import * as vscode from "vscode";
import {
	registerHelpAndFeedbackCommand,
	registerReportIssueCommand,
	registerTestCommands,
	registerTestConnectionCommand,
} from "./extension/commands";
import { registerDiagnosticsCommand } from "./extension/diagnostics";
import { createConfigurationPrompt, Notifier, reconfigureAction, showActionableMessage } from "./extension/notifier";
import { registerManageCommand } from "./extension/serverManagement";
import { ServerRegistry } from "./extension/serverRegistry";
import { StatusBarManager } from "./extension/status";
import { createIssueReporterEnv, IssueReporter } from "./issueReporter";
import { LiteLLMChatModelProvider } from "./provider";
import { Logger } from "./shared/logger";
import type { AggregatedStatus } from "./shared/servers";
import { HAS_SHOWN_WELCOME_KEY } from "./shared/storageKeys";

const GITHUB_DOCS = "https://github.com/Vivswan/litellm-vscode-chat#quick-start";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const extVersion: string = context.extension.packageJSON?.version ?? "unknown";
	const vscodeVersion = vscode.version;
	const ua = `litellm-vscode-chat/${extVersion} VSCode/${vscodeVersion}`;

	const outputChannel = vscode.window.createOutputChannel("LiteLLM", { log: true });
	context.subscriptions.push(outputChannel);

	const issueReporter = new IssueReporter(createIssueReporterEnv(context.globalStorageUri));
	const logger = new Logger(outputChannel, issueReporter);
	logger.log(`LiteLLM Extension activated (v${extVersion})`);
	const registry = new ServerRegistry(context.globalState, context.secrets);
	const provider = new LiteLLMChatModelProvider(ua, logger);

	provider.setServerProvider(() => registry.getServersWithKeys());
	provider.setConfigurationPrompt(createConfigurationPrompt());

	// The provider must not see a half-migrated registry, so migration completes before registration.
	try {
		const migrated = await registry.migrateLegacy();
		if (migrated) {
			logger.log("Migrated legacy single-server config to server registry");
		}
	} catch (error) {
		logger.error("Legacy config migration failed", error);
	}

	vscode.lm.registerLanguageModelChatProvider("litellm", provider);

	// Test-only commands
	registerTestCommands(context, registry, provider);

	// Status bar and refresh notifications share the same status callback,
	// isolated so one consumer's failure cannot starve the other.
	const statusBar = new StatusBarManager(context, logger);
	const notifier = new Notifier();
	provider.setStatusCallback((aggStatus: AggregatedStatus) => {
		try {
			statusBar.handleAggregatedStatus(aggStatus);
		} catch (error) {
			logger.error("Status bar update failed", error);
		}
		try {
			notifier.handleAggregatedStatus(aggStatus);
		} catch (error) {
			logger.error("Notifier update failed", error);
		}
	});

	// Welcome message
	const hasShownWelcome = context.globalState.get<boolean>(HAS_SHOWN_WELCOME_KEY, false);
	if (!hasShownWelcome && registry.getServers().length === 0) {
		showActionableMessage("info", "Welcome to LiteLLM! Connect to 100+ LLMs in VS Code.", [
			reconfigureAction("Configure Now"),
			{ label: "Documentation", run: () => void vscode.env.openExternal(vscode.Uri.parse(GITHUB_DOCS)) },
		]).catch((error) => {
			logger.error("Welcome message failed", error);
		});
	}
	if (!hasShownWelcome) {
		await context.globalState.update(HAS_SHOWN_WELCOME_KEY, true);
	}

	// Server management command
	registerManageCommand(context, registry, logger);

	// Test connection command
	registerTestConnectionCommand(context, registry, provider, statusBar, outputChannel, logger);

	// Diagnostics command
	registerDiagnosticsCommand(context, registry, () => statusBar.connectionStatus, outputChannel);

	// Help & Feedback command
	registerHelpAndFeedbackCommand(context);

	// Report Issue command
	registerReportIssueCommand(
		context,
		registry,
		() => statusBar.connectionStatus,
		extVersion,
		vscodeVersion,
		issueReporter
	);
}

export function deactivate() {}
