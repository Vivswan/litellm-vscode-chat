/**
 * Cross-layer fuzzer for the open capability vocabulary: the invariants that
 * only hold ACROSS resolver and registration seam - the core seven are
 * independent of every non-core field, unknown fields are inert at
 * registration down to the identity fast path, the effective view matches a
 * naive full-walk oracle (provenance and shadow stacks included), the catalog
 * never prices, user costs beat server costs per field with the 0/0
 * free-vs-undeclared split, and ModelResolutionTable equals the uncached walk
 * across invalidation sequences. Generators aim at the hostile subspaces:
 * prototype-named fields, own "__proto__" keys, -0 costs, 0/0 pairs,
 * ambiguous matchers, and every directive.
 */
import * as assert from "node:assert";
import * as fc from "fast-check";
import type { CapabilityOverrideOptions } from "../../../provider/catalog/capabilityOverrides";
import { applyCapabilityOverrides } from "../../../provider/catalog/capabilityOverrides";
import { normalizeModelItem } from "../../../provider/catalog/discovery";
import type { PreAttachModelInfo } from "../../../provider/catalog/groupModels";
import type { PerTokenCosts } from "../../../provider/catalog/modelCatalog";
import type { ModelPricing } from "../../../provider/catalog/registration";
import { buildModelInfos, pricingFromCosts } from "../../../provider/catalog/registration";
import type { LiteLLMModelItem, LiteLLMProvider } from "../../../provider/catalog/schemas";
import type {
	BooleanCapabilityField,
	CapabilityCatalogLookup,
	CapabilityFieldName,
	CapabilityFieldValues,
	CapabilityJsonValue,
	CapabilityLevel,
	CatalogLookupResult,
	EffectiveCapabilityField,
	EffectiveOutputLimitSource,
	ModelCapabilitiesRecord,
	ParsedCapabilityRecord,
	ResolveModelCapabilitiesInput,
	ServerCapabilityValues,
	ServerDeclaredCapabilities,
} from "../../../shared/config/capabilityResolution";
import {
	CAPABILITY_FIELDS,
	CAPABILITY_FLOOR,
	CONSUMED_CAPABILITY_FIELDS,
	capabilityField,
	EMPTY_CATALOG_LOOKUP,
	resolveCapabilityLayer,
	resolveModelCapabilities,
} from "../../../shared/config/capabilityResolution";
import type { RecordChainResolution } from "../../../shared/config/recordResolution";
import { FALLBACK_DIRECTIVE, OPENROUTER_MODEL_DIRECTIVE } from "../../../shared/config/recordResolution";
import { ModelResolutionTable } from "../../../shared/config/resolutionTable";
import { getCurrencySymbol } from "../../../shared/config/settings";
import { resolveFuzzSeed } from "../../fuzzStream";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 200;
const SEED = resolveFuzzSeed();

const SERVER = { id: "srv1", label: "Default", baseUrl: "http://a.test", apiKey: "k" };
const SCOPE = "http://a.test";

const FIELD_NAMES = Object.keys(CAPABILITY_FIELDS) as CapabilityFieldName[];
const BOOLEAN_FIELD_NAMES = FIELD_NAMES.filter(
	(name): name is BooleanCapabilityField => CAPABILITY_FIELDS[name] === "boolean"
);
const CONSUMED_EXTRA_NAMES = Object.keys(CONSUMED_CAPABILITY_FIELDS).filter(
	(name) => !Object.hasOwn(CAPABILITY_FIELDS, name)
);
// Legal open fields that shadow Object.prototype members.
const PROTOTYPE_NAMES = ["toString", "valueOf", "constructor", "hasOwnProperty"] as const;
const USER_SET_LEVELS: readonly CapabilityLevel[] = ["entry", "global", "entry-fallback", "global-fallback"];

/** The 8 cost fields under their wire names, exhaustive over PerTokenCosts by the satisfies check. */
const COST_FIELD_NAMES = Object.keys({
	input_cost_per_token: true,
	output_cost_per_token: true,
	cache_read_input_token_cost: true,
	cache_creation_input_token_cost: true,
	long_context_input_cost_per_token: true,
	long_context_output_cost_per_token: true,
	long_context_cache_read_input_token_cost: true,
	long_context_cache_creation_input_token_cost: true,
} satisfies Record<keyof PerTokenCosts, true>) as readonly (keyof PerTokenCosts)[];

/** Every pricing field the seam may stamp on a served model, exhaustive over ModelPricing by the satisfies check. */
const MODEL_PRICING_KEYS = Object.keys({
	inputCost: true,
	outputCost: true,
	cacheCost: true,
	cacheWriteCost: true,
	longContextInputCost: true,
	longContextOutputCost: true,
	longContextCacheCost: true,
	longContextCacheWriteCost: true,
	priceCategory: true,
	pricing: true,
} satisfies Record<keyof ModelPricing, true>) as readonly (keyof ModelPricing)[];

// Slash-free so a scoped key can never collide with a plain key, colon-free so
// no cut spells ":cheapest", underscore-free so no field name spells a directive.
const idChar = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789.-");
const modelId = fc.string({ unit: idChar, minLength: 1, maxLength: 10 });

const validNumber = fc.integer({ min: 1, max: 1_000_000 });
// -0 rides JSON.parse("-0") in real settings files, so it belongs in the pool.
const validCost = fc.constantFrom<number>(0, -0, 1e-7, 0.000003, 0.5);

// The two directive IDs the generated catalogs can hold, plus one they never do.
const DIRECTIVE_POOL = ["cat/one", "cat/two", "cat/none"] as const;

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

// Values land on kind-matched and mismatched fields alike, keeping the
// invalid-value and verbatim-extras paths common.
const fieldValueArb = fc.oneof(
	{ arbitrary: validNumber, weight: 3 },
	{ arbitrary: fc.boolean(), weight: 3 },
	{ arbitrary: validCost as fc.Arbitrary<unknown>, weight: 2 },
	{
		arbitrary: fc.constantFrom<unknown>([], ["temperature"], ["reasoning_effort"], ["tools", "reasoning_effort"]),
		weight: 2,
	},
	{ arbitrary: fc.constantFrom<unknown>(-1, 1.5, "128k", null, [""], { nested: [1] }, ""), weight: 2 }
);
const recordKeyArb = fc.oneof(
	{ arbitrary: fc.constantFrom<string>(...FIELD_NAMES), weight: 5 },
	{ arbitrary: fc.constantFrom<string>(...CONSUMED_EXTRA_NAMES), weight: 3 },
	{ arbitrary: modelId, weight: 2 },
	{ arbitrary: fc.constantFrom<string>(...PROTOTYPE_NAMES), weight: 1 }
);

