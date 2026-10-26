/**
 * The dashboard's wire contract as one endpoint table: the envelope unions, the routing, the zod schema map, and the
 * panel handler map all derive from DASHBOARD_ENDPOINTS, so a method missing a payload, schema, handler, or (for
 * reads) response type fails compilation. State pushes carry secret LOCATIONS, never values (readInlineSecrets is the
 * one value path); failures carry webview-safe text.
 *
 *   Imported by both sides -> pure: no vscode, DOM, Node, or zod
 */

import type { EffectiveCapabilities } from "../shared/config/capabilityResolution";
import type { EffectiveParametersProjection } from "../shared/config/parameterResolution";
import type {
	BooleanSettingId,
	FeatureModelId,
	FeatureModelRef,
	LanguageFilterMode,
	NumberSettingId,
	SessionIdMode,
	TokenEstimationMode,
	UiAccent,
	UiTheme,
	UsageStatusBarMode,
} from "../shared/config/settingSpec";
import {
	CHAT_SESSION_ID_SETTING_KEY,
	FEATURE_MODEL_SETTING_KEYS,
	INLINE_COMPLETIONS_LANGUAGE_FILTER_SETTING_KEY,
} from "../shared/config/settingSpec";
import type { TransportErrorClassification } from "../shared/errorClassification";
import type {
	ExpectedFailureCategory,
	McpOptIn,
	NonChatMode,
	NonSecretOptionalFields,
	SecretFieldId,
	SecretLocation,
} from "../shared/serverEntry";
import type { HeaderScalar } from "../shared/util/headers";
import type {
	CatalogModelSummary,
	DashboardSectionId,
	DashboardState,
	EntryModelCapabilitiesPayload,
	EntryModelParametersPayload,
	RecordChainView,
	ResettableSettingId,
	ResolvedModelsView,
	RevealableSettingId,
	SettingRowId,
} from "./viewModels";

/** IDs the extension maps to registered commands; model syncing is NOT one, it rides the acked syncModels method. */
export const DASHBOARD_COMMAND_IDS = [
	"openGroupsFile",
	"testConnection",
	"openSettings",
	"reportIssue",
	"openOutput",
	"exportSettings",
	"importSettings",
] as const;

export type DashboardCommandId = (typeof DASHBOARD_COMMAND_IDS)[number];

/** Size bounds on webview-minted values, enforced by the extension-side schemas (intentSchema.ts). */
export const WIRE_LIMITS = {
	/** Entry labels, created or addressed. */
	label: 1024,
	/** Base and OAuth token URLs. */
	url: 4096,
	/** The non-secret free-text entry fields (client ID, scopes, header name). */
	textField: 2048,
	secretValue: 8192,
	/** The Copy diagnostics text the webview composes from pushed state. */
	copyText: 1_048_576,
	/** Matcher keys in a record map. */
	recordKey: 512,
	recordFieldName: 256,
	/** Records per map; far above any per-model record set on a large proxy. */
	recordGroups: 1024,
	recordFields: 256,
	/** One record map's whole JSON rendering, in UTF-16 code units. */
	recordJsonUnits: 1024 * 1024,
	/** discovery.declared entries per save. */
	declaredModels: 1024,
	/** One raw model ID, wherever the wire carries one (declared lists, inspector reads, feature model refs). */
	modelId: 512,
	/** One chat.additionalToolSchemaKeywords keyword name. */
	schemaKeyword: 256,
	/** Keywords per chat.additionalToolSchemaKeywords write. */
	schemaKeywords: 64,
	/** One VS Code language ID in the inline-completions language filter. */
	languageId: 128,
	/** Language entries per inline-completions language filter write. */
	languageList: 256,
	/**
	 * The usage.currencySymbol display prefix. Unlike the caps above, honest input can meet this one, so the settings
	 * form pre-gates against it and the generated manifest's maxLength is this value.
	 */
	currencySymbol: 12,
	/**
	 * The commitGeneration.prompt instruction text. Honest prompts can be long, so the settings row pre-gates against
	 * this bound like the currency symbol does, and the generated manifest's maxLength is this value.
	 */
	commitPrompt: 8192,
} as const;

/**
 * What to do with one secret field on save: "keep" leaves it where it is, "clear" removes it from both locations,
 * "set" replaces it in the chosen location and removes it from the other.
 *
 *   Values -> never logged, never echoed back into DashboardState
 */
