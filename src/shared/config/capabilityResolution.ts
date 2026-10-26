/**
 * The single owner of the models.capabilities vocabulary and its precedence walk.
 *
 *   The vocabulary is OPEN                                            -> the user is always right, it is their server
 *   Records are matcher-keyed and combine through recordResolution.ts -> entry result over global field by field
 *   a `_fallback` field                                                -> drops below the server level
 */

import { trimHttpWhitespace } from "../util/headers";
import type { ModelRecordMap } from "./modelMatcher";
import { DEFAULT_MAX_TOKENS_CAP } from "./parameterResolution";
import type { ParsedRecord, RecordChainResolution, RecordDiagnostic, RecordLayer } from "./recordResolution";
import {
	canonicalFieldKey,
	FALLBACK_DIRECTIVE,
	INHERITABLE_DIRECTIVE,
	lintRecordMap,
	OPENROUTER_MODEL_DIRECTIVE,
	parseMarkingDirective,
	parseSharedDirectives,
	resolveRecordChain,
	wrongTypeDirectives,
} from "./recordResolution";

/** The core, keyed by wire name (as /model/info spells them) with its value kind; total in every resolution result. */
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

/**
 * The value kinds the consumed vocabulary validates: "number" is a positive integer, "cost" a finite non-negative
 * number (zero is how "free" is written), "string-array" an array of non-empty strings (empty is valid).
 */
export type CapabilityValueKind = "number" | "boolean" | "cost" | "string-array";

type ValueOfKind<Kind extends CapabilityValueKind> = Kind extends "number" | "cost"
	? number
	: Kind extends "boolean"
		? boolean
		: readonly string[];

type CapabilityFieldValue<K extends CapabilityFieldName> = ValueOfKind<(typeof CAPABILITY_FIELDS)[K]>;

export type CapabilityFieldValues = { readonly [K in CapabilityFieldName]: CapabilityFieldValue<K> };

/**
 * A capability value as configuration carries it: JSON-serializable (null included), so it rides the dashboard
 * protocol.
 */
export type CapabilityJsonValue =
	| null
	| boolean
	| number
	| string
	| readonly CapabilityJsonValue[]
	| { readonly [key: string]: CapabilityJsonValue };

/** An invalid value is diagnosed and the field stays unset so a lower level can win. */
export const CONSUMED_CAPABILITY_FIELDS = {
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
	replay_reasoning_content: "boolean",
	supported_openai_params: "string-array",
	reasoning_effort_levels: "string-array",
} as const satisfies Record<string, CapabilityValueKind>;

export type ConsumedCapabilityField = keyof typeof CONSUMED_CAPABILITY_FIELDS;

export type ConsumedFieldOfKind<Kind extends CapabilityValueKind> = {
	[K in ConsumedCapabilityField]: (typeof CONSUMED_CAPABILITY_FIELDS)[K] extends Kind ? K : never;
}[ConsumedCapabilityField];

/**
 * The per-token cost fields. Registration's pricing, the walk's server level, and both dashboard pricing surfaces
 * key on this union, so a cost field exists exactly once: as a "cost" entry of the consumed vocabulary.
 */
export type CostCapabilityField = ConsumedFieldOfKind<"cost">;

export function consumedFieldsOfKind<Kind extends CapabilityValueKind>(kind: Kind): ConsumedFieldOfKind<Kind>[] {
	return (Object.keys(CONSUMED_CAPABILITY_FIELDS) as ConsumedCapabilityField[]).filter(
		(name): name is ConsumedFieldOfKind<Kind> => CONSUMED_CAPABILITY_FIELDS[name] === kind
	);
}

/** The consumed vocabulary's kind for a key, own-property guarded ("toString" is a legal open field name). */
export function consumedFieldKind(key: string): CapabilityValueKind | undefined {
	return Object.hasOwn(CONSUMED_CAPABILITY_FIELDS, key)
		? CONSUMED_CAPABILITY_FIELDS[key as ConsumedCapabilityField]
		: undefined;
}

function isCapabilityFieldName(key: string): key is CapabilityFieldName {
	return Object.hasOwn(CAPABILITY_FIELDS, key);
}

