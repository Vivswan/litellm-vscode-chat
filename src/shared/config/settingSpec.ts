/**
 * The single source of truth for the extension's configuration section, the
 * value side of its scalar settings (key names, defaults, and minimums), and
 * the object settings' key names. package.json's contributed configuration
 * mirrors this table (settingSpec.test.ts pins the mirror, docs numbers
 * included), the settings readers clamp against it, and the dashboard
 * protocol layers its presentation metadata on top. Pure constants: no
 * vscode, no Node, no zod (the dashboard protocol pulls this module into the
 * webview bundle, and the dev launcher loads it outside the host).
 */

/** The configuration section every litellm-vscode-chat.* setting lives under. */
export const CONFIG_SECTION = "litellm-vscode-chat";

/**
 * The object settings' keys under the config section. They have no scalar
 * spec; their readers (shared/config/settings.ts, the server sync engine,
 * the dashboard's editors, and the dev launcher's profile inspection) share
 * the key names through these constants, and settingSpec.test.ts pins the
 * package.json contributions against them.
 */
export const MODEL_CAPABILITIES_SETTING_KEY = "models.capabilities";
export const MODEL_PARAMETERS_SETTING_KEY = "models.parameters";
export const SERVERS_SETTING_KEY = "servers";
export const USAGE_ALERT_THRESHOLDS_SETTING_KEY = "usage.alertThresholds";
export const USAGE_STATUS_BAR_SETTING_KEY = "usage.statusBar";

/** The floor both timeout settings clamp to; sub-second timeouts would abort requests before they leave. */
export const MIN_TIMEOUT_MS = 1000;

/**
 * The value contract of one number setting, exactly what package.json
 * declares for it. Nullable settings may default to null ("unset, derive
 * it"); non-nullable ones always carry a number.
 */
export type NumberSettingValueSpec =
	| { readonly default: number; readonly minimum: number; readonly nullable: false }
	| { readonly default: number | null; readonly minimum: number; readonly nullable: true };

/** The value contract of one boolean setting. */
export interface BooleanSettingValueSpec {
	readonly default: boolean;
}

/** The number-valued litellm-vscode-chat.* settings, keyed by their setting names. */
export const NUMBER_SETTING_SPECS = {
	"chat.timeout": { default: 300000, minimum: MIN_TIMEOUT_MS, nullable: false },
	"discovery.timeout": { default: 30000, minimum: MIN_TIMEOUT_MS, nullable: false },
	// A zero TTL is legal: it disables serving from the discovery cache.
	"discovery.cacheTtl": { default: 3600000, minimum: 0, nullable: false },
	// Milliseconds like the other cadence settings. Zero is legal and disables
	// usage polling entirely (explicit refresh still works); negatives clamp
	// to it.
	"usage.pollInterval": { default: 300000, minimum: 0, nullable: false },
} as const satisfies Record<string, NumberSettingValueSpec>;

export type NumberSettingId = keyof typeof NUMBER_SETTING_SPECS;

/** The boolean litellm-vscode-chat.* settings, keyed by their setting names. */
export const BOOLEAN_SETTING_SPECS = {
	"chat.promptCaching": { default: true },
	"models.openRouterCatalog": { default: true },
	"ui.maskSecretInputs": { default: true },
} as const satisfies Record<string, BooleanSettingValueSpec>;

export type BooleanSettingId = keyof typeof BOOLEAN_SETTING_SPECS;

/**
 * The settings under the config section with no scalar spec: the object and
 * array settings plus the enum-string usage.statusBar. Their value grammars
 * live with their readers; this list only names the keys.
 */
export const STRUCTURED_SETTING_KEYS = [
	SERVERS_SETTING_KEY,
	MODEL_PARAMETERS_SETTING_KEY,
	MODEL_CAPABILITIES_SETTING_KEY,
	USAGE_ALERT_THRESHOLDS_SETTING_KEY,
	USAGE_STATUS_BAR_SETTING_KEY,
] as const;

/**
 * Every litellm-vscode-chat.* setting key: the structured settings plus the
 * scalar-spec'd number and boolean settings. settingSpec.test.ts pins this
 * list against package.json's contributed configuration properties, so a
 * future setting cannot silently escape the surfaces that walk the whole
 * vocabulary (the settings export walks exactly this list).
 */
export const ALL_SETTING_KEYS: readonly string[] = [
	...STRUCTURED_SETTING_KEYS,
	...Object.keys(NUMBER_SETTING_SPECS),
	...Object.keys(BOOLEAN_SETTING_SPECS),
];
