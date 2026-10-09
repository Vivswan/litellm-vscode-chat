import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import type { LiteLLMChatModelProvider } from "../../provider";
import { CMD } from "../../shared/config/commandIds";
import { HAS_SHOWN_WELCOME_KEY } from "../../shared/config/storageKeys";
import type { Logger } from "../../shared/logger";
import type { AggregatedStatus } from "../../shared/servers";
import { DOCS_GETTING_STARTED_URL } from "../../shared/util/links";
import type { DashboardController } from "../dashboard/panel";
import { registerManageCommand } from "../servers/serverManagement";
import type { DeclaredServerView, ServerSyncEngine } from "../servers/serverSync/engine";
import type { ServerVerdict } from "../servers/syncFailureOverlay";
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
 * The connection status bar item (through the slot registry's StatusItem) and the refresh notifier; both consume the
 * same aggregated status through wireStatusFanout.
 */
export function wireStatusSurfaces(
	context: vscode.ExtensionContext,
	logger: Logger,
	hasConfiguredServers: () => boolean,
	verdict: Pick<ServerVerdict, "declared" | "rows">
): { statusBar: StatusBarManager; notifier: Notifier } {
	const statusBar = new StatusBarManager(
		context,
		logger,
		hasConfiguredServers,
		verdict,
		new StatusItem({
			slot: "connection",
			alignment: vscode.StatusBarAlignment.Right,
			priority: 100,
			command: CMD.openDashboard,
			log: (message) => logger.log(message),
		})
	);
	const notifier = new Notifier(hasConfiguredServers, verdict);
	// Disposal withdraws an armed no-servers claim, so its deferred toast cannot fire from a deactivated extension.
	context.subscriptions.push(notifier);
	return { statusBar, notifier };
}

/**
 * Status bar, refresh notifications, and the dashboard share one status callback, isolated so one consumer's failure
 * cannot starve the others; sync passes re-judge the two overlay consumers, since a sync-only change (a failed upsert,
 * a blocked entry clearing) never fires the status callback.
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
	// The dashboard already re-renders per pass (wireDashboard's own onDidSync subscription); these two read the sync
	// outcome only through the overlay.
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
 *   this runs during activation -> Gated on the declared servers setting only
 */
export async function maybeShowWelcome(
	context: vscode.ExtensionContext,
	logger: Logger,
	deps: {
		hasDeclaredServers: () => boolean;
	}
): Promise<void> {
	const hasShownWelcome = context.globalState.get<boolean>(HAS_SHOWN_WELCOME_KEY, false);
	if (!hasShownWelcome && !deps.hasDeclaredServers()) {
		showActionableMessage("info", l10n.t("Welcome to LiteLLM! Connect to 100+ LLMs in VS Code."), [
			reconfigureAction(configureNowLabel()),
			{
				label: l10n.t("Documentation"),
				run: () => void vscode.env.openExternal(vscode.Uri.parse(DOCS_GETTING_STARTED_URL)),
			},
		]).catch((error) => {
			logger.error("Welcome message failed", error);
		});
	}
	if (!hasShownWelcome) {
		await context.globalState.update(HAS_SHOWN_WELCOME_KEY, true);
	}
}

export function wireUiCommands(
	context: vscode.ExtensionContext,
	logger: Logger,
	deps: {
		provider: LiteLLMChatModelProvider;
		statusBar: StatusBarManager;
		outputChannel: vscode.OutputChannel;
		syncEngine: ServerSyncEngine;
		/** The owner's declared set (ServerVerdict.declared); the issue report judges configuration presence from it. */
		getDeclared: () => readonly DeclaredServerView[];
		issueReporter: IssueReporter;
		extVersion: string;
		vscodeVersion: string;
		/** The gate the status bar and notifier share; the two refresh commands read it when nothing was probed. */
		hasConfiguredServers: () => boolean;
	}
): void {
	registerManageCommand(context);

	registerTestConnectionCommand(
		context,
		deps.provider,
		deps.statusBar,
		deps.outputChannel,
		logger,
		deps.hasConfiguredServers
	);

	//   Sync Models Now -> a forced server sync first (reconciling groups edited natively), then a
	//       discovery-cache-skipping refetch
	registerSyncModelsCommand(
		context,
		deps.provider,
		deps.statusBar,
		deps.outputChannel,
		logger,
		deps.hasConfiguredServers,
		() => deps.syncEngine.syncNow(true)
	);

	registerHelpAndFeedbackCommand(context);

	// Groups-file deep link: notices about leftover provider groups open the host's chatLanguageModels.json, the one
	// place a group can be deleted.
	registerOpenGroupsFileCommand(context, logger);

	registerOpenSettingKeyCommand(context, logger);

	registerReportIssueCommand(
		context,
		() => deps.statusBar.connectionStatus,
		deps.getDeclared,
		deps.extVersion,
		deps.vscodeVersion,
		deps.issueReporter
	);
}
