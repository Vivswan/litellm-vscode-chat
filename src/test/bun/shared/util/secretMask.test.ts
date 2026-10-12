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

	test("a raw value holding a percent escape matches the escape in either hex case: a password written encoded in a URL", () => {
		// The collector registers the password as written and decoded ("pass%4Ass", "passJss"); a line that carries
		// the URL in lowercase escapes holds neither literally.
		assert.deepStrictEqual(secretSpans("GET http://u:pass%4ass@h.test", ["pass%4Ass", "passJss"]), [
			{ from: 13, to: 22, value: "pass%4Ass" },
		]);
	});

	test("only a complete percent escape folds its case: a percent sign followed by one hex digit and a non-hex one is literal", () => {
		// "100%off" and "100%oFf" are not the same percent encoding (both throw on decodeURIComponent), nor are
		// "key%Ag-Q7" and "key%ag-Q7": the hex digit after "%o" or before "g" opens no escape.
		assert.deepStrictEqual(
			[
				secretSpans("coupon 100%oFf", ["100%off"]),
				secretSpans("coupon key%ag-Q7", ["key%Ag-Q7"]),
				secretSpans("coupon 100%off", ["100%off"]),
			],
			[[], [], [{ from: 7, to: 14, value: "100%off" }]]
		);
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
