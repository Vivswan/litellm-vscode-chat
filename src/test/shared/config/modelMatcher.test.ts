/**
 * The matcher grammar's unit pins: the key forms, the whole-ID anchoring, the
 * invalid-key diagnostics, and the strict specificity tiers - including every
 * edge case docs/models.md#model-matching calls out (literal slashes, the
 * trailing-star rule, underscore IDs, glob-beats-regex, dot-star vs "*").
 */
import * as assert from "node:assert";
import type { MatcherInvalidReason, ParsedMatcher } from "../../../shared/config/modelMatcher";
import {
	CATCH_ALL_KEY,
	compareSpecificity,
	lintMatcherKeys,
	matchChain,
	matcherMatches,
	parseMatcherKey,
} from "../../../shared/config/modelMatcher";

function parsed(key: string): ParsedMatcher {
	const result = parseMatcherKey(key);
	assert.ok(result.ok, `expected "${key}" to parse`);
	return result.matcher;
}

function invalidReason(key: string): MatcherInvalidReason {
	const result = parseMatcherKey(key);
	assert.ok(!result.ok, `expected "${key}" to be invalid`);
	return result.reason;
}

suite("shared/config modelMatcher parse", () => {
	test("an exact key matches only its exact ID, character for character", () => {
		const matcher = parsed("gpt-5");
		assert.strictEqual(matcher.kind, "exact");
		assert.ok(matcherMatches(matcher, "gpt-5"));
		assert.ok(!matcherMatches(matcher, "gpt-5.7"), "exact keys are not prefixes");
		assert.ok(!matcherMatches(matcher, "gpt-5-turbo"));
		assert.ok(!matcherMatches(matcher, "GPT-5"), "exact keys are case-sensitive");
		assert.ok(!matcherMatches(parsed(" gpt-5"), "gpt-5"), "nothing is trimmed");
	});

	test("a trailing-star key is a glob over its literal prefix", () => {
		const matcher = parsed("gpt-5*");
		assert.strictEqual(matcher.kind, "glob");
		assert.ok(matcherMatches(matcher, "gpt-5"));
		assert.ok(matcherMatches(matcher, "gpt-5.7"));
		assert.ok(matcherMatches(matcher, "gpt-5-turbo"));
		assert.ok(!matcherMatches(matcher, "gpt-4"));
		assert.ok(!matcherMatches(matcher, "GPT-5.7"), "globs are case-sensitive");
	});

	test("a slash-wrapped key is a regex matched against the whole ID", () => {
		const matcher = parsed("/gpt-[45].*/");
		assert.strictEqual(matcher.kind, "regex");
		assert.ok(matcherMatches(matcher, "gpt-4-turbo"));
		assert.ok(matcherMatches(matcher, "gpt-5"));
		assert.ok(!matcherMatches(matcher, "my-gpt-4"), "anchored: never a substring match");
		assert.ok(!matcherMatches(parsed("/gpt/"), "gpt-4"), "anchored at the end too");
	});

	test("the i flag makes the one case-insensitive form; other flags are diagnosed", () => {
		assert.ok(matcherMatches(parsed("/GPT-5.*/i"), "gpt-5-turbo"));
		assert.strictEqual(invalidReason("/gpt-5/g"), "unsupported-regex-flag");
		assert.strictEqual(invalidReason("/gpt-5/gi"), "unsupported-regex-flag");
		assert.strictEqual(invalidReason("/gpt-5/I"), "unsupported-regex-flag");
	});

	test("an invalid regex pattern is diagnosed and never matches", () => {
		assert.strictEqual(invalidReason("/gpt-[5/"), "invalid-regex");
	});

	test('"*" is the catch-all and "" is invalid', () => {
		assert.strictEqual(parsed(CATCH_ALL_KEY).kind, "catch-all");
		assert.ok(matcherMatches(parsed(CATCH_ALL_KEY), "anything-at-all"));
		assert.strictEqual(invalidReason(""), "empty-key");
	});

	test("a star anywhere but the end invalidates the key", () => {
		assert.strictEqual(invalidReason("gpt*5"), "misplaced-star");
		assert.strictEqual(invalidReason("*gpt"), "misplaced-star");
		assert.strictEqual(invalidReason("gpt**"), "misplaced-star");
		assert.strictEqual(invalidReason("*x*"), "misplaced-star");
	});

	test("an ID containing slashes is matched by a plain exact key", () => {
		const matcher = parsed("anthropic/claude-4");
		assert.strictEqual(matcher.kind, "exact", "only a key that starts AND ends with / reads as a regex");
		assert.ok(matcherMatches(matcher, "anthropic/claude-4"));
	});

	test("a slash in a regex body matches a literal slash, escaped or raw", () => {
		// The body runs to the LAST delimiter, so interior slashes never end the key early.
		assert.ok(matcherMatches(parsed("/anthropic\\/claude.*/"), "anthropic/claude-4"));
		assert.ok(matcherMatches(parsed("/anthropic/claude.*/"), "anthropic/claude-4"));
		assert.ok(!matcherMatches(parsed("/anthropic\\/claude.*/"), "anthropic-claude-4"));
	});

	test("an ID that literally ends in a star needs a regex with the star escaped", () => {
		const matcher = parsed("/gpt-5\\*/");
		assert.strictEqual(matcher.kind, "regex");
		assert.ok(matcherMatches(matcher, "gpt-5*"));
		assert.ok(!matcherMatches(matcher, "gpt-5x"));
	});

	test("an ID starting with an underscore can only be matched by a regex key", () => {
		// "_..." record keys are directives, so the exact form is unreachable;
		// the regex form still selects such an ID.
		assert.ok(matcherMatches(parsed("/_internal-model/"), "_internal-model"));
	});
});

