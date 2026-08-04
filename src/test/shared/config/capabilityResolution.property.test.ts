/**
 * The capability resolver's safety argument, mirrored from the
 * parameterResolution property suite: for random capability records (valid
 * and invalid values, directives, scoped and unscoped keys cut from generated
 * raw IDs so matches are the common case), the boundary parse is the only
 * gate - invalid values contribute nothing anywhere, the full walk is total,
 * an injected higher-precedence field always wins, and the overrides
 * resolution and the full walk can never disagree on a field the overrides
 * set. Registration and the dashboard both consume resolveModelCapabilities,
 * so these pins are what keeps the two surfaces from drifting.
 */
import * as assert from "node:assert";
import * as fc from "fast-check";
import type {
	BooleanCapabilityField,
	CapabilityCatalogLookup,
	CapabilityFieldName,
	CapabilityFieldValues,
	CapabilityLevel,
	CapabilityOverrideLevel,
	CatalogLookupResult,
	EffectiveCapabilityFields,
	EffectiveOutputLimitSource,
	ModelCapabilitiesRecord,
	NumberCapabilityField,
	ResolvedCapabilityOverrideField,
	ResolvedCapabilityOverrideFields,
	ResolveModelCapabilitiesInput,
	ServerDeclaredCapabilities,
} from "../../../shared/config/capabilityResolution";
import {
	CAPABILITY_FIELDS,
	CAPABILITY_FLOOR,
	DECLARE_DIRECTIVE,
	extractDeclaredModels,
	OPENROUTER_MODEL_DIRECTIVE,
	resolveCapabilityOverrides,
	resolveModelCapabilities,
} from "../../../shared/config/capabilityResolution";
import { resolveFuzzSeed } from "../../fuzzStream";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 200;
const SEED = resolveFuzzSeed();

const FIELD_NAMES = Object.keys(CAPABILITY_FIELDS) as CapabilityFieldName[];
const NUMBER_FIELD_NAMES = FIELD_NAMES.filter(
	(name): name is NumberCapabilityField => CAPABILITY_FIELDS[name] === "number"
);
const BOOLEAN_FIELD_NAMES = FIELD_NAMES.filter(
	(name): name is BooleanCapabilityField => CAPABILITY_FIELDS[name] === "boolean"
);
const OVERRIDE_LEVELS: readonly CapabilityOverrideLevel[] = ["entry", "global", "directive"];

// Slash-free so a scoped key "<scope>/<prefix>" can never collide with an
// unscoped key or match a scope other than its own.
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

// Values land on kind-matched and kind-mismatched fields alike, so both the
// valid path and the invalid-value fallthrough stay common.
const fieldValueArb = fc.oneof(
	{ arbitrary: validNumber, weight: 3 },
	{ arbitrary: fc.boolean(), weight: 3 },
	{ arbitrary: fc.constantFrom<unknown>("128k", 0, -5, 1.5, null), weight: 2 }
);
const recordKeyArb = fc.oneof(
	{ arbitrary: fc.constantFrom<string>(...FIELD_NAMES), weight: 5 },
	{ arbitrary: noSlashKey, weight: 1 },
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
		})
	)
	.map(([base, declare, openrouterModel]) => ({
		...base,
		...(declare !== undefined ? { [DECLARE_DIRECTIVE]: declare } : {}),
		...(openrouterModel !== undefined ? { [OPENROUTER_MODEL_DIRECTIVE]: openrouterModel } : {}),
	}));

const serverDeclaredArb: fc.Arbitrary<ServerDeclaredCapabilities> = fc.oneof(
	fc.constant<ServerDeclaredCapabilities>({ kind: "declared" }),
	fc
		.record({ values: validFieldsArb, outputDeclared: fc.boolean() })
		.map(({ values, outputDeclared }): ServerDeclaredCapabilities => ({ kind: "discovered", values, outputDeclared }))
);

const tokenDefaultArb = fc.record({ value: validNumber, explicitlyConfigured: fc.boolean() });
const tokenDefaultsArb = fc.record({
	contextLength: tokenDefaultArb,
	maxOutputTokens: tokenDefaultArb,
	maxInputTokens: fc.option(validNumber, { nil: undefined }),
});

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
 * A raw ID plus capability records whose keys are cuts of it (matches are the
 * common case), a cut of an unrelated ID keeping the no-match branch alive,
 * zero-length cuts keeping the empty-key edge alive, directives pointing into
 * and past the generated catalog, and independent server, defaults, and
 * catalog layers.
 */
