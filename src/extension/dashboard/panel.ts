/**
 * The dashboard WebviewPanel wiring. DashboardController holds the panel
 * lifecycle and message dispatch against injected seams (panel factory,
 * snapshot source, settings access), so everything but the last-mile vscode
 * calls is unit-testable. registerDashboardCommand supplies the real ones.
 *
 * The panel does not retain context when hidden: the webview is a stateless
 * view, so a fresh page asking for state (the "ready" handshake) rebuilds it
 * from the stores, and every store change re-pushes the full state.
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
	DashboardUsage,
} from "../../dashboard/viewModels";
import type { LiteLLMChatModelProvider } from "../../provider";
import type { ServerModelsSnapshot } from "../../provider/catalog/statusWindow";
import type { CapabilityCatalogLookup } from "../../shared/config/capabilityResolution";
import { CMD } from "../../shared/config/commandIds";
import { searchCatalogModels } from "../../shared/config/openRouterCatalog";
import type { ModelResolutionTable } from "../../shared/config/resolutionTable";
import { CONFIG_SECTION } from "../../shared/config/settingSpec";
import {
	getDiscoveryTimeout,
	getUiAccent,
	getUiTheme,
	getUsageAlertThresholds,
	getUsagePollIntervalMs,
	getUsagePollingOffFreshnessWindowMs,
	SERVERS_SETTING_KEY,
} from "../../shared/config/settings";
import { PARKED_GLOBAL_HEADERS_KEY } from "../../shared/config/storageKeys";
import type { TransportErrorClassification } from "../../shared/errorClassification";
import type { Logger } from "../../shared/logger";
import type { SecretFieldId, SecretLocation } from "../../shared/serverEntry";
import { pickNonSecretOptionalFields, SECRET_FIELD_IDS } from "../../shared/serverEntry";
import { normalizeBaseUrl } from "../../shared/util/baseUrl";
import {
	DASHBOARD_BUNDLE_FILENAME,
	DASHBOARD_STYLESHEET_FILENAME,
	WEBVIEW_DIST_SEGMENTS,
} from "../../shared/webviewPaths";
import type { OpenRouterCatalogStore } from "../openRouterCatalog";
import type { GroupRemovalStore } from "../servers/groupRemovals";
import type { ServerRegistry } from "../servers/serverRegistry";
import type { DeclaredServerView, ServerSyncEngine } from "../servers/serverSync";
import {
	deleteServerSecrets,
	inlineSecretValues,
	parseServersSetting,
	readEntryModelParameters,
	readServerSecrets,
	serverSettingReports,
	updateServerSecret,
} from "../servers/serverSync";
import type { UsagePoller } from "../servers/usage";
import { isUsageFresh, notifyUsageRefreshFailure } from "../servers/usage";
import { createSettingsAccess } from "../settingsAccess";
import { resolveAdoptableCredentials, resolveExternalGroupIdentity } from "./adopt";
import { buildConfigDiagnostics } from "./configDiagnostics";
import { joinDeclared, labeledSnapshots } from "./declaredJoin";
import { buildDashboardHtml } from "./html";
import { parseDashboardRequest } from "./intentSchema";
import type { IntentAckNotice, IntentEnvironment } from "./intents";
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
	observedKeysByEntryLabel,
	observedModelInfoKeysUnion,
	resolveDashboardModelCapabilities,
	resolveDashboardModelParameters,
	visibleHiddenGroups,
} from "./state";
import { createDraftConnectionProbe } from "./testDraftConnection";
import { buildUsageView } from "./usageView";

/** The slice of vscode.Webview the controller uses; createPanel sets the HTML before handing the panel over. */
interface DashboardWebview {
	postMessage(message: unknown): Thenable<boolean>;
	onDidReceiveMessage: vscode.Event<unknown>;
}

/** The slice of vscode.WebviewPanel the controller uses. */
export interface DashboardPanel {
	readonly webview: DashboardWebview;
	readonly visible: boolean;
	reveal(): void;
	onDidDispose: vscode.Event<void>;
	onDidChangeViewState: vscode.Event<unknown>;
	dispose(): void;
}

