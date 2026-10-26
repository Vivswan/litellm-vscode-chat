import * as l10n from "@vscode/l10n";
import type { LanguageModelChatRequestMessage, ProvideLanguageModelChatResponseOptions } from "vscode";
import * as vscode from "vscode";
import { resolveMaxTokens } from "../../shared/config/parameterResolution";
import { ModelResolutionTable } from "../../shared/config/resolutionTable";
import { SESSION_ID_HEADER_NAME } from "../../shared/config/sessionId";
import {
	getAdditionalToolSchemaKeywords,
	getDiscoveryTimeout,
	getMaxToolsPerRequest,
	getModelParametersConfig,
	getRequestTimeout,
	isPromptCachingEnabled,
} from "../../shared/config/settings";
import { convertMessages } from "../../shared/conversion/messages";
import { applyPromptCacheBreakpoints } from "../../shared/conversion/promptCache";
import { estimateToolTokens, estimateWireMessagesTokens } from "../../shared/conversion/tokenEstimation";
import { convertTools, type ToolConfig } from "../../shared/conversion/tools";
import type { OpenAIChatMessage } from "../../shared/conversion/wire";
import type { Logger } from "../../shared/logger";
import { chatErrorMessage, englishChatErrorMessage, localizedError } from "../../shared/mirroredError";
import type { NonChatMode } from "../../shared/serverEntry";
import type { ServerWithKey } from "../../shared/servers";
import type { HeaderValue } from "../../shared/util/headers";
import { isRecord } from "../../shared/util/json";
import { validateRequest } from "../../shared/validation";
import type { ExpectedDiscoveryFailures, FetchModelsResult } from "../catalog/discovery";
import { fetchModels } from "../catalog/discovery";
import type { GroupServer, ParsedModelMetadata } from "../catalog/groupModels";
import { groupClientId } from "../catalog/groupModels";
import { requestParamsFromModelConfiguration } from "../catalog/modelConfiguration";
import {
	type OAuthConfig,
	type OAuthErrorSurface,
	OAuthTokenSource,
	type TimeoutBudget,
	type VirtualKeyConfig,
} from "./auth";
import type { AuthOverlayScope } from "./authOverlay";
import { applyAuthOverlay, hasHeader } from "./authOverlay";
import { isHostCancellation } from "./cancellation";
import { CHAT_COMPLETIONS_PATH, chatCompletionsUrl, ServerClientCache } from "./clients";
import { mapSdkError } from "./errorMapping";
import type { TransportFetch } from "./nodeHttpFetch";
import { nodeHttpFetch } from "./nodeHttpFetch";
import { buildRequestBody } from "./request";
import { chatSessionIdHeader } from "./sessionId";
import type { ToolCallIdSource } from "./streaming/processor";
import { StreamProcessor } from "./streaming/processor";
import { bodylessResponseError, timeoutRequestError } from "./transportErrors";

/**
 * One chat request as the host hands it over. `metadata` is the provider's one parse of the model object (nothing here
 * re-narrows the host round trip), and `server` the group's live connection, resolved by the provider from the model's
 * group identity.
 */
export interface ChatRequestContext {
	metadata: ParsedModelMetadata;

	server: GroupServer;

	messages: readonly LanguageModelChatRequestMessage[];

	options: ProvideLanguageModelChatResponseOptions;

	progress: vscode.Progress<vscode.LanguageModelResponsePart>;

	token: vscode.CancellationToken;
}

/**
 * A server with its credentials and the entry it may match. `entryLabel` names the declared entry candidate for
 * per-entry headers: a group's CONFIGURED label, never the URL-host display fallback an unlabeled group renders under,
 * which could collide with a real entry label. Distinct from `label`, which is display text.
 */
export interface ServerConnection extends ServerWithKey {
	oauth?: OAuthConfig;

	virtualKey?: VirtualKeyConfig;

	entryLabel?: string | undefined;
}

/**
 * The per-entry resolvers take the entry's label and the group's base URL and answer only when both identify the
 * same declared entry; each defaults to none, so models served by an unlabeled (external) group get only the global
 * modelParameters, and servers no declared entry matches get the auto apiVersion rule. `resolution` defaults to a
 * private table for callers constructed without a provider.
 */
