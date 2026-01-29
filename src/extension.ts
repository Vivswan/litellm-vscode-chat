import * as vscode from "vscode";
import { LiteLLMChatModelProvider } from "./provider";

/**
 * Check if the current VS Code version meets the minimum required version.
 * @param current The current VS Code version (e.g., "1.108.0")
 * @param required The minimum required version (e.g., "1.108.0")
 * @returns true if current version is compatible, false otherwise
 */
function isVersionCompatible(current: string, required: string): boolean {
	const parse = (v: string) =>
		v
			.split(".")
			.slice(0, 3)
			.map((n) => parseInt(n.replace(/[^0-9]/g, ""), 10));
	const [cMaj, cMin, cPat] = parse(current);
	const [rMaj, rMin, rPat] = parse(required);
	if (cMaj !== rMaj) {
		return cMaj > rMaj;
	}
	if (cMin !== rMin) {
		return cMin > rMin;
	}
	return cPat >= rPat;
}

export function activate(context: vscode.ExtensionContext) {
	// Check VS Code version compatibility
	const minVersion = "1.108.0";
	if (!isVersionCompatible(vscode.version, minVersion)) {
		vscode.window
			.showErrorMessage(
				`LiteLLM requires VS Code ${minVersion} or higher. You have ${vscode.version}. Please update VS Code.`,
				"Download Update"
			)
			.then((sel) => {
				if (sel) {
					vscode.env.openExternal(vscode.Uri.parse("https://code.visualstudio.com/"));
				}
			});
		return; // Don't register provider
	}
	// Build a descriptive User-Agent to help quantify API usage
	const ext = vscode.extensions.getExtension("vivswan.litellm-vscode-chat");
	const extVersion = ext?.packageJSON?.version ?? "unknown";
	const vscodeVersion = vscode.version;
	// Keep UA minimal: only extension version and VS Code version
	const ua = `litellm-vscode-chat/${extVersion} VSCode/${vscodeVersion}`;

	// Create output channel for diagnostics
	const outputChannel = vscode.window.createOutputChannel("LiteLLM");
	context.subscriptions.push(outputChannel);
	outputChannel.appendLine(`LiteLLM Extension activated (v${extVersion})`);

	const provider = new LiteLLMChatModelProvider(context.secrets, ua, outputChannel);
	// Register the LiteLLM provider under the vendor id used in package.json
	vscode.lm.registerLanguageModelChatProvider("litellm", provider);

	// Connection status tracking
	interface ConnectionStatus {
		state: "not-configured" | "loading" | "connected" | "error";
		modelCount?: number;
		error?: string;
		lastChecked?: Date;
	}

	let connectionStatus: ConnectionStatus = { state: "not-configured" };

	// Create status bar indicator
	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.command = "litellm.showDiagnostics";
	context.subscriptions.push(statusBarItem);

	// Function to update status bar based on connection state
	async function updateStatusBar(status?: ConnectionStatus) {
		if (status) {
			connectionStatus = status;
			// Persist state for next reload
			await context.globalState.update("litellm.lastConnectionStatus", status);
		}

		const baseUrl = await context.secrets.get("litellm.baseUrl");

		switch (connectionStatus.state) {
			case "not-configured":
				statusBarItem.text = "$(warning) LiteLLM";
				statusBarItem.tooltip = "Not configured - click to set up";
				statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
				break;
			case "loading":
				statusBarItem.text = "$(loading~spin) LiteLLM";
				statusBarItem.tooltip = "Fetching models...";
				statusBarItem.backgroundColor = undefined;
				break;
			case "connected": {
				const count = connectionStatus.modelCount ?? 0;
				statusBarItem.text = `$(check) LiteLLM (${count})`;
				statusBarItem.tooltip = `Connected to ${baseUrl}\n${count} model${count === 1 ? "" : "s"} available\nClick for diagnostics`;
				statusBarItem.backgroundColor = undefined;
				break;
			}
			case "error":
				statusBarItem.text = "$(error) LiteLLM";
				statusBarItem.tooltip = `Connection failed\n${connectionStatus.error || "Unknown error"}\nClick for details`;
				statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
				break;
		}
		statusBarItem.show();
	}

	// Restore last known state from previous session
	const lastStatus = context.globalState.get<ConnectionStatus>("litellm.lastConnectionStatus");
	if (lastStatus) {
		connectionStatus = lastStatus;
	}

	// Initial status bar update
	updateStatusBar();

	// Update when secrets change
	context.secrets.onDidChange((e) => {
		if (e.key === "litellm.baseUrl") {
			updateStatusBar({ state: "not-configured" });
		}
	});

	// Provide status update callback to provider
	provider.setStatusCallback((modelCount: number, error?: string) => {
		if (error) {
			outputChannel.appendLine(`[${new Date().toISOString()}] Model fetch failed: ${error}`);
			updateStatusBar({ state: "error", error, lastChecked: new Date() });
		} else if (modelCount === 0) {
			outputChannel.appendLine(`[${new Date().toISOString()}] Warning: Server returned 0 models`);
			updateStatusBar({ state: "error", modelCount: 0, error: "Server returned 0 models", lastChecked: new Date() });
		} else {
			outputChannel.appendLine(`[${new Date().toISOString()}] Successfully fetched ${modelCount} models`);
			updateStatusBar({ state: "connected", modelCount, lastChecked: new Date() });
		}
	});

	// Show welcome message on first run for unconfigured users
	const hasShownWelcome = context.globalState.get<boolean>("litellm.hasShownWelcome", false);
	if (!hasShownWelcome) {
		context.secrets.get("litellm.baseUrl").then((baseUrl) => {
			if (!baseUrl) {
				vscode.window
					.showInformationMessage(
						"Welcome to LiteLLM! Connect to 100+ LLMs in VS Code.",
						"Configure Now",
						"Documentation"
					)
					.then((choice) => {
						if (choice === "Configure Now") {
							vscode.commands.executeCommand("litellm.manage");
						} else if (choice === "Documentation") {
							vscode.env.openExternal(vscode.Uri.parse("https://github.com/Vivswan/litellm-vscode-chat#quick-start"));
						}
					});
			}
		});
		context.globalState.update("litellm.hasShownWelcome", true);
	}

	// Management command to configure base URL and API key
	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.manage", async () => {
			// First, prompt for base URL
			const existingBaseUrl = await context.secrets.get("litellm.baseUrl");
			const baseUrl = await vscode.window.showInputBox({
				title: "LiteLLM Base URL",
				prompt: existingBaseUrl
					? "Update your LiteLLM base URL"
					: "Enter your LiteLLM base URL (e.g., http://localhost:4000 or https://api.litellm.ai)",
				ignoreFocusOut: true,
				value: existingBaseUrl ?? "",
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
				return; // user canceled
			}

			// Then, prompt for API key
			const existingApiKey = await context.secrets.get("litellm.apiKey");
			const apiKey = await vscode.window.showInputBox({
				title: "LiteLLM API Key",
				prompt: existingApiKey
					? "Update your LiteLLM API key"
					: "Enter your LiteLLM API key (leave empty if not required)",
				ignoreFocusOut: true,
				password: false,
				value: existingApiKey ?? "",
			});
			if (apiKey === undefined) {
				return; // user canceled
			}

			// Save or clear the values
			if (!baseUrl.trim()) {
				await context.secrets.delete("litellm.baseUrl");
			} else {
				await context.secrets.store("litellm.baseUrl", baseUrl.trim());
			}

			if (!apiKey.trim()) {
				await context.secrets.delete("litellm.apiKey");
			} else {
				await context.secrets.store("litellm.apiKey", apiKey.trim());
			}

			// Update status bar to reflect new configuration
			await updateStatusBar({ state: "not-configured" });
			outputChannel.appendLine(`[${new Date().toISOString()}] Configuration updated: ${baseUrl.trim()}`);

			// Show success message with test connection option
			vscode.window
				.showInformationMessage("LiteLLM configuration saved!", "Test Connection", "Open Chat", "Dismiss")
				.then((choice) => {
					if (choice === "Test Connection") {
						vscode.commands.executeCommand("litellm.testConnection");
					} else if (choice === "Open Chat") {
						vscode.commands.executeCommand("workbench.action.chat.open");
					}
				});
		})
	);

	// Test connection command
	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.testConnection", async () => {
			const baseUrl = await context.secrets.get("litellm.baseUrl");
			if (!baseUrl) {
				vscode.window.showErrorMessage("LiteLLM is not configured. Please run 'Manage LiteLLM Provider' first.");
				return;
			}

			outputChannel.appendLine(`\n[${new Date().toISOString()}] Testing connection to ${baseUrl}...`);
			outputChannel.show(true);

			try {
				// Update status to loading
				await updateStatusBar({ state: "loading" });

				// Trigger model fetch by calling the provider method
				const models = await provider.prepareLanguageModelChatInformation(
					{ silent: false },
					new vscode.CancellationTokenSource().token
				);

				if (models.length === 0) {
					outputChannel.appendLine(`[${new Date().toISOString()}] WARNING: Server returned 0 models`);
					vscode.window
						.showWarningMessage(
							`LiteLLM: Connected to ${baseUrl}, but server returned no models. Check your LiteLLM proxy configuration.`,
							"View Output",
							"Reconfigure"
						)
						.then((choice) => {
							if (choice === "View Output") {
								outputChannel.show();
							} else if (choice === "Reconfigure") {
								vscode.commands.executeCommand("litellm.manage");
							}
						});
				} else {
					outputChannel.appendLine(`[${new Date().toISOString()}] SUCCESS: Found ${models.length} models`);
					vscode.window
						.showInformationMessage(
							`LiteLLM: Connection successful! Found ${models.length} model${models.length === 1 ? "" : "s"}.`,
							"View Models",
							"Open Chat"
						)
						.then((choice) => {
							if (choice === "View Models") {
								outputChannel.show();
							} else if (choice === "Open Chat") {
								vscode.commands.executeCommand("workbench.action.chat.open");
							}
						});
				}
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				outputChannel.appendLine(`[${new Date().toISOString()}] ERROR: ${errorMsg}`);
				vscode.window
					.showErrorMessage(`LiteLLM: Connection failed - ${errorMsg}`, "View Output", "Reconfigure")
					.then((choice) => {
						if (choice === "View Output") {
							outputChannel.show();
						} else if (choice === "Reconfigure") {
							vscode.commands.executeCommand("litellm.manage");
						}
					});
			}
		})
	);

	// Show diagnostics command
	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.showDiagnostics", async () => {
			const baseUrl = await context.secrets.get("litellm.baseUrl");
			const hasApiKey = !!(await context.secrets.get("litellm.apiKey"));

			const statusText =
				connectionStatus.state === "not-configured"
					? "Not configured"
					: connectionStatus.state === "loading"
						? "Loading..."
						: connectionStatus.state === "connected"
							? `Connected (${connectionStatus.modelCount ?? 0} models)`
							: `Error: ${connectionStatus.error || "Unknown error"}`;

			const lastCheckedText = connectionStatus.lastChecked
				? new Date(connectionStatus.lastChecked).toLocaleString()
				: "Never";

			const diagnosticMessage = [
				"LiteLLM Diagnostics",
				"",
				`Configuration:`,
				`  Base URL: ${baseUrl || "Not set"}`,
				`  API Key: ${hasApiKey ? "Configured" : "Not set"}`,
				"",
				`Connection Status: ${statusText}`,
				`Last Checked: ${lastCheckedText}`,
				"",
				"Check the LiteLLM output channel for detailed logs.",
			].join("\n");

			const choice = await vscode.window.showInformationMessage(
				diagnosticMessage,
				{ modal: true },
				"View Output",
				"Test Connection",
				"Reconfigure"
			);

			if (choice === "View Output") {
				outputChannel.show();
			} else if (choice === "Test Connection") {
				vscode.commands.executeCommand("litellm.testConnection");
			} else if (choice === "Reconfigure") {
				vscode.commands.executeCommand("litellm.manage");
			}
		})
	);
}

export function deactivate() {}
