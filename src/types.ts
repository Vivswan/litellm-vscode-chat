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

/**
 * Normalized model entry used internally after discovery. Both discovery
 * endpoints are narrowed and normalized into this shape, so `providers` is
 * always an array (possibly empty for bare /v1/models entries).
 */
export interface LiteLLMModelItem {
	id: string;
	providers: LiteLLMProvider[];
	architecture?: LiteLLMArchitecture;
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

/** Finish reason on a streaming choice. Providers may send values beyond the OpenAI set. */
export type FinishReason =
	| "stop"
	| "length"
	| "tool_calls"
	| "content_filter"
	| "function_call"
	| (string & Record<never, never>);

/** Structured thinking payload used by Anthropic-style providers. */
export interface ThinkingBlock {
	text?: string;
	id?: string;
	metadata?: unknown;
}

/** Content block inside a structured streaming delta; only text blocks are rendered. */
export interface ChunkContentBlock {
	type?: string;
	text?: string;
}

/** Fragment of a streamed tool call. OpenAI-compatible proxies may send the index as a numeric string. */
export interface StreamedToolCall {
	index?: number | string;
	id?: string;
	type?: string;
	function?: { name?: string; arguments?: string };
}

/** Streaming message delta. Providers surface reasoning under several different keys. */
export interface ChunkDelta {
	role?: string;
	content?: string | ChunkContentBlock[] | null;
	tool_calls?: StreamedToolCall[];
	thinking?: string | ThinkingBlock;
	reasoning_content?: string;
	reasoning?: string;
}

/** A single choice in a streaming chunk. Some providers put thinking on the choice instead of the delta. */
export interface ChunkChoice {
	index?: number;
	delta?: ChunkDelta;
	thinking?: string | ThinkingBlock;
	finish_reason?: FinishReason | null;
}

/** Token usage trailer, including provider cache accounting fields. Logged wholesale, so extras pass through. */
export interface ChunkUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
	prompt_tokens_details?: { cached_tokens?: number; audio_tokens?: number };
	completion_tokens_details?: { reasoning_tokens?: number; audio_tokens?: number };
	[key: string]: unknown;
}

/** One SSE chunk of a streaming chat completion. */
export interface ChatCompletionChunk {
	id?: string;
	object?: string;
	created?: number;
	model?: string;
	choices?: ChunkChoice[];
	usage?: ChunkUsage | null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function narrowThinking(raw: unknown): string | ThinkingBlock | undefined {
	if (typeof raw === "string") {
		return raw;
	}
	if (isRecord(raw)) {
		return {
			text: typeof raw.text === "string" ? raw.text : undefined,
			id: typeof raw.id === "string" ? raw.id : undefined,
			metadata: raw.metadata,
		};
	}
	return undefined;
}

function narrowContent(raw: unknown): string | ChunkContentBlock[] | null | undefined {
	if (raw === undefined) {
		return undefined;
	}
	if (raw === null) {
		return null;
	}
	if (Array.isArray(raw)) {
		return raw.filter(isRecord).map((block) => ({
			type: typeof block.type === "string" ? block.type : undefined,
			text: typeof block.text === "string" ? block.text : undefined,
		}));
	}
	return typeof raw === "string" ? raw : String(raw);
}

function narrowToolCall(raw: Record<string, unknown>): StreamedToolCall {
	const func = isRecord(raw.function) ? raw.function : undefined;
	return {
		index: typeof raw.index === "number" || typeof raw.index === "string" ? raw.index : undefined,
		id: typeof raw.id === "string" ? raw.id : undefined,
		type: typeof raw.type === "string" ? raw.type : undefined,
		function: func
			? {
					name: typeof func.name === "string" ? func.name : undefined,
					arguments: typeof func.arguments === "string" ? func.arguments : undefined,
				}
			: undefined,
	};
}

function narrowDelta(raw: unknown): ChunkDelta | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}
	return {
		role: typeof raw.role === "string" ? raw.role : undefined,
		content: narrowContent(raw.content),
		tool_calls: Array.isArray(raw.tool_calls) ? raw.tool_calls.filter(isRecord).map(narrowToolCall) : undefined,
		thinking: narrowThinking(raw.thinking),
		reasoning_content: typeof raw.reasoning_content === "string" ? raw.reasoning_content : undefined,
		reasoning: typeof raw.reasoning === "string" ? raw.reasoning : undefined,
	};
}

function narrowChoice(raw: Record<string, unknown>): ChunkChoice {
	return {
		index: typeof raw.index === "number" ? raw.index : undefined,
		delta: narrowDelta(raw.delta),
		thinking: narrowThinking(raw.thinking),
		finish_reason: typeof raw.finish_reason === "string" ? raw.finish_reason : undefined,
	};
}

/**
 * Leniently narrow a parsed SSE payload to the chunk contract. Unknown or
 * malformed fields are ignored rather than rejected; only a non-object
 * payload yields undefined.
 */
export function parseChunk(raw: unknown): ChatCompletionChunk | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}
	return {
		id: typeof raw.id === "string" ? raw.id : undefined,
		object: typeof raw.object === "string" ? raw.object : undefined,
		created: typeof raw.created === "number" ? raw.created : undefined,
		model: typeof raw.model === "string" ? raw.model : undefined,
		choices: Array.isArray(raw.choices) ? raw.choices.filter(isRecord).map(narrowChoice) : undefined,
		usage: isRecord(raw.usage) ? (raw.usage as ChunkUsage) : undefined,
	};
}
