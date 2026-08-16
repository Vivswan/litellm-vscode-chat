/**
 * The Servers page's usage projection: the poller's ServerUsageState reduced
 * to the serializable DashboardUsage the state push carries. Pure; the
 * freshness predicate is injected so this module and the status bar item
 * share one rule without importing each other.
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
	/** UsagePoller.isRefreshing. */
	readonly refreshing: boolean;
	/** UsagePoller.isRefreshingExplicitly. */
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
 * enums and status number, restated so the webview type stays self-contained.
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
 * Whether a standing blocks usage in a way the USER can fix: a key the server
 * refuses (401/403). Unsupported endpoints are deliberately not "blocked" - no
 * key change unhides them.
 */
function forbiddenStanding(state: UsageEndpointState): boolean {
	return state.kind === "unavailable" && state.reason === "forbidden";
}

/**
 * One store state as the Servers page's usage card, or undefined for servers
 * that do not surface. Full card while availability stands "available", a
 * reduced card when a forbidden standing blocks it. Unsupported-only and
 * still-probing servers stay hidden: hidden states are only ones the user
 * cannot act on (docs/usage.md#requirements).
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

/** The reduced card for a server a forbidden standing leaves without usage: identity plus endpoint standings. */
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
