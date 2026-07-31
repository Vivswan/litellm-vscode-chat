import { getModelParametersConfig } from "../../shared/config/settings";
import type { ToolConfig } from "../../shared/conversion/tools";
import type { OpenAIChatMessage } from "../../shared/conversion/wire";
import type { ModelRoute } from "../catalog/modelCatalog";
import type { ModelConfigurationRequestParams } from "../catalog/modelConfiguration";

/**
 * Cap on the fallback max_tokens when neither runtime options nor configured
 * model parameters set one and the model's output limit is a defaults-derived
 * guess rather than server-declared.
 */
export const DEFAULT_MAX_TOKENS_CAP = 4096;
export const MAX_TOOLS_PER_REQUEST = 128;

function findLongestPrefixEntry<T>(id: string, entries: Record<string, T>): { key: string; value: T } | undefined {
	let best: { key: string; value: T } | undefined;
	for (const [key, value] of Object.entries(entries)) {
		if (id === key || id.startsWith(key)) {
			if (!best || key.length > best.key.length) {
				best = { key, value };
			}
		}
	}
	return best;
}

export function findLongestPrefixMatch<T>(id: string, entries: Record<string, T>): T | undefined {
	return findLongestPrefixEntry(id, entries)?.value;
}

/**
 * The most specific scoped entry across all scopes. Specificity is the length
 * of the model prefix after the scope, not of the whole key. Scoped keys must
 * contain the full "<scope>/" prefix. Ties on model prefix length resolve to
 * the earlier scope in `scopes`, then to configuration object order.
 */
function findScopedMatch<T>(
	rawId: string,
	scopes: readonly string[],
	entries: Record<string, T>
): { specificity: number; value: T } | undefined {
	let best: { specificity: number; value: T } | undefined;
	for (const scope of scopes) {
		const scopePrefix = `${scope}/`;
		for (const [key, value] of Object.entries(entries)) {
			if (!key.startsWith(scopePrefix)) {
				continue;
			}
			const modelPrefix = key.slice(scopePrefix.length);
			if (rawId === modelPrefix || rawId.startsWith(modelPrefix)) {
				if (!best || modelPrefix.length > best.specificity) {
					best = { specificity: modelPrefix.length, value };
				}
			}
		}
	}
	return best;
}

/**
 * Resolve the configured modelParameters for a model, merging two settings
 * sources. The global setting resolves as before: scoped keys are tried as
 * "<scope>/<modelId>" for every entry in `serverScopes` (the server's
 * normalized base URL), and any scoped match beats an unscoped one.
 * `entryModelParameters` is the declared server entry's own record (already
 * scoped to one entry, so plain longest-prefix matching applies); its
 * matching parameters override the global result key by key, mirroring how
 * the picker configuration and runtime options later override both.
 */
export function getModelParameters(
	modelId: string,
	modelRoutes: Map<string, ModelRoute>,
	serverScopes: readonly string[] = [],
	entryModelParameters?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
): Record<string, unknown> {
	const route = modelRoutes.get(modelId);
	const rawId = route?.rawModelId ?? modelId;
	const modelParameters = getModelParametersConfig();
	const scoped = findScopedMatch(rawId, serverScopes, modelParameters);
	const global = scoped?.value ?? findLongestPrefixMatch(rawId, modelParameters);
	const entry = findLongestPrefixMatch(rawId, entryModelParameters ?? {});
	return { ...global, ...entry };
}

export interface RequestBodyParams {
	rawModelId: string;
	openaiMessages: OpenAIChatMessage[];
	maxTokens: number;
	modelParams: Record<string, unknown>;
	/** Tools and tool_choice as one unit (see ToolConfig); absent means the request carries neither. */
	toolConfig: ToolConfig | undefined;
	/** Wire params resolved from the host's modelConfiguration, i.e. the user's model-picker choices. */
	modelConfiguration?: ModelConfigurationRequestParams | undefined;
	modelOptions?: Record<string, unknown> | undefined;
}

/**
 * Builds the request body as a pure pass-through: only parameters the user
 * set are forwarded, never injected defaults, so the provider's own defaults
 * apply. User-set sources apply in ascending precedence: modelParameters
 * config (global, overridden by the declared entry's own; getModelParameters
 * merges the two into `modelParams`), then the model-picker configuration,
 * then runtime modelOptions.
 */
export function buildRequestBody(params: RequestBodyParams): Record<string, unknown> {
	const { rawModelId, openaiMessages, maxTokens, modelParams, toolConfig, modelConfiguration, modelOptions } = params;

	const body: Record<string, unknown> = {
		model: rawModelId,
		messages: openaiMessages,
		stream: true,
		stream_options: { include_usage: true },
		max_tokens: maxTokens,
	};

	const providerOwnedKeys = new Set(["model", "messages", "stream", "stream_options", "tools", "tool_choice"]);

	// Underscore-prefixed keys are internal on both sources: VS Code injects
	// them into modelOptions, and retired extension metadata such as
	// _replaceDefaults may linger in user configuration.
	const passThrough = (source: Record<string, unknown>) => {
		for (const [key, value] of Object.entries(source)) {
			if (key === "max_tokens" || providerOwnedKeys.has(key) || key.startsWith("_")) {
				continue;
			}
			body[key] = value;
		}
	};

	passThrough(modelParams);
	if (modelConfiguration) {
		passThrough(modelConfiguration);
	}
	if (modelOptions) {
		passThrough(modelOptions);
	}

	if (toolConfig) {
		body.tools = toolConfig.tools;
		body.tool_choice = toolConfig.tool_choice;
	}

	return body;
}
