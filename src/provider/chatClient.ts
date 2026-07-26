import type {
	LanguageModelChatInformation,
	LanguageModelChatRequestMessage,
	ProvideLanguageModelChatResponseOptions,
} from "vscode";
import * as vscode from "vscode";
import type { Logger } from "../shared/logger";
import { convertMessages } from "../shared/messages";
import type { ServerWithKey } from "../shared/servers";
import { getCustomHeaders, getDiscoveryTimeout, getRequestTimeout, isPromptCachingEnabled } from "../shared/settings";
import { estimateMessagesTokens, estimateToolTokens } from "../shared/tokenEstimation";
import { convertTools } from "../shared/tools";
import { validateRequest } from "../shared/validation";
import { ServerClientCache } from "./clients";
import { resolveServer } from "./config";
import type { FetchModelsResult } from "./discovery";
import { fetchModels } from "./discovery";
import { mapSdkError, RequestError, timeoutMessage } from "./errorMapping";
import type { ModelRoute } from "./modelCatalog";
import { buildRequestBody, DEFAULT_MAX_TOKENS_CAP, getModelParameters, MAX_TOOLS_PER_REQUEST } from "./request";
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
	logger?: Logger | undefined;
}

/**
 * Owns the HTTP-facing side of the provider: model discovery, chat requests,
 * the model route and prompt-caching registries, and tool-call ID generation.
 */
export class ChatClient {
	private readonly userAgent: string;
	private readonly logger?: Logger | undefined;
	private getServers?: () => Promise<ServerWithKey[]>;
	private readonly clients = new ServerClientCache();
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

	/** Drop cached SDK clients for servers that no longer exist. */
	pruneClients(serverIds: Iterable<string>): void {
		this.clients.prune(serverIds);
	}

	async fetchModels(server: ServerWithKey): Promise<FetchModelsResult> {
		this.log("fetchModels called", { baseUrl: server.baseUrl, hasApiKey: !!server.apiKey });
		const customHeaders = getCustomHeaders(this.log);
		const discoveryTimeout = getDiscoveryTimeout(this.log);
		const client = this.clients.get({
			serverId: server.id,
			baseUrl: server.baseUrl,
			apiKey: server.apiKey,
			userAgent: this.userAgent,
			customHeaders,
		});
		return fetchModels({ client, baseUrl: server.baseUrl, discoveryTimeout, log: this.log });
	}

	async send(ctx: ChatRequestContext): Promise<void> {
		const { model, messages, options, progress, token } = ctx;

		const route = this._modelRoutes.get(model.id);
		let serverId: string;
		let baseUrl: string;
		let apiKey: string;
		let rawModelId: string;

		if (route) {
			const server = await resolveServer(route.serverId, this.getServers);
			if (server) {
				serverId = server.id;
				baseUrl = server.baseUrl;
				apiKey = server.apiKey;
			} else {
				throw new Error(`Server "${route.serverLabel}" is no longer configured`);
			}
			rawModelId = route.rawModelId;
		} else {
			const servers = this.getServers ? await this.getServers() : [];
			const [soleServer] = servers;
			if (servers.length === 1 && soleServer !== undefined) {
				serverId = soleServer.id;
				baseUrl = soleServer.baseUrl;
				apiKey = soleServer.apiKey;
				rawModelId = model.id;
			} else {
				throw new Error(
					`Model "${model.id}" is not registered with any configured server. Refresh the model list and try again.`
				);
			}
		}

		const promptCachingEnabled = isPromptCachingEnabled();
		const customHeaders = getCustomHeaders(this.log);
		const requestTimeout = getRequestTimeout(this.log);
		const supportsPromptCaching = this._promptCachingSupport.get(model.id) === true;
		const openaiMessages = convertMessages(messages, {
			cacheSystemPrompt: promptCachingEnabled && supportsPromptCaching,
			log: this.log,
		});
		validateRequest(messages);
		const toolConfig = convertTools(options);

		if (options.tools && options.tools.length > MAX_TOOLS_PER_REQUEST) {
			throw new Error(`Cannot have more than ${MAX_TOOLS_PER_REQUEST} tools per request.`);
		}

		const inputTokenCount = estimateMessagesTokens(messages, { includeMultimodal: false });
		const toolTokenCount = estimateToolTokens(toolConfig.tools);
		const tokenLimit = Math.max(1, model.maxInputTokens);
		if (inputTokenCount + toolTokenCount > tokenLimit) {
			throw new Error(
				`Message exceeds token limit (estimated ${inputTokenCount + toolTokenCount} tokens, limit ${tokenLimit}).`
			);
		}

		const modelParams = getModelParameters(model.id, this._modelRoutes);

		let maxTokens: number;
		if (typeof options.modelOptions?.max_tokens === "number") {
			maxTokens = options.modelOptions.max_tokens;
		} else if (typeof modelParams.max_tokens === "number") {
			maxTokens = modelParams.max_tokens;
		} else {
			maxTokens = Math.min(DEFAULT_MAX_TOKENS_CAP, model.maxOutputTokens);
		}

		const requestBody = buildRequestBody({
			rawModelId,
			openaiMessages,
			maxTokens,
			modelParams,
			toolConfig,
			modelOptions: options.modelOptions as Record<string, unknown> | undefined,
		});

		const client = this.clients.get({
			serverId,
			baseUrl,
			apiKey,
			userAgent: this.userAgent,
			customHeaders,
		});

		this.log("Sending chat request", {
			url: `${baseUrl}/v1/chat/completions`,
			modelId: rawModelId,
			messageCount: messages.length,
		});

		// User cancellation must abort the in-flight request, not just stop the
		// read loop, so the token is bridged onto an AbortController combined
		// with the request timeout. The per-request timeout keeps the SDK's own
		// 600 s time-to-headers default from cutting in before ours.
		const cancelController = new AbortController();
		const cancelListener = token.onCancellationRequested(() => cancelController.abort());
		const timeoutSignal = AbortSignal.timeout(requestTimeout);
		const errorContext = { surface: "chat" as const, baseUrl, timeoutMs: requestTimeout };

		try {
			const response = await client
				.post("/chat/completions", {
					body: requestBody,
					signal: AbortSignal.any([cancelController.signal, timeoutSignal]),
					timeout: requestTimeout,
				})
				.asResponse();

			if (!response.body) {
				throw new Error("No response body from LiteLLM API");
			}

			const streamProcessor = new StreamProcessor(this.toolCallIds, this.log);
			await streamProcessor.processStreamingResponse(response.body, progress, token);
		} catch (err) {
			if (token.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			if (timeoutSignal.aborted) {
				throw new RequestError(timeoutMessage(errorContext), "timeout", { cause: err });
			}
			throw mapSdkError(err, errorContext);
		} finally {
			cancelListener.dispose();
		}
	}
}
