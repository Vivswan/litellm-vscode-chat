import type { ServerCapabilityValues, ServerDeclaredCapabilities } from "../../shared/config/capabilityResolution";
import {
	consumedFieldsOfKind,
	FLOOR_CONTEXT_LENGTH,
	FLOOR_MAX_OUTPUT_TOKENS,
	guessedMaxTokensDefault,
} from "../../shared/config/capabilityResolution";
import { normalizeCostPerToken } from "../../shared/util/numbers";
import { intersectSupportedReasoningEfforts } from "./modelConfiguration";
import type { DeclaredPerTokenCosts, LiteLLMProvider, PerTokenCosts, TokenConstraints } from "./schemas";

export function buildExposedModelId(rawModelId: string, serverId: string, serverCount: number): string {
	if (serverCount <= 1) {
		return rawModelId;
	}
	return `${serverId}/${rawModelId}`;
}

/**
 * The single home of the fallback rules: an unreported limit falls back to the built-in floor (the same FLOOR_*
 * literals the capability walk floors to), a missing input limit derives from context minus output, and the request
 * default is decided here, at the floor fill, so no later layer needs to know which number was a guess. The limit
 * fields are read as-is: discovery narrowed them to positive numbers or undefined at the mapping sites.
 */
export function deriveTokenConstraints(provider: LiteLLMProvider | undefined): TokenConstraints {
	const declaredOutputTokens = provider?.max_output_tokens ?? provider?.max_tokens;
	const maxOutputTokens = declaredOutputTokens ?? FLOOR_MAX_OUTPUT_TOKENS;
	const defaultMaxTokens = declaredOutputTokens ?? guessedMaxTokensDefault(FLOOR_MAX_OUTPUT_TOKENS);
	const contextLength = provider?.context_length ?? FLOOR_CONTEXT_LENGTH;
	const maxInputTokens = provider?.max_input_tokens ?? Math.max(1, contextLength - maxOutputTokens);
	const reported = {
		context: provider?.context_length !== undefined,
		input: provider?.max_input_tokens !== undefined,
		output: declaredOutputTokens !== undefined,
	};
	return {
		maxOutputTokens,
		defaultMaxTokens,
		contextLength,
		maxInputTokens,
		reported: { ...reported, any: reported.context || reported.input || reported.output },
	};
}

/**
 * The one home of the min-collapse rule: deployment merging and registration's cheapest/fastest aggregates both
 * advertise through it, so neither can advertise more input than the strictest contributor accepts. The request
 * default collapses the same way, which is how one floor-filled contributor keeps the whole set under the cap.
 */
export function collapseTokenLimits(limits: readonly [TokenConstraints, ...TokenConstraints[]]): TokenConstraints {
	const reported = {
		context: limits.some((c) => c.reported.context),
		input: limits.some((c) => c.reported.input),
		output: limits.some((c) => c.reported.output),
	};
	return {
		maxOutputTokens: Math.min(...limits.map((c) => c.maxOutputTokens)),
		defaultMaxTokens: Math.min(...limits.map((c) => c.defaultMaxTokens)),
		contextLength: Math.min(...limits.map((c) => c.contextLength)),
		maxInputTokens: Math.min(...limits.map((c) => c.maxInputTokens)),
		reported: { ...reported, any: reported.context || reported.input || reported.output },
	};
}

const COST_FIELDS = consumedFieldsOfKind("cost");

/**
 * Server costs are present-means-declared by construction: discovery's serverCostsOf already mapped LiteLLM's 0/0
 * no-pricing stamp to undefined at ingest, so every cost a provider entry still carries was declared and each field
 * with a usable cost is stored (normalizeCostPerToken canonicalizes -0 to +0, so a stored zero cannot ride a negative
 * sign into the per-million conversion; merged entries carry null for disagreeing costs, which reads as absent here).
 */
function serverCostValues(costs: Readonly<PerTokenCosts>): Partial<ServerCapabilityValues> {
	const values: DeclaredPerTokenCosts = {};
	for (const field of COST_FIELDS) {
		const cost = normalizeCostPerToken(costs[field]);
		if (cost !== undefined) {
			values[field] = cost;
		}
	}
	return values;
}

/** Providers-array entries are lenient pass-throughs, so a list is re-narrowed to the string-array kind's values. */
function narrowStrings(list: unknown[]): string[] {
	return list.filter((param): param is string => typeof param === "string" && param.length > 0);
}

function intersectReportedLists(lists: readonly (string[] | null | undefined)[]): readonly string[] | undefined {
	const [first, ...rest] = lists;
	if (!Array.isArray(first) || rest.some((list) => !Array.isArray(list))) {
		return undefined;
	}
	const tails = rest.map((list) => new Set(narrowStrings(list as unknown[])));
	return narrowStrings(first).filter((param) => tails.every((tail) => tail.has(param)));
}