/**
 * The ONE typing verdict for the consumed vocabulary, shared by the resolver's parse and the dashboard editors' live
 * drafts so the two cannot drift.
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
 * The own-property read for the open field bags. They are plain objects, so a field named "toString" or "constructor"
 * must read as absent from a bag that does not carry it, never as the inherited Object.prototype member.
 */
export function capabilityField<T>(bag: Readonly<Record<string, T | undefined>>, name: string): T | undefined {
	return Object.hasOwn(bag, name) ? bag[name] : undefined;
}

const WRONG_TYPE_DIRECTIVES: ReadonlySet<string> = new Set(wrongTypeDirectives("capabilities"));

export type ModelCapabilitiesRecord = ModelRecordMap;

type CapabilityConfigLayer = RecordLayer;

export interface CapabilityDiagnostic extends RecordDiagnostic {
	readonly layer: CapabilityConfigLayer;
}

/** A capability record's parse; `openrouterModel` is the `_openrouter_model` directive's catalog ID when valid. */
export interface ParsedCapabilityRecord extends ParsedRecord {
	readonly fields: Readonly<Record<string, CapabilityJsonValue>>;
	readonly openrouterModel?: string | undefined;
}

/** A marking-list entry in canonical spelling; a non-string entry is left as is for the directive parse to diagnose. */
function canonicalListEntry(entry: unknown): unknown {
	return typeof entry === "string" ? canonicalFieldKey("capabilities", entry) : entry;
}

/**
 * The record with every key, and every `_fallback` and `_inheritable` list entry, in canonical spelling.
 * Null-prototyped so a trimmed "__proto__" defines an own key instead of walking the chain. `_inherit_from` entries
 * stay raw: they name MATCHER keys, and the matcher grammar trims nothing.
 */
function canonicalCapabilityRecord(record: Readonly<Record<string, unknown>>): Record<string, unknown> {
	const normalized: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
	for (const [rawKey, rawValue] of Object.entries(record)) {
		const key = canonicalFieldKey("capabilities", rawKey);
		if ((key === FALLBACK_DIRECTIVE || key === INHERITABLE_DIRECTIVE) && Array.isArray(rawValue)) {
			normalized[key] = rawValue.map(canonicalListEntry);
			continue;
		}
		normalized[key] = rawValue;
	}
	return normalized;
}

/**
 * One field into the bag: a consumed key must pass its kind (diagnosed and left unset otherwise), an open key is kept
 * as-is with a hint. Settings values arrive from JSON, so anything present is serializable; only an undefined (an
 * in-memory caller's hole) is dropped.
 */
function readCapabilityField(
	key: string,
	value: unknown,
	fields: Record<string, CapabilityJsonValue>,
	diagnostics: Omit<RecordDiagnostic, "recordKey">[]
): void {
	const kind = consumedFieldKind(key);
	if (kind === undefined) {
		if (value !== undefined) {
			fields[key] = value as CapabilityJsonValue;
			diagnostics.push({ kind: "unrecognized-key", key });
		}
		return;
	}

	if (!isValidConsumedCapabilityValue(kind, value)) {
		diagnostics.push({ kind: "invalid-value", key });
		return;
	}

	// A cost of -0 would ride a negative sign into arithmetic; "free" is +0.
	fields[key] = kind === "cost" && value === 0 ? 0 : (value as CapabilityJsonValue);
}

/**
 * The one typing boundary of the capability vocabulary.
 * Every dynamic read downstream is hasOwn-guarded, so prototype names like "toString" are legal open fields.
 *
 *   consumed field, invalid value -> diagnosed and left unset, so a lower-precedence source's valid value can still
 *                                    win
 *   unknown underscore key        -> silently ignored for forward compatibility, which also keeps a hostile own
 *                                    "__proto__" out
 */
