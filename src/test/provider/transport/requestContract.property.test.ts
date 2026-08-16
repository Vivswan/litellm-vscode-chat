import * as assert from "node:assert";
import * as fc from "fast-check";
import * as vscode from "vscode";
import { DEFAULT_REASONING_EFFORT_LEVELS } from "../../../provider/catalog/modelConfiguration";
import { resolveFuzzSeed } from "../../fuzzStream";
import { mswServer, useMsw } from "../../mocks/handlers";
import { makeModelInfo } from "../../pureHelpers";
import { captureRequestBody, createConfiguredProvider, userMessage, withConfig } from "../../testUtils";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 200;
const SEED = resolveFuzzSeed();

/**
 * The pass-through invariant, end to end: this suite drives
 * provideLanguageModelChatResponse through msw and asserts the captured HTTP body carries
 * exactly the provider-owned fields plus the user-set keys, with runtime options > picker
 * configuration > configured parameters.
 */

const OWNED_KEYS = ["model", "messages", "stream", "stream_options", "max_tokens", "tools", "tool_choice"] as const;
const OWNED_KEY_SET: ReadonlySet<string> = new Set(OWNED_KEYS);

// normalizeModelParameters drops these outright, which would void the oracle.
const RESERVED_KEYS = new Set(["constructor", "prototype", "__proto__"]);

const safeKeyChar = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789.-");
const safeKey = fc.string({ unit: safeKeyChar, minLength: 1, maxLength: 10 }).filter((key) => !RESERVED_KEYS.has(key));

// A small shared pool makes cross-source collisions common enough for the
// precedence branch to run; reasoning_effort collides with the picker mapping on
// purpose. max_tokens stays out: it has its own property below.
const SHARED_POOL_KEYS = ["temperature", "top_p", "seed", "reasoning_effort"] as const;

const bodyKey = fc.oneof(
	{ arbitrary: fc.constantFrom(...SHARED_POOL_KEYS), weight: 2 },
	{ arbitrary: safeKey, weight: 1 },
	{ arbitrary: fc.constantFrom(...OWNED_KEYS).filter((key) => key !== "max_tokens"), weight: 1 },
	{ arbitrary: safeKey.map((key) => `_${key}`), weight: 1 }
);
const sourceRecord = fc.dictionary(bodyKey, fc.jsonValue({ maxDepth: 2 }), { maxKeys: 5 });

/**
 * The picker's reasoningEffort choice: built-in levels, an unknown level
 * string (the vocabulary is open, so it forwards as-is), the default
 * sentinel, non-string junk, or no configuration at all.
 */
const pickerArb = fc.constantFrom<unknown>(...DEFAULT_REASONING_EFFORT_LEVELS, "default", "extreme", 42, undefined);

const toolsArb = fc
	.array(
		fc.constantFrom("read_file", "list_dir").map((name) => ({
			name,
			description: `The ${name} tool`,
			inputSchema: { type: "object", properties: {} },
		})),
		{ maxLength: 2 }
	)
	.map((tools) => tools.filter((tool, index, all) => all.findIndex((t) => t.name === tool.name) === index));

const messagesArb = fc
	.array(fc.string({ unit: safeKeyChar, minLength: 1, maxLength: 12 }), { minLength: 1, maxLength: 2 })
	.map((texts) => texts.map(userMessage));

/** Drop the keys the provider owns or reserves; what remains must pass through verbatim. */
function passthrough(source: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(source).filter(([key]) => !OWNED_KEY_SET.has(key) && !key.startsWith("_")));
}

/** JSON-canonicalize (the body crossed HTTP, so -0 and friends already did). */
function overWire(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

suite("provider/request full-pipeline pass-through properties", () => {
	useMsw();

	test("the wire body is exactly the owned fields plus user-set keys, options > picker > parameters", async function () {
		this.timeout(180000);
		await fc.assert(
			fc.asyncProperty(
				sourceRecord,
				sourceRecord,
				pickerArb,
				toolsArb,
				messagesArb,
				async (modelParams, modelOptions, picker, tools, messages) => {
					// captureRequestBody stacks a fresh handler set per call; reset so
					// a long nightly run does not accumulate hundreds of handlers.
					mswServer.resetHandlers();
					const body = await withConfig({ "models.parameters": { "test-model": modelParams } }, () =>
						captureRequestBody(
							createConfiguredProvider(),
							makeModelInfo(),
							{
								toolMode: vscode.LanguageModelChatToolMode.Auto,
								modelOptions,
								...(tools.length > 0 ? { tools } : {}),
								...(picker !== undefined ? { modelConfiguration: { reasoningEffort: picker } } : {}),
							},
							{ messages }
						)
					);

					// Provider-owned fields are provider-authored, whatever the sources held.
					assert.strictEqual(body.model, "test-model");
					assert.strictEqual(body.stream, true);
					assert.deepStrictEqual(body.stream_options, { include_usage: true });
					assert.strictEqual(typeof body.max_tokens, "number");
					assert.ok(Array.isArray(body.messages));
					assert.strictEqual((body.messages as unknown[]).length, messages.length);
					if (tools.length > 0) {
						assert.ok(Array.isArray(body.tools), "offered tools must reach the wire");
						assert.strictEqual((body.tools as unknown[]).length, tools.length);
					} else {
						assert.ok(!("tools" in body), "tools may come only from the tool config");
						assert.ok(!("tool_choice" in body));
					}

					// Everything else: the merged user-set keys, later sources winning.
					// Any picked string except the sentinel is a user-set level (open
					// vocabulary); non-strings drop.
					const pickerMapped = typeof picker === "string" && picker !== "default" ? { reasoning_effort: picker } : {};
					const expected = { ...passthrough(modelParams), ...pickerMapped, ...passthrough(modelOptions) };
					const ownedAndTools: ReadonlySet<string> = new Set([...OWNED_KEYS]);
					const passed = Object.fromEntries(Object.entries(body).filter(([key]) => !ownedAndTools.has(key)));
					assert.deepStrictEqual(passed, overWire(expected));
				}
			),
			{ numRuns: Math.min(NUM_RUNS, 1000), seed: SEED }
		);
	});

	test("max_tokens resolves options over parameters over min(4096, model max)", async function () {
		this.timeout(180000);
		await fc.assert(
			fc.asyncProperty(
				fc.option(fc.integer({ min: 1, max: 30000 }), { nil: undefined }),
				fc.option(fc.integer({ min: 1, max: 30000 }), { nil: undefined }),
				fc.integer({ min: 100, max: 50000 }),
				async (optionsMax, paramsMax, modelMax) => {
					mswServer.resetHandlers();
					const body = await withConfig(
						{ "models.parameters": { "test-model": paramsMax !== undefined ? { max_tokens: paramsMax } : {} } },
						() =>
							captureRequestBody(createConfiguredProvider(), makeModelInfo({ maxOutputTokens: modelMax }), {
								toolMode: vscode.LanguageModelChatToolMode.Auto,
								...(optionsMax !== undefined ? { modelOptions: { max_tokens: optionsMax } } : {}),
							})
					);
					// The hand-built model info carries no server-declared output limit,
					// so the fallback stays under the 4096 cap; the declared-uncapped arm
					// is pinned by requestContract.test.ts.
					const expected = optionsMax ?? paramsMax ?? Math.min(4096, modelMax);
					assert.strictEqual(body.max_tokens, expected);
				}
			),
			{ numRuns: Math.min(NUM_RUNS, 500), seed: SEED }
		);
	});
});
