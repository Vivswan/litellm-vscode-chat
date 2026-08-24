import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import type { CommandId } from "../../shared/config/commandIds";
import { CMD, INTERNAL_CMD } from "../../shared/config/commandIds";

/** Settings-view filter that narrows to this extension's settings. */
export const EXTENSION_SETTINGS_FILTER = "@ext:vivswan.litellm-vscode-chat";

/** A hub entry either routes in-module ("servers", "settings") or names the extension command it executes as-is. */
interface HubItem extends vscode.QuickPickItem {
	action: "servers" | "settings" | CommandId;
}

/**
 * Resolved per open: a module-level constant would localize before l10n.config
 * and freeze English. Codicon prefixes stay inside the literals so extraction
 * keys match what the quick pick displays.
 */
function hubItems(): readonly HubItem[] {
	return [
		{
			label: l10n.t("$(server) Manage Servers"),
			description: l10n.t("Servers, API keys, and which models are enabled"),
			action: "servers",
		},
		{
			label: l10n.t("$(dashboard) Open Dashboard"),
			description: l10n.t("Servers, models, and settings in one view"),
			action: CMD.openDashboard,
		},
		{
			label: l10n.t("$(sync) Sync Models Now"),
			description: l10n.t("Refetch the model list from every server"),
			action: CMD.syncModels,
		},
		{
			label: l10n.t("$(testing-run-icon) Test Connection"),
			description: l10n.t("Check every server and report the result"),
			action: CMD.testConnection,
		},
		{
			label: l10n.t("$(pulse) Show Diagnostics"),
			description: l10n.t("Connection state and per-server details"),
			action: CMD.showDiagnostics,
		},
		{
			label: l10n.t("$(key) Set Server Secret"),
			description: l10n.t("Store an API key or OAuth secret outside settings files"),
			action: CMD.setServerSecret,
		},
		{
			label: l10n.t("$(settings-gear) Open Settings"),
			description: l10n.t("Timeouts, caching, headers, model parameters"),
			action: "settings",
		},
		{
			label: l10n.t("$(question) Help & Feedback"),
			description: l10n.t("Documentation, feature requests, bug reports"),
			action: CMD.helpAndFeedback,
		},
		{
			label: l10n.t("$(report) Report Issue"),
			description: l10n.t("Open a prefilled GitHub issue"),
			action: CMD.reportIssue,
		},
	];
}

/**
 * litellm.manage is the extension's front door: a hub quick pick routing to the
 * dashboard's Servers view and the individually registered commands.
 *
 * litellm.manageServers is the direct route for callers that promise
 * configuration and must not land a user on the hub menu. It stays out of
 * package.json's contributes.commands, so the palette shows only the hub.
 */
export function registerManageCommand(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(CMD.manage, async () => {
			const pick = await vscode.window.showQuickPick([...hubItems()], {
				title: "LiteLLM",
				placeHolder: l10n.t("Select an action"),
			});
			if (!pick) {
				return;
			}
			if (pick.action === "servers") {
				await vscode.commands.executeCommand(CMD.openDashboard);
			} else if (pick.action === "settings") {
				await vscode.commands.executeCommand("workbench.action.openSettings", EXTENSION_SETTINGS_FILTER);
			} else {
				await vscode.commands.executeCommand(pick.action);
			}
		}),
		vscode.commands.registerCommand(INTERNAL_CMD.manageServers, () => vscode.commands.executeCommand(CMD.openDashboard))
	);
}
