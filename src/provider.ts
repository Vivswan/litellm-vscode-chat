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

import type {
	LiteLLMModelInfoItem,
	LiteLLMModelInfoResponse,
	LiteLLMModelItem,
	LiteLLMModelsResponse,
	LiteLLMProvider,
} from "./types";

import { convertTools, convertMessages, tryParseJSONObject, validateRequest } from "./utils";
import {
	DEFAULT_MAX_OUTPUT_TOKENS,
	DEFAULT_CONTEXT_LENGTH,
	DEFAULT_TEMPERATURE,
	DEFAULT_FALLBACK_MAX_TOKENS,
	CHARS_PER_TOKEN_ESTIMATE,
	IMAGE_TOKEN_ESTIMATE,
	PDF_TOKEN_ESTIMATE,
	MODEL_FETCH_TIMEOUT,
	CHAT_REQUEST_TIMEOUT,
	MAX_TOOLS_PER_REQUEST,
	CONTROL_TOKENS,
	PROVIDER_OWNED_FIELDS,
} from "./constants";
import type {
	StreamingResponseDelta,
	StreamingChoice,
	StreamingDelta,
	ThinkingContent,
	ContentBlock,
	StreamingToolCall,
	TokenUsage,
} from "./types";

/**
 * VS Code Chat provider backed by LiteLLM.
 */
export class LiteLLMChatModelProvider implements LanguageModelChatProvider {
	private _chatEndpoints: { model: string; modelMaxPromptTokens: number }[] = [];

	/** Per-request streaming state, reset at the start of each chat response. */
	private _req = LiteLLMChatModelProvider._freshRequestState();

	/** Cache prompt-caching support per model id as reported by /v1/model/info. */
	private _promptCachingSupport = new Map<string, boolean>();

	/** Callback to update extension status */
	private _statusCallback?: (modelCount: number, error?: string) => void;

	/** Track if we've shown the "no config" notification this session */
	private _hasShownNoConfigNotification = false;

	/** Auto-incrementing counter for generating unique tool call IDs. */
	private _toolCallIdCounter = 0;

	private static _freshRequestState() {
		return {
			toolCallBuffers: new Map<number, { id?: string; name?: string; args: string }>(),
			completedToolCallIndices: new Set<number>(),
			hasEmittedAssistantText: false,
			emittedBeginToolCallsHint: false,
			textToolParserBuffer: "",
			textToolActive: undefined as undefined | { name?: string; index?: number; argBuffer: string; emitted?: boolean },
			emittedTextToolCallKeys: new Set<string>(),
			emittedTextToolCallIds: new Set<string>(),
		};
	}

	/**
	 * Create a provider using the given secret storage for the API key.
	 * @param secrets VS Code secret storage.
	 * @param userAgent User agent string for API requests.
	 * @param outputChannel Output channel for diagnostic logging.
	 */
	constructor(
		private readonly secrets: vscode.SecretStorage,
		private readonly userAgent: string,
		private readonly outputChannel?: vscode.OutputChannel
	) {}

	/**
	 * Set callback to update extension status when models are fetched.
	 * @param callback Function to call with model count or error.
	 */
	setStatusCallback(callback: (modelCount: number, error?: string) => void): void {
		this._statusCallback = callback;
	}

	private log(message: string, data?: unknown): void {
		if (this.outputChannel) {
			const timestamp = new Date().toISOString();
			if (data !== undefined) {
				this.outputChannel.appendLine(`[${timestamp}] ${message}: ${JSON.stringify(data, null, 2)}`);
			} else {
				this.outputChannel.appendLine(`[${timestamp}] ${message}`);
			}
		}
	}

	private logError(message: string, error: unknown): void {
		const errorMsg = error instanceof Error ? error.message : String(error);
		if (this.outputChannel) {
			const timestamp = new Date().toISOString();
			this.outputChannel.appendLine(`[${timestamp}] ERROR: ${message}: ${errorMsg}`);
			if (error instanceof Error && error.stack) {
				this.outputChannel.appendLine(`Stack trace: ${error.stack}`);
			}
		}
	}

	/**
	 * Roughly estimate text tokens for VS Code chat messages.
	 * Only counts text parts — multimodal data (images, PDFs) is excluded because
	 * real token accounting is model- and provider-specific, and this estimate
	 * feeds a hard client-side rejection path.
	 */
	private estimateMessagesTokens(msgs: readonly vscode.LanguageModelChatRequestMessage[]): number {
		let total = 0;
		for (const m of msgs) {
			for (const part of m.content) {
				if (part instanceof vscode.LanguageModelTextPart) {
					total += Math.ceil(part.value.length / CHARS_PER_TOKEN_ESTIMATE);
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					total += Math.ceil((part.name.length + JSON.stringify(part.input ?? {}).length) / CHARS_PER_TOKEN_ESTIMATE);
				} else if (part instanceof vscode.LanguageModelDataPart) {
					const mime = part.mimeType.toLowerCase();
					if (mime.startsWith("text/") || mime === "application/json" || mime.endsWith("+json")) {
						total += Math.ceil(part.data.length / CHARS_PER_TOKEN_ESTIMATE);
					}
					// Images/PDFs excluded: real costs are model-specific, let LiteLLM handle rejection
				}
			}
		}
		return total;
	}

	/** Rough token estimate for tool definitions by JSON size */
	private estimateToolTokens(
		tools: { type: string; function: { name: string; description?: string; parameters?: object } }[] | undefined
	): number {
		if (!tools || tools.length === 0) {
			return 0;
		}
		try {
			const json = JSON.stringify(tools);
			return Math.ceil(json.length / CHARS_PER_TOKEN_ESTIMATE);
		} catch {
			return 0;
		}
	}

