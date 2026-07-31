/**
 * The dashboard's wire contract: the serializable state the extension pushes
 * into the webview and the intents the webview posts back. This module is
 * imported by both sides (the extension host and the browser bundle), so it
 * must stay pure: no vscode, no DOM, no Node. Pure helpers from src/shared
 * are the one allowed dependency, re-exported here because webview code may
 * import only this module (the Biome override in biome.json enforces that).
 *
 * The dashboard is a stateless view over the existing stores. Everything in
 * DashboardState is derived on demand from the provider's status window and
 * from workspace configuration; nothing here is persisted anywhere.
 */

export type { BooleanSettingId, NumberSettingId } from "../../shared/config/settingSpec";
export type { NonSecretOptionalFieldId, SecretFieldId, SecretLocation } from "../../shared/serverEntry";
export { NON_SECRET_OPTIONAL_FIELD_IDS, SECRET_FIELD_IDS } from "../../shared/serverEntry";
export type { HeaderScalar } from "../../shared/util/headers";
export { isValidHeaderName, isValidHeaderValue } from "../../shared/util/headers";
export { isUnsafeRecordKey } from "../../shared/util/json";

import type {
	BooleanSettingId,
	BooleanSettingValueSpec,
	NumberSettingId,
	NumberSettingValueSpec,
} from "../../shared/config/settingSpec";
import { BOOLEAN_SETTING_SPECS, NUMBER_SETTING_SPECS } from "../../shared/config/settingSpec";
import type { NonSecretOptionalFields, SecretFieldId, SecretLocation } from "../../shared/serverEntry";
import type { HeaderScalar } from "../../shared/util/headers";

/** A per-entry modelParameters record: model-ID prefix to request parameters. Non-secret user configuration. */
type EntryModelParametersPayload = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/** The non-secret configuration of a declared server, for the edit form's prefill. */
interface DashboardServerConfig extends NonSecretOptionalFields {
	/** Where each secret currently lives; the values themselves never reach the webview. */
	readonly secrets: Readonly<Record<SecretFieldId, SecretLocation>>;
	/** The entry's own modelParameters, when it has any; the edit form's prefill. */
	readonly modelParameters?: EntryModelParametersPayload | undefined;
}

interface DashboardServerBase {
	readonly label: string;
	readonly baseUrl: string;
	readonly modelCount: number;
	/** ISO timestamp of the last discovery attempt; absent while unchecked. */
	readonly lastChecked?: string | undefined;
	/** Whether the server has credentials configured anywhere; never the credentials themselves. */
	readonly hasApiKey: boolean;
	readonly hasOAuth: boolean;
}

/**
 * One server row: a declared entry from the litellm-vscode-chat.servers
 * setting, a live provider group the status window saw, or both merged
 * (joined by label and base URL). Secrets never reach the webview; only
 * their locations do.
 *
 * Discriminated twice. On `origin`: a declared row always carries the edit
 * form's config prefill, an external row always carries the opaque adopt
 * handle, and neither carries the other's field. On `state`: an error row
 * always has its message, an "ok" row may STILL carry one (deliberate: a
 * declared entry whose group upsert failed while an already-live group keeps
 * serving renders "OK (N models) - <sync error>"), and "unchecked" (declared
 * in settings but not yet seen by a discovery pass) carries none.
 */
export type DashboardServer = DashboardServerBase &
	(
		| {
				/** In the servers setting (editable here); `config` is the edit form's prefill. */
				readonly origin: "declared";
				readonly config: DashboardServerConfig;
				readonly adoptHandle?: undefined;
		  }
		| {
				/**
				 * A provider group managed outside the setting. `adoptHandle` is the
				 * opaque token the adopt intent names its source group by: a salted
				 * one-way hash of the extension-side server ID, stable across state
				 * pushes for the session (rendered labels and row order are not); it
				 * carries no credential material, cannot be reproduced outside the
				 * extension host, and resolves back to a group only while that group
				 * is still external.
				 */
				readonly origin: "external";
				readonly adoptHandle: string;
				readonly config?: undefined;
		  }
	) &
	(
		| { readonly state: "ok"; readonly error?: string | undefined }
		| { readonly state: "error"; readonly error: string }
		| { readonly state: "unchecked"; readonly error?: undefined }
	);

