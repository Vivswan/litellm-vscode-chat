import * as l10n from "@vscode/l10n";
import type { LanguageModelChatRequestMessage, ProvideLanguageModelChatResponseOptions } from "vscode";
import * as vscode from "vscode";
import { ModelResolutionTable } from "../../shared/config/resolutionTable";
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
import { convertTools } from "../../shared/conversion/tools";
import type { Logger } from "../../shared/logger";
import { chatErrorMessage, englishChatErrorMessage, localizedError } from "../../shared/mirroredError";
import type { ServerWithKey } from "../../shared/servers";
import { isRecord } from "../../shared/util/json";
import { validateRequest } from "../../shared/validation";
import type { ExpectedDiscoveryFailures, FetchModelsResult } from "../catalog/discovery";
import { fetchModels } from "../catalog/discovery";
import type { GroupServer, LiteLLMModelInfo } from "../catalog/groupModels";
import { groupClientId, parseModelMetadata } from "../catalog/groupModels";
import { requestParamsFromModelConfiguration } from "../catalog/modelConfiguration";
import {
	type OAuthConfig,
	type OAuthErrorSurface,
	OAuthTokenSource,
	type TimeoutBudget,
	type VirtualKeyConfig,
} from "./auth";
import type { AuthOverlayScope } from "./authOverlay";
import { applyAuthOverlay } from "./authOverlay";
import { CHAT_COMPLETIONS_PATH, chatCompletionsUrl, ServerClientCache } from "./clients";
import { bodylessResponseError, mapSdkError, timeoutRequestError } from "./errorMapping";
import { buildRequestBody, resolveMaxTokens } from "./request";
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
 * A server to talk to: the connection fields plus the OAuth and virtual-key
 * credentials that only provider-group configurations can carry.
 */
export interface ServerConnection extends ServerWithKey {
	oauth?: OAuthConfig;
	virtualKey?: VirtualKeyConfig;
	/**
	 * The label naming the declared entry candidate for per-entry headers: a
	 * group's CONFIGURED label, never the URL-host display fallback an
	 * unlabeled group renders under, which could collide with a real entry
	 * label. Distinct from `label`, which is display text.
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
	/**
	 * Resolves a declared server entry's per-entry modelParameters at request
	 * time, from the entry's label and the attached server's base URL, and only
	 * when both identify the same declared entry. Defaults to none: models
	 * without an attached labeled server (external groups) get only the global
	 * modelParameters.
	 */
	getEntryModelParameters?:
		| ((label: string, baseUrl: string) => Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined)
		| undefined;
	/**
	 * The provider-owned flat resolution table; requests read their configured
	 * parameters through it so the request path, registration, and the
	 * dashboard share one cache. Defaults to a private table for callers
	 * constructed without a provider.
	 */
	resolution?: ModelResolutionTable | undefined;
	/**
	 * Resolves a declared server entry's custom headers at request time, matched
	 * like getEntryModelParameters. Defaults to none: servers no declared entry
	 * matches send no custom headers.
	 */
	getEntryHeaders?: ((label: string, baseUrl: string) => Readonly<Record<string, string>> | undefined) | undefined;
	/**
	 * Resolves a declared server entry's apiVersion override (what apiRootOf
	 * appends to the base URL) at request time. "" is a real value (append
	 * nothing), distinct from undefined (auto). Defaults to none: servers no
	 * declared entry matches get the auto rule.
	 */
	getEntryApiVersion?: ((label: string, baseUrl: string) => string | undefined) | undefined;
}

/**
 * Owns the HTTP-facing side of the provider: model discovery, chat requests,
 * the prompt-caching gate, and tool-call ID generation.
 */
export class ChatClient {
	private readonly userAgent: string;
	private readonly logger?: Logger | undefined;
	private readonly getEntryModelParameters: (
		label: string,
		baseUrl: string
	) => Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined;
	private readonly getEntryHeaders: (label: string, baseUrl: string) => Readonly<Record<string, string>> | undefined;
	private readonly getEntryApiVersion: (label: string, baseUrl: string) => string | undefined;
	private readonly clients = new ServerClientCache();
	private readonly oauthTokens = new OAuthTokenSource();
	private readonly resolution: ModelResolutionTable;
	private _toolCallIdCounter = 0;
	// The single owner of tool-call ID generation; see ToolCallIdSource for the
	// synchronous-advance requirement.
	private readonly toolCallIds: ToolCallIdSource = { next: () => ++this._toolCallIdCounter };

	private readonly log = (message: string, data?: unknown): void => {
		this.logger?.log(message, data);
	};

