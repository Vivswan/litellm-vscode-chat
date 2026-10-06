/**
 * Report Anyway is always one click, and the gate itself remembers nothing - rerunning the command re-offers. Every
 * entry point funnels through the one registered command, so a toast that already offered Troubleshooting Docs gets the
 * offer again on purpose: this is the last defense before a public issue.
 */

import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import { thrownErrorDisplayText } from "../../provider/transport/errorMapping";
import type { SetupHintKind } from "../../shared/errorClassification";
import { failureClassification } from "../../shared/failureCause";
import { isHiddenGroupServerStatus } from "../../shared/servers";
import { SETUP_HINT_DOCS_URLS } from "../../shared/util/links";
import {
	configureNowLabel,
	type MessageAction,
	reconfigureAction,
	showActionableMessage,
	testConnectionAction,
	troubleshootingDocsAction,
} from "./notifier";
import type { ConnectionStatus } from "./status";

export type SetupProblem = SetupHintKind | "not-configured" | "hidden-groups";

/**
 * The gate's verdict, read from the CURRENT connection status only - never from the issue reporter's historical
 * latestError, which is never cleared, so a healthy user must not be gated by an old failure. One staleness window is
 * accepted: at cold start the status is last session's restored verdict until the first refresh, so a since-fixed setup
 * problem can gate once more.
 *
 *   An error status without a setup hint -> is treated as a real bug and goes straight to GitHub
 *   hidden groups WHOLLY explain it -> that state is user-chosen configuration (an entry removed, or pointed at
 *                                      another URL)
 *   the server that answered empty may be a real bug -> A zero-model state a hidden group only partly explains never
 *                                                       gates
 */
export function detectSetupProblem(status: ConnectionStatus): SetupProblem | undefined {
	switch (status.state) {
		case "not-configured":
			return "not-configured";
		case "error":
			return failureClassification(status.cause)?.setupHint;
		case "connected": {
			const whollyExplainedByHidden =
				status.serverStatuses.some(isHiddenGroupServerStatus) &&
				status.serverStatuses.every(
					(server) => isHiddenGroupServerStatus(server) || (server.state === "error" && server.expected === true)
				);
			return status.totalModels === 0 && whollyExplainedByHidden ? "hidden-groups" : undefined;
		}
		default:
			return undefined;
	}
}

function gateMessage(problem: SetupProblem): string {
	switch (problem) {
		case "not-configured":
			return l10n.t(
				"LiteLLM: No server is configured yet - the issue reporter is for bugs, and setup help is faster in the dashboard."
			);
		case "hidden-groups":
			return l10n.t(
				"LiteLLM: This looks like a setup state, not a bug (a server hidden by your configuration - removed here, or its entry pointed at another URL - answers with no models). The dashboard's server list shows why and what to do next, faster than a GitHub issue."
			);
		case "proxy-not-running":
			return l10n.t(
				"LiteLLM: This looks like a setup problem (nothing is answering at the configured address). The troubleshooting guide usually resolves it faster than a GitHub issue."
			);
		case "configure-api-key":
			return l10n.t(
				"LiteLLM: This looks like a setup problem (the server rejected the API key). The troubleshooting guide usually resolves it faster than a GitHub issue."
			);
		case "check-base-url":
			return l10n.t(
				"LiteLLM: This looks like a setup problem (the server answered 404 at the configured base URL). The troubleshooting guide usually resolves it faster than a GitHub issue."
			);
		case "use-bare-localhost":
			return l10n.t(
				"LiteLLM: This looks like a setup problem (the configured host is a subdomain of localhost, which usually does not resolve - plain localhost does). The troubleshooting guide usually resolves it faster than a GitHub issue."
			);
	}
}

/**
 * Non-modal: only Report Anyway opens an issue, with the snapshot the command already built, so what gets reported is
 * what the gate judged. Callers must not await this from a serialized message chain (runReportIssue documents why it
 * voids the returned promise); because of that void, a failing report must surface here rather than die as an unhandled
 * rejection.
 */
export async function showSetupProblemGate(problem: SetupProblem, reportAnyway: () => Promise<void>): Promise<void> {
	const reportAnywayAction: MessageAction = {
		label: l10n.t("Report Anyway"),
		run: async () => {
			try {
				await reportAnyway();
			} catch (error) {
				const detail = thrownErrorDisplayText(error);
				void vscode.window.showErrorMessage(l10n.t("LiteLLM: Could not open the issue report - {0}", detail));
			}
		},
	};
	const actions =
		problem === "not-configured"
			? [reconfigureAction(configureNowLabel()), reportAnywayAction]
			: problem === "hidden-groups"
				? //   No docs section or connection test fixes the user's own configuration -> the dashboard's Servers
					//       view shows the hidden group with its cause
					[reconfigureAction(l10n.t("Open Dashboard")), reportAnywayAction]
				: [troubleshootingDocsAction(SETUP_HINT_DOCS_URLS[problem]), testConnectionAction(), reportAnywayAction];
	await showActionableMessage("warning", gateMessage(problem), actions);
}
