import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { stripMarkdownFences, truncateKeepingHead, truncateKeepingTail } from "../../../../shared/util/text";

// Drift pins for the consolidated text helpers: these cases are ported from
// the consumers' suites (commitGen's fence edge cases, fim's surrogate
// boundaries), so the shared module cannot drift from the semantics the
// consumers shipped with.

describe("shared/util/text stripMarkdownFences", () => {
	test("removes a fence pair, language tag included", () => {
		assert.strictEqual(stripMarkdownFences("```\nfeat: x\n```"), "feat: x");
		assert.strictEqual(stripMarkdownFences("```text\nfeat: x\n\nbody line\n```\n"), "feat: x\n\nbody line");
	});

	test("removes a lone opening fence", () => {
		assert.strictEqual(stripMarkdownFences("```\nfeat: x"), "feat: x");
	});

	test("leaves unfenced text and interior fences alone", () => {
		assert.strictEqual(stripMarkdownFences("feat: x"), "feat: x");
		const interior = "feat: x\n\nadds a ```code``` sample";
		assert.strictEqual(stripMarkdownFences(interior), interior);
	});

	test("trims surrounding whitespace, and an all-fence reply strips to the empty string", () => {
		assert.strictEqual(stripMarkdownFences("  feat: x \n"), "feat: x");
		assert.strictEqual(stripMarkdownFences("```\n```"), "");
		assert.strictEqual(stripMarkdownFences(""), "");
	});
});

describe("shared/util/text truncateKeepingTail", () => {
	test("at or under budget the input passes through verbatim, a lone surrogate included", () => {
		assert.strictEqual(truncateKeepingTail("abc", 3), "abc");
		assert.strictEqual(truncateKeepingTail("", 5), "");
		// Fidelity beats repair: pre-existing malformed input is not "fixed".
		assert.strictEqual(truncateKeepingTail("\ud800", 5), "\ud800");
	});

	test("over budget keeps the last `budget` units", () => {
		assert.strictEqual(truncateKeepingTail("abcdef", 4), "cdef");
	});

	test("a cut landing inside a surrogate pair drops the severed low half", () => {
		// The cut severs an emoji, leaving its low surrogate at the head; the
		// lone unit is dropped rather than sent.
		const text = `${"\u{1F600}".repeat(4)}b`; // 9 units
		const cut = truncateKeepingTail(text, 8);
		assert.strictEqual(cut.length, 7);
		assert.ok(cut.isWellFormed());
		assert.ok(cut.endsWith("b"));
	});

	test("an aligned cut through astral text keeps the full budget", () => {
		const text = `a${"\u{1F600}".repeat(4)}`; // 9 units
		const cut = truncateKeepingTail(text, 8);
		assert.strictEqual(cut.length, 8);
		assert.ok(cut.isWellFormed());
	});

	test("a budget of zero, less, or NaN keeps nothing, and a fractional budget floors", () => {
		assert.strictEqual(truncateKeepingTail("abc", 0), "");
		assert.strictEqual(truncateKeepingTail("abc", -1), "");
		assert.strictEqual(truncateKeepingTail("abc", Number.NaN), "");
		// slice(-0.5) would coerce to slice(-0) and return the WHOLE string;
		// the floor keeps the budget in whole units instead.
		assert.strictEqual(truncateKeepingTail("abc", 0.5), "");
		assert.strictEqual(truncateKeepingTail("abcdef", 2.5), "ef");
	});
});

describe("shared/util/text truncateKeepingHead", () => {
	test("at or under budget the input passes through verbatim, a lone surrogate included", () => {
		assert.strictEqual(truncateKeepingHead("abc", 3), "abc");
		assert.strictEqual(truncateKeepingHead("", 5), "");
		assert.strictEqual(truncateKeepingHead("\udfff", 5), "\udfff");
	});

	test("over budget keeps the first `budget` units", () => {
		assert.strictEqual(truncateKeepingHead("abcdef", 4), "abcd");
	});

	test("a cut landing inside a surrogate pair drops the severed high half", () => {
		// The mirror rule: the cut leaves a high surrogate at the tail.
		const text = `c${"\u{1F600}".repeat(4)}`; // 9 units
		const cut = truncateKeepingHead(text, 8);
		assert.strictEqual(cut.length, 7);
		assert.ok(cut.isWellFormed());
		assert.ok(cut.startsWith("c"));
	});

	test("an aligned cut through astral text keeps the full budget", () => {
		const text = `${"\u{1F600}".repeat(4)}z`; // 9 units
		const cut = truncateKeepingHead(text, 8);
		assert.strictEqual(cut.length, 8);
		assert.ok(cut.isWellFormed());
	});

	test("a budget of zero, less, or NaN keeps nothing, and a fractional budget floors", () => {
		assert.strictEqual(truncateKeepingHead("abc", 0), "");
		assert.strictEqual(truncateKeepingHead("abc", -1), "");
		assert.strictEqual(truncateKeepingHead("abc", Number.NaN), "");
		assert.strictEqual(truncateKeepingHead("abc", 0.5), "");
		assert.strictEqual(truncateKeepingHead("abcdef", 2.5), "ab");
	});
});
