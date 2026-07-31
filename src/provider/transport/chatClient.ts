import type { LanguageModelChatRequestMessage, ProvideLanguageModelChatResponseOptions } from "vscode";
import * as vscode from "vscode";
import { normalizeBaseUrl } from "../../shared/baseUrl";
import { convertMessages } from "../../shared/conversion/messages";
import { applyPromptCacheBreakpoints } from "../../shared/conversion/promptCache";
import { estimateMessagesTokens, estimateToolTokens } from "../../shared/conversion/tokenEstimation";
import { convertTools } from "../../shared/conversion/tools";
import { isRecord } from "../../shared/json";
import type { Logger } from "../../shared/logger";
import type { ServerWithKey } from "../../shared/servers";
import {
	getCustomHeaders,
	getDiscoveryTimeout,
	getRequestTimeout,
	isPromptCachingEnabled,
	type TokenDefaults,
} from "../../shared/settings";
import { validateRequest } from "../../shared/validation";
import type { FetchModelsResult } from "../catalog/discovery";
import { fetchModels } from "../catalog/discovery";
import type { GroupServer, LiteLLMModelInfo } from "../catalog/groupModels";
import { groupClientId, parseModelMetadata } from "../catalog/groupModels";
import type { ModelRoute } from "../catalog/modelCatalog";
import { requestParamsFromModelConfiguration } from "../catalog/modelConfiguration";
import { resolveServer } from "../config";
import { type OAuthConfig, OAuthTokenSource, type VirtualKeyConfig } from "./auth";
import { CHAT_COMPLETIONS_PATH, chatCompletionsUrl, ServerClientCache } from "./clients";
import { mapSdkError, RequestError, timeoutMessage } from "./errorMapping";
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

/**
 * Everything one chat request needs to reach its server, resolved in full
 * before anything is sent. Every field is required (undefined must be stated,
 * not omitted), so a resolution branch cannot silently drop the credentials
 * or scopes another branch carries.
 */
interface ResolvedConnection {
	serverId: string;
	baseUrl: string;
	apiKey: string;
	rawModelId: string;
	/** Scopes for modelParameters matching: the server's normalized base URL. */
	serverScopes: readonly string[];
	oauth: OAuthConfig | undefined;
	virtualKey: VirtualKeyConfig | undefined;
}

export interface ChatClientOptions {
	userAgent: string;
	logger?: Logger | undefined;
	/** Resolves the legacy registry's servers; defaults to none for hosts that only serve provider groups. */
	getServers?: (() => Promise<ServerWithKey[]>) | undefined;
	/**
	 * Resolves a declared server entry's per-entry modelParameters by its label
	 * at request time; injected by the extension layer (the setting lives on
	 * its side of the boundary). Defaults to none: models without an attached
	 * labeled server (external groups, registry-path models) get only the
	 * global modelParameters.
	 */
	getEntryModelParameters?:
		| ((label: string) => Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined)
		| undefined;
}

/**
 * Owns the HTTP-facing side of the provider: model discovery, chat requests,
 * the model route and prompt-caching registries, and tool-call ID generation.
 */
export class ChatClient {
	private readonly userAgent: string;
	private readonly logger?: Logger | undefined;
	private readonly getServers: () => Promise<ServerWithKey[]>;
	private readonly getEntryModelParameters: (
		label: string
	) => Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined;
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
		this.getServers = options.getServers ?? (() => Promise.resolve([]));
		this.getEntryModelParameters = options.getEntryModelParameters ?? (() => undefined);
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
		const { headers, sentOAuthToken } = await this.resolveAuthHeaders(server, discoveryTimeout);
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
			this.invalidateRejectedToken(server.oauth, error, sentOAuthToken);
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
	 *
	 * `sentOAuthToken` is the bearer token the returned headers actually
	 * carry, captured here so a later 401 never has to re-parse it out of the
	 * Authorization header (drift between writing and stripping the scheme
	 * would silently degrade the straggling-401 protection). When the virtual
	 * key owns the Authorization header no token is exchanged or sent, and
	 * the field is undefined.
	 */
	private async resolveAuthHeaders(
		credentials: { oauth?: OAuthConfig | undefined; virtualKey?: VirtualKeyConfig | undefined },
		discoveryTimeout: number,
		signal?: AbortSignal
	): Promise<{ headers: Record<string, string> | undefined; sentOAuthToken: string | undefined }> {
		const headers: Record<string, string> = {};
		let sentOAuthToken: string | undefined;
		// A virtual key naming the Authorization header (any casing; HTTP header
		// names are case-insensitive) owns it outright, so the token exchange is
		// skipped entirely: the token could never be sent, and an unreachable
		// identity provider must not fail a request that would not carry it.
		const authorizationOverridden = credentials.virtualKey?.header.toLowerCase() === "authorization";
		if (credentials.oauth && !authorizationOverridden) {
			sentOAuthToken = await this.oauthTokens.getToken(credentials.oauth, discoveryTimeout, signal);
			headers.Authorization = `Bearer ${sentOAuthToken}`;
		}
		if (credentials.virtualKey) {
			headers[credentials.virtualKey.header] = credentials.virtualKey.value;
		}
		return { headers: Object.keys(headers).length > 0 ? headers : undefined, sentOAuthToken };
	}

