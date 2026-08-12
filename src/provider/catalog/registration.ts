import type { LanguageModelChatInformation } from "vscode";
import type { ServerWithKey } from "../../shared/servers";
import { normalizeCostPerToken } from "../../shared/util/numbers";
import type { PreAttachModelInfo } from "./groupModels";
import type { PerTokenCosts } from "./modelCatalog";
import {
	buildExposedModelId,
	collapseTokenConstraints,
	deriveTokenConstraints,
	discoveredCapabilityBaseline,
} from "./modelCatalog";
import { REASONING_EFFORT_SCHEMA, supportsReasoningEffort } from "./modelConfiguration";
import type { LiteLLMModelItem, LiteLLMProvider } from "./schemas";
import { supportsTools } from "./schemas";

export interface RegistrationResult {
	/** Pre-attach on purpose: registration output must never carry a group's credentials. */
	infos: PreAttachModelInfo[];
}

/**
 * The family a single-provider entry registers under. Real provider names
 * (LiteLLM's litellm_provider, or a providers-array entry's name) make
 * `vscode.lm.selectChatModels({ family })` useful to other extensions; a
 * blank name falls back to the generic "litellm".
 */
function familyFromProvider(provider: LiteLLMProvider): string {
	return provider.provider.length > 0 ? provider.provider : "litellm";
}

/** VS Code's pricing unit is cost per million tokens; LiteLLM reports cost per token. */
const TOKENS_PER_MILLION = 1_000_000;
/**
 * Rounding precision for the per-million conversion. Per-token costs are tiny
 * binary fractions, so the bare multiplication yields noise like
 * 2.9999999999999996 for a 0.000003 per-token cost; six decimal places keep
 * every realistic price exact while flattening it.
 */
const COST_DECIMALS = 1_000_000;

/** The numeric pricing fields of the host's model metadata, base tier and long-context tier. */
type BasePricingKey = "inputCost" | "outputCost" | "cacheCost" | "cacheWriteCost";
type LongContextPricingKey =
	| "longContextInputCost"
	| "longContextOutputCost"
	| "longContextCacheCost"
	| "longContextCacheWriteCost";
export type ModelPricing = Pick<
	LanguageModelChatInformation,
	BasePricingKey | LongContextPricingKey | "priceCategory" | "pricing"
>;

/**
 * The picker's relative cost badge, derived from the converted base
 * per-million costs. The blend weights input over output 3:1, a typical
 * input-heavy chat workload. Threshold anchors (blended per-million dollars):
 * under 1 is "low" (gpt-4o-mini 0.26, gemini-flash 0.85), under 8 is "medium"
 * (gemini-2.5-pro 3.4, gpt-4o 4.4, sonnet 6), under 40 is "high" (opus 4.5 at
 * 10, opus 4.1 at 30), and "very_high" is the rest (gpt-4.5 93.75, o1-pro
 * 262.5). Only these four literals ever go out: the host renders any other
 * string through a capitalized "<Foo> cost" fallback.
 */
function priceCategoryFor(inputCost: number, outputCost: number): "low" | "medium" | "high" | "very_high" {
	const blended = (3 * inputCost + outputCost) / 4;
	if (blended < 1) {
		return "low";
	}
	if (blended < 8) {
		return "medium";
	}
	return blended < 40 ? "high" : "very_high";
}

/**
 * The Reasoning Effort picker control for an entry backed by the given
 * provider data, or nothing. Capability data decides whether the control
 * exists (the chosen value is a parameter and travels the request path):
 * entries whose every backing provider advertises reasoning support get the
 * schema, so an aggregate over mixed providers stays without it, as does a
 * merged deployment group whose intersection already demoted the flag. Bare
 * /v1/models entries have no provider data and never advertise the control.
 */
function configurationSchemaFor(
	providers: readonly LiteLLMProvider[]
): Pick<LanguageModelChatInformation, "configurationSchema"> {
	return providers.length > 0 && providers.every(supportsReasoningEffort)
		? { configurationSchema: REASONING_EFFORT_SCHEMA }
		: {};
}

