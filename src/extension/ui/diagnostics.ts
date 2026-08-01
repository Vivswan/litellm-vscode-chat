/**
 * The environment-and-connection snapshot the issue reporter attaches to
 * GitHub issue bodies. The interactive diagnostics surface is the
 * dashboard's Diagnostics tab (litellm.showDiagnostics deep-links to it; see
 * extension/dashboard/panel.ts).
 */

import { isGroupClientId } from "../../provider/catalog/groupModels";
import type { ServerStatus } from "../../shared/servers";
import type { ServerRegistry } from "../servers/serverRegistry";
import type { DiagnosticsSnapshot, IssueReporter } from "./issueReporter";
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
