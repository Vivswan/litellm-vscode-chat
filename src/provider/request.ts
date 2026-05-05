import * as vscode from "vscode";
import type { LiteLLMProvider } from "../types";
import { findLongestPrefixMatch, getModelDefaults } from "./modelDefaults";

const KNOWN_PARAMETER_LIMITATIONS: Record<string, Set<string>> = {
	claude: new Set(["temperature"]),
	o1: new Set(["temperature", "top_p", "frequency_penalty", "presence_penalty"]),
	"gpt-5": new Set(["temperature", "top_p", "frequency_penalty", "presence_penalty"]),
	"gpt-5.1-codex": new Set(["temperature", "frequency_penalty", "presence_penalty"]),
	"codex-mini": new Set(["temperature", "frequency_penalty", "presence_penalty"]),
};

export function stripUnsupportedParams(body: Record<string, unknown>, rawModelId: string): void {
	const modelName = rawModelId.includes("/") ? rawModelId.slice(rawModelId.lastIndexOf("/") + 1) : rawModelId;
	const unsupported = findLongestPrefixMatch(modelName, KNOWN_PARAMETER_LIMITATIONS);
	if (unsupported) {
		for (const param of unsupported) {
			delete body[param];
		}
	}
}

const DEFAULT_MAX_OUTPUT_TOKENS = 16000;
const DEFAULT_CONTEXT_LENGTH = 128000;

export interface ModelRoute {
	serverId: string;
	rawModelId: string;
	serverLabel: string;
}

export function getTokenConstraints(provider: LiteLLMProvider | undefined): {
	maxOutputTokens: number;
	contextLength: number;
	maxInputTokens: number;
} {
	const config = vscode.workspace.getConfiguration("litellm-vscode-chat");
	const normalizePositive = (value: unknown): number | undefined =>
		typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

	const maxOutputTokens =
		normalizePositive(provider?.max_output_tokens) ??
		normalizePositive(provider?.max_tokens) ??
		normalizePositive(config.get<number>("defaultMaxOutputTokens", DEFAULT_MAX_OUTPUT_TOKENS)) ??
		DEFAULT_MAX_OUTPUT_TOKENS;

	const contextLength =
		normalizePositive(provider?.context_length) ??
		normalizePositive(config.get<number>("defaultContextLength", DEFAULT_CONTEXT_LENGTH)) ??
		DEFAULT_CONTEXT_LENGTH;

	const configMaxInput = normalizePositive(config.get<number | null>("defaultMaxInputTokens", null));
	const maxInputTokens =
		configMaxInput ?? normalizePositive(provider?.max_input_tokens) ?? Math.max(1, contextLength - maxOutputTokens);

	return { maxOutputTokens, contextLength, maxInputTokens };
}

export function getModelParameters(modelId: string, modelRoutes: Map<string, ModelRoute>): Record<string, unknown> {
	const route = modelRoutes.get(modelId);
	const rawId = route?.rawModelId ?? modelId;
	const config = vscode.workspace.getConfiguration("litellm-vscode-chat");
	const modelParameters = config.get<Record<string, Record<string, unknown>>>("modelParameters", {});
	if (route?.serverLabel) {
		const scopedMatch = findLongestPrefixMatch(`${route.serverLabel}/${rawId}`, modelParameters);
		if (scopedMatch) {
			return { ...scopedMatch };
		}
	}
	const match = findLongestPrefixMatch(rawId, modelParameters);
	return match ? { ...match } : {};
}

export function buildExposedModelId(rawModelId: string, serverId: string, serverCount: number): string {
	if (serverCount <= 1) {
		return rawModelId;
	}
	return `${serverId}/${rawModelId}`;
}

export function estimateMessagesTokens(msgs: readonly vscode.LanguageModelChatRequestMessage[]): number {
	let total = 0;
	for (const m of msgs) {
		for (const part of m.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				total += Math.ceil(part.value.length / 4);
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				total += Math.ceil((part.name.length + JSON.stringify(part.input ?? {}).length) / 4);
			} else if (part instanceof vscode.LanguageModelDataPart) {
				const mime = part.mimeType.toLowerCase();
				if (mime.startsWith("text/") || mime === "application/json" || mime.endsWith("+json")) {
					total += Math.ceil(part.data.length / 4);
				}
			}
		}
	}
	return total;
}

export function estimateToolTokens(
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

export interface RequestBodyParams {
	rawModelId: string;
	openaiMessages: unknown[];
	maxTokens: number;
	modelParams: Record<string, unknown>;
	toolConfig: { tools?: unknown[]; tool_choice?: unknown };
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

	stripUnsupportedParams(body, rawModelId);
	return body;
}