	constructor(options: ChatClientOptions) {
		this.userAgent = options.userAgent;
		this.logger = options.logger;
		this.getEntryModelParameters = options.getEntryModelParameters ?? (() => undefined);
		this.getEntryHeaders = options.getEntryHeaders ?? (() => undefined);
		this.getEntryApiVersion = options.getEntryApiVersion ?? (() => undefined);
		this.resolution = options.resolution ?? new ModelResolutionTable();
	}

	/**
	 * The custom headers one call to `baseUrl` carries: the declared entry's
	 * `headers` record when the entry-candidate label and URL identify one,
	 * none otherwise. Copied because the client cache expects an owned record.
	 */
	private customHeadersFor(entryLabel: string | undefined, baseUrl: string): Record<string, string> {
		const headers = entryLabel !== undefined ? this.getEntryHeaders(entryLabel, baseUrl) : undefined;
		return headers !== undefined ? { ...headers } : {};
	}

	/**
	 * The apiVersion override one call to `baseUrl` resolves under: the
	 * declared entry's `apiVersion` when the entry-candidate label and URL
	 * identify one, undefined (the auto rule) otherwise. "" carries through
	 * as a real value.
	 */
	private apiVersionFor(entryLabel: string | undefined, baseUrl: string): string | undefined {
		return entryLabel !== undefined ? this.getEntryApiVersion(entryLabel, baseUrl) : undefined;
	}

	/** Drop cached SDK clients for any server ID not in `keep`; the provider includes live group-client IDs. */
	pruneClients(serverIds: Iterable<string>): void {
		this.clients.prune(serverIds);
	}

