import * as vscode from "vscode";
import type { ServerModelsSnapshot } from "../provider";
import { isGroupClientId } from "../provider/catalog/groupModels";
import { CMD, INTERNAL_CMD } from "../shared/config/commandIds";
import { CONFIG_SECTION } from "../shared/config/settingSpec";
import { SERVERS_SETTING_KEY } from "../shared/config/settings";
import type { SecretFieldId, SecretLocation } from "../shared/serverEntry";
import { pickNonSecretOptionalFields, SECRET_FIELD_IDS } from "../shared/serverEntry";
import type { ServerConfig, ServerStatus } from "../shared/servers";
import { normalizeBaseUrl } from "../shared/util/baseUrl";
import type { DashboardServer } from "./dashboard/protocol";
import { classifyOverall } from "./dashboard/protocol";
import { buildDashboardState } from "./dashboard/state";
import type { DiagnosticsSnapshot, IssueReporter } from "./issueReporter";
import type { ServerRegistry } from "./serverRegistry";
import type { DeclaredServerView } from "./serverSync";
import { inlineSecretValues, parseServersSetting } from "./serverSync";
import type { ConnectionStatus } from "./status";
import { statusServerStatuses, statusTotalModels } from "./status";

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
	// registry and every observed group status. The persisted-status trust
	// boundary lives in the status bar's normalizing restore, so the elements
	// here are real ServerStatus values; isGroupClientId still classifies the
	// serverId because OLD persisted entries predate the group-entry kind.
	const groupStatuses = statusServerStatuses(connectionStatus).filter((s) => isGroupClientId(s.serverId));
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
		modelCount: statusTotalModels(connectionStatus),
		apiKeyConfigured: hasApiKey,
		baseUrlConfigured: hasBaseUrl,
		latestError: issueReporter.getLatestError(),
		recentLogs: issueReporter.getRecentLogs(),
	};
}

/**
 * The dialog's overall verdict. The classification is shared with the
 * dashboard hero (classifyOverall in the protocol module), so the two cannot
 * drift; this only renders each verdict as the dialog's line, with model
 * counts and the first error.
 */
function overallStatusText(servers: readonly DashboardServer[], modelCount: number): string {
	switch (classifyOverall(servers)) {
		case "not-configured":
			return "Not configured";
		case "error": {
			// The verdict guarantees at least one error-state server; the fallback
			// only satisfies the type checker, which cannot see that.
			const firstError = servers.find((server) => server.state === "error")?.error ?? "Unknown error";
			return `Error: ${firstError}`;
		}
		case "degraded":
			return `Degraded (${modelCount} models, some servers failed)`;
		case "waiting":
			return "Waiting for first sync";
		case "connected":
			return `Connected (${modelCount} models)`;
	}
}

function serverOutcomeText(server: DashboardServer): string {
	switch (server.state) {
		case "ok":
			// A reachable server can still carry an error: a declared entry whose
			// group upsert failed while an already-live group keeps serving.
			return server.error !== undefined
				? `OK (${server.modelCount} models) - ${server.error}`
				: `OK (${server.modelCount} models)`;
		case "error":
			return `Error: ${server.error}`;
		case "unchecked":
			return "Not checked yet";
	}
}

/**
 * The dialog body, built from the merged declared-plus-live server rows so
 * its numbers always agree with the dashboard hero. The legacy registry
 * (test mode and pre-migration installs) gets its own line only while it
 * still holds entries.
 */
function buildDiagnosticsMessage(
	servers: readonly DashboardServer[],
	modelCount: number,
	legacyServers: readonly ServerConfig[]
): string {
	const checkedTimes = servers
		.map((server) => (server.lastChecked === undefined ? Number.NaN : new Date(server.lastChecked).getTime()))
		.filter((time) => !Number.isNaN(time));
	const lastCheckedText = checkedTimes.length > 0 ? new Date(Math.max(...checkedTimes)).toLocaleString() : "Never";

	const lines = [
		"LiteLLM Diagnostics",
		"",
		`Servers Configured: ${servers.length}`,
		`Connection Status: ${overallStatusText(servers, modelCount)}`,
		`Last Checked: ${lastCheckedText}`,
	];

	// After a sweep, a legacy registry server can also surface as an external
	// snapshot row inside `servers` (same base URL). Only the registry servers
	// with no row of their own earn the extra line, so the same server is never
	// counted twice.
	const shownBaseUrls = new Set(servers.map((server) => normalizeBaseUrl(server.baseUrl)));
	const legacyNotShown = legacyServers.filter((server) => !shownBaseUrls.has(normalizeBaseUrl(server.baseUrl)));
	if (legacyNotShown.length > 0) {
		lines.push(`Legacy Registry Servers: ${legacyNotShown.length}`);
	}

	if (servers.length > 0) {
		lines.push("");
		lines.push("Server Details:");
		for (const server of servers) {
			lines.push(`  ${server.label}: ${serverOutcomeText(server)}`);
			lines.push(`    URL: ${server.baseUrl}`);
		}
	}

	lines.push("");
	lines.push("Check the LiteLLM output channel for detailed logs.");
	return lines.join("\n");
}

