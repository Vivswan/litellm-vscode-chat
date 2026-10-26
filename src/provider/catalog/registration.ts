import type { LanguageModelChatInformation } from "vscode";
import { getCurrencySymbol } from "../../shared/config/settings";
import type { ServerWithKey } from "../../shared/servers";
import { normalizeCostPerToken } from "../../shared/util/numbers";
import type { DiscoveryLog } from "./discoveryLog";
import type { PreAttachModelInfo } from "./groupModels";
import {
	buildExposedModelId,
	collapseTokenLimits,
	deriveTokenConstraints,
	discoveredCapabilityBaseline,
	replaysReasoningContent,
	reportedReasoningLevels,
} from "./modelCatalog";
import { DEFAULT_REASONING_EFFORT_LEVELS, reasoningEffortSchema, supportsReasoningEffort } from "./modelConfiguration";
import type { LiteLLMModelItem, LiteLLMProvider, PerTokenCosts, TokenConstraints } from "./schemas";
import { supportsTools } from "./schemas";

export interface RegistrationResult {
	/** Pre-attach on purpose: registration output must never carry a group's credentials. */
	infos: PreAttachModelInfo[];
}

/**
 * Real provider names (LiteLLM's litellm_provider, or a providers-array entry's name) make
 * `vscode.lm.selectChatModels({ family })` useful to other extensions.
 */
function familyFromProvider(provider: LiteLLMProvider): string {
	return provider.provider.length > 0 ? provider.provider : "litellm";
}

/** VS Code's pricing unit is cost per million tokens; LiteLLM reports cost per token. */
const TOKENS_PER_MILLION = 1_000_000;

/** Per-token costs are tiny binary fractions, so the bare multiplication yields noise. */
const COST_DECIMALS = 1_000_000;

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
 * The blend weights input over output 3:1, a typical input-heavy chat workload. Only these four literals ever go out:
 * the host renders any other string through a capitalized "<Foo> cost" fallback.
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
 * Capability data decides whether the control exists: entries whose every backing provider advertises reasoning
 * support get the schema.
 *   a merged deployment group whose intersection already demoted the flag -> stays without it
 *   Bare /v1/models entries                                                -> have no provider data and never
 *                                                                             advertise it
 */
function configurationSchemaFor(
	providers: readonly LiteLLMProvider[],
	reasoningEfforts: LiteLLMModelItem["reasoningEfforts"]
): Pick<LanguageModelChatInformation, "configurationSchema"> {
	if (providers.length === 0 || !providers.every(supportsReasoningEffort)) {
		return {};
	}
	// The proxy's own menu outranks what the providers' flags resolved to; its null is "unknown", the built-in list.
	const levels = reasoningEfforts === undefined ? reportedReasoningLevels(providers) : (reasoningEfforts ?? undefined);
	return { configurationSchema: reasoningEffortSchema(levels ?? DEFAULT_REASONING_EFFORT_LEVELS) };
}

/**
 * Registration prices only entries whose route pins the serving deployment's COST; for the cheapest/fastest
 * aggregates and the untooled base entry the proxy's routing decides what a request costs, so only a user
 * cost record can put a number on them.
 *
 *   long-context tier -> rides only beside its base field (alone it would face an empty Default cell) and
 *                        is omitted when equal to it, since the host shows tiers only when they differ
 *   `pricing` label   -> the hover's numeric cost table is entitlement-gated, so for a typical LiteLLM user
 *                        this label is the only cost line the hover can show
 */
export function pricingFromCosts(costs: Readonly<PerTokenCosts>, currencySymbol: string): ModelPricing {
	// The raw zero pair, before the per-million rounding: pairs that merely ROUND to 0/0 must not borrow its
	// genuinely-free display (see the badge gate below).
	const zeroPair =
		normalizeCostPerToken(costs.input_cost_per_token) === 0 && normalizeCostPerToken(costs.output_cost_per_token) === 0;
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
	// The relative-cost badge and the display label need both sides of the price (one-sided pricing is an
	// incomplete signal) and derive from the base tier only: the longContext* costs describe an opt-in regime, not the
	// headline cost.
	//   on sub-unit dust, "$0 in / $0 out" plus a "low" badge would present it as free -> A pair that BOTH rounded to 0
	//                                                                                      gets neither label nor badge
	// The `zeroPair` disjunct is what keeps a RAW zero pair - which can only be user-written "this model is genuinely
	// free" (the server's stamp died at ingest) - carrying both on purpose; deleting it would strip the free label
	// exactly from the models priced free deliberately.
	if (
		fields.inputCost !== undefined &&
		fields.outputCost !== undefined &&
		(fields.inputCost > 0 || fields.outputCost > 0 || zeroPair)
	) {
		fields.priceCategory = priceCategoryFor(fields.inputCost, fields.outputCost);
		// The label takes the configured usage.currencySymbol verbatim (display only, never a conversion), like every
		// other cost surface.
		fields.pricing = `${currencySymbol}${fields.inputCost} in / ${currencySymbol}${fields.outputCost} out per 1M tokens`;
	}
	return fields;
}