export type SecretDirective =
	| { readonly action: "keep" }
	| { readonly action: "clear" }
	| { readonly action: "set"; readonly location: "settings" | "secure"; readonly value: string };

/**
 * saveServer.ts requireEntryShownByForm re-checks this identity before resolving any "keep" directive, because a
 * label alone is spoofable by time and an entry swapped in under it would send ITS credentials to the displayed
 * hosts. Locations only, never values; the non-secret auth fields ride because they pick each secret's destination.
 * The MCP opt-in is deliberately absent: an MCP endpoint receives credentials only on the entry's own origin, which
 * `baseUrl` already pins.
 */
export interface ReplacedEntryIdentity extends NonSecretOptionalFields {
	/** The entry's label as displayed; on a rename it differs from the payload's server.label. */
	readonly label: string;

	/** The entry's base URL as displayed: a stamped destination a resolved secret may be sent to. */
	readonly baseUrl: string;

	/** The entry's apiVersion override as displayed; "" is a real value (append nothing), absent is auto. */
	readonly apiVersion?: string | undefined;

	/** Where each secret lives as displayed; a "keep" directive resolves against these. */
	readonly secrets: Readonly<Record<SecretFieldId, SecretLocation>>;
}

/** The non-secret half of a servers entry as the form submits it. */
export interface SaveServerPayload extends NonSecretOptionalFields {
	/** The entry's identity: the sync engine names the provider group after it. */
	readonly label: string;

	/** The server root, in the form's canonical http(s) spelling. */
	readonly baseUrl: string;

	/** The version segment: absent is auto (no key saved), "" appends nothing, anything else is appended verbatim. */
	readonly apiVersion?: string | undefined;

	/** The entry's per-entry modelParameters; absent or empty means the saved entry carries none. */
	readonly modelParameters?: EntryModelParametersPayload | undefined;

	/** The entry's per-entry modelCapabilities; empty means the saved entry carries none. */
	readonly modelCapabilities: EntryModelCapabilitiesPayload;

	/** The failure categories the entry treats as expected; declareExpectedFailure appends one at a time. */
	readonly expectedFailures: readonly ExpectedFailureCategory[];

	/** The entry's custom HTTP headers, plain settings text, not secrets; the schema refuses a payload without it. */
	readonly headers: Readonly<Record<string, HeaderScalar>>;

	/** discovery.declared: exact model IDs served without discovery; empty means none. */
	readonly declaredModels: readonly string[];

	/** discovery.includeModes: the non-chat modes discovery registers instead of skipping; empty means none. */
	readonly includeModes: readonly NonChatMode[];

	/** The entry's manual usage budget in USD; null means none (clearing any stored budget). */
	readonly budget: number | null;

	/** The MCP opt-in; null means none (clearing any stored opt-in). */
	readonly mcp: McpOptIn | null;
}

/** How one method's outcome returns to the webview. */
type EndpointOutcome =
	/** A correlated response. */
	| "read"
	/** A correlated ack or fail; only success is followed by the state push its write triggers. */
	| "acked"
	/** No ack; the following push is the success signal. */
	| "fire-and-forget";

/** Which queue a method's handling joins. */
type EndpointChannel =
	/** One at a time on the mutation chain: two concurrent saves would lose an update. */
	| "chained"
	/** Off the chain; only non-mutating methods. */
	| "concurrent";

/**
 * One endpoint row's shape. Only a fire-and-forget method carries `fail`, where its refused intent's standing notice
 * renders; acked failures answer their posting hook instead.
 *
 *   "settings-row" -> the owning settings row; SettingWriteMethod derives from this mark, so the SETTING_WRITE_ROWS
 *                     entry must exist before the table compiles
 *   "pane-top"     -> the shell's pane-top line (PANE_TOP_FAIL_METHODS)
 *   "log-only"     -> the output log alone; the following push carries the outcome
 */
type DashboardEndpointSpec =
	| { readonly outcome: Exclude<EndpointOutcome, "fire-and-forget">; readonly channel: EndpointChannel }
	| {
			readonly outcome: "fire-and-forget";
			readonly channel: EndpointChannel;
			readonly fail: "settings-row" | "pane-top" | "log-only";
	  };

