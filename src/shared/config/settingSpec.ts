/**
 * The single source of truth for the extension's configuration section.
 *
 * package.json's contributed configuration is generated from this table (scripts/dev/manifest), the settings readers
 * judge against it, and the dashboard protocol layers its own presentation metadata on top.
 *
 * Pure constants: no vscode, no Node, no zod (this module rides into the webview bundle and loads outside the host).
 *
 * The twelve key constants after the section name are the settings with no scalar spec; their readers share the key
 * names through them. FEATURE_MODEL_IDS lists the features that pick their model through an explicit `<feature>.model`
 * setting.
 */

export const CONFIG_SECTION = "litellm-vscode-chat";

export const ADDITIONAL_TOOL_SCHEMA_KEYWORDS_SETTING_KEY = "chat.additionalToolSchemaKeywords";
export const TOKEN_ESTIMATION_SETTING_KEY = "chat.tokenEstimation";
export const MODEL_CAPABILITIES_SETTING_KEY = "models.capabilities";
export const MODEL_PARAMETERS_SETTING_KEY = "models.parameters";
export const SERVERS_SETTING_KEY = "servers";
export const USAGE_ALERT_THRESHOLDS_SETTING_KEY = "usage.alertThresholds";
export const USAGE_STATUS_BAR_SETTING_KEY = "usage.statusBar";
export const CURRENCY_SYMBOL_SETTING_KEY = "usage.currencySymbol";
export const UI_THEME_SETTING_KEY = "ui.theme";
export const UI_ACCENT_SETTING_KEY = "ui.accent";
export const INLINE_COMPLETIONS_LANGUAGE_FILTER_SETTING_KEY = "inlineCompletions.languageFilter";
export const COMMIT_GENERATION_PROMPT_SETTING_KEY = "commitGeneration.prompt";

export const FEATURE_MODEL_IDS = [
	"inlineCompletions",
	"commitGeneration",
	"prGeneration",
	"consultTool",
	// Its model backs only the FALLBACK path: enabled with no model still works, because the primary path routes
	// through the @litellm participant on whichever model the chat picker names.
	"quickFix",
	"reviewComments",
] as const;

export type FeatureModelId = (typeof FEATURE_MODEL_IDS)[number];

/** Every feature with an enable setting; the one FeatureId vocabulary the per-layer tables key on. */
export const FEATURE_IDS = [
	...FEATURE_MODEL_IDS,
	// The two that run on the chat request's own model and so have no model key.
	"chatParticipant",
	"agentTools",
] as const;

export type FeatureId = (typeof FEATURE_IDS)[number];

export function isFeatureModelId(feature: FeatureId): feature is FeatureModelId {
	return (FEATURE_MODEL_IDS as readonly FeatureId[]).includes(feature);
}

/**
 * A feature's explicit model choice: a `servers` entry's label (the same identity the sync engine and usage
 * resolution address entries by) plus the raw model ID that server serves. Never auto-picked.
 */
export interface FeatureModelRef {
	readonly server: string;
	readonly model: string;
}

/** Each feature's model setting key; the one map the getters, intents, and rows address the pair through. */
export const FEATURE_MODEL_SETTING_KEYS = {
	inlineCompletions: "inlineCompletions.model",
	commitGeneration: "commitGeneration.model",
	prGeneration: "prGeneration.model",
	consultTool: "consultTool.model",
	quickFix: "quickFix.model",
	reviewComments: "reviewComments.model",
} as const satisfies Record<FeatureModelId, string>;

/** One feature's model setting key as a literal type; the view-model unions derive their members from it. */
export type FeatureModelSettingKey = (typeof FEATURE_MODEL_SETTING_KEYS)[FeatureModelId];

/** The model setting keys in FEATURE_MODEL_IDS order, for the surfaces that iterate rather than address. */
export const FEATURE_MODEL_SETTING_KEY_LIST: readonly FeatureModelSettingKey[] = FEATURE_MODEL_IDS.map(
	(feature) => FEATURE_MODEL_SETTING_KEYS[feature]
);

/** What LiteLLM groups a chat request under: the session id the request carries. */
export const SESSION_ID_MODES = [
	"off", // no session id rides the request
	"on", // one session per chat, the way other LiteLLM clients send theirs
	"folder", // one session per open folder
	"window", // one session per VS Code window, until it closes
] as const;

