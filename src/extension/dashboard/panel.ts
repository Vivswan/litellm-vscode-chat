/**
 * DashboardController holds the panel lifecycle and message dispatch against injected seams (panel factory, snapshot
 * source, settings access), so everything but the last-mile vscode calls is unit-testable.
 *
 * The panel does not retain context when hidden: the webview is a stateless view, so a fresh page asking for state (the
 * "ready" handshake) rebuilds it from the stores, and every store change re-pushes the full state.
 */

import { randomBytes } from "node:crypto";
import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import type {
	AckedMethod,
	DashboardMethod,
	ExtensionToWebviewMessage,
	IntentAckTone,
	NotifyingMethod,
	ReadMethod,
	RequestPayload,
	RpcRequest,
	RpcRequestType,
	RpcResponseType,
} from "../../dashboard/endpoints";
import { DASHBOARD_ENDPOINTS, settingWriteRow } from "../../dashboard/endpoints";
import type {
	CatalogModelSummary,
	CatalogStatusView,
	DashboardSectionId,
	DashboardState,
	DashboardUsage,
	VerdictRow,
} from "../../dashboard/viewModels";
import type { LiteLLMChatModelProvider } from "../../provider";
import type { ServerModelsSnapshot } from "../../provider/catalog/statusWindow";
import type { CapabilityCatalogLookup } from "../../shared/config/capabilityResolution";
import { CMD } from "../../shared/config/commandIds";
import { searchCatalogModels } from "../../shared/config/openRouterCatalog";
import type { ModelResolutionTable } from "../../shared/config/resolutionTable";
import { CONFIG_SECTION, FEATURE_MODEL_IDS } from "../../shared/config/settingSpec";
import {
	getDiscoveryTimeout,
	getUiAccent,
	getUiTheme,
	getUsageAlertThresholds,
	getUsagePollIntervalMs,
	getUsagePollingOffFreshnessWindowMs,
} from "../../shared/config/settings";
import type { TransportErrorClassification } from "../../shared/errorClassification";
import type { Logger } from "../../shared/logger";
import { errorLabel } from "../../shared/util/errorLabel";
import type { HeaderValue } from "../../shared/util/headers";
import {
	DASHBOARD_BUNDLE_FILENAME,
	DASHBOARD_STYLESHEET_FILENAME,
	WEBVIEW_DIST_SEGMENTS,
} from "../../shared/webviewPaths";
import type { OpenRouterCatalogStore } from "../openRouterCatalog";
import type { GroupRemovalStore, TombstoneIdentity } from "../servers/groupRemovals";
import { tombstoneHides } from "../servers/groupRemovals";
import { openManageLanguageModels } from "../servers/manageLanguageModels";
import type { SecretStore, ServerSyncEngine } from "../servers/serverSync";
import {
	deleteServerSecrets,
	IndeterminateServersSettingError,
	readEntryModelParameters,
	serverSettingReports,
	updateServerSecret,
} from "../servers/serverSync";
import { readServerSecretsRecord } from "../servers/serverSync/secrets";
import type { ServerVerdict } from "../servers/syncFailureOverlay";
import type { UsagePoller } from "../servers/usage";
import { isUsageFresh, notifyUsageRefreshFailure } from "../servers/usage";
import type { SettingsAccess } from "../settingsAccess";
import { createSettingsAccess } from "../settingsAccess";
import { resolveAdoptableCredentials, resolveExternalGroupIdentity } from "./adopt";
import { buildConfigDiagnostics } from "./configDiagnostics";
import { secretValueHolders } from "./declaredJoin";
import type { DeclaredServersInput } from "./declaredServers";
import { buildDashboardHtml } from "./html";
import type { DashboardParseIssue } from "./intentSchema";
import { parseDashboardRequest } from "./intentSchema";
import type { FeatureProbes, IntentAckNotice, IntentEnvironment } from "./intents";
import {
	DashboardOperationError,
	DashboardValidationError,
	executeDashboardIntent,
	readInlineSecretValues,
} from "./intents";
import { buildResolvedModelsView, resolveModelRecordChains } from "./resolvedModels";
import type { EntryCapabilitiesRecord, EntryParametersResolution, RemovedGroupsView, SettingsReader } from "./state";
import {
	buildDashboardState,
	mostSpecificGlobalRecordKey,
	observedModelInfoKeysUnion,
	resolveDashboardModelCapabilities,
	resolveDashboardModelParameters,
} from "./state";
import { createDraftConnectionProbe } from "./testDraftConnection";
import { buildUsageView } from "./usageView";

/** The slice of vscode.Webview the controller uses; createPanel sets the HTML before handing the panel over. */
interface DashboardWebview {
	postMessage(message: unknown): Thenable<boolean>;
	onDidReceiveMessage: vscode.Event<unknown>;
}

export interface DashboardPanel {
	readonly webview: DashboardWebview;
	readonly visible: boolean;
	reveal(): void;
	onDidDispose: vscode.Event<void>;
	onDidChangeViewState: vscode.Event<unknown>;
	dispose(): void;
}

/**
 * Every member resolves through the provider's own machinery (the group lookup, the request path's entry resolvers, the
 * shared flat table), so the dashboard structurally cannot diverge from registration and requests; the next per-server
 * resolver belongs here, not as another loose env member.
 */
