import * as vscode from "vscode";
import { isToolResultPart } from "./messages";
import { audioInputFormatForMime, isImageMimeType, isPdfMimeType, isTextMimeType } from "./mime";
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

export interface TokenEstimationOptions {
	/** When true, images, PDFs, and audio clips contribute fixed estimates; when false they count as zero. */
	includeMultimodal: boolean;
}

export function estimatePartTokens(part: unknown, options: TokenEstimationOptions): number {
	if (part instanceof vscode.LanguageModelTextPart) {
		return Math.ceil(part.value.length / CHARS_PER_TOKEN);
	}
	if (part instanceof vscode.LanguageModelToolCallPart) {
		return Math.ceil((part.name.length + JSON.stringify(part.input ?? {}).length) / CHARS_PER_TOKEN);
	}
	if (part instanceof vscode.LanguageModelDataPart) {
		if (options.includeMultimodal) {
			if (isImageMimeType(part.mimeType)) {
				return IMAGE_TOKEN_ESTIMATE;
			}
			if (isPdfMimeType(part.mimeType)) {
				return PDF_TOKEN_ESTIMATE;
			}
			// The same vocabulary as the wire conversion: audio outside it never
			// reaches the server, so it must not inflate the estimate.
			if (audioInputFormatForMime(part.mimeType) !== undefined) {
				return AUDIO_TOKEN_ESTIMATE;
			}
		}
		if (isTextMimeType(part.mimeType)) {
			return Math.ceil(part.data.length / CHARS_PER_TOKEN);
		}
	}
	// Tool results wrap their output in a content array (no string value), so
	// each entry recurses through the same per-part estimates. In agent
	// sessions tool output dominates the prompt; counting it as 0 made the
	// host's budget skip trimming until the request overflowed server-side.
	// The conversion path (collectToolResultContent) forwards only text and
	// images from a tool result and drops PDF and audio unconditionally, so
	// those count zero here: they never ship, whatever the model supports.
	if (isToolResultPart(part)) {
		let total = 0;
		for (const inner of part.content ?? []) {
			if (
				inner instanceof vscode.LanguageModelDataPart &&
				!isImageMimeType(inner.mimeType) &&
				!isTextMimeType(inner.mimeType)
			) {
				continue;
			}
			total += estimatePartTokens(inner, options);
		}
		return total;
	}
	// Prompt-TSX parts transmit as their string value or, for object values,
	// their JSON serialization (extractPromptTsxText in messages.ts); the
	// estimate counts that same rendering. A string value would also hit the
	// generic fallback below, but an object value would otherwise score 0.
	if (part instanceof vscode.LanguageModelPromptTsxPart) {
		if (typeof part.value === "string") {
			return Math.ceil(part.value.length / CHARS_PER_TOKEN);
		}
		if (part.value !== undefined && part.value !== null) {
			try {
				return Math.ceil(JSON.stringify(part.value).length / CHARS_PER_TOKEN);
			} catch {
				return 0;
			}
		}
		return 0;
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
		for (const part of m.content) {
			total += estimatePartTokens(part, options);
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
