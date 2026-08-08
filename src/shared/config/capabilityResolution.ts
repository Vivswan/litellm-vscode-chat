/**
 * The single owner of the models.capabilities vocabulary, its precedence
 * walk, and the `_openrouter_model`/`_fallback` directives. Pure
 * (no vscode, no DOM, no Node) on purpose: the provider's registration path
 * patches attached models through resolveModelCapabilities, and the
 * dashboard's capability inspector renders its projection through the
 * protocol module's re-exports - one implementation, so the inspector cannot
 * drift from what registration serves. Everything out is serializable data
 * (records and arrays, no Maps), so results ride the dashboard message
 * protocol unchanged.
 *
 * Unlike models.parameters (an open pass-through), capabilities are a closed
 * vocabulary: parseCapabilityRecord is the one boundary where keys and value
 * types are enforced, so everything downstream handles typed fields and
 * diagnostics instead of re-checking raw records. Records are keyed by the
 * shared matcher grammar and combine through the shared inheritance walk
 * (recordResolution.ts); each layer resolves its own chain, then the entry
 * result beats the global result field by field. A record's `_fallback`
 * directive demotes all or the listed fields from override level (above
 * server) to fallback level (below server), the flag riding from each
 * field's source record wherever inheritance carries it.
 */

import type { ModelRecordMap } from "./modelMatcher";
import type { ParsedRecord, RecordChainResolution, RecordDiagnostic, RecordLayer } from "./recordResolution";
import { lintRecordMap, parseSharedDirectives, resolveRecordChain } from "./recordResolution";

/**
 * The closed capability vocabulary, keyed by wire name (aligned with
 * /model/info), each with its value kind. Unknown non-underscore keys in a
 * capability record are diagnosed, not passed through; unknown underscore
 * keys are reserved for future directives and ignored silently.
 */
export const CAPABILITY_FIELDS = {
	context_length: "number",
	max_input_tokens: "number",
	max_output_tokens: "number",
	supports_function_calling: "boolean",
	supports_vision: "boolean",
	supports_reasoning: "boolean",
	supports_audio_input: "boolean",
} as const;

export type CapabilityFieldName = keyof typeof CAPABILITY_FIELDS;

export type NumberCapabilityField = {
	[K in CapabilityFieldName]: (typeof CAPABILITY_FIELDS)[K] extends "number" ? K : never;
}[CapabilityFieldName];

export type BooleanCapabilityField = Exclude<CapabilityFieldName, NumberCapabilityField>;

type CapabilityFieldValue<K extends CapabilityFieldName> = (typeof CAPABILITY_FIELDS)[K] extends "number"
	? number
	: boolean;

/** A total capability assignment; Partial<CapabilityFieldValues> is the parsed shape of one record. */
export type CapabilityFieldValues = { readonly [K in CapabilityFieldName]: CapabilityFieldValue<K> };

function isCapabilityFieldName(key: string): key is CapabilityFieldName {
	return Object.hasOwn(CAPABILITY_FIELDS, key);
}

function isNumberCapabilityField(name: CapabilityFieldName): name is NumberCapabilityField {
	return CAPABILITY_FIELDS[name] === "number";
}

/** Names an OpenRouter catalog entry whose capabilities backfill fields the record leaves unset. */
export const OPENROUTER_MODEL_DIRECTIVE = "_openrouter_model";

/**
 * Demotes all (`true`) or the listed capability fields of its record from
 * override level to fallback level: applied BELOW the server-reported value
 * instead of above it (fill-when-missing semantics). The marking rides with
 * each field wherever inheritance carries it.
 */
export const FALLBACK_DIRECTIVE = "_fallback";

/** The parameters-record directive, known here only to diagnose it as the wrong record type. */
const FORCE_DIRECTIVE_WRONG_TYPE = "_force";

/** A models.capabilities record map: matcher key to capability fields and directives. */
export type ModelCapabilitiesRecord = ModelRecordMap;

/** "entry" is the declared server entry's own record map; "global" the models.capabilities setting. */
type CapabilityConfigLayer = RecordLayer;