export function parseCapabilityRecord(record: Readonly<Record<string, unknown>>): ParsedCapabilityRecord {
	const normalized = canonicalCapabilityRecord(record);
	const fields: Record<string, CapabilityJsonValue> = {};
	let openrouterModel: string | undefined;
	const diagnostics: Omit<RecordDiagnostic, "recordKey">[] = [];

	for (const [key, value] of Object.entries(normalized)) {
		if (key === OPENROUTER_MODEL_DIRECTIVE) {
			if (typeof value === "string" && trimHttpWhitespace(value) !== "") {
				openrouterModel = value;
			} else {
				diagnostics.push({ kind: "invalid-directive", key });
			}
			continue;
		}
		if (WRONG_TYPE_DIRECTIVES.has(key)) {
			diagnostics.push({ kind: "wrong-record-type", key });
			continue;
		}
		if (key.startsWith("_")) {
			continue;
		}
		readCapabilityField(key, value, fields, diagnostics);
	}

	const fallback = parseMarkingDirective(normalized, FALLBACK_DIRECTIVE, fields);
	diagnostics.push(...fallback.diagnostics);

	const shared = parseSharedDirectives(normalized, fields);
	diagnostics.push(...shared.diagnostics);

	return {
		fields,
		inheritable: shared.inheritable,
		forced: new Set(),
		fallback: fallback.marked,
		inheritFrom: shared.inheritFrom,
		...(openrouterModel === undefined ? {} : { openrouterModel }),
		diagnostics,
	};
}

export function resolveCapabilityLayer(rawModelId: string, records: ModelCapabilitiesRecord): RecordChainResolution {
	return resolveRecordChain(rawModelId, records, (record) => parseCapabilityRecord(record));
}

export function lintCapabilityRecords(records: ModelCapabilitiesRecord): readonly RecordDiagnostic[] {
	return lintRecordMap(records, (record) => parseCapabilityRecord(record));
}

/**
 * The evidence set as the advisory filter reads it: undefined when there is none - no set at all, or an EMPTY one (a
 * listing carrying no model_info says nothing about the server's key vocabulary, and hinting against it would flag
 * every open field at once). Set-built because "__proto__" is a legal member a raw object key would misread.
 */
export function observedEvidenceSet(observedKeys: readonly string[] | undefined): ReadonlySet<string> | undefined {
	return observedKeys === undefined || observedKeys.length === 0 ? undefined : new Set(observedKeys);
}

/** The consumed check is a backstop, so a vocabulary drift cannot resurrect hints for keys the extension reads. */
function unrecognizedKeyHintSurvives(key: string, observed: ReadonlySet<string> | undefined): boolean {
	return observed !== undefined && !observed.has(key) && consumedFieldKind(key) === undefined;
}

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
 * The advisory filter over capability-record unrecognized-key diagnostics: the field APPLIES as-is, and the hint only
 * says the key may be a typo. With no evidence there is nothing to hint from, so every hint drops rather than crying
 * wolf.
 */
export function filterUnrecognizedKeyDiagnostics<T extends RecordDiagnostic>(
	diagnostics: readonly T[],
	observedKeys: readonly string[] | undefined
): readonly T[] {
	const observed = observedEvidenceSet(observedKeys);
	return filterUnrecognizedKeys(diagnostics, () => observed);
}

export type CatalogLookupResult =
	| {
			readonly kind: "found";
			readonly id: string;
			readonly fields: Readonly<Partial<CapabilityFieldValues>>;
	  }
	| { readonly kind: "ambiguous" }
	| { readonly kind: "not-found" };

/**
 * The OpenRouter catalog as the resolver sees it: injected in-memory data, never a file or the network.
 * byExactId answers `_openrouter_model` directives; byRawModelId the implicit lookup by the model's own ID (exact, else
 * unambiguous post-vendor suffix; ambiguity skips the level).
 */
export interface CapabilityCatalogLookup {
	byExactId(id: string): CatalogLookupResult;
	byRawModelId(rawId: string): CatalogLookupResult;
}

export const EMPTY_CATALOG_LOOKUP: CapabilityCatalogLookup = {
	byExactId: () => ({ kind: "not-found" }),
	byRawModelId: () => ({ kind: "not-found" }),
};

/** The override levels above the server-reported value. */
export type CapabilityOverrideLevel = "entry" | "global" | "directive";

/** The `_fallback`-demoted levels: user-set values that apply only where the server reports nothing. */
export type CapabilityFallbackLevel = "entry-fallback" | "global-fallback";

export type CapabilityLevel =
	| CapabilityOverrideLevel
	| "server"
	| CapabilityFallbackLevel
	| "catalog"
	| "derived"
	| "floor";

