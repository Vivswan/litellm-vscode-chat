/**
 * The single owner of the modelCapabilities vocabulary, its precedence walk,
 * and the `_declare`/`_openrouter_model`/`_fallback` directives. Pure (no
 * vscode, no DOM, no Node) on purpose: the provider's registration path
 * patches attached models through resolveModelCapabilities, and the
 * dashboard's capability inspector renders its projection through the
 * protocol module's re-exports - one implementation, so the inspector cannot
 * drift from what registration serves. Everything out is serializable data
 * (records and arrays, no Maps), so results ride the dashboard message
 * protocol unchanged.
 *
 * Unlike modelParameters (an open pass-through), capabilities are a closed
 * vocabulary: parseCapabilityRecord is the one boundary where keys and value
 * types are enforced, so everything downstream handles typed fields and
 * diagnostics instead of re-checking raw records. The layer merge mirrors
 * resolveModelParameters verbatim - a scoped global match replaces the whole
 * unscoped record, the entry record wins key by key - with one addition: each
 * layer's winning record is parsed independently BEFORE the merge, so an
 * invalid value in a higher layer falls through to a valid lower one instead
 * of shadowing it. A record's `_fallback` directive demotes all or the listed
 * fields from override level (above server) to fallback level (below server),
 * the flag riding from each field's source record through the merge.
 */

import { CATCH_ALL_PREFIX, findLongestPrefixEntry, findScopedMatch } from "./parameterResolution";

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

/** Opts a record's exact key ID into existing as a model even when discovery does not list it. */
export const DECLARE_DIRECTIVE = "_declare";

/** Names an OpenRouter catalog entry whose capabilities backfill fields the record leaves unset. */
export const OPENROUTER_MODEL_DIRECTIVE = "_openrouter_model";

/**
 * Demotes all (`true`) or the listed capability fields of its record from
 * override level to fallback level: applied BELOW the server-reported value
 * instead of above it (fill-when-missing semantics). Combining with a
 * `_declare` that creates the resolved model is diagnosed and the fallback
 * ignored for that model (a declared model has no server side to fall back
 * under, so its fields stay overrides while the declaration works); the same
 * record matching other models by prefix keeps its fallback semantics.
 */
export const FALLBACK_DIRECTIVE = "_fallback";

/** A modelCapabilities record: model-ID prefix (optionally base-URL scoped) to capability fields and directives. */
export type ModelCapabilitiesRecord = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

export type CapabilityDiagnosticKind = "unknown-key" | "invalid-value" | "invalid-directive" | "unscoped-declare";

/** One problem found while parsing a single capability record; `key` is the offending key inside it. */
export interface CapabilityRecordDiagnostic {
	readonly kind: CapabilityDiagnosticKind;
	readonly key: string;
}

/** "entry" is the declared server entry's own record map; "global" the modelCapabilities setting. */
export type CapabilityConfigLayer = "entry" | "global";

/** A record diagnostic attributed to its configuration layer and the record key that carried it. */
export interface CapabilityDiagnostic extends CapabilityRecordDiagnostic {
	readonly layer: CapabilityConfigLayer;
	readonly recordKey: string;
}

export interface ParsedCapabilityRecord {
	/** The validly typed capability fields; invalid and unknown keys are diagnosed away. */
	readonly fields: Readonly<Partial<CapabilityFieldValues>>;
	/** True only when the record carries a legal `_declare: true` (see parseCapabilityRecord's options). */
	readonly declare: boolean;
	/** The `_openrouter_model` directive's catalog ID, when validly set. */
	readonly openrouterModel?: string | undefined;
	/** The field names `_fallback` marks; always keys of `fields`. Empty when absent, false, or ignored. */
	readonly fallback: readonly CapabilityFieldName[];
	readonly diagnostics: readonly CapabilityRecordDiagnostic[];
}

/**
 * The one enforcement boundary of the capability vocabulary. A number field
 * accepts positive integers only; a boolean field accepts booleans only;
 * anything else is an invalid-value diagnostic and the field stays unset, so
 * a lower precedence layer's valid value can still win. `_declare` must be a
 * boolean and is only honored when `allowDeclare` is set - callers pass false
 * for keys that cannot name a server plus exact model ID (unscoped global
 * keys, empty-ID keys, and the catch-all), turning `_declare: true` into an
 * unscoped-declare diagnostic. `_openrouter_model` must be a non-blank
 * string. `_fallback` must be `true` (all of the record's valid fields), a
 * list of field names the record validly sets (anything else in the list is
 * an invalid-directive diagnostic), or `false`. The `_declare` + `_fallback`
 * combination is judged by resolveCapabilityOverrides, not here: whether the
 * fallback is honored depends on which model the record resolves for. Other
 * underscore keys are ignored without diagnosis (forward compatibility).
 */
