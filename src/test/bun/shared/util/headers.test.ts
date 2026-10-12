import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { trimHttpWhitespace } from "../../../../shared/util/headers";

// The trim is the one rule every credential position reads through, on text of uncontrolled length (a pasted key, a
// configured header, a webview filter).

describe("shared/util/headers trimHttpWhitespace", () => {
	test("the four HTTP whitespace characters are stripped from both ends while inner runs stay, and U+00A0 at either end survives", () => {
		const cases: readonly { readonly input: string; readonly expected: string }[] = [
			{ input: " \t\r\nkey\n\r\t ", expected: "key" },
			{ input: "a \t\r\n b", expected: "a \t\r\n b" },
			{ input: "\u00a0key\u00a0", expected: "\u00a0key\u00a0" },
			{ input: " \u00a0key\u00a0 ", expected: "\u00a0key\u00a0" },
			{ input: " key\u000b\u000c", expected: "key\u000b\u000c" },
			{ input: " \t\r\n", expected: "" },
			{ input: "", expected: "" },
			{ input: "key", expected: "key" },
		];
		assert.deepStrictEqual(
			cases.map(({ input }) => trimHttpWhitespace(input)),
			cases.map(({ expected }) => expected)
		);
	});

	test("the trim's work is linear in the text: two hundred thousand tabs between two letters answer at once", () => {
		const text = `x${"\t".repeat(200_000)}y`;
		const started = performance.now();
		const trimmed = trimHttpWhitespace(text);
		const elapsed = performance.now() - started;
		assert.deepStrictEqual(
			{ unchanged: trimmed === text, fast: elapsed < 200 },
			{ unchanged: true, fast: true },
			`${elapsed.toFixed(0)} ms`
		);
	});
});