	/**
	 * Resolve token constraints from provider info, workspace settings, or defaults.
	 *
	 * This reads model CAPABILITIES from the LiteLLM API to understand what each
	 * model can handle. This is separate from modelParameters which sets request
	 * parameters.
	 *
	 * Priority: provider info > workspace settings > hardcoded defaults
	 */
	private getTokenConstraints(provider: LiteLLMProvider | undefined): {
		maxOutputTokens: number;
		contextLength: number;
		maxInputTokens: number;
	} {
		const config = vscode.workspace.getConfiguration("litellm-vscode-chat");
		const normalizePositive = (value: unknown): number | undefined =>
			typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

		// Resolve max output tokens
		const maxOutputTokens =
			normalizePositive(provider?.max_output_tokens) ??
			normalizePositive(provider?.max_tokens) ??
			normalizePositive(config.get<number>("defaultMaxOutputTokens", DEFAULT_MAX_OUTPUT_TOKENS)) ??
			DEFAULT_MAX_OUTPUT_TOKENS;

		// Resolve context length
		const contextLength =
			normalizePositive(provider?.context_length) ??
			normalizePositive(config.get<number>("defaultContextLength", DEFAULT_CONTEXT_LENGTH)) ??
			DEFAULT_CONTEXT_LENGTH;

		// Resolve max input tokens
		const configMaxInput = normalizePositive(config.get<number | null>("defaultMaxInputTokens", null));
		const maxInputTokens =
			configMaxInput ?? normalizePositive(provider?.max_input_tokens) ?? Math.max(1, contextLength - maxOutputTokens);

		return { maxOutputTokens, contextLength, maxInputTokens };
	}

	/**
	 * Resolve model-specific parameters from configuration using longest prefix match.
	 *
	 * This reads user configuration to customize request PARAMETERS sent to the
	 * LiteLLM API. This is separate from getTokenConstraints which reads model
	 * CAPABILITIES.
	 *
	 * @param modelId The model ID to match against configuration keys
	 * @returns Object containing model-specific parameters, or empty object if no match
	 */
	private getModelParameters(modelId: string): Record<string, unknown> {
		const config = vscode.workspace.getConfiguration("litellm-vscode-chat");
		const modelParameters = config.get<Record<string, Record<string, unknown>>>("modelParameters", {});

		// Find longest matching prefix
		let longestMatch: { key: string; value: Record<string, unknown> } | undefined;

		for (const [key, value] of Object.entries(modelParameters)) {
			if (modelId === key || modelId.startsWith(key)) {
				if (!longestMatch || key.length > longestMatch.key.length) {
					longestMatch = { key, value };
				}
			}
		}

		return longestMatch ? { ...longestMatch.value } : {};
	}