	/**
	 * A 401 from the server means it no longer accepts the bearer token the
	 * call sent, so the next request must perform a fresh exchange. The
	 * rejected call itself is never retried (chat completions never retry).
	 * `sentOAuthToken` is resolveAuthHeaders' capture of what actually went
	 * out: a straggling 401 cannot discard a token that already replaced the
	 * rejected one, and a request whose Authorization header the virtual key
	 * replaced (no token on the wire) invalidates nothing.
	 */
	private invalidateRejectedToken(
		oauth: OAuthConfig | undefined,
		error: unknown,
		sentOAuthToken: string | undefined
	): void {
		if (!oauth || sentOAuthToken === undefined || !(error instanceof RequestError) || error.kind !== "auth") {
			return;
		}
		this.oauthTokens.invalidate(oauth, sentOAuthToken);
	}

	/**
	 * Resolve the complete connection for one chat request. Three sources, in
	 * priority order: the group server attached to the model object, the route
	 * registered at discovery time, and (for configuration-less hosts with
	 * exactly one registry server) that sole server. Each branch states every
	 * ResolvedConnection field, so none can silently drop credentials.
	 */
	private async resolveConnection(
		model: LiteLLMModelInfo,
		groupServer: GroupServer | undefined
	): Promise<ResolvedConnection> {
		if (groupServer) {
			return {
				serverId: groupClientId(groupServer),
				baseUrl: groupServer.baseUrl,
				apiKey: groupServer.apiKey,
				rawModelId: model.id,
				serverScopes: [groupServer.baseUrl],
				oauth: groupServer.oauth,
				virtualKey: groupServer.virtualKey,
			};
		}
		const route = this._modelRoutes.get(model.id);
		if (route) {
			const server = await resolveServer(route.serverId, this.getServers);
			if (!server) {
				throw new Error(`Server "${route.serverLabel}" is no longer configured`);
			}
			return {
				serverId: server.id,
				baseUrl: server.baseUrl,
				apiKey: server.apiKey,
				rawModelId: route.rawModelId,
				serverScopes: [normalizeBaseUrl(server.baseUrl)],
				oauth: undefined,
				virtualKey: undefined,
			};
		}
		const servers = await this.getServers();
		const [soleServer] = servers;
		if (servers.length === 1 && soleServer !== undefined) {
			return {
				serverId: soleServer.id,
				baseUrl: soleServer.baseUrl,
				apiKey: soleServer.apiKey,
				rawModelId: model.id,
				serverScopes: [normalizeBaseUrl(soleServer.baseUrl)],
				oauth: undefined,
				virtualKey: undefined,
			};
		}
		throw new Error(
			`Model "${model.id}" is not registered with any configured server. Refresh the model list and try again.`
		);
	}