// Keys and values guaranteed OUTSIDE the consumed vocabulary, so the two
// injection properties stay behavior-neutral by construction.
const extraFieldKeyArb = fc.oneof(modelId, fc.constantFrom<string>(...PROTOTYPE_NAMES));
const extraFieldValueArb = fc.constantFrom<unknown>(true, 7, "text", ["a"], { nested: [1] }, null);

/** Object.fromEntries is CreateDataProperty, so "__proto__" becomes an own key, never a prototype write. */
function recordFromEntries(entries: readonly (readonly [string, unknown])[]): Record<string, unknown> {
	return Object.fromEntries(entries);
}

/**
 * One capability record: random fields, an optional own "__proto__" key minted
 * through JSON.parse (the one way a settings file can carry it), and every
 * directive including the wrong-record-type `_force`.
 */
const capabilityRecordArb: fc.Arbitrary<Record<string, unknown>> = fc
	.tuple(
		fc.array(fc.tuple(recordKeyArb, fieldValueArb), { maxLength: 5 }),
		fc.option(fc.constantFrom<unknown>(7, true, { polluted: true }), { nil: undefined }),
		fc.option(fc.oneof(fc.constantFrom<unknown>(...DIRECTIVE_POOL), fc.constantFrom<unknown>("", 7)), {
			nil: undefined,
		}),
		fc.option(
			fc.oneof(
				{ arbitrary: fc.boolean() as fc.Arbitrary<unknown>, weight: 2 },
				{
					arbitrary: fc.subarray([
						...FIELD_NAMES,
						"supports_pdf_input",
						"input_cost_per_token",
					]) as fc.Arbitrary<unknown>,
					weight: 2,
				},
				{ arbitrary: fc.constantFrom<unknown>("yes", 7, null), weight: 1 }
			),
			{ nil: undefined }
		),
		fc.option(
			fc.oneof(
				fc.boolean() as fc.Arbitrary<unknown>,
				fc.subarray([...FIELD_NAMES, "supports_prompt_caching"]) as fc.Arbitrary<unknown>,
				fc.constant<unknown>("all")
			),
			{ nil: undefined }
		),
		fc.option(fc.constantFrom<unknown>(true, false, ["*"], ["missing-key"], [7], "x"), { nil: undefined }),
		fc.option(fc.constantFrom<unknown>(true, ["max_tokens"], "yes"), { nil: undefined })
	)
	.map(([pairs, proto, openrouterModel, fallback, inheritable, inheritFrom, force]) =>
		recordFromEntries([
			...pairs,
			...(proto !== undefined
				? Object.entries(JSON.parse(`{"__proto__": ${JSON.stringify(proto)}}`) as Record<string, unknown>)
				: []),
			...(openrouterModel !== undefined ? [[OPENROUTER_MODEL_DIRECTIVE, openrouterModel] as const] : []),
			...(fallback !== undefined ? [[FALLBACK_DIRECTIVE, fallback] as const] : []),
			...(inheritable !== undefined ? [["_inheritable", inheritable] as const] : []),
			...(inheritFrom !== undefined ? [["_inherit_from", inheritFrom] as const] : []),
			...(force !== undefined ? [["_force", force] as const] : []),
		])
	);

/** A matcher key cut from one of the scenario's IDs: exact, trailing-glob, /regex/, or the catch-all. */
interface KeySpec {
	readonly cut: number;
	readonly foreign: boolean;
	readonly kind: "exact" | "glob" | "regex" | "star";
	readonly iflag: boolean;
}

const keySpecArb: fc.Arbitrary<KeySpec> = fc.record({
	cut: fc.nat(),
	foreign: fc.boolean(),
	kind: fc.constantFrom<KeySpec["kind"]>("exact", "glob", "regex", "star"),
	iflag: fc.boolean(),
});

function keyOf(spec: KeySpec, rawId: string, otherId: string): string {
	if (spec.kind === "star") {
		return "*";
	}
	const base = spec.foreign ? otherId : rawId;
	const prefix = base.slice(0, spec.cut % (base.length + 1));
	if (spec.kind === "glob") {
		return `${prefix}*`;
	}
	if (spec.kind === "regex") {
		// Regex matchers anchor to the whole ID (parseMatcherKey wraps the body in
		// ^(?:...)$), so a prefix needs the dot-star to match like a glob.
		const escaped = prefix.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
		return spec.iflag ? `/${escaped}.*/i` : `/${escaped}.*/`;
	}
	return prefix;
}

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
			const sole = suffixIds[0];
			if (suffixIds.length === 1 && sole !== undefined) {
				return byExactId(sole);
			}
			return suffixIds.length > 1 ? { kind: "ambiguous" } : { kind: "not-found" };
		},
	};
}

/**
 * Server baselines are resolver INPUT here, so unlike the seam's
 * discovery-built baselines they may carry hostile shapes on purpose: the
 * resolver, not the baseline builder, is under test.
 */
const serverValuesArb: fc.Arbitrary<Partial<ServerCapabilityValues>> = fc
	.tuple(
		validFieldsArb,
		fc.record(
			{
				input_cost_per_token: fc.constantFrom(0, -0, 0.000003),
				output_cost_per_token: fc.constantFrom(0, -0, 0.000015),
				cache_read_input_token_cost: fc.constantFrom(0, 0.0000003),
				cache_creation_input_token_cost: fc.constantFrom(0, 0.00000375),
				long_context_input_cost_per_token: fc.constantFrom(0.000003, 0.000006),
				long_context_output_cost_per_token: fc.constantFrom(0.000015, 0.0000225),
				long_context_cache_read_input_token_cost: fc.constantFrom(0.0000003, 0.0000006),
				long_context_cache_creation_input_token_cost: fc.constantFrom(0.00000375, 0.0000075),
				supports_prompt_caching: fc.boolean(),
				supports_pdf_input: fc.boolean(),
				supports_response_schema: fc.boolean(),
				supported_openai_params: fc.constantFrom<readonly string[]>([], ["temperature"], ["reasoning_effort"]),
			},
			{ requiredKeys: [] }
		),
		fc.boolean()
	)
	.map(
		([core, consumed, proto]) =>
			recordFromEntries([
				...Object.entries(core),
				...Object.entries(consumed),
				...(proto ? Object.entries(JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>) : []),
			]) as Partial<ServerCapabilityValues>
	);