	/** `expected` carries the entry's expected-failure declarations; see FetchModelsRequest. */
	async fetchModels(server: ServerConnection, expected?: ExpectedDiscoveryFailures): Promise<FetchModelsResult> {
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
				...(expected !== undefined ? { expected } : {}),
				...(headers !== undefined ? { headers } : {}),
			});
		} catch (error) {
			auth.fail(error);
			throw error;
		}
	}

	/**
	 * Per-request credentials the cached SDK client cannot carry statically:
	 * the OAuth bearer token and the virtual-key header, applied by the shared
	 * overlay (authOverlay.ts) that also serves the plain-fetch transports. Both
	 * surfaces this client serves bound the exchange by the discovery timeout
	 * (it is auth plumbing, not a chat call), so `timeout` arrives minted at the
	 * caller's getDiscoveryTimeout read; `signal`, when the triggering call
	 * carries one, additionally interrupts the exchange, so user cancellation
	 * and the chat timeout cut in too.
	 *
	 * `auth` is the overlay scope owning 401 invalidation for the very token
	 * the returned headers carry; the caller routes the request's classified
	 * failure through `auth.fail`.
	 */
	private async resolveAuthHeaders(
		credentials: { oauth?: OAuthConfig | undefined; virtualKey?: VirtualKeyConfig | undefined },
		surface: OAuthErrorSurface,
		timeout: TimeoutBudget,
		signal?: AbortSignal
	): Promise<{ headers: Record<string, string> | undefined; auth: AuthOverlayScope }> {
		const headers: Record<string, string> = {};
		const auth = await applyAuthOverlay(headers, credentials, {
			tokens: this.oauthTokens,
			surface,
			timeout,
			signal,
		});
		return { headers: Object.keys(headers).length > 0 ? headers : undefined, auth };
	}

	/**
	 * Resolve the complete connection for one chat request from the group
	 * server attached to the model object. Every served model carries its
	 * group's resolved connection, so a model without one crossed the host
	 * boundary in a state this provider never served (most likely a stale model
	 * object from before a refresh) and fails loudly with a classified error
	 * instead of an undefined route; the terse classification keeps the model ID
	 * out of public logs.
	 */
	private resolveConnection(model: LiteLLMModelInfo, groupServer: GroupServer | undefined): ResolvedConnection {
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
		throw localizedError(
			l10n.t(
				'Model "{0}" is not registered with any configured server. Refresh the model list and try again.',
				model.id
			),
			`Model "${model.id}" is not registered with any configured server. Refresh the model list and try again.`,
			"RequestRouting(model without attached server)"
		);
	}

	async send(ctx: ChatRequestContext): Promise<void> {
		const { model, messages, options, progress, token } = ctx;

		// The one parse of the model object's LiteLLM metadata; everything below
		// reads the parsed result instead of re-narrowing the host round trip.
		const metadata = parseModelMetadata(model, this.log);
		const connection = this.resolveConnection(model, metadata.server);

		const promptCachingEnabled = isPromptCachingEnabled();
		const customHeaders = this.customHeadersFor(connection.entryLabel, connection.baseUrl);
		const apiVersion = this.apiVersionFor(connection.entryLabel, connection.baseUrl);
		const requestTimeout = getRequestTimeout(this.log);
		// Validation runs before conversion: a rejected request must not pay the
		// base64 conversion or push conversion's media-drop logs into the public
		// issue-report buffer for a request that never leaves the machine.
		validateRequest(messages);
		// Capability gates for message conversion: the registered imageInput
		// capability decides whether image DataParts ride the wire, and the
		// LiteLLM-derived audio metadata decides whether audio DataParts become
		// input_audio. The pre-send limit check below prices this conversion's
		// output, so it counts the same transmitted forms the request carries.
		const wireGates = { imageInput: metadata.imageInput, audioInput: metadata.supportsAudioInput };
		const converted = convertMessages(messages, { log: this.log, ...wireGates });
		const toolConfig = convertTools(options, getAdditionalToolSchemaKeywords(this.log));

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

		const { messages: openaiMessages, tools: cachedTools } =
			promptCachingEnabled && metadata.supportsPromptCaching
				? applyPromptCacheBreakpoints({ messages: converted, tools: toolConfig?.tools })
				: { messages: converted, tools: toolConfig?.tools };

		// Price the very message array the request sends, never a second
		// conversion of the same input; cache_control markers are token-neutral.
		// Tools price unmarked: a marker would be JSON.stringified as content.
		const inputTokenCount = estimateWireMessagesTokens(openaiMessages);
		const toolTokenCount = estimateToolTokens(toolConfig?.tools);
		const tokenLimit = Math.max(1, model.maxInputTokens);
		if (inputTokenCount + toolTokenCount > tokenLimit) {
			// The numbers must survive in the detail: docs/troubleshooting.md
			// teaches comparing the limit against the model's real one (the
			// models.capabilities fix).
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

		// The attached server's label and base URL together name the declared
		// settings entry this request is routed through (two entries may share a
		// base URL, so the label tells them apart); unlabeled servers contribute
		// none. The match is label plus URL, deliberately not credentials: any
		// group carrying the entry's label at the entry's URL resolves, a
		// hand-labeled native group included. What the URL check excludes is a
		// same-label group at another URL, stale from a label reuse or a baseUrl
		// edit.
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
			apiVersion,
			apiKey: connection.apiKey,
			userAgent: this.userAgent,
			customHeaders,
		});

		this.log("Sending chat request", {
			url: chatCompletionsUrl(connection.baseUrl, apiVersion),
			modelId: connection.rawModelId,
			messageCount: messages.length,
		});

		// User cancellation must abort the in-flight request, not just stop the
		// read loop, so the token is bridged onto an AbortController combined
		// with the request timeout. The per-request timeout keeps the SDK's own
		// 600 s time-to-headers default from cutting in before ours; the
		// AbortSignal.timeout is what bounds the whole call, including a stream
		// that stalls after headers (the SDK disarms its timer once headers
		// arrive).
		const cancelController = new AbortController();
		const cancelListener = token.onCancellationRequested(() => cancelController.abort());
		const timeoutSignal = AbortSignal.timeout(requestTimeout);
		const requestSignal = AbortSignal.any([cancelController.signal, timeoutSignal]);
		const errorContext = { surface: "chat" as const, baseUrl: connection.baseUrl, timeoutMs: requestTimeout };
		let auth: AuthOverlayScope | undefined;

		try {
			const resolvedAuth = await this.resolveAuthHeaders(
				{ oauth: connection.oauth, virtualKey: connection.virtualKey },
				"chat",
				{ ms: getDiscoveryTimeout(this.log), setting: "discovery.timeout" },
				requestSignal
			);
			auth = resolvedAuth.auth;
			const response = await client
				.post(CHAT_COMPLETIONS_PATH, {
					body: requestBody,
					signal: requestSignal,
					timeout: requestTimeout,
					...(resolvedAuth.headers !== undefined ? { headers: resolvedAuth.headers } : {}),
				})
				.asResponse();

			if (!response.body) {
				// One constructor with the one-shot stream's bodyless-200 error, so
				// the copy cannot drift between the two streaming paths.
				throw bodylessResponseError("chat", response.status, connection.baseUrl);
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
			auth?.fail(mapped);
			throw mapped;
		} finally {
			cancelListener.dispose();
		}
	}
}
