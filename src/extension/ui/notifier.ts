import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import { CMD } from "../../shared/config/commandIds";
import type { TransportErrorClassification } from "../../shared/errorClassification";
import type { AggregatedStatus } from "../../shared/servers";
import { isErrorServerStatus } from "../../shared/servers";
import { statusErrorHeadline } from "../../shared/util/errorText";
import { SETUP_HINT_DOCS_URLS } from "../../shared/util/links";
import { openUrl } from "../../shared/util/openUrl";
import type { Timer } from "../../shared/util/timer";
import { PendingCall, REAL_TIMER } from "../../shared/util/timer";
import { zeroModelStatusTexts } from "./status";

// The headline extraction lives in shared/util/errorText so the dashboard
// webview splits messages the same way; re-exported here for the host-side
// consumers that always imported it from the notifier.
export { statusErrorHeadline };

export interface MessageAction {
	label: string;
	run: () => void | Promise<void>;
}

/**
 * The label every button that promises configuration shares; such a button
 * must route to reconfigureAction (or, for the raw showErrorMessage path
 * below, CMD.openDashboard directly), landing on the dashboard's Servers &
 * Models view - never on the hub menu or a native editor. A function, not a
 * constant: module-level localized constants would evaluate before
 * l10n.config and freeze English.
 */
export function configureNowLabel(): string {
	return l10n.t("Configure Now");
}

export async function showActionableMessage(
	kind: "info" | "warning" | "error",
	message: string,
	actions: MessageAction[]
): Promise<void> {
	const labels = actions.map((a) => a.label);
	const choice =
		kind === "info"
			? await vscode.window.showInformationMessage(message, ...labels)
			: kind === "warning"
				? await vscode.window.showWarningMessage(message, ...labels)
				: await vscode.window.showErrorMessage(message, ...labels);
	const action = actions.find((a) => a.label === choice);
	if (action) {
		await action.run();
	}
}

export function reconfigureAction(label = l10n.t("Reconfigure")): MessageAction {
	return { label, run: () => void vscode.commands.executeCommand(CMD.openDashboard) };
}

export function reportIssueAction(label = l10n.t("Report Issue")): MessageAction {
	return { label, run: () => void vscode.commands.executeCommand(CMD.reportIssue) };
}

export function viewOutputAction(channel: vscode.OutputChannel, label = l10n.t("View Output")): MessageAction {
	return { label, run: () => channel.show() };
}

export function testConnectionAction(label = l10n.t("Test Connection")): MessageAction {
	return { label, run: () => void vscode.commands.executeCommand(CMD.testConnection) };
}

export function troubleshootingDocsAction(url: string, label = l10n.t("Troubleshooting Docs")): MessageAction {
	return { label, run: () => openUrl(url) };
}

/**
 * The error-toast actions for surfaces without an output channel (the
 * notifier's background toasts): a hint-carrying classification earns the
 * Troubleshooting Docs button, deep-linked to that cause's docs section;
 * otherwise exactly today's pair. The message itself never changes - the
 * transport messages already carry their own advice, so the hint's whole
 * value on a toast is the docs link.
 */
function notifierErrorActions(classification: TransportErrorClassification | undefined): MessageAction[] {
	const setupHint = classification?.setupHint;
	return setupHint !== undefined
		? [reconfigureAction(), troubleshootingDocsAction(SETUP_HINT_DOCS_URLS[setupHint]), reportIssueAction()]
		: [reconfigureAction(), reportIssueAction()];
}

/**
 * The error-toast actions for the command surfaces (test connection, model
 * sync): the same set as notifierErrorActions with View Output first in both
 * variants, so a hint never displaces access to the logs.
 */
export function commandErrorActions(
	classification: TransportErrorClassification | undefined,
	outputChannel: vscode.OutputChannel
): MessageAction[] {
	return [viewOutputAction(outputChannel), ...notifierErrorActions(classification)];
}

export function openChatAction(label = l10n.t("Open Chat")): MessageAction {
	return { label, run: () => void vscode.commands.executeCommand("workbench.action.chat.open") };
}

export function openSettingsAction(query: string, label = l10n.t("Open Settings")): MessageAction {
	return { label, run: () => void vscode.commands.executeCommand("workbench.action.openSettings", query) };
}

export function dismissAction(): MessageAction {
	return { label: l10n.t("Dismiss"), run: () => {} };
}