const serverDeclaredArb: fc.Arbitrary<ServerDeclaredCapabilities> = fc.oneof(
	fc.constant<ServerDeclaredCapabilities>({ kind: "declared" }),
	fc
		.record({ values: serverValuesArb, outputDeclared: fc.boolean() })
		.map(({ values, outputDeclared }): ServerDeclaredCapabilities => ({ kind: "discovered", values, outputDeclared }))
);

/** A kind-valid value for one consumed field name; open extras take any field value. */
function valueForField(name: string): fc.Arbitrary<unknown> {
	const kind = Object.hasOwn(CONSUMED_CAPABILITY_FIELDS, name) ? CONSUMED_CAPABILITY_FIELDS[name] : undefined;
	switch (kind) {
		case "number":
			return validNumber;
		case "cost":
			return validCost;
		case "boolean":
			return fc.boolean();
		case "string-array":
			return fc.constantFrom<unknown>([], ["temperature"], ["reasoning_effort"]);
		default:
			return fieldValueArb;
	}
}

/**
 * A guaranteed cross-layer collision: one field set by BOTH layers' exact
 * records, optionally `_fallback`-demoted on one side. Without it the random
 * records rarely fight over one field at 200 runs, and the
 * precedence-sensitive properties would only exercise single-layer wins.
 */
interface OverlapSpec {
	readonly name: string;
	readonly entryValue: unknown;
	readonly globalValue: unknown;
	readonly demote: "none" | "entry" | "global";
}

const overlapArb: fc.Arbitrary<OverlapSpec | undefined> = fc.option(
	fc.constantFrom<string>(...FIELD_NAMES, ...CONSUMED_EXTRA_NAMES, "customextra").chain((name) =>
		fc.record({
			name: fc.constant(name),
			entryValue: valueForField(name),
			globalValue: valueForField(name),
			demote: fc.constantFrom<OverlapSpec["demote"]>("none", "entry", "global"),
		})
	),
	{ nil: undefined }
);

interface LayerSpecs {
	readonly rawModelId: string;
	readonly otherId: string;
	readonly globalSpecs: readonly {
		readonly key: KeySpec;
		readonly scoped: boolean;
		readonly record: Record<string, unknown>;
	}[];
	readonly entrySpecs: readonly { readonly key: KeySpec; readonly record: Record<string, unknown> }[] | undefined;
	readonly catalogOne: Partial<CapabilityFieldValues> | undefined;
	readonly catalogTwo: Partial<CapabilityFieldValues> | undefined;
	readonly implicitFields: Partial<CapabilityFieldValues> | undefined;
	readonly implicitAmbiguous: boolean;
	readonly overlap: OverlapSpec | undefined;
}

const layerSpecsArb: fc.Arbitrary<LayerSpecs> = fc.record({
	rawModelId: modelId,
	otherId: modelId,
	globalSpecs: fc.array(fc.record({ key: keySpecArb, scoped: fc.boolean(), record: capabilityRecordArb }), {
		maxLength: 4,
	}),
	entrySpecs: fc.option(fc.array(fc.record({ key: keySpecArb, record: capabilityRecordArb }), { maxLength: 3 }), {
		nil: undefined,
	}),
	catalogOne: fc.option(validFieldsArb, { nil: undefined }),
	catalogTwo: fc.option(validFieldsArb, { nil: undefined }),
	implicitFields: fc.option(validFieldsArb, { nil: undefined }),
	implicitAmbiguous: fc.boolean(),
	overlap: overlapArb,
});

function layerMaps(specs: LayerSpecs): {
	globalCapabilities: ModelCapabilitiesRecord;
	entryCapabilities: ModelCapabilitiesRecord | undefined;
	catalog: CapabilityCatalogLookup;
} {
	const globalCapabilities: Record<string, Record<string, unknown>> = {};
	for (const spec of specs.globalSpecs) {
		const key = keyOf(spec.key, specs.rawModelId, specs.otherId);
		globalCapabilities[spec.scoped ? `${SCOPE}/${key}` : key] = spec.record;
	}
	let entryCapabilities =
		specs.entrySpecs === undefined
			? undefined
			: Object.fromEntries(
					specs.entrySpecs.map((spec) => [keyOf(spec.key, specs.rawModelId, specs.otherId), spec.record])
				);
	if (specs.overlap !== undefined) {
		// The guaranteed collision rides both layers' exact records, so it always
		// matches and always outranks the random chains within its layer.
		const o = specs.overlap;
		globalCapabilities[specs.rawModelId] = {
			...(globalCapabilities[specs.rawModelId] ?? {}),
			[o.name]: o.globalValue,
			...(o.demote === "global" ? { [FALLBACK_DIRECTIVE]: [o.name] } : {}),
		};
		entryCapabilities = {
			...(entryCapabilities ?? {}),
			[specs.rawModelId]: {
				...(entryCapabilities?.[specs.rawModelId] ?? {}),
				[o.name]: o.entryValue,
				...(o.demote === "entry" ? { [FALLBACK_DIRECTIVE]: [o.name] } : {}),
			},
		};
	}
	const catalog = makeCatalog({
		...(specs.catalogOne !== undefined ? { "cat/one": specs.catalogOne } : {}),
		...(specs.catalogTwo !== undefined ? { "cat/two": specs.catalogTwo } : {}),
		...(specs.implicitFields !== undefined ? { [`imp/${specs.rawModelId}`]: specs.implicitFields } : {}),
		...(specs.implicitFields !== undefined && specs.implicitAmbiguous
			? { [`imp2/${specs.rawModelId}`]: specs.implicitFields }
			: {}),
	});
	return { globalCapabilities, entryCapabilities, catalog };
}

