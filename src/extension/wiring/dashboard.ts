import * as vscode from "vscode";
import type { LiteLLMChatModelProvider } from "../../provider";
import { INTERNAL_CMD } from "../../shared/config/commandIds";
import type { NumberSettingId } from "../../shared/config/settingSpec";
import { CONFIG_SECTION } from "../../shared/config/settingSpec";
import {
	CURRENCY_SYMBOL_SETTING_KEY,
	getCurrencySymbol,
	getUsageAlertThresholds,
	getUsagePollIntervalMs,
	getUsagePollingOffFreshnessWindowMs,
	getUsageStatusBarMode,
	USAGE_ALERT_THRESHOLDS_SETTING_KEY,
	USAGE_STATUS_BAR_SETTING_KEY,
} from "../../shared/config/settings";
import type { Logger } from "../../shared/logger";
import type { DashboardController } from "../dashboard/panel";
import { registerDashboardCommand } from "../dashboard/panel";
import type { OpenRouterCatalogStore } from "../openRouterCatalog";
import type { GroupRemovalStore } from "../servers/groupRemovals";
import type { ServerRegistry } from "../servers/serverRegistry";
import type { ServerSyncEngine } from "../servers/serverSync";
import { readEntryModelCapabilities } from "../servers/serverSync";
import type { UsagePoller } from "../servers/usage";
import { StatusItem } from "../ui/status";
import { UsageAlerts } from "../ui/usageAlerts";
import { UsageStatusBar } from "../ui/usageStatusItem";

const USAGE_POLL_INTERVAL_SETTING_ID = "usage.pollInterval" satisfies NumberSettingId;

const USAGE_POLLING_OFF_WINDOW_SETTING_ID = "usage.pollingOffFreshnessWindow" satisfies NumberSettingId;

/**
 * The dashboard panel controller and its commands. Also registers
 * litellm.showDiagnostics: the command deep-links to the dashboard's
 * Diagnostics tab, and the dashboard states the legacy registry's leftovers,
 * which is why it takes the registry.
 */
export function wireDashboard(
	context: vscode.ExtensionContext,
	logger: Logger,
	deps: {
		provider: LiteLLMChatModelProvider;
		syncEngine: ServerSyncEngine;
		registry: ServerRegistry;
		groupRemovals: GroupRemovalStore;
		catalogStore: OpenRouterCatalogStore;
		usagePoller: UsagePoller;
	}
): DashboardController {
	const dashboard = registerDashboardCommand(
		context,
		deps.provider,
		logger,
		deps.syncEngine,
		deps.registry,
		deps.groupRemovals,
		deps.catalogStore,
		deps.usagePoller,
		readEntryModelCapabilities
	);
	context.subscriptions.push(deps.syncEngine.onDidSync(() => dashboard.refresh()));
	return dashboard;
}

/**
 * The usage surfaces over the poller's store: the status bar item beside
 * the connection item, the budget alert toasts, and the deep link both
 * click through to the dashboard's Servers section, where each row carries
 * its spend. Wired after the dashboard because the click target needs it.
 * The item's configuration reaction lives here with the item (the engines'
 * reactions stay in wireServers).
 */
export function wireUsageSurfaces(
	context: vscode.ExtensionContext,
	logger: Logger,
	deps: {
		usagePoller: Pick<UsagePoller, "store" | "onDidRefresh">;
		dashboard: Pick<DashboardController, "open" | "refresh">;
	}
): void {
	const { usagePoller, dashboard } = deps;
	const usageStatusBar = new UsageStatusBar({
		store: usagePoller.store,
		item: new StatusItem({
			slot: "usage",
			alignment: vscode.StatusBarAlignment.Right,
			priority: 99,
			command: INTERNAL_CMD.openUsage,
			log: (message) => logger.log(message),
		}),
		getMode: getUsageStatusBarMode,
		getThresholds: () => getUsageAlertThresholds(),
		getPollIntervalMs: () => getUsagePollIntervalMs(),
		getPollingOffWindowMs: () => getUsagePollingOffFreshnessWindowMs(),
		getCurrencySymbol,
	});
	context.subscriptions.push(
		usageStatusBar,
		new UsageAlerts(usagePoller.store),
		vscode.commands.registerCommand(INTERNAL_CMD.openUsage, () => dashboard.open("overview")),
		// The coarse "pass done" push: the dashboard's usage section re-renders
		// after every completed poll pass (the poller isolates its listeners).
		usagePoller.onDidRefresh(() => dashboard.refresh()),
		vscode.workspace.onDidChangeConfiguration((event) => {
			const affects = (id: string) => event.affectsConfiguration(`${CONFIG_SECTION}.${id}`);
			if (
				affects(USAGE_POLL_INTERVAL_SETTING_ID) ||
				affects(USAGE_POLLING_OFF_WINDOW_SETTING_ID) ||
				affects(USAGE_ALERT_THRESHOLDS_SETTING_KEY) ||
				affects(USAGE_STATUS_BAR_SETTING_KEY) ||
				affects(CURRENCY_SYMBOL_SETTING_KEY)
			) {
				// The item re-reads mode, thresholds, the currency symbol, and the
				// freshness window at render time; a re-render is the whole reaction.
				usageStatusBar.applyConfiguration();
			}
		})
	);
}

/**
 * A tombstone change must reach the picker and the dashboard at once: the
 * model-change event makes the host re-resolve every group (a hidden group
 * then answers empty; an unhidden one serves again), and the refresh
 * re-renders the hidden-groups line.
 */
export function wireGroupRemovalReactions(
	logger: Logger,
	deps: {
		groupRemovals: GroupRemovalStore;
		provider: LiteLLMChatModelProvider;
		dashboard: Pick<DashboardController, "refresh">;
	}
): void {
	const { groupRemovals, provider, dashboard } = deps;
	groupRemovals.onDidChange = () => {
		// Isolated like the status callback's consumers (see wireStatusFanout):
		// one consumer throwing must not starve the other, and a throw escaping
		// into the store would make its callers report a mutation that DID
		// apply as failed.
		try {
			provider.notifyModelInformationChanged();
		} catch (error) {
			logger.error("Group-removal change notification failed", error);
		}
		try {
			dashboard.refresh();
		} catch (error) {
			logger.error("Dashboard refresh failed", error);
		}
	};
	// The store's persists are best-effort (the in-memory view is the truth
	// and the next mutation rewrites the whole blob); failures are log-only.
	groupRemovals.onPersistError = (error) => {
		logger.error("Persisting group-removal bookkeeping failed", error);
	};
}
