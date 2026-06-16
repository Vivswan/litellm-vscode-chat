import { LanguageModelChatInformation } from "vscode";
import type { LiteLLMModelItem } from "../types";
import type { ServerWithKey } from "../extension/serverRegistry";
import type { ModelRoute } from "./request";
import { getTokenConstraints, buildExposedModelId } from "./request";

export interface RegistrationResult {
	infos: LanguageModelChatInformation[];
	routes: Map<string, ModelRoute>;
	promptCaching: Map<string, boolean>;
	/**
	 * Per-exposed-model flag: true when the model routes through a backend that
	 * downgrades the tools cache_control block to 5m (AWS Bedrock). Consumed by
	 * the cache-strategy resolver to drop an unsafe 1h tools marker.
	 */
	toolsCacheNo1h: Map<string, boolean>;
	/**
	 * Per-exposed-model flag: true when the model routes through a backend that
	 * rejects Anthropic-style inline `cache_control` markers entirely (Google
	 * Vertex AI / Gemini). Consumed by the cache-strategy resolver to disable our
	 * markers and rely on the backend's implicit server-side caching.
	 */
	cacheControlNoInline: Map<string, boolean>;
}

/**
 * AWS Bedrock honors the 1h cache TTL on `system`/messages but silently
 * downgrades the tools cachePoint to 5m, which trips Bedrock's
 * non-increasing-TTL ordering invariant when a 1h tools marker precedes a 1h
 * system block. Detect it from the LiteLLM provider name.
 */
function isBedrockProvider(provider: string | undefined): boolean {
	return typeof provider === "string" && provider.toLowerCase().includes("bedrock");
}

/**
 * Native Google Gemini caches via a separate `CachedContent` handle and rejects
 * requests that combine cached content with tools / tool_config / system
 * instruction. LiteLLM's vertex_ai adapter switches into cached-content mode as
 * soon as it sees any inline `cache_control` marker, so emitting our markers
 * produces a fatal 400; Gemini's implicit server-side caching still applies
 * with zero markers sent.
 *
 * IMPORTANT: scope this to *native Gemini only*. `vertex_ai` is LiteLLM's
 * provider name for everything hosted on Vertex — including Anthropic Claude
 * (`vertex_ai/claude-*`), Llama and Mistral — which use the same inline
 * `cache_control` semantics as direct Anthropic and do NOT get Gemini's
 * implicit caching. Disabling inline caching for those would silently turn off
 * prompt caching entirely with no fallback. So we require a Gemini signal in
 * the model id (or an explicit `gemini` provider name), not merely `vertex`.
 */
function isGeminiCacheIncompatible(provider: string | undefined, modelId: string | undefined): boolean {
	const p = typeof provider === "string" ? provider.toLowerCase() : "";
	const id = typeof modelId === "string" ? modelId.toLowerCase() : "";
	// A bare `gemini` provider is unambiguously native Gemini.
	if (p.includes("gemini")) {
		return true;
	}
	// On Vertex, only the Gemini model family is incompatible; Claude/Llama/
	// Mistral on Vertex keep working inline cache_control.
	if (p.includes("vertex")) {
		return id.includes("gemini");
	}
	return false;
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
	const toolsCacheNo1h = new Map<string, boolean>();
	const cacheControlNoInline = new Map<string, boolean>();

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
			toolsCacheNo1h.set(exposedId, isBedrockProvider(providers[0].provider));
			cacheControlNoInline.set(exposedId, isGeminiCacheIncompatible(providers[0].provider, m.id));
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
			toolsCacheNo1h.set(exposedId, false);
			cacheControlNoInline.set(exposedId, false);
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
			const aggregateToolsCacheNo1h = toolProviders.some((p) => isBedrockProvider(p.provider));
			const aggregateCacheControlNoInline = toolProviders.some((p) => isGeminiCacheIncompatible(p.provider, m.id));
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
			toolsCacheNo1h.set(cheapestId, aggregateToolsCacheNo1h);
			cacheControlNoInline.set(cheapestId, aggregateCacheControlNoInline);
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
			toolsCacheNo1h.set(fastestId, aggregateToolsCacheNo1h);
			cacheControlNoInline.set(fastestId, aggregateCacheControlNoInline);
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
			toolsCacheNo1h.set(exposedId, isBedrockProvider(p.provider));
			cacheControlNoInline.set(exposedId, isGeminiCacheIncompatible(p.provider, m.id));
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
			toolsCacheNo1h.set(exposedId, isBedrockProvider(base.provider));
			cacheControlNoInline.set(exposedId, isGeminiCacheIncompatible(base.provider, m.id));
			registerRoute(exposedId, m.id);
		}

		return entries;
	});

	return { infos: infos.map(withUserSelectableMetadata), routes, promptCaching, toolsCacheNo1h, cacheControlNoInline };
}
