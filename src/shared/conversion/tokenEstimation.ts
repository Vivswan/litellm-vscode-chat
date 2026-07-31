import * as vscode from "vscode";
import { type DataPartPosition, dataPartWireForm } from "./dataPartForm";
import { extractPromptTsxText, isToolResultPart } from "./messages";
import type { OpenAIFunctionToolDef } from "./wire";

export const CHARS_PER_TOKEN = 4;
export const IMAGE_TOKEN_ESTIMATE = 765;
export const PDF_TOKEN_ESTIMATE = 500;
/**
 * Providers meter audio by duration, not bytes (OpenAI's gpt-4o audio input
 * runs about 10 tokens per second, Gemini 32 per second), and the duration is
 * not recoverable here without decoding the container. A fixed minute-scale
 * figure between those two rates keeps a typical voice clip from counting as
 * zero, which is the dangerous direction: an undercounted prompt is never
 * trimmed by the host's budget and overflows server-side instead.
 */
export const AUDIO_TOKEN_ESTIMATE = 1000;

/**
 * The same capability gates the message conversion runs under, resolved from
 * the model (registered imageInput capability, LiteLLM audio-input modality).
 * Estimation prices the same transmitted forms conversion produces for this
 * model - media at fixed heuristic figures, text by length - and a part the
 * gates exclude never ships, so it counts zero.
 */
export interface TokenEstimationOptions {
	imageInput: boolean;
	audioInput: boolean;
}

export function estimatePartTokens(
	part: unknown,
	options: TokenEstimationOptions,
	position: DataPartPosition = "user"
): number {
	if (part instanceof vscode.LanguageModelTextPart) {
		return Math.ceil(part.value.length / CHARS_PER_TOKEN);
	}
	if (part instanceof vscode.LanguageModelToolCallPart) {
		return Math.ceil((part.name.length + JSON.stringify(part.input ?? {}).length) / CHARS_PER_TOKEN);
	}
	if (part instanceof vscode.LanguageModelDataPart) {
		const wire = dataPartWireForm(part.mimeType, position, options);
		switch (wire.form) {
			case "image":
				return IMAGE_TOKEN_ESTIMATE;
			case "pdf":
				return PDF_TOKEN_ESTIMATE;
			case "audio":
				return AUDIO_TOKEN_ESTIMATE;
			case "text":
				return Math.ceil(part.data.length / CHARS_PER_TOKEN);
			case "none":
				return 0;
			default:
				return wire satisfies never;
		}
	}
	// Tool results wrap their output in a content array (no string value), so
	// each entry recurses through the same per-part estimates at the
	// "toolResult" position, whose wire forms drop PDF and audio and gate
	// images just like collectToolResultContent. In agent sessions tool output
	// dominates the prompt; counting it as 0 made the host's budget skip
	// trimming until the request overflowed server-side.
	if (isToolResultPart(part)) {
		let total = 0;
		for (const inner of part.content ?? []) {
			total += estimatePartTokens(inner, options, "toolResult");
		}
		return total;
	}
	// Prompt-TSX parts transmit as extractPromptTsxText's rendering (the string
	// value or, for object values, their JSON serialization); the estimate
	// counts that same text. Values with no JSON rendering transmit nothing and
	// price zero. A string value would also hit the generic fallback below, but
	// an object value would otherwise score 0.
	if (part instanceof vscode.LanguageModelPromptTsxPart) {
		const extracted = extractPromptTsxText(part);
		return typeof extracted === "string" ? Math.ceil(extracted.length / CHARS_PER_TOKEN) : 0;
	}
	// Thinking parts (a proposed API class) reach here as unrecognized objects
	// carrying a string value; their text plus any replayed signature or
	// redacted payload is serialized onto the wire, so it counts.
	if (part && typeof part === "object" && typeof (part as { value?: unknown }).value === "string") {
		const record = part as { value: string; metadata?: unknown };
		const metadata =
			record.metadata && typeof record.metadata === "object"
				? (record.metadata as { signature?: unknown; data?: unknown })
				: undefined;
		const signatureLength = typeof metadata?.signature === "string" ? metadata.signature.length : 0;
		const dataLength = typeof metadata?.data === "string" ? metadata.data.length : 0;
		return Math.ceil((record.value.length + signatureLength + dataLength) / CHARS_PER_TOKEN);
	}
	return 0;
}

export function estimateMessagesTokens(
	msgs: readonly vscode.LanguageModelChatRequestMessage[],
	options: TokenEstimationOptions
): number {
	let total = 0;
	for (const m of msgs) {
		// Everything but a user message takes the assistant position: mapRole
		// treats system and unknown roles alike, and conversion sends binary
		// blocks only for user messages, so the seam's assistant rule (text
		// decodes, binary drops) covers all of them.
		const position: DataPartPosition = m.role === vscode.LanguageModelChatMessageRole.User ? "user" : "assistant";
		for (const part of m.content) {
			total += estimatePartTokens(part, options, position);
		}
	}
	return total;
}

export function estimateToolTokens(tools: readonly OpenAIFunctionToolDef[] | undefined): number {
	if (!tools || tools.length === 0) {
		return 0;
	}
	try {
		return Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN);
	} catch {
		return 0;
	}
}
