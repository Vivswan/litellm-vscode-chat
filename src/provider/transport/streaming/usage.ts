import { isRecord } from "../../../shared/json";

/**
 * The known numeric token counts of a usage trailer. The record is
 * response-owned, so logging it wholesale would let arbitrary server keys
 * ride into the issue-report buffer; only these counts have diagnostic
 * value, and only numbers pass.
 */
export function knownUsageCounts(usage: object): Record<string, number> {
	const record = usage as Record<string, unknown>;
	const counts: Record<string, number> = {};
	// Number.isFinite, not typeof: a server literal like 1e999 parses to
	// Infinity, which is useless as a diagnostic count.
	for (const key of [
		"prompt_tokens",
		"completion_tokens",
		"total_tokens",
		"cache_creation_input_tokens",
		"cache_read_input_tokens",
	]) {
		const value = record[key];
		if (Number.isFinite(value)) {
			counts[key] = value as number;
		}
	}
	const detailGroups: ReadonlyArray<readonly [string, readonly string[]]> = [
		["prompt_tokens_details", ["cached_tokens", "cache_creation_input_tokens", "audio_tokens"]],
		["completion_tokens_details", ["reasoning_tokens", "audio_tokens"]],
	];
	for (const [group, keys] of detailGroups) {
		const nested = record[group];
		if (typeof nested !== "object" || nested === null) {
			continue;
		}
		for (const key of keys) {
			const value = (nested as Record<string, unknown>)[key];
			if (Number.isFinite(value)) {
				counts[`${group}.${key}`] = value as number;
			}
		}
	}
	return counts;
}

/**
 * The sanitized payload of the end-of-stream "usage" DataPart, or undefined
 * when the trailer lacks any of the three required counts (the consumer's
 * shape check rejects such a payload outright, so emitting it would be
 * noise). The trailer is response-owned, so it is never forwarded verbatim:
 * only these known numeric counts pass, the same discipline as
 * knownUsageCounts. Cache accounting reads the OpenAI-style
 * prompt_tokens_details keys first and falls back to the top-level
 * cache_read_input_tokens/cache_creation_input_tokens fields LiteLLM emits on
 * Anthropic routes, mapping both shapes onto the prompt_tokens_details keys
 * the consumer reads. Number.isFinite guards every count: a server literal
 * like 1e999 parses to Infinity, JSON.stringify would serialize it as null,
 * and the consumer's shape check would then reject the whole payload.
 */
export function usageDataPartPayload(usage: Record<string, unknown>): Record<string, unknown> | undefined {
	const num = (value: unknown): number | undefined => (Number.isFinite(value) ? (value as number) : undefined);
	const promptTokens = num(usage.prompt_tokens);
	const completionTokens = num(usage.completion_tokens);
	const totalTokens = num(usage.total_tokens);
	if (promptTokens === undefined || completionTokens === undefined || totalTokens === undefined) {
		return undefined;
	}
	const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined;
	const completionDetails = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : undefined;
	const cachedTokens = num(promptDetails?.cached_tokens) ?? num(usage.cache_read_input_tokens);
	const cacheCreationTokens = num(promptDetails?.cache_creation_input_tokens) ?? num(usage.cache_creation_input_tokens);
	const reasoningTokens = num(completionDetails?.reasoning_tokens);
	const payload: Record<string, unknown> = {
		prompt_tokens: promptTokens,
		completion_tokens: completionTokens,
		total_tokens: totalTokens,
	};
	const details: Record<string, number> = {
		...(cachedTokens !== undefined ? { cached_tokens: cachedTokens } : {}),
		...(cacheCreationTokens !== undefined ? { cache_creation_input_tokens: cacheCreationTokens } : {}),
	};
	if (Object.keys(details).length > 0) {
		payload.prompt_tokens_details = details;
	}
	if (reasoningTokens !== undefined) {
		payload.completion_tokens_details = { reasoning_tokens: reasoningTokens };
	}
	return payload;
}
