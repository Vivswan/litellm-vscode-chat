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

/** OpenAI function tool definition used to advertise tools. */
export interface OpenAIFunctionToolDef {
	type: "function";
	function: { name: string; description?: string; parameters?: object };
}

/** OpenAI-style chat roles. */
export type OpenAIChatRole = "system" | "user" | "assistant" | "tool";

/** OpenAI-style chat message used for router requests. */
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
