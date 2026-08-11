/**
 * The capability display helpers: the $/M cost formatter's rounding rules
 * (pinned - both inspectors render through it) and the consumed-field label
 * coverage. The formatter contract: zero is "$0", a dollar and up rounds to
 * cents, sub-dollar values keep three significant digits with trailing zeros
 * trimmed but never below two decimals, and NOTHING ever renders in
 * scientific notation - the raw wire values (5e-7) stringify exponentially,
 * which is exactly the regression this pins against.
 */
import * as assert from "node:assert";
import {
	COST_CAPABILITY_FIELDS,
	capabilityDisplayLabel,
	formatCostPerMillion,
	isCostCapabilityField,
	parameterCountText,
} from "../../../shared/config/capabilityDisplay";
import { CONSUMED_CAPABILITY_FIELDS } from "../../../shared/config/capabilityResolution";

suite("shared/config/capabilityDisplay formatCostPerMillion", () => {
	test("renders whole-dollar and cent values with exactly two decimals", () => {
		assert.strictEqual(formatCostPerMillion(0.000005), "$5.00");
		assert.strictEqual(formatCostPerMillion(0.000025), "$25.00");
		assert.strictEqual(formatCostPerMillion(6.25e-6), "$6.25");
		assert.strictEqual(formatCostPerMillion(3.75e-5), "$37.50");
		assert.strictEqual(formatCostPerMillion(0.000001), "$1.00");
	});

	test("the 5e-7 regression case renders as $0.50, never scientific notation", () => {
		assert.strictEqual(formatCostPerMillion(5e-7), "$0.50");
	});

	test("sub-dollar values trim trailing zeros but keep at least two decimals", () => {
		assert.strictEqual(formatCostPerMillion(3e-7), "$0.30");
		assert.strictEqual(formatCostPerMillion(1.23e-7), "$0.123");
		assert.strictEqual(formatCostPerMillion(2.5e-8), "$0.025");
	});

	test("sub-cent values keep enough digits to stay non-zero", () => {
		assert.strictEqual(formatCostPerMillion(4e-10), "$0.0004");
		assert.strictEqual(formatCostPerMillion(4.56e-10), "$0.000456");
		assert.strictEqual(formatCostPerMillion(1e-12), "$0.000001");
	});

	test("values of a dollar and up round to cents", () => {
		assert.strictEqual(formatCostPerMillion(1.23456e-6), "$1.23");
		assert.strictEqual(formatCostPerMillion(9.999e-6), "$10.00");
		assert.strictEqual(formatCostPerMillion(0.001234), "$1234.00");
	});

	test("boundary rounding never carries into scientific notation or false zeros", () => {
		// Just under a cent: three significant digits, honest sub-cent price.
		assert.strictEqual(formatCostPerMillion(9.99e-9), "$0.00999");
		// Rounds up across the cent boundary and trims back to cents.
		assert.strictEqual(formatCostPerMillion(9.9999e-9), "$0.01");
	});

	test("zero is $0 (a genuinely free model), and -0 does not leak a sign", () => {
		assert.strictEqual(formatCostPerMillion(0), "$0");
		assert.strictEqual(formatCostPerMillion(-0), "$0");
	});

	test("a negative cost keeps its sign (defensive: validation refuses negatives upstream)", () => {
		assert.strictEqual(formatCostPerMillion(-5e-7), "-$0.50");
	});

	test("no input in the representable range ever renders scientific notation", () => {
		// A sweep across magnitudes, including the denormal-adjacent tail.
		for (let exponent = -18; exponent <= 12; exponent += 1) {
			const rendered = formatCostPerMillion(3.21 * 10 ** exponent);
			assert.doesNotMatch(rendered, /e/i, `10^${exponent} rendered as ${rendered}`);
		}
		assert.doesNotMatch(formatCostPerMillion(1e18), /e/i);
	});

	test("extreme values stay plain digits: tiny costs keep their one digit, huge ones never show infinity", () => {
		// 1e-27 per token is 1e-21 $/M; the digit survives (toFixed's 100-digit cap).
		assert.strictEqual(formatCostPerMillion(1e-27), "$0.000000000000000000001");
		// MAX_VALUE * 1e6 overflows to Infinity; the fallback writes digits.
		const huge = formatCostPerMillion(Number.MAX_VALUE);
		assert.doesNotMatch(huge, /e/i);
		assert.doesNotMatch(huge, /Infinity|∞/i);
		assert.match(huge, /^\$\d+000000$/);
	});
});

suite("shared/config/capabilityDisplay labels", () => {
	test("every consumed field has a friendly label; unknown keys have none", () => {
		for (const name of Object.keys(CONSUMED_CAPABILITY_FIELDS)) {
			assert.notStrictEqual(capabilityDisplayLabel(name), undefined, `no label for consumed field ${name}`);
		}
		assert.strictEqual(capabilityDisplayLabel("supports_web_search"), undefined);
		assert.strictEqual(capabilityDisplayLabel("toString"), undefined);
	});

	test("the cost-field list is exactly the consumed cost vocabulary, base tier first", () => {
		const consumedCosts = Object.entries(CONSUMED_CAPABILITY_FIELDS)
			.filter(([, kind]) => kind === "cost")
			.map(([name]) => name);
		assert.deepStrictEqual([...COST_CAPABILITY_FIELDS].sort(), [...consumedCosts].sort());
		assert.strictEqual(COST_CAPABILITY_FIELDS[0], "input_cost_per_token");
		for (const name of COST_CAPABILITY_FIELDS) {
			assert.ok(isCostCapabilityField(name));
		}
		assert.ok(!isCostCapabilityField("context_length"));
	});

	test("the parameter count picks the singular and plural readings", () => {
		assert.strictEqual(parameterCountText(1), "1 parameter");
		assert.strictEqual(parameterCountText(0), "0 parameters");
		assert.strictEqual(parameterCountText(27), "27 parameters");
	});
});
