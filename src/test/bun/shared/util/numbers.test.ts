import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { normalizeCostPerToken, normalizePositiveNumber } from "../../../../shared/util/numbers";

describe("shared/util/numbers", () => {
	test("normalizePositiveNumber accepts positive numbers and numeric strings", () => {
		assert.equal(normalizePositiveNumber(123), 123);
		assert.equal(normalizePositiveNumber("123"), 123);
		assert.equal(normalizePositiveNumber("1.5e5"), 150000);
	});

	test("normalizePositiveNumber rejects malformed and non-positive values", () => {
		assert.equal(normalizePositiveNumber("128000abc"), undefined);
		assert.equal(normalizePositiveNumber("1.5"), undefined);
		assert.equal(normalizePositiveNumber(1.5), undefined);
		assert.equal(normalizePositiveNumber(""), undefined);
		assert.equal(normalizePositiveNumber(0), undefined);
		assert.equal(normalizePositiveNumber(-1), undefined);
		assert.equal(normalizePositiveNumber("NaN"), undefined);
	});

	test("normalizeCostPerToken accepts non-negative finite numbers, including fractions and zero", () => {
		assert.equal(normalizeCostPerToken(0.000003), 0.000003);
		assert.equal(normalizeCostPerToken(0), 0, "zero is a real cost: a free model");
		assert.equal(normalizeCostPerToken(15), 15);
		const negativeZero = normalizeCostPerToken(-0);
		assert.strictEqual(negativeZero, 0);
		assert.ok(!Object.is(negativeZero, -0), "-0 canonicalizes to 0 so no negative-signed cost leaks");
	});

	test("normalizeCostPerToken rejects strings, negatives, and non-finite values", () => {
		assert.equal(normalizeCostPerToken("0.000003"), undefined, "costs are numbers only, never string-coerced");
		assert.equal(normalizeCostPerToken(-0.000003), undefined);
		assert.equal(normalizeCostPerToken(Number.NaN), undefined);
		assert.equal(normalizeCostPerToken(Number.POSITIVE_INFINITY), undefined);
		assert.equal(normalizeCostPerToken(null), undefined);
		assert.equal(normalizeCostPerToken(undefined), undefined);
	});
});