/** A record diagnostic attributed to its configuration layer; see RecordDiagnostic for kinds and keys. */
export interface CapabilityDiagnostic extends RecordDiagnostic {
	readonly layer: CapabilityConfigLayer;
}
export interface ParsedCapabilityRecord extends ParsedRecord {
	/** The validly typed capability fields; invalid and unknown keys are diagnosed away. */
	readonly fields: Readonly<Partial<CapabilityFieldValues>>;
	/** The `_openrouter_model` directive's catalog ID, when validly set. */
	readonly openrouterModel?: string | undefined;
}

/**
 * The one enforcement boundary of the capability vocabulary. A number field
 * accepts positive integers only; a boolean field accepts booleans only;
 * anything else is an invalid-value diagnostic and the field stays unset, so
 * a lower precedence source's valid value can still win. `_openrouter_model`
 * must be a non-blank string. `_fallback` must be `true` (all of the record's
 * valid fields), a list of field names the record validly sets (anything
 * else in the list is an invalid-directive diagnostic), or `false`. `_force`
 * belongs to parameters records and is diagnosed as the wrong record type;
 * the shared `_inheritable`/`_inherit_from` directives parse in
 * recordResolution; other underscore keys are ignored without diagnosis
 * (forward compatibility). Model declaration is not a directive: an entry's
 * `discovery.declared` list is the one way to create a model discovery
 * cannot list.
 */
export function parseCapabilityRecord(record: Readonly<Record<string, unknown>>): ParsedCapabilityRecord {
	const numbers: { -readonly [K in NumberCapabilityField]?: number } = {};
	const booleans: { -readonly [K in BooleanCapabilityField]?: boolean } = {};
	let openrouterModel: string | undefined;
	const diagnostics: Omit<RecordDiagnostic, "recordKey">[] = [];

	for (const [key, value] of Object.entries(record)) {
		if (key === OPENROUTER_MODEL_DIRECTIVE) {
			if (typeof value === "string" && value.trim() !== "") {
				openrouterModel = value;
			} else {
				diagnostics.push({ kind: "invalid-directive", key });
			}
			continue;
		}
		if (key === FORCE_DIRECTIVE_WRONG_TYPE) {
			diagnostics.push({ kind: "wrong-record-type", key });
			continue;
		}
		if (key.startsWith("_")) {
			continue;
		}
		if (!isCapabilityFieldName(key)) {
			diagnostics.push({ kind: "unknown-key", key });
			continue;
		}
		if (isNumberCapabilityField(key)) {
			if (typeof value === "number" && Number.isInteger(value) && value > 0) {
				numbers[key] = value;
			} else {
				diagnostics.push({ kind: "invalid-value", key });
			}
		} else if (typeof value === "boolean") {
			booleans[key] = value;
		} else {
			diagnostics.push({ kind: "invalid-value", key });
		}
	}

	const fields = { ...numbers, ...booleans };
	const fallback = new Set<string>();
	if (Object.hasOwn(record, FALLBACK_DIRECTIVE)) {
		const directive = record[FALLBACK_DIRECTIVE];
		if (directive === true) {
			for (const name of Object.keys(fields)) {
				fallback.add(name);
			}
		} else if (Array.isArray(directive)) {
			for (const name of directive) {
				if (typeof name === "string" && isCapabilityFieldName(name) && Object.hasOwn(fields, name)) {
					fallback.add(name);
				} else {
					diagnostics.push({ kind: "invalid-directive", key: FALLBACK_DIRECTIVE });
				}
			}
		} else if (directive !== false) {
			diagnostics.push({ kind: "invalid-directive", key: FALLBACK_DIRECTIVE });
		}
	}

	const shared = parseSharedDirectives(record, fields);
	diagnostics.push(...shared.diagnostics);

	return {
		fields,
		inheritable: shared.inheritable,
		forced: new Set(),
		fallback,
		inheritFrom: shared.inheritFrom,
		...(openrouterModel !== undefined ? { openrouterModel } : {}),
		diagnostics,
	};
}

/** Resolve one layer's capability record map for a model through the shared chain walk. */
export function resolveCapabilityLayer(rawModelId: string, records: ModelCapabilitiesRecord): RecordChainResolution {
	return resolveRecordChain(rawModelId, records, (record) => parseCapabilityRecord(record));
}

