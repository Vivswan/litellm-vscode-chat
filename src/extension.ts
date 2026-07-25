import * as vscode from "vscode";
import { registerHelpAndFeedbackCommand, registerTestCommands } from "./extension/commands";
import { buildDiagnosticsSnapshot, registerDiagnosticsCommand } from "./extension/diagnostics";
import { registerManageCommand } from "./extension/serverManagement";
import { ServerRegistry } from "./extension/serverRegistry";
import { StatusBarManager } from "./extension/status";
import { createIssueReporterEnv, IssueReporter } from "./issueReporter";
import type { AggregatedStatus } from "./provider";
import { LiteLLMChatModelProvider } from "./provider";
import { HAS_SHOWN_WELCOME_KEY } from "./shared/storageKeys";

const GITHUB_DOCS = "https://github.com/Vivswan/litellm-vscode-chat#quick-start";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const extVersion: string = context.extension.packageJSON?.version ?? "unknown";
	const vscodeVersion = vscode.version;
	const ua = `litellm-vscode-chat/${extVersion} VSCode/${vscodeVersion}`;

	const outputChannel = vscode.window.createOutputChannel("LiteLLM");
	context.subscriptions.push(outputChannel);
	outputChannel.appendLine(`LiteLLM Extension activated (v${extVersion})`);

	const issueReporter = new IssueReporter(createIssueReporterEnv(context.globalStorageUri));
	const registry = new ServerRegistry(context.globalState, context.secrets);
	const provider = new LiteLLMChatModelProvider(ua, outputChannel, issueReporter);

	provider.setServerProvider(() => registry.getServersWithKeys());

	// The provider must not see a half-migrated registry, so migration completes before registration.
	try {
		const migrated = await registry.migrateLegacy();
		if (migrated) {
			outputChannel.appendLine(`[${new Date().toISOString()}] Migrated legacy single-server config to server registry`);
		}
	} catch (error) {
		outputChannel.appendLine(`[${new Date().toISOString()}] ERROR: Legacy config migration failed: ${String(error)}`);
	}

	vscode.lm.registerLanguageModelChatProvider("litellm", provider);

	// Test-only commands
	registerTestCommands(context, registry, provider);

	// Status bar
	const statusBar = new StatusBarManager(context, outputChannel);
	provider.setStatusCallback((aggStatus: AggregatedStatus) => {
		statusBar.handleAggregatedStatus(aggStatus);
	});

	// Welcome message
	const hasShownWelcome = context.globalState.get<boolean>(HAS_SHOWN_WELCOME_KEY, false);
	if (!hasShownWelcome && registry.getServers().length === 0) {
		vscode.window
			.showInformationMessage("Welcome to LiteLLM! Connect to 100+ LLMs in VS Code.", "Configure Now", "Documentation")
			.then(
				(choice) => {
					if (choice === "Configure Now") {
						vscode.commands.executeCommand("litellm.manage");
					} else if (choice === "Documentation") {
						vscode.env.openExternal(vscode.Uri.parse(GITHUB_DOCS));
					}
				},
				(error) => {
					outputChannel.appendLine(`[${new Date().toISOString()}] ERROR: Welcome message failed: ${String(error)}`);
				}
			);
	}
	if (!hasShownWelcome) {
		await context.globalState.update(HAS_SHOWN_WELCOME_KEY, true);
	}

	// Server management command
	registerManageCommand(context, registry, outputChannel);

	// Test connection command
	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.testConnection", async () => {
			if (registry.getServers().length === 0) {
				vscode.window.showErrorMessage("LiteLLM: No servers configured. Please run 'Manage LiteLLM Provider' first.");
				return;
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
