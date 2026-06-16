import * as vscode from "vscode";
import type { LiteLLMProvider } from "../types";
import { normalizePositiveNumber } from "../shared/numbers";
import { findLongestPrefixMatch, getModelDefaults } from "./modelDefaults";

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

	const maxOutputTokens =
		normalizePositiveNumber(provider?.max_output_tokens) ??
		normalizePositiveNumber(provider?.max_tokens) ??
		normalizePositiveNumber(config.get<number>("defaultMaxOutputTokens", DEFAULT_MAX_OUTPUT_TOKENS)) ??
		DEFAULT_MAX_OUTPUT_TOKENS;

	const contextLength =
		normalizePositiveNumber(provider?.context_length) ??
		normalizePositiveNumber(config.get<number>("defaultContextLength", DEFAULT_CONTEXT_LENGTH)) ??
		DEFAULT_CONTEXT_LENGTH;

	const configMaxInput = normalizePositiveNumber(config.get<number | null>("defaultMaxInputTokens", null));
	const maxInputTokens =
		configMaxInput ??
		normalizePositiveNumber(provider?.max_input_tokens) ??
		Math.max(1, contextLength - maxOutputTokens);

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
		total += estimateSingleMessageTokens(m);
	}
	return total;
}

/** Estimate the token size of a single message's content (length/4 heuristic). */
function estimateSingleMessageTokens(msg: vscode.LanguageModelChatRequestMessage): number {
	let total = 0;
	for (const part of msg.content) {
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
	return total;
}

/**
 * Estimate the token size of the system-prompt block: the sum of all leading
 * `system`-role messages (VS Code may split the system prompt across several).
 */
export function estimateSystemPromptTokens(msgs: readonly vscode.LanguageModelChatRequestMessage[]): number {
	const USER = vscode.LanguageModelChatMessageRole.User as unknown as number;
	const ASSISTANT = vscode.LanguageModelChatMessageRole.Assistant as unknown as number;
	let total = 0;
	for (const m of msgs) {
		const r = m.role as unknown as number;
		// Only the *leading* system block is cached, so stop accumulating once
		// the conversation proper begins. A stray system-role message later in
		// the transcript must not inflate the `system` anchor size (which would
		// mis-drive the minCacheTokens floor and auto-mode TTL gating).
		if (r === USER || r === ASSISTANT) {
			break;
		}
		total += estimateSingleMessageTokens(m);
	}
	return total;
}

/** Estimate the token size of the first user message block. */
export function estimateFirstUserTokens(msgs: readonly vscode.LanguageModelChatRequestMessage[]): number {
	const USER = vscode.LanguageModelChatMessageRole.User as unknown as number;
	for (const m of msgs) {
		if ((m.role as unknown as number) === USER) {
			return estimateSingleMessageTokens(m);
		}
	}
	return 0;
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

	return body;
}
