import * as vscode from "vscode";
import { isImageMimeType, isPdfMimeType, isTextMimeType } from "./mime";
import type { OpenAIFunctionToolDef } from "./wire";

export const CHARS_PER_TOKEN = 4;
export const IMAGE_TOKEN_ESTIMATE = 765;
export const PDF_TOKEN_ESTIMATE = 500;

export interface TokenEstimationOptions {
	/** When true, images and PDFs contribute fixed estimates; when false they count as zero. */
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
		}
		if (isTextMimeType(part.mimeType)) {
			return Math.ceil(part.data.length / CHARS_PER_TOKEN);
		}
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
