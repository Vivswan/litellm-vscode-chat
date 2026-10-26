/**
 * Pure; the freshness predicate is injected so this module and the status bar item share one rule without importing
 * each other.
 */

import type {
	DashboardUsage,
	UsageEndpointStandingView,
	UsageForbiddenServerView,
	UsageServerCardView,
	UsageServerView,
} from "../../dashboard/viewModels";
import type { ServerUsageState, UsageEndpointState } from "../servers/usage/store";

/** The budget half of a usage card: the source always, the figures only where the store holds them. */
type BudgetFields = Pick<UsageServerView, "budgetSource"> &
	Partial<
		Pick<UsageServerView, "spend" | "effectiveBudget" | "keyBudget" | "entryBudget" | "spentFraction" | "budgetResetAt">
	>;

export interface UsageViewInput {
	/** One usage state per tracked server, label-sorted as UsageStore.getStates lists them. */
	readonly states: readonly ServerUsageState[];

	/** The normalized alert thresholds, as getUsageAlertThresholds returns them. */
	readonly thresholds: readonly number[];

	/** The usage.pollInterval setting: the freshness window while polling is on. */
	readonly pollIntervalMs: number;

	/** The usage.pollingOffFreshnessWindow setting: the freshness window while polling is off. */
	readonly pollingOffWindowMs: number;

	/** The effective discovery.timeout; the card's timeout detail line prints it. */
	readonly discoveryTimeoutMs: number;

	/** UsagePoller.isRefreshing. */
	readonly refreshing: boolean;

	/** UsagePoller.isRefreshingExplicitly. */
	readonly refreshingExplicitly: boolean;

	/** The render time: what the freshness rule judges against, and the view's generatedAt stamp. */
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
 * The store's endpoint standing as the protocol carries it: the same closed enums and status number, restated so the
 * webview type stays self-contained.
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
				...(state.status === undefined ? {} : { status: state.status }),
			};
		case "error":
			return {
				kind: "error",
				...(state.classification === undefined ? {} : { classification: state.classification }),
				...(state.status === undefined ? {} : { status: state.status }),
			};
	}
}

/**
 * Whether a standing blocks usage in a way the USER can fix: a key the server refuses (401/403). Unsupported endpoints
 * are deliberately not "blocked" - no key change unhides them.
 */
function forbiddenStanding(state: UsageEndpointState): boolean {
	return state.kind === "unavailable" && state.reason === "forbidden";
}

/** The request totals a card states, with each rate only where its denominator is positive. */
function requestsView(totals: NonNullable<ServerUsageState["daily"]>["totals"]): UsageServerView["requests"] {
	return {
		total: totals.apiRequests,
		...(totals.apiRequests > 0 ? { successRate: totals.successfulRequests / totals.apiRequests } : {}),
		...(totals.promptTokens > 0 ? { cacheHitRate: totals.cacheReadInputTokens / totals.promptTokens } : {}),
	};
}

/** The budget facts a card states; each optional one appears only when the store holds it. */
function budgetFields(budget: ServerUsageState["budget"]): BudgetFields {
	return {
		...(budget.spend === undefined ? {} : { spend: budget.spend }),
		...(budget.effectiveBudget === undefined ? {} : { effectiveBudget: budget.effectiveBudget }),
		...(budget.keyBudget === undefined ? {} : { keyBudget: budget.keyBudget }),
		...(budget.entryBudget === undefined ? {} : { entryBudget: budget.entryBudget }),
		budgetSource: budget.budgetSource,
		...(budget.spentFraction === undefined ? {} : { spentFraction: budget.spentFraction }),
		...(budget.budgetResetAt === undefined ? {} : { budgetResetAt: budget.budgetResetAt }),
	};
}

function usageServerView(state: ServerUsageState, input: UsageViewInput): UsageServerCardView | undefined {
	if (state.availability !== "available") {
		return forbiddenStanding(state.endpoints.keyInfo) || forbiddenStanding(state.endpoints.dailyActivity)
			? forbiddenServerView(state)
			: undefined;
	}
	const totals = state.daily?.totals;
	const view: UsageServerView = {
		kind: "usage",
		label: state.label,
		baseUrl: state.baseUrl,
		fresh: input.isFresh(state, input.now, input.pollIntervalMs, input.pollingOffWindowMs),
		keyInfo: endpointStandingView(state.endpoints.keyInfo),
		dailyActivity: endpointStandingView(state.endpoints.dailyActivity),
		...(state.spendUpdatedAt === undefined ? {} : { lastUpdatedAt: state.spendUpdatedAt }),
		...budgetFields(state.budget),
		...(totals === undefined ? {} : { requests: requestsView(totals) }),
	};
	return view;
}

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
