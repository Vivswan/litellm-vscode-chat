import * as vscode from "vscode";
import type { DiagnosticsSnapshot, IssueReporter } from "../issueReporter";
import { isGroupClientId } from "../provider/groupModels";
import type { ServerStatus } from "../shared/servers";
import type { ServerRegistry } from "./serverRegistry";
import type { ConnectionStatus } from "./status";

/**
 * Key presence for VS Code-managed group servers, read off their observed
 * statuses: a status entry proves reachability, not key presence, so the
 * answer is "unknown" unless the entries carry an explicit hasApiKey verdict.
 * "unknown" also covers nothing-observed, because native groups may exist
 * that simply have not reported yet.
 */
function observedKeyPresence(groupStatuses: readonly ServerStatus[]): boolean | "unknown" {
	if (groupStatuses.some((s) => s.hasApiKey === true)) {
		return true;
	}
	if (groupStatuses.length > 0 && groupStatuses.every((s) => s.hasApiKey === false)) {
		return false;
	}
	return "unknown";
}

export async function buildDiagnosticsSnapshot(
	registry: ServerRegistry,
	connectionStatus: ConnectionStatus,
	extVersion: string,
	vscodeVersion: string,
	issueReporter: IssueReporter
): Promise<DiagnosticsSnapshot> {
	const servers = registry.getServers();
	const serversWithKeys = await registry.getServersWithKeys();
	// VS Code-managed groups exist regardless of the migration flag (fresh
	// installs never set it), so configuration presence is the union of the
	// registry and every observed group status. Persisted statuses are only
	// loosely validated, so element access must survive junk entries.
	const groupStatuses = (connectionStatus.serverStatuses ?? []).filter((s) =>
		isGroupClientId((s as Partial<ServerStatus> | null)?.serverId)
	);
	const registryHasKey = serversWithKeys.some((s) => s.apiKey.trim().length > 0);
	const groupKeyPresence = observedKeyPresence(groupStatuses);
	let hasApiKey: boolean | "unknown";
	if (registryHasKey || groupKeyPresence === true) {
		hasApiKey = true;
	} else if (groupKeyPresence === false) {
		hasApiKey = false;
	} else {
		// No group verdict: with only registry servers configured the registry
		// answer is definite; with none, groups may exist unobserved.
		hasApiKey = servers.length > 0 && groupStatuses.length === 0 ? false : "unknown";
	}
	const hasBaseUrl = servers.length > 0 || groupStatuses.length > 0;

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
			// Group servers live host-side and their statuses are the only
			// available census, so the count is the registry plus every distinct
			// observed group.
			const serverCount =
				servers.length +
				serverStatuses.filter((s) => isGroupClientId((s as Partial<ServerStatus> | null)?.serverId)).length;

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
				`Servers Configured: ${serverCount}`,
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
				void vscode.commands.executeCommand("litellm.testConnection");
			} else if (choice === "Manage Servers") {
				void vscode.commands.executeCommand("litellm.manage");
			} else if (choice === "Report Issue") {
				void vscode.commands.executeCommand("litellm.reportIssue");
			} else if (choice === "Help & Feedback") {
				void vscode.commands.executeCommand("litellm.helpAndFeedback");
			}
		})
	);
}