export interface ServerResolution {
	/** The request path's per-entry modelParameters resolution; see entryParametersResolver. */
	resolveEntryParameters(serverId: string): EntryParametersResolution | undefined;
	/** The declared entry's own modelCapabilities: the readModelCapabilities responder's entry layer. */
	resolveEntryCapabilities(serverId: string): EntryCapabilitiesRecord | undefined;
	/**
	 * The provider's shared flat resolution table, so the capability inspector reads the SAME cache requests and
	 * registration use. Optional: without it the responder resolves through the same pure walk, uncached.
	 */
	getResolutionTable?(): ModelResolutionTable;
}

/** Everything the controller needs, injected; registerDashboardCommand builds the real one. */
export interface DashboardControllerEnv extends IntentEnvironment {
	/** Create the panel with its HTML already set. */
	createPanel(): DashboardPanel;
	getSnapshots(): readonly ServerModelsSnapshot[];
	getDeclaredServers(): DeclaredServersInput;
	/** The verdict rows their owner publishes (ServerVerdict.rows), for the hero and the paste line. */
	getVerdictRows(): readonly VerdictRow[];
	/** The declared labels whose secret value each live group carries, by server ID (secretValueHolders). */
	getSecretHolders(): ReadonlyMap<string, readonly string[]>;
	/** The removal bookkeeping (tombstones and orphan origins) the state builder folds in. */
	getRemovedGroups(): RemovedGroupsView;
	readonly serverResolution: ServerResolution;
	/** The OpenRouter catalog as in-memory lookup data; EMPTY_CATALOG_LOOKUP while no snapshot exists. */
	getCatalogLookup(): CapabilityCatalogLookup;
	getCatalogStatus(): CatalogStatusView;
	/** The Servers page's usage snapshot, assembled from the poller's store at push time. */
	getUsage(): DashboardUsage;
	/**
	 * One usage pass only when the stored numbers are stale (the poller's refreshIfStale); open() fires it, so
	 * revealing the panel serves the stored numbers instead of re-probing the fleet on every focus.
	 */
	refreshUsageIfStale(): void;
	/** Search the catalog snapshot; the panel bounds the result list before it crosses. */
	searchCatalog(query: string): readonly CatalogModelSummary[];
	settingsReader(): SettingsReader;
	log(message: string, data?: unknown): void;
	logError(message: string, error: unknown): void;
}

/**
 * The classes exist for the test-only injection seam (the monkey fuzzer branches on them): "ignored-malformed" is a
 * schema rejection before anything acted, "validation-error" is any intent the handler refused or failed to apply, and
 * "ok" is an intent that ran to completion.
 */
export type DashboardMessageOutcome = "ok" | "validation-error" | "ignored-malformed";

type DashboardReply = Extract<ExtensionToWebviewMessage, { kind: "response" | "ack" | "fail" }>;

/**
 * What one submitted message produced; the programmatic client (the agent tools) reads it, the webview reads only the
 * posted messages.
 */
export type DashboardSubmission =
	| { readonly outcome: "ok"; readonly reply?: Extract<DashboardReply, { kind: "response" | "ack" }> }
	| {
			readonly outcome: "validation-error";
			readonly reply: Extract<DashboardReply, { kind: "fail" }>;
			readonly issues?: readonly DashboardParseIssue[];
	  }
	| { readonly outcome: "ignored-malformed"; readonly issues: readonly DashboardParseIssue[] };

/**
 * An external submission's correlation id is unknown to the page, so its answer returns by value and is never
 * posted.
 */
type MessageSource = "webview" | "external";

/** How many catalog search results one response may carry; the picker shows a short list. */
const CATALOG_RESULT_LIMIT = 20;

type ReadRequest = Extract<RpcRequestType, { method: ReadMethod }>;

type NotifyingRequest = Exclude<RpcRequestType, ReadRequest>;

function isReadRequest(request: RpcRequestType): request is ReadRequest {
	return DASHBOARD_ENDPOINTS[request.method].outcome === "read";
}

function isAckedRequest(request: NotifyingRequest): request is Extract<NotifyingRequest, { method: AckedMethod }> {
	return DASHBOARD_ENDPOINTS[request.method].outcome === "acked";
}

function isNotifyingMethod(method: DashboardMethod): method is NotifyingMethod {
	return DASHBOARD_ENDPOINTS[method].outcome !== "read";
}

/** What a handler can read about the moment its request arrived; only the ready handshake consumes it. */
interface RequestContext {
	readonly arrivalGeneration: number;
}

/**
 * The panel's handler maps, mapped over the endpoint table so a table method without a handler fails compilation. Read
 * responders build their own full response envelope (concrete per entry, so the method-payload correlation needs no
 * cast); intent runners resolve to the ack's optional caveat message, which fire-and-forget methods never surface.
 */
type ReadResponders = {
	readonly [K in ReadMethod]: (request: RpcRequest<K>) => RpcResponseType;
};

type IntentRunners = {
	readonly [K in Exclude<DashboardMethod, ReadMethod>]: (
		payload: RequestPayload<K>,
		context: RequestContext
	) => Promise<IntentAckNotice | undefined>;
};

