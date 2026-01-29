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
	content?: string;
	name?: string;
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
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
	max_tokens?: number;
	max_input_tokens?: number;
	max_output_tokens?: number;
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
