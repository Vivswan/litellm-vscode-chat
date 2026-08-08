import { parameterSkipReason } from "../../shared/config/parameterResolution";
import type { ToolConfig } from "../../shared/conversion/tools";
import type { OpenAIChatMessage } from "../../shared/conversion/wire";
import type { ModelConfigurationRequestParams } from "../catalog/modelConfiguration";

// The matcher resolution, precedence merge, and max_tokens machinery live in
// the shared module (the dashboard's inspector consumes the same functions),
// and requests read the merged configured parameters through the provider's
// memoized ModelResolutionTable; these re-exports keep this module the
// transport-side entry point.
export { DEFAULT_MAX_TOKENS_CAP, resolveMaxTokens } from "../../shared/config/parameterResolution";

export const MAX_TOOLS_PER_REQUEST = 128;

export interface RequestBodyParams {
	rawModelId: string;
	openaiMessages: OpenAIChatMessage[];
	maxTokens: number;
	modelParams: Record<string, unknown>;
	/** The `_force`d configured parameters; applied above every other pass-through source. */
	forcedParams?: Readonly<Record<string, unknown>> | undefined;
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
 * then runtime modelOptions, then the config records' `_force`d fields
 * (which is what "forced" means: not even runtime options override them).
 */
export function buildRequestBody(params: RequestBodyParams): Record<string, unknown> {
	const {
		rawModelId,
		openaiMessages,
		maxTokens,
		modelParams,
		forcedParams,
		toolConfig,
		modelConfiguration,
		modelOptions,
	} = params;

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
	const passThrough = (source: Readonly<Record<string, unknown>>) => {
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
	if (forcedParams) {
		passThrough(forcedParams);
	}

	if (toolConfig) {
		body.tools = toolConfig.tools;
		body.tool_choice = toolConfig.tool_choice;
	}

	return body;
}
