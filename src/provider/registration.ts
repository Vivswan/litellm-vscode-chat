import type { LanguageModelChatInformation } from "vscode";
import { normalizeCostPerToken } from "../shared/numbers";
import type { ServerWithKey } from "../shared/servers";
import type { TokenDefaults } from "../shared/settings";
import type { PreAttachModelInfo } from "./groupModels";
import type { ModelRoute } from "./modelCatalog";
import { buildExposedModelId, collapseTokenConstraints, deriveTokenConstraints } from "./modelCatalog";
import { REASONING_EFFORT_SCHEMA, supportsReasoningEffort } from "./modelConfiguration";
import type { LiteLLMModelItem, LiteLLMProvider } from "./schemas";
import { supportsTools } from "./schemas";

export interface RegistrationResult {
	/** Pre-attach on purpose: registration output must never carry a group's credentials. */
	infos: PreAttachModelInfo[];
	routes: Map<string, ModelRoute>;
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
type ModelPricing = Pick<LanguageModelChatInformation, BasePricingKey | LongContextPricingKey | "priceCategory">;

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
 * default pricing. The `pricing` display-label string
 * stays unset everywhere: the host surfaces that render the numeric fields
 * treat the label as a fallback or show it in addition, so setting both would
 * duplicate the same information.
 */
function pricingFromProvider(provider: LiteLLMProvider): ModelPricing {
	// LiteLLM (observed on v1.93) stamps input/output_cost_per_token: 0 onto
	// /model/info entries that declare no pricing at all, so a zero pair is
	// "undeclared", not "free": rendering $0 would mislead the picker and any
	// cost-based choice. Models genuinely priced 0/0 (LiteLLM's price map does
	// this for local and self-hosted families like ollama/*) lose their $0
	// display under this rule; behind LiteLLM that shape is indistinguishable
	// from the stamp, and unknown-as-free is the worse failure.
	if (
		normalizeCostPerToken(provider.input_cost_per_token) === 0 &&
		normalizeCostPerToken(provider.output_cost_per_token) === 0
	) {
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
	set("inputCost", "longContextInputCost", provider.input_cost_per_token, provider.long_context_input_cost_per_token);
	set(
		"outputCost",
		"longContextOutputCost",
		provider.output_cost_per_token,
		provider.long_context_output_cost_per_token
	);
	set(
		"cacheCost",
		"longContextCacheCost",
		provider.cache_read_input_token_cost,
		provider.long_context_cache_read_input_token_cost
	);
	set(
		"cacheWriteCost",
		"longContextCacheWriteCost",
		provider.cache_creation_input_token_cost,
		provider.long_context_cache_creation_input_token_cost
	);
	// The relative-cost badge needs both sides of the price (one-sided pricing
	// is an incomplete signal) and derives from the base tier only: the
	// longContext* costs describe an opt-in regime, not the headline cost.
	if (fields.inputCost !== undefined && fields.outputCost !== undefined) {
		fields.priceCategory = priceCategoryFor(fields.inputCost, fields.outputCost);
	}
	return fields;
}

export function buildModelInfos(
	models: LiteLLMModelItem[],
	server: ServerWithKey,
	serverCount: number,
	log: (message: string) => void,
	/** The refresh pass's defaults snapshot; the same one discovery merged deployments with. */
	tokenDefaults: TokenDefaults
): RegistrationResult {
	const routes = new Map<string, ModelRoute>();

	const registerRoute = (exposedId: string, rawId: string) => {
		routes.set(exposedId, {
			serverId: server.id,
			rawModelId: rawId,
			serverLabel: server.label,
		});
	};

	const detail = serverCount > 1 ? server.label : "LiteLLM";
	const namePrefix = serverCount > 1 ? `[${server.label}] ` : "";
	/**
	 * Fields every registered model carries. isBYOK marks the model as served
	 * with user-supplied credentials; the host currently derives true for
	 * non-builtin providers, and the explicit flag pins the value against a
	 * future host default change. isUserSelectable must be an explicit true:
	 * the host's MCP sampling-model picker and local chat sessions use plain
	 * truthy checks, so an absent flag excluded these models there.
	 */
	const common = {
		detail,
		version: "1.0.0",
		isBYOK: true,
		isUserSelectable: true,
	} as const;

	/** The registered entries for one model, switched on its discovery-decided shape. */
	function entriesForModel(m: LiteLLMModelItem): PreAttachModelInfo[] {
		const shape = m.shape;
		const modalities = m.architecture?.input_modalities ?? [];
		const vision = Array.isArray(modalities) && modalities.includes("image");

		switch (shape.kind) {
			case "deployment": {
				const provider = shape.provider;
				const constraints = deriveTokenConstraints(provider, tokenDefaults);
				const exposedId = buildExposedModelId(m.id, server.id, serverCount);
				registerRoute(exposedId, m.id);
				return [
					{
						...common,
						id: exposedId,
						name: `${namePrefix}${m.id}`,
						tooltip: serverCount > 1 ? `LiteLLM via ${server.label}` : "LiteLLM",
						family: familyFromProvider(provider),
						maxInputTokens: constraints.maxInputTokens,
						maxOutputTokens: constraints.maxOutputTokens,
						capabilities: {
							toolCalling: supportsTools(provider),
							imageInput: vision,
						},
						...pricingFromProvider(provider),
						...configurationSchemaFor([provider]),
						litellm: {
							supportsPromptCaching: provider.supports_prompt_caching === true,
							outputLimitSource: constraints.outputLimitSource,
						},
					} satisfies PreAttachModelInfo,
				];
			}

			case "bare": {
				const constraints = deriveTokenConstraints(undefined, tokenDefaults);
				const exposedId = buildExposedModelId(m.id, server.id, serverCount);
				registerRoute(exposedId, m.id);
				return [
					{
						...common,
						id: exposedId,
						name: `${namePrefix}${m.id}`,
						tooltip: serverCount > 1 ? `LiteLLM via ${server.label}` : "LiteLLM",
						family: "litellm",
						maxInputTokens: constraints.maxInputTokens,
						maxOutputTokens: constraints.maxOutputTokens,
						capabilities: {
							toolCalling: true,
							imageInput: vision,
						},
						litellm: { supportsPromptCaching: false, outputLimitSource: constraints.outputLimitSource },
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
					const constraints = collapseTokenConstraints([firstTool, ...restTools], tokenDefaults);
					const aggregatePromptCaching = toolProviders.every((p) => p.supports_prompt_caching === true);
					const aggregateMetadata = {
						supportsPromptCaching: aggregatePromptCaching,
						outputLimitSource: constraints.outputLimitSource,
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
					registerRoute(cheapestId, cheapestRaw);

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
					registerRoute(fastestId, fastestRaw);
				}

				for (const p of toolProviders) {
					const constraints = deriveTokenConstraints(p, tokenDefaults);
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
						...pricingFromProvider(p),
						...configurationSchemaFor([p]),
						litellm: {
							supportsPromptCaching: p.supports_prompt_caching === true,
							outputLimitSource: constraints.outputLimitSource,
						},
					} satisfies PreAttachModelInfo);
					registerRoute(exposedId, rawId);
				}

				if (firstTool === undefined) {
					const base = providers[0];
					// The untooled base entry stands for the whole provider group (the
					// proxy routes it to any of them), so its constraints collapse
					// across every provider, prompt caching and reasoning support need
					// every provider, and only its display identity (name, family)
					// follows the first.
					const constraints = collapseTokenConstraints(providers, tokenDefaults);
					const exposedId = buildExposedModelId(m.id, server.id, serverCount);
					entries.push({
						...common,
						id: exposedId,
						name: `${namePrefix}${m.id}`,
						tooltip: serverCount > 1 ? `LiteLLM via ${server.label}` : "LiteLLM",
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
						},
					} satisfies PreAttachModelInfo);
					registerRoute(exposedId, m.id);
				}

				return entries;
			}
		}
	}

	const infos: PreAttachModelInfo[] = models.flatMap((m) => {
		log(`Processing model: ${m.id} from server "${server.label}"`);
		return entriesForModel(m);
	});

	return { infos, routes };
}
