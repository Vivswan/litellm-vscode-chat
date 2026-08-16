/**
 * The Servers page's usage projection: ServerUsageState (the poller's store,
 * already narrowed to numbers and user-configured identity) reduced to the
 * serializable DashboardUsage the state push carries. Pure; the freshness
 * predicate is injected so this module and the status bar item share one
 * rule without importing each other.
 */

import type {
	DashboardUsage,
	UsageEndpointStandingView,
	UsageForbiddenServerView,
	UsageServerCardView,
	UsageServerView,
} from "../../dashboard/viewModels";
import type { ServerUsageState, UsageEndpointState } from "../servers/usage";

export interface UsageViewInput {
	readonly states: readonly ServerUsageState[];
	/** The normalized alert thresholds, as getUsageAlertThresholds returns them. */
	readonly thresholds: readonly number[];
	readonly pollIntervalMs: number;
	/** The usage.pollingOffFreshnessWindow setting: the freshness window while polling is off. */
	readonly pollingOffWindowMs: number;
	/** The effective discovery.timeout; the card's timeout detail line prints it. */
	readonly discoveryTimeoutMs: number;
	/** Whether a refresh pass is in flight (UsagePoller.isRefreshing). */
	readonly refreshing: boolean;
	/** Whether that pass was explicitly requested (UsagePoller.isRefreshingExplicitly). */
	readonly refreshingExplicitly: boolean;
	readonly now: number;
	/** The shared freshness rule (extension/servers/usage/freshness.ts). */
	readonly isFresh: (
		state: ServerUsageState,
		nowMs: number,
		pollIntervalMs: number,
		pollingOffWindowMs: number
	) => boolean;
}

/**
 * The store's endpoint standing as the protocol carries it: the same closed
 * enums and status number, restated so the webview type stays self-contained
 * (nothing here is response-derived; the spend client guarantees that).
 */
function endpointStandingView(state: UsageEndpointState): UsageEndpointStandingView {
	switch (state.kind) {
		case "unknown":
		case "ok":
			return { kind: state.kind };
		case "unavailable":
			return {
				kind: "unavailable",
				reason: state.reason,
				...(state.status !== undefined ? { status: state.status } : {}),
			};
		case "error":
			return {
				kind: "error",
				...(state.classification !== undefined ? { classification: state.classification } : {}),
				...(state.status !== undefined ? { status: state.status } : {}),
			};
	}
}

/**
 * Whether a usage endpoint's standing blocks usage in a way the USER can fix:
 * a key the server refuses (401/403). Unsupported endpoints (a DB-less proxy)
 * are deliberately not "blocked" - there is no key change that unhides them.
 */
function forbiddenStanding(state: UsageEndpointState): boolean {
	return state.kind === "unavailable" && state.reason === "forbidden";
}

/**
 * One store state as the Servers page's usage card, or undefined for servers
 * that do not surface. A server is shown in full while its usage availability
 * stands "available" (at least one endpoint answered and no permanent verdict
 * replaced it). A server without that - never probed successfully, or
 * downgraded when both endpoints went permanently unavailable - still gets a
 * reduced card when a forbidden standing is what blocks it: the user can act
 * on that (fix the key's permissions, Refresh now), and the poller already
 * dropped any retained numbers with the unavailable verdict. Unsupported-only
 * and still-probing servers stay hidden silently (DB-less proxies never
 * appear; see docs/usage.md#requirements). The rule: hidden states are only
 * ones the user cannot act on.
 */
function usageServerView(state: ServerUsageState, input: UsageViewInput): UsageServerCardView | undefined {
	if (state.availability !== "available") {
		return forbiddenStanding(state.endpoints.keyInfo) || forbiddenStanding(state.endpoints.dailyActivity)
			? forbiddenServerView(state)
			: undefined;
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
	const view: UsageServerView = {
		kind: "usage",
		label: state.label,
		baseUrl: state.baseUrl,
		fresh: input.isFresh(state, input.now, input.pollIntervalMs, input.pollingOffWindowMs),
		keyInfo: endpointStandingView(state.endpoints.keyInfo),
		dailyActivity: endpointStandingView(state.endpoints.dailyActivity),
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
	return view;
}

/**
 * The reduced card for a server a forbidden standing leaves without readable
 * usage: identity plus the endpoint standings the detail lines print - no
 * spend, budget, or request numbers exist to carry.
 */
function forbiddenServerView(state: ServerUsageState): UsageForbiddenServerView {
	return {
		kind: "forbidden",
		label: state.label,
		baseUrl: state.baseUrl,
		keyInfo: endpointStandingView(state.endpoints.keyInfo),
		dailyActivity: endpointStandingView(state.endpoints.dailyActivity),
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
		discoveryTimeoutMs: input.discoveryTimeoutMs,
		refreshing: input.refreshing,
		refreshingExplicitly: input.refreshingExplicitly,
		generatedAt: input.now,
	};
}
