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
import { readServerSecretsRecord } from "../serverSync/secrets";
import type { UsagePollerEnv, UsageRefreshOutcome } from "./poller";
import { usageRefreshFailureSummary } from "./poller";
import { UsageClient } from "./spendClient";

export function createUsagePollerEnv(
	context: vscode.ExtensionContext,
	logger: Logger,
	userAgent: string
): UsagePollerEnv {
	const log = (message: string, data?: unknown) => logger.log(message, data);
	// A read that warns differently logs again.
	//
	//   The setting readers run on every pass
	//     -> their invalid-configuration warnings dedup per rendered line for the session
	//   the log buffer -> feeds public issue reports and holds a bounded number of lines
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
		readSecrets: (label) => readServerSecretsRecord(context.secrets, label),
		client: new UsageClient({ userAgent, log }),
		pollIntervalMs: () => getUsagePollIntervalMs(settingLog),
		initialRefreshDelayMs: () => getUsageInitialRefreshDelayMs(settingLog),
		serversChangeRefreshDelayMs: () => getUsageServersChangeRefreshDelayMs(settingLog),
		alertThresholds: () => getUsageAlertThresholds(settingLog),
		log,
	};
}

/**
 * Partial failures and disposal (outcome undefined) stay silent. Never logged: the poller's
 * one-classification-per-transition discipline already covers the log.
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