	/**
	 * Get the list of available language models contributed by this provider
	 * @param options Options which specify the calling context of this function
	 * @param token A cancellation token which signals if the user cancelled the request or not
	 * @returns A promise that resolves to the list of available language models
	 */
	async prepareLanguageModelChatInformation(
		options: { silent: boolean },
		_token: CancellationToken
	): Promise<LanguageModelChatInformation[]> {
		this.log("prepareLanguageModelChatInformation called", { silent: options.silent });

		const config = await this.ensureConfig(options.silent);
		if (!config) {
			this.log("No config found, returning empty array");

			// Show one-time notification when no config in silent mode
			if (options.silent && !this._hasShownNoConfigNotification) {
				this._hasShownNoConfigNotification = true;
				vscode.window
					.showWarningMessage("LiteLLM: No configuration found. Click to configure.", "Configure Now", "Dismiss")
					.then((choice) => {
						if (choice === "Configure Now") {
							vscode.commands.executeCommand("litellm.manage");
						}
					});
			}

			// Notify status callback
			if (this._statusCallback) {
				this._statusCallback(0, "Not configured");
			}
			return [];
		}
		this.log("Config loaded", { baseUrl: config.baseUrl, hasApiKey: !!config.apiKey });

		let models: LiteLLMModelItem[];
		try {
			const result = await this.fetchModels(config.apiKey, config.baseUrl);
			models = result.models;
			// Clear cache only on successful fetch to preserve existing data on failure
			this._promptCachingSupport.clear();
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			this.logError("Failed to fetch models", err);

			// Notify status callback of error
			if (this._statusCallback) {
				this._statusCallback(0, errorMsg);
			}

			// When silent mode is enabled (e.g., background refresh or "Add models" button),
			// show an error notification so the user knows what went wrong
			if (options.silent) {
				vscode.window.showErrorMessage(`LiteLLM: ${errorMsg}`, "Reconfigure", "Dismiss").then((choice) => {
					if (choice === "Reconfigure") {
						vscode.commands.executeCommand("litellm.manage");
					}
				});
				// Return empty array instead of throwing to prevent the UI from breaking
				return [];
			}
			// In non-silent mode, re-throw to let the caller handle it
			throw err;
		}

		this.log("Fetched models", { count: models.length, modelIds: models.map((m) => m.id) });

		// Warn if server returns empty model list
		if (models.length === 0) {
			this.log("WARNING: Server returned empty model list");
			if (this._statusCallback) {
				this._statusCallback(0, "Server returned 0 models");
			}
			vscode.window
				.showWarningMessage(
					"LiteLLM: Your server returned no models. Check your LiteLLM proxy configuration.",
					"Check Server",
					"Reconfigure"
				)
				.then((choice) => {
					if (choice === "Check Server") {
						vscode.commands.executeCommand("litellm.testConnection");
					} else if (choice === "Reconfigure") {
						vscode.commands.executeCommand("litellm.manage");
					}
				});
			return [];
		}

		const infos: LanguageModelChatInformation[] = models.flatMap((m) => {
			this.log(`Processing model: ${m.id}`);
			const providers = m?.providers ?? [];
			this.log(
				`  - providers: ${providers.length}`,
				providers.map((p) => ({ provider: p.provider, supports_tools: p.supports_tools }))
			);
			const modalities = m.architecture?.input_modalities ?? [];
			const vision = Array.isArray(modalities) && modalities.includes("image");

			if (providers.length === 1 && providers[0].source === "model_info") {
				const constraints = this.getTokenConstraints(providers[0]);
				this._promptCachingSupport.set(m.id, providers[0].supports_prompt_caching === true);
				return [
					{
						id: m.id,
						name: m.id,
						detail: "LiteLLM",
						tooltip: "LiteLLM",
						family: "litellm",
						version: "1.0.0",
						maxInputTokens: constraints.maxInputTokens,
						maxOutputTokens: constraints.maxOutputTokens,
						capabilities: {
							toolCalling: providers[0].supports_tools !== false,
							imageInput: vision,
						},
					} satisfies LanguageModelChatInformation,
				];
			}

			// If no providers array exists (standard OpenAI-compatible API), create a default entry
			if (providers.length === 0) {
				this.log(`  - no providers array, creating default entry`);
				const constraints = this.getTokenConstraints(undefined);
				this._promptCachingSupport.set(m.id, false);
				return [
					{
						id: m.id,
						name: m.id,
						detail: "LiteLLM",
						tooltip: "LiteLLM",
						family: "litellm",
						version: "1.0.0",
						maxInputTokens: constraints.maxInputTokens,
						maxOutputTokens: constraints.maxOutputTokens,
						capabilities: {
							toolCalling: true, // Assume tool calling is supported
							imageInput: vision,
						},
					} satisfies LanguageModelChatInformation,
				];
			}

			// Build entries for all providers that support tool calling
			// Assume supports_tools is true if not explicitly set to false
			const toolProviders = providers.filter((p) => p.supports_tools !== false);
			this.log(
				`  - toolProviders: ${toolProviders.length}`,
				toolProviders.map((p) => p.provider)
			);
			const entries: LanguageModelChatInformation[] = [];

			if (toolProviders.length > 0) {
				const providerConstraints = toolProviders.map((p) => this.getTokenConstraints(p));
				const aggregateContextLen = Math.min(...providerConstraints.map((c) => c.contextLength));
				const maxOutput = Math.min(...providerConstraints.map((c) => c.maxOutputTokens));
				const maxInput = Math.max(1, aggregateContextLen - maxOutput);
				const aggregatePromptCaching = toolProviders.every((p) => p.supports_prompt_caching === true);
				const aggregateCapabilities = {
					toolCalling: true,
					imageInput: vision,
				};
				entries.push({
					id: `${m.id}:cheapest`,
					name: `${m.id} (cheapest)`,
					detail: "LiteLLM",
					tooltip: "LiteLLM via the cheapest provider",
					family: "litellm",
					version: "1.0.0",
					maxInputTokens: maxInput,
					maxOutputTokens: maxOutput,
					capabilities: aggregateCapabilities,
				} satisfies LanguageModelChatInformation);
				this._promptCachingSupport.set(`${m.id}:cheapest`, aggregatePromptCaching);
				entries.push({
					id: `${m.id}:fastest`,
					name: `${m.id} (fastest)`,
					detail: "LiteLLM",
					tooltip: "LiteLLM via the fastest provider",
					family: "litellm",
					version: "1.0.0",
					maxInputTokens: maxInput,
					maxOutputTokens: maxOutput,
					capabilities: aggregateCapabilities,
				} satisfies LanguageModelChatInformation);
				this._promptCachingSupport.set(`${m.id}:fastest`, aggregatePromptCaching);
			}

			for (const p of toolProviders) {
				const constraints = this.getTokenConstraints(p);
				const maxOutput = constraints.maxOutputTokens;
				const maxInput = constraints.maxInputTokens;
				entries.push({
					id: `${m.id}:${p.provider}`,
					name: `${m.id} via ${p.provider}`,
					detail: "LiteLLM",
					tooltip: `LiteLLM via ${p.provider}`,
					family: "litellm",
					version: "1.0.0",
					maxInputTokens: maxInput,
					maxOutputTokens: maxOutput,
					capabilities: {
						toolCalling: true,
						imageInput: vision,
					},
				} satisfies LanguageModelChatInformation);
				this._promptCachingSupport.set(`${m.id}:${p.provider}`, p.supports_prompt_caching === true);
			}

			if (toolProviders.length === 0 && providers.length > 0) {
				const base = providers[0];
				const constraints = this.getTokenConstraints(base);
				const maxOutput = constraints.maxOutputTokens;
				const maxInput = constraints.maxInputTokens;
				entries.push({
					id: m.id,
					name: m.id,
					detail: "LiteLLM",
					tooltip: "LiteLLM",
					family: "litellm",
					version: "1.0.0",
					maxInputTokens: maxInput,
					maxOutputTokens: maxOutput,
					capabilities: {
						toolCalling: false,
						imageInput: vision,
					},
				} satisfies LanguageModelChatInformation);
				this._promptCachingSupport.set(m.id, base.supports_prompt_caching === true);
			}

			this.log(`  - created ${entries.length} entries for model ${m.id}`);
			return entries;
		});

		this._chatEndpoints = infos.map((info) => ({
			model: info.id,
			modelMaxPromptTokens: info.maxInputTokens + info.maxOutputTokens,
		}));

		this.log("Final model count:", infos.length);
		this.log(
			"Model IDs:",
			infos.map((i) => i.id)
		);

		// Notify status callback of success
		if (this._statusCallback) {
			this._statusCallback(infos.length);
		}

		return infos;
	}

	async provideLanguageModelChatInformation(
		options: { silent: boolean },
		_token: CancellationToken
	): Promise<LanguageModelChatInformation[]> {
		return this.prepareLanguageModelChatInformation({ silent: options.silent ?? false }, _token);
	}

