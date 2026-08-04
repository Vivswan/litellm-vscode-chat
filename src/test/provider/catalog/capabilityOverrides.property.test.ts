/**
 * The registration-side equivalence twin of the capabilityResolution property
 * suite: for generated LiteLLM discovery shapes (deployment, bare, and
 * providers-array models with random capability and limit fields) run through
 * the REAL registration path, and generated capability records (keys cut from
 * the raw IDs so matches are common, scoped and entry layers, directives into
 * a generated catalog), the models applyCapabilityOverrides serves advertise
 * exactly what resolveModelCapabilities resolves - on the rebuilt path AND on
 * the object-identity fast path, which is the claim that lets untouched
 * models skip the rebuild at all. synthesizeDeclaredModels is pinned to the
 * same walk over the declared baseline, and the whole application is
 * idempotent because the untouched serverDeclared baseline rides each model.
 */
import * as assert from "node:assert";
import * as fc from "fast-check";
import type { CapabilityOverrideOptions } from "../../../provider/catalog/capabilityOverrides";
import { applyCapabilityOverrides, synthesizeDeclaredModels } from "../../../provider/catalog/capabilityOverrides";
import type { PreAttachModelInfo } from "../../../provider/catalog/groupModels";
import { rawModelIdFromExposed } from "../../../provider/catalog/modelCatalog";
import { buildModelInfos } from "../../../provider/catalog/registration";
import type { LiteLLMModelItem, LiteLLMProvider } from "../../../provider/catalog/schemas";
import type {
	CapabilityCatalogLookup,
	CapabilityFieldValues,
	CapabilityTokenDefaults,
	CatalogLookupResult,
	EffectiveCapabilities,
	ModelCapabilitiesRecord,
} from "../../../shared/config/capabilityResolution";
import {
	DECLARE_DIRECTIVE,
	OPENROUTER_MODEL_DIRECTIVE,
	resolveModelCapabilities,
} from "../../../shared/config/capabilityResolution";
import { resolveFuzzSeed } from "../../fuzzStream";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 200;
const SEED = resolveFuzzSeed();

const SERVER = { id: "srv1", label: "Default", baseUrl: "http://a.test", apiKey: "k" };
const SCOPE = "http://a.test";

/** The two built-in token defaults (settingSpec), so unconfigured generated defaults stay consistent. */
const BUILTIN = { contextLength: 128000, maxOutputTokens: 16000 };

// Slash-free so a scoped key "<scope>/<prefix>" can never collide with an
// unscoped key or match a scope other than its own; ":" stays out so cuts of
// a raw ID can never spell a synthetic ":cheapest" variant by accident.
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
			"supports_audio_input"
		),
		weight: 5,
	},
	{ arbitrary: modelId, weight: 1 }
);
const capabilityRecordArb: fc.Arbitrary<Record<string, unknown>> = fc
	.tuple(
		fc.dictionary(recordKeyArb, fieldValueArb, { maxKeys: 4 }),
		fc.option(fc.boolean(), { nil: undefined }),
		fc.option(fc.constantFrom<string>(...DIRECTIVE_POOL), { nil: undefined })
	)
	.map(([base, declare, openrouterModel]) => ({
		...base,
		...(declare !== undefined ? { [DECLARE_DIRECTIVE]: declare } : {}),
		...(openrouterModel !== undefined ? { [OPENROUTER_MODEL_DIRECTIVE]: openrouterModel } : {}),
	}));