/**
 * The overall configuration verdict, shared by the dashboard hero and the
 * diagnostics dialog so their headline judgement cannot drift. Each surface
 * renders it differently (the hero as a colored word, the dialog as a line
 * with model counts and the first error), but the classification itself lives
 * here once. Only real failures count as failures: declared entries a
 * discovery pass has not reached yet stay neutral.
 */
export type OverallVerdict = "not-configured" | "error" | "degraded" | "waiting" | "connected";

export function classifyOverall(servers: readonly Pick<DashboardServer, "state">[]): OverallVerdict {
	if (servers.length === 0) {
		return "not-configured";
	}
	const errors = servers.filter((server) => server.state === "error").length;
	if (errors === servers.length) {
		return "error";
	}
	if (errors > 0) {
		return "degraded";
	}
	if (servers.every((server) => server.state === "unchecked")) {
		return "waiting";
	}
	return "connected";
}

/** One registered model, reduced to display facts. Costs are USD per million tokens, as registration converted them. */
export interface DashboardModel {
	readonly id: string;
	readonly name: string;
	readonly family: string;
	readonly serverLabel: string;
	readonly maxInputTokens: number;
	readonly maxOutputTokens: number;
	readonly inputCost?: number | undefined;
	readonly outputCost?: number | undefined;
	readonly cacheReadCost?: number | undefined;
	readonly cacheWriteCost?: number | undefined;
	/** Long-context tier costs; present only when the tier differs from the base price. */
	readonly longContextInputCost?: number | undefined;
	readonly longContextOutputCost?: number | undefined;
	readonly longContextCacheReadCost?: number | undefined;
	readonly longContextCacheWriteCost?: number | undefined;
	readonly toolCalling: boolean;
	readonly imageInput: boolean;
	readonly promptCaching: boolean;
	/** True when the model advertises the reasoning-effort configuration control. */
	readonly reasoning: boolean;
}

/** One number setting as the dashboard renders it: the shared value spec plus this module's presentation. */
export type NumberSettingSpec = NumberSettingValueSpec & {
	readonly label: string;
	readonly description: string;
	/** What the number counts; the form renders it as the input's suffix and humanizes durations from it. */
	readonly unit: "ms" | "tokens";
	/** What a configured 0 means, when 0 is legal and has a special reading (the cache TTL). */
	readonly zeroMeaning?: string;
};

/**
 * The number-valued litellm-vscode-chat.* settings the dashboard edits.
 * The value side of each entry (default, minimum, nullability) is spread in
 * from the shared setting spec; labels and descriptions are presentation and
 * live only here. The state builder still reads display-fallback defaults
 * through configuration inspection, which settingSpec.test.ts pins to the
 * same numbers.
 */
export const NUMBER_SETTINGS = {
	defaultMaxOutputTokens: {
		...NUMBER_SETTING_SPECS.defaultMaxOutputTokens,
		label: "Default max output tokens",
		description: "Used when the server does not report a limit.",
		unit: "tokens",
	},
	defaultContextLength: {
		...NUMBER_SETTING_SPECS.defaultContextLength,
		label: "Default context length",
		description: "Used when the server does not report a context window.",
		unit: "tokens",
	},
	defaultMaxInputTokens: {
		...NUMBER_SETTING_SPECS.defaultMaxInputTokens,
		label: "Default max input tokens",
		description: "Leave empty to derive it as context length minus output tokens.",
		unit: "tokens",
	},
	requestTimeout: {
		...NUMBER_SETTING_SPECS.requestTimeout,
		label: "Request timeout",
		description: "Hard bound for one chat completion call.",
		unit: "ms",
	},
	discoveryTimeout: {
		...NUMBER_SETTING_SPECS.discoveryTimeout,
		label: "Discovery timeout",
		description: "Hard bound for one model discovery call.",
		unit: "ms",
	},
	discoveryCacheTtl: {
		...NUMBER_SETTING_SPECS.discoveryCacheTtl,
		label: "Discovery cache TTL",
		description: "How long discovered model lists are reused; 0 asks the server on every refresh.",
		unit: "ms",
		zeroMeaning: "every refresh",
	},
} as const satisfies Record<NumberSettingId, NumberSettingSpec>;

