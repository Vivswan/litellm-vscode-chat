import * as assert from "node:assert";
import { formatMoney, spendTone } from "../../../dashboard/spendFormat";
import { usageFreshnessWindowMs } from "../../../extension/servers/usage/freshness";
import type { ServerUsageState } from "../../../extension/servers/usage/store";
import { UNPROBED_ENDPOINTS, UsageStore } from "../../../extension/servers/usage/store";
import type { StatusItemLike, StatusItemView } from "../../../extension/ui/status";
import { renderUsageStatus, UsageStatusBar } from "../../../extension/ui/usageStatusItem";

const NOW = Date.UTC(2026, 7, 1, 12);
const POLL_INTERVAL_MS = 300_000;
const POLLING_OFF_WINDOW_MS = 600_000;
const DEFAULT_THRESHOLDS = [0.8, 0.95];

interface UsageStateOptions {
	readonly spend?: number;
	readonly effectiveBudget?: number | undefined;
	readonly entryBudget?: number | undefined;
	readonly keyBudget?: number | undefined;
	readonly lastUpdatedAt?: number | undefined;
	readonly budgetResetAt?: number | undefined;
	readonly keyInfoOk?: boolean;
}

/** A key-answering server state; spend/budget default to a healthy 42% position. */
function usageState(label: string, options: UsageStateOptions = {}): ServerUsageState {
	const spend = options.spend ?? 21;
	const effectiveBudget = "effectiveBudget" in options ? options.effectiveBudget : 50;
	const keyInfoOk = options.keyInfoOk ?? true;
	return {
		label,
		baseUrl: `http://${label}.test`,
		endpoints: { ...UNPROBED_ENDPOINTS, keyInfo: keyInfoOk ? { kind: "ok" } : { kind: "error" } },
		availability: keyInfoOk ? "available" : "unknown",
		lastUpdatedAt: "lastUpdatedAt" in options ? options.lastUpdatedAt : NOW - 60_000,
		// The freshness rule and tooltip read the SPEND age; the tests' single
		// lastUpdatedAt option means exactly that.
		spendUpdatedAt: "lastUpdatedAt" in options ? options.lastUpdatedAt : NOW - 60_000,
		lastAttemptAt: NOW - 60_000,
		key: keyInfoOk
			? {
					spend,
					maxBudget: options.keyBudget,
					softBudget: undefined,
					budgetResetAt: options.budgetResetAt,
					hasUser: false,
				}
			: undefined,
		daily: undefined,
		user: undefined,
		budget: {
			entryBudget: options.entryBudget,
			keyBudget: options.keyBudget,
			effectiveBudget,
			budgetSource: options.entryBudget !== undefined ? "entry" : options.keyBudget !== undefined ? "key" : "none",
			spend,
			spentFraction: effectiveBudget !== undefined && effectiveBudget > 0 ? spend / effectiveBudget : undefined,
			budgetResetAt: options.budgetResetAt,
			crossedThresholds: [],
		},
	};
}

function render(
	states: readonly ServerUsageState[],
	overrides: Partial<{
		nowMs: number;
		pollIntervalMs: number;
		thresholds: readonly number[];
		mode: "always" | "alerts-only" | "off";
		currencySymbol: string;
	}> = {}
) {
	return renderUsageStatus(
		states,
		overrides.nowMs ?? NOW,
		overrides.pollIntervalMs ?? POLL_INTERVAL_MS,
		POLLING_OFF_WINDOW_MS,
		overrides.thresholds ?? DEFAULT_THRESHOLDS,
		overrides.mode ?? "always",
		overrides.currencySymbol ?? "$"
	);
}

/** The visible view, or a loud failure when the renderer hid the item. */
function expectVisible(result: ReturnType<typeof render>) {
	assert.ok(result !== "hidden", "expected a visible view");
	return result;
}

