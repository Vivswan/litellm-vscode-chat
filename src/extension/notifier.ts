import * as vscode from "vscode";
import type { ConfigurationPrompt } from "../provider/config";
import { CMD, INTERNAL_CMD } from "../shared/commandIds";
import { GITHUB_DOCS_URL } from "../shared/links";
import type { AggregatedStatus } from "../shared/servers";
import { isErrorServerStatus } from "../shared/servers";

export interface MessageAction {
	label: string;
	run: () => void | Promise<void>;
}

/**
 * The label every button that promises the server editor shares; such a
 * button must route to reconfigureAction (or, for the raw showErrorMessage
 * path below, INTERNAL_CMD.manageServers), never to the hub menu.
 */
export const CONFIGURE_NOW_LABEL = "Configure Now";

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

export function reconfigureAction(label = "Reconfigure"): MessageAction {
	return { label, run: () => void vscode.commands.executeCommand(INTERNAL_CMD.manageServers) };
}

export function reportIssueAction(label = "Report Issue"): MessageAction {
	return { label, run: () => void vscode.commands.executeCommand(CMD.reportIssue) };
}

export function viewOutputAction(channel: vscode.OutputChannel, label = "View Output"): MessageAction {
	return { label, run: () => channel.show() };
}

export function testConnectionAction(label = "Test Connection"): MessageAction {
	return { label, run: () => void vscode.commands.executeCommand(CMD.testConnection) };
}

export function openChatAction(label = "Open Chat"): MessageAction {
	return { label, run: () => void vscode.commands.executeCommand("workbench.action.chat.open") };
}

export function openSettingsAction(query: string, label = "Open Settings"): MessageAction {
	return { label, run: () => void vscode.commands.executeCommand("workbench.action.openSettings", query) };
}

export function dismissAction(): MessageAction {
	return { label: "Dismiss", run: () => {} };
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
			const choice = await vscode.window.showErrorMessage(
				"LiteLLM is not configured. Set up your connection to use this provider.",
				CONFIGURE_NOW_LABEL,
				"Learn More"
			);
			if (choice === CONFIGURE_NOW_LABEL) {
				await vscode.commands.executeCommand(INTERNAL_CMD.manageServers);
				return true;
			}
			if (choice === "Learn More") {
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
				message: "LiteLLM: No servers configured. Click to configure.",
				actions: [reconfigureAction(CONFIGURE_NOW_LABEL)],
			};
		}
		const failures = status.serverStatuses.filter(isErrorServerStatus);
		const firstFailure = failures[0];
		if (firstFailure !== undefined && failures.length === status.serverStatuses.length) {
			return {
				tag: "all-failed",
				signature: `all-failed:${firstFailure.error}`,
				kind: "error",
				message: `LiteLLM: ${firstFailure.error}`,
				actions: [reconfigureAction(), reportIssueAction()],
			};
		}
		if (status.totalModels === 0) {
			return {
				tag: "no-models",
				signature: "no-models",
				kind: "warning",
				message: "LiteLLM: Your servers returned no models. Check your LiteLLM proxy configuration.",
				actions: [testConnectionAction("Check Server"), reconfigureAction(), reportIssueAction()],
			};
		}
		return { tag: "recovered" };
	}
}