export type SessionIdMode = (typeof SESSION_ID_MODES)[number];

/** The default: a session per chat, as other LiteLLM clients send theirs. */
export const DEFAULT_SESSION_ID_MODE: SessionIdMode = "on";

/** The session id setting's key; it covers the Copilot chat, the agent path, and the @litellm participant. */
export const CHAT_SESSION_ID_SETTING_KEY = "chat.sessionId";

/** "block" runs completions everywhere except the listed languages; "allow" runs them only there. */
export const LANGUAGE_FILTER_MODES = ["block", "allow"] as const;

export type LanguageFilterMode = (typeof LANGUAGE_FILTER_MODES)[number];

/**
 * The inlineCompletions.languageFilter value: one mode plus exact VS Code language IDs (no globs). Block mode with the
 * empty list filters nothing; allow mode with the empty list runs completions nowhere.
 */
export interface InlineLanguageFilter {
	readonly mode: LanguageFilterMode;
	readonly languages: readonly string[];
}

/** Block mode with the empty list: filters nothing. */
export const DEFAULT_INLINE_LANGUAGE_FILTER: InlineLanguageFilter = { mode: "block", languages: [] };

/** Here because dashboard/html.ts stamps it on the root element and may import only this pure module. */
export const UI_THEMES = ["auto", "light", "dark"] as const;

export type UiTheme = (typeof UI_THEMES)[number];

/** "auto" follows the host's theme kind. */
export const DEFAULT_UI_THEME: UiTheme = "auto";

/** The accent hue of primary actions, selection, focus and links; never of status, which keeps the severity colors. */
export const UI_ACCENTS = ["blue", "violet", "teal", "amber"] as const;

export type UiAccent = (typeof UI_ACCENTS)[number];

/** The default accent; blue is the editor's own primary-action hue. */
export const DEFAULT_UI_ACCENT: UiAccent = "blue";

/** How the local token budget prices text (chat.tokenEstimation). */
export const TOKEN_ESTIMATION_MODES = [
	"auto", // starts from a script-aware heuristic
	"heuristic", // the plain 4-characters-per-token rule; never loads tokenizer data
	"o200k_base", // the explicit encodings always load theirs
	"cl100k_base",
] as const;

export type TokenEstimationMode = (typeof TOKEN_ESTIMATION_MODES)[number];

/** "auto" by default: script-aware without loading tokenizer data up front. */
export const DEFAULT_TOKEN_ESTIMATION_MODE: TokenEstimationMode = "auto";

/** Display only, never a conversion: the prefix of every spend and cost figure; "" renders the bare number. */
export const DEFAULT_CURRENCY_SYMBOL = "$";

/** The floor of both timeout settings; a sub-second timeout would abort requests before they leave. */
export const MIN_TIMEOUT_MS = 1000;

/** The ceiling of every timer-fed millisecond setting: past 2^31 - 1 the platform's timers fire at once or throw. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** Retries after a retryable failure of an idempotent request; here so the settings-reference prose can derive it. */
export const DISCOVERY_MAX_RETRIES = 2;

/**
 * The value contract of one number setting, exactly what package.json declares for it; a configured value outside
 * it reads as the default (acceptsNumberSetting), never as a clamped or rounded guess.
 *
 * `integer` is the one source of the integer-only fact: the manifest declares `"type": "integer"`, the reader and the
 * dashboard refuse fractions. Every millisecond setting is integer-only because the platform's timers are:
 * AbortSignal.timeout(1000.5) throws a RangeError. `offValue` is the documented off switch: exactly this value is
 * taken although it lies below the minimum.
 *   Nullable settings may default to null -> "unset, derive it"
 */
export type NumberSettingValueSpec = {
	readonly integer?: true;
	readonly minimum: number;
	readonly maximum: number;
	readonly offValue?: 0;
} & (
	| { readonly default: number; readonly nullable: false }
	| { readonly default: number | null; readonly nullable: true }
);

export interface BooleanSettingValueSpec {
	readonly default: boolean;
}

/** The floor of a running poll: a tiny interval would loop several GETs per server as fast as the network allows. */
export const MIN_USAGE_POLL_INTERVAL_MS = 30000;

