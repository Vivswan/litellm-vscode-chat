/**
 * The usage freshness rule (docs/usage.md#polling), pure so the status bar's
 * aggregation and its tests share one definition: a server's data is fresh
 * while the last fetch succeeded and is less than two poll intervals old; with
 * polling off, on-demand data counts as fresh for the configured
 * usage.pollingOffFreshnessWindow. Stale servers keep rendering in the usage
 * panel with their age, but the status bar drops them from its aggregation
 * rather than present an old number as current.
 */

import type { ServerUsageState } from "./store";

/**
 * How long a successful fetch stays fresh under the given poll cadence.
 * `pollingOffWindowMs` is the usage.pollingOffFreshnessWindow setting, read
 * by the caller: the window that applies while polling is off (interval 0).
 */
export function usageFreshnessWindowMs(pollIntervalMs: number, pollingOffWindowMs: number): number {
	return pollIntervalMs > 0 ? pollIntervalMs * 2 : pollingOffWindowMs;
}

/**
 * Whether a server's usage data is fresh at `nowMs`. "The last fetch succeeded"
 * means the server currently holds key data (/key/info standing "ok") with a
 * spendUpdatedAt strictly inside the window: data exactly two intervals old is
 * already stale. A non-positive window means nothing is ever fresh - stated
 * explicitly, because a clock that jumped backwards yields a negative age that
 * would otherwise slip under a zero window.
 */
export function isUsageFresh(
	state: ServerUsageState,
	nowMs: number,
	pollIntervalMs: number,
	pollingOffWindowMs: number
): boolean {
	if (state.endpoints.keyInfo.kind !== "ok" || state.key === undefined || state.spendUpdatedAt === undefined) {
		return false;
	}
	const windowMs = usageFreshnessWindowMs(pollIntervalMs, pollingOffWindowMs);
	return windowMs > 0 && nowMs - state.spendUpdatedAt < windowMs;
}
