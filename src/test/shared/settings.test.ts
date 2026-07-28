import * as assert from "node:assert";
import {
	DEFAULT_DISCOVERY_CACHE_TTL_MS,
	DEFAULT_DISCOVERY_TIMEOUT_MS,
	DEFAULT_REQUEST_TIMEOUT_MS,
	getDiscoveryCacheTtl,
	getDiscoveryTimeout,
	getRequestTimeout,
	MIN_TIMEOUT_MS,
} from "../../shared/settings";
import { expectDefined, withConfig } from "../testUtils";

suite("shared/settings timeout getters", () => {
	test("pass valid timeouts through without logging", async () => {
		const logged: unknown[] = [];
		await withConfig({ discoveryTimeout: 5000 }, () => {
			assert.strictEqual(
				getDiscoveryTimeout(() => logged.push(true)),
				5000
			);
		});
		assert.strictEqual(logged.length, 0);
	});

	test("use the default when nothing is configured", async () => {
		await withConfig({}, () => {
			assert.strictEqual(getDiscoveryTimeout(), DEFAULT_DISCOVERY_TIMEOUT_MS);
			assert.strictEqual(getRequestTimeout(), DEFAULT_REQUEST_TIMEOUT_MS);
		});
	});

	test("clamp sub-minimum values to the minimum and log", async () => {
		const logged: { msg: string; data?: unknown }[] = [];
		await withConfig({ requestTimeout: 500 }, () => {
			assert.strictEqual(
				getRequestTimeout((msg, data) => logged.push({ msg, data })),
				MIN_TIMEOUT_MS
			);
		});
		assert.strictEqual(logged.length, 1);
		const entry = expectDefined(logged[0]);
		assert.ok(entry.msg.includes("requestTimeout"));
		assert.deepStrictEqual(entry.data, { configured: 500, clamped: MIN_TIMEOUT_MS });
	});

	test("fall back to the default for NaN", async () => {
		const logged: unknown[] = [];
		await withConfig({ discoveryTimeout: Number.NaN }, () => {
			assert.strictEqual(
				getDiscoveryTimeout(() => logged.push(true)),
				DEFAULT_DISCOVERY_TIMEOUT_MS
			);
		});
		assert.strictEqual(logged.length, 1);
	});

	test("fall back to the default for non-finite and non-number values", async () => {
		for (const raw of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "5000", undefined]) {
			const logged: unknown[] = [];
			await withConfig({ discoveryTimeout: raw }, () => {
				assert.strictEqual(
					getDiscoveryTimeout(() => logged.push(true)),
					DEFAULT_DISCOVERY_TIMEOUT_MS,
					`configured value ${String(raw)} must fall back to the default`
				);
			});
			assert.strictEqual(logged.length, 1, `configured value ${String(raw)} must be logged`);
		}
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