/** The value contract of each number setting, exactly what package.json declares; see NumberSettingValueSpec. */
export const NUMBER_SETTING_SPECS = {
	"chat.timeout": { default: 300000, minimum: MIN_TIMEOUT_MS, maximum: MAX_TIMER_MS, nullable: false, integer: true },
	// A tool count, not milliseconds; nothing short of exact-integer range bounds it.
	"chat.maxToolsPerRequest": {
		default: 128,
		minimum: 1,
		maximum: Number.MAX_SAFE_INTEGER,
		nullable: false,
		integer: true,
	},
	"discovery.timeout": {
		default: 30000,
		minimum: MIN_TIMEOUT_MS,
		maximum: MAX_TIMER_MS,
		nullable: false,
		integer: true,
	},
	// An age window: compared against elapsed time, never scheduled, so a 30-day TTL is legal and only exact-integer
	// range bounds it. A zero TTL is legal too: it disables serving from the discovery cache.
	"discovery.cacheTtl": {
		default: 3600000,
		minimum: 0,
		maximum: Number.MAX_SAFE_INTEGER,
		nullable: false,
		integer: true,
	},
	// An age window like cacheTtl. Zero is legal: it disables stale serving.
	"discovery.staleServeWindow": {
		default: 600000,
		minimum: 0,
		maximum: Number.MAX_SAFE_INTEGER,
		nullable: false,
		integer: true,
	},
	// Milliseconds like the other cadence settings. Zero is the documented off switch (explicit refresh still works).
	"usage.pollInterval": {
		default: 300000,
		minimum: MIN_USAGE_POLL_INTERVAL_MS,
		maximum: MAX_TIMER_MS,
		offValue: 0,
		nullable: false,
		integer: true,
	},
	// The first poll after activation: soon, but never on the activation path.
	"usage.initialRefreshDelay": { default: 5000, minimum: 0, maximum: MAX_TIMER_MS, nullable: false, integer: true },
	// Long enough to coalesce settings.json keystroke bursts.
	"usage.serversChangeRefreshDelay": {
		default: 2000,
		minimum: 0,
		maximum: MAX_TIMER_MS,
		nullable: false,
		integer: true,
	},
	// An age window like cacheTtl. Zero is legal.
	"usage.pollingOffFreshnessWindow": {
		default: 600000,
		minimum: 0,
		maximum: Number.MAX_SAFE_INTEGER,
		nullable: false,
		integer: true,
	},
} as const satisfies Record<string, NumberSettingValueSpec>;

export type NumberSettingId = keyof typeof NUMBER_SETTING_SPECS;

export function isIntegerSetting(id: NumberSettingId): boolean {
	const spec = NUMBER_SETTING_SPECS[id];
	return "integer" in spec && spec.integer === true;
}

export function numberSettingOffValue(id: NumberSettingId): number | undefined {
	const spec = NUMBER_SETTING_SPECS[id];
	return "offValue" in spec ? spec.offValue : undefined;
}

/**
 * Whether a configured value is one the setting takes as written. Anything else reads as the default, never as a
 * clamped or rounded guess: the reader (settings.ts), the host write (dashboard/intents.ts), the import gate
 * (settingsTransfer/importPlan.ts), the form (dashboard/presenters.ts), and the Diagnostics tab (configDiagnostics.ts)
 * all judge by this one rule, so they name the same bound.
 */
export function acceptsNumberSetting(id: NumberSettingId, raw: unknown): boolean {
	const spec = NUMBER_SETTING_SPECS[id];
	if (raw === null) {
		return spec.nullable;
	}
	const offValue = numberSettingOffValue(id);
	if (offValue !== undefined && raw === offValue) {
		return true;
	}
	return (
		typeof raw === "number" &&
		Number.isFinite(raw) &&
		(!isIntegerSetting(id) || Number.isInteger(raw)) &&
		raw >= spec.minimum &&
		raw <= spec.maximum
	);
}

/**
 * The contract as English bound text for logs, failure-detail lines, and the copyable diagnostics block, so every
 * English surface names the same bound.
 *   "between 1000 and 2147483647" / "between 30000 and 2147483647, or 0 to turn it off"
 */