export const NUMBER_SETTING_IDS = Object.keys(NUMBER_SETTINGS) as readonly NumberSettingId[];

/** One boolean setting as the dashboard renders it: the shared value spec plus this module's presentation. */
type BooleanSettingSpec = BooleanSettingValueSpec & {
	readonly label: string;
	readonly description: string;
};

/** The boolean litellm-vscode-chat.* settings the dashboard edits; value specs spread in like NUMBER_SETTINGS. */
export const BOOLEAN_SETTINGS = {
	"promptCaching.enabled": {
		...BOOLEAN_SETTING_SPECS["promptCaching.enabled"],
		label: "Prompt caching",
		description: "Cache the system prompt on models that advertise support.",
	},
	maskApiKeyInput: {
		...BOOLEAN_SETTING_SPECS.maskApiKeyInput,
		label: "Mask API key input",
		description: "Hide the API key while typing it into configuration prompts.",
	},
} as const satisfies Record<BooleanSettingId, BooleanSettingSpec>;

export const BOOLEAN_SETTING_IDS = Object.keys(BOOLEAN_SETTINGS) as readonly BooleanSettingId[];

const DURATION_UNITS: readonly (readonly [number, string])[] = [
	[3600000, "h"],
	[60000, "min"],
	[1000, "s"],
];

/**
 * A millisecond count as humans read clocks: "5 min", "1 h 30 min". At most
 * two units; a truncated remainder gets a "~" instead of false precision.
 * Sub-second values return undefined (they already read as milliseconds).
 */
function formatDuration(ms: number): string | undefined {
	if (!Number.isInteger(ms) || ms < 1000) {
		return undefined;
	}
	const parts: string[] = [];
	let rest = ms;
	for (const [size, name] of DURATION_UNITS) {
		const count = Math.floor(rest / size);
		if (count > 0 && parts.length < 2) {
			parts.push(`${count} ${name}`);
			rest -= count * size;
		}
	}
	return `${rest > 0 ? "~" : ""}${parts.join(" ")}`;
}

/**
 * One number-setting draft parsed once: rejected with the reason to render,
 * an empty draft that clears a nullable setting, or the committed value. The
 * error display, the commit, and the equivalence hint all read this one
 * parse, so a keystroke is judged exactly once.
 */
export type NumberDraftParse =
	| { readonly kind: "invalid"; readonly problem: string }
	| { readonly kind: "clear" }
	| { readonly kind: "value"; readonly value: number };

export function parseNumberDraft(id: NumberSettingId, text: string): NumberDraftParse {
	const spec: NumberSettingSpec = NUMBER_SETTINGS[id];
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		return spec.nullable ? { kind: "clear" } : { kind: "invalid", problem: "Enter a number" };
	}
	const value = Number(trimmed);
	if (!Number.isFinite(value)) {
		return { kind: "invalid", problem: "Not a number" };
	}
	if (value < spec.minimum) {
		return { kind: "invalid", problem: `Must be at least ${spec.minimum}` };
	}
	return { kind: "value", value };
}

/**
 * The muted equivalence rendered next to a number input, recomputed from the
 * parsed draft as the user types: millisecond durations in clock units, and
 * the TTL's special zero reading ("= every refresh"). Takes the value
 * parseNumberDraft committed to, so it cannot re-read the raw text by other
 * rules. Token counts get no equivalence (a digit-grouped echo of the same
 * number says nothing); their unit suffix on the input carries the meaning.
 */
export function equivalence(id: NumberSettingId, value: number): string | undefined {
	const spec: NumberSettingSpec = NUMBER_SETTINGS[id];
	if (spec.unit !== "ms") {
		return undefined;
	}
	if (value === 0) {
		return spec.zeroMeaning === undefined ? undefined : `= ${spec.zeroMeaning}`;
	}
	const duration = formatDuration(value);
	return duration === undefined ? undefined : `= ${duration}`;
}

/**
 * The identity of a scalar setting's external state, which the settings
 * form's draft-resync effect keys on. Both halves are load-bearing: a
 * successful reset can change the configured scope while leaving the
 * effective value untouched (removing a value pinned to exactly its default),
 * and the field's draft - possibly a rejected one, error and all - must
 * resync to the store on that push too, not only when the value itself moves.
 */