/** The levels in precedence order, highest first; resolveModelCapabilities' candidates and every ranker follow it. */
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

/**
 * A lower-precedence level's value for a field some higher level won; `key` is the source record key (entry/global
 * levels) or the catalog entry ID (directive/catalog).
 */
export interface ShadowedCapabilityValue {
	readonly level: CapabilityLevel;
	readonly key?: string | undefined;
	readonly value: CapabilityJsonValue;
}

export interface ResolvedCapabilityOverrideField<V extends CapabilityJsonValue = CapabilityJsonValue> {
	/** The winning override's value; consumed fields are kind-validated at the parse, open fields pass as written. */
	readonly value: V;

	/** The override level that won: entry over global over directive. */
	readonly level: CapabilityOverrideLevel;

	/** The record key whose literal field set it (entry/global) or the directive's catalog ID (directive). */
	readonly key: string;

	/** Present when the layer's winning record inherited the field from `key`; names that winning record. */
	readonly inheritedBy?: string | undefined;

	/** Lower override levels that also set this field, highest first. */
	readonly shadowed: readonly ShadowedCapabilityValue[];
}

export type ResolvedCapabilityOverrideFields = {
	readonly [key: string]: ResolvedCapabilityOverrideField | undefined;
};

/** One `_fallback`-demoted value, ready to slot into the walk below the server level. */
export interface CapabilityFallbackCandidate<V extends CapabilityJsonValue = CapabilityJsonValue> {
	/** entry-fallback over global-fallback, both below the server level. */
	readonly level: CapabilityFallbackLevel;

	/** The record key whose literal field carries the value. */
	readonly key: string;

	/** Present when the layer's winning record inherited the field from `key`; names that winning record. */
	readonly inheritedBy?: string | undefined;

	/** The demoted value; consumed fields are kind-validated at the parse, open fields pass as written. */
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
	/** The model's own raw ID: the key the records are matched against and the implicit catalog lookup uses. */
	readonly rawModelId: string;

	/** The models.capabilities setting as normalizeModelCapabilities returns it. */
	readonly globalCapabilities: ModelCapabilitiesRecord;

	/** The declared server entry's own capability records, when one matched. */
	readonly entryCapabilities?: ModelCapabilitiesRecord | undefined;

	/** The catalog the directive and implicit lookups answer from. */
	readonly catalog: CapabilityCatalogLookup;
}

