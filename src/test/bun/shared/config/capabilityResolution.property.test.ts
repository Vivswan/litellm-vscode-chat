/**
 * The capability resolver's safety argument, mirrored from the
 * parameterResolution property suite: over random capability records (valid and
 * invalid consumed values, verbatim extras, directives, exact and glob keys cut
 * from generated raw IDs so matches are the common case, inert pre-migration
 * URL keys), the boundary parse is the only gate - invalid consumed values
 * contribute nothing anywhere, the walk is total over the core fields, an
 * injected higher-precedence field always wins, and the overrides resolution
 * and the full walk never disagree on a field the overrides set. The open
 * vocabulary is pinned three ways: a frozen copy of the closed-world resolver
 * agrees on core-only configurations, unknown-key extras never move a core
 * field, and every user-set extra resolves with exact provenance against a
 * naive per-field walk. Registration and the dashboard consume the same
 * resolveModelCapabilities, so these pins keep the two surfaces aligned.
 */
import { describe, test } from "bun:test";
import * as assert from "node:assert";
import * as fc from "fast-check";
import type {
	BooleanCapabilityField,
	CapabilityCatalogLookup,
	CapabilityFallbackLevel,
	CapabilityFieldName,
	CapabilityFieldValues,
	CapabilityJsonValue,
	CapabilityLevel,
	CapabilityOverrideLevel,
	CatalogLookupResult,
	EffectiveCapabilityField,
	EffectiveCapabilityFields,
	EffectiveOutputLimitSource,
	ModelCapabilitiesRecord,
	NumberCapabilityField,
	ResolvedCapabilityOverrideField,
	ResolvedCapabilityOverrideFields,
	ResolveModelCapabilitiesInput,
	ServerCapabilityValues,
	ServerDeclaredCapabilities,
} from "../../../../shared/config/capabilityResolution";
import {
	CAPABILITY_FIELDS,
	CAPABILITY_FLOOR,
	CONSUMED_CAPABILITY_FIELDS,
	capabilityField,
	FALLBACK_DIRECTIVE,
	OPENROUTER_MODEL_DIRECTIVE,
	resolveCapabilityLayer,
	resolveCapabilityOverrides,
	resolveModelCapabilities,
} from "../../../../shared/config/capabilityResolution";
import type { ParsedRecord, RecordChainResolution } from "../../../../shared/config/recordResolution";
import { parseSharedDirectives, resolveRecordChain } from "../../../../shared/config/recordResolution";
import { resolveFuzzSeed } from "../../../fuzzStream";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 200;
const SEED = resolveFuzzSeed();

const FIELD_NAMES = Object.keys(CAPABILITY_FIELDS) as CapabilityFieldName[];
const NUMBER_FIELD_NAMES = FIELD_NAMES.filter(
	(name): name is NumberCapabilityField => CAPABILITY_FIELDS[name] === "number"
);
const BOOLEAN_FIELD_NAMES = FIELD_NAMES.filter(
	(name): name is BooleanCapabilityField => CAPABILITY_FIELDS[name] === "boolean"
);
const CONSUMED_EXTRA_NAMES = Object.keys(CONSUMED_CAPABILITY_FIELDS).filter(
	(name) => !Object.hasOwn(CAPABILITY_FIELDS, name)
);
const OVERRIDE_LEVELS: readonly CapabilityOverrideLevel[] = ["entry", "global", "directive"];
// The directive level is NOT user-set: both catalog paths stay guesses on the wire.
const USER_SET_LEVELS: readonly CapabilityLevel[] = ["entry", "global", "entry-fallback", "global-fallback"];

// Slash-free so a pre-migration URL key can never collide with a plain key;
// underscore-free so a random field name can never spell a directive.
const noSlashChar = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789.-");
const noSlashKey = fc.string({ unit: noSlashChar, minLength: 1, maxLength: 10 });

const scopePool = ["http://a.test", "http://b.test:4000"] as const;

// The two directive IDs the generated catalog can hold, plus one it never does.
const DIRECTIVE_POOL = ["cat/one", "cat/two", "cat/none"] as const;

const validNumber = fc.integer({ min: 1, max: 1_000_000 });
const validFieldsArb: fc.Arbitrary<Partial<CapabilityFieldValues>> = fc.record(
	{
		context_length: validNumber,
		max_input_tokens: validNumber,
		max_output_tokens: validNumber,
		supports_function_calling: fc.boolean(),
		supports_vision: fc.boolean(),
		supports_reasoning: fc.boolean(),
		supports_audio_input: fc.boolean(),
	},
	{ requiredKeys: [] }
);