export function numberSettingBoundText(id: NumberSettingId): string {
	const { minimum, maximum } = NUMBER_SETTING_SPECS[id];
	const offValue = numberSettingOffValue(id);
	const range = `between ${minimum} and ${maximum}`;
	return offValue === undefined ? range : `${range}, or ${offValue} to turn it off`;
}

export const BOOLEAN_SETTING_SPECS = {
	"chat.promptCaching": { default: true },
	"models.openRouterCatalog": { default: true },
	"ui.maskSecretInputs": { default: true },
	"logs.redactSecrets": { default: true },
	"inlineCompletions.enabled": { default: false },
	"commitGeneration.enabled": { default: false },
	"prGeneration.enabled": { default: false },
	"consultTool.enabled": { default: false },
	"quickFix.enabled": { default: false },
	"reviewComments.enabled": { default: false },
	// The participant is on by default: it costs nothing until invoked and uses the chat request's own model, so it has
	// no model key.
	"chatParticipant.enabled": { default: true },
	// The agent tools are opt-in twice over: the feature switch registers the read tools, and each write tool registers
	// only under its own switch.
	"agentTools.enabled": { default: false },
	"agentTools.setSetting.enabled": { default: false },
	"agentTools.editModelRecords.enabled": { default: false },
	"agentTools.saveServer.enabled": { default: false },
	"agentTools.removeServer.enabled": { default: false },
	"agentTools.runAction.enabled": { default: false },
	"agentTools.secretValues.enabled": { default: false },
} as const satisfies Record<string, BooleanSettingValueSpec>;

export type BooleanSettingId = keyof typeof BOOLEAN_SETTING_SPECS;

/** Each feature's enable key; the one map the settings getter, diagnostics flags, and dashboard rows address. */
export const FEATURE_ENABLE_SETTING_KEYS = {
	inlineCompletions: "inlineCompletions.enabled",
	commitGeneration: "commitGeneration.enabled",
	prGeneration: "prGeneration.enabled",
	consultTool: "consultTool.enabled",
	quickFix: "quickFix.enabled",
	reviewComments: "reviewComments.enabled",
	chatParticipant: "chatParticipant.enabled",
	agentTools: "agentTools.enabled",
} as const satisfies Record<FeatureId, BooleanSettingId>;

/** The agent tools that write, each behind its own toggle beside the feature switch. */
const AGENT_WRITE_TOOL_IDS = ["setSetting", "editModelRecords", "saveServer", "removeServer", "runAction"] as const;

export type AgentWriteToolId = (typeof AGENT_WRITE_TOOL_IDS)[number];

/** Each write tool's toggle key; the one map the settings getter, the registration, and the manifest address. */
export const AGENT_TOOL_TOGGLE_KEYS = {
	setSetting: "agentTools.setSetting.enabled",
	editModelRecords: "agentTools.editModelRecords.enabled",
	saveServer: "agentTools.saveServer.enabled",
	removeServer: "agentTools.removeServer.enabled",
	runAction: "agentTools.runAction.enabled",
} as const satisfies Record<AgentWriteToolId, BooleanSettingId>;

/** Whether agent tool input may carry a secret's value; off, the user types it into a masked input box instead. */
export const AGENT_TOOLS_SECRET_VALUES_KEY = "agentTools.secretValues.enabled" satisfies BooleanSettingId;

/** Whether the output channel masks known secret values; the issue report always does. */
export const LOG_REDACTION_SETTING_KEY = "logs.redactSecrets" satisfies BooleanSettingId;

/**
 * Any key of the agentTools family; the set_setting tool refuses these at the type level, so an agent cannot flip its
 * own switches.
 */
export type AgentToolsSettingId =
	| "agentTools.enabled"
	| (typeof AGENT_TOOL_TOGGLE_KEYS)[AgentWriteToolId]
	| typeof AGENT_TOOLS_SECRET_VALUES_KEY;

/** The agentTools family in manifest order; a literal tuple so CONFIGURATION_SECTIONS can check it is total. */
export const AGENT_TOOLS_SETTING_KEYS = [
	FEATURE_ENABLE_SETTING_KEYS.agentTools,
	AGENT_TOOL_TOGGLE_KEYS.setSetting,
	AGENT_TOOL_TOGGLE_KEYS.editModelRecords,
	AGENT_TOOL_TOGGLE_KEYS.saveServer,
	AGENT_TOOL_TOGGLE_KEYS.removeServer,
	AGENT_TOOL_TOGGLE_KEYS.runAction,
	AGENT_TOOLS_SECRET_VALUES_KEY,
] as const satisfies readonly AgentToolsSettingId[];

