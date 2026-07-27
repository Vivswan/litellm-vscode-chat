import { getModelParametersConfig } from "../shared/settings";
import type { OpenAIChatMessage, OpenAIFunctionToolDef } from "../shared/wire";
import type { ModelRoute } from "./modelCatalog";
import type { ModelConfigurationRequestParams } from "./modelConfiguration";

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
 * of the model prefix after the scope, not of the whole key, so a long base
 * URL with a vague model prefix never outranks a short label with a precise
 * one. Scoped keys must contain the full "<scope>/" prefix. Ties on model
 * prefix length resolve to the earlier scope in `scopes` (callers pass the
 * base URL before legacy labels), then to configuration object order.
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
 * Resolve the configured modelParameters entry for a model. Scoped keys are
 * tried as "<scope>/<modelId>" for the route's server label plus every entry
 * in `serverScopes` (a group server's base URL and its pre-migration label);
 * any scoped match beats an unscoped one.
 */
export function getModelParameters(
	modelId: string,
	modelRoutes: Map<string, ModelRoute>,
	serverScopes: readonly string[] = []
): Record<string, unknown> {
	const route = modelRoutes.get(modelId);
	const rawId = route?.rawModelId ?? modelId;
	const modelParameters = getModelParametersConfig();
	const scopes = route?.serverLabel ? [route.serverLabel, ...serverScopes] : serverScopes;
	const scoped = findScopedMatch(rawId, scopes, modelParameters);
	if (scoped) {
		return { ...scoped.value };
	}
	const match = findLongestPrefixMatch(rawId, modelParameters);
	return match ? { ...match } : {};
}

export interface RequestBodyParams {
	rawModelId: string;
	openaiMessages: OpenAIChatMessage[];
	maxTokens: number;
	modelParams: Record<string, unknown>;
	toolConfig: { tools?: OpenAIFunctionToolDef[]; tool_choice?: unknown };
	/** Wire params resolved from the host's modelConfiguration, i.e. the user's model-picker choices. */
	modelConfiguration?: ModelConfigurationRequestParams | undefined;
	modelOptions?: Record<string, unknown> | undefined;
}

/**
 * Builds the request body as a pure pass-through: only parameters the user
 * set are forwarded, never injected defaults, so the provider's own defaults
 * apply. User-set sources apply in ascending precedence: modelParameters
 * config, then the model-picker configuration, then runtime modelOptions.
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

	if (toolConfig.tools) {
		body.tools = toolConfig.tools;
	}
	if (toolConfig.tool_choice) {
		body.tool_choice = toolConfig.tool_choice;
	}

	return body;
}
