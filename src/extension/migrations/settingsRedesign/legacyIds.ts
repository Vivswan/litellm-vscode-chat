/**
 *   the migration must keep working (and keep compiling) while the settings shell around it is rewritten
 *     -> The new-name targets are re-declared here as literals on purpose
 */

/** Old scalar setting id -> its renamed id, values carried verbatim. */
export const LEGACY_SCALAR_RENAMES = [
	{ oldId: "requestTimeout", newId: "chat.timeout" },
	{ oldId: "promptCaching.enabled", newId: "chat.promptCaching" },
	{ oldId: "discoveryTimeout", newId: "discovery.timeout" },
	{ oldId: "discoveryCacheTtl", newId: "discovery.cacheTtl" },
	{ oldId: "openRouterCatalog.enabled", newId: "models.openRouterCatalog" },
	{ oldId: "maskApiKeyInput", newId: "ui.maskSecretInputs" },
] as const;

/** The record settings' rename pair, transformed (not just moved) on the way. */
export const LEGACY_MODEL_PARAMETERS_ID = "modelParameters";
export const LEGACY_MODEL_CAPABILITIES_ID = "modelCapabilities";
export const NEW_MODEL_PARAMETERS_ID = "models.parameters";
export const NEW_MODEL_CAPABILITIES_ID = "models.capabilities";

/** The removed global headers setting; its value moves into the entries. */
export const LEGACY_HEADERS_ID = "headers";

/**
 * The removed default* token trio with each setting's target capability field and placement in the models.capabilities
 * "*" record: the two below-server settings ride `_fallback`, the input limit (which beat the server-reported value)
 * stays a plain override.
 */
export const REMOVED_TOKEN_DEFAULTS = [
	{ id: "defaultContextLength", field: "context_length", placement: "fallback" },
	{ id: "defaultMaxInputTokens", field: "max_input_tokens", placement: "override" },
	{ id: "defaultMaxOutputTokens", field: "max_output_tokens", placement: "fallback" },
] as const;

/** The servers setting keeps its id; its entries are restructured in place. */
export const SERVERS_ID = "servers";

/**
 * The flat per-entry credential fields of the pre-redesign entry shape, restructured into the entry's `auth` object.
 */
export const LEGACY_ENTRY_AUTH_FIELD_IDS = [
	"apiKey",
	"oauthTokenUrl",
	"oauthClientId",
	"oauthClientSecret",
	"oauthScopes",
	"virtualKeyHeader",
	"virtualKeyValue",
] as const;

export type LegacyEntryAuthFieldId = (typeof LEGACY_ENTRY_AUTH_FIELD_IDS)[number];

/**
 * Every flat field the restructure consumes: the credential fields plus the per-entry records and expectedFailures,
 * which move under `models` and `discovery`. An entry carrying any of these is old-world.
 */
export const LEGACY_ENTRY_FIELD_IDS = [
	...LEGACY_ENTRY_AUTH_FIELD_IDS,
	"modelParameters",
	"modelCapabilities",
	"expectedFailures",
] as const;

/** The removed `_declare` capability directive: an exact-ID record key opting into existing without discovery. */
export const DECLARE_DIRECTIVE = "_declare";

/**
 * The unforceable-key rule as the OLD `_force` parser applied it, quarantined with the rest of the legacy identifiers:
 * records.ts rewrites a migrated `_force` to the names it really forced when written, so the move can never newly force
 * max_tokens (which the live grammar allows). Declared here rather than imported so the live rule can move without
 * silently changing what an old config meant.
 */
const PROVIDER_OWNED_KEYS: ReadonlySet<string> = new Set([
	"model",
	"messages",
	"stream",
	"stream_options",
	"max_tokens",
	"tools",
	"tool_choice",
]);

export function isForceableKey(key: string): boolean {
	return !key.startsWith("_") && !PROVIDER_OWNED_KEYS.has(key);
}

/** Every legacy setting id whose workspace-layer values the migration counts but never rewrites. */
export const LEGACY_SETTING_IDS: readonly string[] = [
	...LEGACY_SCALAR_RENAMES.map((rename) => rename.oldId),
	LEGACY_MODEL_PARAMETERS_ID,
	LEGACY_MODEL_CAPABILITIES_ID,
	LEGACY_HEADERS_ID,
	...REMOVED_TOKEN_DEFAULTS.map((source) => source.id),
];
