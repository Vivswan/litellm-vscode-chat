/**
 * The Report Issue command's troubleshoot-first gate: setup-shaped
 * diagnostics get one non-modal offer of the faster fix (dashboard, docs,
 * connection test) before GitHub opens. Report Anyway is always one click,
 * and the gate itself remembers nothing - rerunning the command re-offers
 * (the repeat-report ledger runReportIssue writes when a report opens is a
 * separate, ungated-path concern). Every entry
 * point (palette, dashboard, hub, and the toasts' Report Issue action)
 * funnels through the one registered command, so they all pass this gate;
 * a classified failure toast that already offered Troubleshooting Docs gets
 * the offer again here on purpose - the gate is the last defense before a
 * public issue, and the entry points are too many to track which already
 * showed it.
 */

import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import type { SetupHintKind } from "../../shared/errorClassification";
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

/**
 * The hint ids are the setup verdicts; not-configured and hidden-groups (the
 * zero-model verdict explained by explicit removals) are the two
 * non-transport cases.
 */
export type SetupProblem = SetupHintKind | "not-configured" | "hidden-groups";

/**
 * The gate's verdict, read from the CURRENT connection status only - never
 * from the issue reporter's historical latestError, which is never cleared:
 * a healthy user must not be gated by an old failure. An error status
 * without a setup hint is treated as a real bug and goes straight to GitHub,
 * exactly like every healthy state - except the synthetic zero-model verdict
 * WHOLLY explained by hidden groups (every carried status is a hidden group
 * or an expected failure): that state is user-chosen configuration (the
 * groups answer empty because the user removed them), so the gate offers the
 * restore instead of a blank issue. A zero-model verdict a hidden group only
 * partly explains never gates: the server that answered with an empty
 * listing may be a real bug. One staleness window remains by design: at cold
 * start the status is last session's restored verdict until the first
 * refresh reports (and a status persisted by a pre-flag version restores
 * without hiddenByRemoval, so the hidden state can go ungated once), so a
 * since-fixed setup problem can gate once more - it self-corrects on that
 * refresh, costs one click, and the diagnostics snapshot reports the same
 * state, so the gate and the report never disagree.
 */
export function detectSetupProblem(status: ConnectionStatus): SetupProblem | undefined {
	switch (status.state) {
		case "not-configured":
			return "not-configured";
		case "error": {
			if (status.classification?.setupHint !== undefined) {
				return status.classification.setupHint;
			}
			const serverStatuses = status.serverStatuses ?? [];
			const whollyExplainedByHidden =
				serverStatuses.some(isHiddenGroupServerStatus) &&
				serverStatuses.every(
					(server) => isHiddenGroupServerStatus(server) || (server.state === "error" && server.expected === true)
				);
			return (status.totalModels ?? 0) === 0 && whollyExplainedByHidden ? "hidden-groups" : undefined;
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
				"LiteLLM: This looks like a setup state, not a bug (a server hidden by an explicit removal answers with no models). Restoring it from the dashboard's server list is faster than a GitHub issue."
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
	}
}

/**
 * Show the gate and act on the answer. Non-modal: Esc or dismissal does
 * nothing, and only Report Anyway opens an issue - with the snapshot the
 * command already built, so what gets reported is what the gate judged.
 * Callers must not await this from a serialized message chain; runReportIssue
 * documents why it voids the returned promise. Because of that void, a
 * failing report must surface here rather than die as an unhandled
 * rejection - the ungated path gets that for free from the command handler.
 * The other actions keep the toast idiom's semantics.
 */
export async function showSetupProblemGate(problem: SetupProblem, reportAnyway: () => Promise<void>): Promise<void> {
	const reportAnywayAction: MessageAction = {
		label: l10n.t("Report Anyway"),
		run: async () => {
			try {
				await reportAnyway();
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				void vscode.window.showErrorMessage(l10n.t("LiteLLM: Could not open the issue report - {0}", detail));
			}
		},
	};
	const actions =
		problem === "not-configured"
			? [reconfigureAction(configureNowLabel()), reportAnywayAction]
			: problem === "hidden-groups"
				? // The dashboard's Servers & Models view carries the hidden-groups
					// line with the Unhide action; there is no docs section or
					// connection test that fixes a deliberate removal.
					[reconfigureAction(l10n.t("Open Dashboard")), reportAnywayAction]
				: [troubleshootingDocsAction(SETUP_HINT_DOCS_URLS[problem]), testConnectionAction(), reportAnywayAction];
	await showActionableMessage("warning", gateMessage(problem), actions);
}
