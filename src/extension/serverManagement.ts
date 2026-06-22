import * as vscode from "vscode";
import {
	DEFAULT_OAUTH2_VIRTUAL_KEY_HEADER,
	normalizeAuthConfig,
	type OAuth2Credentials,
	type ServerAuthConfig,
	type ServerRegistry,
} from "./serverRegistry";

interface AuthPromptResult {
	auth: ServerAuthConfig;
	apiKey?: string;
	oauthCredentials?: OAuth2Credentials;
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

	const authResult = await promptAuthConfig(registry, "add");
	if (!authResult) {
		return false;
	}

	await registry.addServer(
		label.trim(),
		baseUrl.trim(),
		authResult.apiKey ?? "",
		authResult.auth,
		authResult.oauthCredentials
	);
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

		const authResult = await promptAuthConfig(registry, "edit", serverId, server.auth);
		if (!authResult) {
			return;
		}

		await registry.updateServer(
			serverId,
			label.trim(),
			baseUrl.trim(),
			authResult.apiKey,
			authResult.auth,
			authResult.oauthCredentials
		);
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

async function promptAuthConfig(
	registry: ServerRegistry,
	mode: "add" | "edit",
	serverId?: string,
	currentAuth?: ServerAuthConfig
): Promise<AuthPromptResult | undefined> {
	const normalizedAuth = normalizeAuthConfig(currentAuth);
	const authPick = await vscode.window.showQuickPick(
		[
			{
				label: "$(key) API Key",
				description: "Use a static LiteLLM API key",
				authType: "apiKey" as const,
			},
			{
				label: "$(shield) OAuth2 Client Credentials",
				description: "Fetch short-lived bearer tokens from an IdP",
				authType: "oauth2" as const,
			},
		],
		{
			title: `LiteLLM: ${mode === "add" ? "Add" : "Edit"} Server - Authentication`,
			placeHolder: "Choose how to authenticate to this LiteLLM server",
			ignoreFocusOut: true,
		}
	);
	if (!authPick) {
		return undefined;
	}

	if (authPick.authType === "apiKey") {
		const existingApiKey = serverId ? await registry.getApiKey(serverId) : "";
		const maskApiKey = vscode.workspace.getConfiguration("litellm-vscode-chat").get<boolean>("maskApiKeyInput", true);
		const apiKey = await vscode.window.showInputBox({
			title: `LiteLLM: ${mode === "add" ? "Add" : "Edit"} Server - API Key`,
			prompt: existingApiKey ? "Update the API key" : "Enter the API key (leave empty if not required)",
			ignoreFocusOut: true,
			password: maskApiKey,
			value: existingApiKey,
		});
		if (apiKey === undefined) {
			return undefined;
		}
		return { auth: { type: "apiKey" }, apiKey: apiKey.trim() };
	}

	const existingOAuthCredentials = serverId
		? await registry.getOAuth2Credentials(serverId)
		: { clientId: "", clientSecret: "", virtualKey: "" };
	const existingOAuthAuth = normalizedAuth.type === "oauth2" ? normalizedAuth : undefined;
	const tokenUrl = await vscode.window.showInputBox({
		title: `LiteLLM: ${mode === "add" ? "Add" : "Edit"} Server - OAuth2 Token URL`,
		prompt: "Enter the OAuth2 token endpoint URL",
		ignoreFocusOut: true,
		placeHolder: "https://idp.example.com/oauth2/token",
		value: existingOAuthAuth?.tokenUrl ?? "",
		validateInput: (value) => validateRequiredUrl(value, "Token URL"),
	});
	if (tokenUrl === undefined) {
		return undefined;
	}

	const clientId = await vscode.window.showInputBox({
		title: `LiteLLM: ${mode === "add" ? "Add" : "Edit"} Server - OAuth2 Client ID`,
		prompt: "Enter the OAuth2 client ID",
		ignoreFocusOut: true,
		value: existingOAuthCredentials.clientId,
		validateInput: (value) => (value.trim() ? null : "Client ID is required"),
	});
	if (clientId === undefined) {
		return undefined;
	}

	const clientSecret = await vscode.window.showInputBox({
		title: `LiteLLM: ${mode === "add" ? "Add" : "Edit"} Server - OAuth2 Client Secret`,
		prompt: "Enter the OAuth2 client secret",
		ignoreFocusOut: true,
		password: true,
		value: existingOAuthCredentials.clientSecret,
		validateInput: (value) => (value ? null : "Client secret is required"),
	});
	if (clientSecret === undefined) {
		return undefined;
	}

	const virtualKey = await vscode.window.showInputBox({
		title: `LiteLLM: ${mode === "add" ? "Add" : "Edit"} Server - Virtual Key`,
		prompt: "Enter the optional LiteLLM virtual key or client identifier",
		ignoreFocusOut: true,
		value: existingOAuthCredentials.virtualKey,
	});
	if (virtualKey === undefined) {
		return undefined;
	}

	const virtualKeyHeader = await vscode.window.showInputBox({
		title: `LiteLLM: ${mode === "add" ? "Add" : "Edit"} Server - Virtual Key Header`,
		prompt: "Enter the header name used for the optional virtual key",
		ignoreFocusOut: true,
		value: existingOAuthAuth?.virtualKeyHeader ?? DEFAULT_OAUTH2_VIRTUAL_KEY_HEADER,
		validateInput: (value) => (value.trim() ? null : "Header name is required"),
	});
	if (virtualKeyHeader === undefined) {
		return undefined;
	}

	return {
		auth: {
			type: "oauth2",
			tokenUrl: tokenUrl.trim(),
			virtualKeyHeader: virtualKeyHeader.trim() || DEFAULT_OAUTH2_VIRTUAL_KEY_HEADER,
		},
		oauthCredentials: {
			clientId: clientId.trim(),
			clientSecret,
			virtualKey: virtualKey.trim(),
		},
	};
}

function validateRequiredUrl(value: string, label: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) {
		return `${label} is required`;
	}
	if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
		return `${label} must start with http:// or https://`;
	}
	return null;
}