/**
 * Pricing metadata for the model picker, converted to VS Code's
 * per-million-token unit. Only entries whose route pins the serving
 * deployment's cost carry pricing: sole model_info entries (deployment
 * merging already required exact per-field agreement) and per-provider
 * entries. The cheapest/fastest aggregates and the untooled base entry stay
 * without it because there the proxy's routing decides what a request
 * actually costs; the derived priceCategory badge rides in the same return,
 * so those entries carry no category for the same reason. Providers-array entries are lenient pass-throughs, so every
 * value is re-narrowed, and a field without a usable number is omitted
 * outright rather than set to undefined. Long-context tier costs (LiteLLM's
 * above-N-tokens keys, resolved to one tier at discovery) become the host's
 * longContext* fields under two extra rules. They ride only next to their
 * base field: the picker's cost table renders the long-context value beside
 * the default one, so a tier price without a base price would sit next to an
 * empty Default cell claiming the model has no standard cost. And they are
 * omitted when they equal the converted base cost: the host declares the
 * longContext* fields as present only when long-context pricing differs from
 * default pricing. The `pricing` display label rides beside the numeric
 * fields when both base costs are known: the model picker hover's numeric
 * cost table is entitlement-gated (Copilot usage-based billing), so for a
 * typical LiteLLM user the label is the only cost line that hover can show;
 * the Manage Models markdown hover renders label and numbers together, one
 * accepted duplicated line.
 *
 * `zeroPairMeansUndeclared` (default true) is the one semantic knob, for
 * capabilityOverrides' rebuild from EFFECTIVE fields: there a raw zero pair
 * can only be user-written configuration ("this model is genuinely free" -
 * the server's 0/0 stamp never enters the capability walk, see
 * serverCostValues), so under `false` the pair prices as $0/$0 with the
 * cheapest badge instead of reading as undeclared. A pair that merely ROUNDS
 * to 0/0 (sub-unit dust) still gets neither label nor badge under either
 * setting, so a server-derived rebuild stays byte-identical to what this
 * function produced at registration. Exported for that rebuild seam.
 */