suite("extension/ui usageStatusItem renderUsageStatus", () => {
	test("shows the worst fresh server's percentage, rounded", () => {
		const view = expectVisible(
			render([
				usageState("alpha", { spend: 21, effectiveBudget: 50 }),
				usageState("beta", { spend: 10, effectiveBudget: 100 }),
			])
		);
		assert.strictEqual(view.text, "42%");
		assert.strictEqual(view.severity, "plain");
	});

	test("past 100% the literal number shows", () => {
		const view = expectVisible(render([usageState("alpha", { spend: 56, effectiveBudget: 50 })]));
		assert.strictEqual(view.text, "112%");
	});

	test("hidden when the mode is off, whatever the data says", () => {
		assert.strictEqual(render([usageState("alpha", { spend: 56, effectiveBudget: 50 })], { mode: "off" }), "hidden");
	});

	test("hidden when no server has fresh data", () => {
		const stale = usageState("alpha", { lastUpdatedAt: NOW - 3 * POLL_INTERVAL_MS });
		assert.strictEqual(render([stale]), "hidden");
		assert.strictEqual(render([]), "hidden");
	});

	test("hidden when no fresh server has a budget", () => {
		const budgetless = usageState("alpha", { effectiveBudget: undefined });
		assert.strictEqual(render([budgetless]), "hidden");
	});

	test("a stale server is dropped from the aggregation, not shown as current", () => {
		const fresh = usageState("alpha", { spend: 20, effectiveBudget: 50 });
		const staleWorse = usageState("beta", {
			spend: 99,
			effectiveBudget: 100,
			lastUpdatedAt: NOW - 2 * POLL_INTERVAL_MS,
		});
		const view = expectVisible(render([fresh, staleWorse]));
		assert.strictEqual(view.text, "40%", "the stale 99% must not drive the number");
	});

	test("reaching a threshold counts as crossing it: warning at the lowest, error at the highest", () => {
		const at79 = expectVisible(render([usageState("alpha", { spend: 79, effectiveBudget: 100 })]));
		assert.strictEqual(at79.severity, "plain");

		const at80 = expectVisible(render([usageState("alpha", { spend: 80, effectiveBudget: 100 })]));
		assert.strictEqual(at80.severity, "warning");

		const at95 = expectVisible(render([usageState("alpha", { spend: 95, effectiveBudget: 100 })]));
		assert.strictEqual(at95.severity, "error");
	});

	test("a single-threshold list goes straight to the error background when crossed", () => {
		const crossed = expectVisible(
			render([usageState("alpha", { spend: 50, effectiveBudget: 100 })], { thresholds: [0.5] })
		);
		assert.strictEqual(crossed.severity, "error");

		const below = expectVisible(
			render([usageState("alpha", { spend: 49, effectiveBudget: 100 })], { thresholds: [0.5] })
		);
		assert.strictEqual(below.severity, "plain");
	});

	test("the background is the shared spend tone: one map for the meter, the diagnostic, and this item", () => {
		// The cross-surface equality pin over the threshold edge cases, the empty
		// list and past-100% included: whatever tone src/dashboard's map assigns,
		// the item's severity is its fixed embodiment - never a second scale.
		const severityByTone = { ok: "plain", warn: "warning", error: "error" } as const;
		for (const fraction of [0.42, 0.5, 0.8, 0.95, 1, 1.12]) {
			for (const thresholds of [[], [0.5], [0.8, 0.95], [1]] as const) {
				const view = expectVisible(
					render([usageState("alpha", { spend: fraction * 100, effectiveBudget: 100 })], { thresholds })
				);
				assert.strictEqual(
					view.severity,
					severityByTone[spendTone(fraction, thresholds)],
					`fraction ${fraction} with thresholds [${thresholds.join(", ")}]`
				);
			}
		}
	});

	test("an empty threshold list renders plain up to the whole budget, then error: over-budget outranks alerts-off", () => {
		const under = expectVisible(render([usageState("alpha", { spend: 99, effectiveBudget: 100 })], { thresholds: [] }));
		assert.strictEqual(under.severity, "plain");

		const over = expectVisible(render([usageState("alpha", { spend: 200, effectiveBudget: 100 })], { thresholds: [] }));
		assert.strictEqual(over.severity, "error");
	});

	test("alerts-only shows the item only while something fresh sits at or above the lowest threshold", () => {
		assert.strictEqual(
			render([usageState("alpha", { spend: 42, effectiveBudget: 100 })], { mode: "alerts-only" }),
			"hidden"
		);
		const tripped = expectVisible(
			render([usageState("alpha", { spend: 80, effectiveBudget: 100 })], { mode: "alerts-only" })
		);
		assert.strictEqual(tripped.severity, "warning");
	});

	test("alerts-only with an empty threshold list shows only past the whole budget (the one tone left)", () => {
		assert.strictEqual(
			render([usageState("alpha", { spend: 99, effectiveBudget: 100 })], { mode: "alerts-only", thresholds: [] }),
			"hidden"
		);
		const over = expectVisible(
			render([usageState("alpha", { spend: 200, effectiveBudget: 100 })], { mode: "alerts-only", thresholds: [] })
		);
		assert.strictEqual(over.severity, "error");
	});

	test("alerts-only follows freshness: an over-threshold server going stale hides the item", () => {
		const stale = usageState("alpha", { spend: 99, effectiveBudget: 100, lastUpdatedAt: NOW - 2 * POLL_INTERVAL_MS });
		assert.strictEqual(render([stale], { mode: "alerts-only" }), "hidden");
	});

	test("with polling off the freshness window is ten minutes", () => {
		const nineMinutes = usageState("alpha", { lastUpdatedAt: NOW - 9 * 60_000 });
		assert.ok(render([nineMinutes], { pollIntervalMs: 0 }) !== "hidden");

		const elevenMinutes = usageState("alpha", { lastUpdatedAt: NOW - 11 * 60_000 });
		assert.strictEqual(render([elevenMinutes], { pollIntervalMs: 0 }), "hidden");
	});

	suite("the tooltip breakdown", () => {
		test("carries each server's spend, budget, percentage, reset date, and last-updated", () => {
			const resetAt = Date.UTC(2026, 7, 31);
			const view = expectVisible(
				render([usageState("prod", { spend: 42, effectiveBudget: 50, keyBudget: 50, budgetResetAt: resetAt })])
			);
			const tooltip = view.tooltipLines.join("\n");
			assert.ok(tooltip.includes("prod: $42.00 of $50.00 (84%)"), tooltip);
			assert.ok(
				tooltip.includes(new Date(resetAt).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })),
				tooltip
			);
			assert.ok(tooltip.includes("1 minute ago"), tooltip);
		});

		test("shows both budgets when the entry overrides the key-reported one", () => {
			const view = expectVisible(
				render([usageState("prod", { spend: 42, effectiveBudget: 50, entryBudget: 50, keyBudget: 100 })])
			);
			const tooltip = view.tooltipLines.join("\n");
			assert.ok(tooltip.includes("prod: $42.00 of $50.00 (84%) - key reports $100.00"), tooltip);
		});

		test("a four-figure amount prints exactly as the dashboard card would: the shared formatMoney, never toFixed", () => {
			// The cross-surface money pin: one spend, one string, tooltip and card
			// alike. formatMoney's own shape is pinned in the bun spendFormat suite.
			const view = expectVisible(render([usageState("prod", { spend: 1500, effectiveBudget: 2000, keyBudget: 2000 })]));
			const tooltip = view.tooltipLines.join("\n");
			assert.ok(tooltip.includes(`prod: ${formatMoney(1500, "$")} of ${formatMoney(2000, "$")} (75%)`), tooltip);
			assert.ok(!tooltip.includes("1500.00"), tooltip);
		});

		test("prints amounts with the configured currency symbol verbatim; the empty symbol leaves bare numbers", () => {
			const states = [usageState("prod", { spend: 42, effectiveBudget: 50, keyBudget: 50 })];
			const euro = expectVisible(render(states, { currencySymbol: "EUR " }));
			assert.ok(
				euro.tooltipLines.join("\n").includes("prod: EUR 42.00 of EUR 50.00 (84%)"),
				euro.tooltipLines.join("\n")
			);

			const bare = expectVisible(render(states, { currencySymbol: "" }));
			assert.ok(bare.tooltipLines.join("\n").includes("prod: 42.00 of 50.00 (84%)"), bare.tooltipLines.join("\n"));
		});

		test("notes stale servers and budget-less spend instead of dropping their rows", () => {
			const fresh = usageState("alpha", { spend: 21, effectiveBudget: 50 });
			const stale = usageState("beta", {
				spend: 30,
				effectiveBudget: 60,
				lastUpdatedAt: NOW - 25 * 60_000,
			});
			const budgetless = usageState("gamma", { spend: 5, effectiveBudget: undefined });
			const view = expectVisible(render([fresh, stale, budgetless]));
			const tooltip = view.tooltipLines.join("\n");
			assert.ok(tooltip.includes("beta: $30.00 of $60.00 (50%)"), tooltip);
			assert.ok(tooltip.includes("stale - last updated 25 minutes ago"), tooltip);
			assert.ok(tooltip.includes("gamma: $5.00 spent, no budget"), tooltip);
		});

		test("counts the other fresh servers over a threshold", () => {
			const worst = usageState("alpha", { spend: 96, effectiveBudget: 100 });
			const alsoOver = usageState("beta", { spend: 85, effectiveBudget: 100 });
			const under = usageState("gamma", { spend: 10, effectiveBudget: 100 });
			const view = expectVisible(render([worst, alsoOver, under]));
			assert.ok(view.tooltipLines.includes("1 other server is over an alert threshold"), view.tooltipLines.join("\n"));

			const alone = expectVisible(render([worst, under]));
			assert.ok(
				alone.tooltipLines.every((line) => !line.includes("over an alert threshold")),
				"no line when the worst server is the only one over"
			);
		});

		test("over-budget always counts: with an empty threshold list a second over-budget server still shows", () => {
			const worst = usageState("alpha", { spend: 150, effectiveBudget: 100 });
			const alsoOverBudget = usageState("beta", { spend: 120, effectiveBudget: 100 });
			const under = usageState("gamma", { spend: 99, effectiveBudget: 100 });
			const view = expectVisible(render([worst, alsoOverBudget, under], { thresholds: [] }));
			assert.ok(view.tooltipLines.includes("1 other server is over an alert threshold"), view.tooltipLines.join("\n"));

			const alone = expectVisible(render([worst, under], { thresholds: [] }));
			assert.ok(
				alone.tooltipLines.every((line) => !line.includes("over an alert threshold")),
				"under-budget servers never count without a threshold"
			);
		});
	});
});