/** Whether one number is a usable usage.alertThresholds value: finite, in (0, 1]. */
export function isUsableThreshold(value: number): boolean {
	return Number.isFinite(value) && value > 0 && value <= 1;
}

/** The budget fractions the usage poller alerts at when nothing valid is configured. */
export const DEFAULT_USAGE_ALERT_THRESHOLDS: readonly number[] = [0.8, 0.95];

/**
 * The thresholds that participate in a scale: the usable ones, deduplicated and ascending. The one list normalizer
 * behind the settings reader, the dashboard's spend tone, the status bar, and the budget resolver.
 */
export function usableThresholds(thresholds: readonly number[]): number[] {
	return [...new Set(thresholds.filter(isUsableThreshold))].sort((a, b) => a - b);
}

/** When the usage status-bar item shows: always, only while an alert threshold is crossed, or never. */
export const USAGE_STATUS_BAR_MODES = ["always", "alerts-only", "off"] as const;

export type UsageStatusBarMode = (typeof USAGE_STATUS_BAR_MODES)[number];

/** Always shown by default, so a configured budget stays in view. */
export const DEFAULT_USAGE_STATUS_BAR_MODE: UsageStatusBarMode = "always";

/** The settings with no scalar spec: objects, arrays, free and enum strings. Their grammars live with their readers. */
const STRUCTURED_SETTING_KEYS = [
	SERVERS_SETTING_KEY,
	MODEL_PARAMETERS_SETTING_KEY,
	MODEL_CAPABILITIES_SETTING_KEY,
	ADDITIONAL_TOOL_SCHEMA_KEYWORDS_SETTING_KEY,
	TOKEN_ESTIMATION_SETTING_KEY,
	USAGE_ALERT_THRESHOLDS_SETTING_KEY,
	USAGE_STATUS_BAR_SETTING_KEY,
	CURRENCY_SYMBOL_SETTING_KEY,
	UI_THEME_SETTING_KEY,
	UI_ACCENT_SETTING_KEY,
	...FEATURE_MODEL_SETTING_KEY_LIST,
	INLINE_COMPLETIONS_LANGUAGE_FILTER_SETTING_KEY,
	COMMIT_GENERATION_PROMPT_SETTING_KEY,
	CHAT_SESSION_ID_SETTING_KEY,
] as const;

/** Every setting key as a literal union, for the surfaces that must be TOTAL over the vocabulary. */
export type SettingId = (typeof STRUCTURED_SETTING_KEYS)[number] | NumberSettingId | BooleanSettingId;

/** Every setting the dashboard writes by key; the servers array is out, written in settingsWriteTurn.ts's turn. */
export type KeyedSettingId = Exclude<SettingId, typeof SERVERS_SETTING_KEY>;

/** The id doubles as the nls key suffix `litellm.config.section.<id>`. */
interface ConfigurationSection {
	readonly id: string;
	readonly settings: readonly SettingId[];
}

