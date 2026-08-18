import * as assert from "node:assert";
import type { ServerUsageState } from "../../../extension/servers/usage/store";
import { UNPROBED_ENDPOINTS, UsageStore } from "../../../extension/servers/usage/store";
import type { MessageAction } from "../../../extension/ui/notifier";
import { UsageAlerts } from "../../../extension/ui/usageAlerts";

function stateAt(label: string, spentFraction: number, crossedThresholds: readonly number[]): ServerUsageState {
	const effectiveBudget = 100;
	return {
		label,
		baseUrl: `http://${label}.test`,
		endpoints: { ...UNPROBED_ENDPOINTS, keyInfo: { kind: "ok" } },
		availability: "available",
		lastUpdatedAt: Date.now(),
		spendUpdatedAt: Date.now(),
		lastAttemptAt: Date.now(),
		key: {
			spend: spentFraction * effectiveBudget,
			maxBudget: effectiveBudget,
			softBudget: undefined,
			budgetResetAt: undefined,
			hasUser: false,
		},
		daily: undefined,
		user: undefined,
		budget: {
			entryBudget: undefined,
			keyBudget: effectiveBudget,
			effectiveBudget,
			budgetSource: "key",
			spend: spentFraction * effectiveBudget,
			spentFraction,
			budgetResetAt: undefined,
			crossedThresholds,
		},
	};
}

interface RecordedToast {
	kind: "info" | "warning" | "error";
	message: string;
	actions: MessageAction[];
}

function harness() {
	const store = new UsageStore();
	const toasts: RecordedToast[] = [];
	const alerts = new UsageAlerts(store, async (kind, message, actions) => {
		toasts.push({ kind, message, actions });
	});
	return { store, toasts, alerts };
}

suite("extension/ui usageAlerts", () => {
	test("a steady-state refresh with nothing newly crossed stays silent", () => {
		const { store, toasts } = harness();

		store.upsert(stateAt("prod", 0.5, []), []);
		store.upsert(stateAt("prod", 0.82, [0.8]), []);

		assert.strictEqual(toasts.length, 0, "the store's newlyCrossedThresholds is the only trigger");
	});

	test("one poll jumping several thresholds fires ONE warning for the highest only", () => {
		const { store, toasts } = harness();

		store.upsert(stateAt("prod", 0.97, [0.8, 0.95]), [0.8, 0.95]);

		assert.strictEqual(toasts.length, 1);
		const toast = toasts[0];
		assert.ok(toast !== undefined);
		assert.strictEqual(toast.kind, "warning", "all budget notifications use the one severity");
		assert.strictEqual(toast.message, 'LiteLLM: "prod" has used at least 97% of its budget (alert at 95%)');
	});

	test("the toast names the server, the threshold, and the current spend percentage", () => {
		const { store, toasts } = harness();

		store.upsert(stateAt("staging", 0.82, [0.8]), [0.8]);

		assert.strictEqual(toasts[0]?.message, 'LiteLLM: "staging" has used at least 82% of its budget (alert at 80%)');
		assert.deepStrictEqual(
			toasts[0]?.actions.map((action) => action.label),
			["Open Usage", "Dismiss"]
		);
	});

	test("a non-whole threshold renders exactly as configured while the spend still floors", () => {
		const { store, toasts } = harness();

		store.upsert(stateAt("prod", 0.858, [0.855]), [0.855]);

		// The floored spend reads below the threshold it just crossed, which only
		// "at least" makes true: 85% is a lower bound, 85.5% the exact trigger.
		assert.strictEqual(toasts[0]?.message, 'LiteLLM: "prod" has used at least 85% of its budget (alert at 85.5%)');
	});

	test("a re-armed threshold (spend dropped below, then crossed again) toasts again", () => {
		const { store, toasts } = harness();

		store.upsert(stateAt("prod", 0.82, [0.8]), [0.8]);
		// The budget reset: spend fell below every threshold, re-arming them.
		store.upsert(stateAt("prod", 0.1, []), []);
		store.upsert(stateAt("prod", 0.85, [0.8]), [0.8]);

		assert.strictEqual(toasts.length, 2, "the store re-arms below-threshold; a fresh crossing reports again");
	});

	test("alerts are per server entry: two labels crossing independently both toast", () => {
		const { store, toasts } = harness();

		store.upsert(stateAt("prod", 0.82, [0.8]), [0.8]);
		store.upsert(stateAt("staging", 0.81, [0.8]), [0.8]);

		assert.strictEqual(toasts.length, 2);
		assert.ok(toasts[0]?.message.includes('"prod"'));
		assert.ok(toasts[1]?.message.includes('"staging"'));
	});

	test("removal events and disposal never toast", () => {
		const { store, toasts, alerts } = harness();
		store.upsert(stateAt("prod", 0.5, []), []);

		store.prune(() => false);
		assert.strictEqual(toasts.length, 0);

		alerts.dispose();
		store.upsert(stateAt("prod", 0.99, [0.8, 0.95]), [0.8, 0.95]);
		assert.strictEqual(toasts.length, 0, "a disposed subscriber must stop hearing events");
	});
});
