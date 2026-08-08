import * as assert from "node:assert";
import * as fc from "fast-check";
import { crossedThresholds, newlyCrossedThresholds } from "../../../../extension/servers/usage";
import { resolveFuzzSeed } from "../../../fuzzStream";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 200;
const SEED = resolveFuzzSeed();

/**
 * The threshold-crossing state drives budget alerts, so its dedup contract
 * gets property coverage: crossings are exactly the at-or-above thresholds,
 * a steady fraction never re-reports, and dropping below a threshold re-arms
 * it. The oracle below replays a fraction sequence with an independent
 * per-threshold armed flag and must agree with the store's set-difference
 * implementation event for event.
 */

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

suite("extension/servers/usage threshold-crossing properties", () => {
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
				// Sorted ascending and a subset of the usable thresholds.
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
					// Oracle: one armed flag per threshold, re-armed whenever the
					// fraction sits below it.
					const armed = new Map<number, boolean>(thresholds.map((t) => [t, true]));
					let previous: readonly number[] = [];
					for (const fraction of fractions) {
						const crossed = crossedThresholds(fraction, thresholds);
						const newly = newlyCrossedThresholds(previous, crossed);
						const expected: number[] = [];
						for (const t of [...thresholds].sort((a, b) => a - b)) {
							if (fraction >= t) {
								if (armed.get(t) === true) {
									expected.push(t);
								}
								armed.set(t, false);
							} else {
								armed.set(t, true);
							}
						}
						assert.deepStrictEqual([...newly], expected);
						previous = crossed;
					}
				}
			),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});
