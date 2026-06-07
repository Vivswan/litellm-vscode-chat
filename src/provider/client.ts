import * as vscode from "vscode";
import type {
	LanguageModelChatRequestMessage,
	ProvideLanguageModelChatResponseOptions,
	LanguageModelChatInformation,
} from "vscode";
import { convertMessages } from "../shared/messages";
import { convertTools, applyToolsCacheControl } from "../shared/tools";
import { validateRequest } from "../shared/validation";
import {
	estimateMessagesTokens,
	estimateToolTokens,
	estimateSystemPromptTokens,
	estimateFirstUserTokens,
	getModelParameters,
	buildRequestBody,
} from "./request";
import type { ModelRoute } from "./request";
import {
	resolveCachePlan,
	normalizeMode,
	normalizeRollingPlacement,
	normalizeAutoBreakpoint,
	normalizeMinCacheTokens,
} from "./cacheStrategy";
import { StreamProcessor } from "./streaming";
import { resolveServer } from "./config";
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
	let apiKey: string;
	let rawModelId: string;

	if (route) {
		const server = await resolveServer(route.serverId, getServers, secrets);
		if (server) {
			baseUrl = server.baseUrl;
			apiKey = server.apiKey;
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
		apiKey = config.apiKey;
		rawModelId = model.id;
	}

	const settings = vscode.workspace.getConfiguration("litellm-vscode-chat");
	// Back-compat: an earlier release used a boolean `promptCaching.enabled`
	// switch instead of the current `promptCaching.mode` enum. If a user still
	// has `enabled: false` in their settings and has NOT explicitly chosen a
	// mode, honour the legacy opt-out by forcing mode "off" — otherwise the new
	// "auto" default would silently re-enable caching for them.
	const modeInspect = settings.inspect<string>("promptCaching.mode");
	const modeExplicitlySet =
		modeInspect?.globalValue !== undefined ||
		modeInspect?.workspaceValue !== undefined ||
		modeInspect?.workspaceFolderValue !== undefined;
	const legacyEnabled = settings.get<boolean | undefined>("promptCaching.enabled", undefined);
	let cacheMode = normalizeMode(settings.get<string>("promptCaching.mode", "auto"));
	if (!modeExplicitlySet && legacyEnabled === false) {
		cacheMode = "off";
		log("Honouring legacy promptCaching.enabled=false; forcing prompt caching mode 'off'");
	}
	const rollingPlacement = normalizeRollingPlacement(
		settings.get<string>("promptCaching.rollingLastMessage", "stableTurnsOnly")
	);
	const tokenSizeAutoBreakpoint = normalizeAutoBreakpoint(
		settings.get<number>("promptCaching.tokenSizeAutoBreakpoint", 8000)
	);
	const minCacheTokens = normalizeMinCacheTokens(settings.get<number>("promptCaching.minCacheTokens", 4096));
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

	// Measure each anchor's block size up front so the resolver can apply the
	// auto-mode size gating and the universal minCacheTokens floor. Tools are
	// sized from a no-cache conversion to avoid a chicken-and-egg dependency.
	const baseToolConfig = convertTools(options);
	const anchorSizes = {
		tools: estimateToolTokens(baseToolConfig.tools),
		system: estimateSystemPromptTokens(messages),
		firstUser: estimateFirstUserTokens(messages),
	};

	const cachePlan = resolveCachePlan({
		mode: cacheMode,
		supportsPromptCaching,
		rollingPlacement,
		tokenSizeAutoBreakpoint,
		minCacheTokens,
		sizes: anchorSizes,
	});

	const placedRollingOn: { role: string } = { role: "" };
	const openaiMessages = convertMessages(messages, {
		cache: {
			system: cachePlan.system.enabled ? { ttl: cachePlan.system.ttl } : undefined,
			firstUser: cachePlan.firstUser.enabled ? { ttl: cachePlan.firstUser.ttl } : undefined,
			rolling: cachePlan.rolling.enabled
				? { ttl: cachePlan.rolling.ttl, placement: cachePlan.rolling.placement }
				: undefined,
		},
		placedRollingOn,
	});
	validateRequest(messages);
	// Reuse the already-converted tools array (sized above) and tag it in place
	// when caching is enabled, instead of re-running the full convertTools
	// sanitization pass a second time.
	if (cachePlan.tools.enabled) {
		applyToolsCacheControl(baseToolConfig.tools, cachePlan.tools.ttl);
	}
	const toolConfig = baseToolConfig;

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

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"User-Agent": userAgent,
	};
	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
		headers["X-API-Key"] = apiKey;
	}

	log("Sending chat request", {
		url: `${baseUrl}/v1/chat/completions`,
		modelId: rawModelId,
		messageCount: messages.length,
		caching:
			cachePlan.mode === "off" || !supportsPromptCaching
				? { mode: cachePlan.mode, active: false, supported: supportsPromptCaching }
				: {
						mode: cachePlan.mode,
						active: true,
						tools: cachePlan.tools.enabled ? cachePlan.tools.ttl : "off",
						system: cachePlan.system.enabled ? cachePlan.system.ttl : "off",
						firstUser: cachePlan.firstUser.enabled ? cachePlan.firstUser.ttl : "off",
						rollingLast: cachePlan.rolling.enabled ? `${cachePlan.rolling.ttl}/${cachePlan.rolling.placement}` : "off",
						rollingPlacedOn: placedRollingOn.role || "skipped",
						sizes: anchorSizes,
					},
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
			throw new Error(
				`Authentication failed: Your LiteLLM server requires an API key. Please run the "Manage LiteLLM Provider" command to configure your API key.`
			);
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