/** Server baselines carry the consumed vocabulary too, so its server level stays exercised. */
const serverValuesArb: fc.Arbitrary<Partial<ServerCapabilityValues>> = fc
	.tuple(
		validFieldsArb,
		fc.record(
			{
				input_cost_per_token: fc.constantFrom(0, 0.000003),
				cache_read_input_token_cost: fc.constantFrom(0, 0.0000003),
				supports_prompt_caching: fc.boolean(),
				supports_pdf_input: fc.boolean(),
				supported_openai_params: fc.constantFrom<readonly string[]>([], ["temperature"], ["tools", "reasoning"]),
			},
			{ requiredKeys: [] }
		)
	)
	.map(([core, consumed]) => ({ ...core, ...consumed }));

// Values land on kind-matched and kind-mismatched fields alike, so both the
// valid path and the invalid-value fallthrough stay common; structured JSON
// values keep the verbatim-extras path alive.
const fieldValueArb = fc.oneof(
	{ arbitrary: validNumber, weight: 3 },
	{ arbitrary: fc.boolean(), weight: 3 },
	{ arbitrary: fc.constantFrom<unknown>(0, 0.000003, -1, 1.5), weight: 2 },
	{ arbitrary: fc.constantFrom<unknown>([], ["temperature"], [""], "128k", null, { nested: true }), weight: 2 }
);
const recordKeyArb = fc.oneof(
	{ arbitrary: fc.constantFrom<string>(...FIELD_NAMES), weight: 5 },
	{ arbitrary: fc.constantFrom<string>(...CONSUMED_EXTRA_NAMES), weight: 2 },
	{ arbitrary: noSlashKey, weight: 1 },
	// Prototype-named fields must behave like any other extra (the
	// own-property guard's regression surface).
	{ arbitrary: fc.constantFrom("toString", "valueOf", "constructor", "hasOwnProperty"), weight: 1 },
	{ arbitrary: noSlashKey.map((key) => `_${key}`), weight: 1 }
);
const capabilityRecordArb: fc.Arbitrary<Record<string, unknown>> = fc
	.tuple(
		fc.dictionary(recordKeyArb, fieldValueArb, { maxKeys: 5 }),
		fc.option(fc.oneof({ arbitrary: fc.boolean(), weight: 3 }, { arbitrary: fc.constant<unknown>("yes"), weight: 1 }), {
			nil: undefined,
		}),
		fc.option(fc.oneof(fc.constantFrom<unknown>(...DIRECTIVE_POOL), fc.constantFrom<unknown>("", 7)), {
			nil: undefined,
		}),
		// _fallback: all-fields, a list of names (valid and bogus alike), or an
		// invalid shape - each of the parse branches stays a common case.
		fc.option(
			fc.oneof(
				{ arbitrary: fc.boolean(), weight: 2 },
				{ arbitrary: fc.subarray([...FIELD_NAMES, "supports_pdf_input"]), weight: 2 },
				{ arbitrary: fc.constantFrom<unknown>("yes", 7, null), weight: 1 }
			),
			{ nil: undefined }
		)
	)
	.map(([base, declare, openrouterModel, fallback]) => ({
		...base,
		// _declare is retired; it stays as inert underscore-key noise that
		// resolution must ignore everywhere.
		...(declare !== undefined ? { _declare: declare } : {}),
		...(openrouterModel !== undefined ? { [OPENROUTER_MODEL_DIRECTIVE]: openrouterModel } : {}),
		...(fallback !== undefined ? { [FALLBACK_DIRECTIVE]: fallback } : {}),
	}));

const serverDeclaredArb: fc.Arbitrary<ServerDeclaredCapabilities> = fc.oneof(
	fc.constant<ServerDeclaredCapabilities>({ kind: "declared" }),
	fc
		.record({ values: serverValuesArb, outputDeclared: fc.boolean() })
		.map(({ values, outputDeclared }): ServerDeclaredCapabilities => ({ kind: "discovered", values, outputDeclared }))
);

