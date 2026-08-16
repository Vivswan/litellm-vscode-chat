/**
 * The registration-side equivalence twin of the capabilityResolution property suite: for
 * generated discovery shapes run through the REAL registration path and generated
 * capability records, the models applyCapabilityOverrides serves advertise exactly what
 * resolveModelCapabilities resolves - on the rebuilt path AND on the object-identity fast
 * path, which is the claim that lets untouched models skip the rebuild.
 * synthesizeDeclaredModels is pinned to the same walk over the declared baseline, and the
 * whole application is idempotent because the untouched baseline rides each model.
 */
import * as assert from "node:assert";
import * as fc from "fast-check";
import type { CapabilityOverrideOptions } from "../../../provider/catalog/capabilityOverrides";
import {
	applyCapabilityOverrides,
	pricingFieldsFromEffective,
	reasoningGate,
	synthesizeDeclaredModels,
} from "../../../provider/catalog/capabilityOverrides";
import type { PreAttachModelInfo } from "../../../provider/catalog/groupModels";
import { rawModelIdFromExposed } from "../../../provider/catalog/modelCatalog";
import { buildModelInfos } from "../../../provider/catalog/registration";
import type { LiteLLMModelItem, LiteLLMProvider } from "../../../provider/catalog/schemas";
import type {
	CapabilityCatalogLookup,
	CapabilityFieldValues,
	CatalogLookupResult,
	EffectiveCapabilities,
	ModelCapabilitiesRecord,
} from "../../../shared/config/capabilityResolution";
import {
	capabilityField,
	OPENROUTER_MODEL_DIRECTIVE,
	resolveModelCapabilities,
} from "../../../shared/config/capabilityResolution";
import { ModelResolutionTable } from "../../../shared/config/resolutionTable";
import { getCurrencySymbol } from "../../../shared/config/settings";
import { resolveFuzzSeed } from "../../fuzzStream";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 200;
const SEED = resolveFuzzSeed();

const SERVER = { id: "srv1", label: "Default", baseUrl: "http://a.test", apiKey: "k" };
const SCOPE = "http://a.test";

// Slash-free so a scoped key "<scope>/<prefix>" can never collide with an
// unscoped key or match a foreign scope; colon-free so no cut of a raw ID
// spells a synthetic ":cheapest" variant.
const idChar = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789.-");
const modelId = fc.string({ unit: idChar, minLength: 1, maxLength: 10 });

const validNumber = fc.integer({ min: 1, max: 1_000_000 });
const limitValue = fc.option(fc.oneof(validNumber, fc.constant<null>(null)), { nil: undefined });
const flagValue = fc.option(fc.oneof(fc.boolean(), fc.constant<null>(null)), { nil: undefined });

const providerArb: fc.Arbitrary<LiteLLMProvider> = fc.record(
	{
		provider: fc.constantFrom("openai", "anthropic", ""),
		status: fc.constant("ok"),
		supports_tools: flagValue,
		context_length: fc.option(validNumber, { nil: undefined }),
		max_tokens: limitValue,
		max_input_tokens: limitValue,
		max_output_tokens: limitValue,
		// The internal marker deployment merging authors; generated so merged
		// provider shapes (declared values with a demoted source) stay covered.
		output_limit_source: fc.option(fc.constantFrom<"provider" | "defaults">("provider", "defaults"), {
			nil: undefined,
		}),
		supports_prompt_caching: flagValue,
		supports_response_schema: flagValue,
		supports_reasoning: flagValue,
		supported_openai_params: fc.option(
			fc.oneof(fc.constant<string[]>(["reasoning_effort"]), fc.constant<string[]>(["temperature"]), fc.constant(null)),
			{ nil: undefined }
		),
		input_cost_per_token: fc.option(fc.oneof(fc.constant(0), fc.constant(0.000003), fc.constant(null)), {
			nil: undefined,
		}),
		output_cost_per_token: fc.option(fc.oneof(fc.constant(0), fc.constant(0.000015), fc.constant(null)), {
			nil: undefined,
		}),
		cache_read_input_token_cost: fc.option(fc.oneof(fc.constant(0), fc.constant(0.0000003), fc.constant(null)), {
			nil: undefined,
		}),
		cache_creation_input_token_cost: fc.option(fc.oneof(fc.constant(0), fc.constant(0.00000375), fc.constant(null)), {
			nil: undefined,
		}),
		long_context_input_cost_per_token: fc.option(fc.oneof(fc.constant(0.000003), fc.constant(0.000006)), {
			nil: undefined,
		}),
		long_context_output_cost_per_token: fc.option(fc.oneof(fc.constant(0.000015), fc.constant(0.0000225)), {
			nil: undefined,
		}),
	},
	{ requiredKeys: ["provider", "status"] }
);

