import * as vscode from "vscode";
import type { ServerRegistry, OAuthInput, OAuthSecrets } from "./serverRegistry";
import { DEFAULT_VIRTUAL_KEY_HEADER } from "../provider/auth";

/**
 * Prompts for the OAuth client-credentials fields. `existing` pre-fills the
 * inputs when editing. Returns undefined if the user cancels any step.
 */
async function collectOAuthInput(existing?: OAuthSecrets): Promise<OAuthInput | undefined> {
	const idpUrl = await vscode.window.showInputBox({
		title: "LiteLLM: OAuth - Token URL (IDP)",
		prompt: "Enter the OAuth token endpoint that issues the access token",
		ignoreFocusOut: true,
		value: existing?.idpUrl,
		placeHolder: "https://idp.example.com/auth/realms/<realm>/protocol/openid-connect/token",
		validateInput: (value) => {
			if (!value.trim()) {
				return "Token URL is required";
			}
			if (!value.startsWith("http://") && !value.startsWith("https://")) {
				return "URL must start with http:// or https://";
			}
			return null;
		},
	});
	if (idpUrl === undefined) {
		return undefined;
	}

	const clientId = await vscode.window.showInputBox({
		title: "LiteLLM: OAuth - Client ID",
		prompt: "Enter the OAuth client_id",
		ignoreFocusOut: true,
		value: existing?.clientId,
		validateInput: (value) => (value.trim() ? null : "Client ID is required"),
	});
	if (clientId === undefined) {
		return undefined;
	}

	const maskSecret = vscode.workspace.getConfiguration("litellm-vscode-chat").get<boolean>("maskApiKeyInput", true);
	const clientSecret = await vscode.window.showInputBox({
		title: "LiteLLM: OAuth - Client Secret",
		prompt: existing ? "Update the OAuth client_secret" : "Enter the OAuth client_secret",
		ignoreFocusOut: true,
		password: maskSecret,
		value: existing?.clientSecret,
		validateInput: (value) => (value.trim() ? null : "Client Secret is required"),
	});
	if (clientSecret === undefined) {
		return undefined;
	}

	const virtualKey = await vscode.window.showInputBox({
		title: "LiteLLM: OAuth - Virtual Key",
		prompt: `Enter the virtual/client key sent in the ${DEFAULT_VIRTUAL_KEY_HEADER} header (leave empty if not required)`,
		ignoreFocusOut: true,
		password: maskSecret,
		value: existing?.virtualKey,
	});
	if (virtualKey === undefined) {
		return undefined;
	}

	const virtualKeyHeader = await vscode.window.showInputBox({
		title: "LiteLLM: OAuth - Virtual Key Header",
		prompt: "Header name for the virtual key",
		ignoreFocusOut: true,
		value: existing?.virtualKeyHeader ?? DEFAULT_VIRTUAL_KEY_HEADER,
		placeHolder: DEFAULT_VIRTUAL_KEY_HEADER,
	});
	if (virtualKeyHeader === undefined) {
		return undefined;
	}

	const trimmedHeader = virtualKeyHeader.trim();
	return {
		idpUrl: idpUrl.trim(),
		clientId: clientId.trim(),
		clientSecret: clientSecret.trim(),
		virtualKey: virtualKey.trim(),
		...(trimmedHeader && trimmedHeader !== DEFAULT_VIRTUAL_KEY_HEADER ? { virtualKeyHeader: trimmedHeader } : {}),
	};
}

/** Asks the user which auth method to use. Returns undefined on cancel. */
async function pickAuthType(current?: "apikey" | "oauth"): Promise<"apikey" | "oauth" | undefined> {
	const items: (vscode.QuickPickItem & { value: "apikey" | "oauth" })[] = [
		{
			label: "$(key) API Key",
			description: current === "apikey" ? "(current)" : undefined,
			detail: "Static API key sent as a Bearer token",
			value: "apikey",
		},
		{
			label: "$(shield) OAuth (Client Credentials)",
			description: current === "oauth" ? "(current)" : undefined,
			detail: "Fetch a bearer token from an IDP using client_id / client_secret",
			value: "oauth",
		},
	];
	const pick = await vscode.window.showQuickPick(items, {
		title: "LiteLLM: Authentication Method",
		placeHolder: "How does this server authenticate?",
	});
	return pick?.value;
}

