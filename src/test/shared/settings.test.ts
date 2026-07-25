import * as assert from "node:assert";
import {
	clampTimeout,
	DEFAULT_DISCOVERY_TIMEOUT_MS,
	DEFAULT_REQUEST_TIMEOUT_MS,
	MIN_TIMEOUT_MS,
} from "../../shared/settings";

suite("shared/settings clampTimeout", () => {
	test("passes valid timeouts through without logging", () => {
		const logged: unknown[] = [];
		const result = clampTimeout(5000, DEFAULT_DISCOVERY_TIMEOUT_MS, "discoveryTimeout", (msg, data) =>
			logged.push({ msg, data })
		);
		assert.strictEqual(result, 5000);
		assert.strictEqual(logged.length, 0);
	});

	test("clamps sub-minimum values to the minimum and logs", () => {
		const logged: { msg: string; data?: unknown }[] = [];
		const result = clampTimeout(500, DEFAULT_REQUEST_TIMEOUT_MS, "requestTimeout", (msg, data) =>
			logged.push({ msg, data })
		);
		assert.strictEqual(result, MIN_TIMEOUT_MS);
		assert.strictEqual(logged.length, 1);
		assert.ok(logged[0].msg.includes("requestTimeout"));
		assert.deepStrictEqual(logged[0].data, { configured: 500, clamped: MIN_TIMEOUT_MS });
	});

	test("falls back to the default for NaN", () => {
		const logged: unknown[] = [];
		const result = clampTimeout(Number.NaN, DEFAULT_DISCOVERY_TIMEOUT_MS, "discoveryTimeout", () => logged.push(true));
		assert.strictEqual(result, DEFAULT_DISCOVERY_TIMEOUT_MS);
		assert.strictEqual(logged.length, 1);
	});

	test("falls back to the default for non-finite and non-number values", () => {
		assert.strictEqual(clampTimeout(Number.POSITIVE_INFINITY, 30000, "discoveryTimeout"), 30000);
		assert.strictEqual(clampTimeout(Number.NEGATIVE_INFINITY, 30000, "discoveryTimeout"), 30000);
		assert.strictEqual(clampTimeout("5000", 30000, "discoveryTimeout"), 30000);
		assert.strictEqual(clampTimeout(undefined, 30000, "discoveryTimeout"), 30000);
	});

	test("clamps when the fallback itself is below the minimum", () => {
		assert.strictEqual(clampTimeout(Number.NaN, 100, "requestTimeout"), MIN_TIMEOUT_MS);
	});
});