	/**
	 * Fetch the list of models and supplementary metadata from LiteLLM.
	 * @param apiKey The LiteLLM API key used to authenticate.
	 * @param baseUrl The LiteLLM base URL.
	 */
	/**
	 * Map /v1/model/info entries into a /v1/models-like shape for reuse.
	 *
	 * Extracts the model ID using fallback priority:
	 * 1. item.model_name (preferred, most specific)
	 * 2. item.litellm_params?.model (fallback)
	 * 3. item.model_info?.key (secondary fallback)
	 * 4. item.model_info?.id (last resort)
	 */
	private mapModelInfoToLiteLLMModel(item: LiteLLMModelInfoItem): LiteLLMModelItem | undefined {
		const modelId = item.model_name ?? item.litellm_params?.model ?? item.model_info?.key ?? item.model_info?.id;

		if (!modelId) {
			return undefined;
		}

		const supportsTools = item.model_info?.supports_function_calling ?? item.model_info?.supports_tool_choice ?? true;
		const providerName = item.model_info?.litellm_provider ?? "litellm";
		const normalizePositive = (value: unknown): number | undefined =>
			typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
		const maxInputTokens = normalizePositive(item.model_info?.max_input_tokens);
		const maxOutputTokens =
			normalizePositive(item.model_info?.max_output_tokens) ?? normalizePositive(item.model_info?.max_tokens);
		const maxTokens =
			normalizePositive(item.model_info?.max_tokens) ?? normalizePositive(item.model_info?.max_output_tokens);

		const provider: LiteLLMProvider = {
			provider: providerName,
			status: "ok",
			supports_tools: supportsTools,
			context_length: maxInputTokens ?? maxTokens,
			max_tokens: maxTokens,
			max_input_tokens: maxInputTokens,
			max_output_tokens: maxOutputTokens,
			source: "model_info",
			supports_prompt_caching: item.model_info?.supports_prompt_caching ?? null,
			supports_response_schema: item.model_info?.supports_response_schema ?? null,
			supports_reasoning: item.model_info?.supports_reasoning ?? null,
			supports_pdf_input: item.model_info?.supports_pdf_input ?? null,
			supported_openai_params: item.model_info?.supported_openai_params ?? null,
		};

		const inputModalities: string[] = [];
		if (item.model_info?.supports_vision) {
			inputModalities.push("image");
		}
		if (item.model_info?.supports_pdf_input) {
			inputModalities.push("pdf");
		}
		const architecture = inputModalities.length > 0 ? { input_modalities: inputModalities } : undefined;

		return {
			id: modelId,
			object: "model",
			created: 0,
			owned_by: providerName,
			providers: [provider],
			architecture,
		};
	}

	private async fetchModels(apiKey: string, baseUrl: string): Promise<{ models: LiteLLMModelItem[] }> {
		this.log("fetchModels called", { baseUrl, hasApiKey: !!apiKey });
		const headers: Record<string, string> = { "User-Agent": this.userAgent };
		if (apiKey) {
			// Try both authentication methods: standard Bearer and X-API-Key
			headers.Authorization = `Bearer ${apiKey}`;
			headers["X-API-Key"] = apiKey;
		}
		const readErrorText = async (resp: Response): Promise<string> => {
			let text = "";
			try {
				text = await resp.text();
			} catch (error) {
				this.logError("Failed to read response text", error);
			}
			return text;
		};

		const handleNonOk = async (resp: Response): Promise<never> => {
			const text = await readErrorText(resp);
			// Provide helpful error message for authentication failures
			if (resp.status === 401) {
				const err = new Error(
					`Authentication failed: Your LiteLLM server requires an API key. Please run the "Manage LiteLLM Provider" command to configure your API key.`
				);
				this.logError("Authentication error", err);
				throw err;
			}

			const err = new Error(
				`Failed to fetch LiteLLM models: ${resp.status} ${resp.statusText}${text ? `\n${text}` : ""}`
			);
			this.logError("Failed to fetch LiteLLM models", err);
			throw err;
		};

		this.log("Fetching from:", `${baseUrl}/v1/model/info`);

		try {
			const infoResp = await fetch(`${baseUrl}/v1/model/info`, {
				method: "GET",
				headers,
				signal: AbortSignal.timeout(MODEL_FETCH_TIMEOUT),
			});
			this.log("Response status:", `${infoResp.status} ${infoResp.statusText}`);
			if (infoResp.ok) {
				const parsed = (await infoResp.json()) as LiteLLMModelInfoResponse | LiteLLMModelsResponse;
				const data = (parsed as LiteLLMModelInfoResponse).data ?? [];
				this.log("Parsed model/info response:", { modelCount: data.length });
				if (data.length > 0) {
					this.log("First model/info sample:", JSON.stringify(data[0], null, 2));
				}

				const first = data[0] as LiteLLMModelItem | undefined;
				if (first && typeof (first as LiteLLMModelItem).id === "string" && Array.isArray(first.providers)) {
					const models = data as LiteLLMModelItem[];
					this.log("Successfully fetched models:", models.length);
					return { models };
				}

				const models = data
					.map((item) => this.mapModelInfoToLiteLLMModel(item as LiteLLMModelInfoItem))
					.filter((m): m is LiteLLMModelItem => Boolean(m));
				if (data.length > 0 && models.length === 0) {
					this.log("model/info returned data but no mappable models; falling back", { dataLength: data.length });
				} else {
					this.log("Successfully fetched models:", models.length);
					return { models };
				}
			}
			// Fall through to /v1/models fallback
		} catch (error) {
			this.log("model/info failed, falling back to /v1/models", error);
			// Fall through to /v1/models fallback
		}

		// Fallback to /v1/models
		try {
			this.log("Fetching from:", `${baseUrl}/v1/models`);
			const resp = await fetch(`${baseUrl}/v1/models`, {
				method: "GET",
				headers,
				signal: AbortSignal.timeout(MODEL_FETCH_TIMEOUT),
			});
			this.log("Response status:", `${resp.status} ${resp.statusText}`);
			if (!resp.ok) {
				await handleNonOk(resp);
			}
			const parsed = (await resp.json()) as LiteLLMModelsResponse;
			this.log("Parsed response:", {
				object: parsed.object,
				modelCount: parsed.data?.length ?? 0,
			});
			if (parsed.data && parsed.data.length > 0) {
				this.log("First model sample:", JSON.stringify(parsed.data[0], null, 2));
			}
			const models = parsed.data ?? [];
			this.log("Successfully fetched models:", models.length);
			return { models };
		} catch (fetchError) {
			// Enhanced error handling for network and certificate issues
			const errMsg = fetchError instanceof Error ? fetchError.message : String(fetchError);
			const cause = (fetchError as Error & { cause?: unknown })?.cause;
			const causeMsg = cause instanceof Error ? cause.message : String(cause);

			// Check for common network errors
			if (causeMsg.includes("certificate has expired") || causeMsg.includes("CERT_HAS_EXPIRED")) {
				const err = new Error(
					`SSL Certificate Error: The SSL certificate for ${baseUrl} has expired. Please contact your LiteLLM server administrator to renew the certificate, or update your base URL.`
				);
				this.logError("Certificate error", err);
				throw err;
			} else if (causeMsg.includes("certificate") || errMsg.includes("certificate")) {
				const err = new Error(
					`SSL Certificate Error: There is an issue with the SSL certificate for ${baseUrl}. Error: ${causeMsg || errMsg}`
				);
				this.logError("Certificate error", err);
				throw err;
			} else if (causeMsg.includes("ENOTFOUND") || causeMsg.includes("ECONNREFUSED")) {
				const err = new Error(
					`Connection Error: Unable to connect to ${baseUrl}. Please check that the server is running and the URL is correct.`
				);
				this.logError("Connection error", err);
				throw err;
			} else {
				const err = new Error(
					`Network Error: Failed to fetch models from ${baseUrl}. ${errMsg}${causeMsg && causeMsg !== errMsg ? `. Cause: ${causeMsg}` : ""}`
				);
				this.logError("Network error", err);
				throw err;
			}
		}
	}