/** One row per method the webview can call; the webview is a trust boundary, so intentSchema.ts re-validates each. */
export const DASHBOARD_ENDPOINTS = {
	/** The page-load handshake: the state push it triggers is the answer. */
	ready: { outcome: "fire-and-forget", channel: "chained", fail: "log-only" },
	setNumberSetting: { outcome: "fire-and-forget", channel: "chained", fail: "settings-row" },
	setBooleanSetting: { outcome: "fire-and-forget", channel: "chained", fail: "settings-row" },
	/** Remove the setting from the highest-precedence scope that sets it. */
	resetSetting: { outcome: "fire-and-forget", channel: "chained", fail: "settings-row" },
	/** Open the user settings.json at "litellm-vscode-chat.<setting>". */
	revealSetting: { outcome: "fire-and-forget", channel: "chained", fail: "log-only" },
	setModelParameters: { outcome: "acked", channel: "chained" },
	setModelCapabilities: { outcome: "acked", channel: "chained" },
	setUsageStatusBar: { outcome: "fire-and-forget", channel: "chained", fail: "settings-row" },
	setTokenEstimation: { outcome: "fire-and-forget", channel: "chained", fail: "settings-row" },
	setCurrencySymbol: { outcome: "fire-and-forget", channel: "chained", fail: "settings-row" },
	setAdditionalToolSchemaKeywords: { outcome: "fire-and-forget", channel: "chained", fail: "settings-row" },
	setUiTheme: { outcome: "fire-and-forget", channel: "chained", fail: "settings-row" },
	setUiAccent: { outcome: "fire-and-forget", channel: "chained", fail: "settings-row" },
	setUsageAlertThresholds: { outcome: "fire-and-forget", channel: "chained", fail: "settings-row" },
	setFeatureModel: { outcome: "fire-and-forget", channel: "chained", fail: "settings-row" },
	setCommitPrompt: { outcome: "fire-and-forget", channel: "chained", fail: "settings-row" },
	setLanguageFilter: { outcome: "fire-and-forget", channel: "chained", fail: "settings-row" },
	setChatSessionId: { outcome: "fire-and-forget", channel: "chained", fail: "settings-row" },
	/** Refresh the OpenRouter catalog now; the outcome lands in the next push's catalog status. */
	refreshCatalog: { outcome: "fire-and-forget", channel: "chained", fail: "log-only" },
	/** Refresh usage data for every server now; the poller's completion re-pushes state. */
	refreshUsage: { outcome: "fire-and-forget", channel: "chained", fail: "log-only" },
	saveServerSetting: { outcome: "acked", channel: "chained" },
	/**
	 * Append one expected-failure category to the named entry (the servers page's one-click declaration). Chained like
	 * every servers-array read-modify-write, and bound like removeServerSetting; an already-declared category acks as
	 * a no-op.
	 */
	declareExpectedFailure: { outcome: "acked", channel: "chained" },
	/**
	 * One read-only discovery probe of a draft configuration: nothing is written, synced, or cached, "keep" directives
	 * resolve against the entry `replace` identifies, and the success notice is composed extension-side, never from
	 * payload or response text. Concurrent because it can block on the network for a whole discovery timeout, and a
	 * Save queued behind an abandoned probe would stall.
	 */
	testServerDraft: { outcome: "acked", channel: "concurrent" },
	/**
	 * One read-only probe of a picked (feature, server, model) triple through the feature's own probe: the exact
	 * pipeline the feature runs (the inline-completions probe is the FIM send over a sample context - same connection
	 * resolution, template application, and fixed bounds). Refused when no probe is registered for the feature; the
	 * success notice is composed extension-side from counts only, never from response text.
	 *
	 *   it blocks on the network -> Concurrent
	 */
	testFeatureModel: { outcome: "acked", channel: "concurrent" },
	/**
	 * Remove every entry under the row's label. `label` and `baseUrl` are the row's identity: the write refuses when
	 * the entry under the label now points elsewhere, so a stale row cannot act on its successor.
	 */
	removeServerSetting: { outcome: "acked", channel: "chained" },
	/**
	 * Adopt an external provider group into the servers setting: the group's credentials are resolved extension-side
	 * (the webview never sees them) and stored where `secrets` directs per field. `sourceHandle` resolves only against
	 * groups that are still external and still at `baseUrl`.
	 */
	adoptServer: { outcome: "acked", channel: "chained" },
	/**
	 * Remove (hide) an external provider group by writing its removal tombstone. Named by the opaque handle, resolved
	 * only against groups still external and still at `baseUrl`, so a forged request cannot hide a declared group.
	 */
	hideExternalServer: { outcome: "acked", channel: "chained" },
	/** Clear one hidden group's tombstone (the identity its HiddenGroup row carried). */
	unhideServer: { outcome: "acked", channel: "chained" },
	/**
	 * Open the host's Manage Language Models editor on a hidden group, where its Delete action lives: searched for the
	 * group's synced name (the identity its HiddenGroup row carried, offered only with syncedName), and resolved
	 * against the tombstones, so a stale request opens nothing.
	 */
	manageHiddenGroup: { outcome: "acked", channel: "chained" },
	/**
	 * Acked because the answer IS the point: state pushes emit long before discovery starts, so a control disabled
	 * during the pass needs the ack to release. The ack proves only that the sync command settled, not that every
	 * server answered. No parameters: the sync covers every server, exactly as the command palette runs it.
	 *
	 *   the pass blocks on the network and never writes the servers setting -> Concurrent
	 */
	syncModels: { outcome: "acked", channel: "concurrent" },
	/**
	 * A declared entry's inline-stored secret values, for the edit form's prefill: inline values already sit in
	 * plaintext in the settings file, and secure-stored or absent fields carry NO key in the response. Deliberately a
	 * read, never part of DashboardState, since state pushes must never carry secret material. Chained although
	 * non-mutating: a prefill read must never overtake the save it follows.
	 */
	readInlineSecrets: { outcome: "read", channel: "chained" },
	/**
	 * One model's effective capabilities, produced by the same resolveModelCapabilities walk registration runs, so the
	 * inspector cannot drift from what is served.
	 */
	readModelCapabilities: { outcome: "read", channel: "concurrent" },
	/**
	 * One model's effective-parameters projection, resolved through the provider's SHARED flat resolution table, the
	 * same cache requests read.
	 */
	readModelParameters: { outcome: "read", channel: "concurrent" },
	/**
	 * The Diagnostics tab's Resolved-models view, computed extension-side. On demand rather than in state pushes
	 * because it scales with models x fields.
	 */
	readResolvedModels: { outcome: "read", channel: "concurrent" },
	/** The query is user-typed filter text, never a secret; the catalog data never enters the webview bundle. */
	searchCatalog: { outcome: "read", channel: "concurrent" },
	executeCommand: { outcome: "fire-and-forget", channel: "chained", fail: "pane-top" },
	/**
	 * The webview cannot see the known credential values and they never cross the wire, so the text it composed is
	 * redacted and written to the clipboard on the extension side.
	 */
	copyDiagnostics: { outcome: "fire-and-forget", channel: "chained", fail: "pane-top" },
} as const satisfies Record<string, DashboardEndpointSpec>;