/** Shared with capabilityOverrides.ts: its synthesized declared models carry the same registration-wide fields. */
export const COMMON_MODEL_FIELDS = {
	version: "1.0.0",
	// Served with user-supplied credentials; the explicit flag pins the value against a future host default change.
	isBYOK: true,
	// Must be an explicit true.
	isUserSelectable: true,
} as const;

/**
 * The display fields every model of one server shares. With several servers the label prefixes the name and fills
 * the detail and the tooltip; with one server the prefix is empty and the other two read "LiteLLM". `tooltip` is the
 * base one (deployment and bare entries); group-shape entries compose their own.
 */
export interface ServerDisplayContext {
	readonly detail: string;

	readonly namePrefix: string;

	readonly tooltip: string;
}

/** Shared with capabilityOverrides.ts, so synthesized declared models render like their discovered neighbors. */
export function serverDisplayContext(server: Pick<ServerWithKey, "label">, serverCount: number): ServerDisplayContext {
	return {
		detail: serverCount > 1 ? server.label : "LiteLLM",
		namePrefix: serverCount > 1 ? `[${server.label}] ` : "",
		tooltip: serverCount > 1 ? `LiteLLM via ${server.label}` : "LiteLLM",
	};
}

/** What every entry of one build shares: the server, its display fields, and the fields common to every model. */
interface BuildContext {
	readonly server: ServerWithKey;
	readonly serverCount: number;
	readonly common: Readonly<{ detail: string } & typeof COMMON_MODEL_FIELDS>;
	readonly namePrefix: string;
	readonly tooltip: string;
	readonly currencySymbol: string;
}

/**
 * What every entry of one listed model is built from. The server reported modalities only when the array is present,
 * which is what the baseline keys its vision/audio presence on; the gates read the empty stand-in, so an unreported
 * modality is exactly a missing one and both flags stay strictly boolean. `audioInput` is LiteLLM capability data
 * only: VS Code has no audio capability flag, so it rides the litellm metadata and gates message conversion.
 */
interface ModelEntryContext extends BuildContext {
	readonly model: LiteLLMModelItem;
	readonly modalities: readonly string[] | undefined;
	readonly vision: boolean;
	readonly audioInput: boolean;
}

/** The providers of a group shape, or the tool-capable ones among them: never empty. */
type ProviderSet = readonly [LiteLLMProvider, ...LiteLLMProvider[]];

function modelEntryContext(model: LiteLLMModelItem, build: BuildContext): ModelEntryContext {
	const rawModalities = model.architecture?.input_modalities;
	const modalities = Array.isArray(rawModalities) ? rawModalities : undefined;
	const reportedModalities = modalities ?? [];
	return {
		...build,
		model,
		modalities,
		vision: reportedModalities.includes("image"),
		audioInput: reportedModalities.includes("audio"),
	};
}

/**
 * Costs join the baseline only at the shapes this registration prices: the walk's server level must never offer a
 * price the picker refused to advertise.
 */
function baselineFor(
	ctx: ModelEntryContext,
	input: Omit<Parameters<typeof discoveredCapabilityBaseline>[0], "modalities" | "reasoningEfforts">
): ReturnType<typeof discoveredCapabilityBaseline> {
	return discoveredCapabilityBaseline({
		...input,
		modalities: ctx.modalities,
		reasoningEfforts: ctx.model.reasoningEfforts,
	});
}

/** A single deployment: the proxy's one route for this model id, priced from its own costs. */
function deploymentEntry(
	ctx: ModelEntryContext,
	provider: LiteLLMProvider,
	constraints: TokenConstraints
): PreAttachModelInfo {
	const { model: m, server, serverCount, common, namePrefix, tooltip, currencySymbol, vision, audioInput } = ctx;
	return {
		...common,
		id: buildExposedModelId(m.id, server.id, serverCount),
		name: `${namePrefix}${m.id}`,
		tooltip,
		family: familyFromProvider(provider),
		maxInputTokens: constraints.maxInputTokens,
		maxOutputTokens: constraints.maxOutputTokens,
		capabilities: {
			toolCalling: supportsTools(provider),
			imageInput: vision,
		},
		...pricingFromCosts(provider, currencySymbol),
		...configurationSchemaFor([provider], m.reasoningEfforts),
		litellm: {
			rawModelId: m.id,
			supportsPromptCaching: provider.supports_prompt_caching === true,
			defaultMaxTokens: constraints.defaultMaxTokens,
			supportsAudioInput: audioInput,
			replayReasoningContent: replaysReasoningContent([provider]),
			serverDeclared: baselineFor(ctx, {
				providers: [provider],
				limits: constraints,
				toolCalling: supportsTools(provider),
				reasoning: supportsReasoningEffort(provider),
				costs: provider,
			}),
		},
	} satisfies PreAttachModelInfo;
}