/**
 * Record-level lint of a capability record map, independent of any model:
 * invalid matchers, unknown fields, invalid values, malformed directives, and
 * `_inherit_from` entries naming keys the map does not hold (see
 * lintParameterRecords for why the per-model chain resolution cannot cover
 * this); the caller attributes the layer.
 */
export function lintCapabilityRecords(records: ModelCapabilitiesRecord): readonly RecordDiagnostic[] {
	return lintRecordMap(records, (record) => parseCapabilityRecord(record));
}

/**
 * Catalog pricing in the wire vocabulary (USD per token, matching LiteLLM's
 * cost keys). The resolver never touches it - it rides the lookup result so
 * consumers can apply the pricing precedence: server-reported pricing beats
 * directive-derived pricing beats implicit-match pricing.
 */
export interface CatalogPricing {
	readonly input_cost_per_token?: number | undefined;
	readonly output_cost_per_token?: number | undefined;
}

/** A catalog answer: capability fields (and any pricing) for the matched entry, or why there is none. */
export type CatalogLookupResult =
	| {
			readonly kind: "found";
			readonly id: string;
			readonly fields: Readonly<Partial<CapabilityFieldValues>>;
			readonly pricing?: CatalogPricing | undefined;
	  }
	| { readonly kind: "ambiguous" }
	| { readonly kind: "not-found" };

/**
 * The OpenRouter catalog as the resolver sees it: injected in-memory data,
 * never a file or the network. byExactId answers `_openrouter_model`
 * directives; byRawModelId answers the implicit low-precedence lookup by the
 * model's own ID (exact, else unambiguous post-vendor suffix - ambiguity is
 * the implementation's call and skips the level).
 */
export interface CapabilityCatalogLookup {
	byExactId(id: string): CatalogLookupResult;
	byRawModelId(rawId: string): CatalogLookupResult;
}

/** The missing-catalog default: answers not-found so every catalog level skips. */
export const EMPTY_CATALOG_LOOKUP: CapabilityCatalogLookup = {
	byExactId: () => ({ kind: "not-found" }),
	byRawModelId: () => ({ kind: "not-found" }),
};

/** The override levels above the server-reported value. */
export type CapabilityOverrideLevel = "entry" | "global" | "directive";

/** The `_fallback`-demoted levels: user-set values that apply only where the server reports nothing. */
export type CapabilityFallbackLevel = "entry-fallback" | "global-fallback";

/**
 * Where one effective capability value came from, precedence-ordered:
 * entry and global explicit fields, `_openrouter_model`-derived fields, the
 * server-reported value, `_fallback`-demoted entry and global fields, the
 * implicit catalog match, the context-minus-output derivation (only
 * max_input_tokens), and the built-in floor.
 */
export type CapabilityLevel =
	| CapabilityOverrideLevel
	| "server"
	| CapabilityFallbackLevel
	| "catalog"
	| "derived"
	| "floor";

/** A lower-precedence level's value for a field some higher level won. */
export interface ShadowedCapabilityValue {
	readonly level: CapabilityLevel;
	/** The source record key (entry/global levels), or the catalog entry ID (directive/catalog). */
	readonly key?: string | undefined;
	readonly value: number | boolean;
}

export interface ResolvedCapabilityOverrideField<V extends number | boolean> {
	readonly value: V;
	readonly level: CapabilityOverrideLevel;
	/** The record key whose literal field set it (entry/global) or the directive's catalog ID (directive). */
	readonly key: string;
	/** Present when the layer's winning record inherited the field; names the source record (== key). */
	readonly inheritedFrom?: string | undefined;
	/** Lower override levels that also set this field, highest first. */
	readonly shadowed: readonly ShadowedCapabilityValue[];
}

export type ResolvedCapabilityOverrideFields = {
	readonly [K in CapabilityFieldName]?: ResolvedCapabilityOverrideField<CapabilityFieldValue<K>> | undefined;
};

/** One `_fallback`-demoted value, ready to slot into the walk below the server level. */
export interface CapabilityFallbackCandidate<V extends number | boolean> {
	readonly level: CapabilityFallbackLevel;
	/** The record key whose literal field carries the value. */
	readonly key: string;
	/** Present when the layer's winning record inherited the field; names the source record (== key). */
	readonly inheritedFrom?: string | undefined;
	readonly value: V;
}

