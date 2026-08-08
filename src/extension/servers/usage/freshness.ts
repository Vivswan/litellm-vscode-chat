/**
 * The usage freshness rule (docs/usage.md#polling), pure so the status bar's
 * aggregation and its tests share one definition: a server's data is fresh
 * while the last fetch succeeded and is less than two poll intervals old;
 * with polling off, on-demand data counts as fresh for ten minutes (twice the
 * default interval). Stale servers keep rendering in the usage panel with
 * their age, but the status bar drops them from its aggregation rather than
 * present an old number as current.
 */

import type { ServerUsageState } from "./store";

/** The freshness window while polling is off (interval 0): twice the default 5-minute interval. */
export const POLLING_OFF_FRESHNESS_WINDOW_MS = 600_000;

/** How long a successful fetch stays fresh under the given poll cadence. */
export function usageFreshnessWindowMs(pollIntervalMs: number): number {
	return pollIntervalMs > 0 ? pollIntervalMs * 2 : POLLING_OFF_FRESHNESS_WINDOW_MS;
}

/**
 * Whether a server's usage data is fresh at `nowMs`. "The last fetch
 * succeeded" means the server currently holds key data (/key/info standing
 * "ok" - the budget and spend numbers the aggregation reads) with a
 * spendUpdatedAt strictly inside the window: data exactly two intervals old is
 * already stale.
 */
export function isUsageFresh(state: ServerUsageState, nowMs: number, pollIntervalMs: number): boolean {
	if (state.endpoints.keyInfo.kind !== "ok" || state.key === undefined || state.spendUpdatedAt === undefined) {
		return false;
	}
	return nowMs - state.spendUpdatedAt < usageFreshnessWindowMs(pollIntervalMs);
}
