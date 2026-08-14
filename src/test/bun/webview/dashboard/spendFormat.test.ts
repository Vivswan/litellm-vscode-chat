/**
 * The shared spend formatters (spendFormat.ts): money and percentage
 * printing, and the fraction-to-tone bar presentation every spend surface
 * reads. Pure functions, so this suite renders nothing.
 */
import { describe, expect, test } from "bun:test";
import { barPresentation, formatMoney, formatPercent } from "../../../../webview/dashboard/spendFormat";

describe("barPresentation", () => {
	test("tones scale to the configured thresholds, crossing at >=", () => {
		expect(barPresentation(0.5, [0.8, 0.95]).tone).toBe("ok");
		expect(barPresentation(0.8, [0.8, 0.95]).tone).toBe("warn");
		expect(barPresentation(0.95, [0.8, 0.95]).tone).toBe("error");
	});

	test("a single-threshold list goes straight to error", () => {
		expect(barPresentation(0.5, [0.5]).tone).toBe("error");
	});

	test("an empty list never escalates and the fill clamps at 100%", () => {
		const over = barPresentation(1.12, []);
		expect(over.tone).toBe("ok");
		expect(over.widthPercent).toBe(100);
	});
});

describe("formatting", () => {
	test("percentages show the literal number past 100", () => {
		expect(formatPercent(1.12)).toBe("112%");
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