/** Exact IDs and unambiguous post-vendor suffixes answer found, several suffix hits answer ambiguous. */
function makeCatalog(entries: Record<string, Partial<CapabilityFieldValues>>): CapabilityCatalogLookup {
	const byExactId = (id: string): CatalogLookupResult => {
		const fields = entries[id];
		return fields !== undefined ? { kind: "found", id, fields } : { kind: "not-found" };
	};
	return {
		byExactId,
		byRawModelId: (rawId: string): CatalogLookupResult => {
			const exact = byExactId(rawId);
			if (exact.kind === "found") {
				return exact;
			}
			const suffixIds = Object.keys(entries).filter((id) => id.split("/").slice(1).join("/") === rawId);
			if (suffixIds.length === 1 && suffixIds[0] !== undefined) {
				return byExactId(suffixIds[0]);
			}
			return suffixIds.length > 1 ? { kind: "ambiguous" } : { kind: "not-found" };
		},
	};
}

interface Scenario {
	readonly input: ResolveModelCapabilitiesInput;
}

/**
 * A raw ID plus capability records whose keys are glob or exact cuts of it
 * (matches are the common case), a cut of an unrelated ID keeping the
 * no-match branch alive, the catch-all "*", inert pre-migration URL keys,
 * directives pointing into and past the generated catalog, and independent
 * server and catalog layers.
 */
const scenario: fc.Arbitrary<Scenario> = fc
	.record({
		rawModelId: noSlashKey,
		otherId: noSlashKey,
		globalSpecs: fc.array(
			fc.record({
				cut: fc.nat(),
				foreign: fc.boolean(),
				glob: fc.boolean(),
				star: fc.boolean(),
				scope: fc.option(fc.constantFrom(...scopePool), { nil: undefined }),
				record: capabilityRecordArb,
			}),
			{ maxLength: 4 }
		),
		entrySpecs: fc.option(
			fc.array(
				fc.record({
					cut: fc.nat(),
					foreign: fc.boolean(),
					glob: fc.boolean(),
					star: fc.boolean(),
					record: capabilityRecordArb,
				}),
				{ maxLength: 3 }
			),
			{ nil: undefined }
		),
		catalogOne: fc.option(validFieldsArb, { nil: undefined }),
		catalogTwo: fc.option(validFieldsArb, { nil: undefined }),
		implicitFields: fc.option(validFieldsArb, { nil: undefined }),
		implicitAmbiguous: fc.boolean(),
		serverDeclared: serverDeclaredArb,
	})
	.map((spec) => {
		const keyOf = (cut: number, foreign: boolean, glob: boolean, star: boolean) => {
			if (star) {
				return "*";
			}
			const base = foreign ? spec.otherId : spec.rawModelId;
			return `${base.slice(0, cut % (base.length + 1))}${glob ? "*" : ""}`;
		};
		const globalCapabilities: Record<string, Record<string, unknown>> = {};
		for (const globalSpec of spec.globalSpecs) {
			const key = keyOf(globalSpec.cut, globalSpec.foreign, globalSpec.glob, globalSpec.star);
			globalCapabilities[globalSpec.scope === undefined ? key : `${globalSpec.scope}/${key}`] = globalSpec.record;
		}
		const entryCapabilities =
			spec.entrySpecs === undefined
				? undefined
				: Object.fromEntries(
						spec.entrySpecs.map((entry) => [keyOf(entry.cut, entry.foreign, entry.glob, entry.star), entry.record])
					);
		const catalog = makeCatalog({
			...(spec.catalogOne !== undefined ? { "cat/one": spec.catalogOne } : {}),
			...(spec.catalogTwo !== undefined ? { "cat/two": spec.catalogTwo } : {}),
			...(spec.implicitFields !== undefined ? { [`imp/${spec.rawModelId}`]: spec.implicitFields } : {}),
			...(spec.implicitFields !== undefined && spec.implicitAmbiguous
				? { [`imp2/${spec.rawModelId}`]: spec.implicitFields }
				: {}),
		});
		return {
			input: {
				rawModelId: spec.rawModelId,
				globalCapabilities,
				entryCapabilities,
				catalog,
				serverDeclared: spec.serverDeclared,
			},
		};
	});

/**
 * The independent statement of what parseCapabilityRecord accepts, so the
 * fallthrough property below is not the parser checking itself: keep
 * kind-valid consumed fields, EVERY extra verbatim (the open vocabulary),
 * non-blank `_openrouter_model`, and boolean-or-array `_fallback`; drop only
 * invalid consumed values.
 */
