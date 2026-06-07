import * as vscode from "vscode";
import type { AggregatedStatus } from "../provider";
import type { ServerStatus } from "./serverRegistry";

export interface ConnectionStatus {
	state: "not-configured" | "loading" | "connected" | "degraded" | "error";
	totalModels?: number;
	serverStatuses?: ServerStatus[];
	error?: string;
	lastChecked?: string;
}

export function formatSessionCostUsd(costUsd: number): string | undefined {
	if (!Number.isFinite(costUsd) || costUsd <= 0) {
		return undefined;
	}
	return costUsd < 0.0001 ? "<$0.0001" : `$${costUsd.toFixed(4)}`;
}

export class StatusBarManager {
	private _connectionStatus: ConnectionStatus = { state: "not-configured" };
	private readonly _statusBarItem: vscode.StatusBarItem;
	private _sessionCostUsd = 0;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly outputChannel: vscode.OutputChannel
	) {
		this._statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		this._statusBarItem.command = "litellm.showDiagnostics";
		context.subscriptions.push(this._statusBarItem);

		const lastStatus = context.globalState.get<ConnectionStatus>("litellm.lastConnectionStatus");
		if (lastStatus) {
			this._connectionStatus = lastStatus;
		}
		this.updateStatusBar();
	}

	get connectionStatus(): ConnectionStatus {
		return this._connectionStatus;
	}

	addSessionCost(costUsd: number): void {
		if (!Number.isFinite(costUsd) || costUsd <= 0) {
			return;
		}
		this._sessionCostUsd += costUsd;
		void this.updateStatusBar();
	}

	private costSuffix(): string {
		const formatted = formatSessionCostUsd(this._sessionCostUsd);
		if (!formatted) {
			return "";
		}
		return ` - ${formatted}`;
	}

	private costTooltipSuffix(): string {
		const formatted = formatSessionCostUsd(this._sessionCostUsd);
		if (!formatted) {
			return "";
		}
		return `\nCumulative LiteLLM cost since this window started: ${formatted}`;
	}

	async updateStatusBar(status?: ConnectionStatus): Promise<void> {
		if (status) {
			this._connectionStatus = status;
			await this.context.globalState.update("litellm.lastConnectionStatus", status);
		}

		switch (this._connectionStatus.state) {
			case "not-configured":
				this._statusBarItem.text = `$(warning) LiteLLM${this.costSuffix()}`;
				this._statusBarItem.tooltip = `Not configured - click to set up${this.costTooltipSuffix()}`;
				this._statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
				break;
			case "loading":
				this._statusBarItem.text = `$(loading~spin) LiteLLM${this.costSuffix()}`;
				this._statusBarItem.tooltip = `Fetching models...${this.costTooltipSuffix()}`;
				this._statusBarItem.backgroundColor = undefined;
				break;
			case "connected": {
				const count = this._connectionStatus.totalModels ?? 0;
				const serverCount = this._connectionStatus.serverStatuses?.length ?? 0;
				const serverText = serverCount > 1 ? ` from ${serverCount} servers` : "";
				this._statusBarItem.text = `$(check) LiteLLM (${count})${this.costSuffix()}`;
				this._statusBarItem.tooltip = `${count} model${count === 1 ? "" : "s"} available${serverText}\nClick for diagnostics${this.costTooltipSuffix()}`;
				this._statusBarItem.backgroundColor = undefined;
				break;
			}
			case "degraded": {
				const count = this._connectionStatus.totalModels ?? 0;
				const statuses = this._connectionStatus.serverStatuses ?? [];
				const failedCount = statuses.filter((s) => s.state === "error").length;
				this._statusBarItem.text = `$(warning) LiteLLM (${count})${this.costSuffix()}`;
				this._statusBarItem.tooltip = `${count} model${count === 1 ? "" : "s"} available\n${failedCount} server${failedCount === 1 ? "" : "s"} unreachable\nClick for diagnostics${this.costTooltipSuffix()}`;
				this._statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
				break;
			}
			case "error":
				this._statusBarItem.text = `$(error) LiteLLM${this.costSuffix()}`;
				this._statusBarItem.tooltip = `Connection failed\n${this._connectionStatus.error || "Unknown error"}\nClick for details${this.costTooltipSuffix()}`;
				this._statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
				break;
		}
		this._statusBarItem.show();
	}

	handleAggregatedStatus(aggStatus: AggregatedStatus): void {
		const now = new Date().toISOString();
		const { serverStatuses, totalModels } = aggStatus;

		if (serverStatuses.length === 0) {
			this.outputChannel.appendLine(`[${now}] No servers configured`);
			void this.updateStatusBar({ state: "not-configured", lastChecked: now });
			return;
		}

		const okCount = serverStatuses.filter((s) => s.state === "ok").length;
		const errCount = serverStatuses.filter((s) => s.state === "error").length;

		if (okCount === 0) {
			const firstError = serverStatuses.find((s) => s.error)?.error ?? "All servers failed";
			this.outputChannel.appendLine(`[${now}] All servers failed: ${firstError}`);
			void this.updateStatusBar({
				state: "error",
				error: firstError,
				serverStatuses,
				totalModels: 0,
				lastChecked: now,
			});
		} else if (errCount > 0) {
			this.outputChannel.appendLine(
				`[${now}] Partial success: ${okCount} ok, ${errCount} failed, ${totalModels} models`
			);
			void this.updateStatusBar({
				state: "degraded",
				serverStatuses,
				totalModels,
				lastChecked: now,
			});
		} else if (totalModels === 0) {
			this.outputChannel.appendLine(`[${now}] Warning: All servers returned 0 models`);
			void this.updateStatusBar({
				state: "error",
				error: "Servers returned 0 models",
				serverStatuses,
				totalModels: 0,
				lastChecked: now,
			});
		} else {
			this.outputChannel.appendLine(`[${now}] Successfully fetched ${totalModels} models from ${okCount} server(s)`);
			void this.updateStatusBar({
				state: "connected",
				serverStatuses,
				totalModels,
				lastChecked: now,
			});
		}
	}
}