export class DashboardController implements vscode.Disposable {
	private _panel: DashboardPanel | undefined;
	private readonly _panelSubscriptions: vscode.Disposable[] = [];
	/**
	 * Mutating intents run one at a time: two concurrent saves would read-modify-write the same servers array and lose
	 * one of the updates, so every mutating message joins this chain (concurrent-channel reads run off it, and a
	 * malformed message is rejected before reaching it).
	 */
	private _messageChain: Promise<unknown> = Promise.resolve();
	/**
	 * The deep-link target of the latest open call, held until the page proves it can receive messages: a loading or
	 * reloading page silently drops posts, so the ready handshake flushes it. Consumed once, so a later reload cannot
	 * replay a stale jump.
	 */
	private _pendingFocusSection: DashboardSectionId | undefined;
	private readonly _observedGroups = new Map<
		string,
		{ readonly label: string; readonly entryLabel: string | undefined; readonly baseUrl: string }
	>();
	/**
	 * The current page's generation, bumped whenever the page is torn down or replaced (the panel hides - without
	 * retainContextWhenHidden the page dies hidden and reloads on reveal - or is disposed). _readyGeneration records
	 * the generation whose ready handshake completed, judged against the generation current when it ARRIVED, so a
	 * handshake handled late cannot vouch for the next page.
	 *
	 * The page -> is provably listening only while the two match
	 */
	private _pageGeneration = 0;
	private _readyGeneration: number | undefined;

	constructor(private readonly env: DashboardControllerEnv) {}

	open(section?: DashboardSectionId): void {
		this._pendingFocusSection = section;
		// The poller's completion re-push lands the numbers when a pass does run.
		this.env.refreshUsageIfStale();
		if (this._panel !== undefined) {
			this._panel.reveal();
			this.pushState();
			this.flushPendingFocus();
			return;
		}
		const panel = this.env.createPanel();
		this._panel = panel;
		this._panelSubscriptions.push(
			panel.webview.onDidReceiveMessage((message) => {
				void this.enqueueMessage(message, "webview");
			}),
			panel.onDidChangeViewState(() => {
				// Context is not retained while hidden, so a re-shown webview needs the current state again (its own
				// "ready" also covers the reload; this push covers hosts that restore the page without reloading).
				if (panel.visible) {
					this.pushState();
				} else {
					this._pageGeneration += 1;
				}
			}),
			panel.onDidDispose(() => {
				this.disposePanel();
			})
		);
		this.pushState();
	}

	refresh(): void {
		if (this._panel?.visible === true) {
			this.pushState();
		}
	}

	/**
	 * Test-only injection seam: run one raw message through the exact same path a webview post takes - both callers
	 * share enqueueMessage, so an injected message gets the same parse, routing, and ordering, and cannot drift from
	 * the real handling. Registered behind the non-production litellm._test.dashboardMessage command.
	 */
	async injectMessageForTest(raw: unknown): Promise<DashboardMessageOutcome> {
		return (await this.enqueueMessage(raw, "webview")).outcome;
	}

	/**
	 * The programmatic client entry (the agent tools): one raw request through the exact path a webview post takes,
	 * answered by return value instead of a post. Mutating requests join the same serialized chain as the page's, so a
	 * tool and an open dashboard cannot lose each other's servers-array update, and a landed intent still pushes state
	 * to an open panel.
	 */
	submit(raw: unknown): Promise<DashboardSubmission> {
		return this.enqueueMessage(raw, "external");
	}

	/**
	 * The page generation is captured at arrival, not handling, because the chain may drain a message after its page
	 * died and a late ready must not vouch for the next page. "concurrent" methods skip the chain because the
	 * draft-connection probe can block a whole discovery timeout, which would stall every later Save behind it.
	 */
	private enqueueMessage(raw: unknown, source: MessageSource): Promise<DashboardSubmission> {
		const arrivalGeneration = this._pageGeneration;
		const parsed = parseDashboardRequest(raw);
		if (!parsed.success) {
			// Codes and a count only: an issue path names the keys the sender wrote (a record's model key, a header
			// name), and the buffer feeds public issue reports.
			this.env.log("Ignoring malformed dashboard message", {
				issueCount: parsed.issues.length,
				codes: [...new Set(parsed.issues.map((issue) => issue.code))],
			});
			const issues = parsed.issues;
			// A parse whose envelope frame survived still identifies the caller: answer a notifying method with a
			// correlated refusal, or an editor waiting on this id would stay pending forever. Reads stay silent - their
			// fail path does not exist on the wire.
			const frame = parsed.frame;
			if (frame !== undefined && isNotifyingMethod(frame.method)) {
				const reply = {
					kind: "fail",
					id: frame.id,
					method: frame.method,
					message: l10n.t("The change was not applied; see the LiteLLM output log."),
					failureKind: "validation",
				} as const;
				if (source === "webview") {
					this.postToPanel(reply);
				}
				return Promise.resolve({ outcome: "validation-error", reply, issues });
			}
			return Promise.resolve({ outcome: "ignored-malformed", issues });
		}
		const request = parsed.request;
		if (DASHBOARD_ENDPOINTS[request.method].channel === "concurrent") {
			const submission = this.handleRequest(request, arrivalGeneration, source);
			submission.then(undefined, (error) => {
				this.env.logError("Dashboard message handling failed", error);
			});
			return submission;
		}
		const submission = this._messageChain.then(() => this.handleRequest(request, arrivalGeneration, source));
		this._messageChain = submission.then(
			() => undefined,
			(error) => {
				this.env.logError("Dashboard message handling failed", error);
			}
		);
		return submission;
	}

	dispose(): void {
		this._panel?.dispose();
		this.disposePanel();
	}

	private disposePanel(): void {
		for (const subscription of this._panelSubscriptions.splice(0)) {
			subscription.dispose();
		}
		this._panel = undefined;
		this._pendingFocusSection = undefined;
		this._pageGeneration += 1;
	}

	private pushState(): void {
		if (this._panel === undefined) {
			return;
		}
		this.postToPanel({ kind: "push", state: this.readState() });
	}

