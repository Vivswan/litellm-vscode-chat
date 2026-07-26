import { normalizePositiveNumber } from "../shared/numbers";
import { getTokenDefaults } from "../shared/settings";
import type { LiteLLMProvider } from "./schemas";

export interface ModelRoute {
	serverId: string;
	rawModelId: string;
	serverLabel: string;
}

export function buildExposedModelId(rawModelId: string, serverId: string, serverCount: number): string {
	if (serverCount <= 1) {
		return rawModelId;
	}
	return `${serverId}/${rawModelId}`;
}

export function getTokenConstraints(provider: LiteLLMProvider | undefined): {
	maxOutputTokens: number;
	contextLength: number;
	maxInputTokens: number;
} {
	const defaults = getTokenDefaults();

	const maxOutputTokens =
		normalizePositiveNumber(provider?.max_output_tokens) ??
		normalizePositiveNumber(provider?.max_tokens) ??
		defaults.maxOutputTokens;

	const contextLength = normalizePositiveNumber(provider?.context_length) ?? defaults.contextLength;

	const maxInputTokens =
		defaults.maxInputTokens ??
		normalizePositiveNumber(provider?.max_input_tokens) ??
		Math.max(1, contextLength - maxOutputTokens);

	return { maxOutputTokens, contextLength, maxInputTokens };
}
