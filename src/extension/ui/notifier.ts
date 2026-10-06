import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import { classifyOverall } from "../../dashboard/presenters";
import { CMD } from "../../shared/config/commandIds";
import type { TransportErrorClassification } from "../../shared/errorClassification";
import { failureTexts } from "../../shared/failureCause";
import { Logger } from "../../shared/logger";
import type { AggregatedStatus } from "../../shared/servers";
import { statusClassification, unexpectedServerFailures } from "../../shared/servers";
import { SETUP_HINT_DOCS_URLS } from "../../shared/util/links";
import { openUrl } from "../../shared/util/openUrl";
import type { Timer } from "../../shared/util/timer";
import { PendingCall, REAL_TIMER } from "../../shared/util/timer";
import type { ServerVerdict } from "../servers/syncFailureOverlay";
import { applySyncFailures } from "../servers/syncFailureOverlay";
import { zeroModelJudgment, zeroModelTexts } from "./status";

export interface MessageAction {
	label: string;
	run: () => void | Promise<void>;
}

export type MessageKind = "info" | "warning" | "error";

/**
 * A function, not a constant: module-level localized constants would evaluate before l10n.config and freeze English.
 */
export function configureNowLabel(): string {
	return l10n.t("Configure Now");
}

/**
 * The one toast door: the message and a modal's detail pass Logger.redact once before VS Code shows them, so an
 * error that quotes a configured value or a URL's userinfo never reaches a toast whole. An l10n literal carries no
 * value and comes out unchanged; the labels are the caller's own button titles.
 */
export function showMessage(
	kind: MessageKind,
	message: string,
	labels: readonly string[],
	options?: vscode.MessageOptions
): Thenable<string | undefined> {
	const shown = Logger.redact(message);
	const show =
		kind === "info"
			? vscode.window.showInformationMessage
			: kind === "warning"
				? vscode.window.showWarningMessage
				: vscode.window.showErrorMessage;
	if (options === undefined) {
		return show(shown, ...labels);
	}
	const masked = options.detail === undefined ? options : { ...options, detail: Logger.redact(options.detail) };
	return show(shown, masked, ...labels);
}