	/** Everything the dashboard knows; the state push and the agent tools' configuration read share it. */
	readState(): DashboardState {
		const snapshots = this.env.getSnapshots();
		for (const snapshot of snapshots) {
			this._observedGroups.set(snapshot.status.serverId, {
				label: snapshot.status.label,
				entryLabel: snapshot.entryLabel,
				baseUrl: snapshot.status.baseUrl,
			});
		}
		const reader = this.env.settingsReader();
		const declared = this.env.getDeclaredServers();
		const entryReports = serverSettingReports(this.env.readServersSetting());
		const removedGroups = this.env.getRemovedGroups();
		// A tombstone is a ghost until the group it hides was seen this session, by the key it hides by.
		const observed = (tombstone: TombstoneIdentity) =>
			[...this._observedGroups.entries()].filter(([groupId, group]) =>
				tombstoneHides(tombstone, { groupId, ...group })
			);
		const wasGroupObserved = (tombstone: TombstoneIdentity) => observed(tombstone).length > 0;
		const wasLabeledGroupObserved = (tombstone: TombstoneIdentity) =>
			observed(tombstone).some(([, group]) => group.entryLabel !== undefined);
		// In FEATURE_MODEL_IDS order for a stable push, whatever object the env built its probes record from.
		const featureProbes = FEATURE_MODEL_IDS.filter((feature) => this.env.featureProbes[feature] !== undefined);
		const state = buildDashboardState({
			snapshots,
			reader,
			declared,
			entryReports,
			secretHolders: this.env.getSecretHolders(),
			featureProbes,
			removedGroups,
			wasGroupObserved,
			wasLabeledGroupObserved,
			catalog: this.env.getCatalogStatus(),
			usage: this.env.getUsage(),
			verdictRows: this.env.getVerdictRows(),
		});
		return {
			...state,
			diagnostics: buildConfigDiagnostics({
				reader,
				entryReports,
				declared: declared.views,
				// The same list the servers section's hidden-groups line renders.
				hiddenGroups: state.hiddenGroups,
				// The advisory-hint evidence: per entry its own server's observed set (the declared row carries its
				// joined snapshot's), global records the cross-server union.
				observedKeysByEntry: new Map(
					state.servers.flatMap((server) =>
						server.origin === "declared" && server.observedModelInfoKeys !== undefined
							? [[server.label, server.observedModelInfoKeys] as const]
							: []
					)
				),
				observedKeysUnion: observedModelInfoKeysUnion(snapshots),
			}),
		};
	}

	private flushPendingFocus(): void {
		if (this._pendingFocusSection === undefined || this._readyGeneration !== this._pageGeneration) {
			return;
		}
		const section = this._pendingFocusSection;
		this._pendingFocusSection = undefined;
		this.postToPanel({ kind: "focusSection", section });
	}

	/**
	 * The read responders: each answers with its own correlated response envelope - no state push, no outcome notice,
	 * and no logging (the readInlineSecrets answer is secret material, so the read arm stays log-free). Concrete per
	 * entry so the method-payload correlation the request union erases is rebuilt without a cast.
	 */
	private readonly readResponders: ReadResponders = {
		readInlineSecrets: (request) => ({
			// The edit form's on-demand prefill: values only for fields stored inline in the servers setting (already
			// plaintext there), and only while the entry still matches the identity the form displayed.
			kind: "response",
			id: request.id,
			method: "readInlineSecrets",
			payload: { values: readInlineSecretValues(this.env.readServersSetting(), request.payload.replace) },
		}),
		readModelCapabilities: (request) => {
			const { scopeKey, rawId } = request.payload;
			const capabilitiesReader = this.env.settingsReader();
			const capsGlobalKey = mostSpecificGlobalRecordKey(capabilitiesReader, "capabilities", rawId);
			const capsChains = resolveModelRecordChains(
				{
					snapshots: this.env.getSnapshots(),
					reader: capabilitiesReader,
					resolveEntryParameters: (serverId) => this.env.serverResolution.resolveEntryParameters(serverId),
					resolveEntryCapabilities: (serverId) => this.env.serverResolution.resolveEntryCapabilities(serverId),
				},
				"capabilities",
				scopeKey,
				rawId
			);
			return {
				kind: "response",
				id: request.id,
				method: "readModelCapabilities",
				payload: {
					capabilities: resolveDashboardModelCapabilities(
						{
							snapshots: this.env.getSnapshots(),
							reader: capabilitiesReader,
							resolveEntryCapabilities: (serverId) => this.env.serverResolution.resolveEntryCapabilities(serverId),
							catalog: this.env.getCatalogLookup(),
							resolution: this.env.serverResolution.getResolutionTable?.(),
						},
						scopeKey,
						rawId
					),
					...(capsGlobalKey !== undefined ? { globalRecordKey: capsGlobalKey } : {}),
					...(capsChains.length > 0 ? { chains: capsChains } : {}),
				},
			};
		},
		readModelParameters: (request) => {
			const { scopeKey, rawId } = request.payload;
			const parametersReader = this.env.settingsReader();
			const answer = resolveDashboardModelParameters(
				{
					snapshots: this.env.getSnapshots(),
					reader: parametersReader,
					resolveEntryParameters: (serverId) => this.env.serverResolution.resolveEntryParameters(serverId),
					resolution: this.env.serverResolution.getResolutionTable?.(),
				},
				scopeKey,
				rawId
			);
			const paramsGlobalKey = mostSpecificGlobalRecordKey(parametersReader, "parameters", rawId);
			const paramsChains = resolveModelRecordChains(
				{
					snapshots: this.env.getSnapshots(),
					reader: parametersReader,
					resolveEntryParameters: (serverId) => this.env.serverResolution.resolveEntryParameters(serverId),
					resolveEntryCapabilities: (serverId) => this.env.serverResolution.resolveEntryCapabilities(serverId),
				},
				"parameters",
				scopeKey,
				rawId
			);
			return {
				kind: "response",
				id: request.id,
				method: "readModelParameters",
				payload: {
					...(answer !== undefined ? { projection: answer } : {}),
					...(paramsGlobalKey !== undefined ? { globalRecordKey: paramsGlobalKey } : {}),
					...(paramsChains.length > 0 ? { chains: paramsChains } : {}),
				},
			};
		},
		readResolvedModels: (request) => ({
			// The Diagnostics tab's Resolved-models view, computed on demand: it scales with models x fields, so it
			// stays out of state pushes.
			kind: "response",
			id: request.id,
			method: "readResolvedModels",
			payload: {
				view: buildResolvedModelsView({
					snapshots: this.env.getSnapshots(),
					reader: this.env.settingsReader(),
					resolveEntryParameters: (serverId) => this.env.serverResolution.resolveEntryParameters(serverId),
					resolveEntryCapabilities: (serverId) => this.env.serverResolution.resolveEntryCapabilities(serverId),
					declared: this.env.getDeclaredServers().views,
					catalog: this.env.getCatalogLookup(),
					resolution: this.env.serverResolution.getResolutionTable?.(),
				}),
			},
		}),
		searchCatalog: (request) => ({
			kind: "response",
			id: request.id,
			method: "searchCatalog",
			payload: { results: this.env.searchCatalog(request.payload.query).slice(0, CATALOG_RESULT_LIMIT) },
		}),
	};

