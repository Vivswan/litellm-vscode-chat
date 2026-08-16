/**
 * The single source of truth for the extension's configuration section, the
 * value side of its scalar settings (key names, defaults, and minimums), and
 * the object settings' key names. package.json's contributed configuration
 * mirrors this table (settingSpec.test.ts pins the mirror), the settings
 * readers clamp against it, and the dashboard protocol layers its presentation
 * metadata on top. Pure constants: no vscode, no Node, no zod (this module
 * rides into the webview bundle and loads outside the host).
 */

/** The configuration section every litellm-vscode-chat.* setting lives under. */
export const CONFIG_SECTION = "litellm-vscode-chat";

/**
 * The object settings' keys under the config section. They have no scalar
 * spec; their readers share the key names through these constants, and
 * settingSpec.test.ts pins the package.json contributions against them.
 */
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

/**
 * The dashboard's theme choices. "auto" leaves every semantic token mapped
 * onto the host's --vscode-* variables, so the dashboard follows whatever
 * theme the editor wears - high contrast and themes we have never seen
 * included. The other two pin our own palette instead.
 *
 * The vocabularies live here rather than beside their readers because the HTML
 * shell stamps them on the root element and this module is the only settings
 * module it can reach: the shell is pure string building so the render harness
 * can import it outside the extension host.
 */
export const UI_THEMES = ["auto", "light", "dark"] as const;

export type UiTheme = (typeof UI_THEMES)[number];

export const DEFAULT_UI_THEME: UiTheme = "auto";

/**
 * The accent hue, deployed on primary actions, selection, focus and links -
 * never on status, where it would compete with the severity colors.
 */
export const UI_ACCENTS = ["blue", "violet", "teal", "amber"] as const;

export type UiAccent = (typeof UI_ACCENTS)[number];

export const DEFAULT_UI_ACCENT: UiAccent = "blue";

/**
 * How the local token budget prices text (chat.tokenEstimation). "auto" starts
 * from a script-aware heuristic and loads the o200k_base tokenizer once the UI
 * language or the counted text is CJK; "heuristic" is the plain
 * 4-characters-per-token rule and never loads tokenizer data; the explicit
 * encodings always load theirs.
 */
export const TOKEN_ESTIMATION_MODES = ["auto", "heuristic", "o200k_base", "cl100k_base"] as const;

export type TokenEstimationMode = (typeof TOKEN_ESTIMATION_MODES)[number];

export const DEFAULT_TOKEN_ESTIMATION_MODE: TokenEstimationMode = "auto";

/**
 * The prefix every spend and cost figure renders with (usage.currencySymbol).
 * Display only, never a conversion: a proxy accounting in another currency
 * still reports plain numbers, and this symbol is how the display stops
 * claiming dollars. The empty string renders the bare number.
 */
export const DEFAULT_CURRENCY_SYMBOL = "$";

/** The floor both timeout settings clamp to; sub-second timeouts would abort requests before they leave. */
export const MIN_TIMEOUT_MS = 1000;

/**
 * The value contract of one number setting, exactly what package.json declares
 * for it. Nullable settings may default to null ("unset, derive it").
 * `integer` is the one source of the integer-only fact: the manifest declares
 * `"type": "integer"`, the settings reader floors fractions, and the
 * dashboard's count grammar refuses them.
 */
export type NumberSettingValueSpec = { readonly integer?: true } & (
	| { readonly default: number; readonly minimum: number; readonly nullable: false }
	| { readonly default: number | null; readonly minimum: number; readonly nullable: true }
);

/** The value contract of one boolean setting. */
export interface BooleanSettingValueSpec {
	readonly default: boolean;
}

/** The number-valued litellm-vscode-chat.* settings, keyed by their setting names. */
export const NUMBER_SETTING_SPECS = {
	"chat.timeout": { default: 300000, minimum: MIN_TIMEOUT_MS, nullable: false },
	// A tool count, not milliseconds.
	"chat.maxToolsPerRequest": { default: 128, minimum: 1, nullable: false, integer: true },
	"discovery.timeout": { default: 30000, minimum: MIN_TIMEOUT_MS, nullable: false },
	// A zero TTL is legal: it disables serving from the discovery cache.
	"discovery.cacheTtl": { default: 3600000, minimum: 0, nullable: false },
	// Zero is legal: it disables stale serving, so a failed silent refresh
	// serves the empty list immediately.
	"discovery.staleServeWindow": { default: 600000, minimum: 0, nullable: false },
	// Milliseconds like the other cadence settings. Zero is legal and disables
	// usage polling entirely (explicit refresh still works); negatives clamp
	// to it.
	"usage.pollInterval": { default: 300000, minimum: 0, nullable: false },
	// The first poll after activation: soon, but never on the activation path.
	"usage.initialRefreshDelay": { default: 5000, minimum: 0, nullable: false },
	// Long enough to coalesce settings.json keystroke bursts.
	"usage.serversChangeRefreshDelay": { default: 2000, minimum: 0, nullable: false },
	// Zero is legal: on-demand data then never counts as fresh, so the status
	// bar aggregates nothing.
	"usage.pollingOffFreshnessWindow": { default: 600000, minimum: 0, nullable: false },
} as const satisfies Record<string, NumberSettingValueSpec>;

export type NumberSettingId = keyof typeof NUMBER_SETTING_SPECS;

/**
 * Whether one number setting is integer-only. The single reader of the spec's
 * `integer` flag, so the settings getter's floor, the intent boundary's
 * refusal, and the drift guards all ask the same predicate.
 */
export function isIntegerSetting(id: NumberSettingId): boolean {
	const spec = NUMBER_SETTING_SPECS[id];
	return "integer" in spec && spec.integer === true;
}

/** The boolean litellm-vscode-chat.* settings, keyed by their setting names. */
export const BOOLEAN_SETTING_SPECS = {
	"chat.promptCaching": { default: true },
	"models.openRouterCatalog": { default: true },
	"ui.maskSecretInputs": { default: true },
} as const satisfies Record<string, BooleanSettingValueSpec>;

export type BooleanSettingId = keyof typeof BOOLEAN_SETTING_SPECS;

/**
 * The settings under the config section with no scalar spec: the object and
 * array settings plus the free and enum strings. Their value grammars live
 * with their readers; this list only names the keys.
 */
export const STRUCTURED_SETTING_KEYS = [
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
] as const;

/**
 * Every litellm-vscode-chat.* setting key. settingSpec.test.ts pins this list
 * against package.json's contributed configuration, so a future setting cannot
 * silently escape the surfaces that walk the whole vocabulary.
 */
export const ALL_SETTING_KEYS: readonly string[] = [
	...STRUCTURED_SETTING_KEYS,
	...Object.keys(NUMBER_SETTING_SPECS),
	...Object.keys(BOOLEAN_SETTING_SPECS),
];
