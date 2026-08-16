import * as vscode from "vscode";
import { type DataPartPosition, dataPartWireForm } from "./dataPartForm";
import { extractPromptTsxText, isToolResultPart } from "./messages";
import { countTextBytesTokens, countTextTokens } from "./textTokens";
import type { OpenAIFunctionToolDef } from "./wire";

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
 * The same capability gates the message conversion runs under. Estimation
 * prices the same transmitted forms conversion produces for this model, and a
 * part the gates exclude never ships, so it counts zero.
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
		return countTextTokens(part.value);
	}
	if (part instanceof vscode.LanguageModelToolCallPart) {
		return countTextTokens(part.name + JSON.stringify(part.input ?? {}));
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
				return countTextBytesTokens(part.data);
			case "none":
				return 0;
			default:
				return wire satisfies never;
		}
	}
	// Tool results wrap their output in a content array, so each entry prices
	// what collectToolResultContent transmits for it: recognized part classes
	// recurse at the "toolResult" position, a bare string prices through the
	// same text counter, and anything else is JSON-stringified onto the wire.
	// In agent sessions tool output dominates the prompt; counting entries as 0
	// made the host's budget skip trimming until the request overflowed
	// server-side.
	if (isToolResultPart(part)) {
		let total = 0;
		for (const inner of part.content ?? []) {
			if (
				inner instanceof vscode.LanguageModelTextPart ||
				inner instanceof vscode.LanguageModelDataPart ||
				inner instanceof vscode.LanguageModelPromptTsxPart
			) {
				total += estimatePartTokens(inner, options, "toolResult");
			} else if (typeof inner === "string") {
				total += countTextTokens(inner);
			} else {
				try {
					// Conversion appends JSON.stringify's result with `+=`, which
					// coerces a missing rendering to the literal "undefined"; the
					// estimate prices exactly that transmitted text.
					total += countTextTokens(JSON.stringify(inner) ?? "undefined");
				} catch {
					// A throwing serialization transmits nothing and prices zero.
				}
			}
		}
		return total;
	}
	// Prompt-TSX parts transmit as extractPromptTsxText's rendering; the
	// estimate counts that same text. Values with no JSON rendering transmit
	// nothing and price zero. A string value would also hit the generic
	// fallback below, but an object value would otherwise score 0.
	if (part instanceof vscode.LanguageModelPromptTsxPart) {
		const extracted = extractPromptTsxText(part);
		return typeof extracted === "string" ? countTextTokens(extracted) : 0;
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
		const signature = typeof metadata?.signature === "string" ? metadata.signature : "";
		const data = typeof metadata?.data === "string" ? metadata.data : "";
		return countTextTokens(record.value + signature + data);
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
		// blocks only for user messages.
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
		return countTextTokens(JSON.stringify(tools));
	} catch {
		return 0;
	}
}
