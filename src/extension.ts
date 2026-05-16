import * as vscode from "vscode";
import { LiteLLMChatModelProvider } from "./provider";
import type { AggregatedStatus } from "./provider";
import { IssueReporter } from "./issueReporter";
import { ServerRegistry } from "./extension/serverRegistry";
import { StatusBarManager } from "./extension/status";
import { registerHelpAndFeedbackCommand, registerTestCommands } from "./extension/commands";
import { registerManageCommand } from "./extension/serverManagement";
import { registerDiagnosticsCommand, buildDiagnosticsSnapshot } from "./extension/diagnostics";

const GITHUB_DOCS = "https://github.com/Vivswan/litellm-vscode-chat#quick-start";

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
		return;
	}

	const ext = vscode.extensions.getExtension("vivswan.litellm-vscode-chat");
	const extVersion = ext?.packageJSON?.version ?? "unknown";
	const vscodeVersion = vscode.version;
	const ua = `litellm-vscode-chat/${extVersion} VSCode/${vscodeVersion}`;

	const outputChannel = vscode.window.createOutputChannel("LiteLLM");
	context.subscriptions.push(outputChannel);
	outputChannel.appendLine(`LiteLLM Extension activated (v${extVersion})`);

	const issueReporter = new IssueReporter();
	const registry = new ServerRegistry(context.globalState, context.secrets);
	const provider = new LiteLLMChatModelProvider(context.secrets, ua, outputChannel, issueReporter);

	provider.setServerProvider(() => registry.getServersWithKeys());

	registry.migrateLegacy().then((migrated) => {
		if (migrated) {
			outputChannel.appendLine(`[${new Date().toISOString()}] Migrated legacy single-server config to server registry`);
		}
	});

	vscode.lm.registerLanguageModelChatProvider("litellm", provider);

	// Test-only commands
	registerTestCommands(context, registry, provider);

	// Status bar
	const statusBar = new StatusBarManager(context, outputChannel);
	provider.setStatusCallback((aggStatus: AggregatedStatus) => {
		statusBar.handleAggregatedStatus(aggStatus);
	});

	// Welcome message
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

	// Server management command
	registerManageCommand(context, registry, outputChannel);

	// Test connection command
	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.testConnection", async () => {
			const servers = registry.getServers();
			if (servers.length === 0) {
				const baseUrl = await context.secrets.get("litellm.baseUrl");
				if (!baseUrl) {
					vscode.window.showErrorMessage("LiteLLM: No servers configured. Please run 'Manage LiteLLM Provider' first.");
					return;
				}
			}

			outputChannel.appendLine(`\n[${new Date().toISOString()}] Testing connection to all servers...`);
			outputChannel.show(true);

			try {
				await statusBar.updateStatusBar({ state: "loading" });

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

	// Diagnostics command
	registerDiagnosticsCommand(context, registry, () => statusBar.connectionStatus, outputChannel);

	// Help & Feedback command
	registerHelpAndFeedbackCommand(context);

	// Report Issue command
	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.reportIssue", async () => {
			const snapshot = await buildDiagnosticsSnapshot(
				registry,
				context,
				statusBar.connectionStatus,
				extVersion,
				vscodeVersion,
				issueReporter
			);
			await issueReporter.openIssue(snapshot);
		})
	);
}

export function deactivate() {}
