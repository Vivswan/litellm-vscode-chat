import * as vscode from "vscode";
import type { ConfigurationPrompt } from "../provider/config";
import type { AggregatedStatus } from "../shared/servers";

const GITHUB_DOCS = "https://github.com/Vivswan/litellm-vscode-chat#quick-start";

export interface MessageAction {
	label: string;
	run: () => void | Promise<void>;
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

export function reconfigureAction(label = "Reconfigure"): MessageAction {
	return { label, run: () => void vscode.commands.executeCommand("litellm.manage") };
}

export function reportIssueAction(label = "Report Issue"): MessageAction {
	return { label, run: () => void vscode.commands.executeCommand("litellm.reportIssue") };
}

export function viewOutputAction(channel: vscode.OutputChannel, label = "View Output"): MessageAction {
	return { label, run: () => channel.show() };
}

export function testConnectionAction(label = "Test Connection"): MessageAction {
	return { label, run: () => void vscode.commands.executeCommand("litellm.testConnection") };
}

export function openChatAction(label = "Open Chat"): MessageAction {
	return { label, run: () => void vscode.commands.executeCommand("workbench.action.chat.open") };
}

export function dismissAction(): MessageAction {
	return { label: "Dismiss", run: () => {} };
}

export function createConfigurationPrompt(): ConfigurationPrompt {
	return {
		async promptToConfigure(): Promise<boolean> {
			const choice = await vscode.window.showErrorMessage(
				"LiteLLM is not configured. Set up your connection to use this provider.",
				"Configure Now",
				"Learn More"
			);
			if (choice === "Configure Now") {
				await vscode.commands.executeCommand("litellm.manage");
				return true;
			}
			if (choice === "Learn More") {
				vscode.env.openExternal(vscode.Uri.parse(GITHUB_DOCS));
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
 * Owns all toasts for provider refresh outcomes. Silent (background) refreshes
 * notify with once-per-condition dedup; non-silent refreshes never toast here
 * because the caller (test connection command or the model picker) surfaces
 * the outcome directly.
 */
export class Notifier {
	private _lastNotifiedSignature: string | undefined;

	handleAggregatedStatus(status: AggregatedStatus): void {
		const condition = this.evaluate(status);
		if (!condition) {
			// A successful refresh resets dedup so a recovered-then-broken
			// setup notifies again.
			this._lastNotifiedSignature = undefined;
			return;
		}
		if (!status.silent) {
			return;
		}
		if (condition.signature === this._lastNotifiedSignature) {
			return;
		}
		this._lastNotifiedSignature = condition.signature;
		void showActionableMessage(condition.kind, condition.message, condition.actions);
	}

	private evaluate(status: AggregatedStatus): NotifiableCondition | undefined {
		if (status.serverStatuses.length === 0) {
			return {
				signature: "no-servers",
				kind: "warning",
				message: "LiteLLM: No servers configured. Click to configure.",
				actions: [reconfigureAction("Configure Now")],
			};
		}
		const okCount = status.serverStatuses.filter((s) => s.state === "ok").length;
		if (okCount === 0) {
			const firstError = status.serverStatuses.find((s) => s.error)?.error ?? "Unknown error";
			return {
				signature: `all-failed:${firstError}`,
				kind: "error",
				message: `LiteLLM: ${firstError}`,
				actions: [reconfigureAction(), reportIssueAction()],
			};
		}
		if (status.totalModels === 0) {
			return {
				signature: "no-models",
				kind: "warning",
				message: "LiteLLM: Your servers returned no models. Check your LiteLLM proxy configuration.",
				actions: [testConnectionAction("Check Server"), reconfigureAction(), reportIssueAction()],
			};
		}
		return undefined;
	}
}
