/**
 * The dashboard's wire contract, defined once as an endpoint table. Every
 * derived surface - the request/response envelope unions, the chained vs
 * concurrent routing, the acked-intent bookkeeping, the extension-side zod
 * schema map, and the panel's handler map - is a mapped type or lookup over
 * DASHBOARD_ENDPOINTS, so a method cannot exist without a payload type, a
 * schema, a handler, and (for reads) a response type: each omission fails
 * compilation at the corresponding mapped structure.
 *
 * This module is imported by both sides (the extension host and the browser
 * bundle), so it stays pure: no vscode, no DOM, no Node, no zod - the runtime
 * exports are a plain const table and a few lookups over it.
 *
 * Security invariants that live on this boundary: state pushes carry secret
 * LOCATIONS, never values (the one value path is the readInlineSecrets read,
 * whose response answers with fields already sitting in plaintext in the
 * settings file); failure notices carry webview-safe text, and the panel
 * boundary logs classifications only.
 */

import type { EffectiveCapabilities } from "../shared/config/capabilityResolution";
import type { EffectiveParametersProjection } from "../shared/config/parameterResolution";
import type { BooleanSettingId, NumberSettingId } from "../shared/config/settingSpec";
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

/** Actions the webview can trigger; the extension maps each ID to the command it already registers. */
export const DASHBOARD_COMMAND_IDS = [
	"openGroupsFile",
	"syncModels",
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
 * schemas (intentSchema.ts) and declared here - plain numbers, no zod - as
 * the caps a webview surface would pre-gate against if it ever needs to.
 * Generous enough that no honest input meets one: their only job is to keep
 * a hostile or broken page from ballooning a settings write, and anything
 * refused comes back as a correlated validation failure, never a silent
 * drop. The schemas carry a few further token-local caps (request ids,
 * header rows, the catalog query) that no form input approaches.
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
} as const;

/**
 * What to do with one secret field when saving a server entry. "keep" leaves
 * the field wherever it is (inline in the setting or in secret storage);
 * "clear" removes it from both; "set" replaces it in the chosen location and
 * removes it from the other. Values flow webview -> extension -> setting or
 * SecretStorage only: they are never logged and never echoed back into
 * DashboardState.
 */
export type SecretDirective =
	| { readonly action: "keep" }
	| { readonly action: "clear" }
	| { readonly action: "set"; readonly location: "settings" | "secure"; readonly value: string };

/**
 * The non-secret half of a litellm-vscode-chat.servers entry as the dashboard
 * form submits it. The label is the entry's identity: the sync engine names
 * the VS Code provider group after it, so renaming creates a new group (the
 * old one stays until its object is deleted from the models file).
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
	 * The entry's custom HTTP headers (plain settings text, not secrets);
	 * empty means the saved entry carries none. Always sent - the schema
	 * refuses a payload without it, so a save can never silently delete a
	 * stored record it did not mean to touch.
	 */
	readonly headers: Readonly<Record<string, HeaderScalar>>;
	/** The entry's discovery.declared model IDs; empty means none. */
	readonly declaredModels: readonly string[];
	/** The entry's manual usage budget in USD; null means none (clearing any stored budget). */
	readonly budget: number | null;
}

/**
 * How one method's outcome returns to the page, and which queue its handling
 * joins.
 *
 * outcome: "read" answers with a correlated response envelope (no state push,
 * no outcome notice); "acked" posts a correlated ack (or fail) envelope and
 * then the state push its landed write triggers; "fire-and-forget" gets no
 * ack - the state push following the applied intent is the whole success
 * signal, and only failures notify.
 *
 * channel: "chained" methods run one at a time on the mutation chain (two
 * concurrent saves would read-modify-write the same servers array and lose
 * one update); "concurrent" methods run off it - only genuinely non-mutating
 * methods may be marked concurrent, and readInlineSecrets deliberately stays
 * chained so a prefill read never overtakes the save it follows.
 */