export interface ResolvedCapabilityOverrides {
	/** The override levels' winners per field, entry over global over directive. */
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

/** A layer's value for a field with the record that spelled it, and the winner that inherited it when they differ. */
interface LayerField {
	value: CapabilityJsonValue;
	key: string;
	inheritedBy?: string;
}

/** A layer's field at the wanted level: an override (`wantFallback` false) or a `_fallback`-demoted value. */
function layerField(resolution: RecordChainResolution, name: string, wantFallback: boolean): LayerField | undefined {
	const field = resolution.fields.get(name);
	if (field === undefined || field.fallback !== wantFallback) {
		return undefined;
	}

	return {
		// The chain carries only parseCapabilityRecord output, so the value is already a kept capability value.
		value: field.value as CapabilityJsonValue,
		key: field.sourceKey,
		...(resolution.winnerKey !== undefined && field.sourceKey !== resolution.winnerKey
			? { inheritedBy: resolution.winnerKey }
			: {}),
	};
}

/** The `_openrouter_model` directive as the walk reads it; `fields` is empty unless its catalog entry was found. */
interface ResolvedDirective {
	readonly outcome: DirectiveOutcome | undefined;
	readonly fields: Readonly<Partial<CapabilityFieldValues>>;
}

function resolveDirective(directiveId: string | undefined, catalog: CapabilityCatalogLookup): ResolvedDirective {
	if (directiveId === undefined) {
		return { outcome: undefined, fields: {} };
	}

	const lookup = catalog.byExactId(directiveId);
	if (lookup.kind !== "found") {
		return { outcome: { kind: "not-found", id: directiveId }, fields: {} };
	}

	return { outcome: { kind: "applied", id: directiveId }, fields: lookup.fields };
}

export function resolveCapabilityOverrides(input: ResolveCapabilityOverridesInput): ResolvedCapabilityOverrides {
	const { rawModelId, globalCapabilities, entryCapabilities, catalog } = input;

	const entry = resolveCapabilityLayer(rawModelId, entryCapabilities ?? {});
	const global = resolveCapabilityLayer(rawModelId, globalCapabilities);

	const entryWinner = entry.winner as ParsedCapabilityRecord | undefined;
	const globalWinner = global.winner as ParsedCapabilityRecord | undefined;
	const directive = resolveDirective(entryWinner?.openrouterModel ?? globalWinner?.openrouterModel, catalog);

	const overrideField = (name: string): ResolvedCapabilityOverrideField | undefined => {
		const layered: {
			level: CapabilityOverrideLevel;
			key: string;
			inheritedBy?: string;
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
		const derivedValue = isCapabilityFieldName(name) ? directive.fields[name] : undefined;
		if (derivedValue !== undefined && directive.outcome !== undefined) {
			layered.push({ level: "directive", key: directive.outcome.id, value: derivedValue });
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

	const names = new Set<string>([...entry.fields.keys(), ...global.fields.keys(), ...Object.keys(directive.fields)]);
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
		...(directive.outcome === undefined ? {} : { directive: directive.outcome }),
		implicitCatalog: catalog.byRawModelId(rawModelId),
		diagnostics,
	};
}

/**
 * The typed server-reported capability values the walk may read: every consumed field under its wire key, as
 * discovery maps them from /model/info, typed by its kind.
 */
export type ServerCapabilityValues = {
	readonly [K in ConsumedCapabilityField]: ValueOfKind<(typeof CONSUMED_CAPABILITY_FIELDS)[K]>;
};

/**
 * Registration's post-aggregation baseline for one model: the conservative merged values exactly as the deployment
 * merge produced them, plus the request default the collapse decided for the server level. Both are minima over the
 * contributors, taken independently, so a floor-filled contributor caps the default even when a declared one supplies
 * the advertised minimum. Declared models have no server side at all, so the discriminant makes a missing baseline
 * unrepresentable rather than silently empty.
 */
export type ServerDeclaredCapabilities =
	| {
			readonly kind: "discovered";
			readonly values: Readonly<Partial<ServerCapabilityValues>>;
			readonly defaultMaxTokens: number;
	  }
	| { readonly kind: "declared" };

export const FLOOR_CONTEXT_LENGTH = 128000;
export const FLOOR_MAX_OUTPUT_TOKENS = 16000;

/** A guessed output limit (a floor fill, a catalog entry) is advertised whole; requests default to the cap under it. */
export function guessedMaxTokensDefault(limit: number): number {
	return Math.min(DEFAULT_MAX_TOKENS_CAP, limit);
}

/** The core floors. max_input_tokens has none (context minus output is total); every other field resolves open. */
export const CAPABILITY_FLOOR: Readonly<Omit<CapabilityFieldValues, "max_input_tokens">> = {
	context_length: FLOOR_CONTEXT_LENGTH,
	max_output_tokens: FLOOR_MAX_OUTPUT_TOKENS,
	supports_function_calling: true,
	supports_vision: false,
	supports_reasoning: false,
	supports_audio_input: false,
};

export interface EffectiveCapabilityField<V extends CapabilityJsonValue = CapabilityJsonValue> {
	/** The value the walk settled on, typed by the field's kind for the core fields. */
	readonly value: V;

	/** The level that supplied the value; floor and derived are the backstops. */
	readonly level: CapabilityLevel;

	/** The source record key (entry/global/fallback) or catalog entry ID (directive/catalog); absent elsewhere. */
	readonly key?: string | undefined;

	/** Present when the level's winning record inherited the field from `key`; names that winning record. */
	readonly inheritedBy?: string | undefined;

	/** Every lower level that also carried a value, highest first; floor and derived never shadow. */
	readonly shadowed: readonly ShadowedCapabilityValue[];
}

/**
 * The core fields, total by construction, plus every non-core field some level carried. A plain object, so a dynamic
 * read by an arbitrary open name must be own-property guarded: a bare index read of an unset prototype name like
 * "valueOf" would surface the inherited Object.prototype member.
 */
export type EffectiveCapabilityFields = {
	readonly [K in CapabilityFieldName]: EffectiveCapabilityField<CapabilityFieldValue<K>>;
} & { readonly [key: string]: EffectiveCapabilityField | undefined };

export interface ResolveModelCapabilitiesInput extends ResolveCapabilityOverridesInput {
	readonly serverDeclared: ServerDeclaredCapabilities;
}

export interface EffectiveCapabilities {
	/** The core fields, total, plus every open field some level carried. */
	readonly fields: EffectiveCapabilityFields;

	/** The request's max_tokens when nothing configures one; the one number the chat path reads for the fallback. */
	readonly defaultMaxTokens: number;

	/** See ResolvedCapabilityOverrides.directive. */
	readonly directive?: DirectiveOutcome | undefined;

	/** Field and `_openrouter_model` problems in the matching records. */
	readonly diagnostics: readonly CapabilityDiagnostic[];
}

interface LevelCandidate {
	readonly level: CapabilityLevel;
	readonly key?: string | undefined;
	readonly inheritedBy?: string | undefined;
	readonly value: CapabilityJsonValue;
}

function resolveField(
	override: ResolvedCapabilityOverrideField | undefined,
	lower: readonly LevelCandidate[]
): EffectiveCapabilityField | undefined {
	if (override !== undefined) {
		return {
			value: override.value,
			level: override.level,
			key: override.key,
			...(override.inheritedBy === undefined ? {} : { inheritedBy: override.inheritedBy }),
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
		...(winner.key === undefined ? {} : { key: winner.key }),
		...(winner.inheritedBy === undefined ? {} : { inheritedBy: winner.inheritedBy }),
		shadowed,
	};
}

/** Total so a new level fails here; the directive level is not user-set, so its catalog guess keeps the wire clamp. */
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

/** A user-written value (an override or a `_fallback` fill); the dashboard labels the output limit by it. */
export function isUserSetLevel(level: CapabilityLevel): boolean {
	return LEVEL_IS_USER_SET[level];
}

/**
 * The request's max_tokens default under the resolved output limit. A server-level limit takes the baseline's own
 * default rather than one derived here: the collapse decided that default beside the limit, and the two minima can
 * come from different contributors.
 */
function defaultMaxTokensFor(
	maxOutputTokens: EffectiveCapabilityField<number>,
	serverDeclared: ServerDeclaredCapabilities
): number {
	if (LEVEL_IS_USER_SET[maxOutputTokens.level]) {
		return maxOutputTokens.value;
	}

	if (maxOutputTokens.level === "server" && serverDeclared.kind === "discovered") {
		return serverDeclared.defaultMaxTokens;
	}

	return guessedMaxTokensDefault(maxOutputTokens.value);
}

export function resolveModelCapabilities(input: ResolveModelCapabilitiesInput): EffectiveCapabilities {
	const overrides = resolveCapabilityOverrides(input);
	const serverValues: Readonly<Record<string, CapabilityJsonValue | undefined>> =
		input.serverDeclared.kind === "discovered" ? input.serverDeclared.values : {};
	const catalogMatch = overrides.implicitCatalog.kind === "found" ? overrides.implicitCatalog : undefined;

	const fromServer = (name: string): LevelCandidate[] => {
		const value = capabilityField(serverValues, name);
		return value === undefined ? [] : [{ level: "server", value }];
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
	// Every level that feeds a core field is kind-validated at its source, so narrowing the open walk's result to the
	// field's declared kind is safe.
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

	const defaultMaxTokens = defaultMaxTokensFor(maxOutputTokens, input.serverDeclared);

	const fields: Record<string, EffectiveCapabilityField> = {
		context_length: contextLength,
		max_input_tokens: maxInputTokens,
		max_output_tokens: maxOutputTokens,
		supports_function_calling: booleanField("supports_function_calling"),
		supports_vision: booleanField("supports_vision"),
		supports_reasoning: booleanField("supports_reasoning"),
		supports_audio_input: booleanField("supports_audio_input"),
	};
	// Underscore names are skipped like the parse skips them, which keeps a hostile own "__proto__" key in a server
	// baseline out of the result object.
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
		defaultMaxTokens,
		...(overrides.directive === undefined ? {} : { directive: overrides.directive }),
		diagnostics: overrides.diagnostics,
	};
}
