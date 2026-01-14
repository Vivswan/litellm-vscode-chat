/**
 * OpenAI function-call entry emitted by assistant messages.
 */
export interface OpenAIToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

/**
 * OpenAI function tool definition used to advertise tools.
 */
export interface OpenAIFunctionToolDef {
	type: "function";
	function: { name: string; description?: string; parameters?: object };
}

/**
 * Content item for vision/image support in OpenAI messages
 */
export interface OpenAIChatMessageContentItem {
	type: "text" | "image_url";
	text?: string;
	image_url?: {
		url: string;
	};
}

/**
 * OpenAI-style chat message used for router requests.
 */
export interface OpenAIChatMessage {
	role: OpenAIChatRole;
	content?: string | OpenAIChatMessageContentItem[];
	name?: string;
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
}

/**
 * LiteLLM model configuration parameters.
 */
export interface LiteLLMParams {
	custom_llm_provider?: string;
	litellm_credential_name?: string;
	use_in_pass_through?: boolean;
	use_litellm_proxy?: boolean;
	merge_reasoning_content_in_choices?: boolean;
	model?: string;
	tags?: string[];
}

/**
 * Detailed model information from LiteLLM proxy including capabilities and token constraints.
 */
export interface LiteLLMModelInfo {
	id?: string;
	db_model?: boolean;
	key?: string;
	max_tokens?: number;
	max_input_tokens?: number;
	max_output_tokens?: number;
	litellm_provider?: string;
	mode?: string;
	supports_system_messages?: boolean | null;
	supports_response_schema?: boolean;
	supports_vision?: boolean;
	supports_function_calling?: boolean;
	supports_tool_choice?: boolean;
	supports_assistant_prefill?: boolean | null;
	supports_prompt_caching?: boolean;
	supports_audio_input?: boolean | null;
	supports_audio_output?: boolean | null;
	supports_pdf_input?: boolean;
	supports_embedding_image_input?: boolean | null;
	supports_native_streaming?: boolean | null;
	supports_web_search?: boolean | null;
	supports_url_context?: boolean | null;
	supports_reasoning?: boolean;
	supports_computer_use?: boolean | null;
	supported_openai_params?: string[];
	[key: string]: unknown; // Allow additional fields for extensibility
}

/**
 * Single model entry from /model/info endpoint.
 */
export interface LiteLLMModelEntry {
	model_name: string;
	litellm_params?: LiteLLMParams;
	model_info?: LiteLLMModelInfo;
}

/**
 * Response envelope for LiteLLM /model/info endpoint.
 */
export interface LiteLLMModelInfoResponse {
	data: LiteLLMModelEntry[];
}

/**
 * Transformed model item for internal use.
 */
export interface TransformedModelItem {
	id: string;
	object: string;
	created: number;
	owned_by: string;
	model_name: string;
	litellm_params?: LiteLLMParams;
	model_info?: LiteLLMModelInfo;
}

/**
 * Buffer used to accumulate streamed tool call parts until arguments are valid JSON.
 */
export interface ToolCallBuffer {
	id?: string;
	name?: string;
	args: string;
}

/** OpenAI-style chat roles. */
export type OpenAIChatRole = "system" | "user" | "assistant" | "tool";
