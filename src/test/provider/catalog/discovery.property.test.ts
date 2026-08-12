import * as assert from "node:assert";
import * as fc from "fast-check";
import { HttpResponse, http } from "msw";
import {
	fetchModels,
	mapModelInfoEntry,
	mergeModelDeployments,
	parseModelInfoItem,
} from "../../../provider/catalog/discovery";
import { deriveTokenConstraints } from "../../../provider/catalog/modelCatalog";
import { buildModelInfos } from "../../../provider/catalog/registration";
import type { LiteLLMProvider, ModelInfoFields } from "../../../provider/catalog/schemas";
import { supportsTools } from "../../../provider/catalog/schemas";
import { createServerClient } from "../../../provider/transport/clients";
import { resolveFuzzSeed } from "../../fuzzStream";
import { emptyErrorResponse, MODEL_INFO_URL, MODELS_URL, mswServer, TEST_BASE_URL, useMsw } from "../../mocks/handlers";
import { expectDefined } from "../../pureHelpers";

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

suite("provider/discovery deployment merge properties", () => {
	test("merged token constraints never exceed any deployment's standalone constraints", () => {
		fc.assert(
			fc.property(fc.array(modelInfoArb, { minLength: 1, maxLength: 5 }), (infos) => {
				const deployments = infos.map((modelInfo) =>
					mapModelInfoEntry(expectDefined(parseModelInfoItem({ model_name: "balanced", model_info: modelInfo })))
				);
				const first = expectDefined(deployments[0]);
				const merged = mergeModelDeployments([first, ...deployments.slice(1)]);
				const mergedConstraints = deriveTokenConstraints(merged.provider);

				for (const [index, deployment] of deployments.entries()) {
					const standalone = deriveTokenConstraints(deployment.provider);
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
			fc.property(fc.array(providerArb, { minLength: 1, maxLength: 5 }), (providers) => {
				const first = expectDefined(providers[0]);
				const { infos } = buildModelInfos(
					[{ id: "multi", shape: { kind: "group", providers: [first, ...providers.slice(1)] } }],
					{ id: "srv1", label: "Default", baseUrl: "http://litellm.test", apiKey: "k" },
					1,
					() => {}
				);
				const toolProviders = providers.filter(supportsTools);
				const [entryId, contributors] =
					toolProviders.length > 0 ? (["multi:cheapest", toolProviders] as const) : (["multi", providers] as const);
				const entry = expectDefined(infos.find((info) => info.id === entryId));

				for (const [index, provider] of contributors.entries()) {
					const standalone = deriveTokenConstraints(provider);
					const detail = `${entryId} contributor ${index}: entry {maxInputTokens: ${entry.maxInputTokens}, maxOutputTokens: ${entry.maxOutputTokens}} vs standalone ${JSON.stringify(standalone)}`;
					assert.ok(entry.maxInputTokens <= standalone.maxInputTokens, `maxInputTokens exceeds ${detail}`);
					assert.ok(entry.maxOutputTokens <= standalone.maxOutputTokens, `maxOutputTokens exceeds ${detail}`);
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});

suite("provider/discovery expectedFailures retry properties", () => {
	useMsw();

	/**
	 * The per-endpoint retry invariant over every expectedFailures combination
	 * and every endpoint-failure combination: an expected endpoint gets exactly
	 * one attempt, an unexpected one keeps the full budget, a model/info
	 * success skips the fallback entirely, and expectations never change WHICH
	 * failure is terminal. Attempts are counted through msw (5xx via
	 * emptyErrorResponse, the retryable shape). Run count is capped: retried
	 * 5xx attempts pay the SDK's real backoff sleeps, and the sixteen
	 * combinations are covered well within the cap.
	 */
	test("expected endpoints get one attempt, unexpected ones the full budget, per endpoint", async function () {
		this.timeout(120000);
		const expectedArb = fc.record({ modelInfo: fc.boolean(), modelListing: fc.boolean() });
		await fc.assert(
			fc.asyncProperty(expectedArb, fc.boolean(), fc.boolean(), async (expected, infoFails, listingFails) => {
				mswServer.resetHandlers();
				const attempts = { info: 0, models: 0 };
				mswServer.use(
					http.get(MODEL_INFO_URL, () => {
						attempts.info += 1;
						return infoFails
							? emptyErrorResponse(500)
							: HttpResponse.json({ data: [{ model_name: "m", model_info: { supports_function_calling: true } }] });
					}),
					http.get(MODELS_URL, () => {
						attempts.models += 1;
						return listingFails ? emptyErrorResponse(500) : HttpResponse.json({ object: "list", data: [{ id: "m" }] });
					})
				);
				const client = createServerClient({
					serverId: "srv1",
					baseUrl: TEST_BASE_URL,
					apiKey: "test-key",
					userAgent: "test-agent",
					customHeaders: {},
				});
				const call = fetchModels({
					client,
					baseUrl: TEST_BASE_URL,
					apiVersion: undefined,
					discoveryTimeout: 30000,
					expected,
					log: () => {},
				});
				if (infoFails && listingFails) {
					await assert.rejects(call, "only a /models failure is terminal, expected or not");
				} else {
					const { models } = await call;
					assert.ok(models.length > 0);
				}
				const budget = (isExpected: boolean) => (isExpected ? 1 : 3);
				assert.strictEqual(attempts.info, infoFails ? budget(expected.modelInfo) : 1, "model/info attempt count");
				const expectedModelsAttempts = !infoFails ? 0 : listingFails ? budget(expected.modelListing) : 1;
				assert.strictEqual(attempts.models, expectedModelsAttempts, "models attempt count");
			}),
			{ numRuns: Math.min(NUM_RUNS, 16), seed: SEED }
		);
	});
});
