import { getModelParametersConfig } from "../shared/settings";
import type { OpenAIChatMessage, OpenAIFunctionToolDef } from "../types";
import type { ModelRoute } from "./modelCatalog";
import { findLongestPrefixMatch, getModelDefaults } from "./modelDefaults";

/** Fallback max_tokens when neither runtime options nor configured model parameters set one. */
export const DEFAULT_MAX_TOKENS_CAP = 4096;
export const MAX_TOOLS_PER_REQUEST = 128;

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

export function buildRequestBody(params: RequestBodyParams): Record<string, unknown> {
	const { rawModelId, openaiMessages, maxTokens, modelParams, toolConfig, modelOptions } = params;

	const replaceDefaults = modelParams._replaceDefaults === true;
	delete modelParams._replaceDefaults;

	const defaults = replaceDefaults ? {} : getModelDefaults(rawModelId);

	const body: Record<string, unknown> = {
		model: rawModelId,
		messages: openaiMessages,
		stream: true,
		stream_options: { include_usage: true },
		max_tokens: maxTokens,
		...defaults,
	};

	const providerOwnedKeys = new Set(["model", "messages", "stream", "stream_options", "tools", "tool_choice"]);

	for (const [key, value] of Object.entries(modelParams)) {
		if (key !== "max_tokens" && !providerOwnedKeys.has(key)) {
			body[key] = value;
		}
	}

	if (modelOptions) {
		for (const [key, value] of Object.entries(modelOptions)) {
			if (key === "max_tokens") {
				continue;
			}
			if (providerOwnedKeys.has(key)) {
				continue;
			}
			if (key.startsWith("_")) {
				continue;
			}
			body[key] = value;
		}
	}

	if (toolConfig.tools) {
		body.tools = toolConfig.tools;
	}
	if (toolConfig.tool_choice) {
		body.tool_choice = toolConfig.tool_choice;
	}

	return body;
}
