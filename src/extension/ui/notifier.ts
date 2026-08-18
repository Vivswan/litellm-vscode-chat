import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import { classifyOverall } from "../../dashboard/presenters";
import { CMD } from "../../shared/config/commandIds";
import type { TransportErrorClassification } from "../../shared/errorClassification";
import type { AggregatedStatus } from "../../shared/servers";
import { unexpectedServerFailures } from "../../shared/servers";
import { statusErrorHeadline } from "../../shared/util/errorText";
import { SETUP_HINT_DOCS_URLS } from "../../shared/util/links";
import { openUrl } from "../../shared/util/openUrl";
import type { Timer } from "../../shared/util/timer";
import { PendingCall, REAL_TIMER } from "../../shared/util/timer";
import { zeroModelJudgment } from "./status";

// The headline extraction lives in shared/util/errorText so the dashboard
// webview splits messages the same way.
export { statusErrorHeadline };

export interface MessageAction {
	label: string;
	run: () => void | Promise<void>;
}

/**
 * The label every button that promises configuration shares; such a button
 * must route to reconfigureAction (or CMD.openDashboard directly), landing on
 * the dashboard's Servers & Models view - never on the hub menu or a native
 * editor. A function, not a constant: module-level localized constants would
 * evaluate before l10n.config and freeze English.
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
 * The error-toast actions for surfaces without an output channel: a
 * hint-carrying classification earns the Troubleshooting Docs button,
 * deep-linked to that cause's docs section. The message itself never changes -
 * the transport messages already carry their own advice, so the hint's whole
 * value on a toast is the docs link.
 */
function notifierErrorActions(classification: TransportErrorClassification | undefined): MessageAction[] {
	const setupHint = classification?.setupHint;
	return setupHint !== undefined
		? [reconfigureAction(), troubleshootingDocsAction(SETUP_HINT_DOCS_URLS[setupHint]), reportIssueAction()]
		: [reconfigureAction(), reportIssueAction()];
}

/**
 * The command surfaces' error-toast actions: the same set with View Output
 * first, so a hint never displaces access to the logs.
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
 * What one aggregated report means for notification, discriminated by tag so
 * consumers dispatch on the condition instead of re-deriving it from the dedup
 * signature string.
 */
type NotifierOutcome =
	| ({ tag: "no-servers" | "all-failed" | "no-models" } & NotifiableCondition)
	| { tag: "recovered" }
	| { tag: "suppressed" };

/**
 * How long an empty status window may claim "no servers configured" before the
 * claim is believed. At cold start the host runs the groupless refresh (which
 * reports an empty window) before the per-group refreshes that prove groups
 * exist, so the claim needs evidence of absence: the gate is checked again
 * once the host has had time to hand over any groups it manages. If a host is
 * slower still, the mistake self-heals: the first per-group report evaluates
 * as recovered and clears the dedup signature.
 */
const NO_SERVERS_GRACE_MS = 15000;

/**
 * Owns all toasts for provider refresh outcomes. Silent (background) refreshes
 * notify with once-per-condition dedup; non-silent refreshes never toast here
 * because the caller surfaces the outcome directly. `hasConfiguredServers` is
 * the shared configured gate: an empty status window on a configured install
 * must not claim "no servers". Because the gate's group latch flips only after
 * the groupless refresh already reported empty, the no-servers claim is never
 * toasted immediately: it is deferred by NO_SERVERS_GRACE_MS and re-gated when
 * the deferral expires.
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
			// fully known, so no claim is made AND the dedup signature is left
			// intact, or a prior error toast would read as recovered and re-fire
			// on the next real failure.
			this.cancelPendingClaim();
			return;
		}
		if (outcome.tag === "no-servers") {
			// The claim needs evidence of absence, not absence of evidence; see
			// the class comment. Non-silent refreshes do not arm it either: their
			// caller surfaces the outcome directly.
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
		// The one verdict pipeline: classifyOverall owns the branch rules (shared
		// with the status bar and the dashboard headline, so the toast can never
		// contradict the surfaces it points at); this method only maps verdicts
		// onto toasts.
		const verdict = classifyOverall(status.serverStatuses);
		if (verdict === "not-configured") {
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
		if (verdict === "error") {
			const firstFailure = unexpectedServerFailures(status.serverStatuses)[0];
			if (firstFailure === undefined) {
				// Unreachable: a status window carries no misconfigured rows, so the
				// error verdict guarantees an unexpected failure.
				return { tag: "recovered" };
			}
			return {
				tag: "all-failed",
				// The dedup signature is an internal English key, never displayed.
				// It keys on the HEADLINE plus the setup hint, matching what the
				// toast shows: the detail line's server-derived churn is not new
				// information, while distinct causes can share display text
				// (ENOTFOUND and ECONNREFUSED render the same message, but only
				// the latter carries proxy-not-running), so a failure whose hint
				// changes must re-fire the toast carrying the docs action.
				signature: `all-failed:${statusErrorHeadline(firstFailure.error)}:${firstFailure.classification?.setupHint ?? ""}`,
				kind: "error",
				message: l10n.t("LiteLLM: {0}", statusErrorHeadline(firstFailure.error)),
				actions: notifierErrorActions(firstFailure.classification),
			};
		}
		if (verdict === "needs-declare") {
			// Everything failed expectedly with nothing declared: discovery never
			// returned a list, so "returned no models" would misdescribe it. The
			// toast points at the fix the dashboard and status bar name too.
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
		// The shared zero-model judgment (zeroModelJudgment owns the gating
		// rule): it stands down on any verdict that already explains itself, so
		// a degraded window keeps the failure story the other surfaces tell.
		const zero = zeroModelJudgment(status.serverStatuses, status.totalModels);
		if (zero !== undefined) {
			if (zero.hiddenCount > 0) {
				// Hidden groups explain the zero models: the toast names the removal
				// and the recovery, sharing its wording with the status tooltip. The
				// connected verdict proves nothing failed unexpectedly, so no genuine
				// failure is being papered over with restore advice.
				return {
					tag: "no-models",
					// Distinct from "no-models" ON PURPOSE, mirroring the all-failed
					// signature's hint rule: a cause change is new information. The
					// count stays out of the key - hiding a second group is the same
					// cause, not a new one.
					signature: "no-models-hidden",
					kind: "warning",
					message: l10n.t("LiteLLM: {0}", zero.display),
					actions: [reconfigureAction(l10n.t("Open Dashboard")), reportIssueAction()],
				};
			}
			return {
				tag: "no-models",
				signature: "no-models",
				kind: "warning",
				message: l10n.t("LiteLLM: {0}", zero.display),
				actions: [testConnectionAction(l10n.t("Check Server")), reconfigureAction(), reportIssueAction()],
			};
		}
		return { tag: "recovered" };
	}
}
