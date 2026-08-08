/**
 * The dashboard WebviewPanel wiring. DashboardController holds the panel
 * lifecycle and message dispatch against injected seams (panel factory,
 * snapshot source, settings access), so everything but the last-mile vscode
 * calls is unit-testable. registerDashboardCommand supplies the real vscode
 * implementations.
 *
 * The panel does not retain context when hidden: the webview is a stateless
 * view, so a fresh page asking for state (the "ready" handshake) rebuilds it
 * from the stores, and every store change re-pushes the full state.
 */

import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { LiteLLMChatModelProvider, ServerModelsSnapshot } from "../../provider";
import type { CapabilityCatalogLookup } from "../../shared/config/capabilityResolution";
import { CMD } from "../../shared/config/commandIds";
import type { OpenRouterCatalogSnapshot } from "../../shared/config/openRouterCatalog";
import { searchCatalogModels } from "../../shared/config/openRouterCatalog";
import type { ModelResolutionTable } from "../../shared/config/resolutionTable";
import { CONFIG_SECTION } from "../../shared/config/settingSpec";
import { SERVERS_SETTING_KEY } from "../../shared/config/settings";
import type { Logger } from "../../shared/logger";
import type { SecretFieldId, SecretLocation } from "../../shared/serverEntry";
import { pickNonSecretOptionalFields, SECRET_FIELD_IDS } from "../../shared/serverEntry";
import { normalizeBaseUrl } from "../../shared/util/baseUrl";
import { DASHBOARD_BUNDLE_FILENAME, WEBVIEW_DIST_SEGMENTS } from "../../shared/webviewPaths";
import type { GroupRemovalStore } from "../servers/groupRemovals";
import type { ServerRegistry } from "../servers/serverRegistry";
import type { DeclaredServerView, ServerSyncEngine } from "../servers/serverSync";
import {
	copyServerSecrets,
	deleteServerSecrets,
	inlineSecretValues,
	parseServersSetting,
	readEntryModelCapabilities,
	readEntryModelParameters,
	readServerSecrets,
	updateServerSecret,
} from "../servers/serverSync";
import { resolveAdoptableCredentials, resolveExternalGroupIdentity } from "./adopt";
import { buildDashboardHtml } from "./html";
import { webviewMessageSchema } from "./intentSchema";
import type { IntentEnvironment } from "./intents";
import {
	DashboardOperationError,
	DashboardValidationError,
	executeDashboardIntent,
	readInlineSecretValues,
} from "./intents";
import type {
	CatalogModelSummary,
	DashboardSectionId,
	ExtensionToWebviewMessage,
	TransportErrorClassification,
} from "./protocol";
import type { EntryCapabilitiesRecord, EntryParametersResolution, RemovedGroupsView, SettingsReader } from "./state";
import {
	buildDashboardState,
	resolveConfiguredScope,
	resolveDashboardModelCapabilities,
	resolveUpdateScope,
} from "./state";
import { createDraftConnectionProbe } from "./testDraftConnection";

/** The slice of vscode.Webview the controller uses; createPanel sets the HTML before handing the panel over. */
interface DashboardWebview {
	postMessage(message: unknown): Thenable<boolean>;
	onDidReceiveMessage: vscode.Event<unknown>;
}

/**
 * Whether a raw message is a read-only intent safe to handle off the mutation
 * chain: the draft-connection probe (network-bound) and the two pure
 * request/response reads the inspector and catalog picker post
 * (readModelCapabilities, searchCatalog) - a slow search must not stall a
 * Save queued behind it. A cheap discriminant peek, not a schema parse: an
 * impostor merely claiming the type is still fully re-validated in
 * handleMessage and rejected there. Only genuinely non-mutating intents may
 * be listed here; any intent that writes the servers setting or a secret
 * must stay on the chain.
 */
const CONCURRENT_MESSAGE_TYPES = new Set(["testServerDraft", "readModelCapabilities", "searchCatalog"]);

