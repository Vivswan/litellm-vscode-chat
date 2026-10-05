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
import type { NonChatMode } from "../../shared/serverEntry";
import type { ServerWithKey } from "../../shared/servers";
import { isRecord } from "../../shared/util/json";
import { validateRequest } from "../../shared/validation";
import type { ExpectedDiscoveryFailures, FetchModelsResult } from "../catalog/discovery";
import { fetchModels } from "../catalog/discovery";
import type {
	EntryCredentialsResolver,
	GroupServer,
	LiteLLMModelInfo,
	ParsedModelMetadata,
} from "../catalog/groupModels";
import { groupClientId, overlayEntryCredentials, parseModelMetadata } from "../catalog/groupModels";
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
import type { TransportFetch } from "./nodeHttpFetch";
import { nodeHttpFetch } from "./nodeHttpFetch";
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

export interface ServerConnection extends ServerWithKey {
	oauth?: OAuthConfig;
	virtualKey?: VirtualKeyConfig;
	/**
	 * The label naming the declared entry candidate for per-entry headers: a group's CONFIGURED label, never the
	 * URL-host display fallback an unlabeled group renders under, which could collide with a real entry label. Distinct
	 * from `label`, which is display text.
	 */
	entryLabel?: string | undefined;
}

/**
 * Every field is required (undefined must be stated, not omitted), so a resolution branch cannot silently drop the
 * credentials another branch carries.
 */
interface ResolvedConnection {
	serverId: string;
	baseUrl: string;
	apiKey: string;
	rawModelId: string;
	entryLabel: string | undefined;
	oauth: OAuthConfig | undefined;
	virtualKey: VirtualKeyConfig | undefined;
}

export interface ChatClientOptions {
	userAgent: string;
	logger?: Logger | undefined;
	/**
	 * Resolves a declared server entry's per-entry modelParameters at request time, from the entry's label and the
	 * attached server's base URL, and only when both identify the same declared entry. Defaults to none: models
	 * without an attached labeled server (external groups) get only the global modelParameters.
	 */
	getEntryModelParameters?:
		| ((label: string, baseUrl: string) => Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined)
		| undefined;
	/**
	 * The provider-owned flat resolution table; requests read their configured parameters through it so the request
	 * path, registration, and the dashboard share one cache. Defaults to a private table for callers constructed
	 * without a provider.
	 */
	resolution?: ModelResolutionTable | undefined;
	getEntryHeaders?: ((label: string, baseUrl: string) => Readonly<Record<string, string>> | undefined) | undefined;
	/**
	 * "" is a real value (append nothing), distinct from undefined (auto). Defaults to none: servers no declared entry
	 * matches get the auto rule.
	 */
	getEntryApiVersion?: ((label: string, baseUrl: string) => string | undefined) | undefined;
	resolveEntryCredentials?: EntryCredentialsResolver | undefined;
	/** The HTTP transport under the SDK client; tests inject a fake here. Defaults to nodeHttpFetch. */
	fetch?: TransportFetch | undefined;
}

