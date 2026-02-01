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

const DEFAULT_MAX_OUTPUT_TOKENS = 16000;
const DEFAULT_CONTEXT_LENGTH = 128000;

/**
 * VS Code Chat provider backed by LiteLLM.
 */
export class LiteLLMChatModelProvider implements LanguageModelChatProvider {
	private _chatEndpoints: { model: string; modelMaxPromptTokens: number }[] = [];
	/** Buffer for assembling streamed tool calls by index. */
	private _toolCallBuffers: Map<number, { id?: string; name?: string; args: string }> = new Map<
		number,
		{ id?: string; name?: string; args: string }
	>();

	/** Indices for which a tool call has been fully emitted. */
	private _completedToolCallIndices = new Set<number>();

	/** Track if we emitted any assistant text before seeing tool calls (SSE-like begin-tool-calls hint). */
	private _hasEmittedAssistantText = false;

	/** Track if we emitted the begin-tool-calls whitespace flush. */
	private _emittedBeginToolCallsHint = false;

	// Lightweight tokenizer state for tool calls embedded in text
	private _textToolParserBuffer = "";
	private _textToolActive:
		| undefined
		| {
				name?: string;
				index?: number;
				argBuffer: string;
				emitted?: boolean;
		  };
	private _emittedTextToolCallKeys = new Set<string>();
	private _emittedTextToolCallIds = new Set<string>();
	/** Cache prompt-caching support per model id as reported by /v1/model/info. */
	private _promptCachingSupport = new Map<string, boolean>();

	/** Callback to update extension status */
	private _statusCallback?: (modelCount: number, error?: string) => void;

	/** Track if we've shown the "no config" notification this session */
	private _hasShownNoConfigNotification = false;

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
		// Also log to console for development
		if (data !== undefined) {
			console.log(`[LiteLLM Model Provider] ${message}`, data);
		} else {
			console.log(`[LiteLLM Model Provider] ${message}`);
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
		console.error(`[LiteLLM Model Provider] ${message}`, error);
	}

