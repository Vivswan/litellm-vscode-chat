import * as assert from "node:assert";
import type { UsageViewInput } from "../../../extension/dashboard/usageView";
import { buildUsageView } from "../../../extension/dashboard/usageView";
import type { BudgetStatus, ServerUsageState, UsageTotals } from "../../../extension/servers/usage";

const NO_BUDGET: BudgetStatus = {
	entryBudget: undefined,
	keyBudget: undefined,
	effectiveBudget: undefined,
	budgetSource: "none",
	spend: undefined,
	spentFraction: undefined,
	budgetResetAt: undefined,
	crossedThresholds: [],
};

function makeTotals(overrides: Partial<UsageTotals> = {}): UsageTotals {
	return {
		spend: 0,
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		apiRequests: 0,
		successfulRequests: 0,
		failedRequests: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		...overrides,
	};
}

function makeUsageState(overrides: Partial<ServerUsageState> = {}): ServerUsageState {
	return {
		label: "Prod",
		baseUrl: "http://prod.test",
		endpoints: {
			keyInfo: { kind: "ok" },
			dailyActivity: { kind: "unknown" },
			userInfo: { kind: "unknown" },
		},
		availability: "available",
		lastUpdatedAt: undefined,
		spendUpdatedAt: undefined,
		lastAttemptAt: undefined,
		key: undefined,
		daily: undefined,
		user: undefined,
		budget: NO_BUDGET,
		...overrides,
		// The view reads the SPEND age; tests that set lastUpdatedAt mean it.
		...("spendUpdatedAt" in overrides ? {} : { spendUpdatedAt: overrides.lastUpdatedAt }),
	};
}

function makeInput(overrides: Partial<UsageViewInput> = {}): UsageViewInput {
	return {
		states: [],
		thresholds: [0.8, 0.95],
		pollIntervalMs: 300000,
		refreshing: false,
		now: 1_754_000_000_000,
		isFresh: () => true,
		...overrides,
	};
}

suite("extension/dashboard/usageView", () => {
	test("only availability-proven servers surface; unknown and unavailable stay hidden silently", () => {
		const view = buildUsageView(
			makeInput({
				states: [
					makeUsageState({ label: "Shown", availability: "available" }),
					makeUsageState({ label: "Probing", availability: "unknown" }),
					makeUsageState({ label: "DB-less", availability: "unavailable" }),
				],
			})
		);

		assert.deepStrictEqual(
			view.servers.map((server) => server.label),
			["Shown"]
		);
	});

	test("the envelope passes thresholds, poll interval, refreshing, and the generation instant through", () => {
		const view = buildUsageView(makeInput({ thresholds: [0.5], pollIntervalMs: 0, refreshing: true }));

		assert.deepStrictEqual(view.thresholds, [0.5]);
		assert.strictEqual(view.pollIntervalMs, 0);
		assert.strictEqual(view.refreshing, true);
		assert.strictEqual(view.generatedAt, 1_754_000_000_000);
		assert.deepStrictEqual(view.servers, []);
	});

	test("a card projects identity, budget numbers, and reset instant; unset facts stay absent, not undefined-keyed", () => {
		const budget: BudgetStatus = {
			entryBudget: 50,
			keyBudget: 100,
			effectiveBudget: 50,
			budgetSource: "entry",
			spend: 45,
			spentFraction: 0.9,
			budgetResetAt: 1_700_000_000_000,
			crossedThresholds: [0.8],
		};
		const view = buildUsageView(
			makeInput({
				states: [makeUsageState({ lastUpdatedAt: 1_753_999_999_000, budget })],
			})
		);

		const card = view.servers[0];
		assert.ok(card !== undefined);
		assert.strictEqual(card.label, "Prod");
		assert.strictEqual(card.baseUrl, "http://prod.test");
		assert.strictEqual(card.lastUpdatedAt, 1_753_999_999_000);
		assert.strictEqual(card.spend, 45);
		assert.strictEqual(card.effectiveBudget, 50);
		assert.strictEqual(card.keyBudget, 100);
		assert.strictEqual(card.entryBudget, 50);
		assert.strictEqual(card.budgetSource, "entry");
		assert.strictEqual(card.spentFraction, 0.9);
		assert.strictEqual(card.budgetResetAt, 1_700_000_000_000);

		const bare = buildUsageView(makeInput({ states: [makeUsageState()] })).servers[0];
		assert.ok(bare !== undefined);
		assert.strictEqual(bare.budgetSource, "none");
		for (const key of ["lastUpdatedAt", "spend", "effectiveBudget", "keyBudget", "entryBudget", "spentFraction"]) {
			assert.ok(!(key in bare), `${key} must be absent, not an explicit undefined`);
		}
	});

	test("request rates derive from the daily totals, each ratio only when its denominator exists", () => {
		const withRates = buildUsageView(
			makeInput({
				states: [
					makeUsageState({
						daily: {
							days: [],
							totals: makeTotals({
								apiRequests: 200,
								successfulRequests: 150,
								promptTokens: 1000,
								cacheReadInputTokens: 250,
							}),
						},
					}),
				],
			})
		).servers[0];
		assert.deepStrictEqual(withRates?.requests, { total: 200, successRate: 0.75, cacheHitRate: 0.25 });

		const zeroDenominators = buildUsageView(
			makeInput({
				states: [makeUsageState({ daily: { days: [], totals: makeTotals() } })],
			})
		).servers[0];
		assert.deepStrictEqual(zeroDenominators?.requests, { total: 0 }, "zero requests and tokens yield no ratios");

		const noDaily = buildUsageView(makeInput({ states: [makeUsageState()] })).servers[0];
		assert.ok(noDaily !== undefined && !("requests" in noDaily), "no daily answer means no requests block at all");
	});

	test("freshness comes from the injected rule, called with the card's state and the input's clock", () => {
		const calls: [string, number, number][] = [];
		const view = buildUsageView(
			makeInput({
				states: [makeUsageState({ label: "A" }), makeUsageState({ label: "B" })],
				pollIntervalMs: 60000,
				isFresh: (state, nowMs, pollIntervalMs) => {
					calls.push([state.label, nowMs, pollIntervalMs]);
					return state.label === "A";
				},
			})
		);

		assert.deepStrictEqual(
			view.servers.map((server) => [server.label, server.fresh]),
			[
				["A", true],
				["B", false],
			]
		);
		assert.deepStrictEqual(calls, [
			["A", 1_754_000_000_000, 60000],
			["B", 1_754_000_000_000, 60000],
		]);
	});
});