export type DashboardMethod = keyof typeof DASHBOARD_ENDPOINTS;

type MethodsWithOutcome<O extends DashboardEndpointSpec["outcome"]> = {
	[K in DashboardMethod]: (typeof DASHBOARD_ENDPOINTS)[K]["outcome"] extends O ? K : never;
}[DashboardMethod];

export type ReadMethod = MethodsWithOutcome<"read">;
export type AckedMethod = MethodsWithOutcome<"acked">;
type FireAndForgetMethod = MethodsWithOutcome<"fire-and-forget">;

export type NotifyingMethod = AckedMethod | FireAndForgetMethod;

/**
 * A method missing a row breaks the RequestPayload mapped type; a read missing `response` breaks ResponseFor. What a
 * method does and refuses sits on its DASHBOARD_ENDPOINTS row; the payload rules the schema re-checks sit here.
 *
 *   setCurrencySymbol               -> any short string, "" included (bare numbers); the schema bounds the length
 *   setAdditionalToolSchemaKeywords -> non-empty keyword names; the extension refuses anything else
 *   setUsageAlertThresholds         -> fractions in (0, 1]; the extension refuses out-of-range entries
 *   setFeatureModel                 -> an entry label plus a raw model ID (user configuration, never a secret); null
 *                                      clears the pick and resets the setting
 *   setCommitPrompt                 -> the empty string resets the setting
 *   setLanguageFilter               -> one field per request, since each settings row sends only its own half (the
 *                                      schema refuses both or neither); the type stays the optional pair so
 *                                      executeDashboardIntent keeps its own empty-patch refusal for a bypassing caller
 *   saveServerSetting, testServerDraft
 *                                   -> `replace` is the displayed identity of the edited entry, absent when adding
 *   readModelCapabilities, readModelParameters
 *                                   -> addressed by scope key plus raw ID; a stale key de-resolves, and an absent
 *                                      result says so instead of inventing values; `globalRecordKey` and `chains`
 *                                      are extension-computed
 */
