/**
 * The single source of truth for the extension's configuration section and
 * the value side of its scalar settings: key names, defaults, and minimums.
 * package.json's contributed configuration mirrors this table
 * (settingSpec.test.ts pins the mirror, docs numbers included), the
 * settings readers clamp against it, and the dashboard protocol layers its
 * presentation metadata on top. Pure constants: no vscode, no Node, no zod
 * (the dashboard protocol pulls this module into the webview bundle).
 */

/** The configuration section every litellm-vscode-chat.* setting lives under. */
export const CONFIG_SECTION = "litellm-vscode-chat";

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
	defaultMaxOutputTokens: { default: 16000, minimum: 1, nullable: false },
	defaultContextLength: { default: 128000, minimum: 1, nullable: false },
	defaultMaxInputTokens: { default: null, minimum: 1, nullable: true },
	requestTimeout: { default: 300000, minimum: MIN_TIMEOUT_MS, nullable: false },
	discoveryTimeout: { default: 30000, minimum: MIN_TIMEOUT_MS, nullable: false },
	// A zero TTL is legal: it disables serving from the discovery cache.
	discoveryCacheTtl: { default: 3600000, minimum: 0, nullable: false },
} as const satisfies Record<string, NumberSettingValueSpec>;

export type NumberSettingId = keyof typeof NUMBER_SETTING_SPECS;

/** The boolean litellm-vscode-chat.* settings, keyed by their setting names. */
export const BOOLEAN_SETTING_SPECS = {
	"promptCaching.enabled": { default: true },
	maskApiKeyInput: { default: true },
} as const satisfies Record<string, BooleanSettingValueSpec>;

export type BooleanSettingId = keyof typeof BOOLEAN_SETTING_SPECS;
