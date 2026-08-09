import type { LanguageModelChatRequestMessage, ProvideLanguageModelChatResponseOptions } from "vscode";
import * as vscode from "vscode";
import { ModelResolutionTable } from "../../shared/config/resolutionTable";
import {
	getDiscoveryTimeout,
	getModelParametersConfig,
	getRequestTimeout,
	isPromptCachingEnabled,
} from "../../shared/config/settings";
import { convertMessages } from "../../shared/conversion/messages";
import { applyPromptCacheBreakpoints } from "../../shared/conversion/promptCache";
import { estimateMessagesTokens, estimateToolTokens } from "../../shared/conversion/tokenEstimation";
import { convertTools } from "../../shared/conversion/tools";
import type { Logger } from "../../shared/logger";
import type { ServerWithKey } from "../../shared/servers";
import { isRecord } from "../../shared/util/json";
import { validateRequest } from "../../shared/validation";
import type { ExpectedDiscoveryFailures, FetchModelsResult } from "../catalog/discovery";
import { fetchModels } from "../catalog/discovery";
import type { GroupServer, LiteLLMModelInfo } from "../catalog/groupModels";
import { groupClientId, parseModelMetadata } from "../catalog/groupModels";
import type { ModelRoute } from "../catalog/modelCatalog";
import { requestParamsFromModelConfiguration } from "../catalog/modelConfiguration";
import { resolveServer } from "../config";
import { type OAuthConfig, OAuthTokenSource, type VirtualKeyConfig } from "./auth";
import { CHAT_COMPLETIONS_PATH, chatCompletionsUrl, ServerClientCache } from "./clients";
import { localizedError, mapSdkError, RequestError, timeoutRequestError } from "./errorMapping";
import { buildRequestBody, MAX_TOOLS_PER_REQUEST, resolveMaxTokens } from "./request";
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
	/**
	 * The label naming the declared entry candidate for per-entry headers,
	 * when one can match: a group's CONFIGURED label (never the URL-host
	 * display fallback an unlabeled group renders under, which could collide
	 * with a real entry label) or a registry server's own label - the same
	 * identities the discovery side resolves entry capabilities and
	 * expectedFailures with. Distinct from `label`, which is display text.
	 */
	entryLabel?: string | undefined;
}

/**
 * Everything one chat request needs to reach its server, resolved in full
 * before anything is sent. Every field is required (undefined must be stated,
 * not omitted), so a resolution branch cannot silently drop the credentials
 * another branch carries.
 */
interface ResolvedConnection {
	serverId: string;
	baseUrl: string;
	apiKey: string;
	rawModelId: string;
	/** The label naming the declared entry candidate for per-entry configuration (headers); undefined when none can match. */
	entryLabel: string | undefined;
	oauth: OAuthConfig | undefined;
	virtualKey: VirtualKeyConfig | undefined;
}

