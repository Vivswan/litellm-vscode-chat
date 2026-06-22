import * as vscode from "vscode";
import type { ServerRegistry, ServerAuthInput, ServerConfig } from "./serverRegistry";
import { DEFAULT_VIRTUAL_KEY_HEADER } from "./serverRegistry";

const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

interface ExistingAuth {
	apiKey: string;
	oauthClientSecret: string;
	oauthVirtualKey: string;
}

/**
 * Prompts the user to choose an auth method and collects the relevant credentials.
 * Returns undefined if the user cancels at any step.
 */
async function collectAuthInput(server?: ServerConfig, existing?: ExistingAuth): Promise<ServerAuthInput | undefined> {
	const currentMethod = server?.authMethod === "oauth2" ? "oauth2" : "apiKey";
	const methodPick = await vscode.window.showQuickPick(
		[
			{
				label: "$(key) API Key",
				description: "Static API key sent as a Bearer token",
				method: "apiKey" as const,
				picked: currentMethod === "apiKey",
			},
			{
				label: "$(shield) OAuth2 (client credentials)",
				description: "Exchange client credentials for a short-lived token",
				method: "oauth2" as const,
				picked: currentMethod === "oauth2",
			},
		],
		{
			title: "LiteLLM: Authentication Method",
			placeHolder: "Choose how to authenticate with this server",
		}
	);
	if (!methodPick) {
		return undefined;
	}

	const maskInput = vscode.workspace.getConfiguration("litellm-vscode-chat").get<boolean>("maskApiKeyInput", true);

	if (methodPick.method === "apiKey") {
		const apiKey = await vscode.window.showInputBox({
			title: "LiteLLM: API Key",
			prompt: existing?.apiKey ? "Update the API key" : "Enter the API key (leave empty if not required)",
			ignoreFocusOut: true,
			password: maskInput,
			value: existing?.apiKey,
		});
		if (apiKey === undefined) {
			return undefined;
		}
		return { authMethod: "apiKey", apiKey: apiKey.trim() };
	}

	const tokenUrl = await vscode.window.showInputBox({
		title: "LiteLLM: OAuth2 Token URL",
		prompt: "Enter the OAuth2 token endpoint (client-credentials grant)",
		ignoreFocusOut: true,
		placeHolder: "https://idp.example.com/oauth/token",
		value: server?.oauthTokenUrl,
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
	if (tokenUrl === undefined) {
		return undefined;
	}

	const clientId = await vscode.window.showInputBox({
		title: "LiteLLM: OAuth2 Client ID",
		prompt: "Enter the OAuth2 client ID",
		ignoreFocusOut: true,
		value: server?.oauthClientId,
		validateInput: (value) => (value.trim() ? null : "Client ID is required"),
	});
	if (clientId === undefined) {
		return undefined;
	}

	const clientSecret = await vscode.window.showInputBox({
		title: "LiteLLM: OAuth2 Client Secret",
		prompt: existing?.oauthClientSecret ? "Update the client secret" : "Enter the OAuth2 client secret",
		ignoreFocusOut: true,
		password: maskInput,
		value: existing?.oauthClientSecret,
		validateInput: (value) => (value.trim() ? null : "Client secret is required"),
	});
	if (clientSecret === undefined) {
		return undefined;
	}

	const virtualKey = await vscode.window.showInputBox({
		title: "LiteLLM: Virtual Key (optional)",
		prompt: "Enter an optional virtual key sent in a custom header (leave empty to skip)",
		ignoreFocusOut: true,
		password: maskInput,
		value: existing?.oauthVirtualKey,
	});
	if (virtualKey === undefined) {
		return undefined;
	}

	const virtualKeyHeader = await vscode.window.showInputBox({
		title: "LiteLLM: Virtual Key Header (optional)",
		prompt: `Header used to send the virtual key (default: ${DEFAULT_VIRTUAL_KEY_HEADER})`,
		ignoreFocusOut: true,
		placeHolder: DEFAULT_VIRTUAL_KEY_HEADER,
		value: server?.oauthVirtualKeyHeader,
		validateInput: (value) => {
			const trimmed = value.trim();
			if (trimmed && !HEADER_NAME_PATTERN.test(trimmed)) {
				return "Invalid HTTP header name";
			}
			return null;
		},
	});
	if (virtualKeyHeader === undefined) {
		return undefined;
	}

	return {
		authMethod: "oauth2",
		oauth: {
			tokenUrl: tokenUrl.trim(),
			clientId: clientId.trim(),
			clientSecret: clientSecret.trim(),
			virtualKey: virtualKey.trim() || undefined,
			virtualKeyHeader: virtualKeyHeader.trim() || undefined,
		},
	};
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

	const auth = await collectAuthInput();
	if (auth === undefined) {
		return false;
	}

	await registry.addServer(label.trim(), baseUrl.trim(), auth.apiKey ?? "", auth);
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

		const existing: ExistingAuth = {
			apiKey: await registry.getApiKey(serverId),
			oauthClientSecret: await registry.getOAuthClientSecret(serverId),
			oauthVirtualKey: await registry.getOAuthVirtualKey(serverId),
		};
		const auth = await collectAuthInput(server, existing);
		if (auth === undefined) {
			return;
		}

		await registry.updateServer(serverId, label.trim(), baseUrl.trim(), auth.apiKey, auth);
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
					description: `${s.baseUrl} · ${s.authMethod === "oauth2" ? "OAuth2" : "API Key"}`,
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
