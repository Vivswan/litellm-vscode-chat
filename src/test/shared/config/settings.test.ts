import * as assert from "node:assert";
import {
	DEFAULT_DISCOVERY_CACHE_TTL_MS,
	DEFAULT_DISCOVERY_TIMEOUT_MS,
	DEFAULT_REQUEST_TIMEOUT_MS,
	getDiscoveryCacheTtl,
	getDiscoveryTimeout,
	getModelCapabilitiesConfig,
	getRequestTimeout,
	getUsagePollIntervalMs,
	MIN_TIMEOUT_MS,
	MIN_USAGE_POLL_INTERVAL_MS,
	MODEL_CAPABILITIES_SETTING_KEY,
	normalizeCustomHeaders,
	normalizeModelCapabilities,
} from "../../../shared/config/settings";
import { expectDefined, withConfig } from "../../testUtils";

suite("shared/config/settings timeout getters", () => {
	test("pass valid timeouts through without logging", async () => {
		const logged: unknown[] = [];
		await withConfig({ "discovery.timeout": 5000 }, () => {
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
		await withConfig({ "chat.timeout": 500 }, () => {
			assert.strictEqual(
				getRequestTimeout((msg, data) => logged.push({ msg, data })),
				MIN_TIMEOUT_MS
			);
		});
		assert.strictEqual(logged.length, 1);
		const entry = expectDefined(logged[0]);
		assert.ok(entry.msg.includes("chat.timeout"));
		assert.deepStrictEqual(entry.data, { configured: 500, clamped: MIN_TIMEOUT_MS });
	});

	test("fall back to the default for NaN", async () => {
		const logged: unknown[] = [];
		await withConfig({ "discovery.timeout": Number.NaN }, () => {
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
			await withConfig({ "discovery.timeout": raw }, () => {
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

suite("shared/config/settings getDiscoveryCacheTtl", () => {
	test("passes valid values through without logging, including 0", async () => {
		const logged: unknown[] = [];
		await withConfig({ "discovery.cacheTtl": 60000 }, () => {
			assert.strictEqual(
				getDiscoveryCacheTtl(() => logged.push(true)),
				60000
			);
		});
		await withConfig({ "discovery.cacheTtl": 0 }, () => {
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
		await withConfig({ "discovery.cacheTtl": -5 }, () => {
			assert.strictEqual(
				getDiscoveryCacheTtl((msg, data) => logged.push({ msg, data })),
				0
			);
		});
		const entry = expectDefined(logged[0]);
		assert.ok(entry.msg.includes("discovery.cacheTtl"));
		assert.deepStrictEqual(entry.data, { configured: -5, clamped: 0 });
	});

	test("falls back to the default for non-finite and non-number values", async () => {
		for (const raw of [Number.NaN, Number.POSITIVE_INFINITY, "60000", null, true]) {
			const logged: unknown[] = [];
			await withConfig({ "discovery.cacheTtl": raw }, () => {
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

suite("shared/config/settings normalizeCustomHeaders", () => {
	test("values with CR, LF, or CRLF are dropped by the shared header-value predicate", () => {
		const logged: { msg: string; data: unknown }[] = [];
		const headers = normalizeCustomHeaders(
			{
				"x-cr": "start\rend",
				"x-lf": "start\nend",
				"x-crlf": "start\r\nend",
				"x-ok": "value",
			},
			(msg, data) => logged.push({ msg, data })
		);

		assert.deepStrictEqual(headers, { "x-ok": "value" });
		assert.strictEqual(logged.length, 3, "each rejected header logs exactly once");
		for (const entry of logged) {
			assert.ok(entry.msg.includes("cannot be sent as an HTTP header"), entry.msg);
			// The classification names the header, never the value: these values
			// can be secrets and the log buffer feeds public issue reports.
			assert.ok(!JSON.stringify(entry).includes("start"), "the rejected value must not reach the log");
		}
	});

	test("other control octets fail the same predicate the platform Headers enforces; empty stays legal", () => {
		const headers = normalizeCustomHeaders({ "x-nul": "a\u0000b", "x-del": "a\u007fb", "x-empty": "" });
		assert.deepStrictEqual(headers, { "x-empty": "" }, "an empty field value is legal HTTP and must keep flowing");
	});

	test("scalar values stringify and travel; tab and obs-text stay legal", () => {
		const headers = normalizeCustomHeaders({ "x-num": 42, "x-bool": true, "x-tab": "a\tb", "x-hi": "caf\u00e9" });
		assert.deepStrictEqual(headers, { "x-num": "42", "x-bool": "true", "x-tab": "a\tb", "x-hi": "caf\u00e9" });
	});

	test("invalid names, non-scalar values, and non-record inputs drop without throwing", () => {
		assert.deepStrictEqual(normalizeCustomHeaders({ "bad name": "v", "x-obj": { nested: 1 }, "x-ok": "v" }), {
			"x-ok": "v",
		});
		assert.deepStrictEqual(normalizeCustomHeaders("not a record"), {});
		assert.deepStrictEqual(normalizeCustomHeaders(undefined), {});
	});
});

suite("shared/config/settings normalizeModelCapabilities", () => {
	test("keeps the record-of-records shape and stays vocabulary-blind", () => {
		// Shape only, deliberately: unknown keys and invalid values survive here
		// so parseCapabilityRecord (the one vocabulary boundary) can diagnose
		// them instead of them silently vanishing.
		const raw = {
			"gpt-4": { context_length: 128000, supports_pdf_input: true, context_window: "128k" },
			"http://a.test/claude": { _declare: true },
		};
		assert.deepStrictEqual(normalizeModelCapabilities(raw), raw);
	});

	test("one malformed entry drops only itself; unsafe and non-record inputs drop entirely", () => {
		assert.deepStrictEqual(normalizeModelCapabilities({ "gpt-4": { supports_vision: true }, bad: "not a record" }), {
			"gpt-4": { supports_vision: true },
		});
		const polluted = JSON.parse('{"__proto__": {"x": 1}, "constructor": {"y": 2}, "gpt-4": {}}');
		assert.deepStrictEqual(normalizeModelCapabilities(polluted), { "gpt-4": {} });
		assert.deepStrictEqual(normalizeModelCapabilities("not a record"), {});
		assert.deepStrictEqual(normalizeModelCapabilities(undefined), {});
	});

	test("getModelCapabilitiesConfig reads the modelCapabilities setting through the normalizer", async () => {
		await withConfig({ [MODEL_CAPABILITIES_SETTING_KEY]: { "gpt-4": { supports_vision: true }, bad: 1 } }, () => {
			assert.deepStrictEqual(getModelCapabilitiesConfig(), { "gpt-4": { supports_vision: true } });
		});
		await withConfig({}, () => {
			assert.deepStrictEqual(getModelCapabilitiesConfig(), {});
		});
	});
});

suite("shared/config/settings getUsagePollIntervalMs", () => {
	test("zero stays the off switch; tiny positive values clamp up; negatives clamp to zero", async () => {
		await withConfig({ "usage.pollInterval": 0 }, () => {
			assert.strictEqual(getUsagePollIntervalMs(), 0);
		});
		await withConfig({ "usage.pollInterval": 1 }, () => {
			assert.strictEqual(getUsagePollIntervalMs(), MIN_USAGE_POLL_INTERVAL_MS, "a 1ms loop must not ship");
		});
		await withConfig({ "usage.pollInterval": -5 }, () => {
			assert.strictEqual(getUsagePollIntervalMs(), 0, "negatives read as the off switch");
		});
		await withConfig({ "usage.pollInterval": 600000 }, () => {
			assert.strictEqual(getUsagePollIntervalMs(), 600000);
		});
	});
});