export interface ChatClientOptions {
	/** The User-Agent header on the SDK clients' requests; the OAuth token exchange does not carry it. */
	userAgent: HeaderValue;

	/** The log and advisory sink; absent, the client logs nothing. */
	logger?: Logger | undefined;

	/** Request-time resolver for a declared entry's per-entry modelParameters. */
	getEntryModelParameters?:
		| ((label: string, baseUrl: string) => Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined)
		| undefined;

	/** The provider-owned flat resolution table, so the request path, registration, and the dashboard share one cache. */
	resolution?: ModelResolutionTable | undefined;

	/** Request- and discovery-time resolver for a declared entry's custom headers. */
	getEntryHeaders?: ((label: string, baseUrl: string) => Readonly<Record<string, HeaderValue>> | undefined) | undefined;

	/** Resolver for an entry's apiVersion override: "" is a real value (append nothing), undefined the auto rule. */
	getEntryApiVersion?: ((label: string, baseUrl: string) => string | undefined) | undefined;

	/** The HTTP transport under the SDK client; tests inject a fake here. Defaults to nodeHttpFetch. */
	fetch?: TransportFetch | undefined;
}

/** The host's request in wire form; `cachedTools` carry the cache_control markers when prompt caching applies. */
interface WireRequest {
	readonly openaiMessages: OpenAIChatMessage[];
	readonly toolConfig: ToolConfig | undefined;
	readonly cachedTools: ToolConfig["tools"] | undefined;
}

/**
 * Owns the HTTP-facing side of the provider, and tool-call ID generation: see ToolCallIdSource for the
 * synchronous-advance requirement `toolCallIds` meets.
 */
export class ChatClient {
	private readonly userAgent: HeaderValue;

	private readonly logger?: Logger | undefined;

	private readonly getEntryModelParameters: (
		label: string,
		baseUrl: string
	) => Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined;

	private readonly getEntryHeaders: (
		label: string,
		baseUrl: string
	) => Readonly<Record<string, HeaderValue>> | undefined;

	private readonly getEntryApiVersion: (label: string, baseUrl: string) => string | undefined;

	private readonly clients: ServerClientCache;

	private readonly oauthTokens = new OAuthTokenSource();

	private readonly resolution: ModelResolutionTable;

	private _toolCallIdCounter = 0;

	private readonly toolCallIds: ToolCallIdSource = { next: () => ++this._toolCallIdCounter };

	private readonly log = (message: string, data?: unknown): void => {
		this.logger?.log(message, data);
	};

	private readonly advise = (message: string, data?: unknown): void => {
		this.logger?.advisory(message, data);
	};

	constructor(options: ChatClientOptions) {
		this.userAgent = options.userAgent;
		this.logger = options.logger;
		this.getEntryModelParameters = options.getEntryModelParameters ?? (() => undefined);
		this.getEntryHeaders = options.getEntryHeaders ?? (() => undefined);
		this.getEntryApiVersion = options.getEntryApiVersion ?? (() => undefined);
		this.resolution = options.resolution ?? new ModelResolutionTable();
		this.clients = new ServerClientCache(options.fetch ?? nodeHttpFetch);
	}

	/** Copied because the client cache expects an owned record. */
	private customHeadersFor(entryLabel: string | undefined, baseUrl: string): Record<string, HeaderValue> {
		const headers = entryLabel === undefined ? undefined : this.getEntryHeaders(entryLabel, baseUrl);
		return headers === undefined ? {} : { ...headers };
	}

	private apiVersionFor(entryLabel: string | undefined, baseUrl: string): string | undefined {
		return entryLabel === undefined ? undefined : this.getEntryApiVersion(entryLabel, baseUrl);
	}

	pruneClients(serverIds: Iterable<string>): void {
		this.clients.prune(serverIds);
	}