function makeCatalog(entries: Record<string, Partial<CapabilityFieldValues>>): CapabilityCatalogLookup {
	const byExactId = (id: string): CatalogLookupResult => {
		const fields = entries[id];
		return fields !== undefined
			? { kind: "found", id, fields, pricing: { input_cost_per_token: 0.000002, output_cost_per_token: 0.000004 } }
			: { kind: "not-found" };
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
	readonly registrationDefaults: { maxOutputTokens: number; contextLength: number; maxInputTokens: number | undefined };
	readonly capabilityDefaults: CapabilityTokenDefaults;
}

const tokenDefaultPair = (builtin: number) =>
	fc.oneof(
		fc.constant({ value: builtin, explicitlyConfigured: false }),
		validNumber.map((value) => ({ value, explicitlyConfigured: true }))
	);

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
				scoped: fc.boolean(),
				record: capabilityRecordArb,
			}),
			{ maxLength: 3 }
		),
		entrySpecs: fc.option(
			fc.array(fc.record({ cut: fc.nat(), foreign: fc.boolean(), record: capabilityRecordArb }), { maxLength: 2 }),
			{ nil: undefined }
		),
		catalogOne: fc.option(validFieldsArb, { nil: undefined }),
		implicitFields: fc.option(validFieldsArb, { nil: undefined }),
		contextDefault: tokenDefaultPair(BUILTIN.contextLength),
		outputDefault: tokenDefaultPair(BUILTIN.maxOutputTokens),
		maxInputDefault: fc.option(validNumber, { nil: undefined }),
	})
	.map((spec) => {
		const item = { ...spec.item, id: spec.rawModelId };
		const prefixOf = (cut: number, foreign: boolean) => {
			const base = foreign ? spec.otherId : spec.rawModelId;
			return base.slice(0, cut % (base.length + 1));
		};
		const globalCapabilities: Record<string, Record<string, unknown>> = {};
		for (const globalSpec of spec.globalSpecs) {
			const prefix = prefixOf(globalSpec.cut, globalSpec.foreign);
			globalCapabilities[globalSpec.scoped ? `${SCOPE}/${prefix}` : prefix] = globalSpec.record;
		}
		const entryCapabilities =
			spec.entrySpecs === undefined
				? undefined
				: Object.fromEntries(spec.entrySpecs.map((entry) => [prefixOf(entry.cut, entry.foreign), entry.record]));
		const catalog = makeCatalog({
			...(spec.catalogOne !== undefined ? { "cat/one": spec.catalogOne } : {}),
			...(spec.implicitFields !== undefined ? { [`imp/${spec.rawModelId}`]: spec.implicitFields } : {}),
		});
		const capabilityDefaults: CapabilityTokenDefaults = {
			contextLength: spec.contextDefault,
			maxOutputTokens: spec.outputDefault,
			maxInputTokens: spec.maxInputDefault,
		};
		const registrationDefaults = {
			maxOutputTokens: spec.outputDefault.value,
			contextLength: spec.contextDefault.value,
			maxInputTokens: spec.maxInputDefault,
		};
		const opts: CapabilityOverrideOptions = {
			globalCapabilities,
			entryCapabilities,
			catalog,
			tokenDefaults: capabilityDefaults,
			log: () => {},
		};
		return {
			items: [item],
			serverCount: spec.serverCount,
			opts,
			globalCapabilities,
			entryCapabilities,
			catalog,
			registrationDefaults,
			capabilityDefaults,
		};
	});

/** The walk every served model must agree with, over the baseline the model itself carries. */
function effectiveFor(info: PreAttachModelInfo, s: Scenario): EffectiveCapabilities {
	return resolveModelCapabilities({
		rawModelId: rawModelIdFromExposed(info.id, SERVER.id),
		globalCapabilities: s.globalCapabilities,
		serverScopes: [SCOPE],
		entryCapabilities: s.entryCapabilities,
		catalog: s.catalog,
		serverDeclared: info.litellm.serverDeclared,
		tokenDefaults: s.capabilityDefaults,
	});
}

function assertAdvertisesEffective(info: PreAttachModelInfo, effective: EffectiveCapabilities): void {
	assert.strictEqual(info.maxInputTokens, effective.fields.max_input_tokens.value);
	assert.strictEqual(info.maxOutputTokens, effective.fields.max_output_tokens.value);
	assert.strictEqual(Boolean(info.capabilities?.toolCalling), effective.fields.supports_function_calling.value);
	assert.strictEqual(Boolean(info.capabilities?.imageInput), effective.fields.supports_vision.value);
	assert.strictEqual(info.litellm.supportsAudioInput === true, effective.fields.supports_audio_input.value);
	assert.strictEqual(info.litellm.outputLimitSource, effective.outputLimitSource);
	assert.strictEqual(info.configurationSchema !== undefined, effective.fields.supports_reasoning.value);
}

suite("provider/catalog capabilityOverrides properties", () => {
	test("every served model advertises exactly the resolver's effective capabilities, fast path included", () => {
		fc.assert(
			fc.property(scenario, (s) => {
				const { infos } = buildModelInfos(s.items, SERVER, s.serverCount, () => {}, s.registrationDefaults);
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
				const { infos } = buildModelInfos(s.items, SERVER, s.serverCount, () => {}, s.registrationDefaults);
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
				const { infos } = buildModelInfos(s.items, SERVER, s.serverCount, () => {}, s.registrationDefaults);
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
					assert.strictEqual(declared.routes.get(info.id)?.rawModelId, rawId);
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});