	private readonly intentRunners: IntentRunners = {
		ready: (_payload, context) => {
			if (context.arrivalGeneration === this._pageGeneration) {
				this._readyGeneration = context.arrivalGeneration;
			}
			return Promise.resolve(undefined);
		},
		setNumberSetting: (payload) => executeDashboardIntent({ method: "setNumberSetting", payload }, this.env),
		setBooleanSetting: (payload) => executeDashboardIntent({ method: "setBooleanSetting", payload }, this.env),
		resetSetting: (payload) => executeDashboardIntent({ method: "resetSetting", payload }, this.env),
		revealSetting: (payload) => executeDashboardIntent({ method: "revealSetting", payload }, this.env),
		setModelParameters: (payload) => executeDashboardIntent({ method: "setModelParameters", payload }, this.env),
		setModelCapabilities: (payload) => executeDashboardIntent({ method: "setModelCapabilities", payload }, this.env),
		setUsageStatusBar: (payload) => executeDashboardIntent({ method: "setUsageStatusBar", payload }, this.env),
		setTokenEstimation: (payload) => executeDashboardIntent({ method: "setTokenEstimation", payload }, this.env),
		setCurrencySymbol: (payload) => executeDashboardIntent({ method: "setCurrencySymbol", payload }, this.env),
		setAdditionalToolSchemaKeywords: (payload) =>
			executeDashboardIntent({ method: "setAdditionalToolSchemaKeywords", payload }, this.env),
		setUiTheme: (payload) => executeDashboardIntent({ method: "setUiTheme", payload }, this.env),
		setUiAccent: (payload) => executeDashboardIntent({ method: "setUiAccent", payload }, this.env),
		setUsageAlertThresholds: (payload) =>
			executeDashboardIntent({ method: "setUsageAlertThresholds", payload }, this.env),
		setFeatureModel: (payload) => executeDashboardIntent({ method: "setFeatureModel", payload }, this.env),
		setCommitPrompt: (payload) => executeDashboardIntent({ method: "setCommitPrompt", payload }, this.env),
		setLanguageFilter: (payload) => executeDashboardIntent({ method: "setLanguageFilter", payload }, this.env),
		refreshCatalog: (payload) => executeDashboardIntent({ method: "refreshCatalog", payload }, this.env),
		refreshUsage: (payload) => executeDashboardIntent({ method: "refreshUsage", payload }, this.env),
		saveServerSetting: (payload) => executeDashboardIntent({ method: "saveServerSetting", payload }, this.env),
		testServerDraft: (payload) => executeDashboardIntent({ method: "testServerDraft", payload }, this.env),
		testFeatureModel: (payload) => executeDashboardIntent({ method: "testFeatureModel", payload }, this.env),

		removeServerSetting: (payload) => executeDashboardIntent({ method: "removeServerSetting", payload }, this.env),
		declareExpectedFailure: (payload) =>
			executeDashboardIntent({ method: "declareExpectedFailure", payload }, this.env),
		adoptServer: (payload) => executeDashboardIntent({ method: "adoptServer", payload }, this.env),
		hideExternalServer: (payload) => executeDashboardIntent({ method: "hideExternalServer", payload }, this.env),
		unhideServer: (payload) => executeDashboardIntent({ method: "unhideServer", payload }, this.env),
		manageHiddenGroup: (payload) => executeDashboardIntent({ method: "manageHiddenGroup", payload }, this.env),
		executeCommand: (payload) => executeDashboardIntent({ method: "executeCommand", payload }, this.env),
		copyDiagnostics: (payload) => executeDashboardIntent({ method: "copyDiagnostics", payload }, this.env),
		syncModels: (payload) => executeDashboardIntent({ method: "syncModels", payload }, this.env),
	};

	/** Generic so the mapped handler lookup keeps the method-payload correlation the union erases. */
	private answerRead<K extends ReadMethod>(request: RpcRequest<K>): RpcResponseType {
		return this.readResponders[request.method](request);
	}