	async fetchModels(
		server: ServerConnection,
		expected?: ExpectedDiscoveryFailures,
		includeModes?: readonly NonChatMode[]
	): Promise<FetchModelsResult> {
		this.log("fetchModels called", { baseUrl: server.baseUrl, hasApiKey: !!server.apiKey, hasOAuth: !!server.oauth });
		const customHeaders = this.customHeadersFor(server.entryLabel, server.baseUrl);
		const apiVersion = this.apiVersionFor(server.entryLabel, server.baseUrl);
		const discoveryTimeout = getDiscoveryTimeout(this.log);
		const client = this.clients.get({
			serverId: server.id,
			baseUrl: server.baseUrl,
			apiVersion,
			apiKey: server.apiKey,
			userAgent: this.userAgent,
			customHeaders,
		});
		const { headers, auth } = await this.resolveAuthHeaders(server, "discovery", {
			ms: discoveryTimeout,
			setting: "discovery.timeout",
		});
		try {
			return await fetchModels({
				client,
				baseUrl: server.baseUrl,
				apiVersion,
				discoveryTimeout,
				entryLabel: server.entryLabel,
				log: this.log,
				isCancellation: isHostCancellation,
				...(expected === undefined ? {} : { expected }),
				...(includeModes === undefined ? {} : { includeModes }),
				...(headers === undefined ? {} : { headers }),
			});
		} catch (error) {
			auth.fail(error);
			throw error;
		}
	}

	/**
	 * Both surfaces this client serves clock each attempt of their token wait by the discovery timeout (auth plumbing,
	 * not a chat call), so `timeout` arrives minted at the caller's getDiscoveryTimeout read. `signal`, when the
	 * triggering call carries one, ends this call's token wait, so user cancellation and the chat timeout cut in.
	 */
	private async resolveAuthHeaders(
		credentials: { oauth?: OAuthConfig | undefined; virtualKey?: VirtualKeyConfig | undefined },
		surface: OAuthErrorSurface,
		timeout: TimeoutBudget,
		signal?: AbortSignal
	): Promise<{ headers: Record<string, HeaderValue> | undefined; auth: AuthOverlayScope }> {
		const headers: Record<string, HeaderValue> = {};
		const auth = await applyAuthOverlay(headers, credentials, {
			tokens: this.oauthTokens,
			surface,
			timeout,
			signal,
		});
		return { headers: Object.keys(headers).length > 0 ? headers : undefined, auth };
	}

	/** The chat tool cap is checked before anything is sent, so the user sees the count, not a server refusal. */
	private requireToolCount(options: ProvideLanguageModelChatResponseOptions): void {
		const maxTools = getMaxToolsPerRequest(this.log);
		if (options.tools && options.tools.length > maxTools) {
			throw localizedError(
				chatErrorMessage(
					l10n.t(
						"Too many chat tools are enabled for this request. Disable some in the chat Tools picker, or turn off unused extensions or MCP servers, and try again."
					),
					l10n.t("{0} tools requested; the limit is {1} (request not sent)", options.tools.length, maxTools)
				),
				englishChatErrorMessage(
					"Too many chat tools are enabled for this request. Disable some in the chat Tools picker, or turn off unused extensions or MCP servers, and try again.",
					`${options.tools.length} tools requested; the limit is ${maxTools} (request not sent)`
				)
			);
		}
	}

	/**
	 * The host's messages and tools in wire form, with the prompt-cache breakpoints applied where the setting and the
	 * model allow them.
	 */
	private wireRequestFor(
		metadata: ParsedModelMetadata,
		messages: readonly LanguageModelChatRequestMessage[],
		options: ProvideLanguageModelChatResponseOptions,
		promptCachingEnabled: boolean
	): WireRequest {
		validateRequest(messages);
		const wireGates = {
			imageInput: metadata.imageInput,
			audioInput: metadata.supportsAudioInput,
			replayReasoningContent: metadata.replayReasoningContent,
		};
		const converted = convertMessages(messages, { log: this.log, ...wireGates });
		const toolConfig = convertTools(options, getAdditionalToolSchemaKeywords(this.log));
		this.requireToolCount(options);

		const { messages: openaiMessages, tools: cachedTools } =
			promptCachingEnabled && metadata.supportsPromptCaching
				? applyPromptCacheBreakpoints({ messages: converted, tools: toolConfig?.tools })
				: { messages: converted, tools: toolConfig?.tools };
		return { openaiMessages, toolConfig, cachedTools };
	}