/**
 * Pre-migration rendering: with an empty declared/live world, the legacy
 * registry is the only configuration there is. It stays out of the main
 * count (which mirrors the dashboard), but the verdict names it and its
 * rows become the details. Each registry server renders its persisted sweep
 * outcome when the status bar's connection status holds one for its base URL
 * (statuses for servers no longer in the registry are ignored; junk elements
 * never get this far - the status restore drops them), and its configured
 * listing otherwise, so a partial sweep still shows every configured server.
 */
function buildLegacyDiagnosticsMessage(servers: readonly ServerConfig[], status: ConnectionStatus): string {
	const lastCheckedText = status.lastChecked ? new Date(status.lastChecked).toLocaleString() : "Never";
	const lines = [
		"LiteLLM Diagnostics",
		"",
		"Servers Configured: 0",
		`Connection Status: Legacy registry only (${servers.length} ${servers.length === 1 ? "server" : "servers"})`,
		`Last Checked: ${lastCheckedText}`,
		"",
		"Server Details:",
	];
	const statusByUrl = new Map<string, ServerStatus>();
	for (const candidate of statusServerStatuses(status)) {
		if (!statusByUrl.has(normalizeBaseUrl(candidate.baseUrl))) {
			statusByUrl.set(normalizeBaseUrl(candidate.baseUrl), candidate);
		}
	}
	for (const server of servers) {
		const ss = statusByUrl.get(normalizeBaseUrl(server.baseUrl));
		if (ss !== undefined) {
			lines.push(`  ${server.label}: ${ss.state === "ok" ? `OK (${ss.modelCount} models)` : `Error: ${ss.error}`}`);
			lines.push(`    URL: ${server.baseUrl}`);
		} else {
			lines.push(`  ${server.label}: ${server.baseUrl}`);
		}
	}
	lines.push("");
	lines.push("Check the LiteLLM output channel for detailed logs.");
	return lines.join("\n");
}

/**
 * DeclaredServerView equivalents straight from the setting, for the window
 * right after activation when the sync engine's first pass has not landed
 * yet. Secret locations reflect only what the setting itself can prove: an
 * inline value (per the sync engine's own inlineSecretValues rule) reads as
 * "settings", anything else as "none" (a secure blob may exist, but checking
 * it is async and the dialog never shows locations).
 */
function declaredViewsFromSetting(raw: unknown): DeclaredServerView[] {
	return parseServersSetting(raw).entries.map((entry) => {
		const inline = inlineSecretValues(entry);
		const secrets = {} as Record<SecretFieldId, SecretLocation>;
		for (const field of SECRET_FIELD_IDS) {
			secrets[field] = inline[field] !== undefined ? "settings" : "none";
		}
		return { label: entry.label, baseUrl: entry.baseUrl, ...pickNonSecretOptionalFields(entry), secrets };
	});
}

export function registerDiagnosticsCommand(
	context: vscode.ExtensionContext,
	registry: ServerRegistry,
	getSnapshots: () => readonly ServerModelsSnapshot[],
	getDeclared: () => readonly DeclaredServerView[],
	getConnectionStatus: () => ConnectionStatus,
	outputChannel: vscode.OutputChannel
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(CMD.showDiagnostics, async () => {
			// The dialog renders the same DashboardState the dashboard webview
			// renders (declared entries joined with the provider's live status
			// window), so its counts and verdict cannot drift from the hero.
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			// The engine's declared view is authoritative once a pass has run;
			// right after activation it is still empty, so the setting fills in.
			const declared = getDeclared();
			const effectiveDeclared =
				declared.length > 0 ? declared : declaredViewsFromSetting(config.get<unknown>(SERVERS_SETTING_KEY));
			const state = buildDashboardState(
				getSnapshots(),
				{ get: (key) => config.get<unknown>(key), inspect: (key) => config.inspect(key) },
				effectiveDeclared
			);
			const legacyServers = registry.getServers();
			const diagnosticMessage =
				state.servers.length === 0 && legacyServers.length > 0
					? buildLegacyDiagnosticsMessage(legacyServers, getConnectionStatus())
					: buildDiagnosticsMessage(state.servers, state.models.length, legacyServers);

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
				void vscode.commands.executeCommand(CMD.testConnection);
			} else if (choice === "Manage Servers") {
				void vscode.commands.executeCommand(INTERNAL_CMD.manageServers);
			} else if (choice === "Report Issue") {
				void vscode.commands.executeCommand(CMD.reportIssue);
			} else if (choice === "Help & Feedback") {
				void vscode.commands.executeCommand(CMD.helpAndFeedback);
			}
		})
	);
}
