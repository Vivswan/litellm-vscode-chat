import * as vscode from "vscode";
import type { Logger } from "../shared/logger";
import { getMaskApiKeyInput, getModelParametersConfig } from "../shared/settings";
import {
	dismissAction,
	openChatAction,
	openSettingsAction,
	showActionableMessage,
	testConnectionAction,
} from "./notifier";
import type { ServerRegistry } from "./serverRegistry";

async function promptForServerLabel(
	registry: ServerRegistry,
	initial?: string,
	excludeId?: string
): Promise<string | undefined> {
	const editing = initial !== undefined;
	return vscode.window.showInputBox({
		title: editing ? "LiteLLM: Edit Server - Label" : "LiteLLM: Add Server - Label",
		prompt: editing
			? "Update the server label"
			: "Enter a unique label for this server (e.g., 'Production', 'Local Dev')",
		ignoreFocusOut: true,
		...(editing ? { value: initial } : { placeHolder: "My LiteLLM Server" }),
		validateInput: (value) => {
			if (!value.trim()) {
				return "Label is required";
			}
			if (value.includes("/")) {
				return "Label cannot contain '/' (used as separator in model parameters)";
			}
			if (registry.hasLabel(value.trim(), excludeId)) {
				return "A server with this label already exists";
			}
			return null;
		},
	});
}

async function promptForBaseUrl(initial?: string): Promise<string | undefined> {
	const editing = initial !== undefined;
	return vscode.window.showInputBox({
		title: editing ? "LiteLLM: Edit Server - Base URL" : "LiteLLM: Add Server - Base URL",
		prompt: editing ? "Update the LiteLLM base URL" : "Enter the LiteLLM base URL",
		ignoreFocusOut: true,
		...(editing ? { value: initial } : { placeHolder: "http://localhost:4000" }),
		validateInput: (value) => {
			if (!value.trim()) {
				return "Base URL is required";
			}
			if (!value.startsWith("http://") && !value.startsWith("https://")) {
				return "URL must start with http:// or https://";
			}
			return null;
		},
	});
}

async function promptForApiKey(masked: boolean, initial?: string): Promise<string | undefined> {
	const editing = initial !== undefined;
	return vscode.window.showInputBox({
		title: editing ? "LiteLLM: Edit Server - API Key" : "LiteLLM: Add Server - API Key",
		prompt: editing && initial ? "Update the API key" : "Enter the API key (leave empty if not required)",
		ignoreFocusOut: true,
		password: masked,
		...(editing ? { value: initial } : {}),
	});
}

/**
 * Renaming a server orphans modelParameters entries scoped to the old label
 * prefix ("OldLabel/model"). We warn instead of auto-migrating because the
 * setting may live in user or workspace scope and the user may prefer to keep
 * entries for a label they plan to reuse.
 */
export function warnAboutOrphanedModelParameters(
	oldLabel: string,
	newLabel: string,
	parameterKeys: readonly string[]
): void {
	const prefix = `${oldLabel}/`;
	const orphaned = parameterKeys.filter((key) => key.startsWith(prefix));
	if (orphaned.length === 0) {
		return;
	}
	const noun = orphaned.length === 1 ? "entry" : "entries";
	void showActionableMessage(
		"warning",
		`Renaming the server left ${orphaned.length} modelParameters ${noun} scoped to the old label (e.g., "${orphaned[0]}"). Update the "${prefix}" prefix to "${newLabel}/" in settings to keep them applied.`,
		[openSettingsAction("litellm-vscode-chat.modelParameters"), dismissAction()]
	);
}

async function addServerFlow(registry: ServerRegistry, logger: Logger): Promise<boolean> {
	const label = await promptForServerLabel(registry);
	if (label === undefined) {
		return false;
	}

	const baseUrl = await promptForBaseUrl();
	if (baseUrl === undefined) {
		return false;
	}

	const apiKey = await promptForApiKey(getMaskApiKeyInput());
	if (apiKey === undefined) {
		return false;
	}

	await registry.addServer(label.trim(), baseUrl.trim(), apiKey.trim());
	logger.log(`Added server "${label.trim()}" at ${baseUrl.trim()}`);

	void showActionableMessage("info", `Server "${label.trim()}" added!`, [
		testConnectionAction(),
		openChatAction(),
		dismissAction(),
	]);

	return true;
}

async function manageServerFlow(registry: ServerRegistry, serverId: string, logger: Logger): Promise<void> {
	const servers = registry.getServers();
	const server = servers.find((s) => s.id === serverId);
	if (!server) {
		return;
	}

	const pick = await vscode.window.showQuickPick(
		[
			{ label: "$(edit) Edit Server", action: "edit" },
			{ label: "$(testing-run-icon) Test All Servers", action: "test" },
			{ label: "$(trash) Remove Server", action: "remove" },
		],
		{
			title: `LiteLLM: ${server.label}`,
			placeHolder: `Manage server "${server.label}" (${server.baseUrl})`,
		}
	);

	if (!pick) {
		return;
	}

	if (pick.action === "edit") {
		const label = await promptForServerLabel(registry, server.label, serverId);
		if (label === undefined) {
			return;
		}

		const baseUrl = await promptForBaseUrl(server.baseUrl);
		if (baseUrl === undefined) {
			return;
		}

		const existingApiKey = await registry.getApiKey(serverId);
		const apiKey = await promptForApiKey(getMaskApiKeyInput(), existingApiKey);
		if (apiKey === undefined) {
			return;
		}

		const oldLabel = server.label;
		await registry.updateServer(serverId, label.trim(), baseUrl.trim(), apiKey.trim());
		logger.log(`Updated server "${label.trim()}"`);

		void showActionableMessage("info", `Server "${label.trim()}" updated!`, [testConnectionAction(), dismissAction()]);

		if (label.trim() !== oldLabel) {
			warnAboutOrphanedModelParameters(oldLabel, label.trim(), Object.keys(getModelParametersConfig()));
		}
	} else if (pick.action === "test") {
		await vscode.commands.executeCommand("litellm.testConnection");
	} else if (pick.action === "remove") {
		const confirm = await vscode.window.showWarningMessage(
			`Remove server "${server.label}" (${server.baseUrl})?`,
			{ modal: true },
			"Remove"
		);
		if (confirm === "Remove") {
			await registry.removeServer(serverId);
			logger.log(`Removed server "${server.label}"`);
			void vscode.window.showInformationMessage(`Server "${server.label}" removed.`);
		}
	}
}

export function registerManageCommand(
	context: vscode.ExtensionContext,
	registry: ServerRegistry,
	logger: Logger
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.manage", async () => {
			const servers = registry.getServers();

			if (servers.length === 0) {
				await addServerFlow(registry, logger);
				return;
			}

			const items: (vscode.QuickPickItem & { action: string })[] = [
				{ label: "$(add) Add Server", action: "add" },
				...servers.map((s) => ({
					label: `$(server) ${s.label}`,
					description: s.baseUrl,
					action: `edit:${s.id}`,
				})),
				{ label: "$(testing-run-icon) Test All Servers", action: "test-all" },
			];

			const pick = await vscode.window.showQuickPick(items, {
				title: "LiteLLM: Manage Servers",
				placeHolder: "Select an action or server to manage",
			});

			if (!pick) {
				return;
			}

			if (pick.action === "add") {
				await addServerFlow(registry, logger);
			} else if (pick.action === "test-all") {
				await vscode.commands.executeCommand("litellm.testConnection");
			} else if (pick.action.startsWith("edit:")) {
				const serverId = pick.action.slice(5);
				await manageServerFlow(registry, serverId, logger);
			}
		})
	);
}
