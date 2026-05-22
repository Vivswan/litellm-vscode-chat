import { LanguageModelChatInformation } from "vscode";
import type { LiteLLMModelItem } from "../types";
import type { ServerWithKey } from "../extension/serverRegistry";
import type { ModelRoute } from "./request";
import { getTokenConstraints, buildExposedModelId } from "./request";
import { normalizeNonNegativeNumber } from "../shared/numbers";
import { createReasoningEffortConfigurationSchema, type ReasoningEffortPickerValue } from "./reasoningEffort";

type ModelPickerChatInformation = LanguageModelChatInformation & {
	readonly configurationSchema?: ReturnType<typeof createReasoningEffortConfigurationSchema>;
};

export interface RegistrationResult {
	infos: LanguageModelChatInformation[];
	routes: Map<string, ModelRoute>;
	promptCaching: Map<string, boolean>;
}

function withUserSelectableMetadata(info: LanguageModelChatInformation): LanguageModelChatInformation {
	const existingMetadata = (info as LanguageModelChatInformation & { metadata?: Record<string, unknown> }).metadata;

	return {
		...info,
		isUserSelectable: true,
		metadata: {
			...existingMetadata,
			isUserSelectable: true,
		},
	} as LanguageModelChatInformation;
}

export function buildModelInfos(
	models: LiteLLMModelItem[],
	server: ServerWithKey,
	serverCount: number,
	log: (message: string) => void
): RegistrationResult {
	const routes = new Map<string, ModelRoute>();
	const promptCaching = new Map<string, boolean>();

	const providerFamily = (modelId: string, providerName?: string): string => {
		// Only group by the model id prefix when the id actually contains a "/" segment
		// (e.g. "bedrock/anthropic.claude-3"). Otherwise everything without a prefix
		// is bucketed into the generic "litellm" family so models still group together.
		if (modelId.includes("/")) {
			const modelPrefix = modelId
				.split("/")
				.map((part) => part.trim())
				.filter((part) => part.length > 0)[0];
			if (modelPrefix) {
				return modelPrefix.toLowerCase();
			}
		}
		const providerPrefix = (providerName ?? "")
			.split("/")
			.map((part) => part.trim())
			.filter((part) => part.length > 0)[0];
		if (providerPrefix && providerPrefix.toLowerCase() !== "litellm") {
			return providerPrefix.toLowerCase();
		}
		return "litellm";
	};

	const formatCost = (cost: number | null | undefined): string | undefined => {
		if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
			return undefined;
		}
		return `$${(cost * 1_000_000).toFixed(2)}`;
	};

	const summarizeProvider = (provider: LiteLLMModelItem["providers"][number], fallback: string): string => {
		const parts: string[] = [];
		const inputCost = formatCost(normalizeNonNegativeNumber(provider.input_cost_per_token));
		const outputCost = formatCost(normalizeNonNegativeNumber(provider.output_cost_per_token));

		if (inputCost) {
			parts.push(`↑ ${inputCost}`);
		}
		if (outputCost) {
			parts.push(`↓ ${outputCost}`);
		}

		return parts.length > 0 ? parts.join(" · ") : fallback;
	};

	const reasoningSummary = (provider: LiteLLMModelItem["providers"][number]): string | undefined => {
		if (!provider.supports_reasoning) {
			return undefined;
		}
		const efforts: string[] = [];
		if (provider.supports_minimal_reasoning_effort) {
			efforts.push("minimal");
		}
		if (provider.supports_low_reasoning_effort) {
			efforts.push("low");
		}
		efforts.push("medium");
		efforts.push("high");
		if (provider.supports_xhigh_reasoning_effort) {
			efforts.push("xhigh");
		}
		if (provider.supports_max_reasoning_effort) {
			efforts.push("max");
		}
		const unique = Array.from(new Set(efforts));
		return unique.length > 0 ? `Thinking: ${unique.join(" | ")}` : "Thinking";
	};

	const reasoningEffortDefault = (
		provider: LiteLLMModelItem["providers"][number]
	): ReasoningEffortPickerValue | undefined => {
		if (!provider.supports_reasoning) {
			return undefined;
		}
		if (provider.supports_low_reasoning_effort) {
			return "low";
		}
		if (provider.supports_minimal_reasoning_effort) {
			return "minimal";
		}
		if (provider.supports_xhigh_reasoning_effort) {
			return "xhigh";
		}
		if (provider.supports_max_reasoning_effort) {
			return "max";
		}
		return "medium";
	};

	const reasoningSchemaFor = (
		provider: LiteLLMModelItem["providers"][number]
	): ReturnType<typeof createReasoningEffortConfigurationSchema> | undefined => {
		const supportedParams = (provider.supported_openai_params ?? []).map((param) => param.toLowerCase());
		if (!provider.supports_reasoning || !supportedParams.includes("reasoning_effort")) {
			return undefined;
		}
		const defaultValue = reasoningEffortDefault(provider) ?? "medium";
		return createReasoningEffortConfigurationSchema(defaultValue);
	};

	const displayName = (baseName: string, provider: LiteLLMModelItem["providers"][number], suffix?: string): string => {
		const summary = summarizeProvider(provider, "");
		const visibleSummary = summary ? ` (${summary})` : "";
		const visibleSuffix = suffix ? ` ${suffix}` : "";
		return `${baseName}${visibleSummary}${visibleSuffix}`;
	};

	const buildTooltip = (title: string, provider: LiteLLMModelItem["providers"][number], modelName: string): string => {
		const parts: string[] = [title];
		const summary = summarizeProvider(provider, "");
		if (summary) {
			parts.push(`Pricing (per 1M tokens): ${summary}`);
		}
		const thinking = reasoningSummary(provider);
		if (thinking) {
			parts.push(thinking);
		}
		const capabilities: string[] = [];
		if (provider.supports_tools !== false) {
			capabilities.push("tools");
		}
		if (provider.supports_response_schema) {
			capabilities.push("response schema");
		}
		if (provider.supports_reasoning) {
			capabilities.push("reasoning");
		}
		if (provider.supports_pdf_input) {
			capabilities.push("pdf input");
		}
		if (capabilities.length > 0) {
			parts.push(`Capabilities: ${capabilities.join(", ")}`);
		}
		parts.push(`Model: ${modelName}`);
		return parts.join("\n");
	};

	const registerRoute = (
		exposedId: string,
		rawId: string,
		supportedOpenAIParams?: Set<string>,
		provider?: LiteLLMModelItem["providers"][number]
	) => {
		routes.set(exposedId, {
			serverId: server.id,
			rawModelId: rawId,
			serverLabel: server.label,
			supportedOpenAIParams,
			inputCostPerToken: normalizeNonNegativeNumber(provider?.input_cost_per_token) ?? undefined,
			outputCostPerToken: normalizeNonNegativeNumber(provider?.output_cost_per_token) ?? undefined,
		});
	};

	const toSupportedParamsSet = (params: string[] | null | undefined): Set<string> | undefined => {
		if (!Array.isArray(params) || params.length === 0) {
			return undefined;
		}
		return new Set(
			params
				.filter((param): param is string => typeof param === "string" && param.length > 0)
				.map((param) => param.toLowerCase())
		);
	};

	const intersectSupportedParams = (providers: LiteLLMModelItem["providers"]): Set<string> | undefined => {
		const sets = providers
			.map((provider) => toSupportedParamsSet(provider.supported_openai_params))
			.filter((set): set is Set<string> => Boolean(set));
		if (sets.length === 0) {
			return undefined;
		}
		const [first, ...rest] = sets;
		const intersection = new Set(first);
		for (const set of rest) {
			for (const value of Array.from(intersection)) {
				if (!set.has(value)) {
					intersection.delete(value);
				}
			}
		}
		return intersection.size > 0 ? intersection : undefined;
	};

	const infos: ModelPickerChatInformation[] = models.flatMap((m) => {
		log(`Processing model: ${m.id} from server "${server.label}"`);
		const providers = m?.providers ?? [];
		const modalities = m.architecture?.input_modalities ?? [];
		const vision = Array.isArray(modalities) && modalities.includes("image");
		const detail = serverCount > 1 ? server.label : "LiteLLM";
		const namePrefix = serverCount > 1 ? `[${server.label}] ` : "";

		if (providers.length === 1 && providers[0].source === "model_info") {
			const constraints = getTokenConstraints(providers[0]);
			const exposedId = buildExposedModelId(m.id, server.id, serverCount);
			const supported = toSupportedParamsSet(providers[0].supported_openai_params);
			const thinking = reasoningSummary(providers[0]);
			const reasoningEffort = reasoningSchemaFor(providers[0]);
			promptCaching.set(exposedId, providers[0].supports_prompt_caching === true);
			registerRoute(exposedId, m.id, supported, providers[0]);
			return [
				{
					id: exposedId,
					name: displayName(`${namePrefix}${m.id}`, providers[0]),
					detail: [summarizeProvider(providers[0], detail), thinking].filter(Boolean).join(" · "),
					tooltip: buildTooltip(serverCount > 1 ? `LiteLLM via ${server.label}` : "LiteLLM", providers[0], m.id),
					family: providerFamily(m.id, providers[0].provider),
					version: "1.0.0",
					maxInputTokens: constraints.maxInputTokens,
					maxOutputTokens: constraints.maxOutputTokens,
					capabilities: {
						toolCalling: providers[0].supports_tools !== false,
						imageInput: vision,
					},
					...(reasoningEffort ? { configurationSchema: reasoningEffort } : {}),
				} satisfies ModelPickerChatInformation,
			];
		}

		if (providers.length === 0) {
			const constraints = getTokenConstraints(undefined);
			const exposedId = buildExposedModelId(m.id, server.id, serverCount);
			promptCaching.set(exposedId, false);
			registerRoute(exposedId, m.id);
			return [
				{
					id: exposedId,
					name: `${namePrefix}${m.id}`,
					detail,
					tooltip: serverCount > 1 ? `LiteLLM via ${server.label}` : "LiteLLM",
					family: providerFamily(m.id),
					version: "1.0.0",
					maxInputTokens: constraints.maxInputTokens,
					maxOutputTokens: constraints.maxOutputTokens,
					capabilities: {
						toolCalling: true,
						imageInput: vision,
					},
				} satisfies ModelPickerChatInformation,
			];
		}

		const toolProviders = providers.filter((p) => p.supports_tools !== false);
		const entries: ModelPickerChatInformation[] = [];

		if (toolProviders.length > 0) {
			const providerConstraints = toolProviders.map((p) => getTokenConstraints(p));
			const aggregateContextLen = Math.min(...providerConstraints.map((c) => c.contextLength));
			const maxOutput = Math.min(...providerConstraints.map((c) => c.maxOutputTokens));
			const maxInput = Math.max(1, aggregateContextLen - maxOutput);
			const aggregatePromptCaching = toolProviders.every((p) => p.supports_prompt_caching === true);
			const aggregateSupportedParams = intersectSupportedParams(toolProviders);
			const aggregateCapabilities = {
				toolCalling: true,
				imageInput: vision,
			};

			const cheapestRaw = `${m.id}:cheapest`;
			const fastestRaw = `${m.id}:fastest`;
			const cheapestId = buildExposedModelId(cheapestRaw, server.id, serverCount);
			const fastestId = buildExposedModelId(fastestRaw, server.id, serverCount);
			if (aggregateSupportedParams) {
				routes.set(cheapestId, {
					serverId: server.id,
					rawModelId: cheapestRaw,
					serverLabel: server.label,
					supportedOpenAIParams: aggregateSupportedParams,
				});
				routes.set(fastestId, {
					serverId: server.id,
					rawModelId: fastestRaw,
					serverLabel: server.label,
					supportedOpenAIParams: aggregateSupportedParams,
				});
			} else {
				registerRoute(cheapestId, cheapestRaw);
				registerRoute(fastestId, fastestRaw);
			}

			entries.push({
				id: cheapestId,
				name: displayName(`${namePrefix}${m.id}`, toolProviders[0], "(cheapest)"),
				detail: [summarizeProvider(toolProviders[0], detail), reasoningSummary(toolProviders[0]), "cheapest"]
					.filter(Boolean)
					.join(" · "),
				tooltip: `LiteLLM via the cheapest provider${serverCount > 1 ? ` on ${server.label}` : ""}\n${buildTooltip("Cheapest route", toolProviders[0], m.id)}`,
				family: providerFamily(m.id, toolProviders[0].provider),
				version: "1.0.0",
				maxInputTokens: maxInput,
				maxOutputTokens: maxOutput,
				capabilities: aggregateCapabilities,
			} satisfies ModelPickerChatInformation);
			promptCaching.set(cheapestId, aggregatePromptCaching);
			registerRoute(cheapestId, cheapestRaw, aggregateSupportedParams);

			entries.push({
				id: fastestId,
				name: displayName(`${namePrefix}${m.id}`, toolProviders[0], "(fastest)"),
				detail: [summarizeProvider(toolProviders[0], detail), reasoningSummary(toolProviders[0]), "fastest"]
					.filter(Boolean)
					.join(" · "),
				tooltip: `LiteLLM via the fastest provider${serverCount > 1 ? ` on ${server.label}` : ""}\n${buildTooltip("Fastest route", toolProviders[0], m.id)}`,
				family: providerFamily(m.id, toolProviders[0].provider),
				version: "1.0.0",
				maxInputTokens: maxInput,
				maxOutputTokens: maxOutput,
				capabilities: aggregateCapabilities,
			} satisfies ModelPickerChatInformation);
			promptCaching.set(fastestId, aggregatePromptCaching);
			registerRoute(fastestId, fastestRaw, aggregateSupportedParams);
		}

		for (const p of toolProviders) {
			const constraints = getTokenConstraints(p);
			const rawId = `${m.id}:${p.provider}`;
			const exposedId = buildExposedModelId(rawId, server.id, serverCount);
			const supported = toSupportedParamsSet(p.supported_openai_params);
			const reasoningEffort = reasoningSchemaFor(p);
			entries.push({
				id: exposedId,
				name: displayName(`${namePrefix}${m.id} via ${p.provider}`, p),
				detail: [summarizeProvider(p, detail), reasoningSummary(p)].filter(Boolean).join(" · "),
				tooltip: buildTooltip(`LiteLLM via ${p.provider}${serverCount > 1 ? ` on ${server.label}` : ""}`, p, m.id),
				family: providerFamily(m.id, p.provider),
				version: "1.0.0",
				maxInputTokens: constraints.maxInputTokens,
				maxOutputTokens: constraints.maxOutputTokens,
				capabilities: {
					toolCalling: true,
					imageInput: vision,
				},
				...(reasoningEffort ? { configurationSchema: reasoningEffort } : {}),
			} satisfies ModelPickerChatInformation);
			promptCaching.set(exposedId, p.supports_prompt_caching === true);
			registerRoute(exposedId, rawId, supported, p);
		}

		if (toolProviders.length === 0 && providers.length > 0) {
			const base = providers[0];
			const constraints = getTokenConstraints(base);
			const exposedId = buildExposedModelId(m.id, server.id, serverCount);
			const supported = toSupportedParamsSet(base.supported_openai_params);
			const reasoningEffort = reasoningSchemaFor(base);
			entries.push({
				id: exposedId,
				name: displayName(`${namePrefix}${m.id}`, base),
				detail: [summarizeProvider(base, detail), reasoningSummary(base)].filter(Boolean).join(" · "),
				tooltip: buildTooltip(serverCount > 1 ? `LiteLLM via ${server.label}` : "LiteLLM", base, m.id),
				family: providerFamily(m.id, base.provider),
				version: "1.0.0",
				maxInputTokens: constraints.maxInputTokens,
				maxOutputTokens: constraints.maxOutputTokens,
				capabilities: {
					toolCalling: false,
					imageInput: vision,
				},
				...(reasoningEffort ? { configurationSchema: reasoningEffort } : {}),
			} satisfies ModelPickerChatInformation);
			promptCaching.set(exposedId, base.supports_prompt_caching === true);
			registerRoute(exposedId, m.id, supported, base);
		}

		return entries;
	});

	return { infos: infos.map(withUserSelectableMetadata), routes, promptCaching };
}
