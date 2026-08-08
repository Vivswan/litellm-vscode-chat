/**
 * The usage data layer for budget alerts and the usage panel (#232): the
 * spend client fetches a LiteLLM server's own-key budget (/key/info), daily
 * activity (/user/daily/activity), and user rollup (/user/info); budget.ts
 * resolves the effective budget (entry `budget` over key-reported max_budget)
 * and the threshold-crossing state; the store is the typed, subscribable
 * surface the dashboard, status bar, and notifier consume; and the poller
 * keeps it fresh headlessly on the usage.pollInterval cadence (0 = off),
 * with graceful degradation for servers whose proxy cannot serve the endpoints
 * (DB-less: 400/404; unauthorized keys: 401/403). vscodeEnv.ts is the vscode
 * wiring. This index is the import surface.
 */

export type { BudgetStatus, ResolveBudgetInput } from "./budget";
export { crossedThresholds, newlyCrossedThresholds, resolveBudget } from "./budget";
export type { UsageClock, UsageFetchClient, UsagePollerEnv, UsageTimer } from "./poller";
export { USAGE_ACTIVITY_WINDOW_DAYS, UsagePoller } from "./poller";
export type {
	ActivityWindow,
	DailyUsage,
	KeyUsage,
	UsageClientOptions,
	UsageConnection,
	UsageDay,
	UsageTotals,
	UserUsage,
} from "./spendClient";
export {
	activityWindow,
	dailyActivityUrl,
	keyInfoUrl,
	UsageClient,
	usageConnectionFor,
	usageUnavailabilityOf,
	userInfoUrl,
} from "./spendClient";
export type { ServerUsageState, UsageAvailability, UsageChangeEvent } from "./store";
export { createUsagePollerEnv, registerRefreshUsageCommand } from "./vscodeEnv";