	/**
	 * Returns the response for a chat request, passing the results to the progress callback.
	 * The {@linkcode LanguageModelChatProvider} must emit the response parts to the progress callback as they are received from the language model.
	 * @param model The language model to use
	 * @param messages The messages to include in the request
	 * @param options Options for the request
	 * @param progress The progress to emit the streamed response chunks to
	 * @param token A cancellation token for the request
	 * @returns A promise that resolves when the response is complete. Results are actually passed to the progress callback.
	 */
	async provideLanguageModelChatResponse(
		model: LanguageModelChatInformation,
		messages: readonly LanguageModelChatRequestMessage[],
		options: ProvideLanguageModelChatResponseOptions,
		progress: Progress<LanguageModelResponsePart>,
		token: CancellationToken
	): Promise<void> {
		this._req = LiteLLMChatModelProvider._freshRequestState();

		let requestBody: Record<string, unknown> | undefined;
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
			const config = await this.ensureConfig(true);
			if (!config) {
				throw new Error("LiteLLM configuration not found");
			}

			const settings = vscode.workspace.getConfiguration("litellm-vscode-chat");
			const promptCachingEnabled = settings.get<boolean>("promptCaching.enabled", true);
			const supportsPromptCaching = this._promptCachingSupport.get(model.id) === true;
			const openaiMessages = convertMessages(messages, {
				cacheSystemPrompt: promptCachingEnabled && supportsPromptCaching,
			});
			validateRequest(messages);
			const toolConfig = convertTools(options);

			if (options.tools && options.tools.length > MAX_TOOLS_PER_REQUEST) {
				throw new Error(`Cannot have more than ${MAX_TOOLS_PER_REQUEST} tools per request.`);
			}

			const inputTokenCount = this.estimateMessagesTokens(messages);
			const toolTokenCount = this.estimateToolTokens(toolConfig.tools);
			const tokenLimit = Math.max(1, model.maxInputTokens);
			if (inputTokenCount + toolTokenCount > tokenLimit) {
				this.logError("Message exceeds token limit", {
					total: inputTokenCount + toolTokenCount,
					tokenLimit,
				});
				throw new Error("Message exceeds token limit.");
			}

			// 1. Get model-specific parameters from configuration
			const modelParams = this.getModelParameters(model.id);

			// 2. Determine max_tokens with proper precedence and clamping logic
			let maxTokens: number;

			if (typeof options.modelOptions?.max_tokens === "number") {
				// Runtime options have highest priority - use directly without clamping
				maxTokens = options.modelOptions.max_tokens;
			} else if (typeof modelParams.max_tokens === "number") {
				// Model-specific config - use directly without clamping
				maxTokens = modelParams.max_tokens;
			} else {
				// Default value - clamp to model's maximum
				maxTokens = Math.min(DEFAULT_FALLBACK_MAX_TOKENS, model.maxOutputTokens);
			}

			// Build base request body
			requestBody = {
				model: model.id,
				messages: openaiMessages,
				stream: true,
				stream_options: { include_usage: true },
				max_tokens: maxTokens,
				temperature: DEFAULT_TEMPERATURE,
			};

			// 3. Apply model-specific parameters from configuration (max_tokens already handled)
			for (const [key, value] of Object.entries(modelParams)) {
				if (key !== "max_tokens" && !PROVIDER_OWNED_FIELDS.has(key)) {
					(requestBody as Record<string, unknown>)[key] = value;
				}
			}

			// 4. Apply runtime options.modelOptions — broad pass-through (highest priority)
			if (options.modelOptions) {
				for (const [key, value] of Object.entries(options.modelOptions as Record<string, unknown>)) {
					if (key === "max_tokens") {
						continue; // already handled above with special precedence
					}
					if (PROVIDER_OWNED_FIELDS.has(key)) {
						continue; // never overwrite provider-owned fields
					}
					if (key.startsWith("_")) {
						continue; // skip VS Code internal fields (e.g. _capturingTokenCorrelationId)
					}
					(requestBody as Record<string, unknown>)[key] = value;
				}
			}

			if (toolConfig.tools) {
				(requestBody as Record<string, unknown>).tools = toolConfig.tools;
			}
			if (toolConfig.tool_choice) {
				(requestBody as Record<string, unknown>).tool_choice = toolConfig.tool_choice;
			}
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
				"User-Agent": this.userAgent,
			};
			if (config.apiKey) {
				// Try both authentication methods: standard Bearer and X-API-Key
				headers.Authorization = `Bearer ${config.apiKey}`;
				headers["X-API-Key"] = config.apiKey;
			}
			this.log("Sending chat request", {
				url: `${config.baseUrl}/v1/chat/completions`,
				modelId: model.id,
				messageCount: messages.length,
			});
			const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
				method: "POST",
				headers,
				body: JSON.stringify(requestBody),
				signal: AbortSignal.timeout(CHAT_REQUEST_TIMEOUT),
			});

			if (!response.ok) {
				const errorText = await response.text();
				this.logError("API error response", errorText);

				// Provide helpful error message for authentication failures
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
			await this.processStreamingResponse(response.body, trackingProgress, token);
		} catch (err) {
			this.logError("Chat request failed", err);
			throw err;
		}
	}

	/**
	 * Returns the number of tokens for a given text using the model specific tokenizer logic
	 * @param model The language model to use
	 * @param text The text to count tokens for
	 * @param token A cancellation token for the request
	 * @returns A promise that resolves to the number of tokens
	 */
	async provideTokenCount(
		_model: LanguageModelChatInformation,
		text: string | LanguageModelChatRequestMessage,
		_token: CancellationToken
	): Promise<number> {
		if (typeof text === "string") {
			return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
		} else {
			let totalTokens = 0;
			for (const part of text.content) {
				if (part instanceof vscode.LanguageModelTextPart) {
					totalTokens += Math.ceil(part.value.length / CHARS_PER_TOKEN_ESTIMATE);
				} else if (part instanceof vscode.LanguageModelDataPart) {
					const mime = part.mimeType.toLowerCase();
					if (mime.startsWith("image/")) {
						totalTokens += IMAGE_TOKEN_ESTIMATE;
					} else if (mime === "application/pdf") {
						totalTokens += PDF_TOKEN_ESTIMATE;
					} else if (mime.startsWith("text/") || mime === "application/json" || mime.endsWith("+json")) {
						totalTokens += Math.ceil(part.data.length / CHARS_PER_TOKEN_ESTIMATE);
					}
				}
			}
			return totalTokens;
		}
	}

	/**
	 * Ensure base URL and API key exist in SecretStorage, optionally prompting the user when not silent.
	 * @param silent If true, do not prompt the user.
	 */
	private async ensureConfig(silent: boolean): Promise<{ baseUrl: string; apiKey: string } | undefined> {
		this.log("ensureConfig called", { silent });
		let baseUrl = await this.secrets.get("litellm.baseUrl");
		let apiKey = await this.secrets.get("litellm.apiKey");
		this.log("Retrieved from secrets:", { hasBaseUrl: !!baseUrl, hasApiKey: !!apiKey });

		if (!baseUrl) {
			if (silent) {
				return undefined;
			}

			// Show error with action buttons
			const result = await vscode.window.showErrorMessage(
				"LiteLLM is not configured. Set up your connection to use this provider.",
				"Configure Now",
				"Learn More"
			);

			if (result === "Configure Now") {
				await vscode.commands.executeCommand("litellm.manage");
				// Re-fetch config after user completes setup
				baseUrl = await this.secrets.get("litellm.baseUrl");
				apiKey = await this.secrets.get("litellm.apiKey");
			} else if (result === "Learn More") {
				vscode.env.openExternal(vscode.Uri.parse("https://github.com/Vivswan/litellm-vscode-chat#quick-start"));
			}

			if (!baseUrl) {
				this.log("No baseUrl configured, returning undefined");
				return undefined;
			}
		}

		this.log("Config ready:", { baseUrl, hasApiKey: !!apiKey });
		return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey: apiKey ?? "" };
	}

	/**
	 * Read and parse the LiteLLM streaming (SSE-like) response and report parts.
	 * @param responseBody The readable stream body.
	 * @param progress Progress reporter for streamed parts.
	 * @param token Cancellation token.
	 */
	private async processStreamingResponse(
		responseBody: ReadableStream<Uint8Array>,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		const reader = responseBody.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (!token.isCancellationRequested) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (!line.startsWith("data: ")) {
						continue;
					}
					const data = line.slice(6);
					if (data === "[DONE]") {
						// Do not throw on [DONE]; any incomplete/empty buffers are ignored.
						await this.flushToolCallBuffers(progress, /*throwOnInvalid*/ false);
						// Flush any in-progress text-embedded tool call (silent if incomplete)
						await this.flushActiveTextToolCall(progress);
						continue;
					}

					try {
						const parsed = JSON.parse(data);
						await this.processDelta(parsed, progress);
					} catch (e) {
						this.log("Skipping malformed SSE line", { error: String(e), data: data.slice(0, 200) });
					}
				}
			}
		} finally {
			reader.releaseLock();
			this._req = LiteLLMChatModelProvider._freshRequestState();
		}
	}

	/**
	 * Handle a single streamed delta chunk, emitting text and tool call parts.
	 * @param delta Parsed SSE chunk from LiteLLM.
	 * @param progress Progress reporter for parts.
	 */
	private async processDelta(
		delta: StreamingResponseDelta,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>
	): Promise<boolean> {
		let emitted = false;

		// Log token usage — must run before the choices[0] early return because
		// OpenAI-compatible streams send usage in a final chunk with choices: []
		const usage = delta.usage;
		if (usage) {
			this.log("Token usage", usage);
		}

		const choice = delta.choices?.[0];
		if (!choice) {
			return false;
		}

		const deltaObj = choice.delta;

		// report thinking progress if backend provides it and host supports it
		try {
			const maybeThinking =
				choice.thinking ?? deltaObj?.thinking ?? deltaObj?.reasoning_content ?? deltaObj?.reasoning;
			if (maybeThinking !== undefined) {
				const vsAny = vscode as unknown as Record<string, unknown>;
				const ThinkingCtor = vsAny["LanguageModelThinkingPart"] as
					| (new (text: string, id?: string, metadata?: unknown) => unknown)
					| undefined;
				if (ThinkingCtor) {
					let text = "";
					let id: string | undefined;
					let metadata: unknown;
					if (maybeThinking && typeof maybeThinking === "object") {
						const mt = maybeThinking as ThinkingContent;
						text = typeof mt.text === "string" ? mt.text : "";
						id = typeof mt.id === "string" ? mt.id : undefined;
						metadata = mt.metadata;
					} else if (typeof maybeThinking === "string") {
						text = maybeThinking;
					}
					if (text) {
						progress.report(
							new (ThinkingCtor as new (text: string, id?: string, metadata?: unknown) => unknown)(
								text,
								id,
								metadata
							) as unknown as vscode.LanguageModelResponsePart
						);
						emitted = true;
					}
				}
			}
		} catch {
			// ignore errors here temporarily
		}

		// Handle content — may be a string or an array of content blocks
		if (deltaObj?.content !== undefined && deltaObj.content !== null) {
			if (Array.isArray(deltaObj.content)) {
				// Structured content array (some providers return this)
				for (const block of deltaObj.content as Array<ContentBlock>) {
					if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
						const res = this.processTextContent(block.text, progress);
						if (res.emittedText) {
							this._req.hasEmittedAssistantText = true;
						}
						if (res.emittedAny) {
							emitted = true;
						}
					}
					// Silently ignore non-text blocks in streaming (thinking blocks handled above)
				}
			} else {
				const content = String(deltaObj.content);
				const res = this.processTextContent(content, progress);
				if (res.emittedText) {
					this._req.hasEmittedAssistantText = true;
				}
				if (res.emittedAny) {
					emitted = true;
				}
			}
		}

		if (deltaObj?.tool_calls) {
			const toolCalls = deltaObj.tool_calls as Array<StreamingToolCall>;

			// SSEProcessor-like: if first tool call appears after text, emit a whitespace
			// to ensure any UI buffers/linkifiers are flushed without adding visible noise.
			if (!this._req.emittedBeginToolCallsHint && this._req.hasEmittedAssistantText && toolCalls.length > 0) {
				progress.report(new vscode.LanguageModelTextPart(" "));
				this._req.emittedBeginToolCallsHint = true;
			}

			for (const tc of toolCalls) {
				const idx = tc.index ?? 0;
				// Ignore any further deltas for an index we've already completed
				if (this._req.completedToolCallIndices.has(idx)) {
					continue;
				}
				const buf = this._req.toolCallBuffers.get(idx) ?? { args: "" };
				if (tc.id && typeof tc.id === "string") {
					buf.id = tc.id;
				}
				const func = tc.function;
				if (func?.name && typeof func.name === "string") {
					buf.name = func.name;
				}
				if (typeof func?.arguments === "string") {
					buf.args += func.arguments;
				}
				this._req.toolCallBuffers.set(idx, buf);

				// Emit immediately once arguments become valid JSON to avoid perceived hanging
				await this.tryEmitBufferedToolCall(idx, progress);
			}
		}

		const finish = choice.finish_reason ?? undefined;
		if (finish === "tool_calls" || finish === "stop") {
			// On both 'tool_calls' and 'stop', emit any buffered calls and throw on invalid JSON
			await this.flushToolCallBuffers(progress, /*throwOnInvalid*/ true);
		}

		return emitted;
	}

	/**
	 * Process streamed text content for inline tool-call control tokens and emit text/tool calls.
	 * Returns which parts were emitted for logging/flow control.
	 */
	private processTextContent(
		input: string,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>
	): { emittedText: boolean; emittedAny: boolean } {
		const BEGIN = "<|tool_call_begin|>";
		const ARG_BEGIN = "<|tool_call_argument_begin|>";
		const END = "<|tool_call_end|>";

		let data = this._req.textToolParserBuffer + input;
		let emittedText = false;
		let emittedAny = false;
		let visibleOut = "";

		while (data.length > 0) {
			if (!this._req.textToolActive) {
				const b = data.indexOf(BEGIN);
				if (b === -1) {
					// No tool-call start: emit visible portion, but keep any partial BEGIN prefix as buffer
					const longestPartialPrefix = ((): number => {
						for (let k = Math.min(BEGIN.length - 1, data.length - 1); k > 0; k--) {
							if (data.endsWith(BEGIN.slice(0, k))) {
								return k;
							}
						}
						return 0;
					})();
					if (longestPartialPrefix > 0) {
						const visible = data.slice(0, data.length - longestPartialPrefix);
						if (visible) {
							visibleOut += this.stripControlTokens(visible);
						}
						this._req.textToolParserBuffer = data.slice(data.length - longestPartialPrefix);
						data = "";
						break;
					} else {
						// All visible, clean other control tokens
						visibleOut += this.stripControlTokens(data);
						data = "";
						break;
					}
				}
				// Emit text before the token
				const pre = data.slice(0, b);
				if (pre) {
					visibleOut += this.stripControlTokens(pre);
				}
				// Advance past BEGIN
				data = data.slice(b + BEGIN.length);

				// Find the delimiter that ends the name/index segment
				const a = data.indexOf(ARG_BEGIN);
				const e = data.indexOf(END);
				let delimIdx: number;
				let delimKind: "arg" | "end";
				if (a !== -1 && (e === -1 || a < e)) {
					delimIdx = a;
					delimKind = "arg";
				} else if (e !== -1) {
					delimIdx = e;
					delimKind = "end";
				} else {
					// Incomplete header; keep for next chunk (re-add BEGIN so we don't lose it)
					this._req.textToolParserBuffer = BEGIN + data;
					data = "";
					break;
				}

				const header = data.slice(0, delimIdx).trim();
				const m = header.match(/^([A-Za-z0-9_\-.]+)(?::(\d+))?/);
				const name = m?.[1] ?? undefined;
				const index = m?.[2] ? Number(m?.[2]) : undefined;
				this._req.textToolActive = { name, index, argBuffer: "", emitted: false };
				// Advance past delimiter token
				if (delimKind === "arg") {
					data = data.slice(delimIdx + ARG_BEGIN.length);
				} else /* end */ {
					// No args, finalize immediately
					data = data.slice(delimIdx + END.length);
					const did = this.emitTextToolCallIfValid(progress, this._req.textToolActive, "{}");
					if (did) {
						this._req.textToolActive.emitted = true;
						emittedAny = true;
					}
					this._req.textToolActive = undefined;
				}
				continue;
			}

			// We are inside arguments, collect until END and emit as soon as JSON becomes valid
			const e2 = data.indexOf(END);
			if (e2 === -1) {
				// No end marker yet, accumulate and check for early valid JSON
				this._req.textToolActive.argBuffer += data;
				// Early emit when JSON becomes valid and we haven't emitted yet
				if (!this._req.textToolActive.emitted) {
					const did = this.emitTextToolCallIfValid(
						progress,
						this._req.textToolActive,
						this._req.textToolActive.argBuffer
					);
					if (did) {
						this._req.textToolActive.emitted = true;
						emittedAny = true;
					}
				}
				data = "";
				break;
			} else {
				this._req.textToolActive.argBuffer += data.slice(0, e2);
				// Consume END
				data = data.slice(e2 + END.length);
				// Final attempt to emit if not already
				if (!this._req.textToolActive.emitted) {
					const did = this.emitTextToolCallIfValid(
						progress,
						this._req.textToolActive,
						this._req.textToolActive.argBuffer
					);
					if (did) {
						emittedAny = true;
					}
				}
				this._req.textToolActive = undefined;
				continue;
			}
		}

		// Emit any visible text
		const textToEmit = visibleOut;
		if (textToEmit && textToEmit.length > 0) {
			progress.report(new vscode.LanguageModelTextPart(textToEmit));
			emittedText = true;
			emittedAny = true;
		}

		// Store leftover for next chunk
		this._req.textToolParserBuffer = data;

		return { emittedText, emittedAny };
	}

	private emitTextToolCallIfValid(
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		call: { name?: string; index?: number; argBuffer: string; emitted?: boolean },
		argText: string
	): boolean {
		const name = call.name ?? "unknown_tool";
		const parsed = tryParseJSONObject(argText);
		if (!parsed.ok) {
			return false;
		}
		const canonical = JSON.stringify(parsed.value);
		const key = `${name}:${canonical}`;
		// identity-based dedupe when index is present
		if (typeof call.index === "number") {
			const idKey = `${name}:${call.index}`;
			if (this._req.emittedTextToolCallIds.has(idKey)) {
				return false;
			}
			// Mark identity as emitted
			this._req.emittedTextToolCallIds.add(idKey);
		} else if (this._req.emittedTextToolCallKeys.has(key)) {
			return false;
		}
		this._req.emittedTextToolCallKeys.add(key);
		const id = `tct_${++this._toolCallIdCounter}`;
		progress.report(new vscode.LanguageModelToolCallPart(id, name, parsed.value));
		return true;
	}

	private async flushActiveTextToolCall(progress: vscode.Progress<vscode.LanguageModelResponsePart>): Promise<void> {
		if (!this._req.textToolActive) {
			return;
		}
		const argText = this._req.textToolActive.argBuffer;
		const parsed = tryParseJSONObject(argText);
		if (!parsed.ok) {
			return;
		}
		// Emit (dedupe ensures we don't double-emit)
		this.emitTextToolCallIfValid(progress, this._req.textToolActive, argText);
		this._req.textToolActive = undefined;
	}

	/**
	 * Try to emit a buffered tool call when a valid name and JSON arguments are available.
	 * @param index The tool call index from the stream.
	 * @param progress Progress reporter for parts.
	 */
	private async tryEmitBufferedToolCall(
		index: number,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>
	): Promise<void> {
		const buf = this._req.toolCallBuffers.get(index);
		if (!buf) {
			return;
		}
		if (!buf.name) {
			return;
		}
		const canParse = tryParseJSONObject(buf.args);
		if (!canParse.ok) {
			return;
		}
		const id = buf.id ?? `call_${++this._toolCallIdCounter}`;
		const parameters = canParse.value;
		try {
			const canonical = JSON.stringify(parameters);
			this._req.emittedTextToolCallKeys.add(`${buf.name}:${canonical}`);
		} catch {
			/* ignore */
		}
		progress.report(new vscode.LanguageModelToolCallPart(id, buf.name, parameters));
		this._req.toolCallBuffers.delete(index);
		this._req.completedToolCallIndices.add(index);
	}

	/**
	 * Flush all buffered tool calls, optionally throwing if arguments are not valid JSON.
	 * @param progress Progress reporter for parts.
	 * @param throwOnInvalid If true, throw when a tool call has invalid JSON args.
	 */
	private async flushToolCallBuffers(
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		throwOnInvalid: boolean
	): Promise<void> {
		if (this._req.toolCallBuffers.size === 0) {
			return;
		}
		for (const [idx, buf] of Array.from(this._req.toolCallBuffers.entries())) {
			const parsed = tryParseJSONObject(buf.args);
			if (!parsed.ok) {
				if (throwOnInvalid) {
					console.error("[LiteLLM Model Provider] Invalid JSON for tool call", {
						idx,
						snippet: (buf.args || "").slice(0, 200),
					});
					throw new Error("Invalid JSON for tool call");
				}
				// When not throwing (e.g. on [DONE]), drop silently to reduce noise
				continue;
			}
			const id = buf.id ?? `call_${++this._toolCallIdCounter}`;
			const name = buf.name ?? "unknown_tool";
			try {
				const canonical = JSON.stringify(parsed.value);
				this._req.emittedTextToolCallKeys.add(`${name}:${canonical}`);
			} catch {
				/* ignore */
			}
			progress.report(new vscode.LanguageModelToolCallPart(id, name, parsed.value));
			this._req.toolCallBuffers.delete(idx);
			this._req.completedToolCallIndices.add(idx);
		}
	}

	/** Strip provider control tokens like <|tool_calls_section_begin|> and <|tool_call_begin|> from streamed text. */
	private stripControlTokens(text: string): string {
		try {
			// Remove section markers and explicit tool call begin/argument/end markers that some backends stream as text
			return text
				.replace(/<\|[a-zA-Z0-9_-]+_section_(?:begin|end)\|>/g, "")
				.replace(/<\|tool_call_(?:argument_)?(?:begin|end)\|>/g, "");
		} catch {
			return text;
		}
	}
}
