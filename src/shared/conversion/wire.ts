/**
 * OpenAI-compatible request wire format: the message and tool shapes the
 * extension sends to /v1/chat/completions. Owned by shared/ because both the
 * conversion helpers here and the provider's request builder consume them.
 */

/** OpenAI function-call entry emitted by assistant messages. */
export interface OpenAIToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

/**
 * Anthropic prompt-cache marker. LiteLLM forwards it from OpenAI-shaped
 * requests to Anthropic-family backends; placement is owned by promptCache.ts.
 */
export interface EphemeralCacheControl {
	readonly type: "ephemeral";
}

/**
 * OpenAI function tool definition used to advertise tools. Placement of the
 * tool-level `cache_control` marker is owned by promptCache.ts, like the
 * message-level marker below.
 */
export interface OpenAIFunctionToolDef {
	type: "function";
	function: { name: string; description?: string; parameters?: object };
	cache_control?: EphemeralCacheControl;
}

/** OpenAI-style chat roles. */
export type OpenAIChatRole = "system" | "user" | "assistant" | "tool";

/**
 * Anthropic extended-thinking block replayed on an assistant message.
 * LiteLLM forwards these to Anthropic so multi-turn tool use keeps its
 * signed thinking context; other providers never receive them because only
 * blocks that arrived with a signature (or redacted data) are replayed.
 */
export type OpenAIThinkingBlock =
	| { type: "thinking"; thinking: string; signature: string }
	| { type: "redacted_thinking"; data: string };

/**
 * A system or user message. Content is required; the block-array form exists
 * for multimodal user input and for promptCache.ts's marker placement, which
 * rewrites string content into a marked text block on any role.
 */
export interface OpenAIPromptMessage {
	role: "system" | "user";
	content: string | OpenAIChatContentBlock[];
}

/** An assistant turn: text, tool calls, and replayed thinking blocks are each optional. */
export interface OpenAIAssistantMessage {
	role: "assistant";
	content?: string | OpenAIChatContentBlock[] | undefined;
	tool_calls?: OpenAIToolCall[];
	thinking_blocks?: OpenAIThinkingBlock[];
}

/**
 * A tool-result message; the pairing tool_call_id is required by construction.
 * Content is always the flattened text: LiteLLM forwards tool-message content
 * verbatim and OpenAI-family models reject content blocks here, so tool-result
 * images ride a synthesized user message after the turn instead.
 */
export interface OpenAIToolMessage {
	role: "tool";
	tool_call_id: string;
	content: string;
	/**
	 * Message-level prompt-cache marker, valid only on tool-role messages:
	 * LiteLLM's Anthropic adapter copies it onto the top-level tool_result
	 * block, the only cacheable position there.
	 */
	cache_control?: EphemeralCacheControl;
}

/**
 * OpenAI-style chat message used for router requests, discriminated by role
 * so every construction site is checked against that role's required fields.
 */
export type OpenAIChatMessage = OpenAIPromptMessage | OpenAIAssistantMessage | OpenAIToolMessage;

/** Text content block for chat messages. */
interface OpenAIChatTextContentBlock {
	type: "text";
	text: string;
	cache_control?: EphemeralCacheControl;
}

/** Image URL content block for vision input. */
export interface OpenAIChatImageUrlContentBlock {
	type: "image_url";
	image_url: { url: string; detail?: string };
}

/** File content block for document input (PDFs, etc.). */
export interface OpenAIChatFileContentBlock {
	type: "file";
	file: { file_data: string; filename?: string };
}

/**
 * Audio content block for audio input (the OpenAI input_audio shape; LiteLLM
 * routes it to audio-capable models). The wire names only wav and mp3.
 */
export interface OpenAIChatInputAudioContentBlock {
	type: "input_audio";
	input_audio: { data: string; format: "wav" | "mp3" };
}

/** Structured content blocks used in chat messages. */
export type OpenAIChatContentBlock =
	| OpenAIChatTextContentBlock
	| OpenAIChatImageUrlContentBlock
	| OpenAIChatFileContentBlock
	| OpenAIChatInputAudioContentBlock;
