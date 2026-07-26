import { normalizePositiveNumber } from "../shared/numbers";
import type { TokenDefaults } from "../shared/settings";
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

export interface TokenConstraints {
	maxOutputTokens: number;
	contextLength: number;
	maxInputTokens: number;
}

/**
 * The effective token constraints a provider entry advertises under the given
 * defaults. The single home of the fallback rules; every caller receives the
 * refresh pass's one defaults snapshot (read at the top of the provider's
 * refresh and threaded through discovery and registration), so deployment
 * merging and registration always agree.
 */
export function deriveTokenConstraints(
	provider: LiteLLMProvider | undefined,
	defaults: TokenDefaults
): TokenConstraints {
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
