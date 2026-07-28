import * as assert from "node:assert";
import * as fc from "fast-check";
import { mapModelInfoEntry, mergeModelDeployments } from "../../provider/discovery";
import { deriveTokenConstraints } from "../../provider/modelCatalog";
import type { LiteLLMModelInfoItem } from "../../provider/schemas";
import type { TokenDefaults } from "../../shared/settings";
import { resolveFuzzSeed } from "../fuzzStream";
import { expectDefined } from "../testUtils";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 200;
// Pinned by default; FUZZ_SEED overrides so the nightly explores fresh seeds.
const SEED = resolveFuzzSeed();

const tokenLimit = fc.option(fc.integer({ min: 1, max: 500000 }), { nil: undefined });
const flag = fc.option(fc.boolean(), { nil: null });

/** Random subsets of the model_info fields that feed token constraints and capabilities. */
const modelInfoArb: fc.Arbitrary<NonNullable<LiteLLMModelInfoItem["model_info"]>> = fc.record({
	max_tokens: tokenLimit,
	max_input_tokens: tokenLimit,
	max_output_tokens: tokenLimit,
	supports_function_calling: flag,
	supports_tool_choice: flag,
	supports_vision: flag,
	supports_pdf_input: flag,
	supports_reasoning: flag,
	supports_prompt_caching: flag,
});

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
					expectDefined(mapModelInfoEntry({ model_name: "balanced", model_info: modelInfo }))
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
});
