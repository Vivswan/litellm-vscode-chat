import * as vscode from "vscode";
import type { ServerRegistry } from "./serverRegistry";
import type { IssueReporter, DiagnosticsSnapshot } from "../issueReporter";
import type { ConnectionStatus } from "./status";

export async function buildDiagnosticsSnapshot(
	registry: ServerRegistry,
	context: vscode.ExtensionContext,
	connectionStatus: ConnectionStatus,
	extVersion: string,
	vscodeVersion: string,
	issueReporter: IssueReporter
): Promise<DiagnosticsSnapshot> {
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

export function registerDiagnosticsCommand(
	context: vscode.ExtensionContext,
	registry: ServerRegistry,
	getConnectionStatus: () => ConnectionStatus,
	outputChannel: vscode.OutputChannel
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand("litellm.showDiagnostics", async () => {
			const servers = registry.getServers();
			const connectionStatus = getConnectionStatus();
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
}