export function draftSyncKey(value: number | null, configuredScope: SettingScope | null): string {
	return `${value === null ? "" : String(value)}@${configuredScope ?? "default"}`;
}

/** The configuration scopes a setting value can live in, in ascending precedence. */
export type SettingScope = "global" | "workspace" | "workspaceFolder";

/** Human-readable scope names for the webview. */
export const SETTING_SCOPE_LABELS: Record<SettingScope, string> = {
	global: "User",
	workspace: "Workspace",
	workspaceFolder: "Workspace folder",
};

/**
 * An object setting split by configuration scope. VS Code shallow-merges
 * object settings across scopes (workspace keys win over user keys), so an
 * editor over the merged value would copy user-scope entries into workspace
 * files on write and could never delete an entry from the other scope. The
 * dashboard therefore edits exactly one scope's own record (`editScope`,
 * matching where writes land) and shows the records other scopes hold
 * read-only.
 */
export interface ScopedRecordSetting<V> {
	readonly editScope: SettingScope;
	/** The record the edit scope itself holds; what the editor edits and writes back whole. */
	readonly value: Readonly<Record<string, V>>;
	/** Non-empty records held by other scopes, read-only in the dashboard. */
	readonly otherScopes: readonly { readonly scope: SettingScope; readonly value: Readonly<Record<string, V>> }[];
}

/** The settings snapshot the dashboard renders. Scalars are the effective values; records are per-scope. */
export interface DashboardSettings {
	readonly numbers: Readonly<Record<NumberSettingId, number | null>>;
	readonly booleans: Readonly<Record<BooleanSettingId, boolean>>;
	/**
	 * Where each scalar setting is explicitly configured, if anywhere: the
	 * highest-precedence scope inspection reports a value in (workspaceFolder
	 * over workspace over global), or null when only the default applies.
	 * Drives the form's modified indicator and the per-scope Reset naming.
	 * "Modified" means the key is set somewhere, matching the native Settings
	 * editor - a value pinned to exactly its default still shows the bar and
	 * can be reset - and the named scope is the one a reset removes first.
	 */
	readonly configuredScopes: {
		readonly numbers: Readonly<Record<NumberSettingId, SettingScope | null>>;
		readonly booleans: Readonly<Record<BooleanSettingId, SettingScope | null>>;
	};
	readonly modelParameters: ScopedRecordSetting<Readonly<Record<string, unknown>>>;
	readonly headers: ScopedRecordSetting<HeaderScalar>;
}

export interface DashboardState {
	readonly servers: readonly DashboardServer[];
	readonly models: readonly DashboardModel[];
	readonly settings: DashboardSettings;
}

/**
 * Extension-to-webview messages: full state pushes (the webview never holds
 * partial truth), plus per-intent outcome notices. Server intents carry a
 * webview-generated requestId, echoed back in intentSucceeded/intentFailed so
 * an editor waits on its own save rather than on the next unrelated push. A
 * validation-kind failure produces no configuration change and therefore no
 * state push; an operation-kind failure committed its write, so a push
 * follows and must not be read as the intent succeeding.
 */
export type ExtensionToWebviewMessage =
	| { readonly type: "state"; readonly state: DashboardState }
	| {
			/**
			 * The answer to a readInlineSecrets request: the entry's secret values
			 * whose storage is inline in the servers setting, for the edit form's
			 * prefill. Inline values already sit in plaintext in the user's
			 * settings file, so this reveals nothing the Settings editor does not
			 * show. Fields stored in secure storage or absent carry NO key here
			 * (absence, not an empty string); their values never reach the
			 * webview. Deliberately not part of DashboardState: state pushes must
			 * never carry secret material.
			 */
			readonly type: "inlineSecrets";
			readonly requestId: string;
			readonly values: Readonly<Partial<Record<SecretFieldId, string>>>;
	  }
	| {
			readonly type: "intentSucceeded";
			readonly intentType: DashboardIntentType;
			readonly requestId: string;
			/**
			 * An optional caveat about a successful intent (e.g. an adoption that
			 * found no credentials to copy). Informational text only, never a
			 * value from the payload.
			 */
			readonly message?: string | undefined;
	  }
	| {
			readonly type: "intentFailed";
			readonly intentType: DashboardIntentType;
			readonly message: string;
			/**
			 * What the failure left behind. "validation": nothing landed (the
			 * intent was refused or its write failed), so the editor's draft is
			 * still the truth and returns to editing for a retry. "operation": the
			 * durable write committed but a follow-up effect failed, so drafts
			 * over the pre-save state are stale and the message carries the
			 * recovery path.
			 */
			readonly kind: "validation" | "operation";
			readonly requestId?: string | undefined;
	  };

