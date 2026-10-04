/** Owned by shared/ because both the conversion helpers here and the provider's request builder consume them. */

export interface OpenAIToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

/**
 * Anthropic prompt-cache marker. LiteLLM forwards it from OpenAI-shaped requests to Anthropic-family backends;
 * placement is owned by promptCache.ts.
 */
export interface EphemeralCacheControl {
	readonly type: "ephemeral";
}

export interface OpenAIFunctionToolDef {
	type: "function";
	function: { name: string; description?: string; parameters?: object };
	cache_control?: EphemeralCacheControl;
}

export type OpenAIChatRole = "system" | "user" | "assistant" | "tool";

/**
 * Anthropic extended-thinking block replayed on an assistant message. LiteLLM forwards these to Anthropic so multi-turn
 * tool use keeps its signed thinking context.
 */
export type OpenAIThinkingBlock =
	| { type: "thinking"; thinking: string; signature: string }
	| { type: "redacted_thinking"; data: string };

/**
 * Content is required; the block-array form exists for multimodal user input and for promptCache.ts's marker
 * placement.
 */
export interface OpenAIPromptMessage {
	role: "system" | "user";
	content: string | OpenAIChatContentBlock[];
}

export interface OpenAIAssistantMessage {
	role: "assistant";
	content?: string | OpenAIChatContentBlock[] | undefined;
	tool_calls?: OpenAIToolCall[];
	thinking_blocks?: OpenAIThinkingBlock[];
}

/** Content is always the flattened text. */
export interface OpenAIToolMessage {
	role: "tool";
	tool_call_id: string;
	content: string;
	/**
	 * Message-level prompt-cache marker, valid only on tool-role messages: LiteLLM's Anthropic adapter copies it onto
	 * the top-level tool_result block, the only cacheable position there.
	 */
	cache_control?: EphemeralCacheControl;
}

export type OpenAIChatMessage = OpenAIPromptMessage | OpenAIAssistantMessage | OpenAIToolMessage;

interface OpenAIChatTextContentBlock {
	type: "text";
	text: string;
	cache_control?: EphemeralCacheControl;
}

export interface OpenAIChatImageUrlContentBlock {
	type: "image_url";
	image_url: { url: string; detail?: string };
}

export interface OpenAIChatFileContentBlock {
	type: "file";
	file: { file_data: string; filename?: string };
}

/**
 * Audio content block for audio input (the OpenAI input_audio shape; LiteLLM routes it to audio-capable models). The
 * wire names only wav and mp3.
 */
export interface OpenAIChatInputAudioContentBlock {
	type: "input_audio";
	input_audio: { data: string; format: "wav" | "mp3" };
}

export type OpenAIChatContentBlock =
	| OpenAIChatTextContentBlock
	| OpenAIChatImageUrlContentBlock
	| OpenAIChatFileContentBlock
	| OpenAIChatInputAudioContentBlock;