/** Per field, the fallback candidates in precedence order (entry-fallback before global-fallback). */
export type ResolvedCapabilityFallbackFields = {
	readonly [K in CapabilityFieldName]?: readonly CapabilityFallbackCandidate<CapabilityFieldValue<K>>[] | undefined;
};

/** Whether the `_openrouter_model` directive found its catalog entry; not-found feeds the warning badge. */
export interface DirectiveOutcome {
	readonly kind: "applied" | "not-found";
	readonly id: string;
	/** The applied entry's catalog pricing, when it carries one. */
	readonly pricing?: CatalogPricing | undefined;
}

export interface ResolveCapabilityOverridesInput {
	readonly rawModelId: string;
	/** The models.capabilities setting as normalizeModelCapabilities returns it. */
	readonly globalCapabilities: ModelCapabilitiesRecord;
	/** The declared server entry's own capability records, when one matched. */
	readonly entryCapabilities?: ModelCapabilitiesRecord | undefined;
	readonly catalog: CapabilityCatalogLookup;
}

export interface ResolvedCapabilityOverrides {
	readonly fields: ResolvedCapabilityOverrideFields;
	/** The `_fallback`-demoted fields, applied below the server level in the walk. */
	readonly fallbackFields: ResolvedCapabilityFallbackFields;
	/** Present exactly when a winning record carried `_openrouter_model`. */
	readonly directive?: DirectiveOutcome | undefined;
	/** The implicit catalog lookup by the model's own raw ID, for the walk's catalog level. */
	readonly implicitCatalog: CatalogLookupResult;
	/** Field and `_openrouter_model` problems in the matching records. */
	readonly diagnostics: readonly CapabilityDiagnostic[];
}

/**
 * Resolve the user-set capability overrides for one model: each layer's
 * matching chain resolves through the shared inheritance walk
 * (recordResolution.ts), and the entry result beats the global result field
 * by field. A field its source record marks `_fallback` leaves the override
 * chain and comes back as a fallback candidate (below server in the walk),
 * the marking riding wherever inheritance carries the field; the two chains
 * merge independently, so a global override still beats an entry fallback.
 * The `_openrouter_model` directive belongs to a layer's WINNING record only
 * (a directive is never inherited, and a more specific match shadows a
 * broader record's), the entry winner's beating the global winner's; its
 * catalog-derived fields fill only fields no explicit override set.
 */
