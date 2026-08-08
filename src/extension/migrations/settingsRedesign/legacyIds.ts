/**
 * QUARANTINE: every pre-redesign setting id, entry field id, and directive
 * name lives here and in this migration's own tests - no other module may
 * name them. The new-name targets are re-declared here as literals on
 * purpose: the migration must keep working (and keep compiling) while the
 * settings shell around it is rewritten, and the ids are pinned against the
 * docs rename table by the test suite.
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
 * The removed default* token trio with each setting's target capability
 * field and placement in the models.capabilities "*" record: the two
 * below-server settings ride `_fallback`, the input limit (which beat the
 * server-reported value) stays a plain override.
 */
export const REMOVED_TOKEN_DEFAULTS = [
	{ id: "defaultContextLength", field: "context_length", placement: "fallback" },
	{ id: "defaultMaxInputTokens", field: "max_input_tokens", placement: "override" },
	{ id: "defaultMaxOutputTokens", field: "max_output_tokens", placement: "fallback" },
] as const;

/** The servers setting keeps its id; its entries are restructured in place. */
export const SERVERS_ID = "servers";

/**
 * The flat per-entry credential fields of the pre-redesign entry shape,
 * restructured into the entry's `auth` object.
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
 * Every flat field the restructure consumes: the credential fields plus the
 * per-entry records and expectedFailures, which move under `models` and
 * `discovery`. An entry carrying any of these is old-world.
 */
export const LEGACY_ENTRY_FIELD_IDS = [
	...LEGACY_ENTRY_AUTH_FIELD_IDS,
	"modelParameters",
	"modelCapabilities",
	"expectedFailures",
] as const;

/**
 * The removed `_declare` capability directive: an exact-ID record key opting
 * into existing without discovery. Its readings move into the owning entry's
 * `discovery.declared` list.
 */
export const DECLARE_DIRECTIVE = "_declare";

/**
 * The capability vocabulary and the unforceable-key rule as the OLD parsers
 * applied them, quarantined with the rest of the legacy identifiers: the
 * migration expands a `true` directive into the names that directive really
 * marked at the time it was written, so it can never mint a name the old
 * world skipped (and the diagnostic that would come with it). Declared here
 * rather than imported so the redesign's own resolvers can be rewritten
 * without silently changing what an old config meant.
 */
const CAPABILITY_FIELD_TYPES: Readonly<Record<string, "number" | "boolean">> = {
	context_length: "number",
	max_input_tokens: "number",
	max_output_tokens: "number",
	supports_function_calling: "boolean",
	supports_vision: "boolean",
	supports_reasoning: "boolean",
	supports_audio_input: "boolean",
};

/** Whether one key/value pair is a capability field the old parser accepted (and could therefore mark). */
export function isValidCapabilityField(name: string, value: unknown): boolean {
	const type = CAPABILITY_FIELD_TYPES[name];
	if (type === "number") {
		return typeof value === "number" && Number.isInteger(value) && value > 0;
	}
	return type === "boolean" && typeof value === "boolean";
}

/** The request fields the extension owns; `_force` refused them (and underscore keys) as unforceable. */
const PROVIDER_OWNED_KEYS: ReadonlySet<string> = new Set([
	"model",
	"messages",
	"stream",
	"stream_options",
	"max_tokens",
	"tools",
	"tool_choice",
]);

/** Whether one parameter key was forceable under the old `_force` rules. */
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
