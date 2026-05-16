import { LanguageModelChatInformation } from "vscode";
import type { LiteLLMModelItem } from "../types";
import type { ServerWithKey } from "../extension/serverRegistry";
import type { ModelRoute } from "./request";
import { getTokenConstraints, buildExposedModelId } from "./request";

export interface RegistrationResult {
	infos: LanguageModelChatInformation[];
	routes: Map<string, ModelRoute>;
	promptCaching: Map<string, boolean>;
}

function withUserSelectableMetadata(info: LanguageModelChatInformation): LanguageModelChatInformation {
	return {
		...info,
		metadata: {
			...info.metadata,
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

	const registerRoute = (exposedId: string, rawId: string) => {
		routes.set(exposedId, {
			serverId: server.id,
			rawModelId: rawId,
			serverLabel: server.label,
		});
	};

	const infos: LanguageModelChatInformation[] = models.flatMap((m) => {
		log(`Processing model: ${m.id} from server "${server.label}"`);
		const providers = m?.providers ?? [];
		const modalities = m.architecture?.input_modalities ?? [];
		const vision = Array.isArray(modalities) && modalities.includes("image");
		const detail = serverCount > 1 ? server.label : "LiteLLM";
		const namePrefix = serverCount > 1 ? `[${server.label}] ` : "";

		if (providers.length === 1 && providers[0].source === "model_info") {
			const constraints = getTokenConstraints(providers[0]);
			const exposedId = buildExposedModelId(m.id, server.id, serverCount);
			promptCaching.set(exposedId, providers[0].supports_prompt_caching === true);
			registerRoute(exposedId, m.id);
			return [
				{
					id: exposedId,
					name: `${namePrefix}${m.id}`,
					detail,
					tooltip: serverCount > 1 ? `LiteLLM via ${server.label}` : "LiteLLM",
					family: "litellm",
					version: "1.0.0",
					maxInputTokens: constraints.maxInputTokens,
					maxOutputTokens: constraints.maxOutputTokens,
					capabilities: {
						toolCalling: providers[0].supports_tools !== false,
						imageInput: vision,
					},
				} satisfies LanguageModelChatInformation,
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
					family: "litellm",
					version: "1.0.0",
					maxInputTokens: constraints.maxInputTokens,
					maxOutputTokens: constraints.maxOutputTokens,
					capabilities: {
						toolCalling: true,
						imageInput: vision,
					},
				} satisfies LanguageModelChatInformation,
			];
		}

		const toolProviders = providers.filter((p) => p.supports_tools !== false);
		const entries: LanguageModelChatInformation[] = [];

		if (toolProviders.length > 0) {
			const providerConstraints = toolProviders.map((p) => getTokenConstraints(p));
			const aggregateContextLen = Math.min(...providerConstraints.map((c) => c.contextLength));
			const maxOutput = Math.min(...providerConstraints.map((c) => c.maxOutputTokens));
			const maxInput = Math.max(1, aggregateContextLen - maxOutput);
			const aggregatePromptCaching = toolProviders.every((p) => p.supports_prompt_caching === true);
			const aggregateCapabilities = {
				toolCalling: true,
				imageInput: vision,
			};

			const cheapestRaw = `${m.id}:cheapest`;
			const fastestRaw = `${m.id}:fastest`;
			const cheapestId = buildExposedModelId(cheapestRaw, server.id, serverCount);
			const fastestId = buildExposedModelId(fastestRaw, server.id, serverCount);

			entries.push({
				id: cheapestId,
				name: `${namePrefix}${m.id} (cheapest)`,
				detail,
				tooltip: `LiteLLM via the cheapest provider${serverCount > 1 ? ` on ${server.label}` : ""}`,
				family: "litellm",
				version: "1.0.0",
				maxInputTokens: maxInput,
				maxOutputTokens: maxOutput,
				capabilities: aggregateCapabilities,
			} satisfies LanguageModelChatInformation);
			promptCaching.set(cheapestId, aggregatePromptCaching);
			registerRoute(cheapestId, cheapestRaw);

			entries.push({
				id: fastestId,
				name: `${namePrefix}${m.id} (fastest)`,
				detail,
				tooltip: `LiteLLM via the fastest provider${serverCount > 1 ? ` on ${server.label}` : ""}`,
				family: "litellm",
				version: "1.0.0",
				maxInputTokens: maxInput,
				maxOutputTokens: maxOutput,
				capabilities: aggregateCapabilities,
			} satisfies LanguageModelChatInformation);
			promptCaching.set(fastestId, aggregatePromptCaching);
			registerRoute(fastestId, fastestRaw);
		}

		for (const p of toolProviders) {
			const constraints = getTokenConstraints(p);
			const rawId = `${m.id}:${p.provider}`;
			const exposedId = buildExposedModelId(rawId, server.id, serverCount);
			entries.push({
				id: exposedId,
				name: `${namePrefix}${m.id} via ${p.provider}`,
				detail,
				tooltip: `LiteLLM via ${p.provider}${serverCount > 1 ? ` on ${server.label}` : ""}`,
				family: "litellm",
				version: "1.0.0",
				maxInputTokens: constraints.maxInputTokens,
				maxOutputTokens: constraints.maxOutputTokens,
				capabilities: {
					toolCalling: true,
					imageInput: vision,
				},
			} satisfies LanguageModelChatInformation);
			promptCaching.set(exposedId, p.supports_prompt_caching === true);
			registerRoute(exposedId, rawId);
		}

		if (toolProviders.length === 0 && providers.length > 0) {
			const base = providers[0];
			const constraints = getTokenConstraints(base);
			const exposedId = buildExposedModelId(m.id, server.id, serverCount);
			entries.push({
				id: exposedId,
				name: `${namePrefix}${m.id}`,
				detail,
				tooltip: serverCount > 1 ? `LiteLLM via ${server.label}` : "LiteLLM",
				family: "litellm",
				version: "1.0.0",
				maxInputTokens: constraints.maxInputTokens,
				maxOutputTokens: constraints.maxOutputTokens,
				capabilities: {
					toolCalling: false,
					imageInput: vision,
				},
			} satisfies LanguageModelChatInformation);
			promptCaching.set(exposedId, base.supports_prompt_caching === true);
			registerRoute(exposedId, m.id);
		}

		return entries;
	});

	return { infos: infos.map(withUserSelectableMetadata), routes, promptCaching };
}
