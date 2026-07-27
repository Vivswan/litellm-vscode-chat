import * as vscode from "vscode";
import { z } from "zod";
import type { Logger } from "../shared/logger";
import type { AggregatedStatus, ServerStatus } from "../shared/servers";
import { LAST_CONNECTION_STATUS_KEY } from "../shared/storageKeys";

export interface ConnectionStatus {
	state: "not-configured" | "loading" | "connected" | "degraded" | "error";
	totalModels?: number;
	serverStatuses?: ServerStatus[];
	error?: string;
	lastChecked?: string;
}

// Persisted statuses may come from other extension versions, so only the fields
// the status bar dispatches on are validated: unknown keys pass through and
// serverStatuses elements stay unchecked.
const connectionStatusSchema = z.looseObject({
	state: z.enum(["not-configured", "loading", "connected", "degraded", "error"]),
	serverStatuses: z.array(z.unknown()).optional(),
});

function isConnectionStatus(value: unknown): value is ConnectionStatus {
	return connectionStatusSchema.safeParse(value).success;
}

export class StatusBarManager {
	private _connectionStatus: ConnectionStatus = { state: "not-configured" };
	private readonly _statusBarItem: vscode.StatusBarItem;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly logger: Logger
	) {
		this._statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		this._statusBarItem.command = "litellm.openDashboard";
		context.subscriptions.push(this._statusBarItem);

		const lastStatus = context.globalState.get<unknown>(LAST_CONNECTION_STATUS_KEY);
		if (isConnectionStatus(lastStatus)) {
			this._connectionStatus = lastStatus;
		}
		// Rendering without an argument never persists, so nothing needs awaiting.
		void this.updateStatusBar();
	}

	get connectionStatus(): ConnectionStatus {
		return this._connectionStatus;
	}

	/** The command the status bar item runs on click; pinned by tests. */
	get clickCommand(): string | vscode.Command | undefined {
		return this._statusBarItem.command;
	}

	async updateStatusBar(status?: ConnectionStatus): Promise<void> {
		if (status) {
			this._connectionStatus = status;
			await this.context.globalState.update(LAST_CONNECTION_STATUS_KEY, status);
		}

		switch (this._connectionStatus.state) {
			case "not-configured":
				this._statusBarItem.text = "$(warning) LiteLLM";
				this._statusBarItem.tooltip = "Not configured - click to set up";
				this._statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
				break;
			case "loading":
				this._statusBarItem.text = "$(loading~spin) LiteLLM";
				this._statusBarItem.tooltip = "Fetching models...";
				this._statusBarItem.backgroundColor = undefined;
				break;
			case "connected": {
				const count = this._connectionStatus.totalModels ?? 0;
				const serverCount = this._connectionStatus.serverStatuses?.length ?? 0;
				const serverText = serverCount > 1 ? ` from ${serverCount} servers` : "";
				this._statusBarItem.text = `$(check) LiteLLM (${count})`;
				this._statusBarItem.tooltip = `${count} model${count === 1 ? "" : "s"} available${serverText}\nClick for diagnostics`;
				this._statusBarItem.backgroundColor = undefined;
				break;
			}
			case "degraded": {
				const count = this._connectionStatus.totalModels ?? 0;
				const statuses = this._connectionStatus.serverStatuses ?? [];
				const failedCount = statuses.filter((s) => s.state === "error").length;
				this._statusBarItem.text = `$(warning) LiteLLM (${count})`;
				this._statusBarItem.tooltip = `${count} model${count === 1 ? "" : "s"} available\n${failedCount} server${failedCount === 1 ? "" : "s"} unreachable\nClick for diagnostics`;
				this._statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
				break;
			}
			case "error":
				this._statusBarItem.text = "$(error) LiteLLM";
				this._statusBarItem.tooltip = `Connection failed\n${this._connectionStatus.error || "Unknown error"}\nClick for details`;
				this._statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
				break;
		}
		this._statusBarItem.show();
	}

	handleAggregatedStatus(aggStatus: AggregatedStatus): void {
		const now = new Date().toISOString();
		const { serverStatuses, totalModels } = aggStatus;

		if (serverStatuses.length === 0) {
			this.logger.log("No servers configured");
			void this.updateStatusBar({ state: "not-configured", lastChecked: now });
			return;
		}

		const okCount = serverStatuses.filter((s) => s.state === "ok").length;
		const errCount = serverStatuses.filter((s) => s.state === "error").length;

		if (okCount === 0) {
			const firstError = serverStatuses.find((s) => s.error)?.error ?? "All servers failed";
			this.logger.log(`All servers failed: ${firstError}`);
			void this.updateStatusBar({
				state: "error",
				error: firstError,
				serverStatuses,
				totalModels: 0,
				lastChecked: now,
			});
		} else if (errCount > 0) {
			this.logger.log(`Partial success: ${okCount} ok, ${errCount} failed, ${totalModels} models`);
			void this.updateStatusBar({
				state: "degraded",
				serverStatuses,
				totalModels,
				lastChecked: now,
			});
		} else if (totalModels === 0) {
			this.logger.log("Warning: All servers returned 0 models");
			void this.updateStatusBar({
				state: "error",
				error: "Servers returned 0 models",
				serverStatuses,
				totalModels: 0,
				lastChecked: now,
			});
		} else {
			this.logger.log(`Successfully fetched ${totalModels} models from ${okCount} server(s)`);
			void this.updateStatusBar({
				state: "connected",
				serverStatuses,
				totalModels,
				lastChecked: now,
			});
		}
	}
}
