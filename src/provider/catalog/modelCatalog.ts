import type { ServerCapabilityValues, ServerDeclaredCapabilities } from "../../shared/config/capabilityResolution";
import { FLOOR_CONTEXT_LENGTH, FLOOR_MAX_OUTPUT_TOKENS } from "../../shared/config/capabilityResolution";
import { normalizeCostPerToken, normalizePositiveNumber } from "../../shared/util/numbers";
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

/**
 * Invert buildExposedModelId without knowing the registration-time server
 * count: strip the "<serverId>/" namespace when the ID carries it, else the
 * ID is already raw (single-server registrations and provider groups, which
 * always register with a count of 1). The one ambiguity is a raw ID that
 * itself begins with "<serverId>/" registered at count <= 1 - no LiteLLM
 * route mints such IDs, and the round-trip property test pins the exact
 * contract. Consumers without a route map (the dashboard's state builder)
 * resolve raw IDs through this instead of open-coding the strip.
 */
export function rawModelIdFromExposed(exposedId: string, serverId: string): string {
	const prefix = `${serverId}/`;
	return exposedId.startsWith(prefix) ? exposedId.slice(prefix.length) : exposedId;
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
 * every contributing limit was: one floor-filled contributor can supply
 * the minimum itself, and its true limit is unknown either way. No
 * contributors at all also means a floor fill, so the helper can never fail
 * open on vacuous input.
 */
function combinedOutputLimitSource(constraints: readonly TokenConstraints[]): OutputLimitSource {
	return constraints.length > 0 && constraints.every((c) => c.outputLimitSource === "provider")
		? "provider"
		: "defaults";
}

/**
 * The effective token constraints a provider entry advertises. The single
 * home of the fallback rules: an unreported limit falls back to the built-in
 * floor (the same FLOOR_* literals the capability walk floors to), and a
 * missing input limit derives from context minus output.
 */
export function deriveTokenConstraints(provider: LiteLLMProvider | undefined): TokenConstraints {
	const declaredOutputTokens =
		normalizePositiveNumber(provider?.max_output_tokens) ?? normalizePositiveNumber(provider?.max_tokens);
	const maxOutputTokens = declaredOutputTokens ?? FLOOR_MAX_OUTPUT_TOKENS;
	// Only an exact "defaults" marker demotes, so a passed-through wire field
	// can never promote a floor-derived limit to server-declared.
	const outputLimitSource: OutputLimitSource =
		declaredOutputTokens !== undefined && provider?.output_limit_source !== "defaults" ? "provider" : "defaults";

	const contextLength = normalizePositiveNumber(provider?.context_length) ?? FLOOR_CONTEXT_LENGTH;

	const maxInputTokens =
		normalizePositiveNumber(provider?.max_input_tokens) ?? Math.max(1, contextLength - maxOutputTokens);

	return { maxOutputTokens, outputLimitSource, contextLength, maxInputTokens };
}

/**
 * The conservative collapse of several contributors' effective constraints:
 * each contributor's standalone constraints are derived, the per-field
 * minimum is taken, and the combined output limit counts as server-declared
 * only when every contributor declared one (see combinedOutputLimitSource
 * above). The one home of the min-collapse rule: deployment merging
 * (mergeModelDeployments) and registration's cheapest/fastest aggregates both
 * advertise through it, so neither can advertise more input than the
 * strictest contributor accepts, whichever combination of raw limit fields
 * each contributor set. The non-empty parameter type keeps the minimums
 * grounded in at least one real contributor.
 */
export function collapseTokenConstraints(
	contributors: readonly [LiteLLMProvider, ...LiteLLMProvider[]]
): TokenConstraints {
	const standalone = contributors.map((provider) => deriveTokenConstraints(provider));
	return {
		maxOutputTokens: Math.min(...standalone.map((c) => c.maxOutputTokens)),
		outputLimitSource: combinedOutputLimitSource(standalone),
		contextLength: Math.min(...standalone.map((c) => c.contextLength)),
		maxInputTokens: Math.min(...standalone.map((c) => c.maxInputTokens)),
	};
}

/** A contributor's own output limit, before any floor fill; the same field priority deriveTokenConstraints uses. */
function reportedOutputTokens(provider: LiteLLMProvider): number | undefined {
	return normalizePositiveNumber(provider.max_output_tokens) ?? normalizePositiveNumber(provider.max_tokens);
}

/** Which token-limit fields any contributor actually reported. */
export interface ReportedLimits {
	readonly context: boolean;
	readonly input: boolean;
	readonly output: boolean;
	/** Any of the three: the input limit is server-grounded whenever anything numeric was reported (see the baseline doc). */
	readonly any: boolean;
}

/**
 * The reported-vs-floor-filled judgment for a set of contributors, shared by
 * deployment merging (mergeModelDeployments) and the capability baseline
 * (discoveredCapabilityBaseline) so the two can never classify one field
 * differently.
 */
export function reportedLimits(providers: readonly LiteLLMProvider[]): ReportedLimits {
	const context = providers.some((p) => normalizePositiveNumber(p.context_length) !== undefined);
	const input = providers.some((p) => normalizePositiveNumber(p.max_input_tokens) !== undefined);
	const output = providers.some((p) => reportedOutputTokens(p) !== undefined);
	return { context, input, output, any: context || input || output };
}

/** The per-token cost fields pricingFromCosts converts; a LiteLLMProvider satisfies it as-is. */
export type PerTokenCosts = Pick<
	LiteLLMProvider,
	| "input_cost_per_token"
	| "output_cost_per_token"
	| "cache_read_input_token_cost"
	| "cache_creation_input_token_cost"
	| "long_context_input_cost_per_token"
	| "long_context_output_cost_per_token"
	| "long_context_cache_read_input_token_cost"
	| "long_context_cache_creation_input_token_cost"
>;

/** The 8 cost fields under their wire names, exhaustive over PerTokenCosts by the satisfies check. */
const SERVER_COST_FIELDS = Object.keys({
	input_cost_per_token: true,
	output_cost_per_token: true,
	cache_read_input_token_cost: true,
	cache_creation_input_token_cost: true,
	long_context_input_cost_per_token: true,
	long_context_output_cost_per_token: true,
	long_context_cache_read_input_token_cost: true,
	long_context_cache_creation_input_token_cost: true,
} satisfies Record<keyof PerTokenCosts, true>) as readonly (keyof PerTokenCosts)[];

/**
 * The cost fields of one baseline, normalized. LiteLLM (observed on v1.93)
 * stamps input/output_cost_per_token: 0 onto /model/info entries that declare
 * no pricing at all, so a zero PAIR reads as undeclared and drops every cost
 * field (stray cache or long-context costs beside the stamp included), exactly
 * like pricingFromCosts' display rule - the walk's server level must never
 * carry a price registration refused to advertise. Otherwise each field some
 * contributor declared with a usable cost is stored (normalizeCostPerToken
 * canonicalizes -0 to +0, so a stored zero can never ride a negative sign
 * into the per-million conversion).
 */
function serverCostValues(costs: PerTokenCosts): Partial<ServerCapabilityValues> {
	if (
		normalizeCostPerToken(costs.input_cost_per_token) === 0 &&
		normalizeCostPerToken(costs.output_cost_per_token) === 0
	) {
		return {};
	}
	const values: { -readonly [K in keyof PerTokenCosts]?: number } = {};
	for (const field of SERVER_COST_FIELDS) {
		const cost = normalizeCostPerToken(costs[field]);
		if (cost !== undefined) {
			values[field] = cost;
		}
	}
	return values;
}

/**
 * The supported-params answer of a contributor set: present only when EVERY
 * contributor carries an array (the same as-soon-as-one-lacks rule deployment
 * merging applies via intersectSupportedParams), holding the params every
 * contributor lists. Providers-array entries are lenient pass-throughs, so
 * each list is re-narrowed element-wise before use - to non-empty strings,
 * the same vocabulary the user-record "string-array" kind validates.
 */
function intersectReportedParams(providers: readonly LiteLLMProvider[]): readonly string[] | undefined {
	const lists = providers.map((p) => p.supported_openai_params);
	const [first, ...rest] = lists;
	if (!Array.isArray(first) || rest.some((list) => !Array.isArray(list))) {
		return undefined;
	}
	const narrow = (list: unknown[]): string[] =>
		list.filter((param): param is string => typeof param === "string" && param.length > 0);
	const tails = rest.map((list) => new Set(narrow(list as unknown[])));
	return narrow(first).filter((param) => tails.every((tail) => tail.has(param)));
}

export interface DiscoveredBaselineInput {
	/** The provider entries backing this registered entry; empty for bare /v1/models entries. */
	readonly providers: readonly LiteLLMProvider[];
	/** The input modalities exactly when the server supplied the array; undefined means unreported. */
	readonly modalities: readonly string[] | undefined;
	/** The toolCalling capability this entry advertises (registration's answer for its shape). */
	readonly toolCalling: boolean;
	/** Whether this entry advertises the reasoning-effort control (registration's answer for its shape). */
	readonly reasoning: boolean;
	/**
	 * The per-token costs this entry's registration would have priced: present
	 * ONLY for the shapes whose route pins the serving deployment's cost (sole
	 * model_info deployments and per-provider entries). The untooled base entry
	 * and the cheapest/fastest aggregates pass none - registration deliberately
	 * never priced them, and the walk's server level must not offer what the
	 * picker refused to advertise.
	 */
	readonly costs?: PerTokenCosts | undefined;
}

/**
 * The server-reported capability baseline of one registered entry: the walk's
 * server-level input, carried on PreAttachModelInfo.litellm.serverDeclared.
 * Two separate facts ride here. The VALUES are the conservative aggregation
 * results exactly as registration advertises them (per-field minima over the
 * contributors' standalone constraints), present whenever ANY contributor
 * reported the field - so a lower-precedence catalog guess can never displace
 * a conservative server minimum, while a field no contributor reported stays
 * absent and lets the catalog fill it. `outputDeclared` is the stricter
 * every-contributor rule (combinedOutputLimitSource) and controls only
 * whether the output limit bypasses the request-side cap.
 *
 * max_input_tokens is present whenever ANY numeric limit was reported, not
 * only max_input_tokens itself: the collapse fills a missing input limit from
 * the reported context and output limits (min over the per-contributor
 * guesses), and that server-grounded number is what registration advertises -
 * re-deriving it from the collapsed context and output instead can overstate
 * it, because min(ctx_i - out_i) undercuts min(ctx) - min(out). Boolean
 * fields count as reported when any contributor carried the explicit flag
 * (or, for reasoning, the supported-params list); modality flags (vision,
 * audio, pdf) count as reported when the server supplied a modality array at
 * all - a model_info entry that explicitly disclaims vision drops its
 * architecture on the way here, an accepted conflation of "reported false"
 * with "unreported". The prompt-caching and response-schema flags hold only
 * when every contributor advertises them (the same every-contributor rule the
 * registered supportsPromptCaching metadata applies, so the baseline can
 * never say more than the entry advertised); the supported-params list is
 * present only when every contributor carries one and holds their
 * intersection; costs appear only for pricing-eligible shapes (see
 * DiscoveredBaselineInput.costs) under serverCostValues' zero-pair rule.
 */
export function discoveredCapabilityBaseline(input: DiscoveredBaselineInput): ServerDeclaredCapabilities {
	const { providers, modalities, toolCalling, reasoning } = input;
	const [first, ...rest] = providers;
	const constraints = first === undefined ? undefined : collapseTokenConstraints([first, ...rest]);
	const reported = reportedLimits(providers);
	const toolsReported = providers.some((p) => typeof p.supports_tools === "boolean");
	const reasoningReported = providers.some(
		(p) => typeof p.supports_reasoning === "boolean" || Array.isArray(p.supported_openai_params)
	);
	const promptCachingReported = providers.some((p) => typeof p.supports_prompt_caching === "boolean");
	const responseSchemaReported = providers.some((p) => typeof p.supports_response_schema === "boolean");
	const supportedParams = intersectReportedParams(providers);
	const values: Partial<ServerCapabilityValues> = {
		...(constraints !== undefined && reported.context ? { context_length: constraints.contextLength } : {}),
		...(constraints !== undefined && reported.any ? { max_input_tokens: constraints.maxInputTokens } : {}),
		...(constraints !== undefined && reported.output ? { max_output_tokens: constraints.maxOutputTokens } : {}),
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
		...(input.costs !== undefined ? serverCostValues(input.costs) : {}),
	};
	return { kind: "discovered", values, outputDeclared: constraints?.outputLimitSource === "provider" };
}
