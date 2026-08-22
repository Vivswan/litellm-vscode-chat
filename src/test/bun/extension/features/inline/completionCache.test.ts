import { describe, test } from "bun:test";
import * as assert from "node:assert";
import type { CompletionCacheKey } from "../../../../../extension/features/inline/completionCache";
import {
	CompletionCache,
	DEFAULT_COMPLETION_CACHE_CAPACITY,
} from "../../../../../extension/features/inline/completionCache";

function key(overrides: Partial<CompletionCacheKey> = {}): CompletionCacheKey {
	return { server: "Main", model: "codestral-fim", prefix: "function ad", suffix: "\n}", ...overrides };
}

describe("extension/features/inline/completionCache", () => {
	test("miss then hit round trip, empty completions included", () => {
		const cache = new CompletionCache();
		assert.strictEqual(cache.get(key()), undefined);
		cache.set(key(), "d(a, b) {");
		assert.strictEqual(cache.get(key()), "d(a, b) {");
		cache.set(key({ prefix: "nothing to add here" }), "");
		assert.strictEqual(cache.get(key({ prefix: "nothing to add here" })), "");
	});

	test("every key field participates: changing any one is a miss", () => {
		const cache = new CompletionCache();
		cache.set(key(), "value");
		assert.strictEqual(cache.get(key({ server: "Other" })), undefined);
		assert.strictEqual(cache.get(key({ model: "gpt-5.2-mini" })), undefined);
		assert.strictEqual(cache.get(key({ prefix: "function a" })), undefined);
		assert.strictEqual(cache.get(key({ suffix: "" })), undefined);
	});

	test("field content cannot collide across field boundaries", () => {
		const cache = new CompletionCache();
		cache.set(key({ server: "a", model: "b/c" }), "one");
		assert.strictEqual(cache.get(key({ server: "a/b", model: "c" })), undefined);
		cache.set(key({ prefix: "ab", suffix: "c" }), "two");
		assert.strictEqual(cache.get(key({ prefix: "a", suffix: "bc" })), undefined);
	});

	test("eviction drops the least recently USED entry, not the oldest inserted", () => {
		const cache = new CompletionCache(2);
		cache.set(key({ prefix: "a" }), "A");
		cache.set(key({ prefix: "b" }), "B");
		// Touch "a" so "b" becomes least recently used.
		assert.strictEqual(cache.get(key({ prefix: "a" })), "A");
		cache.set(key({ prefix: "c" }), "C");
		assert.strictEqual(cache.size, 2);
		assert.strictEqual(cache.get(key({ prefix: "b" })), undefined, "the untouched entry was evicted");
		assert.strictEqual(cache.get(key({ prefix: "a" })), "A");
		assert.strictEqual(cache.get(key({ prefix: "c" })), "C");
	});

	test("overwriting a key updates the value without growing the cache", () => {
		const cache = new CompletionCache(2);
		cache.set(key(), "old");
		cache.set(key(), "new");
		assert.strictEqual(cache.size, 1);
		assert.strictEqual(cache.get(key()), "new");
	});

	test("an overwrite refreshes recency like a hit", () => {
		const cache = new CompletionCache(2);
		cache.set(key({ prefix: "a" }), "A");
		cache.set(key({ prefix: "b" }), "B");
		cache.set(key({ prefix: "a" }), "A2");
		cache.set(key({ prefix: "c" }), "C");
		assert.strictEqual(cache.get(key({ prefix: "b" })), undefined);
		assert.strictEqual(cache.get(key({ prefix: "a" })), "A2");
	});

	test("invalidate drops everything", () => {
		const cache = new CompletionCache();
		cache.set(key({ prefix: "a" }), "A");
		cache.set(key({ prefix: "b" }), "B");
		cache.invalidate();
		assert.strictEqual(cache.size, 0);
		assert.strictEqual(cache.get(key({ prefix: "a" })), undefined);
	});

	test("capacity must be a positive integer, the default included", () => {
		assert.throws(() => new CompletionCache(0), /positive integer/);
		assert.throws(() => new CompletionCache(-1), /positive integer/);
		assert.throws(() => new CompletionCache(1.5), /positive integer/);
		assert.ok(Number.isInteger(DEFAULT_COMPLETION_CACHE_CAPACITY) && DEFAULT_COMPLETION_CACHE_CAPACITY >= 1);
	});

	test("the bound holds under sustained inserts", () => {
		const cache = new CompletionCache(3);
		for (let i = 0; i < 50; i += 1) {
			cache.set(key({ prefix: `p${i}` }), `v${i}`);
		}
		assert.strictEqual(cache.size, 3);
		assert.strictEqual(cache.get(key({ prefix: "p49" })), "v49");
		assert.strictEqual(cache.get(key({ prefix: "p46" })), undefined);
	});
});
