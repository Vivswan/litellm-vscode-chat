import * as assert from "node:assert";
import {
	isUsageFresh,
	POLLING_OFF_FRESHNESS_WINDOW_MS,
	usageFreshnessWindowMs,
} from "../../../../extension/servers/usage/freshness";
import type { ServerUsageState } from "../../../../extension/servers/usage/store";
import { UNPROBED_ENDPOINTS } from "../../../../extension/servers/usage/store";

const NOW = Date.UTC(2026, 7, 1, 12);
const POLL_INTERVAL_MS = 300_000;

function baseState(overrides: Partial<ServerUsageState> = {}): ServerUsageState {
	return {
		label: "alpha",
		baseUrl: "http://alpha.test",
		endpoints: { ...UNPROBED_ENDPOINTS, keyInfo: { kind: "ok" } },
		availability: "available",
		lastUpdatedAt: NOW - 1_000,
		spendUpdatedAt: NOW - 1_000,
		lastAttemptAt: NOW - 1_000,
		key: { spend: 10, maxBudget: 100, softBudget: undefined, budgetResetAt: undefined, hasUser: false },
		daily: undefined,
		user: undefined,
		budget: {
			entryBudget: undefined,
			keyBudget: 100,
			effectiveBudget: 100,
			budgetSource: "key",
			spend: 10,
			spentFraction: 0.1,
			budgetResetAt: undefined,
			crossedThresholds: [],
		},
		...overrides,
	};
}

/** The tests age the SPEND numbers; mirror lastUpdatedAt overrides into spendUpdatedAt. */
function state(overrides: Partial<ServerUsageState> = {}): ServerUsageState {
	const merged = baseState(overrides);
	return { ...merged, spendUpdatedAt: "spendUpdatedAt" in overrides ? overrides.spendUpdatedAt : merged.lastUpdatedAt };
}

suite("extension/servers/usage freshness", () => {
	test("the window is two poll intervals, and the documented ten minutes with polling off", () => {
		assert.strictEqual(usageFreshnessWindowMs(POLL_INTERVAL_MS), 2 * POLL_INTERVAL_MS);
		assert.strictEqual(usageFreshnessWindowMs(0), POLLING_OFF_FRESHNESS_WINDOW_MS);
		assert.strictEqual(POLLING_OFF_FRESHNESS_WINDOW_MS, 600_000);
	});

	test("data inside the window is fresh; exactly two intervals old is already stale", () => {
		const justInside = state({ lastUpdatedAt: NOW - (2 * POLL_INTERVAL_MS - 1) });
		assert.strictEqual(isUsageFresh(justInside, NOW, POLL_INTERVAL_MS), true);

		const atBoundary = state({ lastUpdatedAt: NOW - 2 * POLL_INTERVAL_MS });
		assert.strictEqual(isUsageFresh(atBoundary, NOW, POLL_INTERVAL_MS), false, "the boundary itself is stale");
	});

	test("with polling off the window is ten minutes", () => {
		const nineMinutes = state({ lastUpdatedAt: NOW - 9 * 60_000 });
		assert.strictEqual(isUsageFresh(nineMinutes, NOW, 0), true);

		const tenMinutes = state({ lastUpdatedAt: NOW - POLLING_OFF_FRESHNESS_WINDOW_MS });
		assert.strictEqual(isUsageFresh(tenMinutes, NOW, 0), false);
	});

	test("only a server whose key endpoint currently answers counts as fresh", () => {
		assert.strictEqual(isUsageFresh(state({ lastUpdatedAt: undefined }), NOW, POLL_INTERVAL_MS), false);
		assert.strictEqual(isUsageFresh(state({ key: undefined }), NOW, POLL_INTERVAL_MS), false);
		assert.strictEqual(
			isUsageFresh(state({ endpoints: { ...UNPROBED_ENDPOINTS, keyInfo: { kind: "error" } } }), NOW, POLL_INTERVAL_MS),
			false,
			"a failing key endpoint means the last fetch did not succeed"
		);
		assert.strictEqual(
			isUsageFresh(
				state({ endpoints: { ...UNPROBED_ENDPOINTS, keyInfo: { kind: "unavailable", reason: "unsupported" } } }),
				NOW,
				POLL_INTERVAL_MS
			),
			false
		);
	});
});
