import { getModelParametersConfig } from "../shared/settings";
import type { OpenAIChatMessage, OpenAIFunctionToolDef } from "../types";
import type { ModelRoute } from "./modelCatalog";

/** Fallback max_tokens when neither runtime options nor configured model parameters set one. */
export const DEFAULT_MAX_TOKENS_CAP = 4096;
export const MAX_TOOLS_PER_REQUEST = 128;

export function findLongestPrefixMatch<T>(id: string, entries: Record<string, T>): T | undefined {
	let best: { key: string; value: T } | undefined;
	for (const [key, value] of Object.entries(entries)) {
		if (id === key || id.startsWith(key)) {
			if (!best || key.length > best.key.length) {
				best = { key, value };
			}
		}
	}
	return best?.value;
}

export function getModelParameters(modelId: string, modelRoutes: Map<string, ModelRoute>): Record<string, unknown> {
	const route = modelRoutes.get(modelId);
	const rawId = route?.rawModelId ?? modelId;
	const modelParameters = getModelParametersConfig();
	if (route?.serverLabel) {
		const scopedMatch = findLongestPrefixMatch(`${route.serverLabel}/${rawId}`, modelParameters);
		if (scopedMatch) {
			return { ...scopedMatch };
		}
	}
	const match = findLongestPrefixMatch(rawId, modelParameters);
	return match ? { ...match } : {};
}

export interface RequestBodyParams {
	rawModelId: string;
	openaiMessages: OpenAIChatMessage[];
	maxTokens: number;
	modelParams: Record<string, unknown>;
	toolConfig: { tools?: OpenAIFunctionToolDef[]; tool_choice?: unknown };
	modelOptions?: Record<string, unknown>;
}

/**
 * Builds the request body as a pure pass-through: only parameters the user
 * set (via modelParameters config or runtime modelOptions) are forwarded,
 * never injected defaults, so the provider's own defaults apply.
 */
export function buildRequestBody(params: RequestBodyParams): Record<string, unknown> {
	const { rawModelId, openaiMessages, maxTokens, modelParams, toolConfig, modelOptions } = params;

	const body: Record<string, unknown> = {
		model: rawModelId,
		messages: openaiMessages,
		stream: true,
		stream_options: { include_usage: true },
		max_tokens: maxTokens,
	};

	const providerOwnedKeys = new Set(["model", "messages", "stream", "stream_options", "tools", "tool_choice"]);

	// Underscore-prefixed keys are internal on both sources: VS Code injects
	// them into modelOptions, and retired extension metadata such as
	// _replaceDefaults may linger in user configuration.
	const passThrough = (source: Record<string, unknown>) => {
		for (const [key, value] of Object.entries(source)) {
			if (key === "max_tokens" || providerOwnedKeys.has(key) || key.startsWith("_")) {
				continue;
			}
			body[key] = value;
		}
	};

	passThrough(modelParams);
	if (modelOptions) {
		passThrough(modelOptions);
	}

	if (toolConfig.tools) {
		body.tools = toolConfig.tools;
	}
	if (toolConfig.tool_choice) {
		body.tool_choice = toolConfig.tool_choice;
	}

	return body;
}