export async function showActionableMessage(
	kind: MessageKind,
	message: string,
	actions: MessageAction[]
): Promise<void> {
	const choice = await showMessage(
		kind,
		message,
		actions.map((a) => a.label)
	);
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
 * The error-toast actions for surfaces without an output channel: a hint-carrying classification earns the
 * Troubleshooting Docs button, deep-linked to that cause's docs section. The message itself never changes - the
 * transport messages already carry their own advice, so the hint's whole value on a toast is the docs link.
 */
function notifierErrorActions(classification: TransportErrorClassification | undefined): MessageAction[] {
	const setupHint = classification?.setupHint;
	return setupHint !== undefined
		? [reconfigureAction(), troubleshootingDocsAction(SETUP_HINT_DOCS_URLS[setupHint]), reportIssueAction()]
		: [reconfigureAction(), reportIssueAction()];
}

/**
 * The command surfaces' error-toast actions: the same set with View Output first, so a hint never displaces access to
 * the logs.
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

type NotifierOutcome =
	| ({ tag: "no-servers" | "all-failed" | "no-models" } & NotifiableCondition)
	| { tag: "recovered" }
	| { tag: "suppressed" };

/**
 * At cold start the host runs the groupless refresh (which reports an empty window) before the per-group refreshes that
 * prove groups exist, so the claim needs evidence of absence: the gate is checked again once the host has had time to
 * hand over any groups it manages.
 *
 *   If a host is slower still -> the mistake self-heals
 */
const NO_SERVERS_GRACE_MS = 15000;

/**
 * Silent (background) refreshes notify with once-per-condition dedup; non-silent refreshes never toast here because the
 * caller surfaces the outcome directly. `hasConfiguredServers` is the shared configured gate: an empty status window on
 * a configured install must not claim "no servers".
 */
export class Notifier implements vscode.Disposable {
	private _lastNotifiedSignature: string | undefined;
	private readonly pendingClaim: PendingCall;
	private lastStatus: AggregatedStatus | undefined;

	constructor(
		private readonly hasConfiguredServers: () => boolean,
		/**
		 * The one owner of the verdict rows and the declared set the status bar judges too, so the toast can never
		 * contradict the bar it points at.
		 */
		private readonly verdict: Pick<ServerVerdict, "declared" | "rows">,
		private readonly graceMs: number = NO_SERVERS_GRACE_MS,
		timer: Timer = REAL_TIMER
	) {
		this.pendingClaim = new PendingCall(timer);
	}

	/**
	 * Withdraws an armed claim so it cannot fire after deactivation: a toast from a deactivated extension would offer
	 * an action whose command registration is already disposed.
	 */
	dispose(): void {
		this.cancelPendingClaim();
	}

	handleAggregatedStatus(status: AggregatedStatus): void {
		this.lastStatus = status;
		const outcome = this.evaluate(status);
		if (outcome.tag === "recovered") {
			// A healthy refresh resets dedup so a recovered-then-broken setup notifies again; a pending no-servers
			// claim is obviously stale.
			this.cancelPendingClaim();
			this._lastNotifiedSignature = undefined;
			return;
		}
		if (outcome.tag === "suppressed") {
			// An empty status window on a configured install: the world is not fully known, so no claim is made AND the
			// dedup signature is left intact, or a prior error toast would read as recovered and re-fire on the next
			// real failure.
			this.cancelPendingClaim();
			return;
		}
		if (outcome.tag === "no-servers") {
			// The claim needs evidence of absence, not absence of evidence; see the class comment. Non-silent refreshes
			// do not arm it either: their caller surfaces the outcome directly.
			if (status.silent) {
				this.armNoServersClaim(outcome);
			}
			return;
		}
		// A real condition over a non-empty window: servers exist, so any pending no-servers claim was a cold-start
		// artifact.
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

	/**
	 * Re-judge the last provider report after a sync pass: a sync-only change moves the overlay without any provider
	 * report firing the status callback. The signature dedup makes re-judging the same world a no-op, and before any
	 * report only a non-empty overlay carries news worth judging.
	 */
	refreshFromSync(): void {
		const base = this.lastStatus ?? { serverStatuses: [], totalModels: 0, silent: true };
		// Before any report, news is a non-empty overlay or a non-empty row set (a refused entry is a row with no
		// overlay).
		if (
			this.lastStatus === undefined &&
			applySyncFailures(base.serverStatuses, this.verdict.declared().views).length === 0 &&
			this.verdict.rows().length === 0
		) {
			return;
		}
		this.handleAggregatedStatus(base);
	}

	private armNoServersClaim(condition: NotifiableCondition): void {
		if (this.pendingClaim.pending || condition.signature === this._lastNotifiedSignature) {
			return;
		}
		this.pendingClaim.arm(() => {
			// Re-gated at expiry: by now the host has handed over any groups it manages, so a still-false gate is
			// evidence of absence.
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
		// The same overlaid window the status bar judges (see applySyncFailures): sync failures never enter the
		// provider report itself.
		const serverStatuses = applySyncFailures(status.serverStatuses, this.verdict.declared().views);
		//   The one verdict pipeline -> classifyOverall owns the branch rules, over the owner's published rows (shared
		//       with the status bar and the dashboard headline)
		const rows = this.verdict.rows();
		const verdict = classifyOverall(rows);
		// "waiting" is declared entries with no report yet: the world is not fully known, the same suppression an
		// empty window gets on a configured install, never a recovery.
		if (verdict === "waiting" || (verdict === "not-configured" && this.hasConfiguredServers())) {
			return { tag: "suppressed" };
		}
		if (verdict === "not-configured") {
			return {
				tag: "no-servers",
				signature: "no-servers",
				kind: "warning",
				message: l10n.t("LiteLLM: No servers configured. Click to configure."),
				actions: [reconfigureAction(configureNowLabel())],
			};
		}
		if (verdict === "error") {
			const firstFailure = unexpectedServerFailures(serverStatuses)[0];
			if (firstFailure === undefined) {
				// Every row is a parser-refused entry: the same error the bar and the hero show, pointing at the fix.
				return {
					tag: "all-failed",
					signature: "all-misconfigured",
					kind: "error",
					message: l10n.t("LiteLLM: {0}", Logger.redact(failureTexts({ kind: "misconfiguredEntry" }, "").display)),
					actions: [reconfigureAction()],
				};
			}
			return {
				tag: "all-failed",
				// The dedup signature is an internal key, never displayed: the cause itself (its classification and
				// setup hint included), so a failure whose cause changes re-fires the toast, with the docs action when
				// the new cause carries a hint.
				signature: `all-failed:${JSON.stringify(firstFailure.cause)}`,
				kind: "error",
				message: l10n.t("LiteLLM: {0}", Logger.redact(failureTexts(firstFailure.cause, firstFailure.baseUrl).display)),
				actions: notifierErrorActions(statusClassification(firstFailure)),
			};
		}
		if (verdict === "needs-declare") {
			// Everything failed expectedly with nothing declared: discovery never returned a list, so "returned no
			// models" would misdescribe it. The toast points at the fix the dashboard and status bar name too.
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
		// The shared zero-model judgment (zeroModelJudgment owns the gating rule): it stands down on any verdict that
		// already explains itself, so a degraded window keeps the failure story the other surfaces tell.
		const zero = zeroModelJudgment(rows, status.totalModels);
		if (zero !== undefined) {
			if (zero.hiddenCount > 0) {
				// Hidden groups explain the zero models: the toast names the removal and the recovery, sharing its
				// wording with the status tooltip. The connected verdict proves nothing failed unexpectedly, so no
				// genuine failure is being papered over with restore advice.
				return {
					tag: "no-models",
					// Distinct from "no-models" ON PURPOSE, mirroring the all-failed signature's hint rule: a cause
					// change is new information. The count stays out of the key - hiding a second group is the same
					// cause, not a new one.
					signature: "no-models-hidden",
					kind: "warning",
					message: l10n.t("LiteLLM: {0}", zeroModelTexts(zero).display),
					actions: [reconfigureAction(l10n.t("Open Dashboard")), reportIssueAction()],
				};
			}
			return {
				tag: "no-models",
				signature: "no-models",
				kind: "warning",
				message: l10n.t("LiteLLM: {0}", zeroModelTexts(zero).display),
				actions: [testConnectionAction(l10n.t("Check Server")), reconfigureAction(), reportIssueAction()],
			};
		}
		// Recovery is something serving: a degraded verdict made of failures beside entries awaiting their first report
		// has nothing recovered in it, so it is suppressed like any other not-yet-known window.
		return serverStatuses.some((status) => status.state === "ok" || status.servedModelCount > 0)
			? { tag: "recovered" }
			: { tag: "suppressed" };
	}
}
