import * as vscode from "vscode";
import { LiteLLMChatModelProvider } from "./provider";
import type { AggregatedStatus } from "./provider";
import { IssueReporter, DiagnosticsSnapshot } from "./issueReporter";
import { ServerRegistry } from "./serverRegistry";
import type { ServerStatus } from "./serverRegistry";

const GITHUB_REPO = "https://github.com/Vivswan/litellm-vscode-chat";
const GITHUB_NEW_ISSUE_FEATURE = `${GITHUB_REPO}/issues/new?labels=enhancement&title=%5BFeature%5D+`;
const GITHUB_DOCS = `${GITHUB_REPO}#quick-start`;

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
	const minVersion = "1.110.0";
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

	const issueReporter = new IssueReporter();
	const registry = new ServerRegistry(context.globalState, context.secrets);
	const provider = new LiteLLMChatModelProvider(context.secrets, ua, outputChannel, issueReporter);

	// Wire up multi-server provider
	provider.setServerProvider(() => registry.getServersWithKeys());

	// Migrate legacy single-server config
	registry.migrateLegacy().then((migrated) => {
		if (migrated) {
			outputChannel.appendLine(`[${new Date().toISOString()}] Migrated legacy single-server config to server registry`);
		}
	});

	vscode.lm.registerLanguageModelChatProvider("litellm", provider);

	// Test-only commands — registered in test and development modes, never in production
	if (context.extensionMode !== vscode.ExtensionMode.Production) {
		context.subscriptions.push(
			vscode.commands.registerCommand("litellm._test.setSecrets", async (baseUrl: string, apiKey: string) => {
				await context.secrets.store("litellm.baseUrl", baseUrl);
				await context.secrets.store("litellm.apiKey", apiKey || "");
			}),
			vscode.commands.registerCommand("litellm._test.refreshModels", async () => {
				const infos = await provider.prepareLanguageModelChatInformation(
					{ silent: true },
					new vscode.CancellationTokenSource().token
				);
				return infos.length;
			}),
			vscode.commands.registerCommand(
				"litellm._test.addServer",
				async (label: string, baseUrl: string, apiKey: string) => {
					return registry.addServer(label, baseUrl, apiKey || "");
				}
			),
			vscode.commands.registerCommand("litellm._test.removeServer", async (serverId: string) => {
				await registry.removeServer(serverId);
			}),
			vscode.commands.registerCommand("litellm._test.clearServers", async () => {
				for (const s of registry.getServers()) {
					await registry.removeServer(s.id);
				}
				await context.secrets.delete("litellm.baseUrl");
				await context.secrets.delete("litellm.apiKey");
			}),
			vscode.commands.registerCommand("litellm._test.getServers", () => {
				return registry.getServers();
			})
		);
	}

	// Connection status tracking
	interface ConnectionStatus {
		state: "not-configured" | "loading" | "connected" | "degraded" | "error";
		totalModels?: number;
		serverStatuses?: ServerStatus[];
		error?: string;
		lastChecked?: string;
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
				const count = connectionStatus.totalModels ?? 0;
				const serverCount = connectionStatus.serverStatuses?.length ?? 0;
				const serverText = serverCount > 1 ? ` from ${serverCount} servers` : "";
				statusBarItem.text = `$(check) LiteLLM (${count})`;
				statusBarItem.tooltip = `${count} model${count === 1 ? "" : "s"} available${serverText}\nClick for diagnostics`;
				statusBarItem.backgroundColor = undefined;
				break;
			}
			case "degraded": {
				const count = connectionStatus.totalModels ?? 0;
				const statuses = connectionStatus.serverStatuses ?? [];
				const failedCount = statuses.filter((s) => s.state === "error").length;
				statusBarItem.text = `$(warning) LiteLLM (${count})`;
				statusBarItem.tooltip = `${count} model${count === 1 ? "" : "s"} available\n${failedCount} server${failedCount === 1 ? "" : "s"} unreachable\nClick for diagnostics`;
				statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
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

	// Status callback from provider
	provider.setStatusCallback((aggStatus: AggregatedStatus) => {
		const now = new Date().toISOString();
		const { serverStatuses, totalModels } = aggStatus;

		if (serverStatuses.length === 0) {
			outputChannel.appendLine(`[${now}] No servers configured`);
			updateStatusBar({ state: "not-configured", lastChecked: now });
			return;
		}

		const okCount = serverStatuses.filter((s) => s.state === "ok").length;
		const errCount = serverStatuses.filter((s) => s.state === "error").length;

		if (okCount === 0) {
			const firstError = serverStatuses.find((s) => s.error)?.error ?? "All servers failed";
			outputChannel.appendLine(`[${now}] All servers failed: ${firstError}`);
			updateStatusBar({
				state: "error",
				error: firstError,
				serverStatuses,
				totalModels: 0,
				lastChecked: now,
			});
		} else if (errCount > 0) {
			outputChannel.appendLine(`[${now}] Partial success: ${okCount} ok, ${errCount} failed, ${totalModels} models`);
			updateStatusBar({
				state: "degraded",
				serverStatuses,
				totalModels,
				lastChecked: now,
			});
		} else if (totalModels === 0) {
			outputChannel.appendLine(`[${now}] Warning: All servers returned 0 models`);
			updateStatusBar({
				state: "error",
				error: "Servers returned 0 models",
				serverStatuses,
				totalModels: 0,
				lastChecked: now,
			});
		} else {
			outputChannel.appendLine(`[${now}] Successfully fetched ${totalModels} models from ${okCount} server(s)`);
			updateStatusBar({
				state: "connected",
				serverStatuses,
				totalModels,
				lastChecked: now,
			});
		}
	});

	// Show welcome message on first run for unconfigured users
	const hasShownWelcome = context.globalState.get<boolean>("litellm.hasShownWelcome", false);
	if (!hasShownWelcome) {
		const servers = registry.getServers();
		if (servers.length === 0) {
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
								vscode.env.openExternal(vscode.Uri.parse(GITHUB_DOCS));
							}
						});
				}
			});
		}
		context.globalState.update("litellm.hasShownWelcome", true);
	}

	// Server management command (replaces old single-server litellm.manage)
	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.manage", async () => {
			const servers = registry.getServers();

			if (servers.length === 0) {
				// No servers: jump straight to add flow
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

	// Test connection command
	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.testConnection", async () => {
			const servers = registry.getServers();
			if (servers.length === 0) {
				// Fallback: check legacy config
				const baseUrl = await context.secrets.get("litellm.baseUrl");
				if (!baseUrl) {
					vscode.window.showErrorMessage("LiteLLM: No servers configured. Please run 'Manage LiteLLM Provider' first.");
					return;
				}
			}

			outputChannel.appendLine(`\n[${new Date().toISOString()}] Testing connection to all servers...`);
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
					outputChannel.appendLine(`[${new Date().toISOString()}] WARNING: No models returned`);
					vscode.window
						.showWarningMessage(
							`LiteLLM: Connected but no models returned. Check your LiteLLM proxy configuration.`,
							"View Output",
							"Reconfigure",
							"Report Issue"
						)
						.then((choice) => {
							if (choice === "View Output") {
								outputChannel.show();
							} else if (choice === "Reconfigure") {
								vscode.commands.executeCommand("litellm.manage");
							} else if (choice === "Report Issue") {
								vscode.commands.executeCommand("litellm.reportIssue");
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
					.showErrorMessage(`LiteLLM: Connection failed - ${errorMsg}`, "View Output", "Reconfigure", "Report Issue")
					.then((choice) => {
						if (choice === "View Output") {
							outputChannel.show();
						} else if (choice === "Reconfigure") {
							vscode.commands.executeCommand("litellm.manage");
						} else if (choice === "Report Issue") {
							vscode.commands.executeCommand("litellm.reportIssue");
						}
					});
			}
		})
	);

	// Show diagnostics command
	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.showDiagnostics", async () => {
			const servers = registry.getServers();
			const serverStatuses = connectionStatus.serverStatuses ?? [];

			const statusText =
				connectionStatus.state === "not-configured"
					? "Not configured"
					: connectionStatus.state === "loading"
						? "Loading..."
						: connectionStatus.state === "connected"
							? `Connected (${connectionStatus.totalModels ?? 0} models)`
							: connectionStatus.state === "degraded"
								? `Degraded (${connectionStatus.totalModels ?? 0} models, some servers failed)`
								: `Error: ${connectionStatus.error || "Unknown error"}`;

			const lastCheckedText = connectionStatus.lastChecked
				? new Date(connectionStatus.lastChecked).toLocaleString()
				: "Never";

			const lines = [
				"LiteLLM Diagnostics",
				"",
				`Servers Configured: ${servers.length}`,
				`Connection Status: ${statusText}`,
				`Last Checked: ${lastCheckedText}`,
			];

			if (serverStatuses.length > 0) {
				lines.push("");
				lines.push("Server Details:");
				for (const ss of serverStatuses) {
					lines.push(`  ${ss.label}: ${ss.state === "ok" ? `OK (${ss.modelCount} models)` : `Error: ${ss.error}`}`);
					lines.push(`    URL: ${ss.baseUrl}`);
				}
			} else if (servers.length > 0) {
				lines.push("");
				lines.push("Server Details:");
				for (const s of servers) {
					lines.push(`  ${s.label}: ${s.baseUrl}`);
				}
			}

			lines.push("");
			lines.push("Check the LiteLLM output channel for detailed logs.");

			const diagnosticMessage = lines.join("\n");

			const choice = await vscode.window.showInformationMessage(
				diagnosticMessage,
				{ modal: true },
				"View Output",
				"Test Connection",
				"Manage Servers",
				"Report Issue",
				"Help & Feedback"
			);

			if (choice === "View Output") {
				outputChannel.show();
			} else if (choice === "Test Connection") {
				vscode.commands.executeCommand("litellm.testConnection");
			} else if (choice === "Manage Servers") {
				vscode.commands.executeCommand("litellm.manage");
			} else if (choice === "Report Issue") {
				vscode.commands.executeCommand("litellm.reportIssue");
			} else if (choice === "Help & Feedback") {
				vscode.commands.executeCommand("litellm.helpAndFeedback");
			}
		})
	);

	// Help & Feedback command
	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.helpAndFeedback", async () => {
			const choice = await vscode.window.showQuickPick(
				[
					{ label: "$(bug) Report Bug", id: "bug" },
					{ label: "$(lightbulb) Request Feature", id: "feature" },
					{ label: "$(book) Documentation", id: "docs" },
				],
				{ title: "LiteLLM: Help & Feedback", placeHolder: "What would you like to do?" }
			);
			if (!choice) {
				return;
			}
			if (choice.id === "bug") {
				await vscode.commands.executeCommand("litellm.reportIssue");
				return;
			}
			const urls: Record<string, string> = {
				feature: GITHUB_NEW_ISSUE_FEATURE,
				docs: GITHUB_DOCS,
			};
			vscode.env.openExternal(vscode.Uri.parse(urls[choice.id]));
		})
	);

	// Build diagnostics snapshot for issue reporting
	async function buildDiagnosticsSnapshot(): Promise<DiagnosticsSnapshot> {
		const servers = registry.getServers();
		const serversWithKeys = await registry.getServersWithKeys();
		const hasApiKey =
			serversWithKeys.some((s) => s.apiKey.trim().length > 0) || !!(await context.secrets.get("litellm.apiKey"));
		const hasBaseUrl = servers.length > 0 || !!(await context.secrets.get("litellm.baseUrl"));

		return {
			extensionVersion: extVersion,
			vscodeVersion: vscodeVersion,
			platform: `${process.platform} ${process.arch}`,
			connectionState: connectionStatus.state,
			modelCount: connectionStatus.totalModels,
			apiKeyConfigured: hasApiKey,
			baseUrlConfigured: hasBaseUrl,
			latestError: issueReporter.getLatestError(),
			recentLogs: issueReporter.getRecentLogs(),
		};
	}

	// Report Issue command
	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.reportIssue", async () => {
			const snapshot = await buildDiagnosticsSnapshot();
			await issueReporter.openIssue(snapshot);
		})
	);
}

async function addServerFlow(registry: ServerRegistry, outputChannel: vscode.OutputChannel): Promise<boolean> {
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

	await registry.addServer(label.trim(), baseUrl.trim(), apiKey.trim());
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

async function manageServerFlow(
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

		await registry.updateServer(serverId, label.trim(), baseUrl.trim(), apiKey.trim());
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
		// Test all servers (individual server test would require refactoring provider)
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

export function deactivate() {}
