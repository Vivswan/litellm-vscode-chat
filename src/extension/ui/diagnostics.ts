/**
 * The environment-and-connection snapshot the issue reporter attaches to GitHub
 * issue bodies. The interactive surface is the dashboard's Diagnostics tab.
 */

import { isGroupClientId } from "../../provider/catalog/groupModels";
import { FEATURE_IDS, isFeatureModelId } from "../../shared/config/settingSpec";
import { getFeatureModelRef, isFeatureEnabled } from "../../shared/config/settings";
import type { ServerStatus } from "../../shared/servers";
import { recordFromKeys } from "../../shared/util/json";
import { mcpEnabledEntryCount } from "../features/mcp/wiring";
import type { ServerRegistry } from "../servers/serverRegistry";
import type { DiagnosticsSnapshot, IssueReporter } from "./issueReporter";
import type { ConnectionStatus } from "./status";
import { statusServerStatuses, statusTotalModels } from "./status";

/**
 * Key presence for VS Code-managed group servers, read off their observed
 * statuses: a status entry proves reachability, not key presence, so the answer
 * is "unknown" unless the entries carry an explicit hasApiKey verdict, and
 * nothing-observed is "unknown" too (native groups may not have reported yet).
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
	// registry and every observed group status. isGroupClientId classifies the
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
		// Feature flags only: whether each feature is on and whether a model
		// ref is set - never which model or label. One loop over FEATURE_IDS, so
		// a new feature joins the report by joining the vocabulary.
		featureFlags: recordFromKeys(FEATURE_IDS, (feature) => ({
			enabled: isFeatureEnabled(feature),
			...(isFeatureModelId(feature) ? { modelConfigured: getFeatureModelRef(feature) !== undefined } : {}),
		})),
		// A count of opted-in entries, never their labels or endpoints: the MCP
		// opt-in is a per-entry field, so it has no FeatureId row to ride.
		mcpEntryCount: mcpEnabledEntryCount(),
		latestError: issueReporter.getLatestError(),
		recentLogs: issueReporter.getRecentLogs(),
	};
}
