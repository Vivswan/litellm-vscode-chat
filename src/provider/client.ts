import * as vscode from "vscode";
import type {
	LanguageModelChatRequestMessage,
	ProvideLanguageModelChatResponseOptions,
	LanguageModelChatInformation,
} from "vscode";
import { convertMessages } from "../shared/messages";
import { convertTools } from "../shared/tools";
import { validateRequest } from "../shared/validation";
import { estimateMessagesTokens, estimateToolTokens, getModelParameters, buildRequestBody } from "./request";
import type { ModelRoute } from "./request";
import { StreamProcessor } from "./streaming";
import { resolveServer } from "./config";
import { resolveAuthHeaders, authFailureMessage } from "./auth";
import { getCustomHeaders } from "./httpHeaders";
import type { ServerWithKey } from "../extension/serverRegistry";

export interface ChatRequestContext {
	model: LanguageModelChatInformation;
	messages: readonly LanguageModelChatRequestMessage[];
	options: ProvideLanguageModelChatResponseOptions;
	progress: vscode.Progress<vscode.LanguageModelResponsePart>;
	token: vscode.CancellationToken;
}

export async function sendChatRequest(
	ctx: ChatRequestContext,
	modelRoutes: Map<string, ModelRoute>,
	promptCachingSupport: Map<string, boolean>,
	getServers: (() => Promise<ServerWithKey[]>) | undefined,
	secrets: vscode.SecretStorage,
	userAgent: string,
	toolCallIdCounter: number,
	log: (message: string, data?: unknown) => void,
	logError: (message: string, error: unknown) => void
): Promise<number> {
	const { model, messages, options, progress, token } = ctx;

	const route = modelRoutes.get(model.id);
	let baseUrl: string;
	let authHeaders: Record<string, string>;
	let authMethod: "oauth" | "apikey" = "apikey";
	let rawModelId: string;

	if (route) {
		const server = await resolveServer(route.serverId, getServers, secrets);
		if (server) {
			baseUrl = server.baseUrl;
			authHeaders = await resolveAuthHeaders(server, log);
			authMethod = server.auth?.type === "oauth" ? "oauth" : "apikey";
		} else {
			throw new Error(`Server "${route.serverLabel}" is no longer configured`);
		}
		rawModelId = route.rawModelId;
	} else {
		const config = await resolveServer("_legacy", undefined, secrets);
		if (!config) {
			throw new Error("LiteLLM configuration not found");
		}
		baseUrl = config.baseUrl;
		authHeaders = await resolveAuthHeaders(config, log);
		rawModelId = model.id;
	}

	const settings = vscode.workspace.getConfiguration("litellm-vscode-chat");
	const promptCachingEnabled = settings.get<boolean>("promptCaching.enabled", true);
	const customHeaders = getCustomHeaders(log);
	const rawRequestTimeout = settings.get<number>("requestTimeout", 300000);
	// Validate and clamp requestTimeout to minimum 1000ms
	const requestTimeout = Math.max(1000, Number.isFinite(rawRequestTimeout) ? rawRequestTimeout : 300000);
	if (rawRequestTimeout !== requestTimeout) {
		log("Invalid requestTimeout configuration, using clamped value", {
			configured: rawRequestTimeout,
			clamped: requestTimeout,
		});
	}
	const supportsPromptCaching = promptCachingSupport.get(model.id) === true;
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
		logError("Message exceeds token limit", { total: inputTokenCount + toolTokenCount, tokenLimit });
		throw new Error("Message exceeds token limit.");
	}

	const modelParams = getModelParameters(model.id, modelRoutes);

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

	// Auth headers take precedence over custom headers; Content-Type and User-Agent are always forced.
	const headers: Record<string, string> = {
		...customHeaders,
		...authHeaders,
		"Content-Type": "application/json",
		"User-Agent": userAgent,
	};

	log("Sending chat request", {
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
		logError("API error response", errorText);

		if (response.status === 401) {
			throw new Error(authFailureMessage(authMethod));
		}

		throw new Error(`LiteLLM API error: ${response.status} ${response.statusText}${errorText ? `\n${errorText}` : ""}`);
	}

	if (!response.body) {
		throw new Error("No response body from LiteLLM API");
	}

	const streamProcessor = new StreamProcessor(toolCallIdCounter, log);
	await streamProcessor.processStreamingResponse(response.body, progress, token);
	return streamProcessor.toolCallIdCounter;
}