interface DashboardEndpointSpec {
	readonly outcome: "read" | "acked" | "fire-and-forget";
	readonly channel: "chained" | "concurrent";
}

/**
 * The endpoint table: one row per method the webview can call. The webview is
 * a trust boundary - the extension re-validates every request against the
 * schema map in extension/dashboard/intentSchema.ts, which is mapped over
 * this table.
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
	setUsageAlertThresholds: { outcome: "fire-and-forget", channel: "chained" },
	/** Refresh the OpenRouter catalog now; the outcome lands in the next push's catalog status. */
	refreshCatalog: { outcome: "fire-and-forget", channel: "chained" },
	/** Refresh usage data for every server now; the poller's completion re-pushes state. */
	refreshUsage: { outcome: "fire-and-forget", channel: "chained" },
	saveServerSetting: { outcome: "acked", channel: "chained" },
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
 * Request and response payloads, one row per table method. A method added to
 * DASHBOARD_ENDPOINTS without a row here breaks the RequestPayload mapped
 * type below; a read without a `response` payload breaks ResponseFor. The
 * `payload: null` methods carry no parameters.
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
	 * Test a DRAFT server configuration - possibly never saved - with one
	 * extension-side discovery probe. Read-only by contract: nothing is
	 * written, synced, or cached. The payload mirrors saveServerSetting (same
	 * secret directives, same value rules: webview -> extension only, never
	 * logged, never echoed back); "keep" directives resolve extension-side
	 * against the entry `replaceLabel` names, exactly as a save would. The
	 * success notice's message is composed extension-side as static
	 * classification text plus the discovered model count, never payload or
	 * response text.
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
	 * Adopt an external provider group into the servers setting: the entry is
	 * written under `label`, and the group's credentials (which exist
	 * extension-side only; the webview never sees them) are resolved by the
	 * extension and stored where `secrets` directs per field. The source group
	 * is named by `sourceHandle`, the opaque token its row carried
	 * (DashboardServer.adoptHandle); the extension resolves it only against
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
	 * Remove (hide) an external provider group: writes its removal tombstone,
	 * so it answers with no models and moves to the hidden-groups line. Names
	 * the group by the opaque handle its row carried, resolved extension-side
	 * only against groups that are still external and still at `baseUrl` -
	 * the same trust rule the adopt intent follows, so a forged request
	 * cannot hide a declared group.
	 */
	hideExternalServer: { request: { readonly baseUrl: string; readonly sourceHandle: string } };
	/** Clear one hidden group's tombstone (the identity its HiddenGroup row carried). */
	unhideServer: { request: { readonly label: string; readonly baseUrl: string } };
	/**
	 * A declared entry's secret values whose storage is inline in the servers
	 * setting, for the edit form's prefill. Inline values already sit in
	 * plaintext in the user's settings file, so this reveals nothing the
	 * Settings editor does not show. Fields stored in secure storage or absent
	 * carry NO key in the response (absence, not an empty string); their
	 * values never reach the webview. Deliberately a read, never part of
	 * DashboardState: state pushes must never carry secret material.
	 */
	readInlineSecrets: {
		request: { readonly label: string };
		response: { readonly values: Readonly<Partial<Record<SecretFieldId, string>>> };
	};
	/**
	 * One model's effective capabilities, produced by the same
	 * resolveModelCapabilities walk registration runs, so the inspector cannot
	 * drift from what is served. The model is named by its scope key (an
	 * opaque per-session server handle, so a stale key de-resolves instead of
	 * hitting another server) plus its raw ID. Absent `capabilities` means the
	 * requested scope or model no longer resolves (the store changed between
	 * the push and the request); the inspector says so instead of inventing
	 * values. `globalRecordKey` is the most specific GLOBAL record key
	 * matching this model, for the inspector's configure-jump; `chains` the
	 * per-map matching chains (the inheritance figure) - both extension-
	 * computed, the webview holds no matcher logic.
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
	 * One model's effective-parameters projection, resolved extension-side
	 * through the provider's SHARED flat resolution table - the same cache
	 * requests read - so the inspector cannot drift from the wire. Addressed
	 * and answered like readModelCapabilities.
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
	 * Search the extension-side OpenRouter catalog snapshot (the
	 * `_openrouter_model` picker). The query is user-typed filter text, never
	 * a secret; the response is a bounded id/name list - the catalog data
	 * itself never enters the webview bundle.
	 */
	searchCatalog: {
		request: { readonly query: string };
		response: { readonly results: readonly CatalogModelSummary[] };
	};
	executeCommand: { request: { readonly command: DashboardCommandId } };
}

