import type {
	LanguageModelChatInformation,
	LanguageModelChatRequestMessage,
	ProvideLanguageModelChatResponseOptions,
} from "vscode";
import * as vscode from "vscode";
import type { Logger } from "../shared/logger";
import { convertMessages } from "../shared/messages";
import type { ServerWithKey } from "../shared/servers";
import { convertTools } from "../shared/tools";
import { validateRequest } from "../shared/validation";
import { resolveServer } from "./config";
import type { FetchModelsResult } from "./discovery";
import { fetchModels } from "./discovery";
import { getCustomHeaders } from "./httpHeaders";
import type { ModelRoute } from "./request";
import { buildRequestBody, estimateMessagesTokens, estimateToolTokens, getModelParameters } from "./request";
import type { ToolCallIdSource } from "./streaming";
import { StreamProcessor } from "./streaming";

export interface ChatRequestContext {
	model: LanguageModelChatInformation;
	messages: readonly LanguageModelChatRequestMessage[];
	options: ProvideLanguageModelChatResponseOptions;
	progress: vscode.Progress<vscode.LanguageModelResponsePart>;
	token: vscode.CancellationToken;
}

export interface ChatClientOptions {
	userAgent: string;
	logger?: Logger;
}

/**
 * Owns the HTTP-facing side of the provider: model discovery, chat requests,
 * the model route and prompt-caching registries, and tool-call ID generation.
 */
export class ChatClient {
	private readonly userAgent: string;
	private readonly logger?: Logger;
	private getServers?: () => Promise<ServerWithKey[]>;
	private readonly _modelRoutes = new Map<string, ModelRoute>();
	private readonly _promptCachingSupport = new Map<string, boolean>();
	private _toolCallIdCounter = 0;
	// The single owner of tool-call ID generation. next() advances the counter
	// synchronously at the moment an ID is handed out, so overlapping requests
	// share the sequence without ever minting duplicates.
	private readonly toolCallIds: ToolCallIdSource = { next: () => ++this._toolCallIdCounter };

	private readonly log = (message: string, data?: unknown): void => {
		this.logger?.log(message, data);
	};
	private readonly logError = (message: string, error: unknown): void => {
		this.logger?.error(message, error);
	};

	constructor(options: ChatClientOptions) {
		this.userAgent = options.userAgent;
		this.logger = options.logger;
	}

	setServerProvider(getServers: () => Promise<ServerWithKey[]>): void {
		this.getServers = getServers;
	}

	applyRegistration(routes: Map<string, ModelRoute>, promptCaching: Map<string, boolean>, clearFirst: boolean): void {
		if (clearFirst) {
			this._modelRoutes.clear();
			this._promptCachingSupport.clear();
		}
		for (const [k, v] of routes) {
			this._modelRoutes.set(k, v);
		}
		for (const [k, v] of promptCaching) {
			this._promptCachingSupport.set(k, v);
		}
	}

	async fetchModels(server: ServerWithKey): Promise<FetchModelsResult> {
		const settings = vscode.workspace.getConfiguration("litellm-vscode-chat");
		const rawDiscoveryTimeout = settings.get<number>("discoveryTimeout", 30000);
		const customHeaders = getCustomHeaders(this.log);
		// Validate and clamp discoveryTimeout to minimum 1000ms
		const discoveryTimeout = Math.max(1000, Number.isFinite(rawDiscoveryTimeout) ? rawDiscoveryTimeout : 30000);
		if (rawDiscoveryTimeout !== discoveryTimeout) {
			this.log("Invalid discoveryTimeout configuration, using clamped value", {
				configured: rawDiscoveryTimeout,
				clamped: discoveryTimeout,
			});
		}
		return fetchModels({
			server,
			userAgent: this.userAgent,
			customHeaders,
			discoveryTimeout,
			log: this.log,
			logError: this.logError,
		});
	}