/**
 * The intent types that carry a correlation requestId, derived from the
 * message union itself. Intersected with DashboardIntentType so pure
 * request/response messages (readInlineSecrets, answered by its own
 * inlineSecrets message, never by an outcome notice) stay out.
 */
type AckedIntentType = Extract<WebviewToExtensionMessage, { requestId: string }>["type"] & DashboardIntentType;

/**
 * Every extension-to-webview discriminant, as a Record over the union: a
 * message type added to ExtensionToWebviewMessage stops compiling until it is
 * registered here, instead of being silently dropped by the webview's
 * receive guard.
 */
const EXTENSION_MESSAGE_TYPES: Readonly<Record<ExtensionToWebviewMessage["type"], true>> = {
	state: true,
	inlineSecrets: true,
	intentSucceeded: true,
	intentFailed: true,
};

/** Whether an incoming discriminant names an extension-to-webview message; the webview's receive guard. */
export function isExtensionMessageType(type: unknown): type is ExtensionToWebviewMessage["type"] {
	return typeof type === "string" && Object.hasOwn(EXTENSION_MESSAGE_TYPES, type);
}

/**
 * The intents whose outcome arrives as its own correlated notice
 * (intentSucceeded or intentFailed echoing the intent's requestId). Their
 * failure notices survive state pushes: a push is not their success signal,
 * and a partially applied save requests a sync whose push would otherwise
 * erase the very warning the save raised. Every other intent's success signal
 * is the state push that follows its landed write, so a push retires those
 * notices (and nothing else would). A Record over the derived union: an
 * intent that gains a requestId without being registered here stops compiling
 * instead of silently regressing to notice erasure.
 */
const ACKED_INTENT_TYPES: Readonly<Record<AckedIntentType, true>> = {
	saveServerSetting: true,
	removeServerSetting: true,
	adoptServer: true,
};

/** The failure notices a state push leaves standing, keyed like FailuresByIntent; see ACKED_INTENT_TYPES. */
export function failuresAfterStatePush<K extends string, V>(
	failures: Readonly<Partial<Record<K, V>>>
): Readonly<Partial<Record<K, V>>> {
	const kept = Object.entries(failures).filter(([intentType]) => Object.hasOwn(ACKED_INTENT_TYPES, intentType));
	if (kept.length === Object.keys(failures).length) {
		return failures;
	}
	return Object.fromEntries(kept) as Partial<Record<K, V>>;
}

/** Actions the webview can trigger; the extension maps each ID to the command it already registers. */
export const DASHBOARD_COMMAND_IDS = [
	"manageServers",
	"syncModels",
	"testConnection",
	"showDiagnostics",
	"openSettings",
] as const;

export type DashboardCommandId = (typeof DASHBOARD_COMMAND_IDS)[number];

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
 * old one stays until removed in the native editor).
 */
export interface SaveServerPayload extends NonSecretOptionalFields {
	readonly label: string;
	readonly baseUrl: string;
	/** The entry's per-entry modelParameters; absent or empty means the saved entry carries none. */
	readonly modelParameters?: EntryModelParametersPayload | undefined;
}

