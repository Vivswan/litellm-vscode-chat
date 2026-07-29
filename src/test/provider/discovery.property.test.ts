import * as assert from "node:assert";
import * as fc from "fast-check";
import { mapModelInfoEntry, mergeModelDeployments, parseModelInfoItem } from "../../provider/discovery";
import { deriveTokenConstraints } from "../../provider/modelCatalog";
import { buildModelInfos } from "../../provider/registration";
import type { LiteLLMProvider, ModelInfoFields } from "../../provider/schemas";
import { supportsTools } from "../../provider/schemas";
import type { TokenDefaults } from "../../shared/settings";
import { resolveFuzzSeed } from "../fuzzStream";
import { expectDefined } from "../testUtils";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 200;
// Pinned by default; FUZZ_SEED overrides so the nightly explores fresh seeds.
const SEED = resolveFuzzSeed();

const tokenLimit = fc.option(fc.integer({ min: 1, max: 500000 }), { nil: undefined });
const flag = fc.option(fc.boolean(), { nil: null });

/** Random subsets of the model_info fields that feed token constraints and capabilities. */
const modelInfoArb: fc.Arbitrary<ModelInfoFields> = fc.record({
	max_tokens: tokenLimit,
	max_input_tokens: tokenLimit,
	max_output_tokens: tokenLimit,
	supports_function_calling: flag,
	supports_tool_choice: flag,
	supports_vision: flag,
	supports_pdf_input: flag,
	supports_reasoning: flag,
	supports_prompt_caching: flag,
} satisfies Partial<Record<keyof ModelInfoFields, fc.Arbitrary<unknown>>>);

/** Random providers-array entries with the fields that feed token constraints; tool support varies. */
const providerArb: fc.Arbitrary<LiteLLMProvider> = fc
	.record({
		context_length: tokenLimit,
		max_tokens: tokenLimit,
		max_input_tokens: tokenLimit,
		max_output_tokens: tokenLimit,
		supports_tools: fc.constantFrom<boolean | undefined>(true, false, undefined),
	})
	.map((fields) => ({ provider: "some-provider", status: "active", ...fields }));

const defaultsArb: fc.Arbitrary<TokenDefaults> = fc.record({
	maxOutputTokens: fc.integer({ min: 1, max: 500000 }),
	contextLength: fc.integer({ min: 1, max: 1000000 }),
	maxInputTokens: fc.option(fc.integer({ min: 1, max: 1000000 }), { nil: undefined }),
});

suite("provider/discovery deployment merge properties", () => {
	test("merged token constraints never exceed any deployment's standalone constraints", () => {
		fc.assert(
			fc.property(fc.array(modelInfoArb, { minLength: 1, maxLength: 5 }), defaultsArb, (infos, defaults) => {
				const deployments = infos.map((modelInfo) =>
					mapModelInfoEntry(expectDefined(parseModelInfoItem({ model_name: "balanced", model_info: modelInfo })))
				);
				const first = expectDefined(deployments[0]);
				const merged = mergeModelDeployments([first, ...deployments.slice(1)], defaults);
				const mergedConstraints = deriveTokenConstraints(merged.provider, defaults);

				for (const [index, deployment] of deployments.entries()) {
					const standalone = deriveTokenConstraints(deployment.provider, defaults);
					const detail = `deployment ${index}: merged ${JSON.stringify(mergedConstraints)} vs standalone ${JSON.stringify(standalone)}`;
					assert.ok(mergedConstraints.maxInputTokens <= standalone.maxInputTokens, `maxInputTokens exceeds ${detail}`);
					assert.ok(
						mergedConstraints.maxOutputTokens <= standalone.maxOutputTokens,
						`maxOutputTokens exceeds ${detail}`
					);
					assert.ok(mergedConstraints.contextLength <= standalone.contextLength, `contextLength exceeds ${detail}`);
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("group entries never advertise more than the relevant providers' standalone constraints", () => {
		// The registration aggregates and the untooled base entry collapse
		// through the same collapseTokenConstraints home as deployment merging;
		// this pins the invariant on those consumers, so a formula reintroduced
		// inline (the shipped context-minus-output bug) fails here. Aggregates
		// stand for the tool-capable providers; the untooled base entry stands
		// for the whole group.
		fc.assert(
			fc.property(fc.array(providerArb, { minLength: 1, maxLength: 5 }), defaultsArb, (providers, defaults) => {
				const first = expectDefined(providers[0]);
				const { infos } = buildModelInfos(
					[{ id: "multi", shape: { kind: "group", providers: [first, ...providers.slice(1)] } }],
					{ id: "srv1", label: "Default", baseUrl: "http://litellm.test", apiKey: "k" },
					1,
					() => {},
					defaults
				);
				const toolProviders = providers.filter(supportsTools);
				const [entryId, contributors] =
					toolProviders.length > 0 ? (["multi:cheapest", toolProviders] as const) : (["multi", providers] as const);
				const entry = expectDefined(infos.find((info) => info.id === entryId));

				for (const [index, provider] of contributors.entries()) {
					const standalone = deriveTokenConstraints(provider, defaults);
					const detail = `${entryId} contributor ${index}: entry {maxInputTokens: ${entry.maxInputTokens}, maxOutputTokens: ${entry.maxOutputTokens}} vs standalone ${JSON.stringify(standalone)}`;
					assert.ok(entry.maxInputTokens <= standalone.maxInputTokens, `maxInputTokens exceeds ${detail}`);
					assert.ok(entry.maxOutputTokens <= standalone.maxOutputTokens, `maxOutputTokens exceeds ${detail}`);
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});