const architectureArb = fc.option(fc.record({ input_modalities: fc.subarray(["text", "image", "audio", "pdf"]) }), {
	nil: undefined,
});

const modelItemArb = (id: string): fc.Arbitrary<LiteLLMModelItem> =>
	fc
		.tuple(
			fc.oneof(
				fc.constant<{ kind: "bare" }>({ kind: "bare" }),
				providerArb.map((provider) => ({ kind: "deployment" as const, provider })),
				fc.array(providerArb, { minLength: 1, maxLength: 3 }).map((providers) => ({
					kind: "group" as const,
					providers: providers as [LiteLLMProvider, ...LiteLLMProvider[]],
				}))
			),
			architectureArb
		)
		.map(([shape, architecture]) => ({ id, shape, architecture }));

// The catalog IDs directives can point at (one miss kept alive), plus an
// implicit entry keyed by the model's own raw ID under a vendor prefix.
const DIRECTIVE_POOL = ["cat/one", "cat/none"] as const;

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

const fieldValueArb = fc.oneof(
	{ arbitrary: validNumber, weight: 3 },
	{ arbitrary: fc.boolean(), weight: 3 },
	// Valid cost and params-list values, so the consumed cost/caching/params
	// fields get well-typed user overrides alongside the invalid noise.
	{ arbitrary: fc.constantFrom<unknown>(0, 0.000001, 0.000003), weight: 2 },
	{
		arbitrary: fc.constantFrom<unknown>(["reasoning_effort"], ["temperature"], ["reasoning_effort", "temperature"], []),
		weight: 2,
	},
	{ arbitrary: fc.constantFrom<unknown>("128k", 0, -5, 1.5, null), weight: 1 }
);
const recordKeyArb = fc.oneof(
	{
		arbitrary: fc.constantFrom<string>(
			"context_length",
			"max_input_tokens",
			"max_output_tokens",
			"supports_function_calling",
			"supports_vision",
			"supports_reasoning",
			"supports_audio_input",
			"supports_prompt_caching",
			"supported_openai_params",
			"input_cost_per_token",
			"output_cost_per_token",
			"cache_read_input_token_cost",
			"long_context_input_cost_per_token"
		),
		weight: 5,
	},
	{ arbitrary: modelId, weight: 1 }
);
const capabilityRecordArb: fc.Arbitrary<Record<string, unknown>> = fc
	.tuple(
		fc.dictionary(recordKeyArb, fieldValueArb, { maxKeys: 4 }),
		fc.option(fc.boolean(), { nil: undefined }),
		fc.option(fc.boolean(), { nil: undefined }),
		fc.option(fc.constantFrom<string>(...DIRECTIVE_POOL), { nil: undefined })
	)
	.map(([base, declare, fallback, openrouterModel]) => ({
		...base,
		// The retired _declare directive stays as inert underscore-key noise;
		// _fallback: true demotes every kept field below the server level.
		...(declare !== undefined ? { _declare: declare } : {}),
		...(fallback !== undefined ? { _fallback: fallback } : {}),
		...(openrouterModel !== undefined ? { [OPENROUTER_MODEL_DIRECTIVE]: openrouterModel } : {}),
	}));

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

