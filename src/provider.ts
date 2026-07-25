import type {
	CancellationToken,
	LanguageModelChatInformation,
	LanguageModelChatProvider,
	LanguageModelChatRequestMessage,
	LanguageModelResponsePart,
	Progress,
	ProvideLanguageModelChatResponseOptions,
} from "vscode";
import * as vscode from "vscode";
import type { ServerStatus, ServerWithKey } from "./extension/serverRegistry";
import type { IssueReporter } from "./issueReporter";
import { sendChatRequest } from "./provider/client";
import type { ConfigurationPrompt } from "./provider/config";
import { ensureServers } from "./provider/config";
import { fetchModels } from "./provider/discovery";
import { getCustomHeaders } from "./provider/httpHeaders";
import { buildModelInfos } from "./provider/registration";
import type { ModelRoute } from "./provider/request";

export interface AggregatedStatus {
	serverStatuses: ServerStatus[];
	totalModels: number;
	silent: boolean;
}

export class LiteLLMChatModelProvider implements LanguageModelChatProvider {
	private _promptCachingSupport = new Map<string, boolean>();
	private _statusCallback?: (status: AggregatedStatus) => void;
	private _toolCallIdCounter = 0;
	private _modelRoutes = new Map<string, ModelRoute>();
	private _getServers?: () => Promise<ServerWithKey[]>;
	private _configurationPrompt?: ConfigurationPrompt;

	constructor(
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

	setConfigurationPrompt(prompt: ConfigurationPrompt): void {
		this._configurationPrompt = prompt;
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

		const servers = await ensureServers(options.silent, this._getServers, this._configurationPrompt);
		if (!servers || servers.length === 0) {
			this.log("No servers configured, returning empty array");

			if (this._statusCallback) {
				this._statusCallback({ serverStatuses: [], totalModels: 0, silent: options.silent });
			}
			return [];
		}

		this.log("Fetching models from servers", { count: servers.length, labels: servers.map((s) => s.label) });

		const settings = vscode.workspace.getConfiguration("litellm-vscode-chat");
		const rawDiscoveryTimeout = settings.get<number>("discoveryTimeout", 30000);
		const customHeaders = getCustomHeaders((msg, data) => this.log(msg, data));
		// Validate and clamp discoveryTimeout to minimum 1000ms
		const discoveryTimeout = Math.max(1000, Number.isFinite(rawDiscoveryTimeout) ? rawDiscoveryTimeout : 30000);
		if (rawDiscoveryTimeout !== discoveryTimeout) {
			this.log("Invalid discoveryTimeout configuration, using clamped value", {
				configured: rawDiscoveryTimeout,
				clamped: discoveryTimeout,
			});
		}

		const results = await Promise.allSettled(
			servers.map(async (server) => {
				const result = await fetchModels(
					server.apiKey,
					server.baseUrl,
					this.userAgent,
					(msg, data) => this.log(msg, data),
					(msg, err) => this.logError(msg, err),
					customHeaders,
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

		this.log("Final model count:", allInfos.length);

		if (this._statusCallback) {
			this._statusCallback({ serverStatuses, totalModels: allInfos.length, silent: options.silent });
		}

		if (successfulCount === 0 && servers.length > 0) {
			if (options.silent) {
				return [];
			}
			const firstError = serverStatuses.find((s) => s.error)?.error ?? "Unknown error";
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
