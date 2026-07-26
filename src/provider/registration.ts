import type { ServerWithKey } from "../shared/servers";
import type { TokenDefaults } from "../shared/settings";
import type { LiteLLMModelInfo } from "./groupModels";
import type { ModelRoute } from "./modelCatalog";
import { buildExposedModelId, deriveTokenConstraints } from "./modelCatalog";
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
					litellm: { supportsPromptCaching: soleProvider.supports_prompt_caching === true },
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
					litellm: { supportsPromptCaching: false },
				} satisfies LiteLLMModelInfo,
			];
		}

		const toolProviders = providers.filter((p) => p.supports_tools !== false);
		const entries: LiteLLMModelInfo[] = [];

		if (toolProviders.length > 0) {
			const providerConstraints = toolProviders.map((p) => deriveTokenConstraints(p, tokenDefaults));
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
				...common,
				id: cheapestId,
				name: `${namePrefix}${m.id} (cheapest)`,
				tooltip: `LiteLLM via the cheapest provider${serverCount > 1 ? ` on ${server.label}` : ""}`,
				family: "litellm",
				maxInputTokens: maxInput,
				maxOutputTokens: maxOutput,
				capabilities: aggregateCapabilities,
				litellm: { supportsPromptCaching: aggregatePromptCaching },
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
				litellm: { supportsPromptCaching: aggregatePromptCaching },
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
				litellm: { supportsPromptCaching: p.supports_prompt_caching === true },
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
				litellm: { supportsPromptCaching: base.supports_prompt_caching === true },
			} satisfies LiteLLMModelInfo);
			registerRoute(exposedId, m.id);
		}

		return entries;
	});

	return { infos, routes };
}
