import { normalizePositiveNumber } from "../../shared/numbers";
import type { TokenDefaults } from "../../shared/settings";
import type { LiteLLMProvider, OutputLimitSource } from "./schemas";

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
	/** Provenance of maxOutputTokens; only "provider" values may be sent to the server uncapped. */
	outputLimitSource: OutputLimitSource;
	contextLength: number;
	maxInputTokens: number;
}

/**
 * A minimum taken over several constraints is server-declared only when
 * every contributing limit was: one defaults-filled contributor can supply
 * the minimum itself, and its true limit is unknown either way. No
 * contributors at all also means defaults, so the helper can never fail
 * open on vacuous input.
 */
function combinedOutputLimitSource(constraints: readonly TokenConstraints[]): OutputLimitSource {
	return constraints.length > 0 && constraints.every((c) => c.outputLimitSource === "provider")
		? "provider"
		: "defaults";
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
	const declaredOutputTokens =
		normalizePositiveNumber(provider?.max_output_tokens) ?? normalizePositiveNumber(provider?.max_tokens);
	const maxOutputTokens = declaredOutputTokens ?? defaults.maxOutputTokens;
	// Only an exact "defaults" marker demotes, so a passed-through wire field
	// can never promote a defaults-derived limit to server-declared.
	const outputLimitSource: OutputLimitSource =
		declaredOutputTokens !== undefined && provider?.output_limit_source !== "defaults" ? "provider" : "defaults";

	const contextLength = normalizePositiveNumber(provider?.context_length) ?? defaults.contextLength;

	// A configured defaultMaxInputTokens is an explicit user override and
	// outranks even a server-declared max_input_tokens (pinned by the
	// "explicit override" request-contract test); the server's limit and the
	// context-minus-output guess are fallbacks, in that order.
	const maxInputTokens =
		defaults.maxInputTokens ??
		normalizePositiveNumber(provider?.max_input_tokens) ??
		Math.max(1, contextLength - maxOutputTokens);

	return { maxOutputTokens, outputLimitSource, contextLength, maxInputTokens };
}

/**
 * The conservative collapse of several contributors' effective constraints:
 * each contributor's standalone constraints are derived under the same
 * defaults snapshot, the per-field minimum is taken, and the combined output
 * limit counts as server-declared only when every contributor declared one
 * (see combinedOutputLimitSource above). The one home of the min-collapse
 * rule: deployment merging (mergeModelDeployments) and registration's
 * cheapest/fastest aggregates both advertise through it, so neither can
 * advertise more input than the strictest contributor accepts, whichever
 * combination of raw limit fields each contributor set. The non-empty
 * parameter type keeps the minimums grounded in at least one real
 * contributor.
 */
export function collapseTokenConstraints(
	contributors: readonly [LiteLLMProvider, ...LiteLLMProvider[]],
	defaults: TokenDefaults
): TokenConstraints {
	const standalone = contributors.map((provider) => deriveTokenConstraints(provider, defaults));
	return {
		maxOutputTokens: Math.min(...standalone.map((c) => c.maxOutputTokens)),
		outputLimitSource: combinedOutputLimitSource(standalone),
		contextLength: Math.min(...standalone.map((c) => c.contextLength)),
		maxInputTokens: Math.min(...standalone.map((c) => c.maxInputTokens)),
	};
}
