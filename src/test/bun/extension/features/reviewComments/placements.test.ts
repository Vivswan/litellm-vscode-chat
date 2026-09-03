import { describe, expect, test } from "bun:test";
import {
	NO_FINDINGS_REPLY,
	type ParsedPlacements,
	parsePlacements,
	type ReviewPlacement,
} from "../../../../../extension/features/reviewComments/placements";

/** Shorthand for the expected result shape; `sawNoFindings` defaults off, as it is for any answer without the sentinel. */
function parsed(placements: readonly ReviewPlacement[], dropped: number, sawNoFindings = false): ParsedPlacements {
	return { placements, dropped, sawNoFindings };
}

describe("extension/features/reviewComments/placements", () => {
	test("well-formed single-line and ranged findings parse in answer order", () => {
		const answer = "LINE 3: The handle leaks.\nLINE 4-6: The retry loop never backs off.";
		expect(parsePlacements(answer, 10)).toEqual(
			parsed(
				[
					{ startLine: 3, endLine: 3, body: "The handle leaks." },
					{ startLine: 4, endLine: 6, body: "The retry loop never backs off." },
				],
				0
			)
		);
	});

	test("an answer that is nothing but whitespace or fences yields zero placements and no sentinel", () => {
		// The distinction the caller acts on: nothing here SAYS the file is clean,
		// so a caller must not clear a file's comments over it.
		for (const answer of ["", "   \n\n\t", "```\n```"]) {
			expect(parsePlacements(answer, 10)).toEqual(parsed([], 0));
		}
	});

	test("the no-findings sentinel is recognized through case, punctuation, and fences, and reported", () => {
		// The sentinel's spelling is what the prompt tells the model to answer, and
		// the signature is frozen because the review commands call it positionally.
		const parse: (answer: string, lineCount: number) => ParsedPlacements = parsePlacements;
		expect(NO_FINDINGS_REPLY).toBe("NO FINDINGS");
		const cases = [NO_FINDINGS_REPLY, "no findings.", "No findings!", "**No-Findings.**", "```\nNO FINDINGS\n```"];
		for (const answer of cases) {
			expect(parse(answer, 10)).toEqual(parsed([], 0, true));
		}
	});

	test("a line with extra words or digits inside the sentinel is not the sentinel: dropped and counted", () => {
		const cases = ["NO 123 FINDINGS", "there are no findings here", "no findings 123", "NO FINDINGS \u6f0f\u6d1e"];
		for (const answer of cases) {
			expect(parsePlacements(answer, 10)).toEqual(parsed([], 1));
		}
	});

	test("interleaved garbage is dropped and counted without breaking the findings around it", () => {
		const answer = [
			"Here is my review:",
			"```",
			"LINE 2: First finding.",
			"The rest of the code looks fine to me.",
			"LINE 7: Second finding.",
			"```",
			"Let me know if you need more detail.",
		].join("\n");
		expect(parsePlacements(answer, 10)).toEqual(
			parsed(
				[
					{ startLine: 2, endLine: 2, body: "First finding." },
					{ startLine: 7, endLine: 7, body: "Second finding." },
				],
				3
			)
		);
	});

	test("markdown decoration is tolerated: bullets, blockquotes, bold anchors, lowercase, spaced ranges", () => {
		const answer = [
			"- **Line 12:** The cache is never invalidated.",
			"> LINE 2: Quoted finding.",
			"**LINE 5: Fully bolded finding.**",
			"* line 7 - 9: Spaced range.",
		].join("\n");
		expect(parsePlacements(answer, 20)).toEqual(
			parsed(
				[
					{ startLine: 12, endLine: 12, body: "The cache is never invalidated." },
					{ startLine: 2, endLine: 2, body: "Quoted finding." },
					{ startLine: 5, endLine: 5, body: "Fully bolded finding." },
					{ startLine: 7, endLine: 9, body: "Spaced range." },
				],
				0
			)
		);
	});

	test("balanced emphasis inside a body is the body's own and stays untouched", () => {
		const body = "**Null deref** when x is **undefined**";
		expect(parsePlacements(`LINE 3: ${body}`, 10)).toEqual(parsed([{ startLine: 3, endLine: 3, body }], 0));
	});

	test("out-of-range anchors clamp into the document and reversed ranges reorder", () => {
		const answer = [
			"LINE 0: Below the file.",
			"LINE 99: Past the end.",
			"LINE 8-99: Tail range.",
			"LINE 9-4: Reversed.",
			"LINE -2: Negative anchor.",
			"LINE -9--2: Negative range.",
		].join("\n");
		expect(parsePlacements(answer, 10)).toEqual(
			parsed(
				[
					{ startLine: 1, endLine: 1, body: "Below the file." },
					{ startLine: 10, endLine: 10, body: "Past the end." },
					{ startLine: 8, endLine: 10, body: "Tail range." },
					{ startLine: 4, endLine: 9, body: "Reversed." },
					{ startLine: 1, endLine: 1, body: "Negative anchor." },
					{ startLine: 1, endLine: 1, body: "Negative range." },
				],
				0
			)
		);
	});

	test("a degenerate line count clamps everything to line one", () => {
		for (const lineCount of [0, -5, Number.NaN, Number.NEGATIVE_INFINITY]) {
			expect(parsePlacements("LINE 7-9: x", lineCount)).toEqual(parsed([{ startLine: 1, endLine: 1, body: "x" }], 0));
		}
		expect(parsePlacements("LINE 7-9: x", 7.9)).toEqual(parsed([{ startLine: 7, endLine: 7, body: "x" }], 0));
	});

	test("an absurd line count caps at MAX_SAFE_INTEGER, so anchors stay safe integers", () => {
		const max = Number.MAX_SAFE_INTEGER;
		expect(parsePlacements(`LINE ${"9".repeat(400)}: x`, 1e30)).toEqual(
			parsed([{ startLine: max, endLine: max, body: "x" }], 0)
		);
	});

	test("malformed finding lines drop with a count and never throw", () => {
		const answer = [
			"LINE: missing number.",
			"LINE abc: not a number.",
			"LINE -: dash without digits.",
			"LINE 3:",
			"LINE 3:   ",
			"LINES 3: plural.",
		].join("\n");
		expect(parsePlacements(answer, 10)).toEqual(parsed([], 6));
	});

	test("hostile input is handled totally: null bytes, CRLF, huge anchors, whitespace runs, very long lines", () => {
		const cases: readonly [string, ParsedPlacements][] = [
			[
				"LINE 1: a\r\nLINE 2: b",
				parsed(
					[
						{ startLine: 1, endLine: 1, body: "a" },
						{ startLine: 2, endLine: 2, body: "b" },
					],
					0
				),
			],
			[
				"LINE 1: a\rLINE 2: b",
				parsed(
					[
						{ startLine: 1, endLine: 1, body: "a" },
						{ startLine: 2, endLine: 2, body: "b" },
					],
					0
				),
			],
			["\0LINE 1: x", parsed([], 1)],
			["LINE", parsed([], 1)],
			[`LINE 2: ${"y".repeat(50_000)}`, parsed([{ startLine: 2, endLine: 2, body: "y".repeat(50_000) }], 0)],
			[
				"LINE 1234567890: huge anchors clamp saturatingly.",
				parsed([{ startLine: 5, endLine: 5, body: "huge anchors clamp saturatingly." }], 0),
			],
			[`LINE 12${" ".repeat(100_000)}`, parsed([], 1)],
			[`LINE 2${" ".repeat(100_000)}: spaced colon.`, parsed([{ startLine: 2, endLine: 2, body: "spaced colon." }], 0)],
		];
		for (const [answer, expected] of cases) {
			expect(parsePlacements(answer, 5)).toEqual(expected);
		}
	});

	test("the result carries counts only: no field of a drop-heavy parse echoes the answer text", () => {
		const answer = "sk-secret-token leaked here\nanother prose line";
		const result = parsePlacements(answer, 3);
		expect(result).toEqual(parsed([], 2));
		expect(JSON.stringify(result)).not.toContain("sk-secret-token");
	});
});
