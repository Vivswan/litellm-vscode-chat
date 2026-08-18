import * as assert from "node:assert";
import type { ServerUsageState } from "../../../../extension/servers/usage";
import { UNPROBED_ENDPOINTS, UsageStore, usageAvailabilityOf } from "../../../../extension/servers/usage/store";

function state(label: string, overrides: Partial<ServerUsageState> = {}): ServerUsageState {
	return {
		label,
		baseUrl: `http://${label}.test`,
		endpoints: UNPROBED_ENDPOINTS,
		availability: "unknown",
		lastUpdatedAt: undefined,
		spendUpdatedAt: undefined,
		lastAttemptAt: undefined,
		key: undefined,
		daily: undefined,
		user: undefined,
		budget: {
			entryBudget: undefined,
			keyBudget: undefined,
			effectiveBudget: undefined,
			budgetSource: "none",
			spend: undefined,
			spentFraction: undefined,
			budgetResetAt: undefined,
			crossedThresholds: [],
		},
		...overrides,
	};
}

suite("extension/servers/usage store", () => {
	test("getStates is label-sorted regardless of insertion order", () => {
		const store = new UsageStore();
		store.upsert(state("gamma"), []);
		store.upsert(state("alpha"), []);
		store.upsert(state("beta"), []);

		assert.deepStrictEqual(
			store.getStates().map((entry) => entry.label),
			["alpha", "beta", "gamma"]
		);
	});

	test("a throwing listener is isolated and logged; the others still hear the event", () => {
		const logged: string[] = [];
		const store = new UsageStore((message) => logged.push(message));
		let heard = 0;
		store.onDidChange(() => {
			throw new Error("consumer bug");
		});
		store.onDidChange(() => {
			heard += 1;
		});

		store.upsert(state("alpha"), []);

		assert.strictEqual(heard, 1);
		assert.ok(logged.some((line) => line.includes("listener failed")));
	});

	test("prune emits one removal per dropped label and keeps the rest", () => {
		const store = new UsageStore();
		const events: string[] = [];
		store.onDidChange((event) => events.push(`${event.kind}:${event.label}`));
		store.upsert(state("alpha"), []);
		store.upsert(state("beta"), []);

		store.prune((label) => label === "alpha");
		store.prune((label) => label === "alpha");

		assert.deepStrictEqual(events, ["updated:alpha", "updated:beta", "removed:beta"]);
		assert.strictEqual(store.get("beta"), undefined);
		assert.ok(store.get("alpha") !== undefined);
	});

	test("a disposed subscription stops hearing events", () => {
		const store = new UsageStore();
		let heard = 0;
		const subscription = store.onDidChange(() => {
			heard += 1;
		});
		store.upsert(state("alpha"), []);
		subscription.dispose();
		store.upsert(state("alpha"), []);

		assert.strictEqual(heard, 1);
	});

	test("availability derives from the two data endpoints, not the rollup", () => {
		assert.strictEqual(usageAvailabilityOf(UNPROBED_ENDPOINTS), "unknown");
		assert.strictEqual(usageAvailabilityOf({ ...UNPROBED_ENDPOINTS, dailyActivity: { kind: "ok" } }), "available");
		assert.strictEqual(
			usageAvailabilityOf({
				keyInfo: { kind: "unavailable", reason: "unsupported" },
				dailyActivity: { kind: "unavailable", reason: "forbidden" },
				userInfo: { kind: "unknown" },
			}),
			"unavailable"
		);
		assert.strictEqual(
			usageAvailabilityOf({
				keyInfo: { kind: "unavailable", reason: "unsupported" },
				dailyActivity: { kind: "error" },
				userInfo: { kind: "unknown" },
			}),
			"unknown",
			"a transient failure must not read as permanently unavailable"
		);
	});
});