interface NotifiableCondition {
	signature: string;
	kind: "warning" | "error";
	message: string;
	actions: MessageAction[];
}

/**
 * What one aggregated report means for notification. The three notifiable
 * conditions are discriminated by tag, so consumers dispatch on the condition
 * itself instead of re-deriving it from the dedup signature string.
 */
type NotifierOutcome =
	| ({ tag: "no-servers" | "all-failed" | "no-models" } & NotifiableCondition)
	| { tag: "recovered" }
	| { tag: "suppressed" };

/**
 * How long an empty status window may claim "no servers configured" before
 * the claim is believed. At cold start the host runs the groupless refresh
 * (which reports an empty window) before the per-group refreshes that prove
 * groups exist, so the claim needs evidence of absence: the gate is checked
 * again once the host has had time to hand over any groups it manages.
 *
 * The trade-off in this number: a genuinely-unconfigured user sees the setup
 * toast this long after cold start (they still have the welcome toast in the
 * meantime), while a host that is slow to re-resolve groups (loaded machine,
 * remote window, many groups) gets this much room before the wrong toast
 * could fire. If a host is slower still, the mistake self-heals: the first
 * per-group report evaluates as recovered and clears the dedup signature.
 */
const NO_SERVERS_GRACE_MS = 15000;

/**
 * Owns all toasts for provider refresh outcomes. Silent (background) refreshes
 * notify with once-per-condition dedup; non-silent refreshes never toast here
 * because the caller (test connection command or the model picker) surfaces
 * the outcome directly. `hasConfiguredServers` is the shared configured gate:
 * an empty status window on a configured install (the group-agnostic refresh
 * reports empty while provider groups serve fine) must not claim "no servers".
 * Because the gate's group latch flips only when a per-group refresh arrives -
 * after the groupless refresh already reported empty - the no-servers claim is
 * never toasted immediately: it is deferred by NO_SERVERS_GRACE_MS and
 * re-gated when the deferral expires, so group-configured users never see it
 * at cold start
 * while genuinely-unconfigured users still get it moments later.
 */
export class Notifier implements vscode.Disposable {
	private _lastNotifiedSignature: string | undefined;
	/** The armed no-servers claim; not pending when none is armed. */
	private readonly pendingClaim: PendingCall;

	constructor(
		private readonly hasConfiguredServers: () => boolean,
		private readonly graceMs: number = NO_SERVERS_GRACE_MS,
		timer: Timer = REAL_TIMER
	) {
		this.pendingClaim = new PendingCall(timer);
	}

	/**
	 * Withdraws an armed claim so it cannot fire after deactivation: a toast
	 * from a deactivated extension would offer an action whose command
	 * registration is already disposed.
	 */
	dispose(): void {
		this.cancelPendingClaim();
	}

	handleAggregatedStatus(status: AggregatedStatus): void {
		const outcome = this.evaluate(status);
		if (outcome.tag === "recovered") {
			// A healthy refresh resets dedup so a recovered-then-broken setup
			// notifies again; a pending no-servers claim is obviously stale.
			this.cancelPendingClaim();
			this._lastNotifiedSignature = undefined;
			return;
		}
		if (outcome.tag === "suppressed") {
			// An empty status window on a configured install: the world is not
			// fully known (the groupless refresh reports before the per-group
			// refreshes), so no claim is made AND the dedup signature is left
			// intact, or a prior error toast would read as recovered and re-fire on
			// the next real failure. A pending claim armed before the gate flipped
			// is withdrawn.
			this.cancelPendingClaim();
			return;
		}
		if (outcome.tag === "no-servers") {
			// The claim needs evidence of absence, not absence of evidence; see
			// the class comment. Non-silent refreshes do not arm it either: their
			// caller surfaces the outcome directly, as with every other condition.
			if (status.silent) {
				this.armNoServersClaim(outcome);
			}
			return;
		}
		// A real condition over a non-empty window: servers exist, so any pending
		// no-servers claim was a cold-start artifact.
		this.cancelPendingClaim();
		if (!status.silent) {
			return;
		}
		if (outcome.signature === this._lastNotifiedSignature) {
			return;
		}
		this._lastNotifiedSignature = outcome.signature;
		void showActionableMessage(outcome.kind, outcome.message, outcome.actions);
	}

