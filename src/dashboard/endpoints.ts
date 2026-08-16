/**
 * The dashboard's wire contract as one endpoint table: the envelope unions,
 * the chained-vs-concurrent routing, the zod schema map, and the panel
 * handler map all derive from DASHBOARD_ENDPOINTS by mapped types, so a
 * method missing a payload, schema, handler, or (for reads) response type
 * fails compilation. Imported by both sides, so it stays pure: no vscode,
 * DOM, Node, or zod. Boundary invariants: state pushes carry secret
 * LOCATIONS, never values (the one value path is the readInlineSecrets read,
 * whose fields already sit in plaintext in the settings file); failure
 * notices carry webview-safe text; the panel logs classifications only.
 */

import type { EffectiveCapabilities } from "../shared/config/capabilityResolution";
import type { EffectiveParametersProjection } from "../shared/config/parameterResolution";
import type {
	BooleanSettingId,
	NumberSettingId,
	TokenEstimationMode,
	UiAccent,
	UiTheme,
} from "../shared/config/settingSpec";
import type { TransportErrorClassification } from "../shared/errorClassification";
import type {
	ExpectedFailureCategory,
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
	UsageStatusBarModeSetting,
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

/**
 * Size bounds on webview-minted values, enforced by the extension-side
 * schemas (intentSchema.ts). Generous enough that no honest input meets one:
 * they only keep a hostile or broken page from ballooning a settings write,
 * and anything refused comes back as a correlated validation failure.
 */
export const WIRE_LIMITS = {
	/** Entry labels, created or addressed. */
	label: 1024,
	/** Base and OAuth token URLs. */
	url: 4096,
	/** The non-secret free-text entry fields (client ID, scopes, header name). */
	textField: 2048,
	/** Secret values (API keys, client secrets, virtual keys). */
	secretValue: 8192,
	/** Matcher keys in a record map. */
	recordKey: 512,
	/** Field names inside one record. */
	recordFieldName: 256,
	/** Records per map; far above any per-model record set on a large proxy. */
	recordGroups: 1024,
	/** Fields per record. */
	recordFields: 256,
	/** One record map's whole JSON rendering, in UTF-16 code units. */
	recordJsonUnits: 1024 * 1024,
	/** discovery.declared entries per save. */
	declaredModels: 1024,
	/**
	 * The usage.currencySymbol display prefix. Unlike the caps above, honest
	 * input can meet this one, so the settings form pre-gates against it and
	 * package.json's manifest maxLength mirrors it (pinned by test - JSON
	 * cannot reference this constant).
	 */
	currencySymbol: 12,
} as const;

/**
 * What to do with one secret field on save: "keep" leaves it where it is,
 * "clear" removes it from both locations, "set" replaces it in the chosen
 * location and removes it from the other. Values flow webview -> extension ->
 * storage only: never logged, never echoed back into DashboardState.
 */
export type SecretDirective =
	| { readonly action: "keep" }
	| { readonly action: "clear" }
	| { readonly action: "set"; readonly location: "settings" | "secure"; readonly value: string };

/**
 * The non-secret half of a servers entry as the form submits it. The label is
 * the entry's identity: the sync engine names the provider group after it, so
 * renaming creates a new group.
 */
export interface SaveServerPayload extends NonSecretOptionalFields {
	readonly label: string;
	readonly baseUrl: string;
	/**
	 * The entry's apiVersion override: absent means auto (the saved entry
	 * carries no key), "" means append nothing to the base URL, anything else
	 * is appended verbatim.
	 */
	readonly apiVersion?: string | undefined;
	/** The entry's per-entry modelParameters; absent or empty means the saved entry carries none. */
	readonly modelParameters?: EntryModelParametersPayload | undefined;
	/** The entry's per-entry modelCapabilities; empty means the saved entry carries none. */
	readonly modelCapabilities: EntryModelCapabilitiesPayload;
	/** The entry's expected discovery-failure categories; empty means none. */
	readonly expectedFailures: readonly ExpectedFailureCategory[];
	/**
	 * The entry's custom HTTP headers (plain settings text, not secrets).
	 * Always sent - the schema refuses a payload without it, so a save can
	 * never silently delete a stored record it did not mean to touch.
	 */
	readonly headers: Readonly<Record<string, HeaderScalar>>;
	/** The entry's discovery.declared model IDs; empty means none. */
	readonly declaredModels: readonly string[];
	/** The entry's manual usage budget in USD; null means none (clearing any stored budget). */
	readonly budget: number | null;
}

/**
 * How one method's outcome returns, and which queue its handling joins.
 *
 * outcome: "read" answers with a correlated response envelope; "acked" posts
 * a correlated ack (or fail) and then the state push its landed write
 * triggers; "fire-and-forget" gets no ack - the following state push is the
 * success signal, and only failures notify.
 *
 * channel: "chained" methods run one at a time on the mutation chain (two
 * concurrent saves would read-modify-write the same servers array and lose
 * one update); only genuinely non-mutating methods may be "concurrent", and
 * readInlineSecrets deliberately stays chained so a prefill read never
 * overtakes the save it follows.
 */
interface DashboardEndpointSpec {
	readonly outcome: "read" | "acked" | "fire-and-forget";
	readonly channel: "chained" | "concurrent";
}

/**
 * The endpoint table: one row per method the webview can call. The webview is
 * a trust boundary - the extension re-validates every request against the
 * schema map in extension/dashboard/intentSchema.ts, mapped over this table.
 */
export const DASHBOARD_ENDPOINTS = {
	/** The page-load handshake: the state push it triggers is the answer. */
	ready: { outcome: "fire-and-forget", channel: "chained" },
	setNumberSetting: { outcome: "fire-and-forget", channel: "chained" },
	setBooleanSetting: { outcome: "fire-and-forget", channel: "chained" },
	/** Remove the setting from the highest-precedence scope that sets it. */
	resetSetting: { outcome: "fire-and-forget", channel: "chained" },
	/** Open the user settings.json at "litellm-vscode-chat.<setting>". */
	revealSetting: { outcome: "fire-and-forget", channel: "chained" },
	setModelParameters: { outcome: "acked", channel: "chained" },
	setModelCapabilities: { outcome: "acked", channel: "chained" },
	setUsageStatusBar: { outcome: "fire-and-forget", channel: "chained" },
	setTokenEstimation: { outcome: "fire-and-forget", channel: "chained" },
	setCurrencySymbol: { outcome: "fire-and-forget", channel: "chained" },
	setAdditionalToolSchemaKeywords: { outcome: "fire-and-forget", channel: "chained" },
	setUiTheme: { outcome: "fire-and-forget", channel: "chained" },
	setUiAccent: { outcome: "fire-and-forget", channel: "chained" },
	setUsageAlertThresholds: { outcome: "fire-and-forget", channel: "chained" },
	/** Refresh the OpenRouter catalog now; the outcome lands in the next push's catalog status. */
	refreshCatalog: { outcome: "fire-and-forget", channel: "chained" },
	/** Refresh usage data for every server now; the poller's completion re-pushes state. */
	refreshUsage: { outcome: "fire-and-forget", channel: "chained" },
	saveServerSetting: { outcome: "acked", channel: "chained" },
	/**
	 * Append one expected-failure category to the named entry (the servers
	 * page's one-click declaration). Chained like every servers-array
	 * read-modify-write.
	 */
	declareExpectedFailure: { outcome: "acked", channel: "chained" },
	/**
	 * One read-only discovery probe of a draft configuration. Concurrent
	 * because it can block on the network for a whole discovery timeout, and a
	 * Save queued behind an abandoned probe would stall.
	 */
	testServerDraft: { outcome: "acked", channel: "concurrent" },
	removeServerSetting: { outcome: "acked", channel: "chained" },
	/** Adopt an external provider group into the servers setting; credentials resolve extension-side only. */
	adoptServer: { outcome: "acked", channel: "chained" },
	hideExternalServer: { outcome: "acked", channel: "chained" },
	unhideServer: { outcome: "acked", channel: "chained" },
	/**
	 * Run a full model sync now; the ack answers when the pass settles. Acked
	 * because the answer IS the point: state pushes emit long before discovery
	 * starts, so a control disabled during the pass needs the ack to release.
	 * The ack proves only that the sync command settled (the host-refresh wait
	 * is bounded), not that every server answered. Concurrent because the pass
	 * blocks on the network and never writes the servers setting - nothing
	 * needs serializing, and the sync engine collapses overlapping passes.
	 */
	syncModels: { outcome: "acked", channel: "concurrent" },
	/** The edit form's on-demand prefill of inline-stored secret fields; see the response payload. */
	readInlineSecrets: { outcome: "read", channel: "chained" },
	readModelCapabilities: { outcome: "read", channel: "concurrent" },
	readModelParameters: { outcome: "read", channel: "concurrent" },
	readResolvedModels: { outcome: "read", channel: "concurrent" },
	searchCatalog: { outcome: "read", channel: "concurrent" },
	executeCommand: { outcome: "fire-and-forget", channel: "chained" },
} as const satisfies Record<string, DashboardEndpointSpec>;

export type DashboardMethod = keyof typeof DASHBOARD_ENDPOINTS;

/** The methods of one outcome class, derived from the table. */
type MethodsWithOutcome<O extends DashboardEndpointSpec["outcome"]> = {
	[K in DashboardMethod]: (typeof DASHBOARD_ENDPOINTS)[K]["outcome"] extends O ? K : never;
}[DashboardMethod];

export type ReadMethod = MethodsWithOutcome<"read">;
export type AckedMethod = MethodsWithOutcome<"acked">;
type FireAndForgetMethod = MethodsWithOutcome<"fire-and-forget">;

/** The methods that produce ack/fail notices: everything whose answer is not a correlated response. */
export type NotifyingMethod = AckedMethod | FireAndForgetMethod;

/**
 * Request and response payloads, one row per table method. A method missing a
 * row breaks the RequestPayload mapped type; a read missing `response` breaks
 * ResponseFor. `request: null` methods carry no parameters.
 */
interface DashboardEndpointIO {
	ready: { request: null };
	setNumberSetting: { request: { readonly setting: NumberSettingId; readonly value: number | null } };
	setBooleanSetting: { request: { readonly setting: BooleanSettingId; readonly value: boolean } };
	resetSetting: { request: { readonly setting: ResettableSettingId } };
	revealSetting: { request: { readonly setting: RevealableSettingId } };
	setModelParameters: { request: { readonly value: Record<string, Record<string, unknown>> } };
	setModelCapabilities: { request: { readonly value: Record<string, Record<string, unknown>> } };
	setUsageStatusBar: { request: { readonly value: UsageStatusBarModeSetting } };
	setTokenEstimation: { request: { readonly value: TokenEstimationMode } };
	/** Any short string, the empty string included (bare numbers); the extension bounds the length at the schema. */
	setCurrencySymbol: { request: { readonly value: string } };
	/** Values must be non-empty keyword names; the extension re-validates and refuses anything else. */
	setAdditionalToolSchemaKeywords: { request: { readonly values: readonly string[] } };
	setUiTheme: { request: { readonly value: UiTheme } };
	setUiAccent: { request: { readonly value: UiAccent } };
	/** Values must be fractions in (0, 1]; the extension re-validates and refuses out-of-range entries. */
	setUsageAlertThresholds: { request: { readonly values: readonly number[] } };
	refreshCatalog: { request: null };
	refreshUsage: { request: null };
	saveServerSetting: {
		request: {
			readonly server: SaveServerPayload;
			readonly secrets: Readonly<Record<SecretFieldId, SecretDirective>>;
			/** When editing: the label of the entry to replace (differs from server.label on rename). */
			readonly replaceLabel?: string | undefined;
		};
	};
	/**
	 * Test a DRAFT server configuration with one extension-side discovery
	 * probe. Read-only by contract: nothing is written, synced, or cached. The
	 * payload mirrors saveServerSetting (same secret-directive value rules);
	 * "keep" directives resolve against the entry `replaceLabel` names. The
	 * success notice is composed extension-side as classification text plus a
	 * model count, never payload or response text.
	 */
	testServerDraft: {
		request: {
			readonly server: SaveServerPayload;
			readonly secrets: Readonly<Record<SecretFieldId, SecretDirective>>;
			readonly replaceLabel?: string | undefined;
		};
	};
	removeServerSetting: { request: { readonly label: string } };
	/**
	 * Append `category` to the declared entry `label` names. The whole payload
	 * is two closed vocabularies - no free-typed value ever rides this method;
	 * the entry is otherwise preserved verbatim, and an already-declared
	 * category acks as a no-op.
	 */
	declareExpectedFailure: { request: { readonly label: string; readonly category: ExpectedFailureCategory } };
	/**
	 * Adopt an external provider group into the servers setting: the group's
	 * credentials (extension-side only; the webview never sees them) are
	 * resolved by the extension and stored where `secrets` directs per field.
	 * `sourceHandle` is the opaque token the row carried, resolved only
	 * against groups that are still external and still at `baseUrl`.
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
	 * Remove (hide) an external provider group by writing its removal
	 * tombstone. Named by the opaque handle, resolved only against groups
	 * still external and still at `baseUrl` - the adopt intent's trust rule,
	 * so a forged request cannot hide a declared group.
	 */
	hideExternalServer: { request: { readonly baseUrl: string; readonly sourceHandle: string } };
	/** Clear one hidden group's tombstone (the identity its HiddenGroup row carried). */
	unhideServer: { request: { readonly label: string; readonly baseUrl: string } };
	/**
	 * A declared entry's inline-stored secret values, for the edit form's
	 * prefill: inline values already sit in plaintext in the settings file, so
	 * this reveals nothing the Settings editor does not show. Secure-stored or
	 * absent fields carry NO key in the response; their values never reach the
	 * webview. Deliberately a read, never part of DashboardState: state pushes
	 * must never carry secret material.
	 */
	readInlineSecrets: {
		request: { readonly label: string };
		response: { readonly values: Readonly<Partial<Record<SecretFieldId, string>>> };
	};
	/**
	 * One model's effective capabilities, produced by the same
	 * resolveModelCapabilities walk registration runs, so the inspector cannot
	 * drift from what is served. Addressed by scope key plus raw ID; a stale
	 * key de-resolves. Absent `capabilities` means the scope or model no
	 * longer resolves; the inspector says so instead of inventing values.
	 * `globalRecordKey` and `chains` are extension-computed - the webview
	 * holds no matcher logic.
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
	 * One model's effective-parameters projection, resolved through the
	 * provider's SHARED flat resolution table - the same cache requests read -
	 * so the inspector cannot drift from the wire. Addressed and answered like
	 * readModelCapabilities.
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
	 * The Diagnostics tab's Resolved-models view, computed extension-side over
	 * the live model set and configuration. On demand rather than in state
	 * pushes because it scales with models x fields.
	 */
	readResolvedModels: { request: null; response: { readonly view: ResolvedModelsView } };
	/**
	 * Search the extension-side OpenRouter catalog snapshot. The query is
	 * user-typed filter text, never a secret; the response is a bounded
	 * id/name list - the catalog data itself never enters the webview bundle.
	 */
	searchCatalog: {
		request: { readonly query: string };
		response: { readonly results: readonly CatalogModelSummary[] };
	};
	executeCommand: { request: { readonly command: DashboardCommandId } };
	/** No parameters: the sync is fleet-wide, exactly as the command palette runs it. */
	syncModels: { request: null };
}

/** One method's request payload; errors here mean a table method is missing its DashboardEndpointIO row. */
export type RequestPayload<K extends DashboardMethod> = DashboardEndpointIO[K]["request"];

/** One read's response payload; errors here mean a read method is missing its `response` type. */
export type ResponseFor<K extends ReadMethod> = DashboardEndpointIO[K]["response"];

/**
 * One webview-to-extension call. Every message the page posts is this
 * envelope: `id` is a webview-minted correlation token, echoed by the
 * response, ack, or fail that answers it, so no outcome is ever uncorrelated.
 */
export type RpcRequest<K extends DashboardMethod> = {
	readonly kind: "request";
	readonly id: string;
	readonly method: K;
	readonly payload: RequestPayload<K>;
};

/** The webview-to-extension union. The extension re-validates every request: the webview is a trust boundary. */
export type RpcRequestType = { [K in DashboardMethod]: RpcRequest<K> }[DashboardMethod];

/** A schema-valid request that asks the extension to do something (everything but the reads and the handshake). */
type IntentMethod = Exclude<NotifyingMethod, "ready">;

/** One parsed intent as the executor consumes it; discriminated on `method` so payloads narrow with it. */
export type DashboardIntent = {
	[K in IntentMethod]: { readonly method: K; readonly payload: RequestPayload<K> };
}[IntentMethod];

/** The answer to one read request, correlated by the request's id. */
type RpcResponse<K extends ReadMethod> = {
	readonly kind: "response";
	readonly id: string;
	readonly method: K;
	readonly payload: ResponseFor<K>;
};

export type RpcResponseType = { [K in ReadMethod]: RpcResponse<K> }[ReadMethod];

/**
 * An acked intent's success notice. `message` is an optional caveat about the
 * success - informational text only, never a value from the payload.
 */
interface IntentAckMessage {
	readonly kind: "ack";
	readonly id: string;
	readonly method: AckedMethod;
	readonly message?: string | undefined;
}

/**
 * An intent's failure notice, correlated to the request that failed.
 * `failureKind`: "validation" means nothing landed, so the editor's draft is
 * still the truth and returns to editing; "operation" means the durable write
 * committed but a follow-up effect failed, so drafts over the pre-save state
 * are stale and the message carries the recovery path. `message` is
 * webview-safe text (may quote an entered configuration key, never a secret);
 * the panel logs classifications only. `classification` is the transport
 * classification behind a failed probe - enum ids, never message text.
 */
interface IntentFailMessage {
	readonly kind: "fail";
	readonly id: string;
	readonly method: NotifyingMethod;
	readonly message: string;
	readonly failureKind: "validation" | "operation";
	readonly classification?: TransportErrorClassification | undefined;
}

/**
 * Extension-to-webview messages: full state pushes (the webview never holds
 * partial truth), the focusSection deep link, read responses, and per-intent
 * outcome notices. A validation-kind failure produces no state push; an
 * operation-kind failure committed its write, so a push follows and must not
 * be read as the intent succeeding.
 */
export type ExtensionToWebviewMessage =
	| { readonly kind: "push"; readonly state: DashboardState }
	| {
			/**
			 * Switch the page to a section (the litellm.showDiagnostics deep
			 * link). Sent after the ready handshake when the dashboard was opened
			 * with a target section, or directly when the page is already live.
			 */
			readonly kind: "focusSection";
			readonly section: DashboardSectionId;
	  }
	| RpcResponseType
	| IntentAckMessage
	| IntentFailMessage;

/**
 * Every extension-to-webview discriminant: a kind added to the union stops
 * compiling until registered here, instead of being silently dropped by the
 * webview's receive guard.
 */
const EXTENSION_MESSAGE_KINDS: Readonly<Record<ExtensionToWebviewMessage["kind"], true>> = {
	push: true,
	focusSection: true,
	response: true,
	ack: true,
	fail: true,
};

/**
 * The webview's receive guard. Window messages come from the extension only
 * (the CSP allows no other frames), so a discriminant shape check suffices.
 */
export function isExtensionMessage(data: unknown): data is ExtensionToWebviewMessage {
	if (typeof data !== "object" || data === null) {
		return false;
	}
	const kind = (data as { kind?: unknown }).kind;
	return typeof kind === "string" && Object.hasOwn(EXTENSION_MESSAGE_KINDS, kind);
}

/** Whether a method name (possibly from an untyped record key) names an acked-outcome table row. */
export function isAckedMethod(method: string): method is AckedMethod {
	return (
		Object.hasOwn(DASHBOARD_ENDPOINTS, method) && DASHBOARD_ENDPOINTS[method as DashboardMethod].outcome === "acked"
	);
}

/**
 * The failure notices a state push leaves standing. Acked methods' failures
 * survive pushes: a push is not their success signal, and a partially applied
 * save requests a sync whose push would otherwise erase the very warning the
 * save raised. Every other method's success signal IS the following push, so
 * a push retires those notices.
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