class FakeItem implements StatusItemLike {
	readonly command = "litellm.openUsage";
	views: StatusItemView[] = [];
	visible: boolean | undefined;
	disposed = false;

	render(view: StatusItemView): void {
		this.views.push(view);
	}
	show(): void {
		this.visible = true;
	}
	hide(): void {
		this.visible = false;
	}
	dispose(): void {
		this.disposed = true;
	}
}

suite("extension/ui usageStatusItem UsageStatusBar", () => {
	function harness(options: { thresholds?: readonly number[]; mode?: "always" | "alerts-only" | "off" } = {}) {
		const store = new UsageStore();
		const item = new FakeItem();
		const clock = { nowMs: NOW };
		const timers: Array<{ callback: () => void; ms: number; cancelled: boolean }> = [];
		let thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
		let mode = options.mode ?? ("always" as const);
		const bar = new UsageStatusBar({
			store,
			item,
			getMode: () => mode,
			getThresholds: () => thresholds,
			getPollIntervalMs: () => POLL_INTERVAL_MS,
			getPollingOffWindowMs: () => POLLING_OFF_WINDOW_MS,
			getCurrencySymbol: () => "$",
			clock: { now: () => clock.nowMs },
			timer: {
				set: (callback, ms) => {
					const entry = { callback, ms, cancelled: false };
					timers.push(entry);
					return () => {
						entry.cancelled = true;
					};
				},
			},
		});
		return {
			store,
			item,
			clock,
			timers,
			bar,
			setThresholds: (next: readonly number[]) => {
				thresholds = next;
			},
			setMode: (next: "always" | "alerts-only" | "off") => {
				mode = next;
			},
		};
	}

	test("hidden on construction with an empty store; renders on the store's change events", () => {
		const { store, item } = harness();
		assert.strictEqual(item.visible, false, "an empty store renders nothing");

		store.upsert(usageState("alpha", { spend: 42, effectiveBudget: 100 }), []);

		assert.strictEqual(item.visible, true);
		assert.strictEqual(item.views.at(-1)?.text, "42%");
	});

	test("applyConfiguration re-reads the settings seams", () => {
		const { store, item, setMode, bar } = harness();
		store.upsert(usageState("alpha", { spend: 42, effectiveBudget: 100 }), []);
		assert.strictEqual(item.visible, true);

		setMode("off");
		bar.applyConfiguration();

		assert.strictEqual(item.visible, false);
	});

	test("a threshold edit changes the severity without a store event", () => {
		const { store, item, setThresholds, bar } = harness();
		store.upsert(usageState("alpha", { spend: 42, effectiveBudget: 100 }), []);
		assert.strictEqual(item.views.at(-1)?.severity, "plain");

		setThresholds([0.4]);
		bar.applyConfiguration();

		assert.strictEqual(item.views.at(-1)?.severity, "error", "a single-threshold list is the alarm");
	});

	test("schedules a re-render at the moment the fresh data would go stale, and hides then", () => {
		const { store, item, clock, timers } = harness();
		const lastUpdatedAt = NOW - 60_000;
		store.upsert(usageState("alpha", { spend: 42, effectiveBudget: 100, lastUpdatedAt }), []);

		const pending = timers.filter((timer) => !timer.cancelled);
		assert.strictEqual(pending.length, 1, "one stale-edge timer per render with fresh data");
		const expected = lastUpdatedAt + usageFreshnessWindowMs(POLL_INTERVAL_MS, POLLING_OFF_WINDOW_MS) - NOW;
		assert.strictEqual(pending[0]?.ms, expected);

		clock.nowMs = lastUpdatedAt + usageFreshnessWindowMs(POLL_INTERVAL_MS, POLLING_OFF_WINDOW_MS);
		pending[0]?.callback();

		assert.strictEqual(item.visible, false, "the item hides on time instead of waiting for the next poll");
	});

	test("dispose cancels the stale-edge timer, unsubscribes, and disposes the item", () => {
		const { store, item, timers, bar } = harness();
		store.upsert(usageState("alpha", { spend: 42, effectiveBudget: 100 }), []);

		bar.dispose();

		assert.ok(
			timers.every((timer) => timer.cancelled),
			"no timer may fire after disposal"
		);
		assert.strictEqual(item.disposed, true);
		const renders = item.views.length;
		store.upsert(usageState("alpha", { spend: 99, effectiveBudget: 100 }), []);
		assert.strictEqual(item.views.length, renders, "a disposed bar must stop listening");
	});
});