export interface ChatClientOptions {
	userAgent: string;
	logger?: Logger | undefined;
	/** Resolves the legacy registry's servers; defaults to none for hosts that only serve provider groups. */
	getServers?: (() => Promise<ServerWithKey[]>) | undefined;
	/**
	 * Resolves a declared server entry's per-entry modelParameters at request
	 * time, from the entry's label and the attached server's base URL; injected
	 * by the extension layer (the setting lives on its side of the boundary).
	 * The resolver returns parameters only when both identify the same declared
	 * entry. Defaults to none: models without an attached labeled server
	 * (external groups, registry-path models) get only the global
	 * modelParameters.
	 */
	getEntryModelParameters?:
		| ((label: string, baseUrl: string) => Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined)
		| undefined;
	/**
	 * The provider-owned flat resolution table; requests read their configured
	 * parameters through it so the request path, registration, and the
	 * dashboard share one cache. Defaults to a private table for callers
	 * constructed without a provider (tests, the draft-connection probe).
	 */
	resolution?: ModelResolutionTable | undefined;
	/**
	 * Resolves a declared server entry's custom headers at request time, from
	 * the entry's label and the server's base URL; injected like
	 * getEntryModelParameters (headers live on the entry - there is no global
	 * headers setting). Defaults to none: servers no declared entry matches
	 * send no custom headers.
	 */
	getEntryHeaders?: ((label: string, baseUrl: string) => Readonly<Record<string, string>> | undefined) | undefined;
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
		label: string,
		baseUrl: string
	) => Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined;
	private readonly getEntryHeaders: (label: string, baseUrl: string) => Readonly<Record<string, string>> | undefined;
	private readonly clients = new ServerClientCache();
	private readonly oauthTokens = new OAuthTokenSource();
	private readonly resolution: ModelResolutionTable;
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
		this.getEntryHeaders = options.getEntryHeaders ?? (() => undefined);
		this.resolution = options.resolution ?? new ModelResolutionTable();
	}

	/**
	 * The custom headers one call to `baseUrl` carries: the declared entry's
	 * `headers` record when the entry-candidate label and URL identify one
	 * (see ServerConnection.entryLabel for which labels qualify), none
	 * otherwise. Copied because the client cache config mutates nothing but
	 * expects an owned record.
	 */
	private customHeadersFor(entryLabel: string | undefined, baseUrl: string): Record<string, string> {
		const headers = entryLabel !== undefined ? this.getEntryHeaders(entryLabel, baseUrl) : undefined;
		return headers !== undefined ? { ...headers } : {};
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

	/** `expected` carries the entry's expected-failure declarations; see FetchModelsRequest. */
	async fetchModels(server: ServerConnection, expected?: ExpectedDiscoveryFailures): Promise<FetchModelsResult> {
		this.log("fetchModels called", { baseUrl: server.baseUrl, hasApiKey: !!server.apiKey, hasOAuth: !!server.oauth });
		const customHeaders = this.customHeadersFor(server.entryLabel, server.baseUrl);
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
				log: this.log,
				...(expected !== undefined ? { expected } : {}),
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
				// The configured group label only; an unlabeled group resolves no
				// entry configuration (its display label is a URL-host fallback).
				entryLabel: groupServer.label,
				oauth: groupServer.oauth,
				virtualKey: groupServer.virtualKey,
			};
		}
		const route = this._modelRoutes.get(model.id);
		if (route) {
			const server = await resolveServer(route.serverId, this.getServers);
			if (!server) {
				throw localizedError(
					vscode.l10n.t('Server "{0}" is no longer configured', route.serverLabel),
					`Server "${route.serverLabel}" is no longer configured`
				);
			}
			return {
				serverId: server.id,
				baseUrl: server.baseUrl,
				apiKey: server.apiKey,
				rawModelId: route.rawModelId,
				entryLabel: server.label,
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
				entryLabel: soleServer.label,
				oauth: undefined,
				virtualKey: undefined,
			};
		}
		throw localizedError(
			vscode.l10n.t(
				'Model "{0}" is not registered with any configured server. Refresh the model list and try again.',
				model.id
			),
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
		const customHeaders = this.customHeadersFor(connection.entryLabel, connection.baseUrl);
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
			throw localizedError(
				`${vscode.l10n.t(
					"Too many chat tools are enabled for this request. Disable some in the chat Tools picker, or turn off unused extensions or MCP servers, and try again."
				)}\n${vscode.l10n.t("{0} tools requested; the limit is {1} (request not sent)", options.tools.length, MAX_TOOLS_PER_REQUEST)}`,
				`Too many chat tools are enabled for this request. Disable some in the chat Tools picker, or turn off unused extensions or MCP servers, and try again.\n${options.tools.length} tools requested; the limit is ${MAX_TOOLS_PER_REQUEST} (request not sent)`
			);
		}

		const { messages: openaiMessages, tools: cachedTools } =
			promptCachingEnabled && metadata.supportsPromptCaching
				? applyPromptCacheBreakpoints({ messages: converted, tools: toolConfig?.tools })
				: { messages: converted, tools: toolConfig?.tools };

		const inputTokenCount = estimateMessagesTokens(messages, wireGates);
		const toolTokenCount = estimateToolTokens(toolConfig?.tools);
		const tokenLimit = Math.max(1, model.maxInputTokens);
		if (inputTokenCount + toolTokenCount > tokenLimit) {
			// The numbers must survive in the detail: docs/troubleshooting.md
			// teaches comparing the limit against the model's real one (the
			// models.capabilities fix).
			throw localizedError(
				`${vscode.l10n.t(
					"This conversation looks too long for the model - trim messages or attachments, or raise the model's input limit in settings if it is wrong."
				)}\n${vscode.l10n.t(
					"token limit exceeded before send: local estimate {0} tokens (messages + tools), input limit {1}",
					inputTokenCount + toolTokenCount,
					tokenLimit
				)}`,
				`This conversation looks too long for the model - trim messages or attachments, or raise the model's input limit in settings if it is wrong.\ntoken limit exceeded before send: local estimate ${inputTokenCount + toolTokenCount} tokens (messages + tools), input limit ${tokenLimit}`
			);
		}

		// The attached server's label and base URL together name the declared
		// settings entry this request is routed through (two entries may share a
		// base URL, so the label tells them apart). The resolver hands back the
		// entry's per-entry modelParameters only when both match, and they merge
		// over the global setting's match inside the resolution table; unlabeled
		// servers (external groups, pre-label groups, registry models)
		// contribute none. The match is label plus URL, deliberately not
		// credentials: any group carrying the entry's label at the entry's URL
		// resolves, a hand-labeled native group included. What the URL check
		// excludes is a same-label group at another URL - a stale group
		// outliving a label reuse or a baseUrl edit. After a baseUrl edit no
		// second group appears (groups are named by label and the add-only host
		// refuses the duplicate name), the entry surfaces the duplicate-name
		// sync error, and the stale group stops receiving the entry's
		// parameters until it is removed natively and re-synced.
		const entryModelParameters =
			metadata.server?.label !== undefined
				? this.getEntryModelParameters(metadata.server.label, metadata.server.baseUrl)
				: undefined;
		// Read through the provider-shared flat table: resolution runs only when
		// the configuration or the model set changed, never per request.
		const { params: modelParams, forcedParams } = this.resolution.resolveParameters(
			connection.serverId,
			connection.rawModelId,
			{ globalParameters: getModelParametersConfig(), entryParameters: entryModelParameters }
		);

		// The one home of the fallback chain is resolveMaxTokens (shared with the
		// dashboard's inspector): forced configured value, runtime option,
		// configured parameter, the server-declared or user-overridden limit
		// honored as-is, else the cap over the defaults-derived guess.
		const { value: maxTokens } = resolveMaxTokens({
			forcedMaxTokens: forcedParams.max_tokens,
			runtimeMaxTokens: options.modelOptions?.max_tokens,
			configuredMaxTokens: modelParams.max_tokens,
			maxOutputTokens: model.maxOutputTokens,
			outputLimitDeclared: metadata.outputLimitSource !== "defaults",
		});

		const requestBody = buildRequestBody({
			rawModelId: connection.rawModelId,
			openaiMessages,
			maxTokens,
			modelParams,
			forcedParams,
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
				// Free of mapSdkError's socket-signature tokens, so the catch below
				// cannot reclassify this as a mid-response network death.
				throw localizedError(
					`${vscode.l10n.t(
						"The server accepted the request but sent nothing back. Try again; if it keeps happening, check any proxy or gateway between VS Code and the LiteLLM server."
					)}\n${vscode.l10n.t("LiteLLM answered {0} with a missing response body ({1})", response.status, connection.baseUrl)}`,
					`The server accepted the request but sent nothing back. Try again; if it keeps happening, check any proxy or gateway between VS Code and the LiteLLM server.\nLiteLLM answered ${response.status} with a missing response body (${connection.baseUrl})`
				);
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
				throw timeoutRequestError(errorContext, err);
			}
			const mapped = mapSdkError(err, errorContext);
			this.invalidateRejectedToken(connection.oauth, mapped, sentOAuthToken);
			throw mapped;
		} finally {
			cancelListener.dispose();
		}
	}
}