	async send(ctx: ChatRequestContext): Promise<void> {
		const { model, messages, options, progress, token } = ctx;

		// The one parse of the model object's LiteLLM metadata; everything below
		// reads the parsed result instead of re-narrowing the host round trip.
		const metadata = parseModelMetadata(model, this.log);
		const connection = await this.resolveConnection(model, metadata.server);

		const promptCachingEnabled = isPromptCachingEnabled();
		const customHeaders = getCustomHeaders(this.log);
		const requestTimeout = getRequestTimeout(this.log);
		// Capability gates for message conversion and token estimation, both
		// re-narrowed at the host boundary by parseModelMetadata: the registered
		// imageInput capability decides whether image DataParts ride the wire,
		// and the LiteLLM-derived audio metadata decides whether audio DataParts
		// become input_audio. The pre-send limit check below prices the prompt
		// under the same gates, so it counts the same transmitted forms the
		// request carries.
		const wireGates = { imageInput: metadata.imageInput, audioInput: metadata.supportsAudioInput };
		const converted = convertMessages(messages, { log: this.log, ...wireGates });
		validateRequest(messages);
		const toolConfig = convertTools(options);

		if (options.tools && options.tools.length > MAX_TOOLS_PER_REQUEST) {
			throw new Error(`Cannot have more than ${MAX_TOOLS_PER_REQUEST} tools per request.`);
		}

		const { messages: openaiMessages, tools: cachedTools } =
			promptCachingEnabled && metadata.supportsPromptCaching
				? applyPromptCacheBreakpoints({ messages: converted, tools: toolConfig?.tools })
				: { messages: converted, tools: toolConfig?.tools };

		const inputTokenCount = estimateMessagesTokens(messages, wireGates);
		const toolTokenCount = estimateToolTokens(toolConfig?.tools);
		const tokenLimit = Math.max(1, model.maxInputTokens);
		if (inputTokenCount + toolTokenCount > tokenLimit) {
			throw new Error(
				`Message exceeds token limit (estimated ${inputTokenCount + toolTokenCount} tokens, limit ${tokenLimit}).`
			);
		}

		// The attached server's label names the declared settings entry this
		// request is routed through (two entries may share a base URL; the label
		// is what tells them apart). Its per-entry modelParameters merge over the
		// global setting's match inside getModelParameters; unlabeled servers
		// (external groups, pre-label groups, registry models) contribute none.
		// The label alone is the entry identity: the base URL is deliberately
		// not cross-checked, because the host cannot update an existing group's
		// URL, so after a user edits an entry's baseUrl a strict check would
		// silently drop the entry's parameters until the group is recreated.
		const entryModelParameters =
			metadata.server?.label !== undefined ? this.getEntryModelParameters(metadata.server.label) : undefined;
		const modelParams = getModelParameters(model.id, this._modelRoutes, connection.serverScopes, entryModelParameters);

		let maxTokens: number;
		if (typeof options.modelOptions?.max_tokens === "number") {
			maxTokens = options.modelOptions.max_tokens;
		} else if (typeof modelParams.max_tokens === "number") {
			maxTokens = modelParams.max_tokens;
		} else if (metadata.outputLimitSource === "provider") {
			// The server declared this limit, so it is honored as-is; the cap
			// below only guards the defaults-derived guess.
			maxTokens = model.maxOutputTokens;
		} else {
			maxTokens = Math.min(DEFAULT_MAX_TOKENS_CAP, model.maxOutputTokens);
		}

		const requestBody = buildRequestBody({
			rawModelId: connection.rawModelId,
			openaiMessages,
			maxTokens,
			modelParams,
			toolConfig: toolConfig && { tools: cachedTools ?? toolConfig.tools, tool_choice: toolConfig.tool_choice },
			modelConfiguration: requestParamsFromModelConfiguration(options.modelConfiguration),
			modelOptions: options.modelOptions as Record<string, unknown> | undefined,
		});

		const client = this.clients.get({
			serverId: connection.serverId,
			baseUrl: connection.baseUrl,
			apiKey: connection.apiKey,
			userAgent: this.userAgent,
			customHeaders,
		});

		this.log("Sending chat request", {
			url: chatCompletionsUrl(connection.baseUrl),
			modelId: connection.rawModelId,
			messageCount: messages.length,
		});

		// User cancellation must abort the in-flight request, not just stop the
		// read loop, so the token is bridged onto an AbortController combined
		// with the request timeout. The per-request timeout keeps the SDK's own
		// 600 s time-to-headers default from cutting in before ours; the
		// AbortSignal.timeout below is what bounds the whole call, including a
		// stream that stalls after headers (the SDK disarms its timer once
		// headers arrive).
		const cancelController = new AbortController();
		const cancelListener = token.onCancellationRequested(() => cancelController.abort());
		const timeoutSignal = AbortSignal.timeout(requestTimeout);
		const requestSignal = AbortSignal.any([cancelController.signal, timeoutSignal]);
		const errorContext = { surface: "chat" as const, baseUrl: connection.baseUrl, timeoutMs: requestTimeout };
		let sentOAuthToken: string | undefined;

		try {
			const resolvedAuth = await this.resolveAuthHeaders(
				{ oauth: connection.oauth, virtualKey: connection.virtualKey },
				getDiscoveryTimeout(this.log),
				requestSignal
			);
			sentOAuthToken = resolvedAuth.sentOAuthToken;
			const response = await client
				.post(CHAT_COMPLETIONS_PATH, {
					body: requestBody,
					signal: requestSignal,
					timeout: requestTimeout,
					...(resolvedAuth.headers !== undefined ? { headers: resolvedAuth.headers } : {}),
				})
				.asResponse();

			if (!response.body) {
				throw new Error("No response body from LiteLLM API");
			}

			// The user-set audio.format parameter (when a modality-audio request
			// declares one) is the only statement of the clip encoding; the
			// stream processor stamps the matching mime on emitted audio parts.
			const audio = requestBody.audio;
			const requestAudioFormat = isRecord(audio) && typeof audio.format === "string" ? audio.format : undefined;
			const streamProcessor = new StreamProcessor(this.toolCallIds, this.log, undefined, undefined, requestAudioFormat);
			await streamProcessor.processStreamingResponse(response.body, progress, token);
		} catch (err) {
			if (token.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			if (timeoutSignal.aborted) {
				throw new RequestError(timeoutMessage(errorContext), "timeout", { cause: err });
			}
			const mapped = mapSdkError(err, errorContext);
			this.invalidateRejectedToken(connection.oauth, mapped, sentOAuthToken);
			throw mapped;
		} finally {
			cancelListener.dispose();
		}
	}
}
