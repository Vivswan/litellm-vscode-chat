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
export const INLINE_COMPLETIONS_LANGUAGE_FILTER_SETTING_KEY = "inlineCompletions.languageFilter";
export const COMMIT_GENERATION_PROMPT_SETTING_KEY = "commitGeneration.prompt";

/**
 * The features that pick their model through an explicit `<feature>.model`
 * setting. Every one is opt-in and fail-closed: the enabled boolean without a
 * model ref keeps the feature inert. quickFix and reviewComments are
 * registered vocabulary ahead of their features shipping - their settings
 * exist and persist, and nothing consumes them yet.
 */
export const FEATURE_MODEL_IDS = [
	"inlineCompletions",
	"commitGeneration",
	"prGeneration",
	"consultTool",
	"quickFix",
	"reviewComments",
] as const;

export type FeatureModelId = (typeof FEATURE_MODEL_IDS)[number];

/**
 * Every feature with an enable setting: the model-picking features plus the
 * chat participant, which uses the chat request's own model and so has no
 * model key. The one FeatureId vocabulary the per-layer tables (settings keys,
 * dashboard descriptors, diagnostics flags, contribution pins) key on.
 */
export const FEATURE_IDS = [...FEATURE_MODEL_IDS, "chatParticipant"] as const;

export type FeatureId = (typeof FEATURE_IDS)[number];

/** Whether a feature picks its model through a `<feature>.model` setting (vs the participant's request model). */
export function isFeatureModelId(feature: FeatureId): feature is FeatureModelId {
	return (FEATURE_MODEL_IDS as readonly FeatureId[]).includes(feature);
}

/**
 * A feature's explicit model choice: a `servers` entry's label (the same
 * identity the sync engine and usage resolution address entries by) plus the
 * raw model ID that server serves. Never auto-picked; null/unset means the
 * feature stays idle.
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

/** The model setting keys as a list, in FEATURE_MODEL_IDS order, for the surfaces that spread the whole family. */
export const FEATURE_MODEL_SETTING_KEY_LIST: readonly FeatureModelSettingKey[] = FEATURE_MODEL_IDS.map(
	(feature) => FEATURE_MODEL_SETTING_KEYS[feature]
);

/**
 * The inline-completions language filter's mode vocabulary: "block" runs
 * completions everywhere except the listed languages, "allow" runs them only
 * there.
 */
export const LANGUAGE_FILTER_MODES = ["block", "allow"] as const;

export type LanguageFilterMode = (typeof LANGUAGE_FILTER_MODES)[number];

/**
 * The inlineCompletions.languageFilter value: one mode plus exact VS Code
 * language IDs (no globs). Block mode with the empty list filters nothing;
 * allow mode with the empty list runs completions nowhere.
 */
export interface InlineLanguageFilter {
	readonly mode: LanguageFilterMode;
	readonly languages: readonly string[];
}

/** The default filter: block nothing, so completions run everywhere. */
export const DEFAULT_INLINE_LANGUAGE_FILTER: InlineLanguageFilter = { mode: "block", languages: [] };

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
	// The model-picking features are opt-in by contract: disabled means zero
	// registration and zero traffic, and enabling without a model ref stays
	// inert. quickFix and reviewComments are registered vocabulary for features
	// that have not shipped yet (the settings persist; nothing consumes them).
	"inlineCompletions.enabled": { default: false },
	"commitGeneration.enabled": { default: false },
	"prGeneration.enabled": { default: false },
	"consultTool.enabled": { default: false },
	"quickFix.enabled": { default: false },
	"reviewComments.enabled": { default: false },
	// The participant is on by default: it costs nothing until invoked and uses
	// the chat request's own model, so it has no model key.
	"chatParticipant.enabled": { default: true },
} as const satisfies Record<string, BooleanSettingValueSpec>;

export type BooleanSettingId = keyof typeof BOOLEAN_SETTING_SPECS;

/**
 * Each feature's enable setting key: the one map the settings getter, the
 * diagnostics flags, and the dashboard's feature rows address the boolean
 * through. Typed against BooleanSettingId, so a feature cannot name an enable
 * key the manifest and specs do not carry.
 */
export const FEATURE_ENABLE_SETTING_KEYS = {
	inlineCompletions: "inlineCompletions.enabled",
	commitGeneration: "commitGeneration.enabled",
	prGeneration: "prGeneration.enabled",
	consultTool: "consultTool.enabled",
	quickFix: "quickFix.enabled",
	reviewComments: "reviewComments.enabled",
	chatParticipant: "chatParticipant.enabled",
} as const satisfies Record<FeatureId, BooleanSettingId>;

/**
 * Whether one number is a usable usage.alertThresholds value: finite, in
 * (0, 1]. The single statement of the bound - the dashboard's list normalizer,
 * the settings reader, the intent boundary's refusal, and the editor's parser
 * all ask this predicate.
 */
export function isUsableThreshold(value: number): boolean {
	return Number.isFinite(value) && value > 0 && value <= 1;
}

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
	...FEATURE_MODEL_SETTING_KEY_LIST,
	INLINE_COMPLETIONS_LANGUAGE_FILTER_SETTING_KEY,
	COMMIT_GENERATION_PROMPT_SETTING_KEY,
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