/**
 * The per-server resolver seams, grouped: how the dashboard answers questions
 * about one snapshot server's identity and configuration. Every member
 * resolves through the provider's own machinery (the group lookup, the request
 * path's entry resolvers, the shared flat table), so the dashboard
 * structurally cannot diverge from registration and requests; the next
 * per-server resolver belongs here, not as another loose env member.
 */
export interface ServerResolution {
	/** Whether a snapshot belongs to a provider group (vs the legacy registry). */
	isGroupSnapshot(serverId: string): boolean;
	/** The request path's per-entry modelParameters resolution; see entryParametersResolver. */
	resolveEntryParameters(serverId: string): EntryParametersResolution | undefined;
	/** The declared entry's own modelCapabilities: the readModelCapabilities responder's entry layer. */
	resolveEntryCapabilities(serverId: string): EntryCapabilitiesRecord | undefined;
	/**
	 * The provider's shared flat resolution table, so the capability inspector
	 * reads the SAME cache requests and registration use. Optional: without it
	 * the responder resolves through the same pure walk, uncached.
	 */
	getResolutionTable?(): ModelResolutionTable;
}

/** Everything the controller needs, injected; registerDashboardCommand builds the real one. */
export interface DashboardControllerEnv extends IntentEnvironment {
	/** Create the panel with its HTML already set. */
	createPanel(): DashboardPanel;
	getSnapshots(): readonly ServerModelsSnapshot[];
	getDeclaredServers(): readonly DeclaredServerView[];
	/** The legacy registry's servers, reduced to base URLs; see DashboardState.legacyServerCount. */
	getLegacyServers(): readonly { readonly baseUrl: string }[];
	/** The removal bookkeeping (tombstones and orphan origins) the state builder folds in. */
	getRemovedGroups(): RemovedGroupsView;
	/** The per-server resolver seams, grouped; see ServerResolution. */
	readonly serverResolution: ServerResolution;
	/** The OpenRouter catalog as in-memory lookup data; EMPTY_CATALOG_LOOKUP while no snapshot exists. */
	getCatalogLookup(): CapabilityCatalogLookup;
	/** The catalog row's status facts (size, last refresh, standing failure, in-flight). */
	getCatalogStatus(): CatalogStatusView;
	/** The Servers page's usage snapshot, assembled from the poller's store at push time. */
	getUsage(): DashboardUsage;
	/** The PARKED_GLOBAL_HEADERS_KEY globalState value, for the parked-headers legacy hint. */
	getParkedGlobalHeaders(): unknown;
	/**
	 * One usage pass only when the stored numbers are stale (the poller's
	 * refreshIfStale); open() fires it, so revealing the panel serves the
	 * stored numbers instead of re-probing the fleet on every focus.
	 */
	refreshUsageIfStale(): void;
	/** Search the catalog snapshot; the panel bounds the result list before it crosses. */
	searchCatalog(query: string): readonly CatalogModelSummary[];
	settingsReader(): SettingsReader;
	log(message: string, data?: unknown): void;
	logError(message: string, error: unknown): void;
}

/**
 * How the message boundary classified one raw webview message. The classes
 * exist for the test-only injection seam (the monkey fuzzer branches on
 * them): "ignored-malformed" is a schema rejection before anything acted,
 * "validation-error" is any intent the handler refused or failed to apply,
 * and "ok" is an intent that ran to completion.
 */
export type DashboardMessageOutcome = "ok" | "validation-error" | "ignored-malformed";

/** One observed group identity as a set key, normalized like the tombstone store's identities. */
function observedIdentityKey(label: string, baseUrl: string): string {
	return `${label}\n${normalizeBaseUrl(baseUrl)}`;
}

/** How many catalog search results one response may carry; the picker shows a short list. */
const CATALOG_RESULT_LIMIT = 20;