export function pricingFromCosts(
	costs: PerTokenCosts,
	opts?: { readonly zeroPairMeansUndeclared?: boolean }
): ModelPricing {
	// LiteLLM (observed on v1.93) stamps input/output_cost_per_token: 0 onto
	// /model/info entries that declare no pricing at all, so a zero pair is
	// "undeclared", not "free": rendering $0 would mislead the picker and any
	// cost-based choice. Models genuinely priced 0/0 (LiteLLM's price map does
	// this for local and self-hosted families like ollama/*) lose their $0
	// display under this rule; behind LiteLLM that shape is indistinguishable
	// from the stamp, and unknown-as-free is the worse failure.
	const zeroPair =
		normalizeCostPerToken(costs.input_cost_per_token) === 0 && normalizeCostPerToken(costs.output_cost_per_token) === 0;
	if (zeroPair && (opts?.zeroPairMeansUndeclared ?? true)) {
		return {};
	}
	const fields: { -readonly [K in keyof ModelPricing]?: ModelPricing[K] } = {};
	const toPerMillion = (perToken: unknown): number | undefined => {
		const cost = normalizeCostPerToken(perToken);
		if (cost === undefined) {
			return undefined;
		}
		const perMillion = Math.round(cost * TOKENS_PER_MILLION * COST_DECIMALS) / COST_DECIMALS;
		// The multiply can overflow a finite-but-absurd declared cost to Infinity.
		return Number.isFinite(perMillion) ? perMillion : undefined;
	};
	const set = (baseKey: BasePricingKey, longKey: LongContextPricingKey, perToken: unknown, longPerToken: unknown) => {
		const base = toPerMillion(perToken);
		if (base === undefined) {
			return;
		}
		fields[baseKey] = base;
		const long = toPerMillion(longPerToken);
		if (long !== undefined && long !== base) {
			fields[longKey] = long;
		}
	};
	set("inputCost", "longContextInputCost", costs.input_cost_per_token, costs.long_context_input_cost_per_token);
	set("outputCost", "longContextOutputCost", costs.output_cost_per_token, costs.long_context_output_cost_per_token);
	set(
		"cacheCost",
		"longContextCacheCost",
		costs.cache_read_input_token_cost,
		costs.long_context_cache_read_input_token_cost
	);
	set(
		"cacheWriteCost",
		"longContextCacheWriteCost",
		costs.cache_creation_input_token_cost,
		costs.long_context_cache_creation_input_token_cost
	);
	// The relative-cost badge and the display label need both sides of the
	// price (one-sided pricing is an incomplete signal) and derive from the
	// base tier only: the longContext* costs describe an opt-in regime, not
	// the headline cost. The converted values are already rounded to six
	// decimals, so String() renders them without float noise; a positive cost
	// too small for that unit has rounded to 0 above, and the label mirrors
	// the numeric field's 0 rather than inventing a smaller unit. A pair that
	// BOTH rounded to 0 gets neither label nor badge: it slipped past the raw
	// 0/0 undeclared check on sub-unit dust, and "$0 in / $0 out" plus a "low"
	// badge would present it as free. The `zeroPair` disjunct is reachable
	// only under zeroPairMeansUndeclared: false (the default path returned {}
	// above): a RAW zero pair kept by that option is user-written "free" and
	// carries the $0 label and the cheapest badge on purpose.
	if (
		fields.inputCost !== undefined &&
		fields.outputCost !== undefined &&
		(fields.inputCost > 0 || fields.outputCost > 0 || zeroPair)
	) {
		fields.priceCategory = priceCategoryFor(fields.inputCost, fields.outputCost);
		fields.pricing = `$${fields.inputCost} in / $${fields.outputCost} out per 1M tokens`;
	}
	return fields;
}

/**
 * Fields every registered model carries. isBYOK marks the model as served
 * with user-supplied credentials; the host currently derives true for
 * non-builtin providers, and the explicit flag pins the value against a
 * future host default change. isUserSelectable must be an explicit true:
 * the host's MCP sampling-model picker and local chat sessions use plain
 * truthy checks, so an absent flag excluded these models there. Shared with
 * capabilityOverrides.ts, whose synthesized declared models must carry
 * the same registration-wide fields.
 */
export const COMMON_MODEL_FIELDS = {
	version: "1.0.0",
	isBYOK: true,
	isUserSelectable: true,
} as const;

/** The display identity a server's registrations share; see serverDisplayContext. */
export interface ServerDisplayContext {
	readonly detail: string;
	readonly namePrefix: string;
	/** The base tooltip (deployment and bare entries); group-shape entries compose their own. */
	readonly tooltip: string;
}

/**
 * How a server's models identify themselves in the picker: multi-server
 * registrations carry the server label (detail, a name prefix, the tooltip);
 * a sole server stays plain "LiteLLM". Shared with capabilityOverrides.ts so
 * synthesized declared models render like their discovered neighbors.
 */
export function serverDisplayContext(server: Pick<ServerWithKey, "label">, serverCount: number): ServerDisplayContext {
	return {
		detail: serverCount > 1 ? server.label : "LiteLLM",
		namePrefix: serverCount > 1 ? `[${server.label}] ` : "",
		tooltip: serverCount > 1 ? `LiteLLM via ${server.label}` : "LiteLLM",
	};
}

