import type { ServerWithKey } from "../shared/servers";
import type { TokenDefaults } from "../shared/settings";
import type { LiteLLMModelInfo } from "./groupModels";
import type { ModelRoute } from "./modelCatalog";
import { buildExposedModelId, deriveTokenConstraints } from "./modelCatalog";
import type { LiteLLMModelItem } from "./schemas";

export interface RegistrationResult {
	infos: LiteLLMModelInfo[];
	routes: Map<string, ModelRoute>;
}

/**
 * LiteLLMModelInfo extended with the user-selectable flag in both places VS
 * Code has looked for it across chatProvider API proposal versions.
 */
interface UserSelectableModelInfo extends LiteLLMModelInfo {
	/** Read at the top level by VS Code 1.120+ (current chatProvider proposal); required for the chat model picker. */
	readonly isUserSelectable: boolean;
	/** Read from metadata by older VS Code builds (pre-1.120 chatProvider proposal); kept for backward compatibility. */
	readonly metadata: Record<string, unknown>;
}

function withUserSelectableMetadata(info: LiteLLMModelInfo): UserSelectableModelInfo {
	const existingMetadata = (info as LiteLLMModelInfo & { metadata?: Record<string, unknown> }).metadata;

	return {
		...info,
		isUserSelectable: true,
		metadata: {
			...existingMetadata,
			isUserSelectable: true,
		},
	};
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

	const infos: LiteLLMModelInfo[] = models.flatMap((m) => {
		log(`Processing model: ${m.id} from server "${server.label}"`);
		const providers = m.providers;
		const modalities = m.architecture?.input_modalities ?? [];
		const vision = Array.isArray(modalities) && modalities.includes("image");
		const detail = serverCount > 1 ? server.label : "LiteLLM";
		const namePrefix = serverCount > 1 ? `[${server.label}] ` : "";

		const soleProvider = providers.length === 1 ? providers[0] : undefined;
		if (soleProvider !== undefined && soleProvider.source === "model_info") {
			const constraints = deriveTokenConstraints(soleProvider, tokenDefaults);
			const exposedId = buildExposedModelId(m.id, server.id, serverCount);
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
				id: cheapestId,
				name: `${namePrefix}${m.id} (cheapest)`,
				detail,
				tooltip: `LiteLLM via the cheapest provider${serverCount > 1 ? ` on ${server.label}` : ""}`,
				family: "litellm",
				version: "1.0.0",
				maxInputTokens: maxInput,
				maxOutputTokens: maxOutput,
				capabilities: aggregateCapabilities,
				litellm: { supportsPromptCaching: aggregatePromptCaching },
			} satisfies LiteLLMModelInfo);
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
				litellm: { supportsPromptCaching: aggregatePromptCaching },
			} satisfies LiteLLMModelInfo);
			registerRoute(fastestId, fastestRaw);
		}

		for (const p of toolProviders) {
			const constraints = deriveTokenConstraints(p, tokenDefaults);
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
				litellm: { supportsPromptCaching: p.supports_prompt_caching === true },
			} satisfies LiteLLMModelInfo);
			registerRoute(exposedId, rawId);
		}

		const base = providers[0];
		if (toolProviders.length === 0 && base !== undefined) {
			const constraints = deriveTokenConstraints(base, tokenDefaults);
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
				litellm: { supportsPromptCaching: base.supports_prompt_caching === true },
			} satisfies LiteLLMModelInfo);
			registerRoute(exposedId, m.id);
		}

		return entries;
	});

	return { infos: infos.map(withUserSelectableMetadata), routes };
}
