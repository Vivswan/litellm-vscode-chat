/**
 * The capability display helpers: the $/M cost formatter's rounding rules (both inspectors render through it), the unit
 * label, and the parameter count. The formatter contract: zero is "$0", a dollar and up rounds to cents, sub-dollar
 * values keep three significant digits with trailing zeros trimmed but never below two decimals, and NOTHING ever
 * renders in scientific notation - the raw wire values (5e-7) stringify exponentially, the regression this pins
 * against.
 */
import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { costUnitLabel, formatCostPerMillion, parameterCountText } from "../../../../shared/config/capabilityDisplay";

describe("shared/config/capabilityDisplay formatCostPerMillion", () => {
	test("each rounding band renders its documented shape", () => {
		const cases: readonly { input: number; expected: string; reason: string }[] = [
			{ input: 0.000005, expected: "$5.00", reason: "whole dollars keep exactly two decimals" },
			{ input: 0.000025, expected: "$25.00", reason: "whole dollars keep exactly two decimals" },
			{ input: 6.25e-6, expected: "$6.25", reason: "cent values keep exactly two decimals" },
			{ input: 3.75e-5, expected: "$37.50", reason: "cent values keep exactly two decimals" },
			{ input: 0.000001, expected: "$1.00", reason: "one dollar keeps exactly two decimals" },
			{ input: 5e-7, expected: "$0.50", reason: "the 5e-7 regression case, never scientific notation" },
			{ input: 3e-7, expected: "$0.30", reason: "sub-dollar trims trailing zeros but keeps two decimals" },
			{ input: 1.23e-7, expected: "$0.123", reason: "sub-dollar keeps three significant digits" },
			{ input: 2.5e-8, expected: "$0.025", reason: "sub-dollar keeps three significant digits" },
			{ input: 4e-10, expected: "$0.0004", reason: "sub-cent keeps enough digits to stay non-zero" },
			{ input: 4.56e-10, expected: "$0.000456", reason: "sub-cent keeps enough digits to stay non-zero" },
			{ input: 1e-12, expected: "$0.000001", reason: "sub-cent keeps enough digits to stay non-zero" },
			{ input: 1.23456e-6, expected: "$1.23", reason: "a dollar and up rounds to cents" },
			{ input: 9.999e-6, expected: "$10.00", reason: "a dollar and up rounds to cents" },
			{ input: 0.001234, expected: "$1234.00", reason: "a dollar and up rounds to cents" },
			{ input: 9.99e-9, expected: "$0.00999", reason: "just under a cent: three significant digits, honest price" },
			{ input: 9.9999e-9, expected: "$0.01", reason: "rounds up across the cent boundary and trims back to cents" },
		];
		for (const { input, expected, reason } of cases) {
			assert.strictEqual(formatCostPerMillion(input, "$"), expected, `${String(input)}: ${reason}`);
		}
	});

	test("zero is $0 (a genuinely free model), and -0 does not leak a sign", () => {
		assert.strictEqual(formatCostPerMillion(0, "$"), "$0");
		assert.strictEqual(formatCostPerMillion(-0, "$"), "$0");
	});

	test("a negative cost keeps its sign (defensive: validation refuses negatives upstream)", () => {
		assert.strictEqual(formatCostPerMillion(-5e-7, "$"), "-$0.50");
	});

	test("no input in the representable range ever renders scientific notation", () => {
		for (let exponent = -18; exponent <= 12; exponent += 1) {
			const rendered = formatCostPerMillion(3.21 * 10 ** exponent, "$");
			assert.doesNotMatch(rendered, /e/i, `10^${exponent} rendered as ${rendered}`);
		}
		assert.doesNotMatch(formatCostPerMillion(1e18, "$"), /e/i);
	});

	test("extreme values stay plain digits: tiny costs keep their one digit, huge ones never show infinity", () => {
		// 1e-27 per token is 1e-21 $/M; the digit survives (toFixed's 100-digit cap).
		assert.strictEqual(formatCostPerMillion(1e-27, "$"), "$0.000000000000000000001");
		// MAX_VALUE * 1e6 overflows to Infinity; the fallback writes digits.
		const huge = formatCostPerMillion(Number.MAX_VALUE, "$");
		assert.doesNotMatch(huge, /e/i);
		assert.doesNotMatch(huge, /Infinity|∞/i);
		assert.match(huge, /^\$\d+000000$/);
	});

	test("the configured symbol prefixes verbatim: multi-character keeps its spacing, empty renders bare numbers", () => {
		assert.strictEqual(formatCostPerMillion(0.000005, "EUR "), "EUR 5.00");
		assert.strictEqual(formatCostPerMillion(0, "EUR "), "EUR 0");
		assert.strictEqual(formatCostPerMillion(-5e-7, "EUR "), "-EUR 0.50");
		assert.strictEqual(formatCostPerMillion(0.000005, ""), "5.00");
		assert.strictEqual(formatCostPerMillion(0, ""), "0");
		assert.strictEqual(formatCostPerMillion(-5e-7, ""), "-0.50");
	});
});

describe("shared/config/capabilityDisplay costUnitLabel", () => {
	test("names the unit with the trimmed symbol; the empty symbol drops the currency claim", () => {
		assert.strictEqual(costUnitLabel("$"), "$ per million tokens");
		assert.strictEqual(costUnitLabel("EUR "), "EUR per million tokens");
		assert.strictEqual(costUnitLabel(""), "per million tokens");
		assert.strictEqual(costUnitLabel("   "), "per million tokens");
	});
});

describe("shared/config/capabilityDisplay parameterCountText", () => {
	test("the parameter count picks the singular and plural readings", () => {
		assert.strictEqual(parameterCountText(1), "1 parameter");
		assert.strictEqual(parameterCountText(0), "0 parameters");
		assert.strictEqual(parameterCountText(27), "27 parameters");
	});
});