function sanitizeRecord(record: Readonly<Record<string, unknown>>): Record<string, unknown> {
	const sanitized: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (key === OPENROUTER_MODEL_DIRECTIVE) {
			if (typeof value === "string" && value.trim() !== "") {
				sanitized[key] = value;
			}
		} else if (key === FALLBACK_DIRECTIVE) {
			if (typeof value === "boolean" || Array.isArray(value)) {
				sanitized[key] = value;
			}
		} else if (Object.hasOwn(CONSUMED_CAPABILITY_FIELDS, key)) {
			const kind = CONSUMED_CAPABILITY_FIELDS[key];
			const valid =
				kind === "number"
					? typeof value === "number" && Number.isInteger(value) && value > 0
					: kind === "cost"
						? typeof value === "number" && Number.isFinite(value) && value >= 0
						: kind === "boolean"
							? typeof value === "boolean"
							: Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
			if (valid) {
				sanitized[key] = value;
			}
		} else if (!key.startsWith("_")) {
			sanitized[key] = value;
		}
	}
	return sanitized;
}

function sanitizeRecords(records: ModelCapabilitiesRecord | undefined): ModelCapabilitiesRecord | undefined {
	if (records === undefined) {
		return undefined;
	}
	return Object.fromEntries(Object.entries(records).map(([key, record]) => [key, sanitizeRecord(record)]));
}

/** The seven core fields of one effective view, projected for closed-world comparisons. */
function coreProjection(fields: EffectiveCapabilityFields): Record<string, EffectiveCapabilityField> {
	return Object.fromEntries(FIELD_NAMES.map((name) => [name, fields[name]]));
}

// --- The frozen closed-world resolver -------------------------------------
// A local copy of the pre-redesign parse, layering, and walk over the core
// seven, built on the shared chain engine with THIS file's frozen parser so
// the live parseCapabilityRecord is not checking itself.

interface FrozenParsed extends ParsedRecord {
	readonly openrouterModel?: string | undefined;
}

function frozenParse(record: Readonly<Record<string, unknown>>): FrozenParsed {
	const fields: Partial<Record<CapabilityFieldName, number | boolean>> = {};
	let openrouterModel: string | undefined;
	for (const [key, value] of Object.entries(record)) {
		if (key === OPENROUTER_MODEL_DIRECTIVE) {
			if (typeof value === "string" && value.trim() !== "") {
				openrouterModel = value;
			}
			continue;
		}
		if (key.startsWith("_") || !Object.hasOwn(CAPABILITY_FIELDS, key)) {
			continue;
		}
		const name = key as CapabilityFieldName;
		if (CAPABILITY_FIELDS[name] === "number") {
			if (typeof value === "number" && Number.isInteger(value) && value > 0) {
				fields[name] = value;
			}
		} else if (typeof value === "boolean") {
			fields[name] = value;
		}
	}
	const fallback = new Set<string>();
	const directive = record[FALLBACK_DIRECTIVE];
	if (directive === true) {
		for (const name of Object.keys(fields)) {
			fallback.add(name);
		}
	} else if (Array.isArray(directive)) {
		for (const name of directive) {
			if (typeof name === "string" && Object.hasOwn(CAPABILITY_FIELDS, name) && Object.hasOwn(fields, name)) {
				fallback.add(name);
			}
		}
	}
	const shared = parseSharedDirectives(record, fields);
	return {
		fields,
		inheritable: shared.inheritable,
		forced: new Set(),
		fallback,
		inheritFrom: shared.inheritFrom,
		diagnostics: [],
		...(openrouterModel !== undefined ? { openrouterModel } : {}),
	};
}

interface FrozenCandidate {
	readonly level: CapabilityLevel;
	readonly key?: string | undefined;
	readonly inheritedFrom?: string | undefined;
	readonly value: number | boolean;
}

/**
 * The frozen walk: per core field, entry override > global override >
 * directive field > server > entry fallback > global fallback > catalog >
 * backstop (floor, or the context-minus-output derivation for
 * max_input_tokens), with the same shadow stacking and provenance rules the
 * old resolver had.
 */
