import type { ChunkChoice, ChunkDelta, ThinkingBlock, ThinkingBlockDelta } from "../wire";

export interface ThinkingContent {
	text: string;
	id?: string | undefined;
	metadata?: unknown;
}

function structuredThinkingContents(raw: string | ThinkingBlock | undefined): ThinkingContent[] {
	if (raw === undefined) {
		return [];
	}
	if (typeof raw === "string") {
		return raw ? [{ text: raw }] : [];
	}
	const text = typeof raw.text === "string" ? raw.text : "";
	return text ? [{ text, id: raw.id, metadata: raw.metadata }] : [];
}

function thinkingBlockContents(blocks: readonly ThinkingBlockDelta[] | undefined): ThinkingContent[] {
	if (!blocks) {
		return [];
	}
	return blocks.flatMap((block): ThinkingContent[] => {
		if (block.type === "redacted_thinking") {
			return block.data ? [{ text: "", metadata: { type: block.type, data: block.data } }] : [];
		}
		const text = block.thinking ?? "";
		const metadata = block.signature !== undefined ? { type: block.type, signature: block.signature } : undefined;
		return text || metadata ? [{ text, metadata }] : [];
	});
}

/**
 * Extract thinking/reasoning content from a streaming choice. Covers the four
 * provider formats: a structured thinking object (choice- or delta-level), a
 * thinking_blocks array (Anthropic extended thinking via LiteLLM, whose text
 * duplicates reasoning_content but whose signature and redacted data exist
 * nowhere else), a reasoning_content string, and a reasoning string. Each
 * format wins only when it yields usable content, so an empty higher-priority
 * field never suppresses a populated lower-priority one.
 */
export function extractThinking(choice: ChunkChoice, delta: ChunkDelta | undefined): ThinkingContent[] {
	const choiceStructured = structuredThinkingContents(choice.thinking);
	if (choiceStructured.length > 0) {
		return choiceStructured;
	}
	const deltaStructured = structuredThinkingContents(delta?.thinking);
	if (deltaStructured.length > 0) {
		return deltaStructured;
	}
	const blocks = thinkingBlockContents(delta?.thinking_blocks);
	if (blocks.length > 0) {
		return blocks;
	}
	const reasoning = delta?.reasoning_content || delta?.reasoning;
	return reasoning ? [{ text: reasoning }] : [];
}

/**
 * The fixed message for a normally-finished stream that produced no parts at
 * all while reasoning output was dropped - because the host has no
 * LanguageModelThinkingPart class, or because the class it has failed to
 * construct. A thrown error rather than a fallback text part: text parts
 * round-trip into replayed chat history, and an error surfaces in the chat UI
 * and flows through the provider boundary's single-point logging. Static
 * string only; nothing response-derived.
 */
export const REASONING_ONLY_RESPONSE_MESSAGE =
	"The model produced only reasoning output, which this version of VS Code could not display: the LanguageModelThinkingPart API is missing or failed. Update VS Code to a version that supports thinking parts, or use a model that returns final text.";

/**
 * Per-request aggregate of reasoning dropped because no thinking part could
 * be built (class missing, or its constructor threw): counts and lengths
 * only, never the text. "parts" counts thinking items, not SSE chunks - one
 * delta carrying three thinking_blocks counts three. logged and threw latch
 * the once-per-request drop log line and the reasoning-only error, because
 * finishStream runs more than once per stream.
 */
export interface DroppedReasoning {
	parts: number;
	length: number;
	logged: boolean;
	threw: boolean;
}

export function freshDroppedReasoning(): DroppedReasoning {
	return { parts: 0, length: 0, logged: false, threw: false };
}