/** A request whose method the table classifies as a read. */
type ReadRequest = Extract<RpcRequestType, { method: ReadMethod }>;

/** Everything else: the handshake plus the acked and fire-and-forget intents. */
type NotifyingRequest = Exclude<RpcRequestType, ReadRequest>;

/** Table-driven outcome routing: the request's method row decides how its answer travels. */
function isReadRequest(request: RpcRequestType): request is ReadRequest {
	return DASHBOARD_ENDPOINTS[request.method].outcome === "read";
}

function isAckedRequest(request: NotifyingRequest): request is Extract<NotifyingRequest, { method: AckedMethod }> {
	return DASHBOARD_ENDPOINTS[request.method].outcome === "acked";
}

/** Whether a method's failures notify (everything but the reads); the refusal path keys on it. */
function isNotifyingMethod(method: DashboardMethod): method is NotifyingMethod {
	return DASHBOARD_ENDPOINTS[method].outcome !== "read";
}

/** What a handler can read about the moment its request arrived; only the ready handshake consumes it. */
interface RequestContext {
	readonly arrivalGeneration: number;
}

/**
 * The panel's handler maps, mapped over the endpoint table so a table method
 * without a handler fails compilation. Read responders build their own full
 * response envelope (concrete per entry, so the method-payload correlation
 * needs no cast); intent runners resolve to the ack's optional caveat
 * message, which fire-and-forget methods never surface.
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
	 * Mutating intents run one at a time: two concurrent saves would
	 * read-modify-write the same servers array and lose one of the updates, so
	 * every mutating message joins this chain (concurrent-channel reads run off
	 * it, and a malformed message is rejected before reaching it).
	 */
	private _messageChain: Promise<unknown> = Promise.resolve();
	/**
	 * The deep-link target of the latest open call, held until the page proves
	 * it can receive messages: a loading or reloading page silently drops
	 * posts, so the ready handshake flushes it. Consumed once, so a later
	 * reload cannot replay a stale jump.
	 */
	private _pendingFocusSection: DashboardSectionId | undefined;
	/**
	 * Group identities (label + normalized base URL) observed alive at some
	 * point this session. Session-sticky on purpose: snapshots age out of the
	 * status window after minutes, but a suppressed group the host still holds
	 * must keep its hidden-groups row all session, while a group deleted from
	 * the models file before this session must not show a ghost row.
	 */
	private readonly _observedGroupIdentities = new Set<string>();
	/**
	 * The current page's generation, bumped whenever the page is torn down or
	 * replaced (the panel hides - without retainContextWhenHidden the page dies
	 * hidden and reloads on reveal - or is disposed). _readyGeneration records
	 * the generation whose ready handshake completed, judged against the
	 * generation current when it ARRIVED, so a handshake handled late cannot
	 * vouch for the next page. The page is provably listening only while the
	 * two match.
	 */
	private _pageGeneration = 0;
	private _readyGeneration: number | undefined;

	constructor(private readonly env: DashboardControllerEnv) {}

	/** Open the dashboard, or bring the existing panel to the front, optionally landing on a section. */
	open(section?: DashboardSectionId): void {
		this._pendingFocusSection = section;
		// Opening serves the stored numbers and re-fetches only when they are
		// stale: re-focusing an open panel must not re-probe the fleet. The
		// poller's completion re-push lands the numbers when a pass does run.
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
				void this.enqueueMessage(message);
			}),
			panel.onDidChangeViewState(() => {
				// Context is not retained while hidden, so a re-shown webview needs
				// the current state again (its own "ready" also covers the reload;
				// this push covers hosts that restore the page without reloading).
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

	/** Re-push state after a store change (configuration or provider status); no-op without a visible panel. */
	refresh(): void {
		if (this._panel?.visible === true) {
			this.pushState();
		}
	}

	/**
	 * Test-only injection seam: run one raw message through the exact same
	 * path a webview post takes - both callers share enqueueMessage, so an
	 * injected message gets the same parse, routing, and ordering, and cannot
	 * drift from the real handling. Registered behind the non-production
	 * litellm._test.dashboardMessage command.
	 */
	injectMessageForTest(raw: unknown): Promise<DashboardMessageOutcome> {
		return this.enqueueMessage(raw);
	}

	/**
	 * The one enqueue path for every message, webview-posted or injected: the
	 * schema parse happens here, once, so every routing decision below acts on
	 * validated data. The page generation is captured at arrival, not at
	 * handling: the chain may drain a message after the page that sent it
	 * died, and a late ready must not vouch for the next page.
	 *
	 * The channel column of the endpoint table routes the queue: "concurrent"
	 * methods run OFF the chain - they never read-modify-write the servers
	 * array (the only reason the chain serializes), and the draft-connection
	 * probe among them can block for a whole discovery timeout, so chaining
	 * them would stall every later Save behind a slow probe. They take the same
	 * handleRequest dispatch; only their place in the queue differs, and their
	 * rejection guard mirrors the chain's so a thrown handler cannot surface as
	 * an unhandled rejection.
	 */
	private enqueueMessage(raw: unknown): Promise<DashboardMessageOutcome> {
		const arrivalGeneration = this._pageGeneration;
		const parsed = parseDashboardRequest(raw);
		if (!parsed.success) {
			this.env.log("Ignoring malformed dashboard message", { issues: parsed.issues });
			// A parse whose envelope frame survived still identifies the caller:
			// answer a notifying method with a correlated refusal, or an editor
			// waiting on this id would stay pending forever. Reads stay silent -
			// their fail path does not exist on the wire.
			const frame = parsed.frame;
			if (frame !== undefined && isNotifyingMethod(frame.method)) {
				this.postToPanel({
					kind: "fail",
					id: frame.id,
					method: frame.method,
					message: l10n.t("The change was not applied; see the LiteLLM output log."),
					failureKind: "validation",
				});
				return Promise.resolve("validation-error");
			}
			return Promise.resolve("ignored-malformed");
		}
		const request = parsed.request;
		if (DASHBOARD_ENDPOINTS[request.method].channel === "concurrent") {
			const outcome = this.handleRequest(request, arrivalGeneration);
			outcome.then(undefined, (error) => {
				this.env.logError("Dashboard message handling failed", error);
			});
			return outcome;
		}
		const outcome = this._messageChain.then(() => this.handleRequest(request, arrivalGeneration));
		this._messageChain = outcome.then(
			() => undefined,
			(error) => {
				this.env.logError("Dashboard message handling failed", error);
			}
		);
		return outcome;
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
		const snapshots = this.env.getSnapshots();
		for (const snapshot of snapshots) {
			if (this.env.serverResolution.isGroupSnapshot(snapshot.status.serverId)) {
				this._observedGroupIdentities.add(observedIdentityKey(snapshot.status.label, snapshot.status.baseUrl));
			}
		}
		const reader = this.env.settingsReader();
		const declared = this.env.getDeclaredServers();
		const entryReports = serverSettingReports(this.env.readServersSetting());
		// The parked-headers hint stands only while externally managed groups
		// exist; externality here is the same join the servers table renders.
		const hasExternalGroups = joinDeclared(labeledSnapshots(snapshots), declared).unmatched.size > 0;
		const removedGroups = this.env.getRemovedGroups();
		const wasGroupObserved = (label: string, baseUrl: string) =>
			this._observedGroupIdentities.has(observedIdentityKey(label, baseUrl));
		this.postToPanel({
			kind: "push",
			state: buildDashboardState({
				snapshots,
				reader,
				declared,
				entryReports,
				legacyServers: this.env.getLegacyServers(),
				removedGroups,
				isGroupSnapshot: (serverId) => this.env.serverResolution.isGroupSnapshot(serverId),
				wasGroupObserved,
				catalog: this.env.getCatalogStatus(),
				usage: this.env.getUsage(),
				diagnostics: buildConfigDiagnostics({
					reader,
					parkedGlobalHeadersValue: this.env.getParkedGlobalHeaders(),
					hasExternalGroups,
					entryReports,
					declared,
					// The same list the servers section's hidden-groups line renders.
					hiddenGroups: visibleHiddenGroups(removedGroups, wasGroupObserved),
					// The advisory-hint evidence: per entry its own server's observed
					// set, global records the cross-server union.
					observedKeysByEntry: observedKeysByEntryLabel(snapshots, declared),
					observedKeysUnion: observedModelInfoKeysUnion(snapshots),
				}),
			}),
		});
	}

	/** Deliver the pending deep-link focus, once, and only to a page that has proven it is listening. */
	private flushPendingFocus(): void {
		if (this._pendingFocusSection === undefined || this._readyGeneration !== this._pageGeneration) {
			return;
		}
		const section = this._pendingFocusSection;
		this._pendingFocusSection = undefined;
		this.postToPanel({ kind: "focusSection", section });
	}

	/**
	 * The read responders: each answers with its own correlated response
	 * envelope - no state push, no outcome notice, and no logging (the
	 * readInlineSecrets answer is secret material, so the read arm stays
	 * log-free). Concrete per entry so the method-payload correlation the
	 * request union erases is rebuilt without a cast.
	 */
	private readonly readResponders: ReadResponders = {
		readInlineSecrets: (request) => ({
			// The edit form's on-demand prefill: values only for fields stored
			// inline in the servers setting (already plaintext there).
			kind: "response",
			id: request.id,
			method: "readInlineSecrets",
			payload: { values: readInlineSecretValues(this.env.readServersSetting(), request.payload.label) },
		}),
		readModelCapabilities: (request) => {
			// The capability inspector's read: resolved extension-side by the
			// same walk registration runs.
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
			// The params inspector's read: resolved through the provider's shared
			// flat table and projected extension-side.
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
			// The Diagnostics tab's Resolved-models view, computed on demand: it
			// scales with models x fields, so it stays out of state pushes.
			kind: "response",
			id: request.id,
			method: "readResolvedModels",
			payload: {
				view: buildResolvedModelsView({
					snapshots: this.env.getSnapshots(),
					reader: this.env.settingsReader(),
					resolveEntryParameters: (serverId) => this.env.serverResolution.resolveEntryParameters(serverId),
					resolveEntryCapabilities: (serverId) => this.env.serverResolution.resolveEntryCapabilities(serverId),
					declared: this.env.getDeclaredServers(),
					catalog: this.env.getCatalogLookup(),
					resolution: this.env.serverResolution.getResolutionTable?.(),
				}),
			},
		}),
		searchCatalog: (request) => ({
			// The catalog picker's search; the bound keeps a broad query from
			// pushing the whole catalog across the webview boundary.
			kind: "response",
			id: request.id,
			method: "searchCatalog",
			payload: { results: this.env.searchCatalog(request.payload.query).slice(0, CATALOG_RESULT_LIMIT) },
		}),
	};

	/**
	 * The intent runners: the ready handshake's generation bookkeeping, plus
	 * one executor call per intent method (concrete per entry, like the read
	 * responders, so the executor's discriminated union needs no cast).
	 */
	private readonly intentRunners: IntentRunners = {
		ready: (_payload, context) => {
			// Judged against the generation current when the handshake ARRIVED:
			// one handled late cannot vouch for the next page.
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
		refreshCatalog: (payload) => executeDashboardIntent({ method: "refreshCatalog", payload }, this.env),
		refreshUsage: (payload) => executeDashboardIntent({ method: "refreshUsage", payload }, this.env),
		saveServerSetting: (payload) => executeDashboardIntent({ method: "saveServerSetting", payload }, this.env),
		testServerDraft: (payload) => executeDashboardIntent({ method: "testServerDraft", payload }, this.env),
		removeServerSetting: (payload) => executeDashboardIntent({ method: "removeServerSetting", payload }, this.env),
		declareExpectedFailure: (payload) =>
			executeDashboardIntent({ method: "declareExpectedFailure", payload }, this.env),
		adoptServer: (payload) => executeDashboardIntent({ method: "adoptServer", payload }, this.env),
		hideExternalServer: (payload) => executeDashboardIntent({ method: "hideExternalServer", payload }, this.env),
		unhideServer: (payload) => executeDashboardIntent({ method: "unhideServer", payload }, this.env),
		executeCommand: (payload) => executeDashboardIntent({ method: "executeCommand", payload }, this.env),
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
	 * The single dispatch behind every parsed request, routed by the request
	 * method's outcome column. Reads answer and stop. Intents run, then post
	 * their ack (acked outcomes only) and push state - the push doubles as the
	 * fire-and-forget intents' success signal, since some applied intents (a
	 * secure-only secret change, a no-op settings write) fire no configuration
	 * event of their own; the focus flush after it is the ready handshake's
	 * second half and a guarded no-op for every other method.
	 */
	private async handleRequest(request: RpcRequestType, arrivalGeneration: number): Promise<DashboardMessageOutcome> {
		if (isReadRequest(request)) {
			this.postToPanel(this.answerRead(request));
			return "ok";
		}
		try {
			const notice = await this.runIntent(request, { arrivalGeneration });
			if (isAckedRequest(request)) {
				// The notice's plain-string form is the quiet success; the object
				// form rides its warning tone onto the ack (see IntentAckNotice).
				const note: { readonly message: string; readonly tone?: IntentAckTone } | undefined =
					typeof notice === "string" ? { message: notice } : notice;
				this.postToPanel({
					kind: "ack",
					id: request.id,
					method: request.method,
					...(note !== undefined ? { message: note.message } : {}),
					...(note?.tone !== undefined ? { tone: note.tone } : {}),
				});
			}
			this.pushState();
			this.flushPendingFocus();
			return "ok";
		} catch (error) {
			// The write did not land (or only partially landed), so the failure
			// notice is the webview's signal to surface the message and return the
			// affected editor to a retryable draft. Validation and operation
			// messages travel to the webview only: validation text can quote an
			// entered key, and the log buffer feeds public issue reports, so the
			// log gets classifications for every failure kind.
			let message: string;
			let failureKind: "validation" | "operation" = "validation";
			let classification: TransportErrorClassification | undefined;
			if (error instanceof DashboardValidationError) {
				message = error.message;
				// Classification only (enum ids and a status) - protocol-legal and
				// log-legal, so it also rides the log line for issue-report triage.
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
					error: error instanceof Error ? error.name : typeof error,
				});
			}
			// A refused scalar write names its owning settings row, derived from the
			// validated payload, so the page can place the notice without a
			// correlation map of its own.
			const row = settingWriteRow(request);
			this.postToPanel({
				kind: "fail",
				id: request.id,
				method: request.method,
				message,
				failureKind,
				...(classification !== undefined ? { classification } : {}),
				...(row !== undefined ? { row } : {}),
			});
			// One class for every refused-or-failed intent: the outcome consumer
			// only needs "did not act as asked", and the validation/operation
			// split already travels via the fail notice's failureKind.
			return "validation-error";
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
	// The shell's whole job is the first paint: it stamps the appearance so a
	// reader who pinned light never sees a dark frame while the bundle boots.
	// The panel does not retain context, so a reveal reloads this stored HTML -
	// which means a theme changed since it was written would hand back exactly
	// the frame the stamp exists to prevent. Rewriting it while the panel is
	// hidden costs nothing: the page is already gone, so there is no reload to
	// pay for and nothing on screen to flash. A visible panel needs none of
	// this; the state push restamps its live DOM.
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
 * The dashboard's request-scope seam: what the request path would resolve as
 * a snapshot server's per-entry modelParameters. Deliberately composed from
 * the request path's own pieces - the group lookup and the same (label,
 * baseUrl) resolver call chat requests make - NOT from the stricter
 * labeled-identity join behind the entry-params-inactive notice: a group with
 * rotated credentials still carries the entry's label and URL, so requests
 * through it still receive the entry's parameters, and the inspector must say
 * so. Unlabeled groups and registry snapshots resolve to nothing, matching
 * the request path exactly.
 */
export function entryParametersResolver(
	// Structurally GroupServer's label and baseUrl; unbranded because the
	// resolver (entryModelParametersFor) normalizes the URL itself.
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

/**
 * DeclaredServerView equivalents straight from the setting, for the window
 * right after activation when the sync engine's first pass has not landed
 * yet. Secret locations reflect only what the setting itself can prove: an
 * inline value reads as "settings", anything else as "none" (a secure blob
 * may exist, but checking it is async and state pushes carry locations, never
 * values).
 */
export function declaredViewsFromSetting(raw: unknown): DeclaredServerView[] {
	return parseServersSetting(raw).entries.map((entry) => {
		const inline = inlineSecretValues(entry);
		const secrets = {} as Record<SecretFieldId, SecretLocation>;
		for (const field of SECRET_FIELD_IDS) {
			secrets[field] = inline[field] !== undefined ? "settings" : "none";
		}
		return {
			label: entry.label,
			baseUrl: entry.baseUrl,
			...pickNonSecretOptionalFields(entry),
			...(entry.apiVersion !== undefined ? { apiVersion: entry.apiVersion } : {}),
			...(entry.headers !== undefined ? { headers: entry.headers } : {}),
			...(entry.modelParameters !== undefined ? { modelParameters: entry.modelParameters } : {}),
			...(entry.modelCapabilities !== undefined ? { modelCapabilities: entry.modelCapabilities } : {}),
			...(entry.expectedFailures !== undefined ? { expectedFailures: entry.expectedFailures } : {}),
			...(entry.declaredModels !== undefined ? { declaredModels: entry.declaredModels } : {}),
			...(entry.budget !== undefined ? { budget: entry.budget } : {}),
			secrets,
		};
	});
}

/**
 * Register litellm.openDashboard and litellm.showDiagnostics (the deep link
 * to the Diagnostics tab) and keep the panel in sync with the stores:
 * configuration changes re-push directly; provider status changes arrive via
 * the returned controller's refresh(), called from the status fan-out in
 * wiring/ui.ts, and server sync passes via the engine's onDidSync hook.
 */
export function registerDashboardCommand(
	context: vscode.ExtensionContext,
	provider: LiteLLMChatModelProvider,
	logger: Logger,
	syncEngine: ServerSyncEngine,
	registry: ServerRegistry,
	removals: GroupRemovalStore,
	// Structurally the OpenRouter catalog store: the snapshot feeds the
	// picker's search, the lookup feeds the capability inspector, the status
	// feeds the settings row, and refreshNow backs the row's Refresh button.
	catalog: Pick<OpenRouterCatalogStore, "lookup" | "snapshot" | "status" | "refreshNow">,
	usagePoller: UsagePoller,
	// The same composed entry-capabilities resolver activation wires into the
	// provider, so the inspector cannot diverge from registration and requests.
	getEntryModelCapabilities: (label: string, baseUrl: string) => EntryCapabilitiesRecord | undefined
): DashboardController {
	const serverResolution: ServerResolution = {
		isGroupSnapshot: (serverId) => provider.getGroupServer(serverId) !== undefined,
		// The exact resolver chat requests use (activation wires the provider's
		// getEntryModelParameters to the same readEntryModelParameters).
		resolveEntryParameters: entryParametersResolver(
			(serverId) => provider.getGroupServer(serverId),
			readEntryModelParameters
		),
		// The entry layer resolves through the provider's own identity source
		// (group label, or the registry sweep's recorded label).
		resolveEntryCapabilities: (serverId) => {
			const identity = provider.capabilityEntryIdentity(serverId);
			return identity !== undefined ? getEntryModelCapabilities(identity.label, identity.baseUrl) : undefined;
		},
		getResolutionTable: () => provider.resolutionTable,
	};
	const settingsAccess = createSettingsAccess();
	const controller = new DashboardController({
		createPanel: () => createRealPanel(context.extensionUri),
		// The window records exactly what each serve handed out (declared models
		// included), so the dashboard lists the same model set as the picker by
		// construction - same IDs, pre-attach infos without the serve decorations.
		getSnapshots: () => provider.getServerSnapshots(),
		getDeclaredServers: () => {
			// The engine's declared view is authoritative once a pass has run;
			// right after activation it is still empty, so the setting fills in.
			const declared = syncEngine.getDeclared();
			if (declared.length > 0) {
				return declared;
			}
			return declaredViewsFromSetting(
				vscode.workspace.getConfiguration(CONFIG_SECTION).get<unknown>(SERVERS_SETTING_KEY)
			);
		},
		getLegacyServers: () => registry.getServers(),
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
		getParkedGlobalHeaders: () => context.globalState.get<unknown>(PARKED_GLOBAL_HEADERS_KEY),
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
		// The open-triggered pass: staleness-gated, and never toasted - the
		// total-failure acknowledgment belongs to the EXPLICIT refresh. The
		// poller's own notifications already re-push the dashboard.
		refreshUsageIfStale: () => {
			void usagePoller.refreshIfStale();
		},
		searchCatalog: (query) => searchCatalogModels(catalog.snapshot(), query),
		// One snapshot per reader: a dashboard build makes many reads and must
		// not mix configuration versions mid-build.
		settingsReader: () => settingsAccess.snapshotReader(),
		updateSetting: (key, value) => settingsAccess.updateAuto(key, value),
		removeSetting: (key) => settingsAccess.removeConfigured(key),
		// The servers setting is machine-scoped: workspaces cannot re-point a
		// label at another host to harvest its stored secrets, and reads and
		// writes always target the user-scope value.
		readServersSetting: () => settingsAccess.readGlobal(SERVERS_SETTING_KEY),
		writeServersSetting: (value) => settingsAccess.writeGlobal(SERVERS_SETTING_KEY, value),
		storeServerSecret: (label, field, value) => updateServerSecret(context.secrets, label, field, value),
		readServerSecrets: (label) => readServerSecrets(context.secrets, label),
		deleteServerSecrets: (label) => deleteServerSecrets(context.secrets, label),
		requestServerSync: () => syncEngine.requestSync(),
		// The adopt intent's credential source: the provider's in-memory group
		// lookup, resolved at intent time against what is external then, so the
		// values never sit in dashboard state. They flow from here into the
		// setting or SecretStorage only.
		resolveAdoptionCredentials: (baseUrl, sourceHandle) =>
			resolveAdoptableCredentials(
				provider.getServerSnapshots(),
				syncEngine.getDeclared(),
				baseUrl,
				sourceHandle,
				(serverId) => provider.getGroupServer(serverId)
			),
		// The hide intent's identity source: the same still-external resolution
		// the adopt path uses, minus the credentials, gated to group-backed
		// snapshots (a legacy-registry row has no group to silence).
		resolveExternalGroup: (baseUrl, sourceHandle) =>
			resolveExternalGroupIdentity(
				provider.getServerSnapshots(),
				syncEngine.getDeclared(),
				baseUrl,
				sourceHandle,
				serverResolution.isGroupSnapshot
			),
		// Tombstone writes fire the store's onDidChange, which the activation
		// wiring points at the provider's model-change event: the hidden group's
		// models leave (or return to) the picker without waiting for the next
		// background refresh.
		hideGroup: (identity) => removals.addTombstone(identity),
		unhideGroup: (identity) => removals.removeTombstone(identity),
		// The draft-connection test's probe: one throwaway discovery pass, no
		// mutation, no caching, and no logger (its discovery chatter would enter
		// the issue-report buffer).
		probeDraftConnection: createDraftConnectionProbe(context),
		executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
		log: (message, data) => logger.log(message, data),
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
