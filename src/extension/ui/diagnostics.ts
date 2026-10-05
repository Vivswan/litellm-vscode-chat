import { isGroupClientId } from "../../provider/catalog/groupModels";
import { FEATURE_IDS, isFeatureModelId } from "../../shared/config/settingSpec";
import { getFeatureModelRef, isFeatureEnabled } from "../../shared/config/settings";
import type { ServerStatus } from "../../shared/servers";
import { recordFromKeys } from "../../shared/util/json";
import { mcpEnabledEntryCount } from "../features/mcp/wiring";
import { sameGroupIdentity } from "../servers/groupRemovals";
import type { DeclaredServerView } from "../servers/serverSync";
import type { DiagnosticsSnapshot, IssueReporter } from "./issueReporter";
import type { ConnectionStatus } from "./status";
import { statusServerStatuses, statusTotalModels } from "./status";

/**
 * Whether authentication is configured, from the two readings the owner publishes: the engine's view of each declared
 * entry (credentials, read by the last sync pass), or a group's report (hasApiKey, the same reading over the group).
 * A secret the pass could not read is invisible here, so only the groups' reports may deny one, and the deny needs
 * EVERY declared entry's own report: the groups publish one report at a time, so an observed window can be a partial
 * one.
 */
function keyPresence(
	declared: readonly DeclaredServerView[],
	groupStatuses: readonly ServerStatus[]
): boolean | "unknown" {
	if (groupStatuses.some((s) => s.hasApiKey === true) || declared.some((view) => view.credentials?.present === true)) {
		return true;
	}
	const reported = (view: DeclaredServerView) =>
		groupStatuses.some(
			(s) => s.entryLabel !== undefined && sameGroupIdentity({ label: s.entryLabel, baseUrl: s.baseUrl }, view)
		);
	if (groupStatuses.length > 0 && groupStatuses.every((s) => s.hasApiKey === false) && declared.every(reported)) {
		return false;
	}
	return "unknown";
}

/**
 * `declared` is the declared set the dashboard draws (DashboardController.declaredServers: the engine's views once a
 * pass has run, the settings fallback before), the one reading of the servers setting this snapshot has; it parses
 * nothing itself.
 */
export function buildDiagnosticsSnapshot(
	connectionStatus: ConnectionStatus,
	declared: readonly DeclaredServerView[],
	extVersion: string,
	vscodeVersion: string,
	issueReporter: IssueReporter
): DiagnosticsSnapshot {
	// Configuration presence reads the declared views beside the observed group statuses: the statuses empty out while
	// a Test Connection pass re-resolves the groups, and a report built in that window denied a configured server
	// (#389). isGroupClientId classifies the serverId because OLD persisted entries predate the group-entry kind.
	const groupStatuses = statusServerStatuses(connectionStatus).filter((s) => isGroupClientId(s.serverId));

	return {
		extensionVersion: extVersion,
		vscodeVersion: vscodeVersion,
		platform: `${process.platform} ${process.arch}`,
		connectionState: connectionStatus.state,
		modelCount: statusTotalModels(connectionStatus),
		apiKeyConfigured: keyPresence(declared, groupStatuses),
		baseUrlConfigured: declared.length > 0 || groupStatuses.length > 0,
		// Feature flags only: whether each feature is on and whether a model ref is set - never which model or label.
		featureFlags: recordFromKeys(FEATURE_IDS, (feature) => ({
			enabled: isFeatureEnabled(feature),
			...(isFeatureModelId(feature) ? { modelConfigured: getFeatureModelRef(feature) !== undefined } : {}),
		})),
		// A count of opted-in entries, never their labels or endpoints: the MCP opt-in is a per-entry field, so it has
		// no FeatureId row to ride.
		mcpEntryCount: mcpEnabledEntryCount(),
		latestError: issueReporter.getLatestError(),
		recentLogs: issueReporter.getRecentLogs(),
	};
}