const scenario: fc.Arbitrary<Scenario> = fc
	.record({
		rawModelId: noSlashKey,
		otherId: noSlashKey,
		globalSpecs: fc.array(
			fc.record({
				cut: fc.nat(),
				foreign: fc.boolean(),
				scope: fc.option(fc.constantFrom(...scopePool), { nil: undefined }),
				record: capabilityRecordArb,
			}),
			{ maxLength: 4 }
		),
		entrySpecs: fc.option(
			fc.array(fc.record({ cut: fc.nat(), foreign: fc.boolean(), record: capabilityRecordArb }), { maxLength: 3 }),
			{ nil: undefined }
		),
		scopes: fc.subarray([...scopePool]),
		catalogOne: fc.option(validFieldsArb, { nil: undefined }),
		catalogTwo: fc.option(validFieldsArb, { nil: undefined }),
		implicitFields: fc.option(validFieldsArb, { nil: undefined }),
		implicitAmbiguous: fc.boolean(),
		serverDeclared: serverDeclaredArb,
		tokenDefaults: tokenDefaultsArb,
	})
	.map((spec) => {
		const prefixOf = (cut: number, foreign: boolean) => {
			const base = foreign ? spec.otherId : spec.rawModelId;
			return base.slice(0, cut % (base.length + 1));
		};
		const globalCapabilities: Record<string, Record<string, unknown>> = {};
		for (const globalSpec of spec.globalSpecs) {
			const prefix = prefixOf(globalSpec.cut, globalSpec.foreign);
			const key = globalSpec.scope === undefined ? prefix : `${globalSpec.scope}/${prefix}`;
			globalCapabilities[key] = globalSpec.record;
		}
		const entryCapabilities =
			spec.entrySpecs === undefined
				? undefined
				: Object.fromEntries(spec.entrySpecs.map((entry) => [prefixOf(entry.cut, entry.foreign), entry.record]));
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
				serverScopes: spec.scopes,
				entryCapabilities,
				catalog,
				serverDeclared: spec.serverDeclared,
				tokenDefaults: spec.tokenDefaults,
			},
		};
	});

/**
 * The independent statement of what parseCapabilityRecord accepts, so the
 * fallthrough property below is not the parser checking itself: keep validly
 * typed capability fields, boolean `_declare`, and non-blank
 * `_openrouter_model`; drop everything else.
 */
function sanitizeRecord(record: Readonly<Record<string, unknown>>): Record<string, unknown> {
	const sanitized: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (key === DECLARE_DIRECTIVE) {
			if (typeof value === "boolean") {
				sanitized[key] = value;
			}
		} else if (key === OPENROUTER_MODEL_DIRECTIVE) {
			if (typeof value === "string" && value.trim() !== "") {
				sanitized[key] = value;
			}
		} else if (Object.hasOwn(CAPABILITY_FIELDS, key)) {
			const kind = CAPABILITY_FIELDS[key as CapabilityFieldName];
			if (
				kind === "number"
					? typeof value === "number" && Number.isInteger(value) && value > 0
					: typeof value === "boolean"
			) {
				sanitized[key] = value;
			}
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

suite("shared/config capabilityResolution properties", () => {
	test("invalid values contribute nothing: sanitizing every record changes no resolved outcome", () => {
		fc.assert(
			fc.property(scenario, ({ input }) => {
				const resolved = resolveCapabilityOverrides(input);
				const sanitized = resolveCapabilityOverrides({
					...input,
					globalCapabilities: sanitizeRecords(input.globalCapabilities) ?? {},
					entryCapabilities: sanitizeRecords(input.entryCapabilities),
				});
				assert.deepStrictEqual(resolved.fields, sanitized.fields);
				assert.deepStrictEqual(resolved.directive, sanitized.directive);
				assert.strictEqual(resolved.declare, sanitized.declare);
				assert.deepStrictEqual(resolved.implicitCatalog, sanitized.implicitCatalog);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("the walk is total: every field resolves with its kind, and the backstops state their formulas", () => {
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

				const expectedSource: EffectiveOutputLimitSource = OVERRIDE_LEVELS.some(
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

	test("precedence is monotonic: an exact entry field beats whatever the walk resolved without it", () => {
		const injection = fc.record({
			name: fc.constantFrom(...FIELD_NAMES),
			number: validNumber,
			boolean: fc.boolean(),
		});
		fc.assert(
			fc.property(scenario, injection, ({ input }, { name, number, boolean }) => {
				const value: CapabilityFieldValues[CapabilityFieldName] =
					CAPABILITY_FIELDS[name] === "number" ? number : boolean;
				const exactRecord = { ...input.entryCapabilities?.[input.rawModelId], [name]: value };
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
				for (const name of FIELD_NAMES) {
					const override: ResolvedCapabilityOverrideField<number | boolean> | undefined = overrideFields[name];
					if (override === undefined) {
						const level: CapabilityLevel = effective.fields[name].level;
						assert.ok(
							!OVERRIDE_LEVELS.some((overrideLevel) => overrideLevel === level),
							`${name} resolved at ${level} without an override setting it`
						);
						continue;
					}
					const field = effective.fields[name];
					assert.strictEqual(field.value, override.value);
					assert.strictEqual(field.level, override.level);
					assert.strictEqual(field.key, override.key);
					assert.deepStrictEqual(field.shadowed.slice(0, override.shadowed.length), override.shadowed);
				}
				assert.deepStrictEqual(effective.directive, overrides.directive);
				assert.strictEqual(effective.declare, overrides.declare);
				assert.deepStrictEqual(effective.replacedUnscoped, overrides.replacedUnscoped);
				assert.deepStrictEqual(effective.diagnostics, overrides.diagnostics);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("declaration and resolution can never disagree about a model being declared", () => {
		fc.assert(
			fc.property(scenario, ({ input }) => {
				const declaredIds = extractDeclaredModels({
					globalCapabilities: input.globalCapabilities,
					serverScopes: input.serverScopes,
					entryCapabilities: input.entryCapabilities,
				}).models.map((model) => model.rawId);
				assert.strictEqual(new Set(declaredIds).size, declaredIds.length, "extraction never emits duplicate IDs");
				assert.strictEqual(resolveCapabilityOverrides(input).declare, declaredIds.includes(input.rawModelId));
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});
