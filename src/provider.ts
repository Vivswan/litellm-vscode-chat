import * as vscode from "vscode";
import {
	CancellationToken,
	LanguageModelChatInformation,
	LanguageModelChatRequestMessage,
	LanguageModelChatProvider,
	LanguageModelResponsePart,
	Progress,
	ProvideLanguageModelChatResponseOptions,
} from "vscode";

import type { IssueReporter } from "./issueReporter";
import type { ServerWithKey, ServerStatus } from "./extension/serverRegistry";
import type { ModelRoute } from "./provider/request";

import { fetchModels } from "./provider/discovery";
import { buildModelInfos } from "./provider/registration";
import { ensureServers } from "./provider/config";
import { sendChatRequest } from "./provider/client";

export interface AggregatedStatus {
	serverStatuses: ServerStatus[];
	totalModels: number;
}

export class LiteLLMChatModelProvider implements LanguageModelChatProvider {
	private _chatEndpoints: { model: string; modelMaxPromptTokens: number }[] = [];
	private _promptCachingSupport = new Map<string, boolean>();
	private _statusCallback?: (status: AggregatedStatus) => void;
	private _hasShownNoConfigNotification = false;
	private _toolCallIdCounter = 0;
	private _modelRoutes = new Map<string, ModelRoute>();
	private _getServers?: () => Promise<ServerWithKey[]>;

	constructor(
		private readonly secrets: vscode.SecretStorage,
		private readonly userAgent: string,
		private readonly outputChannel?: vscode.OutputChannel,
		private readonly issueReporter?: IssueReporter
	) {}

	setStatusCallback(callback: (status: AggregatedStatus) => void): void {
		this._statusCallback = callback;
	}

	setServerProvider(getServers: () => Promise<ServerWithKey[]>): void {
		this._getServers = getServers;
	}

	private log(message: string, data?: unknown): void {
		if (this.outputChannel) {
			const timestamp = new Date().toISOString();
			const line =
				data !== undefined
					? `[${timestamp}] ${message}: ${JSON.stringify(data, null, 2)}`
					: `[${timestamp}] ${message}`;
			this.outputChannel.appendLine(line);
			this.issueReporter?.appendLog(line);
		}
	}

	private logError(message: string, error: unknown): void {
		const errorMsg = error instanceof Error ? error.message : String(error);
		if (this.outputChannel) {
			const timestamp = new Date().toISOString();
			this.outputChannel.appendLine(`[${timestamp}] ERROR: ${message}: ${errorMsg}`);
			this.issueReporter?.appendLog(`[${timestamp}] ERROR: ${message}: ${errorMsg}`);
			if (error instanceof Error && error.stack) {
				this.outputChannel.appendLine(`Stack trace: ${error.stack}`);
			}
		}
		this.issueReporter?.recordError(message, error);
	}

