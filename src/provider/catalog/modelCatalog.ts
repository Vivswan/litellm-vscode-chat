import type { CapabilityFieldValues, ServerDeclaredCapabilities } from "../../shared/config/capabilityResolution";
import { FLOOR_CONTEXT_LENGTH, FLOOR_MAX_OUTPUT_TOKENS } from "../../shared/config/capabilityResolution";
import { normalizePositiveNumber } from "../../shared/util/numbers";
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

export interface DiscoveredBaselineInput {
	/** The provider entries backing this registered entry; empty for bare /v1/models entries. */
	readonly providers: readonly LiteLLMProvider[];
	/** The input modalities exactly when the server supplied the array; undefined means unreported. */
	readonly modalities: readonly string[] | undefined;
	/** The toolCalling capability this entry advertises (registration's answer for its shape). */
	readonly toolCalling: boolean;
	/** Whether this entry advertises the reasoning-effort control (registration's answer for its shape). */
	readonly reasoning: boolean;
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
 * (or, for reasoning, the supported-params list); modality flags count as
 * reported when the server supplied a modality array at all - a model_info
 * entry that explicitly disclaims vision drops its architecture on the way
 * here, an accepted conflation of "reported false" with "unreported".
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
	const values: Partial<CapabilityFieldValues> = {
		...(constraints !== undefined && reported.context ? { context_length: constraints.contextLength } : {}),
		...(constraints !== undefined && reported.any ? { max_input_tokens: constraints.maxInputTokens } : {}),
		...(constraints !== undefined && reported.output ? { max_output_tokens: constraints.maxOutputTokens } : {}),
		...(toolsReported ? { supports_function_calling: toolCalling } : {}),
		...(reasoningReported ? { supports_reasoning: reasoning } : {}),
		...(modalities !== undefined
			? { supports_vision: modalities.includes("image"), supports_audio_input: modalities.includes("audio") }
			: {}),
	};
	return { kind: "discovered", values, outputDeclared: constraints?.outputLimitSource === "provider" };
}