	private runIntent<K extends Exclude<DashboardMethod, ReadMethod>>(
		request: RpcRequest<K>,
		context: RequestContext
	): Promise<IntentAckNotice | undefined> {
		return this.intentRunners[request.method](request.payload, context);
	}

	/**
	 * The single dispatch behind every parsed request, routed by the request method's outcome column. Intents run, then
	 * post their ack (acked outcomes only) and push state - the push doubles as the fire-and-forget intents' success
	 * signal, since some applied intents (a secure-only secret change, a no-op settings write) fire no configuration
	 * event of their own; the focus flush after it is the ready handshake's second half and a guarded no-op for every
	 * other method.
	 */
	private async handleRequest(
		request: RpcRequestType,
		arrivalGeneration: number,
		source: MessageSource
	): Promise<DashboardSubmission> {
		const answer = (reply: DashboardReply): DashboardSubmission => {
			if (source === "webview") {
				this.postToPanel(reply);
			}
			// One class for every refused-or-failed intent: the outcome consumer only needs "did not act as asked", and
			// the validation/operation split already travels via the fail notice's failureKind.
			return reply.kind === "fail" ? { outcome: "validation-error", reply } : { outcome: "ok", reply };
		};
		if (isReadRequest(request)) {
			return answer(this.answerRead(request));
		}
		try {
			const notice = await this.runIntent(request, { arrivalGeneration });
			let submission: DashboardSubmission = { outcome: "ok" };
			if (isAckedRequest(request)) {
				const note: { readonly message: string; readonly tone?: IntentAckTone } | undefined =
					typeof notice === "string" ? { message: notice } : notice;
				submission = answer({
					kind: "ack",
					id: request.id,
					method: request.method,
					...(note !== undefined ? { message: note.message } : {}),
					...(note?.tone !== undefined ? { tone: note.tone } : {}),
				});
			}
			this.pushState();
			this.flushPendingFocus();
			return submission;
		} catch (error) {
			// The write did not land (or only partially landed), so the failure notice is the webview's signal to
			// surface the message and return the affected editor to a retryable draft. Validation and operation
			// messages travel to the webview only: validation text can quote an entered key, and the log buffer feeds
			// public issue reports, so the log gets classifications for every failure kind.
			let message: string;
			let failureKind: "validation" | "operation" = "validation";
			let classification: TransportErrorClassification | undefined;
			if (error instanceof DashboardValidationError) {
				message = error.message;
				// Classification only (enum ids and a status) - protocol-legal and log-legal, so it also rides the log
				// line for issue-report triage.
				classification = error.classification;
				this.env.log("Dashboard intent rejected", {
					method: request.method,
					kind: "validation",
					...(classification !== undefined ? { classification } : {}),
				});
			} else if (error instanceof DashboardOperationError) {
				message = error.message;
				failureKind = "operation";
				this.env.log("Dashboard intent partially applied", { method: request.method, kind: "operation" });
			} else {
				message = l10n.t("The change was not applied; see the LiteLLM output log.");
				this.env.log("Dashboard intent failed", {
					method: request.method,
					error: errorLabel(error),
				});
			}
			// A refused scalar write names its owning settings row, derived from the validated payload, so the page can
			// place the notice without a correlation map of its own.
			const row = settingWriteRow(request);
			return answer({
				kind: "fail",
				id: request.id,
				method: request.method,
				message,
				failureKind,
				...(classification !== undefined ? { classification } : {}),
				...(row !== undefined ? { row } : {}),
			});
		}
	}

	private postToPanel(message: ExtensionToWebviewMessage): void {
		// A hidden webview drops the message; the visibility push re-sends state.
		this._panel?.webview.postMessage(message).then(undefined, (error: unknown) => {
			this.env.logError("Dashboard message post failed", error);
		});
	}
}

function createNonce(): string {
	return randomBytes(16).toString("hex");
}

function createRealPanel(extensionUri: vscode.Uri): DashboardPanel {
	const distDir = vscode.Uri.joinPath(extensionUri, ...WEBVIEW_DIST_SEGMENTS);
	const panel = vscode.window.createWebviewPanel("litellm.dashboard", "LiteLLM Dashboard", vscode.ViewColumn.Active, {
		enableScripts: true,
		localResourceRoots: [distDir],
	});
	const renderShell = (): string =>
		buildDashboardHtml({
			cspSource: panel.webview.cspSource,
			nonce: createNonce(),
			scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(distDir, DASHBOARD_BUNDLE_FILENAME)).toString(),
			styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(distDir, DASHBOARD_STYLESHEET_FILENAME)).toString(),
			language: vscode.env.language,
			l10nBundle: vscode.l10n.bundle,
			theme: getUiTheme(),
			accent: getUiAccent(),
		});
	panel.webview.html = renderShell();
	// The shell's whole job is the first paint: it stamps the appearance so a reader who pinned light never sees a dark
	// frame while the bundle boots. The panel does not retain context, so a reveal reloads this stored HTML - which
	// means a theme changed since it was written would hand back exactly the frame the stamp exists to prevent.
	//
	//   the page is already gone, so there is no reload to pay for and nothing on screen to flash -> Rewriting it while
	//     the panel is hidden costs nothing
	//   the state push restamps its live DOM -> A visible panel needs none of this
	const resyncShellWhileHidden = (): void => {
		if (!panel.visible) {
			panel.webview.html = renderShell();
		}
	};
	const subscriptions = [
		panel.onDidChangeViewState(resyncShellWhileHidden),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration(CONFIG_SECTION)) {
				resyncShellWhileHidden();
			}
		}),
	];
	panel.onDidDispose(() => {
		for (const subscription of subscriptions) {
			subscription.dispose();
		}
	});
	return panel;
}