	/**
	 * The local token estimate must stay under the model's input limit, or the request is refused before send. It
	 * prices the very message array the request sends, never a second conversion of the same input; cache_control
	 * markers are token-neutral. Tools price unmarked: a marker would be JSON.stringified as content.
	 */
	private requireWithinInputLimit(wire: WireRequest, maxInputTokens: number): void {
		const inputTokenCount = estimateWireMessagesTokens(wire.openaiMessages);
		const toolTokenCount = estimateToolTokens(wire.toolConfig?.tools);
		const tokenLimit = Math.max(1, maxInputTokens);
		if (inputTokenCount + toolTokenCount > tokenLimit) {
			// The numbers must survive in the detail: docs/troubleshooting.md teaches comparing the limit against the
			// model's real one (the models.capabilities fix).
			throw localizedError(
				chatErrorMessage(
					l10n.t(
						"This conversation looks too long for the model - trim messages or attachments, or raise the model's input limit in settings if it is wrong."
					),
					l10n.t(
						"token limit exceeded before send: local estimate {0} tokens (messages + tools), input limit {1}",
						inputTokenCount + toolTokenCount,
						tokenLimit
					)
				),
				englishChatErrorMessage(
					"This conversation looks too long for the model - trim messages or attachments, or raise the model's input limit in settings if it is wrong.",
					`token limit exceeded before send: local estimate ${inputTokenCount + toolTokenCount} tokens (messages + tools), input limit ${tokenLimit}`
				)
			);
		}
	}

	/**
	 * The body the request sends: the configured parameters under the user's precedence chain, and max_tokens from
	 * its one fallback chain (resolveMaxTokens, shared with the dashboard's inspector). The entry match is label plus
	 * URL, deliberately not credentials: any group carrying the entry's label at the entry's URL resolves, a
	 * hand-labeled native group included. What the URL check excludes is a same-label group at another URL, stale from
	 * a label reuse or a baseUrl edit.
	 *   two entries may share a base URL -> the label tells them apart
	 */
	private requestBodyFor(ctx: ChatRequestContext, serverId: string, wire: WireRequest): Record<string, unknown> {
		const { metadata, server, options } = ctx;
		const entryModelParameters =
			server.label === undefined ? undefined : this.getEntryModelParameters(server.label, server.baseUrl);
		const { params: modelParams, forcedParams } = this.resolution.resolveParameters(serverId, metadata.rawModelId, {
			globalParameters: getModelParametersConfig(this.advise),
			entryParameters: entryModelParameters,
		});

		const { value: maxTokens } = resolveMaxTokens({
			forcedMaxTokens: forcedParams.max_tokens,
			runtimeMaxTokens: options.modelOptions?.max_tokens,
			configuredMaxTokens: modelParams.max_tokens,
			maxOutputTokens: metadata.maxOutputTokens,
			defaultMaxTokens: metadata.defaultMaxTokens,
		});

		const { openaiMessages, toolConfig, cachedTools } = wire;
		return buildRequestBody({
			rawModelId: metadata.rawModelId,
			openaiMessages,
			maxTokens,
			modelParams,
			forcedParams,
			toolConfig: toolConfig && { tools: cachedTools ?? toolConfig.tools, tool_choice: toolConfig.tool_choice },
			modelConfiguration: requestParamsFromModelConfiguration(options.modelConfiguration),
			modelOptions: options.modelOptions as Record<string, unknown> | undefined,
		});
	}

	/**
	 * The per-request headers: the overlay's auth headers plus the session id. The session id rides the per-request
	 * headers, never the client's own: the client cache keys on the custom headers, so a per-chat value among them
	 * would rebuild the OpenAI client on every new chat. It yields to any header already spelling its name: a
	 * credential's, which owns its name, or a custom header the user set.
	 */
	private perRequestHeaders(
		authHeaders: Record<string, HeaderValue> | undefined,
		customHeaders: Record<string, HeaderValue>,
		messages: readonly LanguageModelChatRequestMessage[]
	): Record<string, HeaderValue> {
		const headers: Record<string, HeaderValue> = authHeaders === undefined ? {} : { ...authHeaders };
		const sessionIdTaken =
			hasHeader(headers, SESSION_ID_HEADER_NAME) || hasHeader(customHeaders, SESSION_ID_HEADER_NAME);
		const sessionIdHeader = sessionIdTaken ? undefined : chatSessionIdHeader(messages);
		if (sessionIdHeader !== undefined) {
			headers[SESSION_ID_HEADER_NAME] = sessionIdHeader;
		}
		return headers;
	}