interface Scenario {
	readonly items: LiteLLMModelItem[];
	readonly serverCount: number;
	readonly opts: CapabilityOverrideOptions;
	readonly globalCapabilities: ModelCapabilitiesRecord;
	readonly entryCapabilities: ModelCapabilitiesRecord | undefined;
	readonly catalog: CapabilityCatalogLookup;
}

const scenario: fc.Arbitrary<Scenario> = fc
	.record({
		rawModelId: modelId,
		otherId: modelId,
		item: modelId.chain(modelItemArb),
		serverCount: fc.constantFrom(1, 2),
		globalSpecs: fc.array(
			fc.record({
				cut: fc.nat(),
				foreign: fc.boolean(),
				glob: fc.boolean(),
				scoped: fc.boolean(),
				record: capabilityRecordArb,
			}),
			{ maxLength: 3 }
		),
		entrySpecs: fc.option(
			fc.array(fc.record({ cut: fc.nat(), foreign: fc.boolean(), glob: fc.boolean(), record: capabilityRecordArb }), {
				maxLength: 2,
			}),
			{ nil: undefined }
		),
		catalogOne: fc.option(validFieldsArb, { nil: undefined }),
		implicitFields: fc.option(validFieldsArb, { nil: undefined }),
		// Which of the scenario's IDs the entry declares (discovery.declared):
		// the discovered ID keeps the inertness branch alive, the other ID the
		// synthesis branch.
		declareRaw: fc.boolean(),
		declareOther: fc.boolean(),
	})
	.map((spec) => {
		const item = { ...spec.item, id: spec.rawModelId };
		// A cut of the raw ID plus "*" is a matching glob; without the star it is
		// an exact key. The empty non-glob cut stays in the language as the
		// invalid "" key, and the scoped form keeps the inert URL keys alive.
		const prefixOf = (cut: number, foreign: boolean, glob: boolean) => {
			const base = foreign ? spec.otherId : spec.rawModelId;
			return `${base.slice(0, cut % (base.length + 1))}${glob ? "*" : ""}`;
		};
		const globalCapabilities: Record<string, Record<string, unknown>> = {};
		for (const globalSpec of spec.globalSpecs) {
			const prefix = prefixOf(globalSpec.cut, globalSpec.foreign, globalSpec.glob);
			globalCapabilities[globalSpec.scoped ? `${SCOPE}/${prefix}` : prefix] = globalSpec.record;
		}
		const entryCapabilities =
			spec.entrySpecs === undefined
				? undefined
				: Object.fromEntries(
						spec.entrySpecs.map((entry) => [prefixOf(entry.cut, entry.foreign, entry.glob), entry.record])
					);
		const catalog = makeCatalog({
			...(spec.catalogOne !== undefined ? { "cat/one": spec.catalogOne } : {}),
			...(spec.implicitFields !== undefined ? { [`imp/${spec.rawModelId}`]: spec.implicitFields } : {}),
		});
		const entryDeclaredModels = [
			...(spec.declareRaw ? [spec.rawModelId] : []),
			...(spec.declareOther ? [spec.otherId] : []),
		];
		const opts: CapabilityOverrideOptions = {
			globalCapabilities,
			entryCapabilities,
			...(entryDeclaredModels.length > 0 ? { entryDeclaredModels } : {}),
			catalog,
			resolution: new ModelResolutionTable(),
			log: () => {},
			logAdvisory: () => {},
		};
		return {
			items: [item],
			serverCount: spec.serverCount,
			opts,
			globalCapabilities,
			entryCapabilities,
			catalog,
		};
	});

/** The walk every served model must agree with, over the baseline the model itself carries. */
function effectiveFor(info: PreAttachModelInfo, s: Scenario): EffectiveCapabilities {
	return resolveModelCapabilities({
		rawModelId: rawModelIdFromExposed(info.id, SERVER.id),
		globalCapabilities: s.globalCapabilities,
		entryCapabilities: s.entryCapabilities,
		catalog: s.catalog,
		serverDeclared: info.litellm.serverDeclared,
	});
}

