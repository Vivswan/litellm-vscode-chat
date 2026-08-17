/**
 * The single owner of the models.capabilities vocabulary and its precedence
 * walk. Pure, and everything out is serializable data (no Maps), so
 * registration and the dashboard's capability inspector share one
 * implementation and results ride the dashboard message protocol unchanged.
 *
 * The vocabulary is OPEN - the user is always right, it is their server.
 * CAPABILITY_FIELDS is the registration-typed core; CONSUMED_CAPABILITY_FIELDS
 * the kind-validated set the extension reads somewhere; every other
 * non-underscore key applies as-is through the same walk. Records are
 * matcher-keyed and combine through recordResolution.ts, entry result over
 * global field by field, and a `_fallback` field drops below the server level.
 */

import type { ModelRecordMap } from "./modelMatcher";
import type { ParsedRecord, RecordChainResolution, RecordDiagnostic, RecordLayer } from "./recordResolution";
import { INHERITABLE_DIRECTIVE, lintRecordMap, parseSharedDirectives, resolveRecordChain } from "./recordResolution";

/**
 * The registration-typed core, keyed by wire name (aligned with /model/info),
 * each with its value kind. These seven are total in every resolution result;
 * every other field resolves only where some level carries a value.
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

/** A capability value as configuration carries it: JSON-serializable (null included), so it rides the dashboard protocol. */
export type CapabilityJsonValue =
	| null
	| boolean
	| number
	| string
	| readonly CapabilityJsonValue[]
	| { readonly [key: string]: CapabilityJsonValue };

/**
 * The value kinds the consumed vocabulary validates: "number" is a positive
 * integer, "cost" a finite non-negative number (zero is how "free" is
 * written), "string-array" an array of non-empty strings (empty is valid).
 */
export type CapabilityValueKind = "number" | "boolean" | "cost" | "string-array";

/**
 * The kind-validated vocabulary: the core plus every capability key the
 * extension consumes somewhere. An invalid value is diagnosed and the field
 * stays unset so a lower level can win. Keys outside this set pass through.
 */
export const CONSUMED_CAPABILITY_FIELDS: Readonly<Record<string, CapabilityValueKind>> = {
	...CAPABILITY_FIELDS,
	input_cost_per_token: "cost",
	output_cost_per_token: "cost",
	cache_read_input_token_cost: "cost",
	cache_creation_input_token_cost: "cost",
	long_context_input_cost_per_token: "cost",
	long_context_output_cost_per_token: "cost",
	long_context_cache_read_input_token_cost: "cost",
	long_context_cache_creation_input_token_cost: "cost",
	supports_prompt_caching: "boolean",
	supports_pdf_input: "boolean",
	supports_response_schema: "boolean",
	supported_openai_params: "string-array",
	reasoning_effort_levels: "string-array",
};

function isCapabilityFieldName(key: string): key is CapabilityFieldName {
	return Object.hasOwn(CAPABILITY_FIELDS, key);
}

/**
 * The ONE typing verdict for the consumed vocabulary, shared by the resolver's
 * parse and the dashboard editors' live drafts so the two cannot drift.
 */
export function isValidConsumedCapabilityValue(kind: CapabilityValueKind, value: unknown): boolean {
	switch (kind) {
		case "number":
			return typeof value === "number" && Number.isInteger(value) && value > 0;
		case "cost":
			return typeof value === "number" && Number.isFinite(value) && value >= 0;
		case "boolean":
			return typeof value === "boolean";
		case "string-array":
			return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
	}
}

/**
 * The own-property read for the open field bags. They are plain objects, so a
 * field named "toString" or "constructor" must read as absent from a bag that
 * does not carry it, never as the inherited Object.prototype member.
 */
export function capabilityField<T>(bag: Readonly<Record<string, T | undefined>>, name: string): T | undefined {
	return Object.hasOwn(bag, name) ? bag[name] : undefined;
}

/** Names an OpenRouter catalog entry whose capabilities backfill fields the record leaves unset. */
export const OPENROUTER_MODEL_DIRECTIVE = "_openrouter_model";

/**
 * Demotes all (`true`) or the listed capability fields from override level to
 * fallback level: applied BELOW the server-reported value instead of above it.
 * The marking rides with each field wherever inheritance carries it.
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
	/** Every kept field: validly-typed consumed fields plus verbatim extras; invalid consumed values are diagnosed away. */
	readonly fields: Readonly<Record<string, CapabilityJsonValue>>;
	/** The `_openrouter_model` directive's catalog ID, when validly set. */
	readonly openrouterModel?: string | undefined;
}

