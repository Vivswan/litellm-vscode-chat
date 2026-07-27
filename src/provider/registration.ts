import type { LanguageModelChatInformation } from "vscode";
import { normalizeCostPerToken } from "../shared/numbers";
import type { ServerWithKey } from "../shared/servers";
import type { TokenDefaults } from "../shared/settings";
import type { LiteLLMModelInfo } from "./groupModels";
import type { ModelRoute } from "./modelCatalog";
import { buildExposedModelId, combinedOutputLimitSource, deriveTokenConstraints } from "./modelCatalog";
import { REASONING_EFFORT_SCHEMA, supportsReasoningEffort } from "./modelConfiguration";
import type { LiteLLMModelItem, LiteLLMProvider } from "./schemas";

export interface RegistrationResult {
	infos: LiteLLMModelInfo[];
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
type ModelPricing = Pick<LanguageModelChatInformation, BasePricingKey | LongContextPricingKey>;

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
 * actually costs. Providers-array entries are lenient pass-throughs, so every
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

	const infos: LiteLLMModelInfo[] = models.flatMap((m) => {
		log(`Processing model: ${m.id} from server "${server.label}"`);
		const providers = m.providers;
		const modalities = m.architecture?.input_modalities ?? [];
		const vision = Array.isArray(modalities) && modalities.includes("image");

		const soleProvider = providers.length === 1 ? providers[0] : undefined;
		if (soleProvider !== undefined && soleProvider.source === "model_info") {
			const constraints = deriveTokenConstraints(soleProvider, tokenDefaults);
			const exposedId = buildExposedModelId(m.id, server.id, serverCount);
			registerRoute(exposedId, m.id);
			return [
				{
					...common,
					id: exposedId,
					name: `${namePrefix}${m.id}`,
					tooltip: serverCount > 1 ? `LiteLLM via ${server.label}` : "LiteLLM",
					family: familyFromProvider(soleProvider),
					maxInputTokens: constraints.maxInputTokens,
					maxOutputTokens: constraints.maxOutputTokens,
					capabilities: {
						toolCalling: soleProvider.supports_tools !== false,
						imageInput: vision,
					},
					...pricingFromProvider(soleProvider),
					...configurationSchemaFor([soleProvider]),
					litellm: {
						supportsPromptCaching: soleProvider.supports_prompt_caching === true,
						outputLimitSource: constraints.outputLimitSource,
					},
				} satisfies LiteLLMModelInfo,
			];
		}

		if (providers.length === 0) {
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
				} satisfies LiteLLMModelInfo,
			];
		}

		const toolProviders = providers.filter((p) => p.supports_tools !== false);
		const entries: LiteLLMModelInfo[] = [];

		if (toolProviders.length > 0) {
			const providerConstraints = toolProviders.map((p) => deriveTokenConstraints(p, tokenDefaults));
			const aggregateContextLen = Math.min(...providerConstraints.map((c) => c.contextLength));
			const maxOutput = Math.min(...providerConstraints.map((c) => c.maxOutputTokens));
			const outputLimitSource = combinedOutputLimitSource(providerConstraints);
			const maxInput = Math.max(1, aggregateContextLen - maxOutput);
			const aggregatePromptCaching = toolProviders.every((p) => p.supports_prompt_caching === true);
			const aggregateMetadata = { supportsPromptCaching: aggregatePromptCaching, outputLimitSource };
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
				maxInputTokens: maxInput,
				maxOutputTokens: maxOutput,
				capabilities: aggregateCapabilities,
				...aggregateConfigurationSchema,
				litellm: aggregateMetadata,
			} satisfies LiteLLMModelInfo);
			registerRoute(cheapestId, cheapestRaw);

			entries.push({
				...common,
				id: fastestId,
				name: `${namePrefix}${m.id} (fastest)`,
				tooltip: `LiteLLM via the fastest provider${serverCount > 1 ? ` on ${server.label}` : ""}`,
				family: "litellm",
				maxInputTokens: maxInput,
				maxOutputTokens: maxOutput,
				capabilities: aggregateCapabilities,
				...aggregateConfigurationSchema,
				litellm: aggregateMetadata,
			} satisfies LiteLLMModelInfo);
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
			} satisfies LiteLLMModelInfo);
			registerRoute(exposedId, rawId);
		}

		const base = providers[0];
		if (toolProviders.length === 0 && base !== undefined) {
			const constraints = deriveTokenConstraints(base, tokenDefaults);
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
				// The untooled base entry stands for the whole provider group (the
				// proxy routes it to any of them), so like the aggregates it needs
				// every backing provider to support reasoning, not just the first.
				...configurationSchemaFor(providers),
				litellm: {
					supportsPromptCaching: base.supports_prompt_caching === true,
					outputLimitSource: constraints.outputLimitSource,
				},
			} satisfies LiteLLMModelInfo);
			registerRoute(exposedId, m.id);
		}

		return entries;
	});

	return { infos, routes };
}