/** A bare /v1/models entry: no provider data, so tool calling is assumed and nothing is priced. */
function bareEntry(ctx: ModelEntryContext): PreAttachModelInfo {
	const { model: m, server, serverCount, common, namePrefix, tooltip, vision, audioInput } = ctx;
	const constraints = deriveTokenConstraints(undefined);
	return {
		...common,
		id: buildExposedModelId(m.id, server.id, serverCount),
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
			rawModelId: m.id,
			supportsPromptCaching: false,
			defaultMaxTokens: constraints.defaultMaxTokens,
			supportsAudioInput: audioInput,
			replayReasoningContent: false,
			serverDeclared: baselineFor(ctx, { providers: [], limits: constraints, toolCalling: true, reasoning: false }),
		},
	} satisfies PreAttachModelInfo;
}

/**
 * The cheapest and fastest aggregates stand for whichever tool-capable provider the proxy routes to, so they
 * advertise the conservative collapse (the same rule deployment merging applies): never more than the strictest
 * provider's standalone constraints.
 */
function aggregateEntries(ctx: ModelEntryContext, toolProviders: ProviderSet): PreAttachModelInfo[] {
	const { model: m, server, serverCount, common, namePrefix, vision, audioInput } = ctx;
	const [firstTool, ...restTools] = toolProviders;
	const constraints = collapseTokenLimits([
		deriveTokenConstraints(firstTool),
		...restTools.map(deriveTokenConstraints),
	]);
	const aggregatePromptCaching = toolProviders.every((p) => p.supports_prompt_caching === true);
	const aggregateMetadata = {
		supportsPromptCaching: aggregatePromptCaching,
		defaultMaxTokens: constraints.defaultMaxTokens,
		supportsAudioInput: audioInput,
		replayReasoningContent: replaysReasoningContent(toolProviders),
		serverDeclared: baselineFor(ctx, {
			providers: toolProviders,
			limits: constraints,
			toolCalling: true,
			reasoning: toolProviders.every(supportsReasoningEffort),
		}),
	};
	const aggregateConfigurationSchema = configurationSchemaFor(toolProviders, m.reasoningEfforts);
	const aggregateCapabilities = {
		toolCalling: true,
		imageInput: vision,
	};
	const onServer = serverCount > 1 ? ` on ${server.label}` : "";
	const aggregate = (variant: "cheapest" | "fastest"): PreAttachModelInfo => {
		const rawId = `${m.id}:${variant}`;
		return {
			...common,
			id: buildExposedModelId(rawId, server.id, serverCount),
			name: `${namePrefix}${m.id} (${variant})`,
			tooltip: `LiteLLM via the ${variant} provider${onServer}`,
			family: "litellm",
			maxInputTokens: constraints.maxInputTokens,
			maxOutputTokens: constraints.maxOutputTokens,
			capabilities: aggregateCapabilities,
			...aggregateConfigurationSchema,
			litellm: { rawModelId: rawId, ...aggregateMetadata },
		} satisfies PreAttachModelInfo;
	};
	return [aggregate("cheapest"), aggregate("fastest")];
}

/** One tool-capable provider of a group, routed to by name and priced from its own costs. */
function providerEntry(ctx: ModelEntryContext, p: LiteLLMProvider): PreAttachModelInfo {
	const { model: m, server, serverCount, common, namePrefix, currencySymbol, vision, audioInput } = ctx;
	const constraints = deriveTokenConstraints(p);
	const rawId = `${m.id}:${p.provider}`;
	return {
		...common,
		id: buildExposedModelId(rawId, server.id, serverCount),
		name: `${namePrefix}${m.id} via ${p.provider}`,
		tooltip: `LiteLLM via ${p.provider}${serverCount > 1 ? ` on ${server.label}` : ""}`,
		family: familyFromProvider(p),
		maxInputTokens: constraints.maxInputTokens,
		maxOutputTokens: constraints.maxOutputTokens,
		capabilities: {
			toolCalling: true,
			imageInput: vision,
		},
		...pricingFromCosts(p, currencySymbol),
		...configurationSchemaFor([p], m.reasoningEfforts),
		litellm: {
			rawModelId: rawId,
			supportsPromptCaching: p.supports_prompt_caching === true,
			defaultMaxTokens: constraints.defaultMaxTokens,
			supportsAudioInput: audioInput,
			replayReasoningContent: replaysReasoningContent([p]),
			serverDeclared: baselineFor(ctx, {
				providers: [p],
				limits: constraints,
				toolCalling: true,
				reasoning: supportsReasoningEffort(p),
				costs: p,
			}),
		},
	} satisfies PreAttachModelInfo;
}