	/** Roughly estimate tokens for VS Code chat messages (text only) */
	private estimateMessagesTokens(msgs: readonly vscode.LanguageModelChatRequestMessage[]): number {
		let total = 0;
		for (const m of msgs) {
			for (const part of m.content) {
				if (part instanceof vscode.LanguageModelTextPart) {
					total += Math.ceil(part.value.length / 4);
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
			return Math.ceil(json.length / 4);
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

		// Resolve max output tokens
		const maxOutputTokens =
			provider?.max_output_tokens ??
			provider?.max_tokens ??
			config.get<number>("defaultMaxOutputTokens", DEFAULT_MAX_OUTPUT_TOKENS);

		// Resolve context length
		const contextLength =
			provider?.context_length ?? config.get<number>("defaultContextLength", DEFAULT_CONTEXT_LENGTH);

		// Resolve max input tokens
		let maxInputTokens = provider?.max_input_tokens;
		if (maxInputTokens === undefined) {
			const configMaxInput = config.get<number | null>("defaultMaxInputTokens", null);
			maxInputTokens = configMaxInput ?? Math.max(1, contextLength - maxOutputTokens);
		}

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

		const provider: LiteLLMProvider = {
			provider: providerName,
			status: "ok",
			supports_tools: supportsTools,
			context_length: item.model_info?.max_input_tokens ?? item.model_info?.max_tokens,
			max_tokens: item.model_info?.max_tokens ?? item.model_info?.max_output_tokens,
			max_input_tokens: item.model_info?.max_input_tokens,
			max_output_tokens: item.model_info?.max_output_tokens ?? item.model_info?.max_tokens,
			source: "model_info",
			supports_prompt_caching: item.model_info?.supports_prompt_caching ?? null,
		};

		const architecture = item.model_info?.supports_vision ? { input_modalities: ["image"] } : undefined;

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
		const modelsList = (async () => {
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
						return data as LiteLLMModelItem[];
					}

					const models = data
						.map((item) => this.mapModelInfoToLiteLLMModel(item as LiteLLMModelInfoItem))
						.filter((m): m is LiteLLMModelItem => Boolean(m));
					if (data.length > 0 && models.length === 0) {
						this.log("model/info returned data but no mappable models; falling back", { dataLength: data.length });
					} else {
						return models;
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
				return parsed.data ?? [];
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
		})();

		try {
			const models = await modelsList;
			this.log("Successfully fetched models:", models.length);
			return { models };
		} catch (err) {
			this.logError("Failed to fetch LiteLLM models", err);
			throw err;
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
		this._toolCallBuffers.clear();
		this._completedToolCallIndices.clear();
		this._hasEmittedAssistantText = false;
		this._emittedBeginToolCallsHint = false;
		this._textToolParserBuffer = "";
		this._textToolActive = undefined;
		this._emittedTextToolCallKeys.clear();
		this._emittedTextToolCallIds.clear();

		let requestBody: Record<string, unknown> | undefined;
		const trackingProgress: Progress<LanguageModelResponsePart> = {
			report: (part) => {
				try {
					progress.report(part);
				} catch (e) {
					console.error("[LiteLLM Model Provider] Progress.report failed", {
						modelId: model.id,
						error: e instanceof Error ? { name: e.name, message: e.message } : String(e),
					});
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

			if (options.tools && options.tools.length > 128) {
				throw new Error("Cannot have more than 128 tools per request.");
			}

			const inputTokenCount = this.estimateMessagesTokens(messages);
			const toolTokenCount = this.estimateToolTokens(toolConfig.tools);
			const tokenLimit = Math.max(1, model.maxInputTokens);
			if (inputTokenCount + toolTokenCount > tokenLimit) {
				console.error("[LiteLLM Model Provider] Message exceeds token limit", {
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
				maxTokens = Math.min(4096, model.maxOutputTokens);
			}

			// Build base request body
			requestBody = {
				model: model.id,
				messages: openaiMessages,
				stream: true,
				max_tokens: maxTokens,
				temperature: 0.7, // Base default
			};

			// 3. Apply other model-specific parameters from configuration (max_tokens already handled)
			for (const [key, value] of Object.entries(modelParams)) {
				if (key !== "max_tokens") {
					(requestBody as Record<string, unknown>)[key] = value;
				}
			}

			// 4. Apply runtime options.modelOptions (highest priority for other parameters)
			if (options.modelOptions) {
				const mo = options.modelOptions as Record<string, unknown>;

				// Apply temperature from options if specified
				if (typeof mo.temperature === "number") {
					(requestBody as Record<string, unknown>).temperature = mo.temperature;
				}

				// Apply other allow-listed parameters
				if (typeof mo.stop === "string" || Array.isArray(mo.stop)) {
					(requestBody as Record<string, unknown>).stop = mo.stop;
				}
				if (typeof mo.frequency_penalty === "number") {
					(requestBody as Record<string, unknown>).frequency_penalty = mo.frequency_penalty;
				}
				if (typeof mo.presence_penalty === "number") {
					(requestBody as Record<string, unknown>).presence_penalty = mo.presence_penalty;
				}
				if (typeof mo.top_p === "number") {
					(requestBody as Record<string, unknown>).top_p = mo.top_p;
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
			console.log("[LiteLLM Model Provider] Sending chat request", {
				url: `${config.baseUrl}/v1/chat/completions`,
				modelId: model.id,
				messageCount: messages.length,
				requestBody: JSON.stringify(requestBody, null, 2),
			});
			const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
				method: "POST",
				headers,
				body: JSON.stringify(requestBody),
			});

			if (!response.ok) {
				const errorText = await response.text();
				console.error("[LiteLLM Model Provider] API error response", errorText);

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
			console.error("[LiteLLM Model Provider] Chat request failed", {
				modelId: model.id,
				messageCount: messages.length,
				error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
			});
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
		model: LanguageModelChatInformation,
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
		return { baseUrl, apiKey: apiKey ?? "" };
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
					} catch {
						// Silently ignore malformed SSE lines temporarily
					}
				}
			}
		} finally {
			reader.releaseLock();
			// Clean up any leftover tool call state
			this._toolCallBuffers.clear();
			this._completedToolCallIndices.clear();
			this._hasEmittedAssistantText = false;
			this._emittedBeginToolCallsHint = false;
			this._textToolParserBuffer = "";
			this._textToolActive = undefined;
			this._emittedTextToolCallKeys.clear();
		}
	}

	/**
	 * Handle a single streamed delta chunk, emitting text and tool call parts.
	 * @param delta Parsed SSE chunk from LiteLLM.
	 * @param progress Progress reporter for parts.
	 */
	private async processDelta(
		delta: Record<string, unknown>,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>
	): Promise<boolean> {
		let emitted = false;
		const choice = (delta.choices as Record<string, unknown>[] | undefined)?.[0];
		if (!choice) {
			return false;
		}

		const deltaObj = choice.delta as Record<string, unknown> | undefined;

		// report thinking progress if backend provides it and host supports it
		try {
			const maybeThinking =
				(choice as Record<string, unknown> | undefined)?.thinking ??
				(deltaObj as Record<string, unknown> | undefined)?.thinking;
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
						const mt = maybeThinking as Record<string, unknown>;
						text = typeof mt["text"] === "string" ? (mt["text"] as string) : "";
						id = typeof mt["id"] === "string" ? (mt["id"] as string) : undefined;
						metadata = mt["metadata"];
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
		if (deltaObj?.content) {
			const content = String(deltaObj.content);
			const res = this.processTextContent(content, progress);
			if (res.emittedText) {
				this._hasEmittedAssistantText = true;
			}
			if (res.emittedAny) {
				emitted = true;
			}
		}

		if (deltaObj?.tool_calls) {
			const toolCalls = deltaObj.tool_calls as Array<Record<string, unknown>>;

			// SSEProcessor-like: if first tool call appears after text, emit a whitespace
			// to ensure any UI buffers/linkifiers are flushed without adding visible noise.
			if (!this._emittedBeginToolCallsHint && this._hasEmittedAssistantText && toolCalls.length > 0) {
				progress.report(new vscode.LanguageModelTextPart(" "));
				this._emittedBeginToolCallsHint = true;
			}

			for (const tc of toolCalls) {
				const idx = (tc.index as number) ?? 0;
				// Ignore any further deltas for an index we've already completed
				if (this._completedToolCallIndices.has(idx)) {
					continue;
				}
				const buf = this._toolCallBuffers.get(idx) ?? { args: "" };
				if (tc.id && typeof tc.id === "string") {
					buf.id = tc.id as string;
				}
				const func = tc.function as Record<string, unknown> | undefined;
				if (func?.name && typeof func.name === "string") {
					buf.name = func.name as string;
				}
				if (typeof func?.arguments === "string") {
					buf.args += func.arguments as string;
				}
				this._toolCallBuffers.set(idx, buf);

				// Emit immediately once arguments become valid JSON to avoid perceived hanging
				await this.tryEmitBufferedToolCall(idx, progress);
			}
		}

		const finish = (choice.finish_reason as string | undefined) ?? undefined;
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

		let data = this._textToolParserBuffer + input;
		let emittedText = false;
		let emittedAny = false;
		let visibleOut = "";

		while (data.length > 0) {
			if (!this._textToolActive) {
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
						this._textToolParserBuffer = data.slice(data.length - longestPartialPrefix);
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
				let delimIdx = -1;
				let delimKind: "arg" | "end" | undefined = undefined;
				if (a !== -1 && (e === -1 || a < e)) {
					delimIdx = a;
					delimKind = "arg";
				} else if (e !== -1) {
					delimIdx = e;
					delimKind = "end";
				} else {
					// Incomplete header; keep for next chunk (re-add BEGIN so we don't lose it)
					this._textToolParserBuffer = BEGIN + data;
					data = "";
					break;
				}

				const header = data.slice(0, delimIdx).trim();
				const m = header.match(/^([A-Za-z0-9_\-.]+)(?::(\d+))?/);
				const name = m?.[1] ?? undefined;
				const index = m?.[2] ? Number(m?.[2]) : undefined;
				this._textToolActive = { name, index, argBuffer: "", emitted: false };
				// Advance past delimiter token
				if (delimKind === "arg") {
					data = data.slice(delimIdx + ARG_BEGIN.length);
				} else /* end */ {
					// No args, finalize immediately
					data = data.slice(delimIdx + END.length);
					const did = this.emitTextToolCallIfValid(progress, this._textToolActive, "{}");
					if (did) {
						this._textToolActive.emitted = true;
						emittedAny = true;
					}
					this._textToolActive = undefined;
				}
				continue;
			}

			// We are inside arguments, collect until END and emit as soon as JSON becomes valid
			const e2 = data.indexOf(END);
			if (e2 === -1) {
				// No end marker yet, accumulate and check for early valid JSON
				this._textToolActive.argBuffer += data;
				// Early emit when JSON becomes valid and we haven't emitted yet
				if (!this._textToolActive.emitted) {
					const did = this.emitTextToolCallIfValid(progress, this._textToolActive, this._textToolActive.argBuffer);
					if (did) {
						this._textToolActive.emitted = true;
						emittedAny = true;
					}
				}
				data = "";
				break;
			} else {
				this._textToolActive.argBuffer += data.slice(0, e2);
				// Consume END
				data = data.slice(e2 + END.length);
				// Final attempt to emit if not already
				if (!this._textToolActive.emitted) {
					const did = this.emitTextToolCallIfValid(progress, this._textToolActive, this._textToolActive.argBuffer);
					if (did) {
						emittedAny = true;
					}
				}
				this._textToolActive = undefined;
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
		this._textToolParserBuffer = data;

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
			if (this._emittedTextToolCallIds.has(idKey)) {
				return false;
			}
			// Mark identity as emitted
			this._emittedTextToolCallIds.add(idKey);
		} else if (this._emittedTextToolCallKeys.has(key)) {
			return false;
		}
		this._emittedTextToolCallKeys.add(key);
		const id = `tct_${Math.random().toString(36).slice(2, 10)}`;
		progress.report(new vscode.LanguageModelToolCallPart(id, name, parsed.value));
		return true;
	}

	private async flushActiveTextToolCall(progress: vscode.Progress<vscode.LanguageModelResponsePart>): Promise<void> {
		if (!this._textToolActive) {
			return;
		}
		const argText = this._textToolActive.argBuffer;
		const parsed = tryParseJSONObject(argText);
		if (!parsed.ok) {
			return;
		}
		// Emit (dedupe ensures we don't double-emit)
		this.emitTextToolCallIfValid(progress, this._textToolActive, argText);
		this._textToolActive = undefined;
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
		const buf = this._toolCallBuffers.get(index);
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
		const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
		const parameters = canParse.value;
		try {
			const canonical = JSON.stringify(parameters);
			this._emittedTextToolCallKeys.add(`${buf.name}:${canonical}`);
		} catch {
			/* ignore */
		}
		progress.report(new vscode.LanguageModelToolCallPart(id, buf.name, parameters));
		this._toolCallBuffers.delete(index);
		this._completedToolCallIndices.add(index);
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
		if (this._toolCallBuffers.size === 0) {
			return;
		}
		for (const [idx, buf] of Array.from(this._toolCallBuffers.entries())) {
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
			const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
			const name = buf.name ?? "unknown_tool";
			try {
				const canonical = JSON.stringify(parsed.value);
				this._emittedTextToolCallKeys.add(`${name}:${canonical}`);
			} catch {
				/* ignore */
			}
			progress.report(new vscode.LanguageModelToolCallPart(id, name, parsed.value));
			this._toolCallBuffers.delete(idx);
			this._completedToolCallIndices.add(idx);
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
