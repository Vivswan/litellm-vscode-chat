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
 * OpenAI-style chat message used for router requests.
 */
export interface OpenAIChatMessage {
	role: OpenAIChatRole;
	content?: string | OpenAIChatContentBlock[];
	name?: string;
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
}

/** Text content block for chat messages. */
export interface OpenAIChatTextContentBlock {
	type: "text";
	text: string;
	cache_control?: {
		type: "ephemeral";
	};
}

/** Image URL content block for vision input. */
export interface OpenAIChatImageUrlContentBlock {
	type: "image_url";
	image_url: { url: string; detail?: string };
}

/** Structured content blocks used in chat messages. */
export type OpenAIChatContentBlock =
	| OpenAIChatTextContentBlock
	| OpenAIChatImageUrlContentBlock
	| OpenAIChatFileContentBlock;

/** File content block for document input (PDFs, etc.). */
export interface OpenAIChatFileContentBlock {
	type: "file";
	file: { file_data: string; filename?: string };
}

/**
 * A single underlying provider (e.g., together, groq) for a model.
 * This interface represents model capability metadata read from the LiteLLM API.
 */
export interface LiteLLMProvider {
	provider: string;
	status: string;
	supports_tools?: boolean;
	supports_structured_output?: boolean;
	context_length?: number;
	// Model capability metadata (READ from /v1/models API endpoint)
	// These define what the model CAN do, not what we ASK it to do.
	// For customizing request parameters, use the modelParameters configuration.
	max_tokens?: number | null;
	max_input_tokens?: number | null;
	max_output_tokens?: number | null;
	source?: "model_info";
	/** True if the upstream model advertises prompt caching support. */
	supports_prompt_caching?: boolean | null;
	/** True if the upstream model supports structured output / response_format schema. */
	supports_response_schema?: boolean | null;
	/** True if the upstream model supports reasoning/thinking. */
	supports_reasoning?: boolean | null;
	/** True if the upstream model supports PDF input. */
	supports_pdf_input?: boolean | null;
	/** List of OpenAI-compatible parameters the model supports. */
	supported_openai_params?: string[] | null;
}

/**
 * Architecture information for a model.
 */
export interface LiteLLMArchitecture {
	input_modalities?: string[];
	output_modalities?: string[];
}

export interface LiteLLMModelItem {
	id: string;
	object: string;
	created: number;
	owned_by: string;
	providers: LiteLLMProvider[];
	architecture?: LiteLLMArchitecture;
}

/**
 * Extra model information (deprecated).
 */
// Deprecated: extra model info was previously fetched from external APIs
export interface LiteLLMExtraModelInfo {
	id: string;
	pipeline_tag?: string;
}

/**
 * Response envelope for the LiteLLM models listing.
 */
export interface LiteLLMModelsResponse {
	object: string;
	data: LiteLLMModelItem[];
}

/** LiteLLM /v1/model/info response envelope. */
export interface LiteLLMModelInfoResponse {
	data: LiteLLMModelInfoItem[];
}

/** LiteLLM model metadata entry from /v1/model/info. */
export interface LiteLLMModelInfoItem {
	model_name?: string;
	litellm_params?: {
		model?: string;
	};
	model_info?: {
		id?: string;
		key?: string;
		max_tokens?: number | null;
		max_input_tokens?: number | null;
		max_output_tokens?: number | null;
		litellm_provider?: string;
		supports_function_calling?: boolean | null;
		supports_tool_choice?: boolean | null;
		supports_vision?: boolean | null;
		supports_prompt_caching?: boolean | null;
		supports_response_schema?: boolean | null;
		supports_reasoning?: boolean | null;
		supports_pdf_input?: boolean | null;
		supports_audio_input?: boolean | null;
		supports_audio_output?: boolean | null;
		supported_openai_params?: string[] | null;
	};
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

/**
 * Streaming response delta structure
 */
export interface StreamingResponseDelta {
	choices?: Array<StreamingChoice>;
	usage?: TokenUsage;
}

/**
 * Streaming choice within a delta
 */
export interface StreamingChoice {
	delta?: StreamingDelta;
	finish_reason?: string | null;
	thinking?: ThinkingContent | string;
}

/**
 * Delta content within a streaming choice
 */
export interface StreamingDelta {
	content?: string | Array<ContentBlock>;
	tool_calls?: Array<StreamingToolCall>;
	thinking?: ThinkingContent | string;
	reasoning_content?: string;
	reasoning?: string;
}

/**
 * Thinking/reasoning content structure
 */
export interface ThinkingContent {
	text?: string;
	id?: string;
	metadata?: unknown;
}

/**
 * Content block in structured delta content
 */
export interface ContentBlock {
	type: string;
	text?: string;
	[key: string]: unknown;
}

/**
 * Streaming tool call structure
 */
export interface StreamingToolCall {
	index?: number;
	id?: string;
	type?: "function";
	function?: {
		name?: string;
		arguments?: string;
	};
}

/**
 * Token usage information
 */
export interface TokenUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
}