const SECTIONS = [
	{ id: "servers", settings: [SERVERS_SETTING_KEY] },
	{
		id: "models",
		settings: [MODEL_PARAMETERS_SETTING_KEY, MODEL_CAPABILITIES_SETTING_KEY, "models.openRouterCatalog"],
	},
	{
		id: "chat",
		settings: [
			"chat.timeout",
			"chat.maxToolsPerRequest",
			ADDITIONAL_TOOL_SCHEMA_KEYWORDS_SETTING_KEY,
			"chat.promptCaching",
			TOKEN_ESTIMATION_SETTING_KEY,
			CHAT_SESSION_ID_SETTING_KEY,
		],
	},
	{ id: "discovery", settings: ["discovery.timeout", "discovery.cacheTtl", "discovery.staleServeWindow"] },
	{
		id: "usage",
		settings: [
			"usage.pollInterval",
			"usage.initialRefreshDelay",
			"usage.serversChangeRefreshDelay",
			"usage.pollingOffFreshnessWindow",
			USAGE_ALERT_THRESHOLDS_SETTING_KEY,
			USAGE_STATUS_BAR_SETTING_KEY,
			CURRENCY_SYMBOL_SETTING_KEY,
		],
	},
	{ id: "ui", settings: ["ui.maskSecretInputs", UI_THEME_SETTING_KEY, UI_ACCENT_SETTING_KEY] },
	{ id: "logs", settings: [LOG_REDACTION_SETTING_KEY] },
	{
		id: "inlineCompletions",
		settings: [
			FEATURE_ENABLE_SETTING_KEYS.inlineCompletions,
			FEATURE_MODEL_SETTING_KEYS.inlineCompletions,
			INLINE_COMPLETIONS_LANGUAGE_FILTER_SETTING_KEY,
		],
	},
	{
		id: "commitGeneration",
		settings: [
			FEATURE_ENABLE_SETTING_KEYS.commitGeneration,
			FEATURE_MODEL_SETTING_KEYS.commitGeneration,
			COMMIT_GENERATION_PROMPT_SETTING_KEY,
		],
	},
	{ id: "prGeneration", settings: [FEATURE_ENABLE_SETTING_KEYS.prGeneration, FEATURE_MODEL_SETTING_KEYS.prGeneration] },
	{ id: "consultTool", settings: [FEATURE_ENABLE_SETTING_KEYS.consultTool, FEATURE_MODEL_SETTING_KEYS.consultTool] },
	{ id: "quickFix", settings: [FEATURE_ENABLE_SETTING_KEYS.quickFix, FEATURE_MODEL_SETTING_KEYS.quickFix] },
	{
		id: "reviewComments",
		settings: [FEATURE_ENABLE_SETTING_KEYS.reviewComments, FEATURE_MODEL_SETTING_KEYS.reviewComments],
	},
	{ id: "chatParticipant", settings: [FEATURE_ENABLE_SETTING_KEYS.chatParticipant] },
	{ id: "agentTools", settings: AGENT_TOOLS_SETTING_KEYS },
] as const satisfies readonly ConfigurationSection[];

type UnsectionedSettingId = Exclude<SettingId, (typeof SECTIONS)[number]["settings"][number]>;

/** The sections in manifest order (the settings UI's, which the docs follow); a key listed twice is refused. */
export const CONFIGURATION_SECTIONS: [UnsectionedSettingId] extends [never]
	? typeof SECTIONS
	: { readonly "every SettingId needs a section; missing": UnsectionedSettingId } = SECTIONS;

/** Every setting key in manifest order; in a section or it does not compile, so no transfer surface misses one. */
export const ALL_SETTING_KEYS: readonly SettingId[] = CONFIGURATION_SECTIONS.flatMap(
	(section): readonly SettingId[] => section.settings
);

/** Membership of foreign text (a file's key, a stored record's key), narrowed to the union. */
export function isSettingId(key: string): key is SettingId {
	return (ALL_SETTING_KEYS as readonly string[]).includes(key);
}

/**
 * Where a setting may be set: "window" is the default user/workspace setting; "machine" is user settings only, never a
 * workspace file and never Settings Sync; "machine-overridable" is per-machine (Settings Sync skips it) but a workspace
 * may still override it with its own explicit entry.
 */
type SettingScope = "window" | "machine" | "machine-overridable";

/**
 * How package.json presents one setting, beside the value spec: the manifest keys that are neither the value contract
 * nor prose. The prose itself stays in package.nls.json under `litellm.config.<id>.description` (and
 * `litellm.config.<id>.<value>` per enum member when `enumDescriptions` is set). `restricted` marks a setting
 * Restricted Mode (an untrusted workspace) may not supply; `description` says whether the prose renders as markdown
 * (`markdownDescription`) or plain text (`description`).
 */
export interface SettingPresentation {
	readonly scope: SettingScope;
	readonly restricted?: true;
	readonly description: "plain" | "markdown";
	readonly editPresentation?: "multilineText";
	readonly enumDescriptions?: true;
}

const MACHINE_OVERRIDABLE_MARKDOWN: SettingPresentation = { scope: "machine-overridable", description: "markdown" };
const MACHINE_MARKDOWN: SettingPresentation = { scope: "machine", description: "markdown" };
const WINDOW_PLAIN: SettingPresentation = { scope: "window", description: "plain" };