	/**
	 * Streams the response body through the processor. Every 200 arrives with a body stream, so a server that sent
	 * nothing shows only as a stream that ends without a byte; that is the same "nothing came back" as a null body and
	 * gets the same error.
	 */
	private async streamResponse(
		response: Response,
		ctx: ChatRequestContext,
		requestBody: Record<string, unknown>
	): Promise<void> {
		const { server, progress, token } = ctx;
		if (!response.body) {
			throw bodylessResponseError("chat", response.status, server.baseUrl);
		}

		// The user-set audio.format parameter (when a modality-audio request declares one) is the only statement of
		// the clip encoding.
		const audio = requestBody.audio;
		const requestAudioFormat = isRecord(audio) && typeof audio.format === "string" ? audio.format : undefined;
		const streamProcessor = new StreamProcessor(
			this.toolCallIds,
			this.log,
			progress,
			undefined,
			undefined,
			requestAudioFormat
		);
		let bodyBytes = 0;
		const counted = response.body.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					bodyBytes += chunk.byteLength;
					controller.enqueue(chunk);
				},
			})
		);
		await streamProcessor.processStreamingResponse(counted, token);
		if (bodyBytes === 0) {
			throw bodylessResponseError("chat", response.status, server.baseUrl);
		}
	}

	async send(ctx: ChatRequestContext): Promise<void> {
		const { metadata, server, messages, token } = ctx;
		const serverId = groupClientId(server);

		const promptCachingEnabled = isPromptCachingEnabled();
		const customHeaders = this.customHeadersFor(server.label, server.baseUrl);
		const apiVersion = this.apiVersionFor(server.label, server.baseUrl);
		const requestTimeout = getRequestTimeout(this.log);
		const wire = this.wireRequestFor(metadata, messages, ctx.options, promptCachingEnabled);
		this.requireWithinInputLimit(wire, metadata.maxInputTokens);
		const requestBody = this.requestBodyFor(ctx, serverId, wire);

		const client = this.clients.get({
			serverId,
			baseUrl: server.baseUrl,
			apiVersion,
			apiKey: server.apiKey,
			userAgent: this.userAgent,
			customHeaders,
		});

		this.log("Sending chat request", {
			url: chatCompletionsUrl(server.baseUrl, apiVersion),
			modelId: metadata.rawModelId,
			messageCount: messages.length,
		});

		// User cancellation must abort the in-flight request, not just stop the read loop, so the token is bridged onto
		// an AbortController combined with the request timeout. The per-request timeout keeps the SDK's own 600 s
		// time-to-headers default from cutting in before ours; the AbortSignal.timeout is what bounds the whole call,
		// including a stream that stalls after headers (the SDK disarms its timer once headers arrive, and the
		// transport has no idle clock of its own).
		const cancelController = new AbortController();
		const cancelListener = token.onCancellationRequested(() => cancelController.abort());
		const timeoutSignal = AbortSignal.timeout(requestTimeout);
		const requestSignal = AbortSignal.any([cancelController.signal, timeoutSignal]);
		const errorContext = { surface: "chat" as const, baseUrl: server.baseUrl, timeoutMs: requestTimeout };
		let auth: AuthOverlayScope | undefined;

		try {
			const resolvedAuth = await this.resolveAuthHeaders(
				{ oauth: server.oauth, virtualKey: server.virtualKey },
				"chat",
				{ ms: getDiscoveryTimeout(this.log), setting: "discovery.timeout" },
				requestSignal
			);
			auth = resolvedAuth.auth;
			const headers = this.perRequestHeaders(resolvedAuth.headers, customHeaders, messages);
			const response = await client
				.post(CHAT_COMPLETIONS_PATH, {
					body: requestBody,
					signal: requestSignal,
					timeout: requestTimeout,
					...(Object.keys(headers).length > 0 ? { headers } : {}),
				})
				.asResponse();
			await this.streamResponse(response, ctx, requestBody);
		} catch (err) {
			if (token.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			if (timeoutSignal.aborted) {
				throw timeoutRequestError(errorContext, err);
			}
			const mapped = mapSdkError(err, errorContext, isHostCancellation);
			auth?.fail(mapped);
			throw mapped;
		} finally {
			cancelListener.dispose();
		}
	}
}
