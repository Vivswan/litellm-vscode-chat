import * as assert from "node:assert";
import {
	clampTimeout,
	DEFAULT_DISCOVERY_CACHE_TTL_MS,
	DEFAULT_DISCOVERY_TIMEOUT_MS,
	DEFAULT_REQUEST_TIMEOUT_MS,
	getDiscoveryCacheTtl,
	MIN_TIMEOUT_MS,
} from "../../shared/settings";
import { expectDefined, withConfig } from "../testUtils";

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
		const entry = expectDefined(logged[0]);
		assert.ok(entry.msg.includes("requestTimeout"));
		assert.deepStrictEqual(entry.data, { configured: 500, clamped: MIN_TIMEOUT_MS });
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

suite("shared/settings getDiscoveryCacheTtl", () => {
	test("passes valid values through without logging, including 0", async () => {
		const logged: unknown[] = [];
		await withConfig({ discoveryCacheTtl: 60000 }, () => {
			assert.strictEqual(
				getDiscoveryCacheTtl(() => logged.push(true)),
				60000
			);
		});
		await withConfig({ discoveryCacheTtl: 0 }, () => {
			assert.strictEqual(
				getDiscoveryCacheTtl(() => logged.push(true)),
				0
			);
		});
		assert.strictEqual(logged.length, 0);
	});

	test("uses the default when nothing is configured", async () => {
		await withConfig({}, () => {
			assert.strictEqual(getDiscoveryCacheTtl(), DEFAULT_DISCOVERY_CACHE_TTL_MS);
		});
	});

	test("clamps negative values to 0 and logs", async () => {
		const logged: { msg: string; data?: unknown }[] = [];
		await withConfig({ discoveryCacheTtl: -5 }, () => {
			assert.strictEqual(
				getDiscoveryCacheTtl((msg, data) => logged.push({ msg, data })),
				0
			);
		});
		const entry = expectDefined(logged[0]);
		assert.ok(entry.msg.includes("discoveryCacheTtl"));
		assert.deepStrictEqual(entry.data, { configured: -5, clamped: 0 });
	});

	test("falls back to the default for non-finite and non-number values", async () => {
		for (const raw of [Number.NaN, Number.POSITIVE_INFINITY, "60000", null, true]) {
			const logged: unknown[] = [];
			await withConfig({ discoveryCacheTtl: raw }, () => {
				assert.strictEqual(
					getDiscoveryCacheTtl(() => logged.push(true)),
					DEFAULT_DISCOVERY_CACHE_TTL_MS,
					`configured value ${String(raw)} must fall back to the default`
				);
			});
			assert.strictEqual(logged.length, 1, `configured value ${String(raw)} must be logged`);
		}
	});
});
