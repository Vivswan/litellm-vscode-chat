import * as vscode from "vscode";
import { LanguageModelChatInformation } from "vscode";
import type { LiteLLMModelItem } from "../types";
import type { ServerWithKey } from "../extension/serverRegistry";
import type { ModelRoute } from "./request";
import { getTokenConstraints, buildExposedModelId } from "./request";
import { findLongestPrefixMatch } from "./modelDefaults";

export interface RegistrationResult {
	infos: LanguageModelChatInformation[];
	routes: Map<string, ModelRoute>;
	promptCaching: Map<string, boolean>;
}

export function buildModelInfos(
	models: LiteLLMModelItem[],
	server: ServerWithKey,
	serverCount: number,
	log: (message: string) => void
): RegistrationResult {
	const routes = new Map<string, ModelRoute>();
	const promptCaching = new Map<string, boolean>();
	const capOverrides = vscode.workspace
		.getConfiguration("litellm-vscode-chat")
		.get<Record<string, string>>("modelCapabilitiesOverrides", {});

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
					capabilities: applyCapabilityOverrides(
						m.id,
						{
							toolCalling: providers[0].supports_tools !== false,
							imageInput: vision,
						},
						capOverrides,
						server.label,
						log
					),
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
					capabilities: applyCapabilityOverrides(
						m.id,
						{
							toolCalling: true,
							imageInput: vision,
						},
						capOverrides,
						server.label,
						log
					),
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
			const aggregateCapabilities = applyCapabilityOverrides(
				m.id,
				{
					toolCalling: true,
					imageInput: vision,
				},
				capOverrides,
				server.label,
				log
			);

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
				capabilities: applyCapabilityOverrides(
					m.id,
					{
						toolCalling: true,
						imageInput: vision,
					},
					capOverrides,
					server.label,
					log
				),
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
				capabilities: applyCapabilityOverrides(
					m.id,
					{
						toolCalling: false,
						imageInput: vision,
					},
					capOverrides,
					server.label,
					log
				),
			} satisfies LanguageModelChatInformation);
			promptCaching.set(exposedId, base.supports_prompt_caching === true);
			registerRoute(exposedId, m.id);
		}

		return entries;
	});

	return { infos, routes, promptCaching };
}

export function applyCapabilityOverrides(
	modelId: string,
	capabilities: { toolCalling: boolean; imageInput: boolean },
	overrides: Record<string, string>,
	serverLabel?: string,
	log?: (message: string) => void
): { toolCalling: boolean; imageInput: boolean } {
	const VALID_CAPS = ["toolCalling", "imageInput"];
	let matchValue: string | undefined;
	if (serverLabel) {
		const scopedOverrides: Record<string, string> = {};
		for (const [key, value] of Object.entries(overrides)) {
			if (key.includes("/")) {
				scopedOverrides[key] = value;
			}
		}
		matchValue = findLongestPrefixMatch(`${serverLabel}/${modelId}`, scopedOverrides);
	}
	if (!matchValue) {
		matchValue = findLongestPrefixMatch(modelId, overrides);
	}
	if (!matchValue) return capabilities;
	const caps = matchValue.split(",").map((s) => s.trim());
	const unknown = caps.filter((c) => c !== "" && !VALID_CAPS.includes(c));
	if (unknown.length > 0 && log) {
		log(
			`WARNING: Unknown capability overrides for "${modelId}": ${unknown.join(", ")}. Valid values: ${VALID_CAPS.join(", ")}`
		);
	}
	return {
		toolCalling: caps.includes("toolCalling") ? true : capabilities.toolCalling,
		imageInput: caps.includes("imageInput") ? true : capabilities.imageInput,
	};
}