/** Webview-to-extension intents. The extension re-validates every one: the webview is a trust boundary. */
export type WebviewToExtensionMessage =
	| { readonly type: "ready" }
	| { readonly type: "setNumberSetting"; readonly setting: NumberSettingId; readonly value: number | null }
	| { readonly type: "setBooleanSetting"; readonly setting: BooleanSettingId; readonly value: boolean }
	/** Remove the setting from the highest-precedence scope that sets it; the next scope's value or the default shows through. */
	| { readonly type: "resetSetting"; readonly setting: NumberSettingId | BooleanSettingId }
	| { readonly type: "setModelParameters"; readonly value: Record<string, Record<string, unknown>> }
	| { readonly type: "setHeaders"; readonly value: Record<string, HeaderScalar> }
	| {
			readonly type: "saveServerSetting";
			readonly server: SaveServerPayload;
			readonly secrets: Readonly<Record<SecretFieldId, SecretDirective>>;
			/** When editing: the label of the entry to replace (differs from server.label on rename). */
			readonly replaceLabel?: string | undefined;
			/** Webview-generated correlation ID, echoed in the outcome notice. */
			readonly requestId: string;
	  }
	| { readonly type: "removeServerSetting"; readonly label: string; readonly requestId: string }
	| {
			/**
			 * Ask for a declared entry's inline secret values (the edit form's
			 * on-demand prefill; see the inlineSecrets response). Carries only the
			 * entry's label; the extension reads the values from the servers
			 * setting itself and answers with inline-stored fields only.
			 */
			readonly type: "readInlineSecrets";
			readonly label: string;
			readonly requestId: string;
	  }
	| {
			/**
			 * Adopt an external provider group into the servers setting: the entry
			 * is written under `label`, and the group's credentials (which exist
			 * extension-side only; the webview never sees them) are resolved by
			 * the extension and stored where `secrets` directs per field. The
			 * source group is named by `sourceHandle`, the opaque token its row
			 * carried (DashboardServer.adoptHandle); the extension resolves it
			 * only against groups that are still external and still at `baseUrl`.
			 */
			readonly type: "adoptServer";
			readonly label: string;
			readonly baseUrl: string;
			readonly sourceHandle: string;
			readonly secrets: Readonly<Record<SecretFieldId, Exclude<SecretLocation, "none">>>;
			readonly requestId: string;
	  }
	| { readonly type: "executeCommand"; readonly command: DashboardCommandId };

/**
 * The intents that can fail and be reported back; the ready handshake has no
 * failure mode, and readInlineSecrets is a read answered by its own response
 * message (an unknown label simply yields no values).
 */
export type DashboardIntentType = Exclude<WebviewToExtensionMessage["type"], "ready" | "readInlineSecrets">;

export type ParsedJsonValue =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly error: string };

/**
 * Parse a model-parameter value typed into the dashboard: strict JSON, so
 * numbers, booleans, quoted strings, arrays, and objects all round-trip
 * unambiguously. Invalid input is a validation error, never a silent guess.
 */
export function parseJsonValue(text: string): ParsedJsonValue {
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		return { ok: false, error: 'Enter a JSON value, e.g. 0.2, true, or "text".' };
	}
	try {
		return { ok: true, value: JSON.parse(trimmed) as unknown };
	} catch {
		return { ok: false, error: 'Not valid JSON. Quote strings, e.g. "text".' };
	}
}

/**
 * Parse a header value typed into the dashboard. Header values are scalars,
 * and most are plain strings, so this is lenient where parseJsonValue is
 * strict: finite JSON scalars are taken as typed values ("true" is a boolean,
 * "42" a number, "\"42\"" a string) and anything else is the literal string.
 */
export function parseHeaderValue(text: string): HeaderScalar {
	const trimmed = text.trim();
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (typeof parsed === "string" || typeof parsed === "boolean") {
			return parsed;
		}
		// Non-finite numbers (JSON.parse("1e999") is Infinity) fall through to
		// the literal string: isHeaderScalar refuses them at the setHeaders
		// intent boundary, so parsing them as numbers would make Apply a
		// silent no-op - the draft looks applied, no failure is acked, and the
		// setting is never written. The literal string is the only lossless,
		// sendable reading.
		if (typeof parsed === "number" && Number.isFinite(parsed)) {
			return parsed;
		}
	} catch {
		// Fall through: the text is a plain string value.
	}
	return trimmed;
}

/** Render a configured value back into the editable text the parse functions accept. */
export function formatJsonValue(value: unknown): string {
	return JSON.stringify(value) ?? "";
}

/**
 * Render a header value as parseHeaderValue-compatible text. Non-strings
 * print bare ("true", "42"); a string that would re-parse as a JSON scalar is
 * quoted so its type survives the round trip.
 */
export function formatHeaderValue(value: HeaderScalar): string {
	if (typeof value !== "string") {
		return String(value);
	}
	try {
		JSON.parse(value);
		return JSON.stringify(value);
	} catch {
		return value;
	}
}