export function resolveCapabilityOverrides(input: ResolveCapabilityOverridesInput): ResolvedCapabilityOverrides {
	const { rawModelId, globalCapabilities, entryCapabilities, catalog } = input;

	const entry = resolveCapabilityLayer(rawModelId, entryCapabilities ?? {});
	const global = resolveCapabilityLayer(rawModelId, globalCapabilities);

	const entryWinner = entry.winner as ParsedCapabilityRecord | undefined;
	const globalWinner = global.winner as ParsedCapabilityRecord | undefined;
	const directiveId = entryWinner?.openrouterModel ?? globalWinner?.openrouterModel;
	const directiveLookup = directiveId !== undefined ? catalog.byExactId(directiveId) : undefined;
	const directive: DirectiveOutcome | undefined =
		directiveId === undefined
			? undefined
			: directiveLookup?.kind === "found"
				? {
						kind: "applied",
						id: directiveId,
						...(directiveLookup.pricing !== undefined ? { pricing: directiveLookup.pricing } : {}),
					}
				: { kind: "not-found", id: directiveId };
	const directiveFields: Readonly<Partial<CapabilityFieldValues>> =
		directiveLookup?.kind === "found" ? directiveLookup.fields : {};

	const layerField = <K extends CapabilityFieldName>(
		resolution: RecordChainResolution,
		name: K,
		wantFallback: boolean
	): { value: CapabilityFieldValue<K>; key: string; inheritedFrom?: string } | undefined => {
		const field = resolution.fields.get(name);
		if (field === undefined || field.fallback !== wantFallback) {
			return undefined;
		}
		return {
			// The chain carries only parseCapabilityRecord output, so the value is
			// already vocabulary-typed for its field name.
			value: field.value as CapabilityFieldValue<K>,
			key: field.sourceKey,
			...(resolution.winnerKey !== undefined && field.sourceKey !== resolution.winnerKey
				? { inheritedFrom: field.sourceKey }
				: {}),
		};
	};

	const overrideField = <K extends CapabilityFieldName>(
		name: K
	): ResolvedCapabilityOverrideField<CapabilityFieldValue<K>> | undefined => {
		const layered: {
			level: CapabilityOverrideLevel;
			key: string;
			inheritedFrom?: string;
			value: CapabilityFieldValue<K>;
		}[] = [];
		const fromEntry = layerField(entry, name, false);
		if (fromEntry !== undefined) {
			layered.push({ level: "entry", ...fromEntry });
		}
		const fromGlobal = layerField(global, name, false);
		if (fromGlobal !== undefined) {
			layered.push({ level: "global", ...fromGlobal });
		}
		const derivedValue = directiveFields[name];
		if (derivedValue !== undefined && directiveId !== undefined) {
			layered.push({ level: "directive", key: directiveId, value: derivedValue });
		}
		const [winner, ...shadowed] = layered;
		return winner === undefined ? undefined : { ...winner, shadowed };
	};

	const fallbackField = <K extends CapabilityFieldName>(
		name: K
	): readonly CapabilityFallbackCandidate<CapabilityFieldValue<K>>[] | undefined => {
		const candidates: CapabilityFallbackCandidate<CapabilityFieldValue<K>>[] = [];
		const fromEntry = layerField(entry, name, true);
		if (fromEntry !== undefined) {
			candidates.push({ level: "entry-fallback", ...fromEntry });
		}
		const fromGlobal = layerField(global, name, true);
		if (fromGlobal !== undefined) {
			candidates.push({ level: "global-fallback", ...fromGlobal });
		}
		return candidates.length > 0 ? candidates : undefined;
	};

	const diagnostics: CapabilityDiagnostic[] = [
		...entry.diagnostics.map((d) => ({ ...d, layer: "entry" as const })),
		...global.diagnostics.map((d) => ({ ...d, layer: "global" as const })),
	];

	return {
		fields: {
			context_length: overrideField("context_length"),
			max_input_tokens: overrideField("max_input_tokens"),
			max_output_tokens: overrideField("max_output_tokens"),
			supports_function_calling: overrideField("supports_function_calling"),
			supports_vision: overrideField("supports_vision"),
			supports_reasoning: overrideField("supports_reasoning"),
			supports_audio_input: overrideField("supports_audio_input"),
		},
		fallbackFields: {
			context_length: fallbackField("context_length"),
			max_input_tokens: fallbackField("max_input_tokens"),
			max_output_tokens: fallbackField("max_output_tokens"),
			supports_function_calling: fallbackField("supports_function_calling"),
			supports_vision: fallbackField("supports_vision"),
			supports_reasoning: fallbackField("supports_reasoning"),
			supports_audio_input: fallbackField("supports_audio_input"),
		},
		...(directive !== undefined ? { directive } : {}),
		implicitCatalog: catalog.byRawModelId(rawModelId),
		diagnostics,
	};
}

/**
 * Registration's post-aggregation baseline for one model: the conservative
 * merged values exactly as the deployment merge produced them (present
 * whenever any contributor reported the field), plus output-limit
 * declaredness (the every-contributor rule), which controls only whether the
 * output limit counts as "provider". Declared models (an entry's
 * `discovery.declared` list) have no server side
 * at all, so the discriminant makes a missing baseline unrepresentable
 * rather than silently empty.
 */
export type ServerDeclaredCapabilities =
	| {
			readonly kind: "discovered";
			readonly values: Readonly<Partial<CapabilityFieldValues>>;
			readonly outputDeclared: boolean;
	  }
	| { readonly kind: "declared" };

/**
 * The built-in floor totals as literals, exported for every consumer of the
 * two numbers (pure and webview-safe).
 */
export const FLOOR_CONTEXT_LENGTH = 128000;
export const FLOOR_MAX_OUTPUT_TOKENS = 16000;

/**
 * The built-in backstop of the walk: tools on, vision/audio/reasoning off,
 * and the floor totals for the two numbers. max_input_tokens has no floor -
 * the context-minus-output derivation is its backstop, and it is total
 * because both inputs are.
 */