export async function addServerFlow(registry: ServerRegistry, outputChannel: vscode.OutputChannel): Promise<boolean> {
	const label = await vscode.window.showInputBox({
		title: "LiteLLM: Add Server - Label",
		prompt: "Enter a unique label for this server (e.g., 'Production', 'Local Dev')",
		ignoreFocusOut: true,
		placeHolder: "My LiteLLM Server",
		validateInput: (value) => {
			if (!value.trim()) {
				return "Label is required";
			}
			if (value.includes("/")) {
				return "Label cannot contain '/' (used as separator in model parameters)";
			}
			if (registry.hasLabel(value.trim())) {
				return "A server with this label already exists";
			}
			return null;
		},
	});
	if (label === undefined) {
		return false;
	}

	const baseUrl = await vscode.window.showInputBox({
		title: "LiteLLM: Add Server - Base URL",
		prompt: "Enter the LiteLLM base URL",
		ignoreFocusOut: true,
		placeHolder: "http://localhost:4000",
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
	if (baseUrl === undefined) {
		return false;
	}

	const authType = await pickAuthType();
	if (authType === undefined) {
		return false;
	}

	if (authType === "oauth") {
		const oauth = await collectOAuthInput();
		if (oauth === undefined) {
			return false;
		}
		await registry.addOAuthServer(label.trim(), baseUrl.trim(), oauth);
	} else {
		const maskApiKey = vscode.workspace.getConfiguration("litellm-vscode-chat").get<boolean>("maskApiKeyInput", true);
		const apiKey = await vscode.window.showInputBox({
			title: "LiteLLM: Add Server - API Key",
			prompt: "Enter the API key (leave empty if not required)",
			ignoreFocusOut: true,
			password: maskApiKey,
		});
		if (apiKey === undefined) {
			return false;
		}
		await registry.addServer(label.trim(), baseUrl.trim(), apiKey.trim());
	}
	outputChannel.appendLine(`[${new Date().toISOString()}] Added server "${label.trim()}" at ${baseUrl.trim()}`);

	vscode.window
		.showInformationMessage(`Server "${label.trim()}" added!`, "Test Connection", "Open Chat", "Dismiss")
		.then((choice) => {
			if (choice === "Test Connection") {
				vscode.commands.executeCommand("litellm.testConnection");
			} else if (choice === "Open Chat") {
				vscode.commands.executeCommand("workbench.action.chat.open");
			}
		});

	return true;
}

export async function manageServerFlow(
	registry: ServerRegistry,
	serverId: string,
	outputChannel: vscode.OutputChannel
): Promise<void> {
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
		const label = await vscode.window.showInputBox({
			title: "LiteLLM: Edit Server - Label",
			prompt: "Update the server label",
			ignoreFocusOut: true,
			value: server.label,
			validateInput: (value) => {
				if (!value.trim()) {
					return "Label is required";
				}
				if (value.includes("/")) {
					return "Label cannot contain '/' (used as separator in model parameters)";
				}
				if (registry.hasLabel(value.trim(), serverId)) {
					return "A server with this label already exists";
				}
				return null;
			},
		});
		if (label === undefined) {
			return;
		}

		const baseUrl = await vscode.window.showInputBox({
			title: "LiteLLM: Edit Server - Base URL",
			prompt: "Update the LiteLLM base URL",
			ignoreFocusOut: true,
			value: server.baseUrl,
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
		if (baseUrl === undefined) {
			return;
		}

		const currentAuthType = server.auth?.type === "oauth" ? "oauth" : "apikey";
		const authType = await pickAuthType(currentAuthType);
		if (authType === undefined) {
			return;
		}

		if (authType === "oauth") {
			const existingOAuth = await registry.getOAuthSecrets(server);
			const oauth = await collectOAuthInput(existingOAuth);
			if (oauth === undefined) {
				return;
			}
			await registry.updateOAuthServer(serverId, label.trim(), baseUrl.trim(), oauth);
		} else {
			const existingApiKey = await registry.getApiKey(serverId);
			const maskApiKey = vscode.workspace.getConfiguration("litellm-vscode-chat").get<boolean>("maskApiKeyInput", true);
			const apiKey = await vscode.window.showInputBox({
				title: "LiteLLM: Edit Server - API Key",
				prompt: existingApiKey ? "Update the API key" : "Enter the API key (leave empty if not required)",
				ignoreFocusOut: true,
				password: maskApiKey,
				value: existingApiKey,
			});
			if (apiKey === undefined) {
				return;
			}
			await registry.updateServer(serverId, label.trim(), baseUrl.trim(), apiKey.trim());
		}
		outputChannel.appendLine(`[${new Date().toISOString()}] Updated server "${label.trim()}"`);

		vscode.window
			.showInformationMessage(`Server "${label.trim()}" updated!`, "Test Connection", "Dismiss")
			.then((choice) => {
				if (choice === "Test Connection") {
					vscode.commands.executeCommand("litellm.testConnection");
				}
			});
	} else if (pick.action === "test") {
		outputChannel.appendLine(`\n[${new Date().toISOString()}] Testing all servers...`);
		outputChannel.show(true);
		await vscode.commands.executeCommand("litellm.testConnection");
	} else if (pick.action === "remove") {
		const confirm = await vscode.window.showWarningMessage(
			`Remove server "${server.label}" (${server.baseUrl})?`,
			{ modal: true },
			"Remove"
		);
		if (confirm === "Remove") {
			await registry.removeServer(serverId);
			outputChannel.appendLine(`[${new Date().toISOString()}] Removed server "${server.label}"`);
			vscode.window.showInformationMessage(`Server "${server.label}" removed.`);
		}
	}
}

export function registerManageCommand(
	context: vscode.ExtensionContext,
	registry: ServerRegistry,
	outputChannel: vscode.OutputChannel
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.manage", async () => {
			const servers = registry.getServers();

			if (servers.length === 0) {
				await addServerFlow(registry, outputChannel);
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
				await addServerFlow(registry, outputChannel);
			} else if (pick.action === "test-all") {
				await vscode.commands.executeCommand("litellm.testConnection");
			} else if (pick.action.startsWith("edit:")) {
				const serverId = pick.action.slice(5);
				await manageServerFlow(registry, serverId, outputChannel);
			}
		})
	);
}
