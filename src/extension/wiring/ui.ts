import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import type { LiteLLMChatModelProvider } from "../../provider";
import { CMD } from "../../shared/config/commandIds";
import { HAS_SHOWN_WELCOME_KEY } from "../../shared/config/storageKeys";
import type { Logger } from "../../shared/logger";
import type { AggregatedStatus } from "../../shared/servers";
import { GITHUB_DOCS_URL } from "../../shared/util/links";
import type { DashboardController } from "../dashboard/panel";
import { registerManageCommand } from "../servers/serverManagement";
import type { ServerRegistry } from "../servers/serverRegistry";
import type { DeclaredServerView, ServerSyncEngine } from "../servers/serverSync";
import {
	registerHelpAndFeedbackCommand,
	registerOpenGroupsFileCommand,
	registerReportIssueCommand,
	registerSyncModelsCommand,
	registerTestConnectionCommand,
} from "../ui/commands";
import type { IssueReporter } from "../ui/issueReporter";
import { configureNowLabel, Notifier, reconfigureAction, showActionableMessage } from "../ui/notifier";
import { registerOpenSettingKeyCommand } from "../ui/openSettingKey";
import { StatusBarManager, StatusItem } from "../ui/status";

/**
 * The connection status bar item (through the slot registry's StatusItem) and
 * the refresh notifier; both consume the same aggregated status through
 * wireStatusFanout.
 */
export function wireStatusSurfaces(
	context: vscode.ExtensionContext,
	logger: Logger,
	hasConfiguredServers: () => boolean,
	/** The sync engine's declared views, for both surfaces' sync-failure overlay. */
	getDeclared: () => readonly DeclaredServerView[]
): { statusBar: StatusBarManager; notifier: Notifier } {
	const statusBar = new StatusBarManager(
		context,
		logger,
		hasConfiguredServers,
		getDeclared,
		new StatusItem({
			slot: "connection",
			alignment: vscode.StatusBarAlignment.Right,
			priority: 100,
			command: CMD.openDashboard,
			log: (message) => logger.log(message),
		})
	);
	const notifier = new Notifier(hasConfiguredServers, getDeclared);
	// Disposal withdraws an armed no-servers claim, so its deferred toast
	// cannot fire from a deactivated extension.
	context.subscriptions.push(notifier);
	return { statusBar, notifier };
}

/**
 * Status bar, refresh notifications, and the dashboard share one status
 * callback, isolated so one consumer's failure cannot starve the others; sync
 * passes re-judge the two overlay consumers, since a sync-only change (a
 * failed upsert, a blocked entry clearing) never fires the status callback.
 */
export function wireStatusFanout(
	context: vscode.ExtensionContext,
	logger: Logger,
	deps: {
		provider: Pick<LiteLLMChatModelProvider, "setStatusCallback">;
		syncEngine: Pick<ServerSyncEngine, "onDidSync">;
		statusBar: StatusBarManager;
		notifier: Notifier;
		dashboard: Pick<DashboardController, "refresh">;
	}
): void {
	const { provider, syncEngine, statusBar, notifier, dashboard } = deps;
	provider.setStatusCallback((aggStatus: AggregatedStatus) => {
		try {
			statusBar.handleAggregatedStatus(aggStatus);
		} catch (error) {
			logger.error("Status bar update failed", error);
		}
		try {
			notifier.handleAggregatedStatus(aggStatus);
		} catch (error) {
			logger.error("Notifier update failed", error);
		}
		try {
			dashboard.refresh();
		} catch (error) {
			logger.error("Dashboard refresh failed", error);
		}
	});
	// The dashboard already re-renders per pass (wireDashboard's own onDidSync
	// subscription); these two read the sync outcome only through the overlay.
	context.subscriptions.push(
		syncEngine.onDidSync(() => {
			try {
				statusBar.refreshFromSync();
			} catch (error) {
				logger.error("Status bar sync refresh failed", error);
			}
			try {
				notifier.refreshFromSync();
			} catch (error) {
				logger.error("Notifier sync refresh failed", error);
			}
		})
	);
}

/**
 * The one-time welcome message. Gated on the legacy registry and the declared
 * servers setting only: this runs during activation, before the host has handed
 * over any provider group, so the group latch cannot contribute yet.
 */
export async function maybeShowWelcome(
	context: vscode.ExtensionContext,
	logger: Logger,
	deps: {
		registry: ServerRegistry;
		hasDeclaredServers: () => boolean;
	}
): Promise<void> {
	const hasShownWelcome = context.globalState.get<boolean>(HAS_SHOWN_WELCOME_KEY, false);
	if (!hasShownWelcome && deps.registry.getServers().length === 0 && !deps.hasDeclaredServers()) {
		showActionableMessage("info", l10n.t("Welcome to LiteLLM! Connect to 100+ LLMs in VS Code."), [
			reconfigureAction(configureNowLabel()),
			{
				label: l10n.t("Documentation"),
				run: () => void vscode.env.openExternal(vscode.Uri.parse(GITHUB_DOCS_URL)),
			},
		]).catch((error) => {
			logger.error("Welcome message failed", error);
		});
	}
	if (!hasShownWelcome) {
		await context.globalState.update(HAS_SHOWN_WELCOME_KEY, true);
	}
}

/**
 * The command-palette surfaces: server management, connection testing,
 * model sync, help, the groups-file and settings.json deep links, and the
 * issue reporter.
 */
export function wireUiCommands(
	context: vscode.ExtensionContext,
	logger: Logger,
	deps: {
		registry: ServerRegistry;
		provider: LiteLLMChatModelProvider;
		statusBar: StatusBarManager;
		outputChannel: vscode.OutputChannel;
		syncEngine: ServerSyncEngine;
		issueReporter: IssueReporter;
		extVersion: string;
		vscodeVersion: string;
	}
): void {
	// The hub's server entry opens the dashboard's Servers view.
	registerManageCommand(context);

	registerTestConnectionCommand(context, deps.provider, deps.statusBar, deps.outputChannel, logger);

	// Sync Models Now: a forced server sync first (reconciling groups edited
	// natively), then a discovery-cache-skipping refetch of every group.
	registerSyncModelsCommand(context, deps.provider, deps.statusBar, deps.outputChannel, logger, () =>
		deps.syncEngine.syncNow(true)
	);

	registerHelpAndFeedbackCommand(context);

	// Groups-file deep link: notices about leftover provider groups open the
	// host's chatLanguageModels.json, the one place a group can be deleted.
	registerOpenGroupsFileCommand(context, logger);

	// Settings.json deep link: the dashboard's per-setting jump (revealSetting).
	registerOpenSettingKeyCommand(context, logger);

	registerReportIssueCommand(
		context,
		deps.registry,
		() => deps.statusBar.connectionStatus,
		deps.extVersion,
		deps.vscodeVersion,
		deps.issueReporter
	);
}