function intersectReportedParams(providers: readonly LiteLLMProvider[]): readonly string[] | undefined {
	return intersectReportedLists(providers.map((p) => p.supported_openai_params));
}

/**
 * The proxy's own group merge, mirrored (router._set_model_group_info): one deployment resolved to unknown leaves the
 * whole group unknown, otherwise the deployments' answers intersect, so the menu offers nothing routing could reject.
 * Deployment merging, registration's configurationSchemaFor, and the capability baseline all read this one rule.
 *   {low, high} and {high, max} -> [high]
 *   {low} and {high}            -> []: the menu registers empty, the server's word
 *   {low} and unknown           -> undefined: the menu falls back to the built-in list
 */
export function reportedReasoningLevels(providers: readonly LiteLLMProvider[]): string[] | undefined {
	let merged: string[] | undefined;
	for (const [index, provider] of providers.entries()) {
		const levels = provider.reasoning_effort_levels;
		if (!Array.isArray(levels)) {
			return undefined;
		}
		const resolved = narrowStrings(levels);
		merged = index === 0 ? resolved : intersectSupportedReasoningEfforts(merged, resolved);
	}
	return merged;
}

export interface DiscoveredBaselineInput {
	/** The provider entries backing this registered entry; empty for bare /v1/models entries. */
	readonly providers: readonly LiteLLMProvider[];
	/** The limits this entry advertises, as registration derived them for its shape. */
	readonly limits: TokenConstraints;
	/** The input modalities exactly when the server supplied the array; undefined means unreported. */
	readonly modalities: readonly string[] | undefined;
	/** The toolCalling capability this entry advertises (registration's answer for its shape). */
	readonly toolCalling: boolean;
	/** Whether this entry advertises the reasoning-effort control (registration's answer for its shape). */
	readonly reasoning: boolean;
	/**
	 * The per-token costs this entry's registration would have priced: present ONLY for the shapes whose route pins the
	 * serving deployment's cost. The untooled base entry and the cheapest/fastest aggregates pass none - registration
	 * deliberately never priced them, and the walk's server level must not offer what the picker refused to advertise.
	 */
	readonly costs?: Readonly<PerTokenCosts> | undefined;
}

/**
 * VALUES are registration's aggregates exactly as advertised, so a lower-precedence catalog guess never
 * displaces a server minimum, while a field no contributor reported stays absent for the catalog to fill.
 * max_input_tokens counts as reported whenever ANY limit was, since re-deriving it from the collapse can overstate it.
 */
export function discoveredCapabilityBaseline(input: DiscoveredBaselineInput): ServerDeclaredCapabilities {
	const { providers, limits, modalities, toolCalling, reasoning } = input;
	const reported = limits.reported;
	const toolsReported = providers.some((p) => typeof p.supports_tools === "boolean");
	const reasoningReported = providers.some(
		(p) => typeof p.supports_reasoning === "boolean" || Array.isArray(p.supported_openai_params)
	);
	const promptCachingReported = providers.some((p) => typeof p.supports_prompt_caching === "boolean");
	const responseSchemaReported = providers.some((p) => typeof p.supports_response_schema === "boolean");
	const supportedParams = intersectReportedParams(providers);
	const reasoningLevels = reportedReasoningLevels(providers);
	const values: Partial<ServerCapabilityValues> = {
		...(reported.context ? { context_length: limits.contextLength } : {}),
		...(reported.any ? { max_input_tokens: limits.maxInputTokens } : {}),
		...(reported.output ? { max_output_tokens: limits.maxOutputTokens } : {}),
		...(toolsReported ? { supports_function_calling: toolCalling } : {}),
		...(reasoningReported ? { supports_reasoning: reasoning } : {}),
		...(modalities !== undefined
			? {
					supports_vision: modalities.includes("image"),
					supports_audio_input: modalities.includes("audio"),
					supports_pdf_input: modalities.includes("pdf"),
				}
			: {}),
		...(promptCachingReported
			? { supports_prompt_caching: providers.every((p) => p.supports_prompt_caching === true) }
			: {}),
		...(responseSchemaReported
			? { supports_response_schema: providers.every((p) => p.supports_response_schema === true) }
			: {}),
		...(supportedParams !== undefined ? { supported_openai_params: supportedParams } : {}),
		...(reasoningLevels !== undefined ? { reasoning_effort_levels: reasoningLevels } : {}),
		...(input.costs !== undefined ? serverCostValues(input.costs) : {}),
	};
	return { kind: "discovered", values, defaultMaxTokens: limits.defaultMaxTokens };
}