export const CAPABILITY_FLOOR: Readonly<Omit<CapabilityFieldValues, "max_input_tokens">> = {
	context_length: FLOOR_CONTEXT_LENGTH,
	max_output_tokens: FLOOR_MAX_OUTPUT_TOKENS,
	supports_function_calling: true,
	supports_vision: false,
	supports_reasoning: false,
	supports_audio_input: false,
};

/**
 * Provenance of the effective max output tokens. "user" (a value the user
 * wrote: an entry or global override, or a `_fallback` fill) and "provider"
 * (server-declared by every contributor) are sent uncapped; "defaults"
 * keeps the request path's min(4096, limit) clamp, because a guessed limit
 * must not escape it.
 */
export type EffectiveOutputLimitSource = "user" | "provider" | "defaults";

export interface EffectiveCapabilityField<V extends number | boolean> {
	readonly value: V;
	readonly level: CapabilityLevel;
	/** The source record key (entry/global/fallback) or catalog entry ID (directive/catalog); absent elsewhere. */
	readonly key?: string | undefined;
	/** Present when the level's winning record inherited the field; names the source record (== key). */
	readonly inheritedFrom?: string | undefined;
	/** Every lower level that also carried a value, highest first; floor and derived never shadow. */
	readonly shadowed: readonly ShadowedCapabilityValue[];
}

/** Total by construction: every capability field resolves to a value at some level. */
export type EffectiveCapabilityFields = {
	readonly [K in CapabilityFieldName]: EffectiveCapabilityField<CapabilityFieldValue<K>>;
};

export interface ResolveModelCapabilitiesInput extends ResolveCapabilityOverridesInput {
	readonly serverDeclared: ServerDeclaredCapabilities;
}

export interface EffectiveCapabilities {
	readonly fields: EffectiveCapabilityFields;
	readonly outputLimitSource: EffectiveOutputLimitSource;
	/** See ResolvedCapabilityOverrides.directive. */
	readonly directive?: DirectiveOutcome | undefined;
	readonly diagnostics: readonly CapabilityDiagnostic[];
}

interface LevelCandidate<V extends number | boolean> {
	readonly level: CapabilityLevel;
	readonly key?: string | undefined;
	readonly inheritedFrom?: string | undefined;
	readonly value: V;
}

function resolveField<V extends number | boolean>(
	override: ResolvedCapabilityOverrideField<V> | undefined,
	lower: readonly LevelCandidate<V>[],
	backstop: { readonly level: "derived" | "floor"; readonly value: V }
): EffectiveCapabilityField<V> {
	if (override !== undefined) {
		return {
			value: override.value,
			level: override.level,
			key: override.key,
			...(override.inheritedFrom !== undefined ? { inheritedFrom: override.inheritedFrom } : {}),
			shadowed: [...override.shadowed, ...lower],
		};
	}
	const [winner, ...shadowed] = lower;
	if (winner === undefined) {
		return { value: backstop.value, level: backstop.level, shadowed: [] };
	}
	return {
		value: winner.value,
		level: winner.level,
		...(winner.key !== undefined ? { key: winner.key } : {}),
		...(winner.inheritedFrom !== undefined ? { inheritedFrom: winner.inheritedFrom } : {}),
		shadowed,
	};
}

/**
 * Whether a level's value counts as user-set for output-limit provenance.
 * Total over CapabilityLevel on purpose, like capabilityOverrides'
 * LEVEL_TRIGGERS_REBUILD: a level added to the walk fails compilation here
 * instead of silently resolving to "defaults" and regaining the wire clamp.
 * The directive level is deliberately NOT user-set: an `_openrouter_model`
 * output limit is still the catalog's guess about the model, so both
 * catalog paths keep the wire clamp - only values the user wrote, and
 * limits the server declared, lift it.
 */
const LEVEL_IS_USER_SET: Readonly<Record<CapabilityLevel, boolean>> = {
	entry: true,
	global: true,
	directive: false,
	server: false,
	"entry-fallback": true,
	"global-fallback": true,
	catalog: false,
	derived: false,
	floor: false,
};