/**
 * Composed from the request path's own pieces and NOT from the stricter labeled-identity join behind the
 * entry-params-inactive notice, because a group with rotated credentials still carries the entry's label and URL,
 * so requests through it still receive the entry's parameters and the inspector must say so.
 */
export function entryParametersResolver(
	// Structurally GroupServer's label and baseUrl; unbranded because the resolver (entryModelParametersFor) normalizes
	// the URL itself.
	getGroupServer: (serverId: string) => { readonly label?: string | undefined; readonly baseUrl: string } | undefined,
	getEntryModelParameters: (label: string, baseUrl: string) => EntryParametersResolution["entryParameters"] | undefined
): (serverId: string) => EntryParametersResolution | undefined {
	return (serverId) => {
		const group = getGroupServer(serverId);
		if (group?.label === undefined) {
			return undefined;
		}
		const entryParameters = getEntryModelParameters(group.label, group.baseUrl);
		return entryParameters !== undefined ? { entryLabel: group.label, entryParameters } : undefined;
	};
}

export interface RegisterDashboardOptions {
	readonly provider: LiteLLMChatModelProvider;
	readonly logger: Logger;
	readonly syncEngine: ServerSyncEngine;
	readonly removals: GroupRemovalStore;
	readonly catalog: Pick<OpenRouterCatalogStore, "lookup" | "snapshot" | "status" | "refreshNow">;
	readonly usagePoller: UsagePoller;
	/** The owner of the declared set and the verdict rows every surface reads. */
	readonly verdict: Pick<ServerVerdict, "declared" | "rows">;
	/**
	 * The same composed entry-capabilities resolver activation wires into the provider, so the inspector cannot diverge
	 * from registration and requests.
	 */
	readonly getEntryModelCapabilities: (label: string, baseUrl: string) => EntryCapabilitiesRecord | undefined;
	/** The one User-Agent activation composes; the draft probe's throwaway client sends it. */
	readonly ua: HeaderValue;
	readonly featureProbes: FeatureProbes;
}

/** What createIntentEnvironment is built from; the row-bound write suite drives it with fakes for these. */
export interface IntentEnvironmentDeps {
	readonly provider: Pick<LiteLLMChatModelProvider, "getServerSnapshots" | "getGroupServer">;
	readonly syncEngine: Pick<ServerSyncEngine, "requestSync" | "resolveDeclaredIdentities">;
	readonly removals: Pick<GroupRemovalStore, "addTombstone" | "retractTombstone" | "removeTombstone" | "hasTombstone">;
	readonly settingsAccess: SettingsAccess;
	readonly secrets: SecretStore;
	readonly logger: Pick<Logger, "log">;
	/** The one User-Agent activation composes; the draft probe's throwaway client sends it. */
	readonly ua: HeaderValue;
	readonly featureProbes: FeatureProbes;
	readonly refreshCatalogNow: () => void;
	readonly refreshUsageNow: () => void;
}

/** The intent half of the controller's environment: every effect executeDashboardIntent can have, over real stores. */
export function createIntentEnvironment(deps: IntentEnvironmentDeps): IntentEnvironment {
	const { provider, syncEngine, removals, settingsAccess, secrets, logger } = deps;
	// The engine's refusal of an indeterminate setting is the user's to fix, so it reaches the webview as validation
	// text rather than the generic "see the log" failure.
	const liveIdentities = async () => {
		try {
			return await syncEngine.resolveDeclaredIdentities();
		} catch (error) {
			if (error instanceof IndeterminateServersSettingError) {
				throw new DashboardValidationError(l10n.t("The servers setting is not an array; fix the setting, then retry"));
			}
			throw error;
		}
	};
	return {
		updateSetting: (key, value) => settingsAccess.updateAuto(key, value),
		removeSetting: (key) => settingsAccess.removeConfigured(key),
		// The effective (scope-merged) value, matching what the state pushes
		// show and what a fresh getter would read after the awaited write.
		readSetting: (key) => settingsAccess.readEffective(key),
		readServersSetting: () => settingsAccess.readServersSetting(),
		writeServersSetting: (write) => settingsAccess.writeServersSetting(write),
		storeServerSecret: (label, field, value, owner) => updateServerSecret(secrets, label, field, value, owner),
		readServerSecrets: (label) => readServerSecretsRecord(secrets, label),
		deleteServerSecrets: (label) => deleteServerSecrets(secrets, label),
		requestServerSync: () => syncEngine.requestSync(),
		// The adopt intent's credential source: the provider's in-memory group lookup under the one group ownership
		// over the setting as it stands at the intent (the engine's live declaration, not its last pass's views), so
		// the values never sit in dashboard state. They flow from here into the setting or SecretStorage only.
		resolveAdoptionCredentials: async (baseUrl, sourceHandle) => {
			const live = await liveIdentities();
			return {
				source: resolveAdoptableCredentials(provider.getServerSnapshots(), live, baseUrl, sourceHandle, (serverId) =>
					provider.getGroupServer(serverId)
				),
				setting: live.setting,
			};
		},
		// The hide intent's identity source: the same external resolution the adopt path uses, minus the credentials.
		resolveExternalGroup: async (baseUrl, sourceHandle) => {
			const live = await liveIdentities();
			return {
				identity: resolveExternalGroupIdentity(provider.getServerSnapshots(), live, baseUrl, sourceHandle, (serverId) =>
					provider.getGroupServer(serverId)
				),
				setting: live.setting,
			};
		},
		// Tombstone writes fire the store's onDidChange, which the activation
		// wiring points at the provider's model-change event: the hidden group's
		// models leave (or return to) the picker without waiting for the next
		// background refresh.
		hideGroup: (identity) => removals.addTombstone(identity),
		retractHide: async (identity) => {
			await removals.retractTombstone(identity);
		},
		unhideGroup: (identity) => removals.removeTombstone(identity),
		isGroupHidden: (identity) => removals.hasTombstone(identity.label, identity.baseUrl),
		openManageLanguageModels: (search) => openManageLanguageModels(search),
		// The draft-connection test's probe: one throwaway discovery pass, no
		// mutation, no caching, and no logger (its discovery chatter would enter
		// the issue-report buffer).
		probeDraftConnection: createDraftConnectionProbe(deps.ua),
		featureProbes: deps.featureProbes,
		refreshCatalogNow: deps.refreshCatalogNow,
		refreshUsageNow: deps.refreshUsageNow,
		executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
		writeClipboard: (text) => vscode.env.clipboard.writeText(text),
		log: (message, data) => logger.log(message, data),
	};
}