function frozenResolve(input: ResolveModelCapabilitiesInput): {
	fields: Record<string, EffectiveCapabilityField>;
	outputLimitSource: EffectiveOutputLimitSource;
	directive: { kind: "applied" | "not-found"; id: string } | undefined;
} {
	const entry = resolveRecordChain(input.rawModelId, input.entryCapabilities ?? {}, frozenParse);
	const global = resolveRecordChain(input.rawModelId, input.globalCapabilities, frozenParse);
	const directiveId =
		(entry.winner as FrozenParsed | undefined)?.openrouterModel ??
		(global.winner as FrozenParsed | undefined)?.openrouterModel;
	const directiveLookup = directiveId !== undefined ? input.catalog.byExactId(directiveId) : undefined;
	const directive =
		directiveId === undefined
			? undefined
			: directiveLookup?.kind === "found"
				? { kind: "applied" as const, id: directiveId }
				: { kind: "not-found" as const, id: directiveId };
	const directiveFields = directiveLookup?.kind === "found" ? directiveLookup.fields : {};
	const serverValues = input.serverDeclared.kind === "discovered" ? input.serverDeclared.values : {};
	const catalogMatch = input.catalog.byRawModelId(input.rawModelId);

	const layerField = (
		resolution: RecordChainResolution,
		name: CapabilityFieldName,
		wantFallback: boolean
	): { value: number | boolean; key: string; inheritedFrom?: string } | undefined => {
		const field = resolution.fields.get(name);
		if (field === undefined || field.fallback !== wantFallback) {
			return undefined;
		}
		return {
			value: field.value as number | boolean,
			key: field.sourceKey,
			...(resolution.winnerKey !== undefined && field.sourceKey !== resolution.winnerKey
				? { inheritedFrom: field.sourceKey }
				: {}),
		};
	};

	const candidatesFor = (name: CapabilityFieldName): FrozenCandidate[] => {
		const layered: FrozenCandidate[] = [];
		const fromEntry = layerField(entry, name, false);
		if (fromEntry !== undefined) {
			layered.push({ level: "entry", ...fromEntry });
		}
		const fromGlobal = layerField(global, name, false);
		if (fromGlobal !== undefined) {
			layered.push({ level: "global", ...fromGlobal });
		}
		const derived = directiveFields[name];
		if (derived !== undefined && directiveId !== undefined) {
			layered.push({ level: "directive", key: directiveId, value: derived });
		}
		const server = serverValues[name];
		if (server !== undefined) {
			layered.push({ level: "server", value: server });
		}
		const entryFallback = layerField(entry, name, true);
		if (entryFallback !== undefined) {
			layered.push({ level: "entry-fallback", ...entryFallback });
		}
		const globalFallback = layerField(global, name, true);
		if (globalFallback !== undefined) {
			layered.push({ level: "global-fallback", ...globalFallback });
		}
		const catalogValue = catalogMatch.kind === "found" ? catalogMatch.fields[name] : undefined;
		if (catalogValue !== undefined && catalogMatch.kind === "found") {
			layered.push({ level: "catalog", key: catalogMatch.id, value: catalogValue });
		}
		return layered;
	};

	const settle = (
		name: CapabilityFieldName,
		backstop: { level: "derived" | "floor"; value: number | boolean }
	): EffectiveCapabilityField => {
		const [winner, ...shadowed] = candidatesFor(name);
		if (winner === undefined) {
			return { value: backstop.value, level: backstop.level, shadowed: [] };
		}
		return {
			value: winner.value,
			level: winner.level,
			...(winner.key !== undefined ? { key: winner.key } : {}),
			...(winner.inheritedFrom !== undefined ? { inheritedFrom: winner.inheritedFrom } : {}),
			shadowed: shadowed.map((candidate) => ({
				level: candidate.level,
				...(candidate.key !== undefined ? { key: candidate.key } : {}),
				...(candidate.inheritedFrom !== undefined ? { inheritedFrom: candidate.inheritedFrom } : {}),
				value: candidate.value,
			})),
		};
	};

	const contextLength = settle("context_length", { level: "floor", value: CAPABILITY_FLOOR.context_length });
	const maxOutputTokens = settle("max_output_tokens", { level: "floor", value: CAPABILITY_FLOOR.max_output_tokens });
	const maxInputTokens = settle("max_input_tokens", {
		level: "derived",
		value: Math.max(1, (contextLength.value as number) - (maxOutputTokens.value as number)),
	});
	const fields: Record<string, EffectiveCapabilityField> = {
		context_length: contextLength,
		max_input_tokens: maxInputTokens,
		max_output_tokens: maxOutputTokens,
	};
	for (const name of BOOLEAN_FIELD_NAMES) {
		fields[name] = settle(name, { level: "floor", value: CAPABILITY_FLOOR[name] });
	}
	const outputLevel = maxOutputTokens.level;
	const outputLimitSource: EffectiveOutputLimitSource = USER_SET_LEVELS.some((level) => level === outputLevel)
		? "user"
		: outputLevel === "server" && input.serverDeclared.kind === "discovered" && input.serverDeclared.outputDeclared
			? "provider"
			: "defaults";
	return { fields, outputLimitSource, directive };
}

