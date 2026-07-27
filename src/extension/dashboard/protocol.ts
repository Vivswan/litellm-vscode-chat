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

interface NumberSettingSpec {
	readonly label: string;
	readonly description: string;
	readonly minimum: number;
	/** Whether null (meaning "unset, derive it") is a legal value. */
	readonly nullable: boolean;
}

/**
 * The number-valued litellm-vscode-chat.* settings the dashboard edits.
 * Labels and constraints live here so the webview form and the extension-side
 * validation read the same table; defaults stay in package.json only (the
 * state builder reads them through configuration inspection).
 */
export const NUMBER_SETTINGS = {
	defaultMaxOutputTokens: {
		label: "Default max output tokens",
		description: "Used when the server does not report a limit.",
		minimum: 1,
		nullable: false,
	},
	defaultContextLength: {
		label: "Default context length",
		description: "Used when the server does not report a context window.",
		minimum: 1,
		nullable: false,
	},
	defaultMaxInputTokens: {
		label: "Default max input tokens",
		description: "Leave empty to derive it as context length minus output tokens.",
		minimum: 1,
		nullable: true,
	},
	requestTimeout: {
		label: "Request timeout (ms)",
		description: "Hard bound for one chat completion call.",
		minimum: 1000,
		nullable: false,
	},
	discoveryTimeout: {
		label: "Discovery timeout (ms)",
		description: "Hard bound for one model discovery call.",
		minimum: 1000,
		nullable: false,
	},
	discoveryCacheTtl: {
		label: "Discovery cache TTL (ms)",
		description: "How long discovered model lists are reused; 0 asks the server on every refresh.",
		minimum: 0,
		nullable: false,
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
	| { readonly type: "intentSucceeded"; readonly intentType: DashboardIntentType; readonly requestId: string }
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

/** The intent types that carry a correlation requestId, derived from the message union itself. */
type AckedIntentType = Extract<WebviewToExtensionMessage, { requestId: string }>["type"];

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
	| { readonly type: "executeCommand"; readonly command: DashboardCommandId };

/** The intents that can fail and be reported back; the ready handshake has no failure mode. */
export type DashboardIntentType = Exclude<WebviewToExtensionMessage["type"], "ready">;

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
