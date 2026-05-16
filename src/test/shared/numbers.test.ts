import * as assert from "assert";
import { normalizePositiveNumber } from "../../shared/numbers";

suite("shared/numbers", () => {
	test("normalizePositiveNumber accepts positive numbers and numeric strings", () => {
		assert.equal(normalizePositiveNumber(123), 123);
		assert.equal(normalizePositiveNumber("123"), 123);
		assert.equal(normalizePositiveNumber("1.5e5"), 150000);
	});

	test("normalizePositiveNumber rejects malformed and non-positive values", () => {
		assert.equal(normalizePositiveNumber("128000abc"), undefined);
		assert.equal(normalizePositiveNumber(""), undefined);
		assert.equal(normalizePositiveNumber(0), undefined);
		assert.equal(normalizePositiveNumber(-1), undefined);
		assert.equal(normalizePositiveNumber("NaN"), undefined);
	});
});
