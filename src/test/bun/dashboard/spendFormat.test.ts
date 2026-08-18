/**
 * The shared spend vocabulary (src/dashboard/spendFormat.ts): money and
 * percentage printing, the fraction-to-tone map, and the worst-fraction
 * reducer that the meter, the row diagnostics, the Servers header, and the
 * status bar all read. Pure functions, so this suite renders nothing.
 */
import { describe, expect, test } from "bun:test";
import {
	barPresentation,
	formatMoney,
	formatPercent,
	spendTone,
	usableThresholds,
	worstSpendTone,
} from "../../../dashboard/spendFormat";

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
	test("percentages show the literal number past 100", () => {
		expect(formatPercent(1.12)).toBe("112%");
		expect(formatPercent(0.845)).toBe("85%");
	});

	test("money amounts keep cents below 1000 and take the configured symbol verbatim", () => {
		expect(formatMoney(12.5, "$")).toBe("$12.50");
		expect(formatMoney(1500, "$")).toBe("$1,500");
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
