import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { safeCut, secretSpans } from "../../../../shared/util/secretMask";

describe("shared/util/secretMask", () => {
	test("secretSpans finds every spelling on the original text, merges overlaps, and keeps a value only for a lone raw occurrence", () => {
		assert.deepStrictEqual(
			[
				secretSpans("abc123xyz", ["abc123", "123xyz"]),
				secretSpans("GET http://host/?token=pa%20ss%2f1", ["pa ss/1"]),
				secretSpans("key abc%20XYZ", ["abc%20XY", "abc XYZ"]),
				secretSpans("short abc beside abcd", ["abc", "abcd"]),
			],
			[
				[{ from: 0, to: 9, value: undefined }],
				[{ from: 23, to: 34, value: undefined }],
				[{ from: 4, to: 13, value: undefined }],
				[{ from: 17, to: 21, value: "abcd" }],
			]
		);
	});

	test("a lone surrogate costs only the percent spelling: the raw and the form spelling are still found", () => {
		// encodeURIComponent throws on "\uD800"; the form encoding writes U+FFFD. Were the two computed in one try, the
		// throw would abort both and the form spelling would never be registered.
		const value = "abc\uD800def";
		assert.deepStrictEqual(secretSpans(`raw ${value} form abc%EF%BF%BDdef`, [value]), [
			{ from: 4, to: 11, value },
			{ from: 17, to: 32, value: undefined },
		]);
	});

	test("safeCut's work is bounded by the cut, not the text: a two-megabyte line of one repeated value answers at once", () => {
		const started = performance.now();
		const at = safeCut("a".repeat(2_000_000), 262_144, ["aaaa"]);
		const elapsed = performance.now() - started;
		assert.deepStrictEqual({ at, fast: elapsed < 1000 }, { at: 0, fast: true }, `${elapsed.toFixed(0)} ms`);
	});

	test("safeCut moves a cut off a value astride it, and leaves a cut at a value's edge or between values alone", () => {
		assert.deepStrictEqual(
			[
				safeCut("abc secret-Q7 def", 9, ["secret-Q7"]),
				safeCut("abc secret-Q7 def", 4, ["secret-Q7"]),
				safeCut("abc secret-Q7 def", 3, ["secret-Q7"]),
				safeCut("abc secret-Q7 def", 13, ["secret-Q7"]),
			],
			[4, 4, 3, 13]
		);
	});
});