/**
 * The one function every consumer calls: the full precedence walk over the
 * user-set overrides, the server-reported baseline, the `_fallback`-demoted
 * fields, the implicit catalog match, and the built-in floor - per field,
 * top wins:
 *
 *  1. explicit field in the entry chain's resolved view
 *  2. explicit field in the global chain's resolved view
 *  3. field derived from `_openrouter_model`
 *  4. server-reported value (skipped for declared models)
 *  5. `_fallback`-marked field from the entry chain
 *  6. `_fallback`-marked field from the global chain
 *  7. implicit catalog lookup by the model's own raw ID
 *  8. built-in floor; max_input_tokens instead derives
 *     max(1, context - output) from the effective values
 *
 * Levels 1-2 and 5-6 count as user-declared output limits ("user"); the
 * server level is "provider" only under the every-contributor declaredness
 * rule; every other level - both catalog paths included - stays "defaults"
 * so guessed limits keep the wire clamp.
 */
export function resolveModelCapabilities(input: ResolveModelCapabilitiesInput): EffectiveCapabilities {
	const overrides = resolveCapabilityOverrides(input);
	const serverValues: Readonly<Partial<CapabilityFieldValues>> =
		input.serverDeclared.kind === "discovered" ? input.serverDeclared.values : {};
	const catalogMatch = overrides.implicitCatalog.kind === "found" ? overrides.implicitCatalog : undefined;

	const fromServer = <K extends CapabilityFieldName>(name: K): LevelCandidate<CapabilityFieldValue<K>>[] => {
		const value = serverValues[name];
		return value !== undefined ? [{ level: "server", value }] : [];
	};
	const fromFallback = <K extends CapabilityFieldName>(name: K): LevelCandidate<CapabilityFieldValue<K>>[] => [
		...(overrides.fallbackFields[name] ?? []),
	];
	const fromCatalog = <K extends CapabilityFieldName>(name: K): LevelCandidate<CapabilityFieldValue<K>>[] => {
		const value = catalogMatch?.fields[name];
		return value !== undefined && catalogMatch !== undefined ? [{ level: "catalog", key: catalogMatch.id, value }] : [];
	};

	const contextLength = resolveField(
		overrides.fields.context_length,
		[...fromServer("context_length"), ...fromFallback("context_length"), ...fromCatalog("context_length")],
		{ level: "floor", value: CAPABILITY_FLOOR.context_length }
	);
	const maxOutputTokens = resolveField(
		overrides.fields.max_output_tokens,
		[...fromServer("max_output_tokens"), ...fromFallback("max_output_tokens"), ...fromCatalog("max_output_tokens")],
		{ level: "floor", value: CAPABILITY_FLOOR.max_output_tokens }
	);
	const maxInputTokens = resolveField(
		overrides.fields.max_input_tokens,
		[...fromServer("max_input_tokens"), ...fromFallback("max_input_tokens"), ...fromCatalog("max_input_tokens")],
		{ level: "derived", value: Math.max(1, contextLength.value - maxOutputTokens.value) }
	);
	const booleanField = (name: BooleanCapabilityField): EffectiveCapabilityField<boolean> =>
		resolveField(overrides.fields[name], [...fromServer(name), ...fromFallback(name), ...fromCatalog(name)], {
			level: "floor",
			value: CAPABILITY_FLOOR[name],
		});

	const outputLevel = maxOutputTokens.level;
	const outputLimitSource: EffectiveOutputLimitSource = LEVEL_IS_USER_SET[outputLevel]
		? "user"
		: outputLevel === "server" && input.serverDeclared.kind === "discovered" && input.serverDeclared.outputDeclared
			? "provider"
			: "defaults";

	return {
		fields: {
			context_length: contextLength,
			max_input_tokens: maxInputTokens,
			max_output_tokens: maxOutputTokens,
			supports_function_calling: booleanField("supports_function_calling"),
			supports_vision: booleanField("supports_vision"),
			supports_reasoning: booleanField("supports_reasoning"),
			supports_audio_input: booleanField("supports_audio_input"),
		},
		outputLimitSource,
		...(overrides.directive !== undefined ? { directive: overrides.directive } : {}),
		diagnostics: overrides.diagnostics,
	};
}