	async send(ctx: ChatRequestContext): Promise<void> {
		const { model, messages, options, progress, token } = ctx;

		const route = this._modelRoutes.get(model.id);
		let baseUrl: string;
		let apiKey: string;
		let rawModelId: string;

		if (route) {
			const server = await resolveServer(route.serverId, this.getServers);
			if (server) {
				baseUrl = server.baseUrl;
				apiKey = server.apiKey;
			} else {
				throw new Error(`Server "${route.serverLabel}" is no longer configured`);
			}
			rawModelId = route.rawModelId;
		} else {
			const servers = this.getServers ? await this.getServers() : [];
			if (servers.length === 1) {
				baseUrl = servers[0].baseUrl;
				apiKey = servers[0].apiKey;
				rawModelId = model.id;
			} else {
				throw new Error(
					`Model "${model.id}" is not registered with any configured server. Refresh the model list and try again.`
				);
			}
		}

		const settings = vscode.workspace.getConfiguration("litellm-vscode-chat");
		const promptCachingEnabled = settings.get<boolean>("promptCaching.enabled", true);
		const customHeaders = getCustomHeaders(this.log);
		const rawRequestTimeout = settings.get<number>("requestTimeout", 300000);
		// Validate and clamp requestTimeout to minimum 1000ms
		const requestTimeout = Math.max(1000, Number.isFinite(rawRequestTimeout) ? rawRequestTimeout : 300000);
		if (rawRequestTimeout !== requestTimeout) {
			this.log("Invalid requestTimeout configuration, using clamped value", {
				configured: rawRequestTimeout,
				clamped: requestTimeout,
			});
		}
		const supportsPromptCaching = this._promptCachingSupport.get(model.id) === true;
		const openaiMessages = convertMessages(messages, {
			cacheSystemPrompt: promptCachingEnabled && supportsPromptCaching,
		});
		validateRequest(messages);
		const toolConfig = convertTools(options);

		if (options.tools && options.tools.length > 128) {
			throw new Error("Cannot have more than 128 tools per request.");
		}

		const inputTokenCount = estimateMessagesTokens(messages);
		const toolTokenCount = estimateToolTokens(toolConfig.tools);
		const tokenLimit = Math.max(1, model.maxInputTokens);
		if (inputTokenCount + toolTokenCount > tokenLimit) {
			this.logError("Message exceeds token limit", { total: inputTokenCount + toolTokenCount, tokenLimit });
			throw new Error("Message exceeds token limit.");
		}

		const modelParams = getModelParameters(model.id, this._modelRoutes);

		let maxTokens: number;
		if (typeof options.modelOptions?.max_tokens === "number") {
			maxTokens = options.modelOptions.max_tokens;
		} else if (typeof modelParams.max_tokens === "number") {
			maxTokens = modelParams.max_tokens;
		} else {
			maxTokens = Math.min(4096, model.maxOutputTokens);
		}

		const requestBody = buildRequestBody({
			rawModelId,
			openaiMessages,
			maxTokens,
			modelParams,
			toolConfig,
			modelOptions: options.modelOptions as Record<string, unknown> | undefined,
		});

		const headers: Record<string, string> = {
			...customHeaders,
			"Content-Type": "application/json",
			"User-Agent": this.userAgent,
		};
		if (apiKey) {
			headers.Authorization = `Bearer ${apiKey}`;
			headers["X-API-Key"] = apiKey;
		}

		this.log("Sending chat request", {
			url: `${baseUrl}/v1/chat/completions`,
			modelId: rawModelId,
			messageCount: messages.length,
		});

		const response = await fetch(`${baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers,
			body: JSON.stringify(requestBody),
			signal: AbortSignal.timeout(requestTimeout),
		});

		if (!response.ok) {
			const errorText = await response.text();
			this.logError("API error response", errorText);

			if (response.status === 401) {
				throw new Error(
					`Authentication failed: Your LiteLLM server requires an API key. Please run the "Manage LiteLLM Provider" command to configure your API key.`
				);
			}

			throw new Error(
				`LiteLLM API error: ${response.status} ${response.statusText}${errorText ? `\n${errorText}` : ""}`
			);
		}

		if (!response.body) {
			throw new Error("No response body from LiteLLM API");
		}

		const streamProcessor = new StreamProcessor(this.toolCallIds, this.log);
		await streamProcessor.processStreamingResponse(response.body, progress, token);
	}
}
