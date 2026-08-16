/**
 * The last-mile vscode wiring for usage polling: the real UsagePollerEnv over
 * workspace configuration and SecretStorage, plus the Refresh Usage Now palette
 * command.
 */

import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import { CMD } from "../../../shared/config/commandIds";
import { CONFIG_SECTION } from "../../../shared/config/settingSpec";
import {
	getUsageAlertThresholds,
	getUsageInitialRefreshDelayMs,
	getUsagePollIntervalMs,
	getUsageServersChangeRefreshDelayMs,
	SERVERS_SETTING_KEY,
} from "../../../shared/config/settings";
import type { Logger } from "../../../shared/logger";
import { readServerSecrets } from "../serverSync/secrets";
import type { UsagePollerEnv, UsageRefreshOutcome } from "./poller";
import { usageRefreshFailureSummary } from "./poller";
import { UsageClient } from "./spendClient";

/** The real environment: workspace configuration, SecretStorage, and the fetch-backed spend client. */
export function createUsagePollerEnv(
	context: vscode.ExtensionContext,
	logger: Logger,
	userAgent: string
): UsagePollerEnv {
	const log = (message: string, data?: unknown) => logger.log(message, data);
	// The setting readers run on every pass, so their invalid-configuration
	// warnings dedup per rendered line for the session: a standing
	// misconfiguration logs once, not once per poll - the log buffer feeds public
	// issue reports and holds a bounded number of lines. A read that warns
	// differently logs again.
	const seenSettingWarnings = new Set<string>();
	const settingLog = (message: string, data?: unknown) => {
		const rendered = `${message}:${JSON.stringify(data) ?? ""}`;
		if (seenSettingWarnings.has(rendered)) {
			return;
		}
		seenSettingWarnings.add(rendered);
		log(message, data);
	};
	return {
		readServersSetting: () => vscode.workspace.getConfiguration(CONFIG_SECTION).get(SERVERS_SETTING_KEY),
		readSecrets: (label) => readServerSecrets(context.secrets, label),
		client: new UsageClient({ userAgent, log }),
		pollIntervalMs: () => getUsagePollIntervalMs(settingLog),
		initialRefreshDelayMs: () => getUsageInitialRefreshDelayMs(settingLog),
		serversChangeRefreshDelayMs: () => getUsageServersChangeRefreshDelayMs(settingLog),
		alertThresholds: () => getUsageAlertThresholds(settingLog),
		log,
	};
}

/**
 * Acknowledge an explicit, user-initiated refresh in which no server returned
 * any usage data: one warning toast, headline plus the per-server template
 * detail (labels, endpoint paths, status numbers - never response text).
 * Partial failures and disposal (outcome undefined) stay silent. Never logged:
 * the poller's one-classification-per-transition discipline already covers the
 * log.
 */
export function notifyUsageRefreshFailure(outcome: UsageRefreshOutcome | undefined): void {
	if (outcome === undefined) {
		return;
	}
	const summary = usageRefreshFailureSummary(outcome);
	if (summary === undefined) {
		return;
	}
	void vscode.window.showWarningMessage(
		l10n.t("LiteLLM: {0}", `${l10n.t("Usage refresh failed - no server returned usage data.")} ${summary}`)
	);
}

/** The palette command: one immediate, availability-re-probing refresh; works with polling off. */
export function registerRefreshUsageCommand(
	context: vscode.ExtensionContext,
	refreshNow: () => Promise<UsageRefreshOutcome | undefined>
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(CMD.refreshUsage, async () => {
			notifyUsageRefreshFailure(await refreshNow());
		})
	);
}