const resolverScenario: fc.Arbitrary<{ input: ResolveModelCapabilitiesInput }> = fc
	.record({ specs: layerSpecsArb, serverDeclared: serverDeclaredArb })
	.map(({ specs, serverDeclared }) => {
		const maps = layerMaps(specs);
		return { input: { rawModelId: specs.rawModelId, ...maps, serverDeclared } };
	});

/** The seven core fields of one effective view, projected for core-only comparisons. */
function coreProjection(fields: Readonly<Record<string, EffectiveCapabilityField | undefined>>) {
	return Object.fromEntries(FIELD_NAMES.map((name) => [name, fields[name]]));
}

// --- Seam scenario: real discovery shapes through the real registration path.

// Post-ingest limits are positive numbers or undefined by construction
// (discovery narrows them at the mapping sites); no null survives to here.
const limitValue = fc.option(validNumber, { nil: undefined });
const flagValue = fc.option(fc.oneof(fc.boolean(), fc.constant<null>(null)), { nil: undefined });
const providerCost = fc.option(fc.oneof(fc.constantFrom(0, -0, 0.000003, 0.000015), fc.constant<null>(null)), {
	nil: undefined,
});

const providerArb: fc.Arbitrary<LiteLLMProvider> = fc.record(
	{
		provider: fc.constantFrom("openai", "anthropic", ""),
		status: fc.constant("ok"),
		supports_tools: flagValue,
		context_length: fc.option(validNumber, { nil: undefined }),
		max_tokens: limitValue,
		max_input_tokens: limitValue,
		max_output_tokens: limitValue,
		supports_prompt_caching: flagValue,
		supports_response_schema: flagValue,
		supports_reasoning: flagValue,
		supported_openai_params: fc.option(
			fc.oneof(
				fc.constant<string[]>(["reasoning_effort"]),
				fc.constant<string[]>(["temperature"]),
				fc.constant<null>(null)
			),
			{ nil: undefined }
		),
		input_cost_per_token: providerCost,
		output_cost_per_token: providerCost,
		cache_read_input_token_cost: providerCost,
		cache_creation_input_token_cost: providerCost,
		long_context_input_cost_per_token: fc.option(fc.constantFrom(0.000003, 0.000006), { nil: undefined }),
		long_context_output_cost_per_token: fc.option(fc.constantFrom(0.000015, 0.0000225), { nil: undefined }),
		long_context_cache_read_input_token_cost: fc.option(fc.constantFrom(0.0000003, 0.0000006), { nil: undefined }),
		long_context_cache_creation_input_token_cost: fc.option(fc.constantFrom(0.00000375, 0.0000075), {
			nil: undefined,
		}),
	},
	{ requiredKeys: ["provider", "status"] }
);

const architectureArb = fc.option(fc.record({ input_modalities: fc.subarray(["text", "image", "audio", "pdf"]) }), {
	nil: undefined,
});

const modelShapeArb = fc.oneof(
	fc.constant<{ kind: "bare" }>({ kind: "bare" }),
	providerArb.map((provider) => ({ kind: "deployment" as const, provider })),
	fc.array(providerArb, { minLength: 1, maxLength: 3 }).map((providers) => ({
		kind: "group" as const,
		providers: providers as [LiteLLMProvider, ...LiteLLMProvider[]],
	}))
);

interface SeamScenario {
	readonly items: LiteLLMModelItem[];
	readonly serverCount: number;
	readonly specs: LayerSpecs;
	readonly globalCapabilities: ModelCapabilitiesRecord;
	readonly entryCapabilities: ModelCapabilitiesRecord | undefined;
	readonly catalog: CapabilityCatalogLookup;
}

const seamScenario: fc.Arbitrary<SeamScenario> = fc
	.record({
		specs: layerSpecsArb,
		shape: modelShapeArb,
		architecture: architectureArb,
		serverCount: fc.constantFrom(1, 2),
	})
	.map(({ specs, shape, architecture, serverCount }) => {
		const maps = layerMaps(specs);
		return {
			items: [{ id: specs.rawModelId, shape, architecture }],
			serverCount,
			specs,
			...maps,
		};
	});

function optsFor(s: SeamScenario, catalog: CapabilityCatalogLookup): CapabilityOverrideOptions {
	return {
		globalCapabilities: s.globalCapabilities,
		entryCapabilities: s.entryCapabilities,
		catalog,
		resolution: new ModelResolutionTable(),
		log: () => {},
		logAdvisory: () => {},
	};
}

/** Every registration-consumed projection of one served model, for cross-run stability comparisons. */
function seamProjection(info: PreAttachModelInfo) {
	return {
		maxInputTokens: info.maxInputTokens,
		maxOutputTokens: info.maxOutputTokens,
		toolCalling: Boolean(info.capabilities?.toolCalling),
		imageInput: Boolean(info.capabilities?.imageInput),
		hasReasoningSchema: info.configurationSchema !== undefined,
		supportsPromptCaching: info.litellm.supportsPromptCaching,
		supportsAudioInput: info.litellm.supportsAudioInput === true,
		outputLimitSource: info.litellm.outputLimitSource,
		pricing: Object.fromEntries(MODEL_PRICING_KEYS.map((key) => [key, info[key]])),
	};
}

/** Strip the 8 cost fields from every record of a map, so server costs are the only cost source left. */
function withoutCostFields(records: ModelCapabilitiesRecord | undefined): ModelCapabilitiesRecord | undefined {
	if (records === undefined) {
		return undefined;
	}
	return Object.fromEntries(
		Object.entries(records).map(([key, record]) => [
			key,
			recordFromEntries(
				Object.entries(record).filter(([name]) => !(COST_FIELD_NAMES as readonly string[]).includes(name))
			),
		])
	);
}