/**
 * The untooled base entry stands for the whole provider group (the proxy routes it to any of them), so its
 * constraints collapse across every provider, and prompt caching and reasoning support need every provider.
 */
function untooledBaseEntry(ctx: ModelEntryContext, providers: ProviderSet): PreAttachModelInfo {
	const { model: m, server, serverCount, common, namePrefix, tooltip, vision, audioInput } = ctx;
	const [firstProvider, ...restProviders] = providers;
	const constraints = collapseTokenLimits([
		deriveTokenConstraints(firstProvider),
		...restProviders.map(deriveTokenConstraints),
	]);
	return {
		...common,
		id: buildExposedModelId(m.id, server.id, serverCount),
		name: `${namePrefix}${m.id}`,
		tooltip,
		family: familyFromProvider(firstProvider),
		maxInputTokens: constraints.maxInputTokens,
		maxOutputTokens: constraints.maxOutputTokens,
		capabilities: {
			toolCalling: false,
			imageInput: vision,
		},
		...configurationSchemaFor(providers, m.reasoningEfforts),
		litellm: {
			rawModelId: m.id,
			supportsPromptCaching: providers.every((p) => p.supports_prompt_caching === true),
			defaultMaxTokens: constraints.defaultMaxTokens,
			supportsAudioInput: audioInput,
			replayReasoningContent: replaysReasoningContent(providers),
			serverDeclared: baselineFor(ctx, {
				providers,
				limits: constraints,
				toolCalling: false,
				reasoning: providers.every(supportsReasoningEffort),
			}),
		},
	} satisfies PreAttachModelInfo;
}

/**
 * A group model fans out: with tool-capable providers the cheapest and fastest aggregates then one entry per such
 * provider, without any the one untooled base entry.
 */
function groupEntries(ctx: ModelEntryContext, providers: ProviderSet): PreAttachModelInfo[] {
	const [firstTool, ...restTools] = providers.filter(supportsTools);
	if (firstTool === undefined) {
		return [untooledBaseEntry(ctx, providers)];
	}
	const toolProviders: ProviderSet = [firstTool, ...restTools];
	return [...aggregateEntries(ctx, toolProviders), ...toolProviders.map((p) => providerEntry(ctx, p))];
}

function entriesForModel(ctx: ModelEntryContext): PreAttachModelInfo[] {
	const shape = ctx.model.shape;
	switch (shape.kind) {
		case "deployment":
			return [deploymentEntry(ctx, shape.provider, shape.limits)];
		case "bare":
			return [bareEntry(ctx)];
		case "group":
			return groupEntries(ctx, shape.providers);
	}
}

export function buildModelInfos(
	models: LiteLLMModelItem[],
	server: ServerWithKey,
	serverCount: number,
	log: DiscoveryLog
): RegistrationResult {
	const { detail, namePrefix, tooltip } = serverDisplayContext(server, serverCount);
	// Read once per build, not per model: every pricing label in one pass carries the same symbol. A change between
	// passes heals at attach time.
	const currencySymbol = getCurrencySymbol();
	const build: BuildContext = {
		server,
		serverCount,
		common: { detail, ...COMMON_MODEL_FIELDS },
		namePrefix,
		tooltip,
		currencySymbol,
	};

	// One line per build, with the shape split: a group model with tool-capable providers fans out into cheapest,
	// fastest, and per-provider entries, which is what a user counting picker entries against the listing needs explained.
	const shapeCounts: Record<LiteLLMModelItem["shape"]["kind"], number> = { deployment: 0, bare: 0, group: 0 };
	const infos: PreAttachModelInfo[] = models.flatMap((m) => {
		shapeCounts[m.shape.kind] += 1;
		return entriesForModel(modelEntryContext(m, build));
	});
	log("Registered models", {
		modelCount: models.length,
		entryCount: infos.length,
		deploymentModels: shapeCounts.deployment,
		bareModels: shapeCounts.bare,
		groupModels: shapeCounts.group,
	});

	return { infos };
}
