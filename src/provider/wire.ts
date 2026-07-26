import { isRecord } from "../shared/json";

/**
 * Streaming wire format for /v1/chat/completions SSE chunks, and the lenient
 * per-line narrowing the stream processor runs on the hot path. The rules are
 * deliberate: unknown or malformed fields are ignored rather than rejected,
 * numeric-string tool-call indexes are accepted, and only a non-object
 * payload yields undefined; never drop a chunk for fields we don't know.
 */

/** Buffer used to accumulate streamed tool call parts until arguments are valid JSON. */
export interface ToolCallBuffer {
	id?: string | undefined;
	name?: string | undefined;
	args: string;
}

/** Finish reason on a streaming choice. Providers may send values beyond the OpenAI set. */
type FinishReason =
	| "stop"
	| "length"
	| "tool_calls"
	| "content_filter"
	| "function_call"
	| (string & Record<never, never>);

/** Structured thinking payload used by Anthropic-style providers. */
export interface ThinkingBlock {
	text?: string | undefined;
	id?: string | undefined;
	metadata?: unknown;
}

/** Content block inside a structured streaming delta; only text blocks are rendered. */
interface ChunkContentBlock {
	type?: string | undefined;
	text?: string | undefined;
}

/** Fragment of a streamed tool call. OpenAI-compatible proxies may send the index as a numeric string. */
export interface StreamedToolCall {
	index?: number | string | undefined;
	id?: string | undefined;
	type?: string | undefined;
	function?: { name?: string | undefined; arguments?: string | undefined } | undefined;
}

/** Streaming message delta. Providers surface reasoning under several different keys. */
export interface ChunkDelta {
	role?: string | undefined;
	content?: string | ChunkContentBlock[] | null | undefined;
	tool_calls?: StreamedToolCall[] | undefined;
	thinking?: string | ThinkingBlock | undefined;
	reasoning_content?: string | undefined;
	reasoning?: string | undefined;
}

/** A single choice in a streaming chunk. Some providers put thinking on the choice instead of the delta. */
export interface ChunkChoice {
	index?: number | undefined;
	delta?: ChunkDelta | undefined;
	thinking?: string | ThinkingBlock | undefined;
	finish_reason?: FinishReason | null | undefined;
}

/** Token usage trailer, including provider cache accounting fields. Logged wholesale, so extras pass through. */
interface ChunkUsage {
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
	id?: string | undefined;
	object?: string | undefined;
	created?: number | undefined;
	model?: string | undefined;
	choices?: ChunkChoice[] | undefined;
	usage?: ChunkUsage | null | undefined;
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
 * payload yields undefined. Hand-rolled rather than schema-driven: this runs
 * once per SSE line, and its leniency rules are the contract.
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