/**
 * Register litellm.openDashboard and litellm.showDiagnostics (the deep link to the Diagnostics tab) and keep the panel
 * in sync with the stores: configuration changes re-push directly; provider status changes arrive via the returned
 * controller's refresh(), called from the status fan-out in wiring/ui.ts, and server sync passes via the engine's
 * onDidSync hook.
 */
export function registerDashboardCommand(
	context: vscode.ExtensionContext,
	options: RegisterDashboardOptions
): DashboardController {
	const { provider, logger, syncEngine, removals, catalog, usagePoller, verdict, getEntryModelCapabilities, ua } =
		options;
	const serverResolution: ServerResolution = {
		// The exact resolver chat requests use (activation wires the provider's getEntryModelParameters to the same
		// readEntryModelParameters).
		resolveEntryParameters: entryParametersResolver(
			(serverId) => provider.getGroupServer(serverId),
			readEntryModelParameters
		),
		resolveEntryCapabilities: (serverId) => {
			const identity = provider.capabilityEntryIdentity(serverId);
			return identity !== undefined ? getEntryModelCapabilities(identity.label, identity.baseUrl) : undefined;
		},
		getResolutionTable: () => provider.resolutionTable,
	};
	const settingsAccess = createSettingsAccess();
	const controller = new DashboardController({
		...createIntentEnvironment({
			provider,
			syncEngine,
			removals,
			settingsAccess,
			secrets: context.secrets,
			logger,
			ua,
			featureProbes: options.featureProbes,
			// Fire-and-forget kicks; both push state when they settle. The catalog
			// row stays toast-free; an explicit usage refresh in which NO server
			// returned data acknowledges itself with one warning toast (partial
			// failures render on the cards instead).
			refreshCatalogNow: () => {
				void catalog.refreshNow().finally(() => controller.refresh());
			},
			refreshUsageNow: () => {
				void usagePoller
					.refreshNow()
					.then(notifyUsageRefreshFailure)
					.finally(() => controller.refresh());
			},
		}),
		createPanel: () => createRealPanel(context.extensionUri),
		getSnapshots: () => provider.getServerSnapshots(),
		getDeclaredServers: () => verdict.declared(),
		getVerdictRows: () => verdict.rows(),
		getSecretHolders: () =>
			secretValueHolders(
				provider.getServerSnapshots(),
				(serverId) => provider.getGroupServer(serverId),
				syncEngine.getSecretValues()
			),
		getRemovedGroups: (): RemovedGroupsView => ({
			tombstones: removals.tombstones(),
			origins: removals.provenance().map((record) => ({
				label: record.label,
				baseUrl: record.baseUrl,
				origin: record.origin,
			})),
		}),
		serverResolution,
		getCatalogLookup: () => catalog.lookup,
		getCatalogStatus: () => catalog.status(),
		getUsage: () =>
			buildUsageView({
				states: usagePoller.store.getStates(),
				thresholds: getUsageAlertThresholds(),
				pollIntervalMs: getUsagePollIntervalMs(),
				pollingOffWindowMs: getUsagePollingOffFreshnessWindowMs(),
				discoveryTimeoutMs: getDiscoveryTimeout(),
				refreshing: usagePoller.isRefreshing(),
				refreshingExplicitly: usagePoller.isRefreshingExplicitly(),
				now: Date.now(),
				isFresh: isUsageFresh,
			}),
		// The open-triggered pass: staleness-gated, and never toasted - the total-failure acknowledgment belongs to the
		// EXPLICIT refresh. The poller's own notifications already re-push the dashboard.
		refreshUsageIfStale: () => {
			void usagePoller.refreshIfStale();
		},
		searchCatalog: (query) => searchCatalogModels(catalog.snapshot(), query),
		// One snapshot per reader: a dashboard build makes many reads and must not mix configuration versions
		// mid-build.
		settingsReader: () => settingsAccess.snapshotReader(),
		logError: (message, error) => logger.error(message, error),
	});
	context.subscriptions.push(
		vscode.commands.registerCommand(CMD.openDashboard, () => controller.open()),
		vscode.commands.registerCommand(CMD.showDiagnostics, () => controller.open("diagnostics")),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration(CONFIG_SECTION)) {
				controller.refresh();
			}
		}),
		controller
	);
	return controller;
}