	private armNoServersClaim(condition: NotifiableCondition): void {
		if (this.pendingClaim.pending || condition.signature === this._lastNotifiedSignature) {
			return;
		}
		this.pendingClaim.arm(() => {
			// Re-gated at expiry: by now the host has handed over any groups it
			// manages, so a still-false gate is evidence of absence.
			if (this.hasConfiguredServers() || condition.signature === this._lastNotifiedSignature) {
				return;
			}
			this._lastNotifiedSignature = condition.signature;
			void showActionableMessage(condition.kind, condition.message, condition.actions);
		}, this.graceMs);
	}

	private cancelPendingClaim(): void {
		this.pendingClaim.cancel();
	}

	private evaluate(status: AggregatedStatus): NotifierOutcome {
		if (status.serverStatuses.length === 0) {
			if (this.hasConfiguredServers()) {
				return { tag: "suppressed" };
			}
			return {
				tag: "no-servers",
				signature: "no-servers",
				kind: "warning",
				message: l10n.t("LiteLLM: No servers configured. Click to configure."),
				actions: [reconfigureAction(configureNowLabel())],
			};
		}
		const failures = status.serverStatuses.filter(isErrorServerStatus);
		// Expected failures never toast red: the entry declared them normal. The
		// all-failed rule mirrors the status bar and classifyOverall (red only
		// when EVERY server failed unexpectedly), so the toast can never
		// contradict the surfaces it points at.
		const unexpectedFailures = failures.filter((failure) => failure.expected !== true);
		const firstFailure = unexpectedFailures[0];
		if (firstFailure !== undefined && unexpectedFailures.length === status.serverStatuses.length) {
			return {
				tag: "all-failed",
				// The dedup signature is an internal English key, never displayed.
				// It keys on the HEADLINE plus the setup hint, matching what the
				// toast shows: the detail line carries variable server-derived
				// text (spend figures, cause chains) whose churn is not new
				// information, while the hint identifies the cause, and distinct
				// causes can share display text (ENOTFOUND and ECONNREFUSED
				// deliberately render the same connection message, but only the
				// latter carries proxy-not-running), so a failure whose hint
				// changes must re-fire the toast that first carries the
				// Troubleshooting Docs action.
				signature: `all-failed:${statusErrorHeadline(firstFailure.error)}:${firstFailure.classification?.setupHint ?? ""}`,
				kind: "error",
				message: l10n.t("LiteLLM: {0}", statusErrorHeadline(firstFailure.error)),
				actions: notifierErrorActions(firstFailure.classification),
			};
		}
		if (status.totalModels === 0) {
			// All-expected failures with nothing declared get the needs-declare
			// message the dashboard and status bar show: discovery never
			// returned a list, so "returned no models" would misdescribe it.
			if (unexpectedFailures.length === 0 && failures.length === status.serverStatuses.length && failures.length > 0) {
				return {
					tag: "no-models",
					signature: "needs-declare",
					kind: "warning",
					message: l10n.t(
						"LiteLLM: Discovery is declared unavailable and no models are declared. Add IDs to the entry's discovery.declared list."
					),
					actions: [reconfigureAction(), reportIssueAction()],
				};
			}
			// Hidden groups explain the zero models: the toast names the real
			// cause and the recovery instead of blaming the proxy configuration;
			// the wording is shared with the status tooltip so the two surfaces
			// cannot disagree. Only while nothing failed unexpectedly - a genuine
			// failure in the mix must not be papered over with restore advice, so
			// that mix keeps the plain no-models warning below.
			const zeroTexts = zeroModelStatusTexts(status.serverStatuses);
			if (zeroTexts.hiddenCount > 0 && unexpectedFailures.length === 0) {
				return {
					tag: "no-models",
					// Distinct from "no-models" ON PURPOSE, mirroring the all-failed
					// signature's hint rule: a cause change is new information, so a
					// generic zero-model state that becomes hidden-explained re-fires
					// with the corrective wording. The count stays out of the key -
					// hiding a second group is the same cause, not a new one.
					signature: "no-models-hidden",
					kind: "warning",
					message: l10n.t("LiteLLM: {0}", zeroTexts.display),
					actions: [reconfigureAction(l10n.t("Open Dashboard")), reportIssueAction()],
				};
			}
			return {
				tag: "no-models",
				signature: "no-models",
				kind: "warning",
				message: l10n.t("LiteLLM: Your servers returned no models. Check your LiteLLM proxy configuration."),
				actions: [testConnectionAction(l10n.t("Check Server")), reconfigureAction(), reportIssueAction()],
			};
		}
		return { tag: "recovered" };
	}
}
