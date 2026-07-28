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

export { isValidHeaderName, isValidHeaderValue } from "../../shared/headers";
export { isUnsafeRecordKey } from "../../shared/json";
export type { SecretFieldId, SecretLocation } from "../../shared/serverSecrets";
export { SECRET_FIELD_IDS } from "../../shared/serverSecrets";

import type { SecretFieldId, SecretLocation } from "../../shared/serverSecrets";

/** The non-secret configuration of a declared server, for the edit form's prefill. */
interface DashboardServerConfig {
	readonly oauthTokenUrl?: string | undefined;
	readonly oauthClientId?: string | undefined;
	readonly oauthScopes?: string | undefined;
	readonly virtualKeyHeader?: string | undefined;
	/** Where each secret currently lives; the values themselves never reach the webview. */
	readonly secrets: Readonly<Record<SecretFieldId, SecretLocation>>;
}

/**
 * One server row: a declared entry from the litellm-vscode-chat.servers
 * setting, a live provider group the status window saw, or both merged
 * (joined by label and base URL). Secrets never reach the webview; only
 * their locations do.
 */
export interface DashboardServer {
	readonly label: string;
	readonly baseUrl: string;
	/** "unchecked": declared in settings but not yet seen by a discovery pass. */
	readonly state: "ok" | "error" | "unchecked";
	readonly modelCount: number;
	readonly error?: string | undefined;
	/** ISO timestamp of the last discovery attempt; absent while unchecked. */
	readonly lastChecked?: string | undefined;
	/** Whether the server has credentials configured anywhere; never the credentials themselves. */
	readonly hasApiKey: boolean;
	readonly hasOAuth: boolean;
	/** "declared": in the servers setting (editable here). "external": a provider group managed outside it. */
	readonly origin: "declared" | "external";
	/** Present on declared servers: the edit form's prefill. */
	readonly config?: DashboardServerConfig | undefined;
	/**
	 * Present on external rows: the opaque token the adopt intent names its
	 * source group by. A salted one-way hash of the extension-side server ID,
	 * stable across state pushes for the session (rendered labels and row
	 * order are not); it carries no credential material, cannot be reproduced
	 * outside the extension host, and resolves back to a group only while
	 * that group is still external.
	 */
	readonly adoptHandle?: string | undefined;
}

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

export interface NumberSettingSpec {
	readonly label: string;
	readonly description: string;
	readonly minimum: number;
	/** Whether null (meaning "unset, derive it") is a legal value. */
	readonly nullable: boolean;
	/** What the number counts; the form renders it as the input's suffix and humanizes durations from it. */
	readonly unit: "ms" | "tokens";
	/** What a configured 0 means, when 0 is legal and has a special reading (the cache TTL). */
	readonly zeroMeaning?: string;
}

/**
 * The number-valued litellm-vscode-chat.* settings the dashboard edits.
 * Labels and constraints live here so the webview form and the extension-side
 * validation read the same table; defaults stay in package.json only (the
 * state builder reads them through configuration inspection when an
 * unusable configured value needs a display fallback).
 */
export const NUMBER_SETTINGS = {
	defaultMaxOutputTokens: {
		label: "Default max output tokens",
		description: "Used when the server does not report a limit.",
		minimum: 1,
		nullable: false,
		unit: "tokens",
	},
	defaultContextLength: {
		label: "Default context length",
		description: "Used when the server does not report a context window.",
		minimum: 1,
		nullable: false,
		unit: "tokens",
	},
	defaultMaxInputTokens: {
		label: "Default max input tokens",
		description: "Leave empty to derive it as context length minus output tokens.",
		minimum: 1,
		nullable: true,
		unit: "tokens",
	},
	requestTimeout: {
		label: "Request timeout",
		description: "Hard bound for one chat completion call.",
		minimum: 1000,
		nullable: false,
		unit: "ms",
	},
	discoveryTimeout: {
		label: "Discovery timeout",
		description: "Hard bound for one model discovery call.",
		minimum: 1000,
		nullable: false,
		unit: "ms",
	},
	discoveryCacheTtl: {
		label: "Discovery cache TTL",
		description: "How long discovered model lists are reused; 0 asks the server on every refresh.",
		minimum: 0,
		nullable: false,
		unit: "ms",
		zeroMeaning: "every refresh",
	},
} as const satisfies Record<string, NumberSettingSpec>;

export type NumberSettingId = keyof typeof NUMBER_SETTINGS;

export const NUMBER_SETTING_IDS = Object.keys(NUMBER_SETTINGS) as readonly NumberSettingId[];

interface BooleanSettingSpec {
	readonly label: string;
	readonly description: string;
}

/** The boolean litellm-vscode-chat.* settings the dashboard edits. */
export const BOOLEAN_SETTINGS = {
	"promptCaching.enabled": {
		label: "Prompt caching",
		description: "Cache the system prompt on models that advertise support.",
	},
	maskApiKeyInput: {
		label: "Mask API key input",
		description: "Hide the API key while typing it into configuration prompts.",
	},
} as const satisfies Record<string, BooleanSettingSpec>;

export type BooleanSettingId = keyof typeof BOOLEAN_SETTINGS;

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
 * The muted equivalence rendered next to a number input, recomputed from the
 * draft as the user types: millisecond durations in clock units, and the
 * TTL's special zero reading ("= every refresh"). Token counts get no
 * equivalence (a digit-grouped echo of the same number says nothing); their
 * unit suffix on the input carries the meaning.
 */
export function equivalence(id: NumberSettingId, draft: string): string | undefined {
	const trimmed = draft.trim();
	if (trimmed.length === 0) {
		return undefined;
	}
	const value = Number(trimmed);
	const spec: NumberSettingSpec = NUMBER_SETTINGS[id];
	if (!Number.isFinite(value) || value < spec.minimum || spec.unit !== "ms") {
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

/** A value legal in the headers setting: HTTP header values are scalars. */
export type HeaderScalar = string | number | boolean;

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

const ACKED_INTENT_TYPE_SET: ReadonlySet<string> = new Set(Object.keys(ACKED_INTENT_TYPES));

/** The failure notices a state push leaves standing; see ACKED_INTENT_TYPES. */
export function failuresAfterStatePush<T>(failures: Readonly<Record<string, T>>): Readonly<Record<string, T>> {
	const kept = Object.entries(failures).filter(([intentType]) => ACKED_INTENT_TYPE_SET.has(intentType));
	return kept.length === Object.keys(failures).length ? failures : Object.fromEntries(kept);
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
export interface SaveServerPayload {
	readonly label: string;
	readonly baseUrl: string;
	readonly oauthTokenUrl?: string | undefined;
	readonly oauthClientId?: string | undefined;
	readonly oauthScopes?: string | undefined;
	readonly virtualKeyHeader?: string | undefined;
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
 * strict: JSON scalars are taken as typed values ("true" is a boolean, "42" a
 * number, "\"42\"" a string) and anything else is the literal string.
 */
export function parseHeaderValue(text: string): HeaderScalar {
	const trimmed = text.trim();
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean") {
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