/**
 * The one typing boundary of the capability vocabulary. A consumed field
 * validates per kind; an invalid value is diagnosed and stays unset, so a
 * lower precedence source's valid value can still win. Every other
 * non-underscore key is kept verbatim with an informational unrecognized-key
 * diagnostic - validation is advisory, never gating. `_openrouter_model` must
 * be a non-blank string; `_fallback` must be `true` (all kept fields), a list
 * of field names the record keeps, or `false`. `_force` is diagnosed as the
 * wrong record type; the shared inheritance directives parse in
 * recordResolution; other underscore keys are ignored without diagnosis
 * (forward compatibility), which also keeps a hostile own "__proto__" key out
 * of the field object (other prototype names like "toString" are legal open
 * fields, and every dynamic read downstream is hasOwn-guarded).
 */
export function parseCapabilityRecord(record: Readonly<Record<string, unknown>>): ParsedCapabilityRecord {
	// Field keys are TRIMMED at this parse boundary, matching the editor, which
	// judges and saves keys trimmed: a hand-padded key in settings.json means
	// the same field on every surface instead of a padded open field the editor
	// would silently rewrite on the next Apply. A trim collision resolves by
	// the record's object key order, the later spelling winning. The rule is
	// whole: the field-naming directives' list entries (`_fallback`,
	// `_inheritable`) trim too, so a padded entry still names its trimmed
	// field - `_inherit_from` entries stay raw, because they name MATCHER keys
	// and the matcher grammar trims nothing. Null-prototyped so a trimmed
	// "__proto__" defines an own key instead of walking the chain.
	const normalized: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
	for (const [rawKey, rawValue] of Object.entries(record)) {
		const key = rawKey.trim();
		normalized[key] =
			(key === FALLBACK_DIRECTIVE || key === INHERITABLE_DIRECTIVE) && Array.isArray(rawValue)
				? rawValue.map((entry) => (typeof entry === "string" ? entry.trim() : entry))
				: rawValue;
	}
	const fields: Record<string, CapabilityJsonValue> = {};
	let openrouterModel: string | undefined;
	const diagnostics: Omit<RecordDiagnostic, "recordKey">[] = [];

	for (const [key, value] of Object.entries(normalized)) {
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
		const kind = Object.hasOwn(CONSUMED_CAPABILITY_FIELDS, key) ? CONSUMED_CAPABILITY_FIELDS[key] : undefined;
		if (kind !== undefined) {
			if (isValidConsumedCapabilityValue(kind, value)) {
				// A cost of -0 would ride a negative sign into arithmetic; "free" is +0.
				fields[key] = kind === "cost" && value === 0 ? 0 : (value as CapabilityJsonValue);
			} else {
				diagnostics.push({ kind: "invalid-value", key });
			}
			continue;
		}
		// Settings values arrive from JSON, so anything present is serializable;
		// only an undefined (an in-memory caller's hole) is dropped.
		if (value !== undefined) {
			fields[key] = value as CapabilityJsonValue;
			diagnostics.push({ kind: "unrecognized-key", key });
		}
	}

	const fallback = new Set<string>();
	if (Object.hasOwn(normalized, FALLBACK_DIRECTIVE)) {
		const directive = normalized[FALLBACK_DIRECTIVE];
		if (directive === true) {
			for (const name of Object.keys(fields)) {
				fallback.add(name);
			}
		} else if (Array.isArray(directive)) {
			for (const name of directive) {
				if (typeof name === "string" && Object.hasOwn(fields, name)) {
					fallback.add(name);
				} else {
					diagnostics.push({ kind: "invalid-directive", key: FALLBACK_DIRECTIVE });
				}
			}
		} else if (directive !== false) {
			diagnostics.push({ kind: "invalid-directive", key: FALLBACK_DIRECTIVE });
		}
	}

	const shared = parseSharedDirectives(normalized, fields);
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
 * Record-level lint of a capability record map, independent of any model: it
 * reaches records no current model matches, which the per-model chain
 * resolution never visits. The caller attributes the layer.
 */
export function lintCapabilityRecords(records: ModelCapabilitiesRecord): readonly RecordDiagnostic[] {
	return lintRecordMap(records, (record) => parseCapabilityRecord(record));
}

/**
 * The evidence set as the advisory filter reads it: undefined when there is
 * none - no set at all, or an EMPTY one (a listing carrying no model_info says
 * nothing about the server's key vocabulary, and hinting against it would flag
 * every open field at once). Set-built because "__proto__" is a legal member a
 * raw object key would misread.
 */
export function observedEvidenceSet(observedKeys: readonly string[] | undefined): ReadonlySet<string> | undefined {
	return observedKeys === undefined || observedKeys.length === 0 ? undefined : new Set(observedKeys);
}

/**
 * Whether one unrecognized-key hint survives its evidence: the set is known
 * and names neither the key nor a consumed field. The consumed check is a
 * backstop, so a vocabulary drift cannot resurrect hints for keys the
 * extension reads.
 */
function unrecognizedKeyHintSurvives(key: string, observed: ReadonlySet<string> | undefined): boolean {
	return observed !== undefined && !observed.has(key) && !Object.hasOwn(CONSUMED_CAPABILITY_FIELDS, key);
}

/**
 * The kind-aware core of the advisory filter: unrecognized-key hints are
 * judged against the evidence the selector picks per diagnostic; every other
 * kind passes through untouched. Returns the input array itself when there is
 * nothing to judge, so callers can cheaply detect "unchanged".
 */
export function filterUnrecognizedKeys<T extends RecordDiagnostic>(
	diagnostics: readonly T[],
	evidenceFor: (diagnostic: T) => ReadonlySet<string> | undefined
): readonly T[] {
	if (!diagnostics.some((diagnostic) => diagnostic.kind === "unrecognized-key")) {
		return diagnostics;
	}
	return diagnostics.filter(
		(diagnostic) =>
			diagnostic.kind !== "unrecognized-key" || unrecognizedKeyHintSurvives(diagnostic.key, evidenceFor(diagnostic))
	);
}

/**
 * The advisory filter over capability-record unrecognized-key diagnostics: the
 * field APPLIES as-is, and the hint only says the key may be a typo. A hint
 * survives exactly when the observed /model/info key set is KNOWN, NON-EMPTY,
 * and names neither the key nor a consumed field; with no evidence there is
 * nothing to hint from, so every hint drops rather than crying wolf.
 */
export function filterUnrecognizedKeyDiagnostics<T extends RecordDiagnostic>(
	diagnostics: readonly T[],
	observedKeys: readonly string[] | undefined
): readonly T[] {
	const observed = observedEvidenceSet(observedKeys);
	return filterUnrecognizedKeys(diagnostics, () => observed);
}

/** A catalog answer: capability fields for the matched entry, or why there is none. */
export type CatalogLookupResult =
	| {
			readonly kind: "found";
			readonly id: string;
			readonly fields: Readonly<Partial<CapabilityFieldValues>>;
	  }
	| { readonly kind: "ambiguous" }
	| { readonly kind: "not-found" };

/**
 * The OpenRouter catalog as the resolver sees it: injected in-memory data,
 * never a file or the network. byExactId answers `_openrouter_model`
 * directives; byRawModelId the implicit lookup by the model's own ID (exact,
 * else unambiguous post-vendor suffix; ambiguity skips the level).
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
 * Where one effective capability value came from, precedence-ordered.
 */
export type CapabilityLevel =
	| CapabilityOverrideLevel
	| "server"
	| CapabilityFallbackLevel
	| "catalog"
	| "derived"
	| "floor";

/**
 * The walk's levels in precedence order, highest first - the ONE declaration
 * of that order, which resolveModelCapabilities' code must layer candidates
 * in. Consumers that rank levels derive from this list; the satisfies check
 * keeps it total, so adding a level fails compilation here too.
 */
export const CAPABILITY_LEVEL_ORDER: readonly CapabilityLevel[] = Object.keys({
	entry: true,
	global: true,
	directive: true,
	server: true,
	"entry-fallback": true,
	"global-fallback": true,
	catalog: true,
	derived: true,
	floor: true,
} satisfies Record<CapabilityLevel, true>) as CapabilityLevel[];

/** A lower-precedence level's value for a field some higher level won. */
export interface ShadowedCapabilityValue {
	readonly level: CapabilityLevel;
	/** The source record key (entry/global levels), or the catalog entry ID (directive/catalog). */
	readonly key?: string | undefined;
	readonly value: CapabilityJsonValue;
}

export interface ResolvedCapabilityOverrideField<V extends CapabilityJsonValue = CapabilityJsonValue> {
	readonly value: V;
	readonly level: CapabilityOverrideLevel;
	/** The record key whose literal field set it (entry/global) or the directive's catalog ID (directive). */
	readonly key: string;
	/** Present when the layer's winning record inherited the field; names the source record (== key). */
	readonly inheritedFrom?: string | undefined;
	/** Lower override levels that also set this field, highest first. */
	readonly shadowed: readonly ShadowedCapabilityValue[];
}

/** Every field some override level set, by wire name; absent fields set no override. */
export type ResolvedCapabilityOverrideFields = {
	readonly [key: string]: ResolvedCapabilityOverrideField | undefined;
};

/** One `_fallback`-demoted value, ready to slot into the walk below the server level. */
export interface CapabilityFallbackCandidate<V extends CapabilityJsonValue = CapabilityJsonValue> {
	readonly level: CapabilityFallbackLevel;
	/** The record key whose literal field carries the value. */
	readonly key: string;
	/** Present when the layer's winning record inherited the field; names the source record (== key). */
	readonly inheritedFrom?: string | undefined;
	readonly value: V;
}

/** Per field, the fallback candidates in precedence order (entry-fallback before global-fallback). */
export type ResolvedCapabilityFallbackFields = {
	readonly [key: string]: readonly CapabilityFallbackCandidate[] | undefined;
};

/** Whether the `_openrouter_model` directive found its catalog entry; not-found feeds the warning badge. */
export interface DirectiveOutcome {
	readonly kind: "applied" | "not-found";
	readonly id: string;
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
 * matching chain resolves through the shared inheritance walk, and the entry
 * result beats the global result field by field. A field its source record
 * marks `_fallback` leaves the override chain and comes back as a fallback
 * candidate; the two chains merge independently, so a global override still
 * beats an entry fallback. The `_openrouter_model` directive belongs to a
 * layer's WINNING record only (a directive is never inherited), the entry
 * winner's beating the global winner's; its catalog-derived fields fill only
 * fields no explicit override set.
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
				? { kind: "applied", id: directiveId }
				: { kind: "not-found", id: directiveId };
	const directiveFields: Readonly<Partial<CapabilityFieldValues>> =
		directiveLookup?.kind === "found" ? directiveLookup.fields : {};

	const layerField = (
		resolution: RecordChainResolution,
		name: string,
		wantFallback: boolean
	): { value: CapabilityJsonValue; key: string; inheritedFrom?: string } | undefined => {
		const field = resolution.fields.get(name);
		if (field === undefined || field.fallback !== wantFallback) {
			return undefined;
		}
		return {
			// The chain carries only parseCapabilityRecord output, so the value is
			// already a kept capability value.
			value: field.value as CapabilityJsonValue,
			key: field.sourceKey,
			...(resolution.winnerKey !== undefined && field.sourceKey !== resolution.winnerKey
				? { inheritedFrom: field.sourceKey }
				: {}),
		};
	};

	const overrideField = (name: string): ResolvedCapabilityOverrideField | undefined => {
		const layered: {
			level: CapabilityOverrideLevel;
			key: string;
			inheritedFrom?: string;
			value: CapabilityJsonValue;
		}[] = [];
		const fromEntry = layerField(entry, name, false);
		if (fromEntry !== undefined) {
			layered.push({ level: "entry", ...fromEntry });
		}
		const fromGlobal = layerField(global, name, false);
		if (fromGlobal !== undefined) {
			layered.push({ level: "global", ...fromGlobal });
		}
		const derivedValue = isCapabilityFieldName(name) ? directiveFields[name] : undefined;
		if (derivedValue !== undefined && directiveId !== undefined) {
			layered.push({ level: "directive", key: directiveId, value: derivedValue });
		}
		const [winner, ...shadowed] = layered;
		return winner === undefined ? undefined : { ...winner, shadowed };
	};

	const fallbackField = (name: string): readonly CapabilityFallbackCandidate[] | undefined => {
		const candidates: CapabilityFallbackCandidate[] = [];
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

	const names = new Set<string>([...entry.fields.keys(), ...global.fields.keys(), ...Object.keys(directiveFields)]);
	const fields: Record<string, ResolvedCapabilityOverrideField> = {};
	const fallbackFields: Record<string, readonly CapabilityFallbackCandidate[]> = {};
	for (const name of names) {
		const override = overrideField(name);
		if (override !== undefined) {
			fields[name] = override;
		}
		const fallback = fallbackField(name);
		if (fallback !== undefined) {
			fallbackFields[name] = fallback;
		}
	}

	return {
		fields,
		fallbackFields,
		...(directive !== undefined ? { directive } : {}),
		implicitCatalog: catalog.byRawModelId(rawModelId),
		diagnostics,
	};
}

/**
 * The typed server-reported capability values the walk may read: the core
 * fields plus the consumed vocabulary's wire keys, as discovery maps them
 * from /model/info.
 */
export type ServerCapabilityValues = CapabilityFieldValues & {
	readonly input_cost_per_token: number;
	readonly output_cost_per_token: number;
	readonly cache_read_input_token_cost: number;
	readonly cache_creation_input_token_cost: number;
	readonly long_context_input_cost_per_token: number;
	readonly long_context_output_cost_per_token: number;
	readonly long_context_cache_read_input_token_cost: number;
	readonly long_context_cache_creation_input_token_cost: number;
	readonly supports_prompt_caching: boolean;
	readonly supports_pdf_input: boolean;
	readonly supports_response_schema: boolean;
	readonly supported_openai_params: readonly string[];
	readonly reasoning_effort_levels: readonly string[];
};

/**
 * Registration's post-aggregation baseline for one model: the conservative
 * merged values exactly as the deployment merge produced them, plus
 * output-limit declaredness (the every-contributor rule), which controls only
 * whether the output limit counts as "provider". Declared models have no
 * server side at all, so the discriminant makes a missing baseline
 * unrepresentable rather than silently empty.
 */
export type ServerDeclaredCapabilities =
	| {
			readonly kind: "discovered";
			readonly values: Readonly<Partial<ServerCapabilityValues>>;
			readonly outputDeclared: boolean;
	  }
	| { readonly kind: "declared" };

export const FLOOR_CONTEXT_LENGTH = 128000;
export const FLOOR_MAX_OUTPUT_TOKENS = 16000;

/**
 * The built-in backstop of the walk. max_input_tokens has no floor - the
 * context-minus-output derivation is its backstop, and it is total because
 * both inputs are. Only the core fields have floors; every other field
 * resolves open (absent when no level carries it).
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
 * Provenance of the effective max output tokens. "user" (an override or a
 * `_fallback` fill) and "provider" (server-declared by every contributor) are
 * sent uncapped; "defaults" keeps the request path's min(4096, limit) clamp,
 * because a guessed limit must not escape it.
 */
export type EffectiveOutputLimitSource = "user" | "provider" | "defaults";

export interface EffectiveCapabilityField<V extends CapabilityJsonValue = CapabilityJsonValue> {
	readonly value: V;
	readonly level: CapabilityLevel;
	/** The source record key (entry/global/fallback) or catalog entry ID (directive/catalog); absent elsewhere. */
	readonly key?: string | undefined;
	/** Present when the level's winning record inherited the field; names the source record (== key). */
	readonly inheritedFrom?: string | undefined;
	/** Every lower level that also carried a value, highest first; floor and derived never shadow. */
	readonly shadowed: readonly ShadowedCapabilityValue[];
}

/**
 * The core fields, total by construction, plus every non-core field some level
 * carried. A plain object, so a dynamic read by an arbitrary open name must be
 * own-property guarded: a bare index read of an unset prototype name like
 * "valueOf" would surface the inherited Object.prototype member.
 */
export type EffectiveCapabilityFields = {
	readonly [K in CapabilityFieldName]: EffectiveCapabilityField<CapabilityFieldValue<K>>;
} & { readonly [key: string]: EffectiveCapabilityField | undefined };

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

interface LevelCandidate {
	readonly level: CapabilityLevel;
	readonly key?: string | undefined;
	readonly inheritedFrom?: string | undefined;
	readonly value: CapabilityJsonValue;
}

/** The walk's per-field core: override wins, else the highest lower candidate; undefined when nothing carries a value. */
function resolveField(
	override: ResolvedCapabilityOverrideField | undefined,
	lower: readonly LevelCandidate[]
): EffectiveCapabilityField | undefined {
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
		return undefined;
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
 * Total over CapabilityLevel on purpose: a level added to the walk fails
 * compilation here instead of silently resolving to "defaults" and regaining
 * the wire clamp. The directive level is deliberately NOT user-set - an
 * `_openrouter_model` output limit is still the catalog's guess, so both
 * catalog paths keep the clamp.
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
 * The one function every consumer calls: the full precedence walk, per field,
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
 * The core fields are total (level 8 backstops them); every other field
 * resolves through the same walk with no backstop, so a field no level carries
 * is simply absent. The directive and implicit catalog levels carry core
 * fields only, by construction of the catalog mapping.
 *
 * Levels 1-2 and 5-6 count as user-declared output limits ("user"); the
 * server level is "provider" only under the every-contributor declaredness
 * rule; every other level - both catalog paths included - stays "defaults"
 * so guessed limits keep the wire clamp.
 */
export function resolveModelCapabilities(input: ResolveModelCapabilitiesInput): EffectiveCapabilities {
	const overrides = resolveCapabilityOverrides(input);
	const serverValues: Readonly<Record<string, CapabilityJsonValue | undefined>> =
		input.serverDeclared.kind === "discovered" ? input.serverDeclared.values : {};
	const catalogMatch = overrides.implicitCatalog.kind === "found" ? overrides.implicitCatalog : undefined;

	const fromServer = (name: string): LevelCandidate[] => {
		const value = capabilityField(serverValues, name);
		return value !== undefined ? [{ level: "server", value }] : [];
	};
	const fromFallback = (name: string): LevelCandidate[] => [...(capabilityField(overrides.fallbackFields, name) ?? [])];
	const fromCatalog = (name: string): LevelCandidate[] => {
		const value = catalogMatch !== undefined && isCapabilityFieldName(name) ? catalogMatch.fields[name] : undefined;
		return value !== undefined && catalogMatch !== undefined ? [{ level: "catalog", key: catalogMatch.id, value }] : [];
	};
	const lowerFor = (name: string): LevelCandidate[] => [
		...fromServer(name),
		...fromFallback(name),
		...fromCatalog(name),
	];
	// Every level that feeds a core field is kind-validated at its source, so
	// narrowing the open walk's result to the field's declared kind is safe.
	const coreField = <K extends CapabilityFieldName>(
		name: K,
		backstop: { readonly level: "derived" | "floor"; readonly value: CapabilityFieldValue<K> }
	): EffectiveCapabilityField<CapabilityFieldValue<K>> =>
		(resolveField(capabilityField(overrides.fields, name), lowerFor(name)) ?? {
			value: backstop.value,
			level: backstop.level,
			shadowed: [],
		}) as EffectiveCapabilityField<CapabilityFieldValue<K>>;

	const contextLength = coreField("context_length", { level: "floor", value: CAPABILITY_FLOOR.context_length });
	const maxOutputTokens = coreField("max_output_tokens", { level: "floor", value: CAPABILITY_FLOOR.max_output_tokens });
	const maxInputTokens = coreField("max_input_tokens", {
		level: "derived",
		value: Math.max(1, contextLength.value - maxOutputTokens.value),
	});
	const booleanField = (name: BooleanCapabilityField): EffectiveCapabilityField<boolean> =>
		coreField(name, { level: "floor", value: CAPABILITY_FLOOR[name] });

	const outputLevel = maxOutputTokens.level;
	const outputLimitSource: EffectiveOutputLimitSource = LEVEL_IS_USER_SET[outputLevel]
		? "user"
		: outputLevel === "server" && input.serverDeclared.kind === "discovered" && input.serverDeclared.outputDeclared
			? "provider"
			: "defaults";

	const fields: Record<string, EffectiveCapabilityField> = {
		context_length: contextLength,
		max_input_tokens: maxInputTokens,
		max_output_tokens: maxOutputTokens,
		supports_function_calling: booleanField("supports_function_calling"),
		supports_vision: booleanField("supports_vision"),
		supports_reasoning: booleanField("supports_reasoning"),
		supports_audio_input: booleanField("supports_audio_input"),
	};
	// Underscore names are skipped like the parse skips them, which keeps a
	// hostile own "__proto__" key in a server baseline out of the result object.
	const openNames = new Set<string>([
		...Object.keys(overrides.fields),
		...Object.keys(overrides.fallbackFields),
		...Object.keys(serverValues),
	]);
	for (const name of openNames) {
		if (isCapabilityFieldName(name) || name.startsWith("_")) {
			continue;
		}
		const resolved = resolveField(capabilityField(overrides.fields, name), lowerFor(name));
		if (resolved !== undefined) {
			fields[name] = resolved;
		}
	}

	return {
		fields: fields as EffectiveCapabilityFields,
		outputLimitSource,
		...(overrides.directive !== undefined ? { directive: overrides.directive } : {}),
		diagnostics: overrides.diagnostics,
	};
}
