import * as vscode from "vscode";
import type { ServerRegistry } from "./serverRegistry";

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

	const headersInput = await vscode.window.showInputBox({
		title: "LiteLLM: Add Server - Custom Headers (Optional)",
		prompt: 'Enter custom HTTP headers as JSON (e.g., {"x-litellm-api-key": "key"}). Leave empty to skip.',
		ignoreFocusOut: true,
		placeHolder: '{"Header-Name": "value"}',
		validateInput: (value) => {
			if (!value.trim()) {
				return null;
			}
			try {
				const parsed = JSON.parse(value);
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
					return "Must be a JSON object";
				}
				for (const v of Object.values(parsed)) {
					if (typeof v !== "string") {
						return "All header values must be strings";
					}
				}
				return null;
			} catch {
				return "Invalid JSON format";
			}
		},
	});
	if (headersInput === undefined) {
		return false;
	}

	const customHeaders = headersInput.trim() ? (JSON.parse(headersInput) as Record<string, string>) : undefined;

	await registry.addServer(label.trim(), baseUrl.trim(), apiKey.trim(), customHeaders);
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

		const existingHeaders = server.customHeaders ?? {};
		const existingHeadersJson = Object.keys(existingHeaders).length > 0 ? JSON.stringify(existingHeaders) : "";
		const headersInput = await vscode.window.showInputBox({
			title: "LiteLLM: Edit Server - Custom Headers (Optional)",
			prompt: 'Update custom HTTP headers as JSON (e.g., {"x-litellm-api-key": "key"}). Clear to remove.',
			ignoreFocusOut: true,
			placeHolder: '{"Header-Name": "value"}',
			value: existingHeadersJson,
			validateInput: (value) => {
				if (!value.trim()) {
					return null;
				}
				try {
					const parsed = JSON.parse(value);
					if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
						return "Must be a JSON object";
					}
					for (const v of Object.values(parsed)) {
						if (typeof v !== "string") {
							return "All header values must be strings";
						}
					}
					return null;
				} catch {
					return "Invalid JSON format";
				}
			},
		});
		if (headersInput === undefined) {
			return;
		}

		const customHeaders = headersInput.trim() ? (JSON.parse(headersInput) as Record<string, string>) : undefined;

		await registry.updateServer(serverId, label.trim(), baseUrl.trim(), apiKey.trim(), customHeaders);
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