interface DashboardEndpointIO {
	ready: { request: null };
	setNumberSetting: { request: { readonly setting: NumberSettingId; readonly value: number | null } };
	setBooleanSetting: { request: { readonly setting: BooleanSettingId; readonly value: boolean } };
	resetSetting: { request: { readonly setting: ResettableSettingId } };
	revealSetting: { request: { readonly setting: RevealableSettingId } };
	setModelParameters: { request: { readonly value: Record<string, Record<string, unknown>> } };
	setModelCapabilities: { request: { readonly value: Record<string, Record<string, unknown>> } };
	setUsageStatusBar: { request: { readonly value: UsageStatusBarMode } };
	setChatSessionId: { request: { readonly value: SessionIdMode } };
	setTokenEstimation: { request: { readonly value: TokenEstimationMode } };
	setCurrencySymbol: { request: { readonly value: string } };
	setAdditionalToolSchemaKeywords: { request: { readonly values: readonly string[] } };
	setUiTheme: { request: { readonly value: UiTheme } };
	setUiAccent: { request: { readonly value: UiAccent } };
	setUsageAlertThresholds: { request: { readonly values: readonly number[] } };
	setFeatureModel: { request: { readonly feature: FeatureModelId; readonly value: FeatureModelRef | null } };
	setCommitPrompt: { request: { readonly value: string } };
	setLanguageFilter: {
		request: {
			readonly mode?: LanguageFilterMode | undefined;
			readonly languages?: readonly string[] | undefined;
		};
	};
	refreshCatalog: { request: null };
	refreshUsage: { request: null };
	saveServerSetting: {
		request: {
			readonly server: SaveServerPayload;
			readonly secrets: Readonly<Record<SecretFieldId, SecretDirective>>;
			readonly replace?: ReplacedEntryIdentity | undefined;
		};
	};
	testServerDraft: {
		request: {
			readonly server: SaveServerPayload;
			readonly secrets: Readonly<Record<SecretFieldId, SecretDirective>>;
			readonly replace?: ReplacedEntryIdentity | undefined;
		};
	};
	testFeatureModel: { request: { readonly feature: FeatureModelId; readonly model: FeatureModelRef } };
	removeServerSetting: { request: { readonly label: string; readonly baseUrl: string } };
	declareExpectedFailure: {
		request: { readonly label: string; readonly baseUrl: string; readonly category: ExpectedFailureCategory };
	};
	adoptServer: {
		request: {
			readonly label: string;
			readonly baseUrl: string;
			readonly sourceHandle: string;
			readonly secrets: Readonly<Record<SecretFieldId, Exclude<SecretLocation, "none">>>;
		};
	};
	hideExternalServer: { request: { readonly baseUrl: string; readonly sourceHandle: string } };
	unhideServer: { request: { readonly label: string; readonly baseUrl: string } };
	manageHiddenGroup: { request: { readonly label: string; readonly baseUrl: string } };
	readInlineSecrets: {
		/** The displayed identity, not a label: a same-label replacement racing the prefill gets an empty answer. */
		request: { readonly replace: ReplacedEntryIdentity };

		/** Prefills for the edit form (applyInlinePrefill); unedited and kept inline, a prefill saves as "keep". */
		response: { readonly values: Readonly<Partial<Record<SecretFieldId, string>>> };
	};
	readModelCapabilities: {
		request: { readonly scopeKey: string; readonly rawId: string };
		response: {
			readonly capabilities?: EffectiveCapabilities | undefined;
			readonly globalRecordKey?: string | undefined;
			readonly chains?: readonly RecordChainView[] | undefined;
		};
	};
	readModelParameters: {
		request: { readonly scopeKey: string; readonly rawId: string };
		response: {
			readonly projection?: EffectiveParametersProjection | undefined;
			readonly globalRecordKey?: string | undefined;
			readonly chains?: readonly RecordChainView[] | undefined;
		};
	};
	readResolvedModels: { request: null; response: { readonly view: ResolvedModelsView } };
	searchCatalog: {
		request: { readonly query: string };
		response: { readonly results: readonly CatalogModelSummary[] };
	};
	executeCommand: { request: { readonly command: DashboardCommandId } };
	copyDiagnostics: { request: { readonly text: string } };
	syncModels: { request: null };
}