/** Restrict every record of a map to core fields plus underscore directives: a closed-world configuration. */
function coreOnlyRecords(records: ModelCapabilitiesRecord | undefined): ModelCapabilitiesRecord | undefined {
	if (records === undefined) {
		return undefined;
	}
	return Object.fromEntries(
		Object.entries(records).map(([key, record]) => [
			key,
			Object.fromEntries(
				Object.entries(record).filter(([name]) => name.startsWith("_") || Object.hasOwn(CAPABILITY_FIELDS, name))
			),
		])
	);
}

/** Restrict a server baseline to the core seven, mirroring the closed world's typing. */
function coreOnlyServer(serverDeclared: ServerDeclaredCapabilities): ServerDeclaredCapabilities {
	if (serverDeclared.kind === "declared") {
		return serverDeclared;
	}
	return {
		kind: "discovered",
		values: Object.fromEntries(
			Object.entries(serverDeclared.values).filter(([name]) => Object.hasOwn(CAPABILITY_FIELDS, name))
		) as Partial<ServerCapabilityValues>,
		outputDeclared: serverDeclared.outputDeclared,
	};
}

describe("shared/config capabilityResolution properties", () => {
	test("invalid consumed values contribute nothing: sanitizing every record changes no resolved outcome", () => {
		fc.assert(
			fc.property(scenario, ({ input }) => {
				const resolved = resolveCapabilityOverrides(input);
				const sanitized = resolveCapabilityOverrides({
					...input,
					globalCapabilities: sanitizeRecords(input.globalCapabilities) ?? {},
					entryCapabilities: sanitizeRecords(input.entryCapabilities),
				});
				assert.deepStrictEqual(resolved.fields, sanitized.fields);
				assert.deepStrictEqual(resolved.fallbackFields, sanitized.fallbackFields);
				assert.deepStrictEqual(resolved.directive, sanitized.directive);
				assert.deepStrictEqual(resolved.implicitCatalog, sanitized.implicitCatalog);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("the walk is total over the core fields, and the backstops state their formulas", () => {
		fc.assert(
			fc.property(scenario, ({ input }) => {
				const effective = resolveModelCapabilities(input);
				const fields: EffectiveCapabilityFields = effective.fields;
				for (const name of NUMBER_FIELD_NAMES) {
					assert.strictEqual(typeof fields[name].value, "number", `${name} must resolve to a number`);
				}
				for (const name of BOOLEAN_FIELD_NAMES) {
					assert.strictEqual(typeof fields[name].value, "boolean", `${name} must resolve to a boolean`);
					if (fields[name].level === "floor") {
						assert.strictEqual(fields[name].value, CAPABILITY_FLOOR[name]);
					}
				}
				const { context_length, max_output_tokens, max_input_tokens } = fields;
				for (const [name, field] of [
					["context_length", context_length],
					["max_output_tokens", max_output_tokens],
				] as const) {
					if (field.level === "floor") {
						assert.strictEqual(field.value, CAPABILITY_FLOOR[name]);
					}
				}
				assert.notStrictEqual(max_input_tokens.level, "floor", "max_input_tokens derives instead of flooring");
				if (max_input_tokens.level === "derived") {
					assert.strictEqual(max_input_tokens.value, Math.max(1, context_length.value - max_output_tokens.value));
					assert.deepStrictEqual(max_input_tokens.shadowed, [], "the derivation only runs when nothing shadows it");
				}
				// Open fields never take a backstop: whatever resolved carries a
				// real level, and the floor/derived levels stay core-only; the
				// directive and catalog levels carry core catalog fields only.
				for (const [name, field] of Object.entries(fields)) {
					if (field !== undefined && !Object.hasOwn(CAPABILITY_FIELDS, name)) {
						assert.notStrictEqual(field.level, "floor", `${name} has no floor`);
						assert.notStrictEqual(field.level, "derived", `${name} has no derivation`);
						assert.notStrictEqual(field.level, "catalog", "the catalog carries core fields only");
						assert.notStrictEqual(field.level, "directive", "the directive derives core fields only");
					}
				}

				const expectedSource: EffectiveOutputLimitSource = USER_SET_LEVELS.some(
					(level) => level === max_output_tokens.level
				)
					? "user"
					: max_output_tokens.level === "server" &&
							input.serverDeclared.kind === "discovered" &&
							input.serverDeclared.outputDeclared
						? "provider"
						: "defaults";
				assert.strictEqual(effective.outputLimitSource, expectedSource);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("precedence is monotonic: an exact entry override field beats whatever the walk resolved without it", () => {
		const injection = fc.record({
			name: fc.constantFrom(...FIELD_NAMES),
			number: validNumber,
			boolean: fc.boolean(),
		});
		fc.assert(
			fc.property(scenario, injection, ({ input }, { name, number, boolean }) => {
				const value: CapabilityFieldValues[CapabilityFieldName] =
					CAPABILITY_FIELDS[name] === "number" ? number : boolean;
				// The injected field must be an override, so a generated _fallback on
				// the exact record is dropped (a fallback-demoted field sits below
				// server), and so is a generated _inherit_from (an exclusive list
				// could re-import a broader fallback marking onto the same field).
				const {
					[FALLBACK_DIRECTIVE]: _fallback,
					_inherit_from: _inheritFrom,
					...base
				} = input.entryCapabilities?.[input.rawModelId] ?? {};
				const exactRecord = { ...base, [name]: value };
				const effective = resolveModelCapabilities({
					...input,
					entryCapabilities: { ...input.entryCapabilities, [input.rawModelId]: exactRecord },
				});
				assert.strictEqual(effective.fields[name].value, value);
				assert.strictEqual(effective.fields[name].level, "entry");
				assert.strictEqual(effective.fields[name].key, input.rawModelId);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("the overrides resolution and the full walk agree on every field the overrides set", () => {
		fc.assert(
			fc.property(scenario, ({ input }) => {
				const overrides = resolveCapabilityOverrides(input);
				const overrideFields: ResolvedCapabilityOverrideFields = overrides.fields;
				const effective = resolveModelCapabilities(input);
				// Own-property reads throughout (the exported accessor): the bags are
				// plain objects, and a prototype-named field must never read as the
				// inherited member.
				const names = new Set([...FIELD_NAMES, ...Object.keys(overrideFields), ...Object.keys(effective.fields)]);
				for (const name of names) {
					const override: ResolvedCapabilityOverrideField | undefined = capabilityField(overrideFields, name);
					const field = capabilityField(effective.fields, name);
					if (override === undefined) {
						const level: CapabilityLevel | undefined = field?.level;
						assert.ok(
							!OVERRIDE_LEVELS.some((overrideLevel) => overrideLevel === level),
							`${name} resolved at ${level} without an override setting it`
						);
					} else {
						assert.ok(field !== undefined, `${name} has an override but no effective field`);
						assert.strictEqual(field.value, override.value);
						assert.strictEqual(field.level, override.level);
						assert.strictEqual(field.key, override.key);
						assert.deepStrictEqual(field.shadowed.slice(0, override.shadowed.length), override.shadowed);
					}
					// A field the walk resolves at a fallback level is exactly the
					// first fallback candidate - nothing above it carried a value.
					if (field !== undefined && (field.level === "entry-fallback" || field.level === "global-fallback")) {
						const level: CapabilityFallbackLevel = field.level;
						const [candidate] = capabilityField(overrides.fallbackFields, name) ?? [];
						assert.ok(candidate !== undefined, `${name} resolved at ${level} must have a fallback candidate`);
						assert.strictEqual(candidate.level, level);
						assert.strictEqual(candidate.key, field.key);
						assert.strictEqual(candidate.value, field.value);
					}
				}
				assert.deepStrictEqual(effective.directive, overrides.directive);
				assert.deepStrictEqual(effective.diagnostics, overrides.diagnostics);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("restriction: on core-only configurations the live resolver matches the frozen closed-world resolver", () => {
		fc.assert(
			fc.property(scenario, ({ input }) => {
				const restricted: ResolveModelCapabilitiesInput = {
					...input,
					globalCapabilities: coreOnlyRecords(input.globalCapabilities) ?? {},
					entryCapabilities: coreOnlyRecords(input.entryCapabilities),
					serverDeclared: coreOnlyServer(input.serverDeclared),
				};
				const live = resolveModelCapabilities(restricted);
				const frozen = frozenResolve(restricted);
				assert.deepStrictEqual(coreProjection(live.fields), frozen.fields);
				assert.strictEqual(live.outputLimitSource, frozen.outputLimitSource);
				assert.deepStrictEqual(live.directive, frozen.directive);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("extras are inert: arbitrary unknown-key fields never move a core field or the output provenance", () => {
		const extraKey = fc.oneof(
			noSlashKey.filter((key) => !Object.hasOwn(CONSUMED_CAPABILITY_FIELDS, key)),
			fc.constantFrom("toString", "valueOf", "constructor", "hasOwnProperty")
		);
		const extraValue = fc.constantFrom<unknown>(true, 7, "text", ["a"], { nested: [1] }, null);
		const extras = fc.dictionary(extraKey, extraValue, { minKeys: 1, maxKeys: 3 });
		fc.assert(
			fc.property(scenario, extras, ({ input }, injected) => {
				const withExtras = (records: ModelCapabilitiesRecord | undefined): ModelCapabilitiesRecord | undefined =>
					records === undefined
						? undefined
						: Object.fromEntries(Object.entries(records).map(([key, record]) => [key, { ...record, ...injected }]));
				const base = resolveModelCapabilities(input);
				const noisy = resolveModelCapabilities({
					...input,
					globalCapabilities: withExtras(input.globalCapabilities) ?? {},
					entryCapabilities: withExtras(input.entryCapabilities),
				});
				assert.deepStrictEqual(coreProjection(noisy.fields), coreProjection(base.fields));
				assert.strictEqual(noisy.outputLimitSource, base.outputLimitSource);
				assert.deepStrictEqual(noisy.directive, base.directive);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("extras resolve with exact provenance: every user-set extra matches a naive per-field walk", () => {
		fc.assert(
			fc.property(scenario, ({ input }) => {
				const entry = resolveCapabilityLayer(input.rawModelId, input.entryCapabilities ?? {});
				const global = resolveCapabilityLayer(input.rawModelId, input.globalCapabilities);
				const serverValues: Readonly<Record<string, CapabilityJsonValue | undefined>> =
					input.serverDeclared.kind === "discovered" ? input.serverDeclared.values : {};
				const effective = resolveModelCapabilities(input);

				const layerField = (resolution: RecordChainResolution, name: string, wantFallback: boolean) => {
					const field = resolution.fields.get(name);
					if (field === undefined || field.fallback !== wantFallback) {
						return undefined;
					}
					return {
						value: field.value as CapabilityJsonValue,
						key: field.sourceKey,
						inheritedFrom:
							resolution.winnerKey !== undefined && field.sourceKey !== resolution.winnerKey
								? field.sourceKey
								: undefined,
					};
				};
				const naive = (
					name: string
				):
					| {
							value: CapabilityJsonValue;
							level: CapabilityLevel;
							key?: string | undefined;
							inheritedFrom?: string | undefined;
					  }
					| undefined => {
					const entryOverride = layerField(entry, name, false);
					if (entryOverride !== undefined) {
						return { level: "entry", ...entryOverride };
					}
					const globalOverride = layerField(global, name, false);
					if (globalOverride !== undefined) {
						return { level: "global", ...globalOverride };
					}
					// Own-property read: a prototype-named field must not surface
					// Object.prototype's member as a server value.
					const server = capabilityField(serverValues, name);
					if (server !== undefined) {
						return { level: "server", value: server };
					}
					const entryFallback = layerField(entry, name, true);
					if (entryFallback !== undefined) {
						return { level: "entry-fallback", ...entryFallback };
					}
					const globalFallback = layerField(global, name, true);
					if (globalFallback !== undefined) {
						return { level: "global-fallback", ...globalFallback };
					}
					return undefined;
				};

				const extraNames = new Set(
					[...entry.fields.keys(), ...global.fields.keys(), ...Object.keys(serverValues)].filter(
						(name) => !Object.hasOwn(CAPABILITY_FIELDS, name)
					)
				);
				for (const name of extraNames) {
					const expected = naive(name);
					const field = capabilityField(effective.fields, name);
					if (expected === undefined) {
						assert.strictEqual(field, undefined, `${name} resolved with no candidate at any level`);
						continue;
					}
					assert.ok(field !== undefined, `${name} must resolve: a level carries it`);
					assert.deepStrictEqual(field.value, expected.value, name);
					assert.strictEqual(field.level, expected.level, name);
					assert.strictEqual(field.key, expected.key, name);
					assert.strictEqual(field.inheritedFrom, expected.inheritedFrom, name);
				}
				// And nothing else: every non-core effective field is a user-set or
				// server-carried extra from the sets above.
				for (const name of Object.keys(effective.fields)) {
					if (!Object.hasOwn(CAPABILITY_FIELDS, name)) {
						assert.ok(extraNames.has(name), `${name} resolved without any level carrying it`);
					}
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});
