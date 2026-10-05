import { isGroupClientId } from "../../provider/catalog/groupModels";
import { FEATURE_IDS, isFeatureModelId } from "../../shared/config/settingSpec";
import { getFeatureModelRef, isFeatureEnabled } from "../../shared/config/settings";
import { entryUsesSecretField } from "../../shared/serverEntry";
import type { ServerStatus } from "../../shared/servers";
import { normalizeBaseUrl } from "../../shared/util/baseUrl";
import { recordFromKeys } from "../../shared/util/json";
import { mcpEnabledEntryCount } from "../features/mcp/wiring";
import { inlineSecretValues } from "../servers/serverSync/secrets";
import type { DeclaredServer } from "../servers/serverSync/setting";
import { currentDeclaredServers } from "../servers/serverSync/vscodeEnv";
import type { DiagnosticsSnapshot, IssueReporter } from "./issueReporter";
import type { ConnectionStatus } from "./status";
import { statusServerStatuses, statusTotalModels } from "./status";

/**
 * Whether an API key or OAuth credentials are configured, from what a synchronous read can see: an inline key or a
 * declared OAuth unit, or a group's report (statusReporting.ts counts OAuth as a key too; a virtual key alone counts in
 * neither). A key resting in SecretStorage is invisible here, so only the groups' reports may deny one, and the deny
 * needs EVERY declared entry's own report: the groups publish one report at a time, so an observed window can be a
 * partial one.
 */
function keyPresence(declared: readonly DeclaredServer[], groupStatuses: readonly ServerStatus[]): boolean | "unknown" {
	if (
		groupStatuses.some((s) => s.hasApiKey === true) ||
		declared.some(
			(entry) => inlineSecretValues(entry).apiKey !== undefined || entryUsesSecretField(entry, "oauthClientSecret")
		)
	) {
		return true;
	}
	const reported = (entry: DeclaredServer) =>
		groupStatuses.some(
			(s) => s.entryLabel === entry.label && normalizeBaseUrl(s.baseUrl) === normalizeBaseUrl(entry.baseUrl)
		);
	if (groupStatuses.length > 0 && groupStatuses.every((s) => s.hasApiKey === false) && declared.every(reported)) {
		return false;
	}
	return "unknown";
}

export function buildDiagnosticsSnapshot(
	connectionStatus: ConnectionStatus,
	extVersion: string,
	vscodeVersion: string,
	issueReporter: IssueReporter
): DiagnosticsSnapshot {
	// Configuration presence reads the declared setting beside the observed group statuses: the statuses empty out
	// while a Test Connection pass re-resolves the groups, and a report built in that window denied a configured server
	// (#389). isGroupClientId classifies the serverId because OLD persisted entries predate the group-entry kind.
	const declared = currentDeclaredServers();
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
