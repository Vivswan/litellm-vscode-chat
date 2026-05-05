import * as assert from "assert";
import { findLongestPrefixMatch, getModelDefaults } from "../../provider/modelDefaults";

suite("modelDefaults", () => {
	test("findLongestPrefixMatch returns longest match", () => {
		const entries = { gpt: "a", "gpt-4": "b", "gpt-4-turbo": "c" };
		assert.strictEqual(findLongestPrefixMatch("gpt-4-turbo:fastest", entries), "c");
		assert.strictEqual(findLongestPrefixMatch("gpt-4:openai", entries), "b");
		assert.strictEqual(findLongestPrefixMatch("gpt-3.5", entries), "a");
	});

	test("findLongestPrefixMatch returns undefined for no match", () => {
		assert.strictEqual(findLongestPrefixMatch("claude-3", { gpt: "a" }), undefined);
	});

	test("getModelDefaults returns temperature 0.7 for unmatched model", () => {
		const defaults = getModelDefaults("claude-3-opus");
		assert.strictEqual(defaults.temperature, 0.7);
	});

	test("getModelDefaults returns no temperature for gpt-5.5", () => {
		const defaults = getModelDefaults("gpt-5.5");
		assert.strictEqual(defaults.temperature, undefined);
	});

	test("getModelDefaults returns no temperature for gpt-5.5 with suffix", () => {
		const defaults = getModelDefaults("gpt-5.5:openai");
		assert.strictEqual(defaults.temperature, undefined);
	});
});
