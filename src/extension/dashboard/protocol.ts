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

export { isValidHeaderName } from "../../shared/headers";
export { isUnsafeRecordKey } from "../../shared/json";

/** One server as the status window saw it last; mirrors shared/servers ServerStatus minus internal IDs. */
export interface DashboardServer {
	readonly label: string;
	readonly baseUrl: string;
	readonly state: "ok" | "error";
	readonly modelCount: number;
	readonly error?: string | undefined;
	/** ISO timestamp of the last discovery attempt. */
	readonly lastChecked: string;
	/** Whether the server's configuration carries credentials; the secrets themselves never reach the webview. */
	readonly hasApiKey: boolean;
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
 * partial truth) and intent-failure notices. A failed intent produces no
 * configuration change and therefore no state push, so the failure message is
 * the only way the webview learns the write did not land.
 */
export type ExtensionToWebviewMessage =
	| { readonly type: "state"; readonly state: DashboardState }
	| { readonly type: "intentFailed"; readonly intentType: DashboardIntentType; readonly message: string };

/** Actions the webview can trigger; the extension maps each ID to the command it already registers. */
export const DASHBOARD_COMMAND_IDS = [
	"manageServers",
	"syncModels",
	"testConnection",
	"showDiagnostics",
	"openSettings",
] as const;

export type DashboardCommandId = (typeof DASHBOARD_COMMAND_IDS)[number];

/** Webview-to-extension intents. The extension re-validates every one: the webview is a trust boundary. */
export type WebviewToExtensionMessage =
	| { readonly type: "ready" }
	| { readonly type: "setNumberSetting"; readonly setting: NumberSettingId; readonly value: number | null }
	| { readonly type: "setBooleanSetting"; readonly setting: BooleanSettingId; readonly value: boolean }
	| { readonly type: "setModelParameters"; readonly value: Record<string, Record<string, unknown>> }
	| { readonly type: "setHeaders"; readonly value: Record<string, HeaderScalar> }
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