export function buildModelInfos(
	models: LiteLLMModelItem[],
	server: ServerWithKey,
	serverCount: number,
	log: (message: string) => void
): RegistrationResult {
	const { detail, namePrefix, tooltip } = serverDisplayContext(server, serverCount);
	const common = {
		detail,
		...COMMON_MODEL_FIELDS,
	} as const;

	/** The registered entries for one model, switched on its discovery-decided shape. */
	function entriesForModel(m: LiteLLMModelItem): PreAttachModelInfo[] {
		const shape = m.shape;
		const rawModalities = m.architecture?.input_modalities;
		// The server reported modalities only when the array is present, which
		// is what the baseline keys its vision/audio presence on; the gates
		// below read the empty stand-in instead, so an unreported modality is
		// exactly a missing one and both flags stay strictly boolean.
		const modalities = Array.isArray(rawModalities) ? rawModalities : undefined;
		const reportedModalities = modalities ?? [];
		const vision = reportedModalities.includes("image");
		// LiteLLM capability data only (supports_audio_input via discovery, or a
		// server-declared architecture); VS Code has no audio capability flag,
		// so this rides the litellm metadata and gates message conversion.
		const audioInput = reportedModalities.includes("audio");
		// Costs join the baseline only at the shapes this registration prices
		// (the pricingFromCosts call sites below): the walk's server level must
		// never offer a price the picker refused to advertise.
		const baselineFor = (
			providers: readonly LiteLLMProvider[],
			toolCalling: boolean,
			reasoning: boolean,
			costs?: PerTokenCosts
		) => discoveredCapabilityBaseline({ providers, modalities, toolCalling, reasoning, costs });

		switch (shape.kind) {
			case "deployment": {
				const provider = shape.provider;
				const constraints = deriveTokenConstraints(provider);
				const exposedId = buildExposedModelId(m.id, server.id, serverCount);
				return [
					{
						...common,
						id: exposedId,
						name: `${namePrefix}${m.id}`,
						tooltip,
						family: familyFromProvider(provider),
						maxInputTokens: constraints.maxInputTokens,
						maxOutputTokens: constraints.maxOutputTokens,
						capabilities: {
							toolCalling: supportsTools(provider),
							imageInput: vision,
						},
						...pricingFromCosts(provider),
						...configurationSchemaFor([provider]),
						litellm: {
							supportsPromptCaching: provider.supports_prompt_caching === true,
							outputLimitSource: constraints.outputLimitSource,
							supportsAudioInput: audioInput,
							serverDeclared: baselineFor(
								[provider],
								supportsTools(provider),
								supportsReasoningEffort(provider),
								provider
							),
						},
					} satisfies PreAttachModelInfo,
				];
			}

			case "bare": {
				const constraints = deriveTokenConstraints(undefined);
				const exposedId = buildExposedModelId(m.id, server.id, serverCount);
				return [
					{
						...common,
						id: exposedId,
						name: `${namePrefix}${m.id}`,
						tooltip,
						family: "litellm",
						maxInputTokens: constraints.maxInputTokens,
						maxOutputTokens: constraints.maxOutputTokens,
						capabilities: {
							toolCalling: true,
							imageInput: vision,
						},
						litellm: {
							supportsPromptCaching: false,
							outputLimitSource: constraints.outputLimitSource,
							supportsAudioInput: audioInput,
							serverDeclared: baselineFor([], true, false),
						},
					} satisfies PreAttachModelInfo,
				];
			}

			case "group": {
				const providers = shape.providers;
				const [firstTool, ...restTools] = providers.filter(supportsTools);
				const toolProviders = firstTool === undefined ? [] : [firstTool, ...restTools];
				const entries: PreAttachModelInfo[] = [];

				if (firstTool !== undefined) {
					// The aggregates stand for whichever tool-capable provider the
					// proxy routes to, so they advertise the conservative collapse
					// (the same rule deployment merging applies): never more than the
					// strictest provider's standalone constraints.
					const constraints = collapseTokenConstraints([firstTool, ...restTools]);
					const aggregatePromptCaching = toolProviders.every((p) => p.supports_prompt_caching === true);
					const aggregateMetadata = {
						supportsPromptCaching: aggregatePromptCaching,
						outputLimitSource: constraints.outputLimitSource,
						supportsAudioInput: audioInput,
						serverDeclared: baselineFor(toolProviders, true, toolProviders.every(supportsReasoningEffort)),
					};
					const aggregateConfigurationSchema = configurationSchemaFor(toolProviders);
					const aggregateCapabilities = {
						toolCalling: true,
						imageInput: vision,
					};

					const cheapestRaw = `${m.id}:cheapest`;
					const fastestRaw = `${m.id}:fastest`;
					const cheapestId = buildExposedModelId(cheapestRaw, server.id, serverCount);
					const fastestId = buildExposedModelId(fastestRaw, server.id, serverCount);

					entries.push({
						...common,
						id: cheapestId,
						name: `${namePrefix}${m.id} (cheapest)`,
						tooltip: `LiteLLM via the cheapest provider${serverCount > 1 ? ` on ${server.label}` : ""}`,
						family: "litellm",
						maxInputTokens: constraints.maxInputTokens,
						maxOutputTokens: constraints.maxOutputTokens,
						capabilities: aggregateCapabilities,
						...aggregateConfigurationSchema,
						litellm: aggregateMetadata,
					} satisfies PreAttachModelInfo);

					entries.push({
						...common,
						id: fastestId,
						name: `${namePrefix}${m.id} (fastest)`,
						tooltip: `LiteLLM via the fastest provider${serverCount > 1 ? ` on ${server.label}` : ""}`,
						family: "litellm",
						maxInputTokens: constraints.maxInputTokens,
						maxOutputTokens: constraints.maxOutputTokens,
						capabilities: aggregateCapabilities,
						...aggregateConfigurationSchema,
						litellm: aggregateMetadata,
					} satisfies PreAttachModelInfo);
				}

				for (const p of toolProviders) {
					const constraints = deriveTokenConstraints(p);
					const rawId = `${m.id}:${p.provider}`;
					const exposedId = buildExposedModelId(rawId, server.id, serverCount);
					entries.push({
						...common,
						id: exposedId,
						name: `${namePrefix}${m.id} via ${p.provider}`,
						tooltip: `LiteLLM via ${p.provider}${serverCount > 1 ? ` on ${server.label}` : ""}`,
						family: familyFromProvider(p),
						maxInputTokens: constraints.maxInputTokens,
						maxOutputTokens: constraints.maxOutputTokens,
						capabilities: {
							toolCalling: true,
							imageInput: vision,
						},
						...pricingFromCosts(p),
						...configurationSchemaFor([p]),
						litellm: {
							supportsPromptCaching: p.supports_prompt_caching === true,
							outputLimitSource: constraints.outputLimitSource,
							supportsAudioInput: audioInput,
							serverDeclared: baselineFor([p], true, supportsReasoningEffort(p), p),
						},
					} satisfies PreAttachModelInfo);
				}

				if (firstTool === undefined) {
					const base = providers[0];
					// The untooled base entry stands for the whole provider group (the
					// proxy routes it to any of them), so its constraints collapse
					// across every provider, prompt caching and reasoning support need
					// every provider, and only its display identity (name, family)
					// follows the first.
					const constraints = collapseTokenConstraints(providers);
					const exposedId = buildExposedModelId(m.id, server.id, serverCount);
					entries.push({
						...common,
						id: exposedId,
						name: `${namePrefix}${m.id}`,
						tooltip,
						family: familyFromProvider(base),
						maxInputTokens: constraints.maxInputTokens,
						maxOutputTokens: constraints.maxOutputTokens,
						capabilities: {
							toolCalling: false,
							imageInput: vision,
						},
						...configurationSchemaFor(providers),
						litellm: {
							supportsPromptCaching: providers.every((p) => p.supports_prompt_caching === true),
							outputLimitSource: constraints.outputLimitSource,
							supportsAudioInput: audioInput,
							serverDeclared: baselineFor(providers, false, providers.every(supportsReasoningEffort)),
						},
					} satisfies PreAttachModelInfo);
				}

				return entries;
			}
		}
	}

	const infos: PreAttachModelInfo[] = models.flatMap((m) => {
		log(`Processing model: ${m.id} from server "${server.label}"`);
		return entriesForModel(m);
	});

	return { infos };
}
