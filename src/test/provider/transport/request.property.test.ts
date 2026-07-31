import * as assert from "node:assert";
import * as fc from "fast-check";
import type { ModelConfigurationRequestParams } from "../../../provider/modelConfiguration";
import { buildRequestBody, findLongestPrefixMatch, getModelParameters } from "../../../provider/transport/request";
import type { OpenAIChatMessage } from "../../../shared/wire";
import { resolveFuzzSeed } from "../../fuzzStream";
import { withConfig } from "../../testUtils";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 200;
const SEED = resolveFuzzSeed();

// "constructor" and "prototype" are reachable in this alphabet and
// normalizeModelParameters drops them, which would void a round trip.
const RESERVED_KEYS = new Set(["constructor", "prototype"]);

const safeKeyChar = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789.-/");
const safeKey = fc.string({ unit: safeKeyChar, minLength: 1, maxLength: 12 }).filter((key) => !RESERVED_KEYS.has(key));

// Slash-free so a scoped key "<scope>/<prefix>" can never collide with an
// unscoped key or match a scope other than its own.
const noSlashChar = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789.-");
const noSlashKey = fc
	.string({ unit: noSlashChar, minLength: 1, maxLength: 12 })
	.filter((key) => !RESERVED_KEYS.has(key));

const prefixEntries = fc.dictionary(safeKey, fc.integer(), { maxKeys: 8 });

/** A model ID that sometimes extends one of the entry keys, so matches are common. */
function deriveModelId(entries: Record<string, number>, fallbackId: string, pick: number, suffix: string): string {
	const keys = Object.keys(entries);
	if (keys.length === 0 || pick % 2 === 0) {
		return fallbackId;
	}
	return `${keys[pick % keys.length]}${suffix}`;
}

suite("provider/request prefix matching properties", () => {
	test("the winner is the unique longest key that prefixes the ID; undefined iff none does", () => {
		fc.assert(
			fc.property(
				prefixEntries,
				safeKey,
				fc.nat(),
				fc.string({ unit: safeKeyChar, maxLength: 6 }),
				(entries, fallbackId, pick, suffix) => {
					const id = deriveModelId(entries, fallbackId, pick, suffix);
					const result = findLongestPrefixMatch(id, entries);
					const matching = Object.keys(entries).filter((key) => id.startsWith(key));
					if (matching.length === 0) {
						assert.strictEqual(result, undefined);
						return;
					}
					// Two matching prefixes of equal length are the same string, so
					// the longest match is unique.
					const longest = matching.reduce((a, b) => (b.length > a.length ? b : a));
					assert.strictEqual(result, entries[longest]);
				}
			),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("adding an entry whose key does not prefix the ID never changes the result", () => {
		fc.assert(
			fc.property(
				prefixEntries,
				safeKey,
				fc.nat(),
				fc.string({ unit: safeKeyChar, maxLength: 6 }),
				safeKey,
				fc.integer(),
				(entries, fallbackId, pick, suffix, extraKey, extraValue) => {
					const id = deriveModelId(entries, fallbackId, pick, suffix);
					fc.pre(!id.startsWith(extraKey));
					const augmented = { ...entries, [extraKey]: extraValue };
					assert.strictEqual(findLongestPrefixMatch(id, augmented), findLongestPrefixMatch(id, entries));
				}
			),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});

suite("provider/request scoped modelParameters properties", () => {
	test("a scoped entry beats an unscoped entry with a strictly longer model prefix", async () => {
		await fc.assert(
			fc.asyncProperty(noSlashKey, noSlashKey, fc.nat(), fc.nat(), async (rawId, scope, cutA, cutB) => {
				const lenA = cutA % (rawId.length + 1);
				const lenB = cutB % (rawId.length + 1);
				fc.pre(lenA !== lenB);
				const scopedKey = `${scope}/${rawId.slice(0, Math.min(lenA, lenB))}`;
				const unscopedKey = rawId.slice(0, Math.max(lenA, lenB));
				const params = await withConfig(
					{ modelParameters: { [unscopedKey]: { source: "unscoped" }, [scopedKey]: { source: "scoped" } } },
					() => getModelParameters(rawId, new Map(), [scope])
				);
				assert.deepStrictEqual(params, { source: "scoped" });
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("across scopes the longer model prefix wins, regardless of scope order or length", async () => {
		await fc.assert(
			fc.asyncProperty(
				noSlashKey,
				noSlashKey,
				noSlashKey,
				fc.nat(),
				fc.nat(),
				async (rawId, scopeA, scopeB, cutA, cutB) => {
					fc.pre(scopeA !== scopeB);
					const lenA = cutA % (rawId.length + 1);
					const lenB = cutB % (rawId.length + 1);
					fc.pre(lenA !== lenB);
					const entries = {
						[`${scopeA}/${rawId.slice(0, lenA)}`]: { source: "a" },
						[`${scopeB}/${rawId.slice(0, lenB)}`]: { source: "b" },
					};
					const expected = { source: lenA > lenB ? "a" : "b" };
					const forward = await withConfig({ modelParameters: entries }, () =>
						getModelParameters(rawId, new Map(), [scopeA, scopeB])
					);
					assert.deepStrictEqual(forward, expected);
					const reversed = await withConfig({ modelParameters: entries }, () =>
						getModelParameters(rawId, new Map(), [scopeB, scopeA])
					);
					assert.deepStrictEqual(reversed, expected);
				}
			),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("ties on model prefix length resolve to the earlier scope in the scopes list", async () => {
		await fc.assert(
			fc.asyncProperty(noSlashKey, noSlashKey, noSlashKey, fc.nat(), async (rawId, scopeA, scopeB, cut) => {
				fc.pre(scopeA !== scopeB);
				const prefix = rawId.slice(0, cut % (rawId.length + 1));
				const entries = {
					[`${scopeA}/${prefix}`]: { source: "a" },
					[`${scopeB}/${prefix}`]: { source: "b" },
				};
				const forward = await withConfig({ modelParameters: entries }, () =>
					getModelParameters(rawId, new Map(), [scopeA, scopeB])
				);
				assert.deepStrictEqual(forward, { source: "a" });
				const reversed = await withConfig({ modelParameters: entries }, () =>
					getModelParameters(rawId, new Map(), [scopeB, scopeA])
				);
				assert.deepStrictEqual(reversed, { source: "b" });
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});

const OWNED_KEYS = ["model", "messages", "stream", "stream_options", "max_tokens", "tools", "tool_choice"] as const;
const OWNED_KEY_SET: ReadonlySet<string> = new Set(OWNED_KEYS);

// A small shared pool makes cross-source key collisions common: without it,
// three records drawing from the wide alphabet essentially never share a key
// and the precedence branch would go untested at any realistic run count.
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
