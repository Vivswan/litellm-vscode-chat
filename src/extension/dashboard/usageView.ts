/**
 * The Usage tab's state projection: ServerUsageState (the poller's store,
 * already narrowed to numbers and user-configured identity) reduced to the
 * serializable DashboardUsage the state push carries. Pure; the freshness
 * predicate is injected so this module and the status bar item share one
 * rule without importing each other.
 */

import type { ServerUsageState } from "../servers/usage";
import type { DashboardUsage, UsageServerView } from "./protocol";

export interface UsageViewInput {
	readonly states: readonly ServerUsageState[];
	/** The normalized alert thresholds, as getUsageAlertThresholds returns them. */
	readonly thresholds: readonly number[];
	readonly pollIntervalMs: number;
	/** Whether a refresh pass is in flight (UsagePoller.isRefreshing). */
	readonly refreshing: boolean;
	readonly now: number;
	/** The shared freshness rule (extension/servers/usage/freshness.ts). */
	readonly isFresh: (state: ServerUsageState, nowMs: number, pollIntervalMs: number) => boolean;
}

/**
 * One store state as the Usage tab's card, or undefined for servers that do
 * not surface: a server is shown once its usage availability is proven
 * ("available" - at least one endpoint answered at some point), and hidden
 * silently while unknown or permanently unavailable (DB-less proxies never
 * appear; see docs/usage.md#requirements).
 */
function usageServerView(state: ServerUsageState, input: UsageViewInput): UsageServerView | undefined {
	if (state.availability !== "available") {
		return undefined;
	}
	const totals = state.daily?.totals;
	const requests =
		totals !== undefined
			? {
					total: totals.apiRequests,
					...(totals.apiRequests > 0 ? { successRate: totals.successfulRequests / totals.apiRequests } : {}),
					...(totals.promptTokens > 0 ? { cacheHitRate: totals.cacheReadInputTokens / totals.promptTokens } : {}),
				}
			: undefined;
	const budget = state.budget;
	return {
		label: state.label,
		baseUrl: state.baseUrl,
		fresh: input.isFresh(state, input.now, input.pollIntervalMs),
		...(state.spendUpdatedAt !== undefined ? { lastUpdatedAt: state.spendUpdatedAt } : {}),
		...(budget.spend !== undefined ? { spend: budget.spend } : {}),
		...(budget.effectiveBudget !== undefined ? { effectiveBudget: budget.effectiveBudget } : {}),
		...(budget.keyBudget !== undefined ? { keyBudget: budget.keyBudget } : {}),
		...(budget.entryBudget !== undefined ? { entryBudget: budget.entryBudget } : {}),
		budgetSource: budget.budgetSource,
		...(budget.spentFraction !== undefined ? { spentFraction: budget.spentFraction } : {}),
		...(budget.budgetResetAt !== undefined ? { budgetResetAt: budget.budgetResetAt } : {}),
		...(requests !== undefined ? { requests } : {}),
	};
}

export function buildUsageView(input: UsageViewInput): DashboardUsage {
	return {
		servers: input.states.flatMap((state) => {
			const view = usageServerView(state, input);
			return view === undefined ? [] : [view];
		}),
		thresholds: input.thresholds,
		pollIntervalMs: input.pollIntervalMs,
		refreshing: input.refreshing,
		generatedAt: input.now,
	};
}