const MODEL_PRICING_KEYS = [
	"inputCost",
	"outputCost",
	"cacheCost",
	"cacheWriteCost",
	"longContextInputCost",
	"longContextOutputCost",
	"longContextCacheCost",
	"longContextCacheWriteCost",
	"priceCategory",
	"pricing",
] as const;

function assertAdvertisesEffective(info: PreAttachModelInfo, effective: EffectiveCapabilities): void {
	assert.strictEqual(info.maxInputTokens, effective.fields.max_input_tokens.value);
	assert.strictEqual(info.maxOutputTokens, effective.fields.max_output_tokens.value);
	assert.strictEqual(Boolean(info.capabilities?.toolCalling), effective.fields.supports_function_calling.value);
	assert.strictEqual(Boolean(info.capabilities?.imageInput), effective.fields.supports_vision.value);
	assert.strictEqual(info.litellm.supportsAudioInput === true, effective.fields.supports_audio_input.value);
	assert.strictEqual(
		info.litellm.supportsPromptCaching,
		capabilityField(effective.fields, "supports_prompt_caching")?.value === true,
		"the caching gate must follow the effective supports_prompt_caching"
	);
	assert.strictEqual(info.litellm.outputLimitSource, effective.outputLimitSource);
	assert.strictEqual(
		info.configurationSchema !== undefined,
		reasoningGate(effective.fields),
		"the reasoning control must follow the gate over the flag and the params list"
	);
	// Production prices with the ambient usage.currencySymbol, so the expectation
	// reads the same getter rather than assuming a default.
	const expectedPricing = pricingFieldsFromEffective(effective.fields, getCurrencySymbol());
	for (const key of MODEL_PRICING_KEYS) {
		assert.strictEqual(info[key], expectedPricing[key], `${key} must equal the effective-field derivation exactly`);
	}
}

suite("provider/catalog capabilityOverrides properties", () => {
	test("every served model advertises exactly the resolver's effective capabilities, fast path included", () => {
		fc.assert(
			fc.property(scenario, (s) => {
				const { infos } = buildModelInfos(s.items, SERVER, s.serverCount, () => {});
				const served = applyCapabilityOverrides(infos, SERVER, s.opts);
				for (const info of served) {
					assertAdvertisesEffective(info, effectiveFor(info, s));
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("application is idempotent: a second pass changes nothing", () => {
		fc.assert(
			fc.property(scenario, (s) => {
				const { infos } = buildModelInfos(s.items, SERVER, s.serverCount, () => {});
				const once = applyCapabilityOverrides(infos, SERVER, s.opts);
				const twice = applyCapabilityOverrides(once, SERVER, s.opts);
				assert.deepStrictEqual(twice, once);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("declared models resolve over the declared baseline, stay inert against discovered IDs, and never collide", () => {
		fc.assert(
			fc.property(scenario, (s) => {
				const { infos } = buildModelInfos(s.items, SERVER, s.serverCount, () => {});
				const served = applyCapabilityOverrides(infos, SERVER, s.opts);
				const discovered = new Set(s.items.map((item) => item.id));
				const reserved = new Set(served.map((info) => info.id));
				const declared = synthesizeDeclaredModels(discovered, reserved, SERVER, s.serverCount, s.opts);
				for (const info of declared.infos) {
					const rawId = rawModelIdFromExposed(info.id, SERVER.id);
					assert.ok(!discovered.has(rawId), "a discovered ID must stay inert");
					assert.ok(!reserved.has(info.id), "a reserved exposed ID must be suppressed");
					assert.strictEqual(info.litellm.declared, true);
					assert.deepStrictEqual(info.litellm.serverDeclared, { kind: "declared" });
					assertAdvertisesEffective(info, effectiveFor(info, s));
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});
