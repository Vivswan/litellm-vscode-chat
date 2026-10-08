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
	TokenEstimationMode,
	UiAccent,
	UiTheme,
	UsageStatusBarMode,
} from "../shared/config/settingSpec";
import {
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

/** Actions the webview can trigger; the extension maps each ID to a command it already registers.
 * Model syncing is deliberately NOT here: it goes through the acked `syncModels` wire method. */
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
 */
export interface ReplacedEntryIdentity extends NonSecretOptionalFields {
	readonly label: string;
	readonly baseUrl: string;
	/** The entry's apiVersion override as displayed; "" is a real value (append nothing), absent is auto. */
	readonly apiVersion?: string | undefined;
	readonly secrets: Readonly<Record<SecretFieldId, SecretLocation>>;
}

/**
 * The non-secret half of a servers entry as the form submits it.
 *
 *   the sync engine names the provider group after it -> The label is the entry's identity
 */
export interface SaveServerPayload extends NonSecretOptionalFields {
	readonly label: string;
	readonly baseUrl: string;
	/**
	 *   absent        -> auto (the saved entry carries no key)
	 *   ""            -> append nothing
	 *   anything else -> appended verbatim
	 */
	readonly apiVersion?: string | undefined;
	/** The entry's per-entry modelParameters; absent or empty means the saved entry carries none. */
	readonly modelParameters?: EntryModelParametersPayload | undefined;
	/** The entry's per-entry modelCapabilities; empty means the saved entry carries none. */
	readonly modelCapabilities: EntryModelCapabilitiesPayload;
	readonly expectedFailures: readonly ExpectedFailureCategory[];
	/**
	 * The entry's custom HTTP headers (plain settings text, not secrets).
	 *
	 *   the schema refuses a payload without it -> Always sent
	 */
	readonly headers: Readonly<Record<string, HeaderScalar>>;
	readonly declaredModels: readonly string[];
	readonly includeModes: readonly NonChatMode[];
	/** The entry's manual usage budget in USD; null means none (clearing any stored budget). */
	readonly budget: number | null;
	/**
	 * Deliberately absent from ReplacedEntryIdentity, which re-checks the STAMPED destinations a resolved secret may be
	 * sent to (the base URL, the token URL). An MCP endpoint is not one of those: it receives credentials only on the
	 * entry's own origin, which `baseUrl` - already in the identity - is what pins.
	 *
	 *   null -> none (clearing any stored opt-in)
	 */
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

type DashboardEndpointSpec =
	| { readonly outcome: Exclude<EndpointOutcome, "fire-and-forget">; readonly channel: EndpointChannel }
	| {
			readonly outcome: "fire-and-forget";
			readonly channel: EndpointChannel;
			/**
			 * Where a refused fire-and-forget intent's standing notice renders. Acked failures answer their posting
			 * hook instead, so only this variant carries `fail`.
			 *
			 *   "settings-row" -> the owning settings row; SettingWriteMethod derives from this mark, so the
			 *                     SETTING_WRITE_ROWS entry must exist before the table compiles
			 *   "pane-top"     -> the shell's pane-top line (PANE_TOP_FAIL_METHODS)
			 *   "log-only"     -> the output log alone; the following push carries the outcome
			 */
			readonly fail: "settings-row" | "pane-top" | "log-only";
	  };

/**
 * The endpoint table: one row per method the webview can call. The webview is a trust boundary - the extension
 * re-validates every request against the schema map in extension/dashboard/intentSchema.ts, mapped over this table.
 */
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
	/** Refresh the OpenRouter catalog now; the outcome lands in the next push's catalog status. */
	refreshCatalog: { outcome: "fire-and-forget", channel: "chained", fail: "log-only" },
	/** Refresh usage data for every server now; the poller's completion re-pushes state. */
	refreshUsage: { outcome: "fire-and-forget", channel: "chained", fail: "log-only" },
	saveServerSetting: { outcome: "acked", channel: "chained" },
	/**
	 * Append one expected-failure category to the named entry (the servers page's one-click declaration). Chained like
	 * every servers-array read-modify-write.
	 */
	declareExpectedFailure: { outcome: "acked", channel: "chained" },
	/**
	 * One read-only discovery probe of a draft configuration. Concurrent because it can block on the network for a
	 * whole discovery timeout, and a Save queued behind an abandoned probe would stall.
	 */
	testServerDraft: { outcome: "acked", channel: "concurrent" },
	/**
	 * One read-only probe of a picked (feature, server, model) triple.
	 *
	 *   it blocks on the network -> Concurrent
	 */
	testFeatureModel: { outcome: "acked", channel: "concurrent" },
	removeServerSetting: { outcome: "acked", channel: "chained" },
	adoptServer: { outcome: "acked", channel: "chained" },
	hideExternalServer: { outcome: "acked", channel: "chained" },
	unhideServer: { outcome: "acked", channel: "chained" },
	/** Open the host's Manage Language Models editor on a hidden group, where its Delete action lives. */
	manageHiddenGroup: { outcome: "acked", channel: "chained" },
	/**
	 * Acked because the answer IS the point: state pushes emit long before discovery starts, so a control disabled
	 * during the pass needs the ack to release. The ack proves only that the sync command settled, not that every
	 * server answered.
	 *
	 *   the pass blocks on the network and never writes the servers setting -> Concurrent
	 */
	syncModels: { outcome: "acked", channel: "concurrent" },
	/** Chained although non-mutating: a prefill read must never overtake the save it follows. */
	readInlineSecrets: { outcome: "read", channel: "chained" },
	readModelCapabilities: { outcome: "read", channel: "concurrent" },
	readModelParameters: { outcome: "read", channel: "concurrent" },
	readResolvedModels: { outcome: "read", channel: "concurrent" },
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

/** A method missing a row breaks the RequestPayload mapped type; a read missing `response` breaks ResponseFor. */
interface DashboardEndpointIO {
	ready: { request: null };
	setNumberSetting: { request: { readonly setting: NumberSettingId; readonly value: number | null } };
	setBooleanSetting: { request: { readonly setting: BooleanSettingId; readonly value: boolean } };
	resetSetting: { request: { readonly setting: ResettableSettingId } };
	revealSetting: { request: { readonly setting: RevealableSettingId } };
	setModelParameters: { request: { readonly value: Record<string, Record<string, unknown>> } };
	setModelCapabilities: { request: { readonly value: Record<string, Record<string, unknown>> } };
	setUsageStatusBar: { request: { readonly value: UsageStatusBarMode } };
	setTokenEstimation: { request: { readonly value: TokenEstimationMode } };
	/** Any short string, the empty string included (bare numbers); the extension bounds the length at the schema. */
	setCurrencySymbol: { request: { readonly value: string } };
	/** Values must be non-empty keyword names; the extension re-validates and refuses anything else. */
	setAdditionalToolSchemaKeywords: { request: { readonly values: readonly string[] } };
	setUiTheme: { request: { readonly value: UiTheme } };
	setUiAccent: { request: { readonly value: UiAccent } };
	/** Values must be fractions in (0, 1]; the extension re-validates and refuses out-of-range entries. */
	setUsageAlertThresholds: { request: { readonly values: readonly number[] } };
	/**
	 * Pick or clear one feature's model: a declared entry's label plus a raw model ID (user configuration, never a
	 * secret); null clears the pick and resets the setting.
	 *
	 *   the feature discriminant -> names the setting
	 */
	setFeatureModel: { request: { readonly feature: FeatureModelId; readonly value: FeatureModelRef | null } };
	/**
	 *   the empty string -> resets the setting
	 */
	setCommitPrompt: { request: { readonly value: string } };
	/**
	 * One field per request because each settings row sends only its own half (the schema refuses both or neither).
	 * The type stays the optional pair so executeDashboardIntent keeps its own empty-patch refusal for a bypassing
	 * caller.
	 */
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
			/**
			 * When editing: the displayed identity of the entry to replace (its label differs from server.label on
			 * rename).
			 */
			readonly replace?: ReplacedEntryIdentity | undefined;
		};
	};
	/**
	 * Read-only by contract: nothing is written, synced, or cached. "keep" directives resolve against the entry
	 * `replace` identifies, and the success notice is composed extension-side, never from payload or response text.
	 */
	testServerDraft: {
		request: {
			readonly server: SaveServerPayload;
			readonly secrets: Readonly<Record<SecretFieldId, SecretDirective>>;
			readonly replace?: ReplacedEntryIdentity | undefined;
		};
	};
	/**
	 * Test one feature's picked (server, model) pair with the feature's own probe: the exact pipeline the feature runs
	 * (the inline-completions probe is the FIM send over a sample context - same connection resolution, template
	 * application, and fixed bounds). Read-only, and the success notice is composed extension-side from counts only -
	 * never from response text.
	 *
	 *   no probe is registered for the feature -> Refused
	 */
	testFeatureModel: { request: { readonly feature: FeatureModelId; readonly model: FeatureModelRef } };
	/**
	 * Remove every entry under the row's label. `label` and `baseUrl` are the row's identity: the write refuses when
	 * the entry under the label now points elsewhere, so a stale row cannot act on its successor.
	 */
	removeServerSetting: { request: { readonly label: string; readonly baseUrl: string } };
	/**
	 * Append `category` (a closed vocabulary) to the declared entry the row identifies, bound like
	 * removeServerSetting; an already-declared category acks as a no-op.
	 */
	declareExpectedFailure: {
		request: { readonly label: string; readonly baseUrl: string; readonly category: ExpectedFailureCategory };
	};
	/**
	 * Adopt an external provider group into the servers setting: the group's credentials are resolved extension-side
	 * (the webview never sees them) and stored where `secrets` directs per field. `sourceHandle` resolves only against
	 * groups that are still external and still at `baseUrl`.
	 */
	adoptServer: {
		request: {
			readonly label: string;
			readonly baseUrl: string;
			readonly sourceHandle: string;
			readonly secrets: Readonly<Record<SecretFieldId, Exclude<SecretLocation, "none">>>;
		};
	};
	/**
	 * Remove (hide) an external provider group by writing its removal tombstone. Named by the opaque handle, resolved
	 * only against groups still external and still at `baseUrl`, so a forged request cannot hide a declared group.
	 */
	hideExternalServer: { request: { readonly baseUrl: string; readonly sourceHandle: string } };
	/** Clear one hidden group's tombstone (the identity its HiddenGroup row carried). */
	unhideServer: { request: { readonly label: string; readonly baseUrl: string } };
	/**
	 * Open Manage Language Models searched for a hidden group's synced name (the identity its HiddenGroup row carried,
	 * offered only with syncedName). Resolved against the tombstones, so a stale request opens nothing.
	 */
	manageHiddenGroup: { request: { readonly label: string; readonly baseUrl: string } };
	/**
	 * A declared entry's inline-stored secret values, for the edit form's prefill: inline values already sit in
	 * plaintext in the settings file. Secure-stored or absent fields carry NO key in the response; their values never
	 * reach the webview.
	 *
	 *   state pushes must never carry secret material -> Deliberately a read, never part of DashboardState
	 */
	readInlineSecrets: {
		/**
		 * The displayed identity of the entry being edited, not a bare label: a same-label replacement racing the
		 * prefill must get an empty answer, never the replacement's inline values into a form showing another entry.
		 */
		request: { readonly replace: ReplacedEntryIdentity };
		response: { readonly values: Readonly<Partial<Record<SecretFieldId, string>>> };
	};
	/**
	 * One model's effective capabilities, produced by the same resolveModelCapabilities walk registration runs, so the
	 * inspector cannot drift from what is served. Addressed by scope key plus raw ID; a stale key de-resolves, and
	 * absent `capabilities` says so instead of inventing values.
	 *
	 *   `globalRecordKey` and `chains` -> extension-computed
	 */
	readModelCapabilities: {
		request: { readonly scopeKey: string; readonly rawId: string };
		response: {
			readonly capabilities?: EffectiveCapabilities | undefined;
			readonly globalRecordKey?: string | undefined;
			readonly chains?: readonly RecordChainView[] | undefined;
		};
	};
	/**
	 *   One model's effective-parameters projection -> resolved through the provider's SHARED flat resolution table
	 *   the provider's SHARED flat resolution table -> the same cache requests read
	 */
	readModelParameters: {
		request: { readonly scopeKey: string; readonly rawId: string };
		response: {
			readonly projection?: EffectiveParametersProjection | undefined;
			readonly globalRecordKey?: string | undefined;
			readonly chains?: readonly RecordChainView[] | undefined;
		};
	};
	/**
	 * The Diagnostics tab's Resolved-models view, computed extension-side. On demand rather than in state pushes
	 * because it scales with models x fields.
	 */
	readResolvedModels: { request: null; response: { readonly view: ResolvedModelsView } };
	/** The query is user-typed filter text, never a secret; the catalog data itself never enters the webview bundle. */
	searchCatalog: {
		request: { readonly query: string };
		response: { readonly results: readonly CatalogModelSummary[] };
	};
	executeCommand: { request: { readonly command: DashboardCommandId } };
	copyDiagnostics: { request: { readonly text: string } };
	/** No parameters: the sync is fleet-wide, exactly as the command palette runs it. */
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
 * `message` is webview-safe text (never a secret); `classification` is the transport classification behind a failed
 * probe - enum ids, never message text; `row` is the failed scalar write's owning settings row (settingWriteRow),
 * extension-derived from the validated payload.
 *
 *   "validation"   -> nothing landed
 *   nothing landed -> the editor's draft is still the truth
 */
interface IntentFailMessage {
	readonly kind: "fail";
	readonly id: string;
	readonly method: NotifyingMethod;
	readonly message: string;
	readonly failureKind: "validation" | "operation";
	readonly classification?: TransportErrorClassification | undefined;
	readonly row?: SettingRowId | undefined;
}

/**
 * Extension-to-webview messages: full state pushes (the webview never holds partial truth), the focusSection deep link,
 * read responses, and per-intent outcome notices.
 *
 *   A validation-kind failure -> produces no state push
 */
export type ExtensionToWebviewMessage =
	| { readonly kind: "push"; readonly state: DashboardState }
	| {
			/**
			 * Switch the page to a section (the litellm.showDiagnostics deep link), after the ready handshake or
			 * directly when the page is live.
			 */
			readonly kind: "focusSection";
			readonly section: DashboardSectionId;
	  }
	| RpcResponseType
	| IntentAckMessage
	| IntentFailMessage;

/**
 * Every extension-to-webview discriminant: a kind added to the union stops compiling until registered here, instead of
 * being silently dropped by the webview's receive guard.
 */
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

/**
 * Derivation (rather than a webview-minted payload field) makes a row that mismatches its request unrepresentable. The
 * ONE registry for the class: exhaustive over SettingWriteMethod by mapped type, and the method list below derives
 * from it rather than standing beside it.
 */
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
