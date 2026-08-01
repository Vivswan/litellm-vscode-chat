import { parameterSkipReason, resolveModelParameters } from "../../shared/config/parameterResolution";
import { getModelParametersConfig } from "../../shared/config/settings";
import type { ToolConfig } from "../../shared/conversion/tools";
import type { OpenAIChatMessage } from "../../shared/conversion/wire";
import type { ModelRoute } from "../catalog/modelCatalog";
import type { ModelConfigurationRequestParams } from "../catalog/modelConfiguration";

// The prefix resolution, precedence merge, and max_tokens machinery live in
// the shared module (the dashboard's inspector consumes the same functions);
// these re-exports keep this module the transport-side entry point.
export {
	DEFAULT_MAX_TOKENS_CAP,
	findLongestPrefixMatch,
	resolveMaxTokens,
} from "../../shared/config/parameterResolution";

export const MAX_TOOLS_PER_REQUEST = 128;

/**
 * Resolve the configured modelParameters for a model, merging two settings
 * sources. The global setting resolves as before: scoped keys are tried as
 * "<scope>/<modelId>" for every entry in `serverScopes` (the server's
 * normalized base URL), and any scoped match beats an unscoped one.
 * `entryModelParameters` is the declared server entry's own record (already
 * scoped to one entry, so plain longest-prefix matching applies); its
 * matching parameters override the global result key by key, mirroring how
 * the picker configuration and runtime options later override both.
 * The merge itself lives in resolveModelParameters (shared with the
 * dashboard's inspector); this wrapper only resolves the raw ID and reads
 * the live configuration.
 */
export function getModelParameters(
	modelId: string,
	modelRoutes: Map<string, ModelRoute>,
	serverScopes: readonly string[] = [],
	entryModelParameters?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
): Record<string, unknown> {
	const route = modelRoutes.get(modelId);
	const rawId = route?.rawModelId ?? modelId;
	return resolveModelParameters({
		rawModelId: rawId,
		globalParameters: getModelParametersConfig(),
		serverScopes,
		entryParameters: entryModelParameters,
	}).params;
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

	// parameterSkipReason owns the drop rules: provider-owned keys (max_tokens
	// included; the chain above already decided its value) and
	// underscore-prefixed internal keys never pass through, on any source.
	const passThrough = (source: Record<string, unknown>) => {
		for (const [key, value] of Object.entries(source)) {
			if (parameterSkipReason(key) !== undefined) {
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