export const SETTING_PRESENTATION: Readonly<Record<SettingId, SettingPresentation>> = {
	// Machine scope, user settings only: an agent's write access to servers and keys is granted by the user alone,
	// never by a checked-in workspace file. The agentTools family below is machine scope for the same reason.
	servers: MACHINE_MARKDOWN,
	// Restricted: the two model record settings shape what goes to the user's server and compile user regex matchers.
	"models.parameters": { scope: "window", restricted: true, description: "markdown" },
	"models.capabilities": { scope: "window", restricted: true, description: "markdown" },
	// Machine-overridable: the catalog toggle causes OpenRouter fetches.
	"models.openRouterCatalog": { scope: "machine-overridable", description: "plain" },
	"chat.timeout": WINDOW_PLAIN,
	"chat.maxToolsPerRequest": WINDOW_PLAIN,
	"chat.additionalToolSchemaKeywords": WINDOW_PLAIN,
	"chat.promptCaching": WINDOW_PLAIN,
	"chat.tokenEstimation": { scope: "window", description: "plain", enumDescriptions: true },
	"chat.sessionId": { scope: "window", description: "plain", enumDescriptions: true },
	"discovery.timeout": WINDOW_PLAIN,
	"discovery.cacheTtl": WINDOW_PLAIN,
	"discovery.staleServeWindow": WINDOW_PLAIN,
	"usage.pollInterval": WINDOW_PLAIN,
	"usage.initialRefreshDelay": WINDOW_PLAIN,
	"usage.serversChangeRefreshDelay": WINDOW_PLAIN,
	"usage.pollingOffFreshnessWindow": WINDOW_PLAIN,
	"usage.alertThresholds": WINDOW_PLAIN,
	"usage.statusBar": WINDOW_PLAIN,
	"usage.currencySymbol": WINDOW_PLAIN,
	"ui.maskSecretInputs": WINDOW_PLAIN,
	"ui.theme": { scope: "window", description: "plain", enumDescriptions: true },
	"ui.accent": WINDOW_PLAIN,
	// Machine-overridable: a per-machine choice about the channel's text.
	"logs.redactSecrets": { scope: "machine-overridable", description: "plain" },
	// Machine-overridable, the load-bearing tier: the enable booleans and model refs decide whether requests happen and
	// where they go.
	"inlineCompletions.enabled": MACHINE_OVERRIDABLE_MARKDOWN,
	"inlineCompletions.model": MACHINE_OVERRIDABLE_MARKDOWN,
	"inlineCompletions.languageFilter": { scope: "window", description: "markdown" },
	"commitGeneration.enabled": MACHINE_OVERRIDABLE_MARKDOWN,
	"commitGeneration.model": MACHINE_OVERRIDABLE_MARKDOWN,
	"commitGeneration.prompt": { scope: "window", description: "markdown", editPresentation: "multilineText" },
	"prGeneration.enabled": MACHINE_OVERRIDABLE_MARKDOWN,
	"prGeneration.model": MACHINE_OVERRIDABLE_MARKDOWN,
	"consultTool.enabled": MACHINE_OVERRIDABLE_MARKDOWN,
	"consultTool.model": MACHINE_OVERRIDABLE_MARKDOWN,
	"quickFix.enabled": MACHINE_OVERRIDABLE_MARKDOWN,
	"quickFix.model": MACHINE_OVERRIDABLE_MARKDOWN,
	"reviewComments.enabled": MACHINE_OVERRIDABLE_MARKDOWN,
	"reviewComments.model": MACHINE_OVERRIDABLE_MARKDOWN,
	"chatParticipant.enabled": MACHINE_OVERRIDABLE_MARKDOWN,
	"agentTools.enabled": MACHINE_MARKDOWN,
	"agentTools.setSetting.enabled": MACHINE_MARKDOWN,
	"agentTools.editModelRecords.enabled": MACHINE_MARKDOWN,
	"agentTools.saveServer.enabled": MACHINE_MARKDOWN,
	"agentTools.removeServer.enabled": MACHINE_MARKDOWN,
	"agentTools.runAction.enabled": MACHINE_MARKDOWN,
	"agentTools.secretValues.enabled": MACHINE_MARKDOWN,
};