suite("provider/catalog capability cross-layer properties", () => {
	test("the core seven are independent of every non-core field: stripping them all changes no core outcome", () => {
		// Stronger than extras-inertness (which only ADDS unknown keys): here
		// every non-core field is REMOVED from both record layers and the server
		// baseline, and the core-seven resolution, the output-limit provenance,
		// and the directive outcome must not move. The open vocabulary is a
		// conservative extension of the closed world along every input axis.
		const restrictRecords = (records: ModelCapabilitiesRecord | undefined): ModelCapabilitiesRecord | undefined =>
			records === undefined
				? undefined
				: Object.fromEntries(
						Object.entries(records).map(([key, record]) => [
							key,
							recordFromEntries(
								Object.entries(record).filter(
									([name]) => name.startsWith("_") || Object.hasOwn(CAPABILITY_FIELDS, name)
								)
							),
						])
					);
		const restrictServer = (serverDeclared: ServerDeclaredCapabilities): ServerDeclaredCapabilities =>
			serverDeclared.kind === "declared"
				? serverDeclared
				: {
						kind: "discovered",
						values: recordFromEntries(
							Object.entries(serverDeclared.values).filter(([name]) => Object.hasOwn(CAPABILITY_FIELDS, name))
						) as Partial<ServerCapabilityValues>,
						outputDeclared: serverDeclared.outputDeclared,
					};
		fc.assert(
			fc.property(resolverScenario, ({ input }) => {
				const full = resolveModelCapabilities(input);
				const stripped = resolveModelCapabilities({
					...input,
					globalCapabilities: restrictRecords(input.globalCapabilities) ?? {},
					entryCapabilities: restrictRecords(input.entryCapabilities),
					serverDeclared: restrictServer(input.serverDeclared),
				});
				assert.deepStrictEqual(coreProjection(full.fields), coreProjection(stripped.fields));
				assert.strictEqual(full.outputLimitSource, stripped.outputLimitSource);
				assert.deepStrictEqual(full.directive, stripped.directive);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("the effective view equals a naive full walk: every field, every level, exact provenance and shadows", () => {
		// The naive full-walk oracle. Per-layer extraction is shared machinery
		// (resolveCapabilityLayer), so what this pins is the eight-level layering
		// ORDER, the resolved field-name universe, the backstops, and the full
		// shadow stacks - which also proves completeness: every user-set field of
		// any ring appears.
		fc.assert(
			fc.property(resolverScenario, ({ input }) => {
				const entry = resolveCapabilityLayer(input.rawModelId, input.entryCapabilities ?? {});
				const global = resolveCapabilityLayer(input.rawModelId, input.globalCapabilities);
				const directiveId =
					(entry.winner as ParsedCapabilityRecord | undefined)?.openrouterModel ??
					(global.winner as ParsedCapabilityRecord | undefined)?.openrouterModel;
				const directiveLookup = directiveId !== undefined ? input.catalog.byExactId(directiveId) : undefined;
				const directiveFields: Readonly<Partial<CapabilityFieldValues>> =
					directiveLookup?.kind === "found" ? directiveLookup.fields : {};
				const serverValues: Readonly<Record<string, CapabilityJsonValue | undefined>> =
					input.serverDeclared.kind === "discovered" ? input.serverDeclared.values : {};
				const catalogMatch = input.catalog.byRawModelId(input.rawModelId);

				const layerField = (resolution: RecordChainResolution, name: string, wantFallback: boolean) => {
					const field = resolution.fields.get(name);
					if (field === undefined || field.fallback !== wantFallback) {
						return undefined;
					}
					return {
						value: field.value as CapabilityJsonValue,
						key: field.sourceKey,
						...(resolution.winnerKey !== undefined && field.sourceKey !== resolution.winnerKey
							? { inheritedBy: resolution.winnerKey }
							: {}),
					};
				};
				interface Candidate {
					readonly level: CapabilityLevel;
					readonly key?: string;
					readonly inheritedBy?: string;
					readonly value: CapabilityJsonValue;
				}
				const candidatesFor = (name: string): Candidate[] => {
					const layered: Candidate[] = [];
					const entryOverride = layerField(entry, name, false);
					if (entryOverride !== undefined) {
						layered.push({ level: "entry", ...entryOverride });
					}
					const globalOverride = layerField(global, name, false);
					if (globalOverride !== undefined) {
						layered.push({ level: "global", ...globalOverride });
					}
					const derived = Object.hasOwn(CAPABILITY_FIELDS, name)
						? directiveFields[name as CapabilityFieldName]
						: undefined;
					if (derived !== undefined && directiveId !== undefined) {
						layered.push({ level: "directive", key: directiveId, value: derived });
					}
					const server = capabilityField(serverValues, name);
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
					const catalogValue =
						catalogMatch.kind === "found" && Object.hasOwn(CAPABILITY_FIELDS, name)
							? catalogMatch.fields[name as CapabilityFieldName]
							: undefined;
					if (catalogValue !== undefined && catalogMatch.kind === "found") {
						layered.push({ level: "catalog", key: catalogMatch.id, value: catalogValue });
					}
					return layered;
				};
				const settle = (
					name: string,
					backstop?: { readonly level: "derived" | "floor"; readonly value: number | boolean }
				): EffectiveCapabilityField | undefined => {
					const [winner, ...shadowed] = candidatesFor(name);
					if (winner === undefined) {
						return backstop === undefined ? undefined : { value: backstop.value, level: backstop.level, shadowed: [] };
					}
					return {
						value: winner.value,
						level: winner.level,
						...(winner.key !== undefined ? { key: winner.key } : {}),
						...(winner.inheritedBy !== undefined ? { inheritedBy: winner.inheritedBy } : {}),
						shadowed: shadowed.map((candidate) => ({
							level: candidate.level,
							...(candidate.key !== undefined ? { key: candidate.key } : {}),
							...(candidate.inheritedBy !== undefined ? { inheritedBy: candidate.inheritedBy } : {}),
							value: candidate.value,
						})),
					};
				};

				const contextLength = settle("context_length", { level: "floor", value: CAPABILITY_FLOOR.context_length });
				const maxOutputTokens = settle("max_output_tokens", {
					level: "floor",
					value: CAPABILITY_FLOOR.max_output_tokens,
				});
				assert.ok(contextLength !== undefined && maxOutputTokens !== undefined);
				const maxInputTokens = settle("max_input_tokens", {
					level: "derived",
					value: Math.max(1, (contextLength.value as number) - (maxOutputTokens.value as number)),
				});
				const naiveFields: Record<string, EffectiveCapabilityField> = {
					context_length: contextLength,
					max_output_tokens: maxOutputTokens,
					...(maxInputTokens !== undefined ? { max_input_tokens: maxInputTokens } : {}),
				};
				for (const name of BOOLEAN_FIELD_NAMES) {
					const field = settle(name, { level: "floor", value: CAPABILITY_FLOOR[name] });
					if (field !== undefined) {
						naiveFields[name] = field;
					}
				}
				const openNames = new Set(
					[...entry.fields.keys(), ...global.fields.keys(), ...Object.keys(serverValues)].filter(
						(name) => !Object.hasOwn(CAPABILITY_FIELDS, name) && !name.startsWith("_")
					)
				);
				for (const name of openNames) {
					const field = settle(name);
					if (field !== undefined) {
						naiveFields[name] = field;
					}
				}

				const effective = resolveModelCapabilities(input);
				// Compared WITHOUT copying, so deepStrictEqual's prototype check stays
				// live: a lost "__proto__" skip would rewrite the result's prototype,
				// and a spread here would launder that back to Object.prototype.
				assert.strictEqual(Object.getPrototypeOf(effective.fields), Object.prototype);
				assert.deepStrictEqual(effective.fields, naiveFields);
				// Completeness: the chains' every field name appears in the view.
				for (const name of [...entry.fields.keys(), ...global.fields.keys()]) {
					assert.ok(capabilityField(effective.fields, name) !== undefined, `${name} is user-set and must resolve`);
				}
				const outputLevel = naiveFields.max_output_tokens?.level;
				const expectedSource: EffectiveOutputLimitSource = USER_SET_LEVELS.some((level) => level === outputLevel)
					? "user"
					: outputLevel === "server" &&
							input.serverDeclared.kind === "discovered" &&
							input.serverDeclared.outputDeclared
						? "provider"
						: "defaults";
				assert.strictEqual(effective.outputLimitSource, expectedSource);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("unknown fields are inert at registration: injecting them changes no registration-consumed projection", () => {
		const extrasArb = fc
			.tuple(fc.array(fc.tuple(extraFieldKeyArb, extraFieldValueArb), { minLength: 1, maxLength: 3 }), fc.boolean())
			.map(([pairs, proto]) =>
				recordFromEntries([
					...pairs,
					...(proto ? Object.entries(JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>) : []),
				])
			);
		fc.assert(
			fc.property(seamScenario, extrasArb, (s, extras) => {
				const inject = (records: ModelCapabilitiesRecord | undefined): ModelCapabilitiesRecord | undefined =>
					records === undefined
						? undefined
						: Object.fromEntries(
								Object.entries(records).map(([key, record]) => [
									key,
									recordFromEntries([...Object.entries(record), ...Object.entries(extras)]),
								])
							);
				const { infos } = buildModelInfos(s.items, SERVER, s.serverCount, () => {});
				const served = applyCapabilityOverrides(infos, SERVER, optsFor(s, s.catalog));
				const noisy = applyCapabilityOverrides(infos, SERVER, {
					...optsFor(s, s.catalog),
					globalCapabilities: inject(s.globalCapabilities) ?? {},
					entryCapabilities: inject(s.entryCapabilities),
				});
				assert.strictEqual(noisy.length, served.length);
				for (const [index, info] of served.entries()) {
					assert.deepStrictEqual(seamProjection(noisy[index] as PreAttachModelInfo), seamProjection(info));
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("an extras-only configuration takes the identity fast path: the served array is the input array", () => {
		// supports_pdf_input and supports_response_schema resolve and display but
		// gate no registered artifact yet, so they ride with the unknown keys: a
		// configuration touching only non-registration-consumed fields must not
		// rebuild anything.
		const extrasRecordArb = fc
			.tuple(
				fc.array(fc.tuple(extraFieldKeyArb, extraFieldValueArb), { maxLength: 3 }),
				fc.record({ supports_pdf_input: fc.boolean(), supports_response_schema: fc.boolean() }, { requiredKeys: [] }),
				fc.option(fc.boolean(), { nil: undefined })
			)
			.map(([pairs, consumed, fallback]) =>
				recordFromEntries([
					...pairs,
					...Object.entries(consumed),
					...(fallback !== undefined ? [[FALLBACK_DIRECTIVE, fallback] as const] : []),
				])
			);
		fc.assert(
			fc.property(
				seamScenario,
				fc.array(fc.record({ key: keySpecArb, record: extrasRecordArb }), { minLength: 1, maxLength: 3 }),
				(s, extraSpecs) => {
					const { infos } = buildModelInfos(s.items, SERVER, s.serverCount, () => {});
					const emptyOpts: CapabilityOverrideOptions = {
						globalCapabilities: {},
						catalog: EMPTY_CATALOG_LOOKUP,
						resolution: new ModelResolutionTable(),
						log: () => {},
						logAdvisory: () => {},
					};
					// One normalizing pass so the extras pass below starts from models
					// that already advertise their baseline; a second zero-config pass
					// must already be the identity, or the fast path never engages in
					// production at all.
					const base = applyCapabilityOverrides(infos, SERVER, emptyOpts);
					assert.strictEqual(
						applyCapabilityOverrides(base, SERVER, emptyOpts),
						base,
						"a normalized zero-config pass must take the identity fast path"
					);
					const extrasOnly: CapabilityOverrideOptions = {
						globalCapabilities: Object.fromEntries(
							extraSpecs.map((spec) => [keyOf(spec.key, s.specs.rawModelId, s.specs.otherId), spec.record])
						),
						entryCapabilities: Object.fromEntries(
							extraSpecs.map((spec) => [keyOf(spec.key, s.specs.rawModelId, s.specs.otherId), spec.record])
						),
						catalog: EMPTY_CATALOG_LOOKUP,
						resolution: new ModelResolutionTable(),
						log: () => {},
						logAdvisory: () => {},
					};
					const served = applyCapabilityOverrides(base, SERVER, extrasOnly);
					assert.strictEqual(served, base, "an extras-only pass must return the input array by identity");
				}
			),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("pricing is catalog-invariant: swapping the whole catalog moves no pricing field on any served model", () => {
		fc.assert(
			fc.property(seamScenario, (s) => {
				const { infos } = buildModelInfos(s.items, SERVER, s.serverCount, () => {});
				const withCatalog = applyCapabilityOverrides(infos, SERVER, optsFor(s, s.catalog));
				const withoutCatalog = applyCapabilityOverrides(infos, SERVER, optsFor(s, EMPTY_CATALOG_LOOKUP));
				assert.strictEqual(withCatalog.length, withoutCatalog.length);
				for (const [index, info] of withCatalog.entries()) {
					const twin = withoutCatalog[index] as PreAttachModelInfo;
					assert.strictEqual(info.id, twin.id);
					assert.deepStrictEqual(
						Object.fromEntries(MODEL_PRICING_KEYS.map((key) => [key, info[key]])),
						Object.fromEntries(MODEL_PRICING_KEYS.map((key) => [key, twin[key]])),
						`${info.id}: pricing must not depend on the catalog`
					);
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("the catalog never prices: no costs anywhere means no pricing, and unjustified pricing strips", () => {
		// Providers carry no costs at all - the post-ingest shape of both "the
		// server declared nothing" and LiteLLM's 0/0 stamp, which discovery maps
		// to undefined at the mapping sites (pinned in discovery.test.ts) - and
		// every record is cost-stripped while the catalog stays rich: no served
		// model may carry pricing. And a stale copy carrying price fields the walk
		// does not derive strips on re-serve, then settles.
		fc.assert(
			fc.property(seamScenario, fc.boolean(), (s, addDirective) => {
				const costFree = (provider: LiteLLMProvider): LiteLLMProvider => ({
					...provider,
					input_cost_per_token: undefined,
					output_cost_per_token: undefined,
					cache_read_input_token_cost: undefined,
					cache_creation_input_token_cost: undefined,
					long_context_input_cost_per_token: undefined,
					long_context_output_cost_per_token: undefined,
					long_context_cache_read_input_token_cost: undefined,
					long_context_cache_creation_input_token_cost: undefined,
				});
				const items = s.items.map((item) => ({
					...item,
					shape:
						item.shape.kind === "deployment"
							? { kind: "deployment" as const, provider: costFree(item.shape.provider) }
							: item.shape.kind === "group"
								? {
										kind: "group" as const,
										providers: item.shape.providers.map(costFree) as [LiteLLMProvider, ...LiteLLMProvider[]],
									}
								: item.shape,
				}));
				const globalCapabilities = {
					...(withoutCostFields(s.globalCapabilities) ?? {}),
					...(addDirective ? { "*": { [OPENROUTER_MODEL_DIRECTIVE]: "cat/one" } } : {}),
				};
				const opts: CapabilityOverrideOptions = {
					globalCapabilities,
					entryCapabilities: withoutCostFields(s.entryCapabilities),
					// The cost keys smuggled past the type are the point: a catalog that
					// VIOLATES the core-fields-only contract must still never price.
					catalog: makeCatalog({
						"cat/one": { max_output_tokens: 512, input_cost_per_token: 0.5, output_cost_per_token: 0.5 } as never,
						[`imp/${s.specs.rawModelId}`]: { input_cost_per_token: 0.25, output_cost_per_token: 0.25 } as never,
					}),
					resolution: new ModelResolutionTable(),
					log: () => {},
					logAdvisory: () => {},
				};
				const { infos } = buildModelInfos(items, SERVER, s.serverCount, () => {});
				const served = applyCapabilityOverrides(infos, SERVER, opts);
				for (const info of served) {
					for (const key of MODEL_PRICING_KEYS) {
						assert.strictEqual(info[key], undefined, `${info.id}: ${key} must stay unset without any cost source`);
					}
				}
				// The stale-copy path: forge pricing the walk does not derive, and the
				// verified rebuild strips it. Strict identity is asserted where the
				// fast path is reachable (the extras-only property); here a directive
				// or a matching record may legitimately keep the rebuild path.
				const stale = served.map(
					(info): PreAttachModelInfo => ({
						...info,
						inputCost: 7,
						outputCost: 13,
						pricing: "$7 in / $13 out per 1M tokens",
					})
				);
				const healed = applyCapabilityOverrides(stale, SERVER, opts);
				for (const info of healed) {
					for (const key of MODEL_PRICING_KEYS) {
						assert.strictEqual(info[key], undefined, `${info.id}: unjustified ${key} must strip on re-serve`);
					}
				}
				assert.deepStrictEqual(
					applyCapabilityOverrides(healed, SERVER, opts),
					healed,
					"the healed copies are settled: a second pass changes nothing"
				);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("user costs beat server costs per field: served pricing derives from the field-wise merge exactly", () => {
		const userCostsArb = fc
			.uniqueArray(fc.tuple(fc.constantFrom<keyof PerTokenCosts>(...COST_FIELD_NAMES), validCost), {
				maxLength: 4,
				selector: ([name]) => name,
			})
			.map((pairs) => Object.fromEntries(pairs) as Partial<Record<keyof PerTokenCosts, number>>);
		fc.assert(
			fc.property(seamScenario, userCostsArb, (s, userCosts) => {
				// Records are cost-stripped and the catch-all entry record carries the
				// user costs, so per field the effective cost is exactly: user record
				// else the model's own server baseline.
				const opts: CapabilityOverrideOptions = {
					globalCapabilities: withoutCostFields(s.globalCapabilities) ?? {},
					entryCapabilities: { "*": { ...userCosts } },
					catalog: s.catalog,
					resolution: new ModelResolutionTable(),
					log: () => {},
					logAdvisory: () => {},
				};
				const { infos } = buildModelInfos(s.items, SERVER, s.serverCount, () => {});
				const served = applyCapabilityOverrides(infos, SERVER, opts);
				for (const info of served) {
					const baseline = info.litellm.serverDeclared;
					const merged: { -readonly [K in keyof PerTokenCosts]?: number } = {};
					for (const name of COST_FIELD_NAMES) {
						const user = userCosts[name];
						// The parse canonicalizes a user-written -0 to +0 ("free" never
						// rides a negative sign); mirror that rule here.
						const fromUser = user !== undefined ? (user === 0 ? 0 : user) : undefined;
						const fromServer =
							baseline.kind === "discovered"
								? (capabilityField(baseline.values, name) as number | undefined)
								: undefined;
						const value = fromUser ?? fromServer;
						if (value !== undefined) {
							merged[name] = value;
						}
					}
					// Production prices with the ambient usage.currencySymbol, so the
					// expectation reads the same getter rather than assuming a default.
					const expected = pricingFromCosts(merged, getCurrencySymbol());
					for (const key of MODEL_PRICING_KEYS) {
						assert.ok(
							Object.is(info[key], expected[key]),
							`${info.id}: ${key} must equal the field-wise user-over-server merge (got ${String(
								info[key]
							)}, want ${String(expected[key])})`
						);
					}
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("a user 0/0 pair prices as free; the server's 0/0 stamp prices as nothing", () => {
		const zero = fc.constantFrom(0, -0);
		fc.assert(
			fc.property(seamScenario, zero, zero, fc.boolean(), (s, zin, zout, userPair) => {
				if (userPair) {
					// A user-written pair (possibly -0) is genuinely free: $0/$0 with the
					// label and the cheapest badge, never a negative zero on the wire.
					const opts: CapabilityOverrideOptions = {
						globalCapabilities: withoutCostFields(s.globalCapabilities) ?? {},
						entryCapabilities: { "*": { input_cost_per_token: zin, output_cost_per_token: zout } },
						catalog: s.catalog,
						resolution: new ModelResolutionTable(),
						log: () => {},
						logAdvisory: () => {},
					};
					const { infos } = buildModelInfos(s.items, SERVER, s.serverCount, () => {});
					for (const info of applyCapabilityOverrides(infos, SERVER, opts)) {
						assert.ok(Object.is(info.inputCost, 0), `${info.id}: a user 0/0 pair must price inputCost as +0`);
						assert.ok(Object.is(info.outputCost, 0), `${info.id}: a user 0/0 pair must price outputCost as +0`);
						assert.strictEqual(typeof info.pricing, "string", `${info.id}: the free pair carries the $0 label`);
						assert.strictEqual(info.priceCategory, "low", `${info.id}: the free pair carries the cheapest badge`);
					}
				} else {
					// The server stamps the pair on the WIRE (LiteLLM's
					// undeclared-pricing shape): the production ingest
					// (normalizeModelItem) maps every cost field to undefined, so no
					// pricing appears anywhere downstream.
					const items = s.items.map((item) =>
						normalizeModelItem(
							{
								id: item.id,
								providers: [
									{
										provider: "openai",
										status: "ok",
										supports_tools: true,
										input_cost_per_token: zin,
										output_cost_per_token: zout,
										cache_read_input_token_cost: 0.0000003,
									},
								],
							},
							() => {}
						)
					);
					const opts: CapabilityOverrideOptions = {
						globalCapabilities: withoutCostFields(s.globalCapabilities) ?? {},
						entryCapabilities: withoutCostFields(s.entryCapabilities),
						catalog: s.catalog,
						resolution: new ModelResolutionTable(),
						log: () => {},
						logAdvisory: () => {},
					};
					const { infos } = buildModelInfos(items, SERVER, s.serverCount, () => {});
					for (const info of applyCapabilityOverrides(infos, SERVER, opts)) {
						for (const key of MODEL_PRICING_KEYS) {
							assert.strictEqual(info[key], undefined, `${info.id}: the server 0/0 stamp must price ${key} as unset`);
						}
					}
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("the resolution table equals the uncached walk across cache-invalidation sequences", () => {
		const stepArb = fc.record({
			server: fc.constantFrom("s1", "s2"),
			// 0-2 hit the shared ID every config's records target; 3 misses.
			id: fc.nat({ max: 3 }),
			config: fc.nat({ max: 2 }),
			serverDeclared: fc.nat({ max: 2 }),
			catalog: fc.nat({ max: 1 }),
			op: fc.constantFrom<"none" | "prune" | "clear">("none", "none", "none", "prune", "clear"),
			pruneTarget: fc.constantFrom("s1", "s2"),
		});
		const sequenceArb = fc.record({
			sharedId: modelId,
			extraId: modelId,
			specs: fc.array(layerSpecsArb, { minLength: 3, maxLength: 3 }),
			serverDeclareds: fc.array(serverDeclaredArb, { minLength: 3, maxLength: 3 }),
			steps: fc.array(stepArb, { minLength: 1, maxLength: 10 }),
		});
		fc.assert(
			fc.property(sequenceArb, ({ sharedId, extraId, specs, serverDeclareds, steps }) => {
				// Every config's matchers, overlap, and implicit catalog entries are
				// rebuilt around ONE shared ID, so switching configs between steps
				// really changes what the queried model resolves to - the staleness a
				// broken fingerprint or probe replay would serve.
				const configs = specs.map((spec) => layerMaps({ ...spec, rawModelId: sharedId }));
				// The miss leg must stay a distinct ID even when the generator collides
				// the two.
				const missId = extraId === sharedId ? `${sharedId}-x` : extraId;
				const table = new ModelResolutionTable();
				for (const step of steps) {
					const rawModelId = step.id === 3 ? missId : sharedId;
					const config = configs[step.config] as (typeof configs)[number];
					const serverDeclared = serverDeclareds[step.serverDeclared] as ServerDeclaredCapabilities;
					const catalog = step.catalog === 0 ? config.catalog : EMPTY_CATALOG_LOOKUP;
					if (step.op === "prune") {
						// The target is independent of the queried server, so both the
						// evicted and the surviving side of a prune get exercised.
						table.prune([step.pruneTarget]);
					} else if (step.op === "clear") {
						table.clear();
					}
					const inputs = {
						globalCapabilities: config.globalCapabilities,
						entryCapabilities: config.entryCapabilities,
						serverDeclared,
						catalog,
					};
					const tabled = table.resolveCapabilities(step.server, rawModelId, inputs);
					// The memo itself: an immediate repeat with identical inputs must
					// serve the cached object, not recompute an equal copy.
					assert.strictEqual(table.resolveCapabilities(step.server, rawModelId, inputs), tabled);
					const direct = resolveModelCapabilities({
						rawModelId,
						globalCapabilities: config.globalCapabilities,
						entryCapabilities: config.entryCapabilities,
						serverDeclared,
						catalog,
					});
					assert.deepStrictEqual(tabled, direct);
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});