export type RequestPayload<K extends DashboardMethod> = DashboardEndpointIO[K]["request"];

export type ResponseFor<K extends ReadMethod> = DashboardEndpointIO[K]["response"];

/**
 *   `id` -> a webview-minted correlation token, echoed by the response, ack, or fail that answers it
 */
export type RpcRequest<K extends DashboardMethod> = {
	readonly kind: "request";
	readonly id: string;
	readonly method: K;
	readonly payload: RequestPayload<K>;
};

export type RpcRequestType = { [K in DashboardMethod]: RpcRequest<K> }[DashboardMethod];

type IntentMethod = Exclude<NotifyingMethod, "ready">;

export type DashboardIntent = {
	[K in IntentMethod]: { readonly method: K; readonly payload: RequestPayload<K> };
}[IntentMethod];

type RpcResponse<K extends ReadMethod> = {
	readonly kind: "response";
	readonly id: string;
	readonly method: K;
	readonly payload: ResponseFor<K>;
};

export type RpcResponseType = { [K in ReadMethod]: RpcResponse<K> }[ReadMethod];

/** The one non-quiet success register an ack may carry; every tone-carrying surface derives from this. */
export type IntentAckTone = "warning";

/**
 * `message` is an optional caveat about the success - informational text only, never a value from the payload. `tone`
 * marks a success worth a warning rendering (the draft probe's zero-model outcome); absent renders the quiet success.
 */
interface IntentAckMessage {
	readonly kind: "ack";
	readonly id: string;
	readonly method: AckedMethod;
	readonly message?: string | undefined;
	readonly tone?: IntentAckTone | undefined;
}

/**
 * A refused or failed intent. Text here is webview-safe, never a secret, and the classification is an enum id, never
 * message text.
 *
 *   message        -> what the webview shows
 *   englishMessage -> its English twin when the thrower supplied one; the agent tools relay it to the calling model,
 *                     since model-facing text stays English
 *   failureKind    -> "validation" means nothing landed, so the editor's draft is still the truth
 *   classification -> the transport classification behind a failed probe
 *   row            -> the failed scalar write's owning settings row (settingWriteRow), derived from the validated
 *                     payload, never webview-minted
 */
interface IntentFailMessage {
	readonly kind: "fail";
	readonly id: string;
	readonly method: NotifyingMethod;
	readonly message: string;
	readonly englishMessage?: string | undefined;
	readonly failureKind: "validation" | "operation";
	readonly classification?: TransportErrorClassification | undefined;
	readonly row?: SettingRowId | undefined;
}

/**
 * Extension-to-webview messages: full state pushes (the webview never holds partial truth), the focusSection deep link,
 * read responses, and per-intent outcome notices. focusSection switches the page to a section (the
 * litellm.showDiagnostics deep link), after the ready handshake or directly when the page is live.
 *
 *   A validation-kind failure -> produces no state push
 */
export type ExtensionToWebviewMessage =
	| { readonly kind: "push"; readonly state: DashboardState }
	| { readonly kind: "focusSection"; readonly section: DashboardSectionId }
	| RpcResponseType
	| IntentAckMessage
	| IntentFailMessage;

/** Every extension-to-webview kind: a new union member fails to compile here instead of being dropped by the guard. */
const EXTENSION_MESSAGE_KINDS: Readonly<Record<ExtensionToWebviewMessage["kind"], true>> = {
	push: true,
	focusSection: true,
	response: true,
	ack: true,
	fail: true,
};

/**
 * The webview's receive guard. Window messages come from the extension only (the CSP allows no other frames), so a
 * discriminant shape check suffices.
 */
export function isExtensionMessage(data: unknown): data is ExtensionToWebviewMessage {
	if (typeof data !== "object" || data === null) {
		return false;
	}
	const kind = (data as { kind?: unknown }).kind;
	return typeof kind === "string" && Object.hasOwn(EXTENSION_MESSAGE_KINDS, kind);
}

export function isAckedMethod(method: string): method is AckedMethod {
	return (
		Object.hasOwn(DASHBOARD_ENDPOINTS, method) && DASHBOARD_ENDPOINTS[method as DashboardMethod].outcome === "acked"
	);
}

