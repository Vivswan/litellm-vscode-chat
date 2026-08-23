/**
 * Totality and bounds properties for parsePlacements. Two properties with two
 * different generators, because they pin different halves of the contract:
 * the noise property feeds arbitrary and grammar-adjacent strings to pin "any
 * string parses without throwing and nothing escapes its bounds"; the
 * structured property renders known findings (including saturating huge
 * anchors) interleaved with known garbage, so nearly every run exercises real
 * placements - counts, order, bodies, and clamped bounds - rather than
 * spending its runs deep inside noise that parses to nothing. The
 * example-based leniency rules live in placements.test.ts.
 */
import { describe, test } from "bun:test";
import * as assert from "node:assert";
import * as fc from "fast-check";
import { parsePlacements } from "../../../../../extension/features/reviewComments/placements";
import { resolveFuzzSeed } from "../../../../fuzzStream";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 300;
const SEED = resolveFuzzSeed();

const grammarToken = fc.constantFrom(
	"LINE ",
	"line",
	"Line 3",
	":",
	"-",
	"**",
	" ",
	"\t",
	"\n",
	"\r\n",
	"0",
	"7",
	"23",
	"999999999",
	"1234567890",
	"x",
	"finding text",
	"```",
	"> ",
	"- ",
	"NO FINDINGS"
);
const answerArb = fc.oneof(fc.string({ maxLength: 200 }), fc.string({ unit: grammarToken, maxLength: 60 }));
const lineCountArb = fc.oneof(fc.integer({ min: -100, max: 100_000 }), fc.double());

/** Anchor digits: exact small numbers (signed - negatives clamp to line one) plus runs long enough to saturate parseInt. */
const anchorArb = fc.oneof(
	fc.integer({ min: -1_000_000, max: 1_000_000 }).map(String),
	fc.constantFrom("99999999999999999999", "9".repeat(400))
);

/** A rendered well-formed finding line; every shape here must parse to exactly one placement. */
const findingArb = fc
	.record({
		prefix: fc.constantFrom("", "- ", "> ", "* ", "**"),
		start: anchorArb,
		end: fc.option(anchorArb, { nil: undefined }),
		bodyId: fc.integer({ min: 0, max: 999 }),
	})
	.map(({ prefix, start, end, bodyId }) => ({
		line: `${prefix}LINE ${start}${end === undefined ? "" : `-${end}`}: finding ${bodyId}`,
		body: `finding ${bodyId}`,
	}));

/** Known garbage: `counted` says whether the parser must report it dropped (fences, blanks, and the sentinel are ignored silently). */
const noiseArb = fc.constantFrom(
	{ line: "", counted: false },
	{ line: "```", counted: false },
	{ line: "NO FINDINGS", counted: false },
	{ line: "The code looks fine to me.", counted: true },
	{ line: "LINE anchorless: no digits.", counted: true }
);

const structuredArb = fc.record({
	entries: fc.array(
		fc.oneof(
			findingArb.map((finding) => ({ kind: "finding" as const, ...finding })),
			noiseArb.map((noise) => ({ kind: "noise" as const, ...noise }))
		),
		{ maxLength: 20 }
	),
	separator: fc.constantFrom("\n", "\r\n", "\r"),
	lineCount: lineCountArb,
});

describe("extension/features/reviewComments/placements properties", () => {
	test("parsePlacements is total and every placement stays inside the document", () => {
		fc.assert(
			fc.property(answerArb, lineCountArb, (answer, lineCount) => {
				const result = parsePlacements(answer, lineCount);
				assert.ok(result.dropped >= 0, "dropped is non-negative");
				assertBounds(result.placements, lineCount);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("rendered findings all parse: counts, order, bodies, and clamped bounds, under any line ending", () => {
		fc.assert(
			fc.property(structuredArb, ({ entries, separator, lineCount }) => {
				const answer = entries.map((entry) => entry.line).join(separator);
				const findings = entries.filter((entry) => entry.kind === "finding");
				const countedNoise = entries.filter((entry) => entry.kind === "noise" && entry.counted).length;
				const result = parsePlacements(answer, lineCount);
				assert.strictEqual(result.placements.length, findings.length, "every rendered finding parses");
				assert.strictEqual(result.dropped, countedNoise, "exactly the counted garbage drops");
				result.placements.forEach((placement, index) => {
					assert.strictEqual(placement.body, findings[index]?.body, "bodies ride through in order");
				});
				assertBounds(result.placements, lineCount);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});

function assertBounds(
	placements: readonly { startLine: number; endLine: number; body: string }[],
	lineCount: number
): void {
	const maxLine = Number.isFinite(lineCount)
		? Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.floor(lineCount)))
		: 1;
	for (const placement of placements) {
		assert.ok(Number.isSafeInteger(placement.startLine), "startLine is a safe integer");
		assert.ok(Number.isSafeInteger(placement.endLine), "endLine is a safe integer");
		assert.ok(placement.startLine >= 1, "startLine >= 1");
		assert.ok(placement.startLine <= placement.endLine, "range is ordered");
		assert.ok(placement.endLine <= maxLine, "endLine inside the document");
		assert.ok(placement.body.length > 0, "body is non-empty");
	}
}