/** Owns the HTTP-facing side of the provider. */
export class ChatClient {
	private readonly userAgent: string;
	private readonly logger?: Logger | undefined;
	private readonly getEntryModelParameters: (
		label: string,
		baseUrl: string
	) => Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined;
	private readonly getEntryHeaders: (label: string, baseUrl: string) => Readonly<Record<string, string>> | undefined;
	private readonly getEntryApiVersion: (label: string, baseUrl: string) => string | undefined;
	private readonly resolveEntryCredentials?: EntryCredentialsResolver | undefined;
	private readonly clients: ServerClientCache;
	private readonly oauthTokens = new OAuthTokenSource();
	private readonly resolution: ModelResolutionTable;
	private _toolCallIdCounter = 0;
	// The single owner of tool-call ID generation; see ToolCallIdSource for the synchronous-advance requirement.
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
		this.resolveEntryCredentials = options.resolveEntryCredentials;
		this.resolution = options.resolution ?? new ModelResolutionTable();
		this.clients = new ServerClientCache(options.fetch ?? nodeHttpFetch);
	}

	/** Copied because the client cache expects an owned record. */
	private customHeadersFor(entryLabel: string | undefined, baseUrl: string): Record<string, string> {
		const headers = entryLabel !== undefined ? this.getEntryHeaders(entryLabel, baseUrl) : undefined;
		return headers !== undefined ? { ...headers } : {};
	}

	private apiVersionFor(entryLabel: string | undefined, baseUrl: string): string | undefined {
		return entryLabel !== undefined ? this.getEntryApiVersion(entryLabel, baseUrl) : undefined;
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
				...(expected !== undefined ? { expected } : {}),
				...(includeModes !== undefined ? { includeModes } : {}),
				...(headers !== undefined ? { headers } : {}),
			});
		} catch (error) {
			auth.fail(error);
			throw error;
		}
	}

	/**
	 * Both surfaces this client serves bound their token wait by the discovery timeout (auth plumbing, not a chat
	 * call), so `timeout` arrives minted at the caller's getDiscoveryTimeout read. `signal`, when the triggering
	 * call carries one, ends this call's token wait, so user cancellation and the chat timeout cut in.
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
	 * Every served model carries its group's resolved connection, so a model without one crossed the host boundary in
	 * a state this provider never served (most likely a stale model object from before a refresh) and fails loudly
	 * with a classified error instead of an undefined route; the terse classification keeps the model ID out of public
	 * logs.
	 */
	private resolveConnection(
		model: LiteLLMModelInfo,
		metadata: Pick<ParsedModelMetadata, "server" | "rawModelId">
	): ResolvedConnection {
		const groupServer = metadata.server;
		if (groupServer) {
			return {
				serverId: groupClientId(groupServer),
				baseUrl: groupServer.baseUrl,
				apiKey: groupServer.apiKey,
				rawModelId: metadata.rawModelId,
				// The configured group label only; an unlabeled group resolves no entry configuration (its display
				// label is a URL-host fallback).
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

	/**
	 * The attached credentials are the serve-time copy a rotation may have retired, so an unresolved entry fails the
	 * request instead of sending them. Throws without logging, like every transport module.
	 */
	private async overlaidServer(server: GroupServer | undefined): Promise<GroupServer | undefined> {
		if (server === undefined) {
			return undefined;
		}
		const overlaid = await overlayEntryCredentials(server, this.resolveEntryCredentials);
		if (overlaid.failure !== undefined) {
			throw overlaid.failure;
		}
		return overlaid.server;
	}

	async send(ctx: ChatRequestContext): Promise<void> {
		const { model, messages, options, progress, token } = ctx;

		// The one parse of the model object's LiteLLM metadata; everything below reads the parsed result instead of
		// re-narrowing the host round trip.
		const parsed = parseModelMetadata(model, this.log);
		// Attached credentials date from the serve that minted the model object; the overlay swaps in the entry's
		// current ones so a rotation applies to the very next request instead of waiting out a host re-resolve.
		const metadata = { ...parsed, server: await this.overlaidServer(parsed.server) };
		const connection = this.resolveConnection(model, metadata);

		const promptCachingEnabled = isPromptCachingEnabled();
		const customHeaders = this.customHeadersFor(connection.entryLabel, connection.baseUrl);
		const apiVersion = this.apiVersionFor(connection.entryLabel, connection.baseUrl);
		const requestTimeout = getRequestTimeout(this.log);
		validateRequest(messages);
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

		// Price the very message array the request sends, never a second conversion of the same input; cache_control
		// markers are token-neutral. Tools price unmarked: a marker would be JSON.stringified as content.
		const inputTokenCount = estimateWireMessagesTokens(openaiMessages);
		const toolTokenCount = estimateToolTokens(toolConfig?.tools);
		const tokenLimit = Math.max(1, model.maxInputTokens);
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

		// The match is label plus URL, deliberately not credentials: any group carrying the entry's label at the
		// entry's URL resolves, a hand-labeled native group included. What the URL check excludes is a same-label group
		// at another URL, stale from a label reuse or a baseUrl edit.
		//   two entries may share a base URL -> the label tells them apart
		const entryModelParameters =
			metadata.server?.label !== undefined
				? this.getEntryModelParameters(metadata.server.label, metadata.server.baseUrl)
				: undefined;
		const { params: modelParams, forcedParams } = this.resolution.resolveParameters(
			connection.serverId,
			connection.rawModelId,
			{ globalParameters: getModelParametersConfig(), entryParameters: entryModelParameters }
		);

		// The one home of the fallback chain is resolveMaxTokens (shared with the dashboard's inspector).
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

		// User cancellation must abort the in-flight request, not just stop the read loop, so the token is bridged onto
		// an AbortController combined with the request timeout. The per-request timeout keeps the SDK's own 600 s
		// time-to-headers default from cutting in before ours; the AbortSignal.timeout is what bounds the whole call,
		// including a stream that stalls after headers (the SDK disarms its timer once headers arrive, and the
		// transport has no idle clock of its own).
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
				throw bodylessResponseError("chat", response.status, connection.baseUrl);
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
			// Every 200 arrives with a body stream, so a server that sent nothing shows only as a stream that ends
			// without a byte; that is the same "nothing came back" as a null body and gets the same error.
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
				throw bodylessResponseError("chat", response.status, connection.baseUrl);
			}
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
