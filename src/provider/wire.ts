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

/**
 * One entry of a thinking_blocks array, LiteLLM's mapping of Anthropic
 * extended thinking. "thinking" entries carry text plus the signature needed
 * to replay the block in a later turn; "redacted_thinking" entries carry only
 * opaque data.
 */
export interface ThinkingBlockDelta {
	type?: string | undefined;
	thinking?: string | undefined;
	signature?: string | undefined;
	data?: string | undefined;
}

/** URL citation attached to a streamed content delta by web-search-enabled models. */
export interface ChunkAnnotation {
	type?: string | undefined;
	url_citation?: { url?: string | undefined; title?: string | undefined } | undefined;
}

/** Content block inside a structured streaming delta; only text blocks are rendered. */
interface ChunkContentBlock {
	type?: string | undefined;
	text?: string | undefined;
}

/** One generated image in a delta.images list; image-generating chat models carry a base64 data URL here. */
export interface ChunkImage {
	type?: string | undefined;
	image_url?: { url?: string | undefined } | undefined;
}

/** Generated audio output in the gpt-4o shape; data fragments across deltas share the id. */
export interface ChunkAudio {
	id?: string | undefined;
	data?: string | undefined;
	transcript?: string | undefined;
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
	thinking_blocks?: ThinkingBlockDelta[] | undefined;
	reasoning_content?: string | undefined;
	reasoning?: string | undefined;
	refusal?: string | undefined;
	annotations?: ChunkAnnotation[] | undefined;
	images?: ChunkImage[] | undefined;
	audio?: ChunkAudio | undefined;
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

function narrowThinkingBlocks(raw: unknown): ThinkingBlockDelta[] | undefined {
	if (!Array.isArray(raw)) {
		return undefined;
	}
	return raw.filter(isRecord).map((block) => ({
		type: typeof block.type === "string" ? block.type : undefined,
		thinking: typeof block.thinking === "string" ? block.thinking : undefined,
		signature: typeof block.signature === "string" ? block.signature : undefined,
		data: typeof block.data === "string" ? block.data : undefined,
	}));
}

function narrowAnnotations(raw: unknown): ChunkAnnotation[] | undefined {
	if (!Array.isArray(raw)) {
		return undefined;
	}
	return raw.filter(isRecord).map((annotation) => {
		const citation = isRecord(annotation.url_citation) ? annotation.url_citation : undefined;
		return {
			type: typeof annotation.type === "string" ? annotation.type : undefined,
			url_citation: citation
				? {
						url: typeof citation.url === "string" ? citation.url : undefined,
						title: typeof citation.title === "string" ? citation.title : undefined,
					}
				: undefined,
		};
	});
}

function narrowImages(raw: unknown): ChunkImage[] | undefined {
	if (!Array.isArray(raw)) {
		return undefined;
	}
	return raw.filter(isRecord).map((image) => {
		const imageUrl = isRecord(image.image_url) ? image.image_url : undefined;
		return {
			type: typeof image.type === "string" ? image.type : undefined,
			image_url: imageUrl ? { url: typeof imageUrl.url === "string" ? imageUrl.url : undefined } : undefined,
		};
	});
}

function narrowAudio(raw: unknown): ChunkAudio | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}
	return {
		id: typeof raw.id === "string" ? raw.id : undefined,
		data: typeof raw.data === "string" ? raw.data : undefined,
		transcript: typeof raw.transcript === "string" ? raw.transcript : undefined,
	};
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
		thinking_blocks: narrowThinkingBlocks(raw.thinking_blocks),
		reasoning_content: typeof raw.reasoning_content === "string" ? raw.reasoning_content : undefined,
		reasoning: typeof raw.reasoning === "string" ? raw.reasoning : undefined,
		refusal: typeof raw.refusal === "string" ? raw.refusal : undefined,
		annotations: narrowAnnotations(raw.annotations),
		images: narrowImages(raw.images),
		audio: narrowAudio(raw.audio),
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