export function parseCapabilityRecord(
	record: Readonly<Record<string, unknown>>,
	options: { readonly allowDeclare: boolean }
): ParsedCapabilityRecord {
	const numbers: { -readonly [K in NumberCapabilityField]?: number } = {};
	const booleans: { -readonly [K in BooleanCapabilityField]?: boolean } = {};
	let isDeclared = false;
	let openrouterModel: string | undefined;
	const diagnostics: CapabilityRecordDiagnostic[] = [];

	for (const [key, value] of Object.entries(record)) {
		if (key === DECLARE_DIRECTIVE) {
			if (typeof value !== "boolean") {
				diagnostics.push({ kind: "invalid-directive", key });
			} else if (value && !options.allowDeclare) {
				diagnostics.push({ kind: "unscoped-declare", key });
			} else {
				isDeclared = value;
			}
			continue;
		}
		if (key === OPENROUTER_MODEL_DIRECTIVE) {
			if (typeof value === "string" && value.trim() !== "") {
				openrouterModel = value;
			} else {
				diagnostics.push({ kind: "invalid-directive", key });
			}
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
	const fallback: CapabilityFieldName[] = [];
	if (Object.hasOwn(record, FALLBACK_DIRECTIVE)) {
		const directive = record[FALLBACK_DIRECTIVE];
		if (directive === true) {
			fallback.push(...(Object.keys(fields) as CapabilityFieldName[]));
		} else if (Array.isArray(directive)) {
			let invalidEntry = false;
			for (const name of directive) {
				if (typeof name === "string" && isCapabilityFieldName(name) && Object.hasOwn(fields, name)) {
					if (!fallback.includes(name)) {
						fallback.push(name);
					}
				} else {
					invalidEntry = true;
				}
			}
			if (invalidEntry) {
				diagnostics.push({ kind: "invalid-directive", key: FALLBACK_DIRECTIVE });
			}
		} else if (directive !== false) {
			diagnostics.push({ kind: "invalid-directive", key: FALLBACK_DIRECTIVE });
		}
	}

	return {
		fields,
		declare: isDeclared,
		...(openrouterModel !== undefined ? { openrouterModel } : {}),
		fallback,
		diagnostics,
	};
}

/**
 * Scoped modelCapabilities keys carry a base URL before the model prefix, and
 * base URLs always contain "://" while LiteLLM model IDs never do - so a
 * global key with "://" that matches none of this server's scopes belongs to
 * another server and is skipped, while a key without one is genuinely
 * unscoped.
 */
function isUrlScopedKey(key: string): boolean {
	return key.includes("://");
}

/**
 * The exact model ID a scoped key may declare: its longest remainder under
 * the matching scopes (the shortest scope, consistent with findScopedMatch
 * preferring the longest model prefix), so the record that declares a model
 * is the record that later matches it. undefined when no scope matches or
 * the remainder is empty or the catch-all "*" - such a key cannot name a
 * model.
 */
function scopedDeclarableId(key: string, scopes: readonly string[]): string | undefined {
	let remainder: string | undefined;
	for (const scope of scopes) {
		if (key.startsWith(`${scope}/`)) {
			const candidate = key.slice(scope.length + 1);
			if (remainder === undefined || candidate.length > remainder.length) {
				remainder = candidate;
			}
		}
	}
	return remainder === "" || remainder === CATCH_ALL_PREFIX ? undefined : remainder;
}

export interface ExtractDeclaredModelsInput {
	/** The modelCapabilities setting as normalizeModelCapabilities returns it. */
	readonly globalCapabilities: ModelCapabilitiesRecord;
	/** Scopes for scoped-key matching: the server's normalized base URL. */
	readonly serverScopes: readonly string[];
	/** The declared server entry's own capability records, when one matched. */
	readonly entryCapabilities?: ModelCapabilitiesRecord | undefined;
}

/** One model a `_declare` directive creates, named by its record key's exact literal ID. */
export interface DeclaredModelSpec {
	readonly rawId: string;
	readonly layer: CapabilityConfigLayer;
	/** The record key that declared it; scoped global keys keep their base-URL prefix. */
	readonly recordKey: string;
}

export interface ExtractedDeclaredModels {
	readonly models: readonly DeclaredModelSpec[];
	/** `_declare` problems only (unscoped-declare and invalid `_declare` values); field diagnostics stay with resolution. */
	readonly diagnostics: readonly CapabilityDiagnostic[];
}

/**
 * Scan the capability records for `_declare` directives and produce the
 * models this server must synthesize when discovery does not list them.
 * Declared IDs are the record keys' exact literals (a scoped key's post-scope
 * remainder, an entry key verbatim); prefix matching never creates models.
 * The same ID declared in both layers dedupes entry-over-global. Whether a
 * declared ID is inert (already discovered) is the caller's call against the
 * discovered raw-ID set - this resolver never sees discovery output.
 */
export function extractDeclaredModels(input: ExtractDeclaredModelsInput): ExtractedDeclaredModels {
	const models: DeclaredModelSpec[] = [];
	const declared = new Set<string>();
	const diagnostics: CapabilityDiagnostic[] = [];

	const scan = (
		layer: CapabilityConfigLayer,
		recordKey: string,
		declarableId: string | undefined,
		record: Readonly<Record<string, unknown>>
	): void => {
		const parsed = parseCapabilityRecord(record, { allowDeclare: declarableId !== undefined });
		for (const diagnostic of parsed.diagnostics) {
			if (diagnostic.key === DECLARE_DIRECTIVE) {
				diagnostics.push({ ...diagnostic, layer, recordKey });
			}
		}
		if (parsed.declare && declarableId !== undefined && !declared.has(declarableId)) {
			declared.add(declarableId);
			models.push({ rawId: declarableId, layer, recordKey });
		}
	};

	for (const [key, record] of Object.entries(input.entryCapabilities ?? {})) {
		// The empty key and the catch-all "*" match every model and can name
		// none, so neither may declare.
		scan("entry", key, key !== "" && key !== CATCH_ALL_PREFIX ? key : undefined, record);
	}
	for (const [key, record] of Object.entries(input.globalCapabilities)) {
		if (input.serverScopes.some((scope) => key.startsWith(`${scope}/`))) {
			scan("global", key, scopedDeclarableId(key, input.serverScopes), record);
		} else if (!isUrlScopedKey(key)) {
			scan("global", key, undefined, record);
		}
	}

	return { models, diagnostics };
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

/** The override levels user configuration sets directly; anything resolved here counts as user-set. */
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
	/** The winning record key (entry/global), or the catalog entry ID (directive/catalog). */
	readonly key?: string | undefined;
	readonly value: number | boolean;
}

export interface ResolvedCapabilityOverrideField<V extends number | boolean> {
	readonly value: V;
	readonly level: CapabilityOverrideLevel;
	/** The record key that set it (entry/global) or the directive's catalog ID (directive). */
	readonly key: string;
	/** Lower override levels that also set this field, highest first. */
	readonly shadowed: readonly ShadowedCapabilityValue[];
}

export type ResolvedCapabilityOverrideFields = {
	readonly [K in CapabilityFieldName]?: ResolvedCapabilityOverrideField<CapabilityFieldValue<K>> | undefined;
};

/** One `_fallback`-demoted value, ready to slot into the walk below the server level. */
export interface CapabilityFallbackCandidate<V extends number | boolean> {
	readonly level: CapabilityFallbackLevel;
	/** The record key that set it; scoped global keys keep their base-URL prefix. */
	readonly key: string;
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
	/** The modelCapabilities setting as normalizeModelCapabilities returns it. */
	readonly globalCapabilities: ModelCapabilitiesRecord;
	/** Scopes for scoped-key matching: the server's normalized base URL. */
	readonly serverScopes: readonly string[];
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
	/** True when extractDeclaredModels declares this exact raw ID; the two can never disagree. */
	readonly declare: boolean;
	/**
	 * The unscoped global record a scoped match replaced WHOLE, when one did.
	 * Replacement is record-level, not key-level, so the inspector must show
	 * this entire record as shadowed - not just the keys the winner also sets.
	 */
	readonly replacedUnscoped?: { readonly key: string; readonly record: Readonly<Record<string, unknown>> } | undefined;
	/** Field and `_openrouter_model` problems in the winning records; `_declare` problems belong to extraction. */
	readonly diagnostics: readonly CapabilityDiagnostic[];
}

/**
 * Resolve the user-set capability overrides for one model: the entry and
 * global layers merge with resolveModelParameters' contract verbatim (any
 * scoped global match replaces the whole unscoped record, then the entry
 * record's longest-prefix match overrides key by key), except that each
 * layer's winning record is parsed independently before merging - an invalid
 * value never shadows a valid lower one. A field its source record marks
 * `_fallback` leaves the override chain and comes back as a fallback
 * candidate (below server in the walk); the two chains merge independently,
 * so a global override still beats an entry fallback. The
 * `_openrouter_model` directive resolves through the same two layers like
 * any key, and its catalog-derived fields fill only fields no explicit
 * override set.
 */
export function resolveCapabilityOverrides(input: ResolveCapabilityOverridesInput): ResolvedCapabilityOverrides {
	const { rawModelId, globalCapabilities, serverScopes, entryCapabilities, catalog } = input;

	const scoped = findScopedMatch(rawModelId, serverScopes, globalCapabilities);
	const unscoped = findLongestPrefixEntry(rawModelId, globalCapabilities);
	// Mirrors resolveModelParameters: only a scoped match with a real value
	// replaces the unscoped record.
	const globalWinner = scoped?.value !== undefined ? { key: scoped.key, value: scoped.value } : unscoped;
	const entryWinner = findLongestPrefixEntry(rawModelId, entryCapabilities ?? {});

	// `_declare` is extraction's concern alone: both layers parse permissively
	// and `_declare` diagnostics are filtered below, so declaration problems
	// have one owner (extractDeclaredModels) and never surface twice.
	const parsedGlobal =
		globalWinner !== undefined ? parseCapabilityRecord(globalWinner.value, { allowDeclare: true }) : undefined;
	const parsedEntry =
		entryWinner !== undefined ? parseCapabilityRecord(entryWinner.value, { allowDeclare: true }) : undefined;

	const directiveId = parsedEntry?.openrouterModel ?? parsedGlobal?.openrouterModel;
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

	// The `_declare` + `_fallback` ban, applied exactly where its rationale
	// holds: a record whose declaration CREATES this model has no server side
	// to fall back under, so its fallback marks are diagnosed and ignored
	// (fields stay overrides; the declaration still works). The same record
	// resolving another model by prefix - or a declaration extraction refuses
	// - keeps its fallback semantics, so a discovered model's server values
	// are never silently overridden by fields the user demoted.
	const entryBanned =
		parsedEntry?.declare === true &&
		parsedEntry.fallback.length > 0 &&
		entryWinner !== undefined &&
		entryWinner.key !== "" &&
		entryWinner.key !== CATCH_ALL_PREFIX &&
		entryWinner.key === rawModelId;
	const globalBanned =
		parsedGlobal?.declare === true &&
		parsedGlobal.fallback.length > 0 &&
		globalWinner !== undefined &&
		scopedDeclarableId(globalWinner.key, serverScopes) === rawModelId;
	const entryFallback: readonly CapabilityFieldName[] = entryBanned ? [] : (parsedEntry?.fallback ?? []);
	const globalFallback: readonly CapabilityFieldName[] = globalBanned ? [] : (parsedGlobal?.fallback ?? []);

	const overrideField = <K extends CapabilityFieldName>(
		name: K
	): ResolvedCapabilityOverrideField<CapabilityFieldValue<K>> | undefined => {
		const layered: { level: CapabilityOverrideLevel; key: string; value: CapabilityFieldValue<K> }[] = [];
		if (parsedEntry !== undefined && entryWinner !== undefined && !entryFallback.includes(name)) {
			const entryValue = parsedEntry.fields[name];
			if (entryValue !== undefined) {
				layered.push({ level: "entry", key: entryWinner.key, value: entryValue });
			}
		}
		if (parsedGlobal !== undefined && globalWinner !== undefined && !globalFallback.includes(name)) {
			const globalValue = parsedGlobal.fields[name];
			if (globalValue !== undefined) {
				layered.push({ level: "global", key: globalWinner.key, value: globalValue });
			}
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
		if (parsedEntry !== undefined && entryWinner !== undefined && entryFallback.includes(name)) {
			const entryValue = parsedEntry.fields[name];
			if (entryValue !== undefined) {
				candidates.push({ level: "entry-fallback", key: entryWinner.key, value: entryValue });
			}
		}
		if (parsedGlobal !== undefined && globalWinner !== undefined && globalFallback.includes(name)) {
			const globalValue = parsedGlobal.fields[name];
			if (globalValue !== undefined) {
				candidates.push({ level: "global-fallback", key: globalWinner.key, value: globalValue });
			}
		}
		return candidates.length > 0 ? candidates : undefined;
	};

	const diagnostics: CapabilityDiagnostic[] = [];
	const attribute = (
		parsed: ParsedCapabilityRecord,
		layer: CapabilityConfigLayer,
		recordKey: string
	): CapabilityDiagnostic[] =>
		parsed.diagnostics.filter((d) => d.key !== DECLARE_DIRECTIVE).map((d) => ({ ...d, layer, recordKey }));
	// The ban's diagnostic dedupes against the parse: a malformed _fallback on
	// a banned record already carries the same kind and key from the parse, and
	// the inspector keys its diagnostic list by exactly that triple.
	const fallbackDiagnosed = (parsed: ParsedCapabilityRecord): boolean =>
		parsed.diagnostics.some((d) => d.kind === "invalid-directive" && d.key === FALLBACK_DIRECTIVE);
	if (parsedEntry !== undefined && entryWinner !== undefined) {
		diagnostics.push(...attribute(parsedEntry, "entry", entryWinner.key));
		if (entryBanned && !fallbackDiagnosed(parsedEntry)) {
			diagnostics.push({
				kind: "invalid-directive",
				key: FALLBACK_DIRECTIVE,
				layer: "entry",
				recordKey: entryWinner.key,
			});
		}
	}
	if (parsedGlobal !== undefined && globalWinner !== undefined) {
		diagnostics.push(...attribute(parsedGlobal, "global", globalWinner.key));
		if (globalBanned && !fallbackDiagnosed(parsedGlobal)) {
			diagnostics.push({
				kind: "invalid-directive",
				key: FALLBACK_DIRECTIVE,
				layer: "global",
				recordKey: globalWinner.key,
			});
		}
	}

	// Declaration is extraction's semantics, not the winner's: a scoped record
	// that loses the capability merge to another scope still declares its exact
	// ID, so the flag delegates to the one owner of that rule.
	const declare = extractDeclaredModels({ globalCapabilities, serverScopes, entryCapabilities }).models.some(
		(model) => model.rawId === rawModelId
	);

	const replacedUnscoped =
		scoped?.value !== undefined && unscoped !== undefined ? { key: unscoped.key, record: unscoped.value } : undefined;

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
		declare,
		...(replacedUnscoped !== undefined ? { replacedUnscoped } : {}),
		diagnostics,
	};
}

/**
 * Registration's post-aggregation baseline for one model: the conservative
 * merged values exactly as the deployment merge produced them (present
 * whenever any contributor reported the field), plus output-limit
 * declaredness (the every-contributor rule), which controls only whether the
 * output limit counts as "provider". `_declare`d models have no server side
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
 * Provenance of the effective max output tokens. "user" (any override level)
 * and "provider" (server-declared by every contributor) are sent uncapped;
 * "defaults" keeps the request path's min(4096, limit) clamp, because a
 * guessed limit must not escape it.
 */
export type EffectiveOutputLimitSource = "user" | "provider" | "defaults";

export interface EffectiveCapabilityField<V extends number | boolean> {
	readonly value: V;
	readonly level: CapabilityLevel;
	/** The winning record key (entry/global) or catalog entry ID (directive/catalog); absent elsewhere. */
	readonly key?: string | undefined;
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
	/** See ResolvedCapabilityOverrides.declare. */
	readonly declare: boolean;
	/** See ResolvedCapabilityOverrides.replacedUnscoped. */
	readonly replacedUnscoped?: { readonly key: string; readonly record: Readonly<Record<string, unknown>> } | undefined;
	readonly diagnostics: readonly CapabilityDiagnostic[];
}

interface LevelCandidate<V extends number | boolean> {
	readonly level: CapabilityLevel;
	readonly key?: string | undefined;
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
		shadowed,
	};
}

/**
 * Whether a level's value counts as user-set for output-limit provenance.
 * Total over CapabilityLevel on purpose, like capabilityOverrides'
 * LEVEL_TRIGGERS_REBUILD: a level added to the walk fails compilation here
 * instead of silently resolving to "defaults" and regaining the wire clamp.
 */
const LEVEL_IS_USER_SET: Readonly<Record<CapabilityLevel, boolean>> = {
	entry: true,
	global: true,
	directive: true,
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
 *  1. explicit field in the entry record
 *  2. explicit field in the global record (scoped replaces unscoped whole)
 *  3. field derived from `_openrouter_model`
 *  4. server-reported value (skipped for `_declare`d models)
 *  5. `_fallback`-marked field in the entry record
 *  6. `_fallback`-marked field in the global record
 *  7. implicit catalog lookup by the model's own raw ID
 *  8. built-in floor; max_input_tokens instead derives
 *     max(1, context - output) from the effective values
 *
 * Levels 1-3 and 5-6 count as user-declared output limits ("user"); the
 * server level is "provider" only under the every-contributor declaredness
 * rule; every other level stays "defaults" so guessed limits keep the wire
 * clamp.
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
		declare: overrides.declare,
		...(overrides.replacedUnscoped !== undefined ? { replacedUnscoped: overrides.replacedUnscoped } : {}),
		diagnostics: overrides.diagnostics,
	};
}
