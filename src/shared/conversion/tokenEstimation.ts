import type * as vscode from "vscode";
import { convertMessages } from "./messages";
import { countTextTokens } from "./textTokens";
import type {
	OpenAIChatContentBlock,
	OpenAIChatMessage,
	OpenAIFunctionToolDef,
	OpenAIThinkingBlock,
	OpenAIToolCall,
} from "./wire";

export const IMAGE_TOKEN_ESTIMATE = 765;
export const PDF_TOKEN_ESTIMATE = 500;
/**
 * Providers meter audio by duration, not bytes, and the duration is not
 * recoverable here without decoding the container. A fixed minute-scale figure
 * keeps a typical voice clip from counting as zero, which is the dangerous
 * direction: an undercounted prompt is never trimmed by the host's budget and
 * overflows server-side instead.
 */
export const AUDIO_TOKEN_ESTIMATE = 1000;

/**
 * The same capability gates the message conversion runs under, so the estimate
 * prices the request this model would actually receive: a part the gates
 * exclude never ships and never counts.
 */
export interface TokenEstimationOptions {
	imageInput: boolean;
	audioInput: boolean;
}

/** Binary blocks price at their fixed estimates; their payload bytes are not the token metric. */
function contentBlockTokens(block: OpenAIChatContentBlock): number {
	switch (block.type) {
		case "text":
			return countTextTokens(block.text);
		case "image_url":
			return IMAGE_TOKEN_ESTIMATE;
		case "file":
			return PDF_TOKEN_ESTIMATE;
		case "input_audio":
			return AUDIO_TOKEN_ESTIMATE;
		default:
			return block satisfies never;
	}
}

function contentTokens(content: string | OpenAIChatContentBlock[] | undefined): number {
	if (content === undefined) {
		return 0;
	}
	if (typeof content === "string") {
		return countTextTokens(content);
	}
	let total = 0;
	for (const block of content) {
		total += contentBlockTokens(block);
	}
	return total;
}

/** The name and the exact arguments string the wire carries; the generated id is scaffolding, like roles and keys. */
function toolCallTokens(call: OpenAIToolCall): number {
	return countTextTokens(call.function.name + call.function.arguments);
}

/** A replayed thinking block carries signed text or a redacted payload; both ship verbatim. */
function thinkingBlockTokens(block: OpenAIThinkingBlock): number {
	return countTextTokens(block.type === "thinking" ? block.thinking + block.signature : block.data);
}

function wireMessageTokens(message: OpenAIChatMessage): number {
	let total = contentTokens(message.content);
	if (message.role === "assistant") {
		for (const call of message.tool_calls ?? []) {
			total += toolCallTokens(call);
		}
		for (const block of message.thinking_blocks ?? []) {
			total += thinkingBlockTokens(block);
		}
	}
	return total;
}

/**
 * Price an already-converted request: transmitted text through the installed
 * counter, binary blocks at their fixed estimates. Callers that hold the
 * array they send price that very array, so conversion runs once per request.
 * Wire scaffolding (roles, ids, JSON punctuation) and `cache_control` markers
 * are deliberately unpriced.
 */
export function estimateWireMessagesTokens(messages: readonly OpenAIChatMessage[]): number {
	let total = 0;
	for (const message of messages) {
		total += wireMessageTokens(message);
	}
	return total;
}

/**
 * Price the request by converting the messages and pricing what conversion
 * emits. The one walk over message parts is conversion's own, so the estimate
 * cannot disagree with the transmitted text; when a second walk drifted, the
 * budget undercounted, the host skipped trimming, and the request overflowed
 * server-side.
 */
export function estimateMessagesTokens(
	msgs: readonly vscode.LanguageModelChatRequestMessage[],
	options: TokenEstimationOptions
): number {
	return estimateWireMessagesTokens(convertMessages(msgs, options));
}

export function estimateToolTokens(tools: readonly OpenAIFunctionToolDef[] | undefined): number {
	if (!tools || tools.length === 0) {
		return 0;
	}
	try {
		return countTextTokens(JSON.stringify(tools));
	} catch {
		return 0;
	}
}
