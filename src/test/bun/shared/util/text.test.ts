import { describe, test } from "bun:test";
import * as assert from "node:assert";
import {
	appendTruncationMarker,
	stripMarkdownFences,
	truncateHeadWithMarker,
	truncateKeepingHead,
	truncateKeepingTail,
	truncationMarker,
} from "../../../../shared/util/text";

// Drift pins for the consolidated text helpers: these cases are ported from
// the consumers' suites (commitGen's fence edge cases, fim's surrogate
// boundaries), so the shared module cannot drift from the semantics the
// consumers shipped with.

describe("shared/util/text stripMarkdownFences", () => {
	const cases: readonly { readonly name: string; readonly reply: string; readonly expected: string }[] = [
		{ name: "a fence pair", reply: "```\nfeat: x\n```", expected: "feat: x" },
		{
			name: "a tagged pair with a body",
			reply: "```text\nfeat: x\n\nbody line\n```\n",
			expected: "feat: x\n\nbody line",
		},
		{ name: "a lone opener costs its own line", reply: "```\nfeat: x", expected: "feat: x" },
		{ name: "unfenced text", reply: "feat: x", expected: "feat: x" },
		{
			name: "interior inline fences",
			reply: "feat: x\n\nadds a ```code``` sample",
			expected: "feat: x\n\nadds a ```code``` sample",
		},
		{ name: "surrounding whitespace", reply: "  feat: x \n", expected: "feat: x" },
		{ name: "an all-fence reply", reply: "```\n```", expected: "" },
		{ name: "the empty reply", reply: "", expected: "" },
		// The model fenced the subject and went on in prose: both of the block's fences are furniture. Judging each
		// end alone left this closer in the message written to the SCM box.
		{
			name: "a fenced subject followed by prose",
			reply: "```\nfeat: add thing\n```\n\nThis commit adds a thing.",
			expected: "feat: add thing\n\nThis commit adds a thing.",
		},
		// A longer pair must strip to nothing; a three-backtick match left a stray backtick here.
		{ name: "a longer all-fence reply", reply: "````\n````", expected: "" },
		{
			name: "a four-backtick wrapper around a three-backtick block",
			reply: "````\nfeat: x\n\n```ts\ncode\n```\n````",
			expected: "feat: x\n\n```ts\ncode\n```",
		},
		{
			name: "a lone opener before a nested block keeps that block's closer",
			reply: "```\nfeat: x\n\n```ts\ncode\n```",
			expected: "feat: x\n\n```ts\ncode\n```",
		},
	];
	for (const { name, reply, expected } of cases) {
		test(name, () => {
			assert.strictEqual(stripMarkdownFences(reply), expected);
		});
	}
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

describe("shared/util/text truncation markers", () => {
	test("truncationMarker is the one bracketed-label shape", () => {
		assert.strictEqual(truncationMarker("diff"), "[diff truncated]");
		assert.strictEqual(truncationMarker("commit messages"), "[commit messages truncated]");
	});

	test("appendTruncationMarker joins on its own line; an empty prefix is the bare marker", () => {
		assert.strictEqual(appendTruncationMarker("kept", "[x truncated]"), "kept\n[x truncated]");
		assert.strictEqual(appendTruncationMarker("", "[x truncated]"), "[x truncated]");
	});

	test("truncateHeadWithMarker passes text at or under the budget verbatim, marker-free", () => {
		assert.strictEqual(truncateHeadWithMarker("abc", 3, "[t truncated]"), "abc");
		assert.strictEqual(truncateHeadWithMarker("abc", 100, "[t truncated]"), "abc");
	});

	test("a cut result - head, line break, and marker - never exceeds the budget", () => {
		const marker = truncationMarker("diff");
		for (const budget of [30, 40, 100]) {
			const cut = truncateHeadWithMarker("d".repeat(budget + 1), budget, marker);
			assert.strictEqual(cut.length, budget);
			assert.ok(cut.endsWith(`\n${marker}`));
			assert.strictEqual(cut, `${"d".repeat(budget - marker.length - 1)}\n${marker}`);
		}
	});

	test("a budget too small to keep any text still holds the bound: the marker fits or is itself cut", () => {
		const marker = "[t truncated]";
		assert.strictEqual(truncateHeadWithMarker("x".repeat(50), marker.length + 1, marker), marker);
		assert.strictEqual(truncateHeadWithMarker("x".repeat(50), marker.length, marker), marker);
		assert.strictEqual(truncateHeadWithMarker("x".repeat(50), 3, marker), "[t ");
		for (const budget of [0, 3, marker.length, marker.length + 1]) {
			assert.ok(truncateHeadWithMarker("x".repeat(50), budget, marker).length <= budget);
		}
	});

	test("the cut is surrogate-safe: an astral character straddling the cut vanishes whole", () => {
		const marker = "[t truncated]"; // 13 units; the cut keeps budget - 14
		const budget = 20;
		const text = `${"a".repeat(budget - marker.length - 2)}\u{1F600}${"b".repeat(budget)}`;
		const cut = truncateHeadWithMarker(text, budget, marker);
		assert.ok(cut.isWellFormed());
		assert.ok(!cut.includes("\u{1F600}"));
		assert.ok(cut.length <= budget);
	});
});