/**
 * The scalar setting-write methods, whose fail envelopes carry the owning settings row (`row` on IntentFailMessage) so
 * the Settings page can place a standing refusal under the row that posted it without keeping a correlation map of its
 * own. Derived from the table's `fail: "settings-row"` marks, never hand-listed: a method joins the class where its
 * endpoint row is declared, and joining without a SETTING_WRITE_ROWS entry (or the inverse) fails the mapped type
 * below.
 */
export type SettingWriteMethod = {
	[K in DashboardMethod]: (typeof DASHBOARD_ENDPOINTS)[K] extends { readonly fail: "settings-row" } ? K : never;
}[DashboardMethod];

/**
 * The fire-and-forget methods whose standing fail notice is the shell's pane-top line (methods posted from any tab that
 * own no settings row). Derived from the table like SettingWriteMethod: marking a row "pane-top" is the whole
 * registration - the shell iterates this list, so there is no second list a new method could miss.
 */
type PaneTopFailMethod = {
	[K in DashboardMethod]: (typeof DASHBOARD_ENDPOINTS)[K] extends { readonly fail: "pane-top" } ? K : never;
}[DashboardMethod];

export const PANE_TOP_FAIL_METHODS = (Object.keys(DASHBOARD_ENDPOINTS) as readonly DashboardMethod[]).filter(
	(method): method is PaneTopFailMethod => {
		const spec: DashboardEndpointSpec = DASHBOARD_ENDPOINTS[method];
		return spec.outcome === "fire-and-forget" && spec.fail === "pane-top";
	}
);

const SETTING_WRITE_ROWS: { readonly [K in SettingWriteMethod]: (payload: RequestPayload<K>) => SettingRowId } = {
	setNumberSetting: (payload) => payload.setting,
	setBooleanSetting: (payload) => payload.setting,
	resetSetting: (payload) => payload.setting,
	setUsageAlertThresholds: () => "usage.alertThresholds",
	setUsageStatusBar: () => "usage.statusBar",
	setTokenEstimation: () => "chat.tokenEstimation",
	setAdditionalToolSchemaKeywords: () => "chat.additionalToolSchemaKeywords",
	setCurrencySymbol: () => "usage.currencySymbol",
	setUiTheme: () => "ui.theme",
	setUiAccent: () => "ui.accent",
	setFeatureModel: (payload) => FEATURE_MODEL_SETTING_KEYS[payload.feature],
	setCommitPrompt: () => "commitGeneration.prompt",
	setLanguageFilter: () => INLINE_COMPLETIONS_LANGUAGE_FILTER_SETTING_KEY,
	setChatSessionId: () => CHAT_SESSION_ID_SETTING_KEY,
};

export const SETTING_WRITE_METHODS = Object.keys(SETTING_WRITE_ROWS) as readonly SettingWriteMethod[];

type MethodPayload = {
	[K in DashboardMethod]: { readonly method: K; readonly payload: RequestPayload<K> };
}[DashboardMethod];

type SettingWritePayload = {
	[K in SettingWriteMethod]: { readonly method: K; readonly payload: RequestPayload<K> };
}[SettingWriteMethod];

function isSettingWrite(request: MethodPayload): request is SettingWritePayload {
	return Object.hasOwn(SETTING_WRITE_ROWS, request.method);
}

/** Generic so the mapped lookup keeps the method-payload correlation the union erases. */
function settingWriteRowOf<K extends SettingWriteMethod>(request: {
	readonly method: K;
	readonly payload: RequestPayload<K>;
}): SettingRowId {
	return SETTING_WRITE_ROWS[request.method](request.payload);
}

/**
 * The settings row a scalar write's failure lands on, or undefined for any other method. Derived from the validated
 * payload rather than carried as a webview-minted field, so a row that mismatches its request is unrepresentable.
 */
export function settingWriteRow(request: MethodPayload): SettingRowId | undefined {
	return isSettingWrite(request) ? settingWriteRowOf(request) : undefined;
}

/**
 * Acked methods' failures survive pushes: a push is not their success signal, and a partially applied save requests a
 * sync whose push would otherwise erase the very warning the save raised. Every other method's success signal IS the
 * following push.
 */
export function failuresAfterStatePush<K extends string, V>(
	failures: Readonly<Partial<Record<K, V>>>
): Readonly<Partial<Record<K, V>>> {
	const kept = Object.entries(failures).filter(([method]) => isAckedMethod(method));
	if (kept.length === Object.keys(failures).length) {
		return failures;
	}
	return Object.fromEntries(kept) as Partial<Record<K, V>>;
}