/** One method's request payload; errors here mean a table method is missing its DashboardEndpointIO row. */
export type RequestPayload<K extends DashboardMethod> = DashboardEndpointIO[K]["request"];

/** One read's response payload; errors here mean a read method is missing its `response` type. */
export type ResponseFor<K extends ReadMethod> = DashboardEndpointIO[K]["response"];

/**
 * One webview-to-extension call. Every message the page posts - reads,
 * acked intents, and fire-and-forget intents alike - is this envelope: `id`
 * is a webview-minted correlation token, echoed by the response, ack, or
 * fail envelope that answers it, so no outcome is ever uncorrelated.
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
 * success (e.g. an adoption that found no credentials to copy, or the draft
 * test's composed model count) - informational text only, never a value from
 * the payload.
 */
interface IntentAckMessage {
	readonly kind: "ack";
	readonly id: string;
	readonly method: AckedMethod;
	readonly message?: string | undefined;
}

/**
 * An intent's failure notice, correlated to the request that failed (every
 * request carries an id, so failures are never uncorrelated). `failureKind`
 * says what the failure left behind: "validation" means nothing landed (the
 * intent was refused or its write failed), so the editor's draft is still the
 * truth and returns to editing for a retry; "operation" means the durable
 * write committed but a follow-up effect failed, so drafts over the pre-save
 * state are stale and the message carries the recovery path. `message` is
 * webview-safe text (it may quote an entered configuration key, never a
 * secret); the panel boundary logs classifications only. `classification` is
 * the transport classification behind a failed connection probe, when one
 * exists - enum ids and a status number, never message text.
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
 * outcome notices. A validation-kind failure produces no configuration change
 * and therefore no state push; an operation-kind failure committed its write,
 * so a push follows and must not be read as the intent succeeding.
 */
export type ExtensionToWebviewMessage =
	| { readonly kind: "push"; readonly state: DashboardState }
	| {
			/**
			 * Switch the page to a section: the deep link litellm.showDiagnostics
			 * uses to land on the Diagnostics tab. The panel sends it after the
			 * webview's ready handshake when the dashboard was opened with a
			 * target section, or directly when the page is already live.
			 */
			readonly kind: "focusSection";
			readonly section: DashboardSectionId;
	  }
	| RpcResponseType
	| IntentAckMessage
	| IntentFailMessage;

/**
 * Every extension-to-webview discriminant, as a Record over the union: a
 * message kind added to ExtensionToWebviewMessage stops compiling until it is
 * registered here, instead of being silently dropped by the webview's
 * receive guard.
 */
const EXTENSION_MESSAGE_KINDS: Readonly<Record<ExtensionToWebviewMessage["kind"], true>> = {
	push: true,
	focusSection: true,
	response: true,
	ack: true,
	fail: true,
};

/**
 * The webview's receive guard. Messages arriving on the window come from the
 * extension only (the CSP allows no other frames), so a shape check on the
 * discriminant suffices.
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
 * The failure notices a state push leaves standing, keyed by method. Acked
 * methods' failure notices survive state pushes: a push is not their success
 * signal, and a partially applied save requests a sync whose push would
 * otherwise erase the very warning the save raised. Every other method's
 * success signal IS the state push that follows its landed write, so a push
 * retires those notices (and nothing else would).
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
