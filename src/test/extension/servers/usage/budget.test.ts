import * as assert from "node:assert";
import { usableThresholds } from "../../../../dashboard/spendFormat";
import type { BudgetStatus, ResolveBudgetInput } from "../../../../extension/servers/usage";
import { crossedThresholds, newlyCrossedThresholds, resolveBudget } from "../../../../extension/servers/usage";
import {
	DEFAULT_USAGE_ALERT_THRESHOLDS,
	getUsageStatusBarMode,
	normalizeUsageAlertThresholds,
	normalizeUsageStatusBarMode,
	type UsageStatusBarMode,
} from "../../../../shared/config/settings";

const THRESHOLDS = [0.8, 0.95] as const;

/** A resolution input with every field stated, overridden per test. */
function input(overrides: Partial<ResolveBudgetInput> = {}): ResolveBudgetInput {
	return {
		entryBudget: undefined,
		keyBudget: undefined,
		spend: undefined,
		budgetResetAt: undefined,
		thresholds: [...THRESHOLDS],
		...overrides,
	};
}

suite("extension/servers/usage budget resolution", () => {
	test("the entry budget wins over the key-reported one, which is retained beside it", () => {
		const status: BudgetStatus = resolveBudget(
			input({ entryBudget: 50, keyBudget: 100, spend: 45, budgetResetAt: 1_700_000_000_000 })
		);

		assert.strictEqual(status.effectiveBudget, 50);
		assert.strictEqual(status.budgetSource, "entry");
		assert.strictEqual(status.keyBudget, 100, "the key-reported budget stays visible beside the effective one");
		assert.strictEqual(status.spentFraction, 0.9);
		assert.strictEqual(status.budgetResetAt, 1_700_000_000_000);
		assert.deepStrictEqual(status.crossedThresholds, [0.8]);
	});

	test("the key-reported budget is the truth when no entry budget is set", () => {
		const status = resolveBudget(input({ keyBudget: 100, spend: 96 }));

		assert.strictEqual(status.effectiveBudget, 100);
		assert.strictEqual(status.budgetSource, "key");
		assert.deepStrictEqual(status.crossedThresholds, [0.8, 0.95]);
	});

	test("a key-reported max_budget of 0 reads as NO budget (zero-means-unlimited), never a fully spent one", () => {
		const status = resolveBudget(input({ keyBudget: 0, spend: 10 }));

		assert.strictEqual(status.keyBudget, undefined);
		assert.strictEqual(status.effectiveBudget, undefined);
		assert.strictEqual(status.budgetSource, "none");
		assert.strictEqual(status.spentFraction, undefined);
		assert.deepStrictEqual(status.crossedThresholds, []);

		// An entry budget covers a zero-reporting key exactly like a missing one.
		const withEntry = resolveBudget(input({ entryBudget: 50, keyBudget: 0, spend: 45 }));
		assert.strictEqual(withEntry.effectiveBudget, 50);
		assert.strictEqual(withEntry.budgetSource, "entry");
		assert.strictEqual(withEntry.keyBudget, undefined, "a zero report is not retained as a real budget");
	});

	test("with neither budget nothing crosses and the fraction is unknown", () => {
		const status = resolveBudget(input({ spend: 123 }));

		assert.strictEqual(status.effectiveBudget, undefined);
		assert.strictEqual(status.budgetSource, "none");
		assert.strictEqual(status.spentFraction, undefined);
		assert.deepStrictEqual(status.crossedThresholds, []);
	});

	test("an unknown spend yields no fraction even with a budget", () => {
		const status = resolveBudget(input({ entryBudget: 50 }));

		assert.strictEqual(status.spentFraction, undefined);
		assert.deepStrictEqual(status.crossedThresholds, []);
	});

	suite("crossedThresholds", () => {
		test("sits at-or-above semantics, deduplicated ascending", () => {
			assert.deepStrictEqual(crossedThresholds(0.8, [0.95, 0.8, 0.8]), [0.8]);
			assert.deepStrictEqual(crossedThresholds(1.2, [0.95, 0.8]), [0.8, 0.95]);
			assert.deepStrictEqual(crossedThresholds(0.5, [0.95, 0.8]), []);
		});

		test("unusable thresholds cannot cross: zero, negatives, NaN, above one", () => {
			assert.deepStrictEqual(crossedThresholds(0.5, [0, -1, Number.NaN, 1.5]), []);
		});
	});

	suite("newlyCrossedThresholds", () => {
		test("reports only what was not crossed before", () => {
			assert.deepStrictEqual(newlyCrossedThresholds([], [0.8]), [0.8]);
			assert.deepStrictEqual(newlyCrossedThresholds([0.8], [0.8, 0.95]), [0.95]);
			assert.deepStrictEqual(newlyCrossedThresholds([0.8, 0.95], [0.8, 0.95]), []);
			assert.deepStrictEqual(newlyCrossedThresholds([0.8], []), []);
		});
	});
});

suite("shared/config/settings usageAlertThresholds normalization", () => {
	test("keeps valid fractions, deduplicated and sorted", () => {
		assert.deepStrictEqual(normalizeUsageAlertThresholds([0.95, 0.8, 0.8, 1]), [0.8, 0.95, 1]);
	});

	test("drops out-of-range entries and keeps the rest", () => {
		const logged: string[] = [];
		const result = normalizeUsageAlertThresholds([0.8, 0, -0.5, 2, Number.NaN, "0.9"], (message) => {
			logged.push(message);
		});
		assert.deepStrictEqual(result, [0.8]);
		assert.strictEqual(logged.length, 1);
	});

	test("a non-array falls back to the default; an empty array is a deliberate off switch", () => {
		assert.deepStrictEqual(normalizeUsageAlertThresholds("0.8"), DEFAULT_USAGE_ALERT_THRESHOLDS);
		assert.deepStrictEqual(normalizeUsageAlertThresholds([]), []);
	});

	test("agrees with the dashboard's usableThresholds on number arrays: one (0, 1] rule, two layers", () => {
		// shared/config cannot import src/dashboard, so the dedup+sort tail exists
		// twice (the (0, 1] bound is the shared isUsableThreshold predicate); this
		// pin holds the two list normalizers together, on number arrays only.
		const rows: readonly (readonly number[])[] = [
			[0.95, 0.8, 0.8, 1],
			[0.8, 0, -0.5, 2, Number.NaN, Number.POSITIVE_INFINITY],
			[],
			[1, Number.MIN_VALUE, 0.5, 0.5],
		];
		for (const row of rows) {
			assert.deepStrictEqual(normalizeUsageAlertThresholds([...row]), usableThresholds(row), `row [${row.join(", ")}]`);
		}
	});
});

suite("shared/config/settings usageStatusBar mode", () => {
	test("narrows to the closed vocabulary, defaulting on anything else", () => {
		const alertsOnly: UsageStatusBarMode = normalizeUsageStatusBarMode("alerts-only");
		assert.strictEqual(alertsOnly, "alerts-only");
		assert.strictEqual(normalizeUsageStatusBarMode("off"), "off");
		assert.strictEqual(normalizeUsageStatusBarMode("sometimes"), "always");
		assert.strictEqual(normalizeUsageStatusBarMode(42), "always");
		assert.strictEqual(normalizeUsageStatusBarMode(undefined), "always");
	});

	test("the live read answers the contributed default when nothing is configured", () => {
		assert.strictEqual(getUsageStatusBarMode(), "always");
	});
});