suite("shared/config modelMatcher specificity", () => {
	const at = (key: string, position = 0) => ({ matcher: parsed(key), position });

	test("exact > glob > regex > catch-all, strictly by tier", () => {
		assert.ok(compareSpecificity(at("gpt-5*"), at("gpt-5")) < 0, "any exact beats any glob");
		assert.ok(compareSpecificity(at("/gpt-5.*/"), at("g*")) < 0, "any glob beats any regex, however narrow the regex");
		assert.ok(
			compareSpecificity(at("*"), at("/.*/")) < 0,
			"a dot-star regex still ranks as a regex, above the catch-all"
		);
	});

	test("between globs the longer literal prefix wins; between regexes the later position wins", () => {
		assert.ok(compareSpecificity(at("gpt*"), at("gpt-5*")) < 0);
		assert.ok(compareSpecificity(at("/a.*/", 0), at("/b.*/", 3)) < 0, "later in the record is more specific");
	});

	test("matchChain orders matching records broadest first and diagnoses invalid keys", () => {
		const { chain, diagnostics } = matchChain("gpt-5.6", {
			"gpt-5.6": { a: 1 },
			"*": { b: 2 },
			"/gpt.*/": { c: 3 },
			"gpt-5*": { d: 4 },
			"claude*": { e: 5 },
			"gpt*5": { f: 6 },
			"": { g: 7 },
		});
		assert.deepStrictEqual(
			chain.map((match) => match.key),
			["*", "/gpt.*/", "gpt-5*", "gpt-5.6"]
		);
		assert.deepStrictEqual(
			diagnostics.map((d) => `${d.key}:${d.reason}`),
			["gpt*5:misplaced-star", ":empty-key"]
		);
	});

	test("lintMatcherKeys reports every invalid key of a record map, matching or not", () => {
		const diagnostics = lintMatcherKeys({ ok: {}, "ok*": {}, "/ok/": {}, "b*ad": {}, "/bad[/": {}, "/bad/x": {} });
		assert.deepStrictEqual(
			diagnostics.map((d) => d.reason),
			["misplaced-star", "invalid-regex", "unsupported-regex-flag"]
		);
	});
});
