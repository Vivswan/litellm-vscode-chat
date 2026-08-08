import * as vscode from "vscode";
import type { ConfigurationPrompt } from "../../provider/config";
import { CMD } from "../../shared/config/commandIds";
import type { TransportErrorClassification } from "../../shared/errorClassification";
import type { AggregatedStatus } from "../../shared/servers";
import { isErrorServerStatus } from "../../shared/servers";
import { GITHUB_DOCS_URL, SETUP_HINT_DOCS_URLS } from "../../shared/util/links";
import { openUrl } from "../../shared/util/openUrl";

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
	return vscode.l10n.t("Configure Now");
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

export function reconfigureAction(label = vscode.l10n.t("Reconfigure")): MessageAction {
	return { label, run: () => void vscode.commands.executeCommand(CMD.openDashboard) };
}

export function reportIssueAction(label = vscode.l10n.t("Report Issue")): MessageAction {
	return { label, run: () => void vscode.commands.executeCommand(CMD.reportIssue) };
}

export function viewOutputAction(channel: vscode.OutputChannel, label = vscode.l10n.t("View Output")): MessageAction {
	return { label, run: () => channel.show() };
}

export function testConnectionAction(label = vscode.l10n.t("Test Connection")): MessageAction {
	return { label, run: () => void vscode.commands.executeCommand(CMD.testConnection) };
}

export function troubleshootingDocsAction(url: string, label = vscode.l10n.t("Troubleshooting Docs")): MessageAction {
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

export function openChatAction(label = vscode.l10n.t("Open Chat")): MessageAction {
	return { label, run: () => void vscode.commands.executeCommand("workbench.action.chat.open") };
}

export function openSettingsAction(query: string, label = vscode.l10n.t("Open Settings")): MessageAction {
	return { label, run: () => void vscode.commands.executeCommand("workbench.action.openSettings", query) };
}

export function dismissAction(): MessageAction {
	return { label: vscode.l10n.t("Dismiss"), run: () => {} };
}

/**
 * The prompt behind the provider's "nothing to serve" path. The caller only
 * checked the legacy registry, which stays empty on modern installs, so the
 * not-configured toast fires only when `hasConfiguredServers` (declared
 * servers-setting entries or live provider groups) also comes up empty.
 */
export function createConfigurationPrompt(hasConfiguredServers: () => boolean): ConfigurationPrompt {
	return {
		async promptToConfigure(): Promise<boolean> {
			if (hasConfiguredServers()) {
				return false;
			}
			const configureNow = configureNowLabel();
			const learnMore = vscode.l10n.t("Learn More");
			const choice = await vscode.window.showErrorMessage(
				vscode.l10n.t("LiteLLM is not configured. Set up your connection to use this provider."),
				configureNow,
				learnMore
			);
			if (choice === configureNow) {
				await vscode.commands.executeCommand(CMD.openDashboard);
				return true;
			}
			if (choice === learnMore) {
				void vscode.env.openExternal(vscode.Uri.parse(GITHUB_DOCS_URL));
			}
			return false;
		},
	};
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

/** Timer effects, injectable so the grace deferral is testable without real time. */
export interface NotifierTimer {
	/** Schedule `callback` after `ms`; the returned closure cancels the pending call. */
	set(callback: () => void, ms: number): () => void;
}

const REAL_TIMER: NotifierTimer = {
	set: (callback, ms) => {
		const handle = setTimeout(callback, ms);
		return () => clearTimeout(handle);
	},
};

/**
 * How long an empty status window may claim "no servers configured" before
 * the claim is believed. At cold start the host runs the groupless refresh
 * (which reports an empty window) before the per-group refreshes that prove
 * groups exist, so the claim needs evidence of absence: the gate is checked
 * again once the host has had time to hand over any groups it manages.
 *
 * The trade-off in this number: a genuinely-unconfigured user sees the setup
 * toast this long after cold start (they still have the welcome toast and the
 * model picker's configuration prompt in the meantime), while a host that is
 * slow to re-resolve groups (loaded machine, remote window, many groups) gets
 * this much room before the wrong toast could fire. If a host is slower
 * still, the mistake self-heals: the first per-group report evaluates as
 * recovered and clears the dedup signature.
 */
const NO_SERVERS_GRACE_MS = 15000;

/**
 * Owns all toasts for provider refresh outcomes. Silent (background) refreshes
 * notify with once-per-condition dedup; non-silent refreshes never toast here
 * because the caller (test connection command or the model picker) surfaces
 * the outcome directly. `hasConfiguredServers` is the same gate the
 * configuration prompt uses: an empty status window on a configured install
 * (fresh installs keep the registry-backed refresh path, which reports empty
 * while provider groups serve fine) must not claim "no servers". Because the
 * gate's group latch flips only when a per-group refresh arrives - after the
 * groupless refresh already reported empty - the no-servers claim is never
 * toasted immediately: it is deferred by NO_SERVERS_GRACE_MS and re-gated when
 * the deferral expires, so group-configured users never see it at cold start
 * while genuinely-unconfigured users still get it moments later.
 */
export class Notifier implements vscode.Disposable {
	private _lastNotifiedSignature: string | undefined;
	/** Cancels the armed no-servers claim; undefined when none is pending. */
	private _cancelPendingClaim: (() => void) | undefined;

	constructor(
		private readonly hasConfiguredServers: () => boolean,
		private readonly graceMs: number = NO_SERVERS_GRACE_MS,
		private readonly timer: NotifierTimer = REAL_TIMER
	) {}

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
		if (this._cancelPendingClaim !== undefined || condition.signature === this._lastNotifiedSignature) {
			return;
		}
		this._cancelPendingClaim = this.timer.set(() => {
			this._cancelPendingClaim = undefined;
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
		this._cancelPendingClaim?.();
		this._cancelPendingClaim = undefined;
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
				message: vscode.l10n.t("LiteLLM: No servers configured. Click to configure."),
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
				// It keys on the error text PLUS the setup hint: the hint identifies
				// the cause, and distinct causes can share display text (ENOTFOUND
				// and ECONNREFUSED deliberately render the same connection message,
				// but only the latter carries proxy-not-running), so a failure whose
				// hint changes must re-fire the toast that first carries the
				// Troubleshooting Docs action.
				signature: `all-failed:${firstFailure.error}:${firstFailure.classification?.setupHint ?? ""}`,
				kind: "error",
				message: vscode.l10n.t("LiteLLM: {0}", firstFailure.error),
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
					message: vscode.l10n.t(
						"LiteLLM: Discovery is declared unavailable and no models are declared. Add IDs to the entry's discovery.declared list."
					),
					actions: [reconfigureAction(), reportIssueAction()],
				};
			}
			return {
				tag: "no-models",
				signature: "no-models",
				kind: "warning",
				message: vscode.l10n.t("LiteLLM: Your servers returned no models. Check your LiteLLM proxy configuration."),
				actions: [testConnectionAction(vscode.l10n.t("Check Server")), reconfigureAction(), reportIssueAction()],
			};
		}
		return { tag: "recovered" };
	}
}
