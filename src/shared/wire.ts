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
 * requests to Anthropic-family backends; placement is owned by
 * shared/promptCache.ts.
 */
export interface EphemeralCacheControl {
	readonly type: "ephemeral";
}

/**
 * OpenAI function tool definition used to advertise tools. Placement of the
 * tool-level `cache_control` marker is owned by shared/promptCache.ts, like
 * the message-level marker below.
 */
export interface OpenAIFunctionToolDef {
	type: "function";
	function: { name: string; description?: string; parameters?: object };
	cache_control?: EphemeralCacheControl;
}

/** OpenAI-style chat roles. */
export type OpenAIChatRole = "system" | "user" | "assistant" | "tool";

/** OpenAI-style chat message used for router requests. */
/**
 * Anthropic extended-thinking block replayed on an assistant message.
 * LiteLLM forwards these to Anthropic so multi-turn tool use keeps its
 * signed thinking context; other providers never receive them because only
 * blocks that arrived with a signature (or redacted data) are replayed.
 */
export type OpenAIThinkingBlock =
	| { type: "thinking"; thinking: string; signature: string }
	| { type: "redacted_thinking"; data: string };

export interface OpenAIChatMessage {
	role: OpenAIChatRole;
	content?: string | OpenAIChatContentBlock[] | undefined;
	name?: string;
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
	thinking_blocks?: OpenAIThinkingBlock[];
	/**
	 * Message-level prompt-cache marker, used only on tool-role messages:
	 * LiteLLM's Anthropic adapter copies it onto the top-level tool_result
	 * block, the only cacheable position there (see shared/promptCache.ts).
	 */
	cache_control?: EphemeralCacheControl;
}

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

/** Structured content blocks used in chat messages. */
export type OpenAIChatContentBlock =
	| OpenAIChatTextContentBlock
	| OpenAIChatImageUrlContentBlock
	| OpenAIChatFileContentBlock;