	async prepareLanguageModelChatInformation(
		options: { silent: boolean },
		_token: CancellationToken
	): Promise<LanguageModelChatInformation[]> {
		this.log("prepareLanguageModelChatInformation called", { silent: options.silent });

		const servers = await ensureServers(options.silent, this._getServers, this.secrets);
		if (!servers || servers.length === 0) {
			this.log("No servers configured, returning empty array");

			if (options.silent && !this._hasShownNoConfigNotification) {
				this._hasShownNoConfigNotification = true;
				vscode.window
					.showWarningMessage("LiteLLM: No servers configured. Click to configure.", "Configure Now", "Dismiss")
					.then((choice) => {
						if (choice === "Configure Now") {
							vscode.commands.executeCommand("litellm.manage");
						}
					});
			}

			if (this._statusCallback) {
				this._statusCallback({ serverStatuses: [], totalModels: 0 });
			}
			return [];
		}

		this.log("Fetching models from servers", { count: servers.length, labels: servers.map((s) => s.label) });

		const settings = vscode.workspace.getConfiguration("litellm-vscode-chat");
		const discoveryTimeout = settings.get<number>("discoveryTimeout", 30000);

		const results = await Promise.allSettled(
			servers.map(async (server) => {
				const result = await fetchModels(
					server.apiKey,
					server.baseUrl,
					this.userAgent,
					(msg, data) => this.log(msg, data),
					(msg, err) => this.logError(msg, err),
					discoveryTimeout
				);
				return { server, models: result.models };
			})
		);

		const serverStatuses: ServerStatus[] = [];
		const allInfos: LanguageModelChatInformation[] = [];

		const successfulCount = results.filter((r) => r.status === "fulfilled").length;
		const serverCount = servers.length;

		if (successfulCount > 0) {
			this._modelRoutes.clear();
			this._promptCachingSupport.clear();
		}

		for (let i = 0; i < results.length; i++) {
			const result = results[i];
			const server = servers[i];

			if (result.status === "rejected") {
				const errorMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
				this.logError(`Failed to fetch models from server "${server.label}"`, result.reason);
				serverStatuses.push({
					serverId: server.id,
					label: server.label,
					baseUrl: server.baseUrl,
					state: "error",
					modelCount: 0,
					error: errorMsg,
					lastChecked: new Date().toISOString(),
				});
				continue;
			}

			const { models } = result.value;
			this.log(`Server "${server.label}" returned ${models.length} models`);

			const reg = buildModelInfos(models, server, serverCount, (msg) => this.log(msg));
			allInfos.push(...reg.infos);
			for (const [k, v] of reg.routes) {
				this._modelRoutes.set(k, v);
			}
			for (const [k, v] of reg.promptCaching) {
				this._promptCachingSupport.set(k, v);
			}

			serverStatuses.push({
				serverId: server.id,
				label: server.label,
				baseUrl: server.baseUrl,
				state: "ok",
				modelCount: reg.infos.length,
				lastChecked: new Date().toISOString(),
			});
		}

		this._chatEndpoints = allInfos.map((info) => ({
			model: info.id,
			modelMaxPromptTokens: info.maxInputTokens + info.maxOutputTokens,
		}));

		this.log("Final model count:", allInfos.length);

		if (this._statusCallback) {
			this._statusCallback({ serverStatuses, totalModels: allInfos.length });
		}

		if (allInfos.length === 0 && successfulCount > 0) {
			vscode.window
				.showWarningMessage(
					"LiteLLM: Your servers returned no models. Check your LiteLLM proxy configuration.",
					"Check Server",
					"Reconfigure",
					"Report Issue"
				)
				.then((choice) => {
					if (choice === "Check Server") {
						vscode.commands.executeCommand("litellm.testConnection");
					} else if (choice === "Reconfigure") {
						vscode.commands.executeCommand("litellm.manage");
					} else if (choice === "Report Issue") {
						vscode.commands.executeCommand("litellm.reportIssue");
					}
				});
		}

		if (successfulCount === 0 && servers.length > 0) {
			const firstError = serverStatuses.find((s) => s.error)?.error ?? "Unknown error";
			if (options.silent) {
				vscode.window
					.showErrorMessage(`LiteLLM: ${firstError}`, "Reconfigure", "Report Issue", "Dismiss")
					.then((choice) => {
						if (choice === "Reconfigure") {
							vscode.commands.executeCommand("litellm.manage");
						} else if (choice === "Report Issue") {
							vscode.commands.executeCommand("litellm.reportIssue");
						}
					});
				return [];
			}
			throw new Error(firstError);
		}

		return allInfos;
	}

	async provideLanguageModelChatInformation(
		options: { silent: boolean },
		_token: CancellationToken
	): Promise<LanguageModelChatInformation[]> {
		return this.prepareLanguageModelChatInformation({ silent: options.silent ?? false }, _token);
	}

	async provideLanguageModelChatResponse(
		model: LanguageModelChatInformation,
		messages: readonly LanguageModelChatRequestMessage[],
		options: ProvideLanguageModelChatResponseOptions,
		progress: Progress<LanguageModelResponsePart>,
		token: CancellationToken
	): Promise<void> {
		const trackingProgress: Progress<LanguageModelResponsePart> = {
			report: (part) => {
				try {
					progress.report(part);
				} catch (e) {
					this.logError("Progress.report failed", e);
				}
			},
		};
		try {
			this._toolCallIdCounter = await sendChatRequest(
				{ model, messages, options, progress: trackingProgress, token },
				this._modelRoutes,
				this._promptCachingSupport,
				this._getServers,
				this.secrets,
				this.userAgent,
				this._toolCallIdCounter,
				(msg, data) => this.log(msg, data),
				(msg, err) => this.logError(msg, err)
			);
		} catch (err) {
			this.logError("Chat request failed", err);
			throw err;
		}
	}

	async provideTokenCount(
		_model: LanguageModelChatInformation,
		text: string | LanguageModelChatRequestMessage,
		_token: CancellationToken
	): Promise<number> {
		if (typeof text === "string") {
			return Math.ceil(text.length / 4);
		} else {
			let totalTokens = 0;
			for (const part of text.content) {
				if (part instanceof vscode.LanguageModelTextPart) {
					totalTokens += Math.ceil(part.value.length / 4);
				} else if (part instanceof vscode.LanguageModelDataPart) {
					const mime = part.mimeType.toLowerCase();
					if (mime.startsWith("image/")) {
						totalTokens += 765;
					} else if (mime === "application/pdf") {
						totalTokens += 500;
					} else if (mime.startsWith("text/") || mime === "application/json" || mime.endsWith("+json")) {
						totalTokens += Math.ceil(part.data.length / 4);
					}
				}
			}
			return totalTokens;
		}
	}
}
