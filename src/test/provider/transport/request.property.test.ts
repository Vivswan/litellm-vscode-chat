/**
 * buildRequestBody's ownership properties: provider-owned and underscore
 * keys never pass through from any source, everything else does with the
 * documented precedence. The matcher and inheritance properties of the
 * configured-parameters merge live with their owner
 * (src/test/shared/config/), and the projection-vs-body equivalence property
 * pins the two sides together.
 */
import * as assert from "node:assert";
import * as fc from "fast-check";
import type { ModelConfigurationRequestParams } from "../../../provider/catalog/modelConfiguration";
import { buildRequestBody } from "../../../provider/transport/request";
import type { OpenAIChatMessage } from "../../../shared/conversion/wire";
import { resolveFuzzSeed } from "../../fuzzStream";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 200;
const SEED = resolveFuzzSeed();

const safeKeyChar = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789.-/");
const safeKey = fc.string({ unit: safeKeyChar, minLength: 1, maxLength: 12 });

const OWNED_KEYS = ["model", "messages", "stream", "stream_options", "max_tokens", "tools", "tool_choice"] as const;
const OWNED_KEY_SET: ReadonlySet<string> = new Set(OWNED_KEYS);

// A small shared pool makes cross-source key collisions common: without it,
// three records drawing from the wide alphabet essentially never share a key and
// the precedence branch would go untested.
const SHARED_POOL_KEYS = ["temperature", "top_p", "presence_penalty", "reasoning_effort"] as const;

const bodyKey = fc.oneof(
	{ arbitrary: fc.constantFrom(...SHARED_POOL_KEYS), weight: 2 },
	{ arbitrary: safeKey, weight: 1 },
	{ arbitrary: fc.constantFrom(...OWNED_KEYS), weight: 1 },
	{ arbitrary: safeKey.map((key) => `_${key}`), weight: 1 }
);
const sourceRecord = fc.dictionary(bodyKey, fc.jsonValue({ maxDepth: 2 }), { maxKeys: 6 });

const MESSAGES: OpenAIChatMessage[] = [{ role: "user", content: "hi" }];
const BASE_KEYS: ReadonlySet<string> = new Set(["model", "messages", "stream", "stream_options", "max_tokens"]);

suite("provider/request buildRequestBody ownership properties", () => {
	test("owned and underscore keys never pass through; everything else does, options over config over params", () => {
		fc.assert(
			fc.property(
				sourceRecord,
				sourceRecord,
				sourceRecord,
				fc.integer({ min: 1, max: 100000 }),
				(modelParams, modelConfiguration, modelOptions, maxTokens) => {
					const body = buildRequestBody({
						rawModelId: "test-model",
						openaiMessages: MESSAGES,
						maxTokens,
						modelParams,
						toolConfig: undefined,
						modelConfiguration: modelConfiguration as ModelConfigurationRequestParams,
						modelOptions,
					});

					assert.strictEqual(body.model, "test-model");
					assert.strictEqual(body.messages, MESSAGES);
					assert.strictEqual(body.stream, true);
					assert.deepStrictEqual(body.stream_options, { include_usage: true });
					assert.strictEqual(body.max_tokens, maxTokens);
					assert.ok(!("tools" in body), "tools may come only from toolConfig");
					assert.ok(!("tool_choice" in body), "tool_choice may come only from toolConfig");

					const expected: Record<string, unknown> = {};
					for (const source of [modelParams, modelConfiguration, modelOptions]) {
						for (const [key, value] of Object.entries(source)) {
							if (OWNED_KEY_SET.has(key) || key.startsWith("_")) {
								continue;
							}
							expected[key] = value;
						}
					}
					const passed = Object.fromEntries(Object.entries(body).filter(([key]) => !BASE_KEYS.has(key)));
					assert.deepStrictEqual(passed, expected);
					for (const [key, value] of Object.entries(expected)) {
						assert.ok(Object.is(body[key], value), `body.${key} must be the winning source's value unchanged`);
					}
				}
			),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});
