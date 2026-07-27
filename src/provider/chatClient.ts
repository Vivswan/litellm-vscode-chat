import type { LanguageModelChatRequestMessage, ProvideLanguageModelChatResponseOptions } from "vscode";
import * as vscode from "vscode";
import type { Logger } from "../shared/logger";
import { convertMessages } from "../shared/messages";
import { applyPromptCacheBreakpoints } from "../shared/promptCache";
import type { ServerWithKey } from "../shared/servers";
import {
	getCustomHeaders,
	getDiscoveryTimeout,
	getRequestTimeout,
	isPromptCachingEnabled,
	type TokenDefaults,
} from "../shared/settings";
import { estimateMessagesTokens, estimateToolTokens } from "../shared/tokenEstimation";
import { convertTools } from "../shared/tools";
import { validateRequest } from "../shared/validation";
import { type OAuthConfig, OAuthTokenSource, type VirtualKeyConfig } from "./auth";
import { ServerClientCache } from "./clients";
import { resolveServer } from "./config";
import type { FetchModelsResult } from "./discovery";
import { fetchModels } from "./discovery";
import { mapSdkError, RequestError, timeoutMessage } from "./errorMapping";
import type { LiteLLMModelInfo } from "./groupModels";
import { getGroupServer, groupClientId, modelOutputLimitSource, modelSupportsPromptCaching } from "./groupModels";
import type { ModelRoute } from "./modelCatalog";
import { requestParamsFromModelConfiguration } from "./modelConfiguration";
import { buildRequestBody, DEFAULT_MAX_TOKENS_CAP, getModelParameters, MAX_TOOLS_PER_REQUEST } from "./request";
import type { ToolCallIdSource } from "./streaming";
import { StreamProcessor } from "./streaming";

export interface ChatRequestContext {
	model: LiteLLMModelInfo;
	messages: readonly LanguageModelChatRequestMessage[];
	options: ProvideLanguageModelChatResponseOptions;
	progress: vscode.Progress<vscode.LanguageModelResponsePart>;
	token: vscode.CancellationToken;
}

/**
 * A server to talk to: the registry fields plus the OAuth and virtual-key
 * credentials that only provider-group configurations can carry.
 */
export interface ServerConnection extends ServerWithKey {
	oauth?: OAuthConfig;
	virtualKey?: VirtualKeyConfig;
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
	private getMigratedServerLabels?: () => Record<string, string[]>;
	private readonly ambiguousLabelBaseUrls = new Set<string>();
	private readonly clients = new ServerClientCache();
	private readonly oauthTokens = new OAuthTokenSource();
	private readonly _modelRoutes = new Map<string, ModelRoute>();
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

	setMigratedServerLabelsProvider(getLabels: () => Record<string, string[]>): void {
		this.getMigratedServerLabels = getLabels;
	}

	/**
	 * The pre-migration label that pointed at this base URL, so label-scoped
	 * modelParameters keep matching. Only an unambiguous mapping applies: when
	 * several labels shared one base URL, their scoped entries would all hit
	 * every group at that URL, so label scoping is skipped (logged once per URL).
	 */
	private migratedLabelsFor(baseUrl: string): string[] {
		const map = this.getMigratedServerLabels?.() ?? {};
		const labels = Object.entries(map).find(([url]) => url.replace(/\/+$/, "") === baseUrl)?.[1] ?? [];
		if (labels.length > 1) {
			if (!this.ambiguousLabelBaseUrls.has(baseUrl)) {
				this.ambiguousLabelBaseUrls.add(baseUrl);
				this.log(
					`Skipping label-scoped modelParameters for ${baseUrl}: multiple pre-migration labels (${labels.join(", ")}) pointed at it; scope by base URL instead`
				);
			}
			return [];
		}
		return [...labels];
	}

	applyRegistration(routes: Map<string, ModelRoute>, clearFirst: boolean): void {
		if (clearFirst) {
			this._modelRoutes.clear();
		}
		for (const [k, v] of routes) {
			this._modelRoutes.set(k, v);
		}
	}

	/** Drop cached SDK clients for any server ID not in `keep`; the provider includes live group-client IDs. */
	pruneClients(serverIds: Iterable<string>): void {
		this.clients.prune(serverIds);
	}

	/** `tokenDefaults` is the caller's per-refresh snapshot; see FetchModelsRequest. */
	async fetchModels(server: ServerConnection, tokenDefaults: TokenDefaults): Promise<FetchModelsResult> {
		this.log("fetchModels called", { baseUrl: server.baseUrl, hasApiKey: !!server.apiKey, hasOAuth: !!server.oauth });
		const customHeaders = getCustomHeaders(this.log);
		const discoveryTimeout = getDiscoveryTimeout(this.log);
		const client = this.clients.get({
			serverId: server.id,
			baseUrl: server.baseUrl,
			apiKey: server.apiKey,
			userAgent: this.userAgent,
			customHeaders,
		});
		const headers = await this.resolveAuthHeaders(server, discoveryTimeout);
		try {
			return await fetchModels({
				client,
				baseUrl: server.baseUrl,
				discoveryTimeout,
				tokenDefaults,
				log: this.log,
				...(headers !== undefined ? { headers } : {}),
			});
		} catch (error) {
			this.invalidateRejectedToken(server.oauth, error, headers);
			throw error;
		}
	}

