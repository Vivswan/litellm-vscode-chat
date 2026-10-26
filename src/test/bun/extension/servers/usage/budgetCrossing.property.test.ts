/**
 * The threshold-crossing state drives budget alerts, so its dedup contract gets property coverage: crossings are
 * exactly the at-or-above thresholds, a steady fraction never re-reports, and dropping below a threshold re-arms it.
 */
import { describe, test } from "bun:test";
import * as assert from "node:assert";
import * as fc from "fast-check";
import { crossedThresholds, newlyCrossedThresholds } from "../../../../../extension/servers/usage/budget";
import { resolveFuzzSeed } from "../../../../fuzzStream";

/** Cases per property; CI sets FUZZ_RUNS above this local default. */
const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 200;

/** The seed every property here shares, printed once so a failing run replays. */
const SEED = resolveFuzzSeed();

/** Fractions as spend/budget produces them: mostly in range, some junk. */
const fractionArb = fc.oneof(
	{ weight: 6, arbitrary: fc.double({ min: 0, max: 1.5, noNaN: true }) },
	{ weight: 1, arbitrary: fc.constantFrom(undefined, Number.NaN, Number.POSITIVE_INFINITY) }
);

/** Threshold lists as the setting reader emits them, plus unvalidated junk entries. */
const thresholdsArb = fc.array(
	fc.oneof(
		{ weight: 5, arbitrary: fc.double({ min: Number.MIN_VALUE, max: 1, noNaN: true }) },
		{ weight: 1, arbitrary: fc.constantFrom(0, -0.5, 2, Number.NaN) }
	),
	{ maxLength: 6 }
);

/**
 * The thresholds `fraction` newly crosses this step: each armed one at or below it, which it disarms; the ones above
 * it re-arm. `armed` is the oracle's one flag per threshold, carried across the fraction sequence.
 */
function expectedNewlyCrossed(fraction: number, ascending: readonly number[], armed: Map<number, boolean>): number[] {
	const expected: number[] = [];
	for (const t of ascending) {
		if (fraction < t) {
			armed.set(t, true);
			continue;
		}
		if (armed.get(t) === true) {
			expected.push(t);
		}
		armed.set(t, false);
	}
	return expected;
}

describe("extension/servers/usage threshold-crossing properties", () => {
	test("crossings are exactly the usable at-or-above thresholds, deduplicated ascending", () => {
		fc.assert(
			fc.property(fractionArb, thresholdsArb, (fraction, thresholds) => {
				const crossed = crossedThresholds(fraction, thresholds);
				const usable = [...new Set(thresholds.filter((t) => Number.isFinite(t) && t > 0 && t <= 1))];
				const expected =
					fraction === undefined || !Number.isFinite(fraction)
						? []
						: usable.filter((t) => fraction >= t).sort((a, b) => a - b);
				assert.deepStrictEqual(crossed, expected);
				for (let i = 1; i < crossed.length; i += 1) {
					assert.ok((crossed[i] as number) > (crossed[i - 1] as number));
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("a steady fraction reports nothing new (dedup) and replaying is idempotent", () => {
		fc.assert(
			fc.property(fractionArb, thresholdsArb, (fraction, thresholds) => {
				const first = crossedThresholds(fraction, thresholds);
				const second = crossedThresholds(fraction, thresholds);
				assert.deepStrictEqual(newlyCrossedThresholds(first, second), []);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("a fraction sequence reports each threshold exactly at its upward crossings (re-arm on drop)", () => {
		fc.assert(
			fc.property(
				fc.array(fc.double({ min: 0, max: 1.5, noNaN: true }), { minLength: 1, maxLength: 20 }),
				fc.array(fc.double({ min: 0.05, max: 1, noNaN: true }), { minLength: 1, maxLength: 4 }),
				(fractions, rawThresholds) => {
					const thresholds = [...new Set(rawThresholds)];
					const ascending = [...thresholds].sort((a, b) => a - b);
					// Oracle: one armed flag per threshold, re-armed whenever the fraction sits below it.
					const armed = new Map<number, boolean>(thresholds.map((t) => [t, true]));
					let previous: readonly number[] = [];
					for (const fraction of fractions) {
						const crossed = crossedThresholds(fraction, thresholds);
						const newly = newlyCrossedThresholds(previous, crossed);
						assert.deepStrictEqual([...newly], expectedNewlyCrossed(fraction, ascending, armed));
						previous = crossed;
					}
				}
			),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});
