import * as vscode from "vscode";
import type { OpenAIFunctionToolDef } from "../types";
import { isImageMimeType, isTextMimeType } from "./mime";

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
			if (part.mimeType.toLowerCase() === "application/pdf") {
				return PDF_TOKEN_ESTIMATE;
			}
		}
		if (isTextMimeType(part.mimeType)) {
			return Math.ceil(part.data.length / CHARS_PER_TOKEN);
		}
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
