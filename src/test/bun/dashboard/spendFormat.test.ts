/**
 * The shared spend vocabulary (src/dashboard/spendFormat.ts): money and
 * percentage printing, the fraction-to-tone map, and the worst-fraction
 * reducer that the meter, the row diagnostics, the Servers header, and the
 * status bar all read. Pure functions, so this suite renders nothing.
 */
import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import {
	barPresentation,
	formatMoney,
	formatPercent,
	formatPercentExact,
	spendTone,
	usableThresholds,
	worstSpendTone,
} from "../../../dashboard/spendFormat";
import { resolveFuzzSeed } from "../../fuzzStream";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 300;
const SEED = resolveFuzzSeed();

describe("spendTone", () => {
	test("the whole fraction-to-tone table, threshold edge cases included", () => {
		const table: readonly [number, readonly number[], string][] = [
			// The default two-threshold scale, crossing at >=.
			[0.5, [0.8, 0.95], "ok"],
			[0.8, [0.8, 0.95], "warn"],
			[0.95, [0.8, 0.95], "error"],
			// A single-threshold list goes straight to error; below it is ok, never warn.
			[0.5, [0.5], "error"],
			[0.49, [0.5], "ok"],
			// An empty list never warns, but past the whole budget is error regardless.
			[0.99, [], "ok"],
			[1, [], "ok"],
			[1.0001, [], "error"],
			[1.3, [], "error"],
			// Exactly the budget crosses a 1.0 threshold (>=), and >1 is error on any list.
			[1, [1], "error"],
			[1.12, [0.8, 0.95], "error"],
			[1.12, [0.5], "error"],
		];
		for (const [fraction, thresholds, tone] of table) {
			expect(spendTone(fraction, thresholds)).toBe(tone as ReturnType<typeof spendTone>);
		}
	});

	test("junk thresholds are filtered before the scale forms: only finite fractions in (0, 1] participate", () => {
		expect(spendTone(0.9, [0, -0.5, 2, Number.NaN, Number.POSITIVE_INFINITY])).toBe("ok");
		// The one usable value survives dedup and acts as lowest AND highest.
		expect(spendTone(0.9, [2, 0.8, Number.NaN, 0.8])).toBe("error");
		expect(usableThresholds([2, 0.95, Number.NaN, 0.8, 0.8, 0])).toEqual([0.8, 0.95]);
	});
});

describe("barPresentation", () => {
	test("the fill clamps at 100% while the tone keeps escalating", () => {
		const over = barPresentation(1.12, []);
		expect(over.widthPercent).toBe(100);
		expect(over.tone).toBe("error");
		expect(barPresentation(0.42, [0.8, 0.95])).toEqual({ widthPercent: 42, tone: "ok" });
	});

	test("the tone is spendTone's, never a second scale", () => {
		for (const fraction of [0, 0.5, 0.8, 0.95, 1, 1.12]) {
			for (const thresholds of [[], [0.5], [0.8, 0.95]] as const) {
				expect(barPresentation(fraction, thresholds).tone).toBe(spendTone(fraction, thresholds));
			}
		}
	});
});

describe("worstSpendTone", () => {
	test("reduces to the maximum fraction and its shared tone; no contributors means no position", () => {
		expect(worstSpendTone([], [0.8, 0.95])).toBeUndefined();
		expect(worstSpendTone([0.42, 0.87], [0.8, 0.95])).toEqual({ worst: 0.87, tone: "warn" });
		// A maximum, never a sum: two half-spent budgets stay at the larger half.
		expect(worstSpendTone([0.5, 0.5], [0.8, 0.95])).toEqual({ worst: 0.5, tone: "ok" });
		// Over the whole budget is error even with alerts off.
		expect(worstSpendTone([0.2, 1.3], [])).toEqual({ worst: 1.3, tone: "error" });
	});
});