function isConcurrentMessage(raw: unknown): boolean {
	return (
		typeof raw === "object" &&
		raw !== null &&
		typeof (raw as { type?: unknown }).type === "string" &&
		CONCURRENT_MESSAGE_TYPES.has((raw as { type: string }).type)
	);
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
	/** Whether a snapshot belongs to a provider group (vs the legacy registry); see buildDashboardState. */
	isGroupSnapshot(serverId: string): boolean;
	/** The request path's per-entry modelParameters resolution for a snapshot's server; see entryParametersResolver. */
	resolveEntryParameters(serverId: string): EntryParametersResolution | undefined;
	/** The declared entry's own modelCapabilities for a snapshot's server; the readModelCapabilities responder's entry layer. */
	resolveEntryCapabilities(serverId: string): EntryCapabilitiesRecord | undefined;
	/** The OpenRouter catalog as in-memory lookup data; EMPTY_CATALOG_LOOKUP while no snapshot exists. */
	getCatalogLookup(): CapabilityCatalogLookup;
	/**
	 * The provider's shared flat resolution table, so the capability inspector
	 * reads the SAME cache requests and registration use. Optional: without it
	 * the responder resolves through the same pure walk, uncached.
	 */
	getResolutionTable?(): ModelResolutionTable;
	/** Search the catalog snapshot for the picker; the panel bounds the result list before it crosses. */
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

/** One observed group identity as a set key, normalized exactly like the tombstone store's identities. */
function observedIdentityKey(label: string, baseUrl: string): string {
	return `${label}\n${normalizeBaseUrl(baseUrl)}`;
}

/** How many catalog search results one response may carry; the picker shows a short list, never the catalog. */
const CATALOG_RESULT_LIMIT = 20;

export class DashboardController implements vscode.Disposable {
	private _panel: DashboardPanel | undefined;
	private readonly _panelSubscriptions: vscode.Disposable[] = [];
	/**
	 * Mutating intents run one at a time: two concurrent saves would
	 * read-modify-write the same servers array and lose one of the updates, so
	 * every incoming message joins this chain. The settled value is irrelevant
	 * to the chain itself (outcomes matter only to injectMessageForTest).
	 */
	private _messageChain: Promise<unknown> = Promise.resolve();
	/**
	 * The deep-link target of the latest open call, held until the page proves
	 * it can receive messages. Delivery is gated on the generation match below
	 * because a loading or reloading page silently drops posts: a not-yet-ready
	 * page keeps the target pending and the ready handshake flushes it.
	 * Consumed once, so a later reload cannot replay a stale jump.
	 */
	private _pendingFocusSection: DashboardSectionId | undefined;
	/**
	 * Group identities (label + normalized base URL) observed alive at some
	 * point this session, accumulated from every state push's snapshots.
	 * Session-sticky on purpose: snapshots age out of the status window after
	 * minutes, but a suppressed group the host still holds must keep its
	 * hidden-groups row all session, while a group deleted from the models
	 * file before this session never reports and must not show a ghost row.
	 */
	private readonly _observedGroupIdentities = new Set<string>();
	/**
	 * The current page's generation, bumped whenever the page is torn down or
	 * replaced: the panel hides (without retainContextWhenHidden the page dies
	 * hidden and reloads on reveal) or the panel is disposed.
	 * _readyGeneration records the generation whose ready handshake completed
	 * - each handshake is judged against the generation current when it
	 * ARRIVED, so one handled late, after its page died, cannot vouch for the
	 * next page. The page is provably listening only while the two match.
	 */
	private _pageGeneration = 0;
	private _readyGeneration: number | undefined;

	constructor(private readonly env: DashboardControllerEnv) {}

	/** Open the dashboard, or bring the existing panel to the front, optionally landing on a section. */
	open(section?: DashboardSectionId): void {
		this._pendingFocusSection = section;
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
	 * serialized path a webview post takes - both callers share enqueueMessage,
	 * so an injected message cannot overtake a real one and cannot drift from
	 * the real handling. Nothing is bypassed: the message meets
	 * webviewMessageSchema.safeParse precisely as a webview-posted message
	 * would. Registered behind the non-production litellm._test.dashboardMessage
	 * command.
	 */
	injectMessageForTest(raw: unknown): Promise<DashboardMessageOutcome> {
		return this.enqueueMessage(raw);
	}

	/**
	 * The one enqueue path for every message, webview-posted or injected: the
	 * outcome joins the serialized chain, and the chain's rejection handler
	 * (which also marks the outcome promise handled for fire-and-forget
	 * callers) logs the failure. The page generation is captured at arrival,
	 * not at handling: the chain may drain a message after the page that sent
	 * it died, and a late ready must not vouch for the next page.
	 *
	 * The read-only draft-connection probe is the one intent that runs OFF the
	 * chain: it never read-modify-writes the servers array (the only reason the
	 * chain serializes), but it can block on the network for a whole discovery
	 * timeout, so chaining it would stall every later Save behind a slow or
	 * abandoned probe. It still takes the exact same validated handleMessage
	 * dispatch; only its place in the queue differs. A malformed message merely
	 * claiming the type is harmless off-chain (the schema rejects it), and the
	 * rejection guard mirrors the chain's so a thrown handler cannot surface as
	 * an unhandled rejection for the fire-and-forget webview caller.
	 */
	private enqueueMessage(raw: unknown): Promise<DashboardMessageOutcome> {
		const arrivalGeneration = this._pageGeneration;
		if (isConcurrentMessage(raw)) {
			const outcome = this.handleMessage(raw, arrivalGeneration);
			outcome.then(undefined, (error) => {
				this.env.logError("Dashboard message handling failed", error);
			});
			return outcome;
		}
		const outcome = this._messageChain.then(() => this.handleMessage(raw, arrivalGeneration));
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
			if (this.env.isGroupSnapshot(snapshot.status.serverId)) {
				this._observedGroupIdentities.add(observedIdentityKey(snapshot.status.label, snapshot.status.baseUrl));
			}
		}
		this.postToPanel({
			type: "state",
			state: buildDashboardState(
				snapshots,
				this.env.settingsReader(),
				this.env.getDeclaredServers(),
				this.env.getLegacyServers(),
				this.env.getRemovedGroups(),
				(serverId) => this.env.isGroupSnapshot(serverId),
				(serverId) => this.env.resolveEntryParameters(serverId),
				(label, baseUrl) => this._observedGroupIdentities.has(observedIdentityKey(label, baseUrl))
			),
		});
	}

	/** Deliver the pending deep-link focus, once, and only to a page that has proven it is listening. */
	private flushPendingFocus(): void {
		if (this._pendingFocusSection === undefined || this._readyGeneration !== this._pageGeneration) {
			return;
		}
		const section = this._pendingFocusSection;
		this._pendingFocusSection = undefined;
		this.postToPanel({ type: "focusSection", section });
	}

	private async handleMessage(raw: unknown, arrivalGeneration: number): Promise<DashboardMessageOutcome> {
		const parsed = webviewMessageSchema.safeParse(raw);
		if (!parsed.success) {
			this.env.log("Ignoring malformed dashboard message", { issues: parsed.error.issues });
			return "ignored-malformed";
		}
		if (parsed.data.type === "ready") {
			if (arrivalGeneration === this._pageGeneration) {
				this._readyGeneration = arrivalGeneration;
			}
			this.pushState();
			this.flushPendingFocus();
			return "ok";
		}
		if (parsed.data.type === "readInlineSecrets") {
			// The edit form's on-demand prefill: values only for fields stored
			// inline in the servers setting (already plaintext there), read at
			// request time. No state push (the response is the whole answer) and
			// no logging - the payload is secret material.
			this.postToPanel({
				type: "inlineSecrets",
				requestId: parsed.data.requestId,
				values: readInlineSecretValues(this.env.readServersSetting(), parsed.data.label),
			});
			return "ok";
		}
		if (parsed.data.type === "readModelCapabilities") {
			// The capability inspector's read: resolved extension-side by the
			// same walk registration runs; the response is the whole answer, so
			// no state push and no outcome notice.
			this.postToPanel({
				type: "modelCapabilities",
				requestId: parsed.data.requestId,
				capabilities: resolveDashboardModelCapabilities(
					{
						snapshots: this.env.getSnapshots(),
						reader: this.env.settingsReader(),
						resolveEntryCapabilities: (serverId) => this.env.resolveEntryCapabilities(serverId),
						catalog: this.env.getCatalogLookup(),
						resolution: this.env.getResolutionTable?.(),
					},
					parsed.data.scopeKey,
					parsed.data.rawId
				),
			});
			return "ok";
		}
		if (parsed.data.type === "searchCatalog") {
			// The catalog picker's search; the bound keeps a broad query from
			// pushing the whole catalog across the webview boundary.
			this.postToPanel({
				type: "catalogSearchResults",
				requestId: parsed.data.requestId,
				results: this.env.searchCatalog(parsed.data.query).slice(0, CATALOG_RESULT_LIMIT),
			});
			return "ok";
		}
		const intent = parsed.data;
		const requestId = "requestId" in intent ? intent.requestId : undefined;
		try {
			const notice = await executeDashboardIntent(intent, this.env);
			if (requestId !== undefined) {
				this.postToPanel({
					type: "intentSucceeded",
					intentType: intent.type,
					requestId,
					...(notice !== undefined ? { message: notice } : {}),
				});
			}
			// The push doubles as the editors' success signal: some applied
			// intents (a secure-only secret change, a no-op settings write) fire
			// no configuration event of their own.
			this.pushState();
			return "ok";
		} catch (error) {
			// The write did not land (or only partially landed), so the failure
			// notice is the webview's signal to surface the message and return the
			// affected editor to a retryable draft. Validation and operation
			// messages travel to the webview only: validation text can quote an
			// entered key (a header name, a modelParameters prefix), and the log
			// buffer feeds public issue reports, so the log gets classifications
			// for every failure kind.
			let message: string;
			let kind: "validation" | "operation" = "validation";
			let classification: TransportErrorClassification | undefined;
			if (error instanceof DashboardValidationError) {
				message = error.message;
				// Classification only (enum ids and a status, from the transport's
				// probe error) - protocol-legal and log-legal by the same rule, so
				// it also rides the log line for issue-report triage.
				classification = error.classification;
				this.env.log("Dashboard intent rejected", {
					intentType: intent.type,
					kind: "validation",
					...(classification !== undefined ? { classification } : {}),
				});
			} else if (error instanceof DashboardOperationError) {
				message = error.message;
				kind = "operation";
				this.env.log("Dashboard intent partially applied", { intentType: intent.type, kind: "operation" });
			} else {
				message = vscode.l10n.t("The change was not applied; see the LiteLLM output log.");
				this.env.log("Dashboard intent failed", {
					intentType: intent.type,
					error: error instanceof Error ? error.name : typeof error,
				});
			}
			this.postToPanel({
				type: "intentFailed",
				intentType: intent.type,
				message,
				kind,
				requestId,
				...(classification !== undefined ? { classification } : {}),
			});
			// One class for every refused-or-failed intent: the outcome consumer
			// (the monkey fuzzer) only needs "did not act as asked", and the
			// validation/operation split already travels via intentFailed's kind.
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

// Scalar writes never land in the folder scope (resolveUpdateScope): the
// dashboard's configuration access is resource-less, and a WorkspaceFolder
// update without a resource throws in multi-root workspaces. Resets differ:
// they must remove the highest-precedence configured value, folder scope
// included, or a reset would delete a hidden lower-scope value while the
// displayed one survives - so the reset map carries all three targets and a
// failing folder-scope removal surfaces as the intent's failure notice.
const TARGET_BY_SCOPE = {
	global: vscode.ConfigurationTarget.Global,
	workspace: vscode.ConfigurationTarget.Workspace,
} as const;

const RESET_TARGET_BY_SCOPE = {
	...TARGET_BY_SCOPE,
	workspaceFolder: vscode.ConfigurationTarget.WorkspaceFolder,
} as const;

function createNonce(): string {
	return randomBytes(16).toString("hex");
}

function createRealPanel(extensionUri: vscode.Uri): DashboardPanel {
	const distDir = vscode.Uri.joinPath(extensionUri, ...WEBVIEW_DIST_SEGMENTS);
	const panel = vscode.window.createWebviewPanel("litellm.dashboard", "LiteLLM Dashboard", vscode.ViewColumn.Active, {
		enableScripts: true,
		localResourceRoots: [distDir],
	});
	panel.webview.html = buildDashboardHtml({
		cspSource: panel.webview.cspSource,
		nonce: createNonce(),
		scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(distDir, DASHBOARD_BUNDLE_FILENAME)).toString(),
		language: vscode.env.language,
		l10nBundle: vscode.l10n.bundle,
	});
	return panel;
}

/**
 * The dashboard's request-scope seam: what the request path would resolve as
 * a snapshot server's per-entry modelParameters. Deliberately composed from
 * the request path's own pieces - the group lookup the chat path's attached
 * server comes from, and the same (label, baseUrl) resolver call chat
 * requests make (readEntryModelParameters in production) - NOT from the
 * stricter labeled-identity join behind the entry-params-inactive notice: a
 * group with rotated credentials still carries the entry's label and URL, so
 * requests through it still receive the entry's parameters, and the
 * inspector must say so. Unlabeled groups and registry snapshots resolve to
 * nothing, matching the request path exactly.
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
 * inline value (per the sync engine's own inlineSecretValues rule) reads as
 * "settings", anything else as "none" (a secure blob may exist, but checking
 * it is async and state pushes carry locations, never values).
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
			...(entry.modelParameters !== undefined ? { modelParameters: entry.modelParameters } : {}),
			...(entry.modelCapabilities !== undefined ? { modelCapabilities: entry.modelCapabilities } : {}),
			...(entry.expectedFailures !== undefined ? { expectedFailures: entry.expectedFailures } : {}),
			secrets,
		};
	});
}

/**
 * The dashboard's snapshot view: the provider's status-window snapshots with
 * the declared-model projection appended to each server's model list.
 * Declared models never enter the status window (they are config-rebuilt on
 * every serve), so this merge is what keeps the dashboard's model list equal
 * to the set the picker serves; a snapshot with nothing declared passes
 * through unchanged.
 */
export function declaredMergedSnapshots(
	provider: Pick<LiteLLMChatModelProvider, "getServerSnapshots" | "declaredModelsForSnapshot">
): readonly ServerModelsSnapshot[] {
	return provider.getServerSnapshots().map((snapshot) => {
		const declared = provider.declaredModelsForSnapshot(snapshot);
		return declared.length > 0 ? { ...snapshot, models: [...snapshot.models, ...declared] } : snapshot;
	});
}

/**
 * Register litellm.openDashboard and litellm.showDiagnostics (the deep link
 * to the Diagnostics tab; the palette entry and notification actions run it)
 * and keep the panel in sync with the stores: configuration changes re-push
 * directly; provider status changes arrive via the returned controller's
 * refresh(), called from the status fan-out in extension.ts, and server sync
 * passes via the engine's onDidSync hook.
 */
export function registerDashboardCommand(
	context: vscode.ExtensionContext,
	provider: LiteLLMChatModelProvider,
	logger: Logger,
	syncEngine: ServerSyncEngine,
	registry: ServerRegistry,
	removals: GroupRemovalStore,
	// Structurally the OpenRouter catalog store: the snapshot feeds the
	// picker's search, the lookup feeds the capability inspector.
	catalog: { readonly lookup: CapabilityCatalogLookup; snapshot(): OpenRouterCatalogSnapshot }
): DashboardController {
	const controller = new DashboardController({
		createPanel: () => createRealPanel(context.extensionUri),
		// Declared models never enter the status window (they are config-rebuilt
		// on every serve), so the dashboard merges the provider's projection
		// into each snapshot's model list - the same set the picker serves.
		getSnapshots: () => declaredMergedSnapshots(provider),
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
		isGroupSnapshot: (serverId) => provider.getGroupServer(serverId) !== undefined,
		// The exact resolver chat requests use (activation wires the provider's
		// getEntryModelParameters to the same readEntryModelParameters).
		resolveEntryParameters: entryParametersResolver(
			(serverId) => provider.getGroupServer(serverId),
			readEntryModelParameters
		),
		// Integration seam (settings workstream): the entry layer resolves
		// through the provider's own identity source (group label, or the
		// registry sweep's recorded label), so the inspector can never
		// diverge from the composition requests and registration use.
		resolveEntryCapabilities: (serverId) => {
			const identity = provider.capabilityEntryIdentity(serverId);
			return identity !== undefined ? readEntryModelCapabilities(identity.label, identity.baseUrl) : undefined;
		},
		getCatalogLookup: () => catalog.lookup,
		getResolutionTable: () => provider.resolutionTable,
		searchCatalog: (query) => searchCatalogModels(catalog.snapshot(), query),
		settingsReader: () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			return {
				get: (key) => config.get<unknown>(key),
				inspect: (key) => config.inspect(key),
			};
		},
		updateSetting: async (key, value) => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const scope = resolveUpdateScope(config.inspect(key));
			await config.update(key, value, TARGET_BY_SCOPE[scope]);
		},
		removeSetting: async (key) => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const scope = resolveConfiguredScope(config.inspect(key)) ?? "global";
			await config.update(key, undefined, RESET_TARGET_BY_SCOPE[scope]);
		},
		// The servers setting is machine-scoped: workspaces cannot re-point a
		// label at another host to harvest its stored secrets, and reads and
		// writes always target the user-scope value.
		readServersSetting: () => {
			return vscode.workspace.getConfiguration(CONFIG_SECTION).inspect(SERVERS_SETTING_KEY)?.globalValue;
		},
		writeServersSetting: async (value) => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			await config.update(SERVERS_SETTING_KEY, value, vscode.ConfigurationTarget.Global);
		},
		storeServerSecret: (label, field, value) => updateServerSecret(context.secrets, label, field, value),
		readServerSecrets: (label) => readServerSecrets(context.secrets, label),
		copyServerSecrets: (fromLabel, toLabel) => copyServerSecrets(context.secrets, fromLabel, toLabel),
		deleteServerSecrets: (label) => deleteServerSecrets(context.secrets, label),
		requestServerSync: () => syncEngine.requestSync(),
		// The adopt intent's credential source: the provider's in-memory group
		// lookup, resolved at intent time (against what is external at intent
		// time) so the values never sit in dashboard state. They flow from here
		// into the setting or SecretStorage only.
		resolveAdoptionCredentials: (baseUrl, sourceHandle) =>
			resolveAdoptableCredentials(
				provider.getServerSnapshots(),
				syncEngine.getDeclared(),
				baseUrl,
				sourceHandle,
				(serverId) => provider.getGroupServer(serverId)
			),
		// The hide intent's identity source: the same still-external resolution
		// the adopt path uses, minus the credentials, and gated to group-backed
		// snapshots (a legacy-registry row has no group a tombstone could
		// silence, so it is not hideable).
		resolveExternalGroup: (baseUrl, sourceHandle) =>
			resolveExternalGroupIdentity(
				provider.getServerSnapshots(),
				syncEngine.getDeclared(),
				baseUrl,
				sourceHandle,
				(serverId) => provider.getGroupServer(serverId) !== undefined
			),
		// Tombstone writes fire the store's onDidChange, which the activation
		// wiring points at the provider's model-change event: the host
		// re-resolves and the hidden group's models leave (or return to) the
		// picker without waiting for the next background refresh.
		hideGroup: (identity) => removals.addTombstone(identity),
		unhideGroup: (identity) => removals.removeTombstone(identity),
		// The draft-connection test's probe: one throwaway discovery pass, no
		// mutation, no caching, and no logger (its discovery chatter would enter
		// the issue-report buffer); see createDraftConnectionProbe.
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