	/**
	 * Per-request credentials the cached SDK client cannot carry statically:
	 * the OAuth bearer token (short-lived, refreshed through the token cache)
	 * and the virtual-key header. The token exchange is bounded by the
	 * discovery timeout on every surface (it is auth plumbing, not a chat
	 * call) and additionally by `signal` when the triggering call carries one,
	 * so user cancellation and the chat timeout interrupt it too.
	 */
	private async resolveAuthHeaders(
		credentials: { oauth?: OAuthConfig | undefined; virtualKey?: VirtualKeyConfig | undefined },
		discoveryTimeout: number,
		signal?: AbortSignal
	): Promise<Record<string, string> | undefined> {
		const headers: Record<string, string> = {};
		if (credentials.oauth) {
			headers.Authorization = `Bearer ${await this.oauthTokens.getToken(credentials.oauth, discoveryTimeout, signal)}`;
		}
		if (credentials.virtualKey) {
			headers[credentials.virtualKey.header] = credentials.virtualKey.value;
		}
		return Object.keys(headers).length > 0 ? headers : undefined;
	}

	/**
	 * A 401 from the server means it no longer accepts the bearer token the
	 * call sent, so the next request must perform a fresh exchange. The
	 * rejected call itself is never retried (chat completions never retry).
	 * The sent token is passed along so a straggling 401 cannot discard a
	 * token that already replaced the rejected one.
	 */
	private invalidateRejectedToken(
		oauth: OAuthConfig | undefined,
		error: unknown,
		sentHeaders: Record<string, string> | undefined
	): void {
		if (!oauth || !(error instanceof RequestError) || error.kind !== "auth") {
			return;
		}
		const sentAuthorization = sentHeaders?.Authorization;
		const bearerPrefix = "Bearer ";
		const rejectedToken = sentAuthorization?.startsWith(bearerPrefix)
			? sentAuthorization.slice(bearerPrefix.length)
			: undefined;
		this.oauthTokens.invalidate(oauth, rejectedToken);
	}

	async send(ctx: ChatRequestContext): Promise<void> {
		const { model, messages, options, progress, token } = ctx;

		const groupServer = getGroupServer(model, this.log);
		const route = groupServer ? undefined : this._modelRoutes.get(model.id);
		let serverId: string;
		let baseUrl: string;
		let apiKey: string;
		let rawModelId: string;
		let serverScopes: readonly string[] = [];
		let oauth: OAuthConfig | undefined;
		let virtualKey: VirtualKeyConfig | undefined;

		if (groupServer) {
			serverId = groupClientId(groupServer);
			baseUrl = groupServer.baseUrl;
			apiKey = groupServer.apiKey;
			rawModelId = model.id;
			serverScopes = [baseUrl, ...this.migratedLabelsFor(baseUrl)];
			oauth = groupServer.oauth;
			virtualKey = groupServer.virtualKey;
		} else if (route) {
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
		const supportsPromptCaching = modelSupportsPromptCaching(model);
		const converted = convertMessages(messages, { log: this.log });
		validateRequest(messages);
		const toolConfig = convertTools(options);

		if (options.tools && options.tools.length > MAX_TOOLS_PER_REQUEST) {
			throw new Error(`Cannot have more than ${MAX_TOOLS_PER_REQUEST} tools per request.`);
		}

		const { messages: openaiMessages, tools } =
			promptCachingEnabled && supportsPromptCaching
				? applyPromptCacheBreakpoints({ messages: converted, tools: toolConfig.tools })
				: { messages: converted, tools: toolConfig.tools };

		const inputTokenCount = estimateMessagesTokens(messages, { includeMultimodal: false });
		const toolTokenCount = estimateToolTokens(toolConfig.tools);
		const tokenLimit = Math.max(1, model.maxInputTokens);
		if (inputTokenCount + toolTokenCount > tokenLimit) {
			throw new Error(
				`Message exceeds token limit (estimated ${inputTokenCount + toolTokenCount} tokens, limit ${tokenLimit}).`
			);
		}

		const modelParams = getModelParameters(model.id, this._modelRoutes, serverScopes);

		let maxTokens: number;
		if (typeof options.modelOptions?.max_tokens === "number") {
			maxTokens = options.modelOptions.max_tokens;
		} else if (typeof modelParams.max_tokens === "number") {
			maxTokens = modelParams.max_tokens;
		} else if (modelOutputLimitSource(model) === "provider") {
			// The server declared this limit, so it is honored as-is; the cap
			// below only guards the defaults-derived guess.
			maxTokens = model.maxOutputTokens;
		} else {
			maxTokens = Math.min(DEFAULT_MAX_TOKENS_CAP, model.maxOutputTokens);
		}

		const requestBody = buildRequestBody({
			rawModelId,
			openaiMessages,
			maxTokens,
			modelParams,
			toolConfig: { tools, tool_choice: toolConfig.tool_choice },
			modelConfiguration: requestParamsFromModelConfiguration(options.modelConfiguration),
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
		const requestSignal = AbortSignal.any([cancelController.signal, timeoutSignal]);
		const errorContext = { surface: "chat" as const, baseUrl, timeoutMs: requestTimeout };
		let authHeaders: Record<string, string> | undefined;

		try {
			authHeaders = await this.resolveAuthHeaders({ oauth, virtualKey }, getDiscoveryTimeout(this.log), requestSignal);
			const response = await client
				.post("/chat/completions", {
					body: requestBody,
					signal: requestSignal,
					timeout: requestTimeout,
					...(authHeaders !== undefined ? { headers: authHeaders } : {}),
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
			const mapped = mapSdkError(err, errorContext);
			this.invalidateRejectedToken(oauth, mapped, authHeaders);
			throw mapped;
		} finally {
			cancelListener.dispose();
		}
	}
}