describe("formatting", () => {
	test("percentages floor to the greatest whole percent reached, past 100 included", () => {
		// A floor, never a round: the tone map compares fraction >= threshold, so
		// 0.995 beside two-threshold [0.8, 0.95] tones error but must not claim
		// a "100%" it never reached; likewise 0.845 has not reached 85%.
		expect(formatPercent(1.12)).toBe("112%");
		expect(formatPercent(0.845)).toBe("84%");
		expect(formatPercent(0.995)).toBe("99%");
		// Float artifacts stay corrected: 0.57 * 100 floats to 56.999..., yet the
		// 0.57 threshold IS reached at 0.57 under >=, so the floor may not drop it.
		expect(formatPercent(0.57)).toBe("57%");
		expect(formatPercent(0.29)).toBe("29%");
		expect(formatPercent(0)).toBe("0%");
	});

	test("pathological fractions terminate: non-finite products and integers past ulp-1 territory", () => {
		// The computation is bounded by construction; these inputs are the ones
		// where a corrective walk would spin (Infinity - 1 === Infinity, and
		// percent + 1 is a value no-op past 2^53).
		expect(formatPercent(Number.NaN)).toBe("NaN%");
		expect(formatPercent(Number.POSITIVE_INFINITY)).toBe("Infinity%");
		expect(formatPercent(Number.MAX_VALUE)).toBe("Infinity%");
		expect(formatPercent(2 ** 53)).toMatch(/^\d+%$/);
	});

	test("the monotonicity pin: no rendered percent the fraction has not reached under >=", () => {
		// The property every threshold surface leans on: if the string says "80%",
		// then fraction >= 0.80 is true under the exact comparison spendTone and
		// the alert store run - and the percent is the greatest such, so the
		// display never understates a crossing either.
		fc.assert(
			fc.property(fc.double({ min: 0, max: 10, noNaN: true, noDefaultInfinity: true }), (fraction) => {
				const rendered = formatPercent(fraction);
				const percent = Number(rendered.slice(0, -1));
				expect(Number.isInteger(percent)).toBe(true);
				expect(fraction >= percent / 100).toBe(true);
				expect(fraction >= (percent + 1) / 100).toBe(false);
			}),
			{ seed: SEED, numRuns: NUM_RUNS }
		);
	});

	test("configured trigger points render unfloored, float noise trimmed", () => {
		// formatPercent floors reached amounts under the >= scale; a threshold the
		// user WROTE has nothing to floor - 0.855 is the 85.5% trigger, not "85%".
		expect(formatPercentExact(0.855)).toBe("85.5%");
		expect(formatPercentExact(0.85)).toBe("85%");
		expect(formatPercentExact(1)).toBe("100%");
		// Float noise stays trimmed: 0.565 * 100 floats just below 56.5.
		expect(formatPercentExact(0.565)).toBe("56.5%");
	});

	test("money amounts keep cents below 1000 and take the configured symbol verbatim", () => {
		expect(formatMoney(12.5, "$")).toBe("$12.50");
		expect(formatMoney(1500, "$")).toBe("$1,500");
	});

	test("one locale policy for the whole column: grouping never asks the ambient locale", () => {
		// The status bar (extension host) and the dashboard (webview) can run
		// under different ambient locales; a de-DE toLocaleString() would print
		// "1.500" beside toFixed's "12.50" in the same column. The pin: an
		// ambient-locale call (no locale argument) fails the test outright.
		const original = Number.prototype.toLocaleString;
		Number.prototype.toLocaleString = function (this: number, ...args: Parameters<typeof original>) {
			if (args[0] === undefined) {
				throw new Error("formatMoney consulted the ambient locale");
			}
			return original.apply(this, args);
		};
		try {
			expect(formatMoney(1500, "$")).toBe("$1,500");
			expect(formatMoney(1234567.89, "")).toBe("1,234,568");
			expect(formatMoney(999.99, "$")).toBe("$999.99");
		} finally {
			Number.prototype.toLocaleString = original;
		}
	});

	test("a multi-character symbol prefixes verbatim, spacing included", () => {
		expect(formatMoney(12.5, "EUR ")).toBe("EUR 12.50");
		expect(formatMoney(1500, "EUR ")).toBe("EUR 1,500");
	});

	test("the empty symbol renders the bare number with no stray space", () => {
		expect(formatMoney(12.5, "")).toBe("12.50");
		expect(formatMoney(1500, "")).toBe("1,500");
	});
});
