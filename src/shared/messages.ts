import * as vscode from "vscode";
import type {
	OpenAIChatContentBlock,
	OpenAIChatFileContentBlock,
	OpenAIChatImageUrlContentBlock,
	OpenAIChatMessage,
	OpenAIChatRole,
	OpenAIToolCall,
} from "../types";

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function isImageMimeType(mime: string): boolean {
	return IMAGE_MIME_TYPES.has(mime.toLowerCase());
}

function isTextMimeType(mime: string): boolean {
	const lower = mime.toLowerCase();
	return lower.startsWith("text/") || lower === "application/json" || lower.endsWith("+json");
}

function convertDataPartToContentBlock(
	part: vscode.LanguageModelDataPart
): OpenAIChatImageUrlContentBlock | OpenAIChatFileContentBlock | null {
	const mime = part.mimeType.toLowerCase();
	if (isImageMimeType(mime)) {
		const base64 = Buffer.from(part.data).toString("base64");
		return { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } };
	}
	if (mime === "application/pdf") {
		const base64 = Buffer.from(part.data).toString("base64");
		return { type: "file", file: { file_data: `data:${mime};base64,${base64}` } };
	}
	return null;
}

function decodeDataPartText(part: vscode.LanguageModelDataPart): string | null {
	if (isTextMimeType(part.mimeType)) {
		return new TextDecoder().decode(part.data);
	}
	return null;
}

function isPromptTsxPart(value: unknown): boolean {
	if (!value || typeof value !== "object") {
		return false;
	}
	const ctorName = (Object.getPrototypeOf(value as object) as { constructor?: { name?: string } } | undefined)
		?.constructor?.name;
	return ctorName === "LanguageModelPromptTsxPart";
}

function extractPromptTsxText(part: unknown): string | null {
	const obj = part as Record<string, unknown>;
	if (typeof obj.value === "string") {
		return obj.value;
	}
	if (obj.value !== undefined && obj.value !== null) {
		try {
			return JSON.stringify(obj.value);
		} catch {
			return null;
		}
	}
	return null;
}

export function isToolResultPart(value: unknown): value is { callId: string; content?: ReadonlyArray<unknown> } {
	if (!value || typeof value !== "object") {
		return false;
	}
	const obj = value as Record<string, unknown>;
	const hasCallId = typeof obj.callId === "string";
	const hasContent = "content" in obj;
	return hasCallId && hasContent;
}

function mapRole(message: vscode.LanguageModelChatRequestMessage): Exclude<OpenAIChatRole, "tool"> {
	const USER = vscode.LanguageModelChatMessageRole.User as unknown as number;
	const ASSISTANT = vscode.LanguageModelChatMessageRole.Assistant as unknown as number;
	const r = message.role as unknown as number;
	if (r === USER) {
		return "user";
	}
	if (r === ASSISTANT) {
		return "assistant";
	}
	return "system";
}

export function collectToolResultText(pr: { content?: ReadonlyArray<unknown> }): string {
	let text = "";
	for (const c of pr.content ?? []) {
		if (c instanceof vscode.LanguageModelTextPart) {
			text += c.value;
		} else if (c instanceof vscode.LanguageModelDataPart) {
			const decoded = decodeDataPartText(c);
			if (decoded !== null) {
				text += decoded;
			} else if (isImageMimeType(c.mimeType)) {
				console.log("[LiteLLM Model Provider] Tool returned image data which cannot be forwarded as tool result text");
			}
		} else if (isPromptTsxPart(c)) {
			const extracted = extractPromptTsxText(c);
			if (extracted) {
				text += extracted;
			}
		} else if (typeof c === "string") {
			text += c;
		} else {
			try {
				text += JSON.stringify(c);
			} catch {
				/* ignore */
			}
		}
	}
	return text;
}

export interface ConvertedMessagesResult {
	messages: OpenAIChatMessage[];
	multimodalContent: {
		imageCount: number;
		pdfCount: number;
	};
}

/**
 * Convert VS Code chat request messages into OpenAI-compatible message objects.
 */
export function convertMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	options?: { cacheSystemPrompt?: boolean }
): ConvertedMessagesResult {
	const out: OpenAIChatMessage[] = [];
	let imageCount = 0;
	let pdfCount = 0;
	for (const m of messages) {
		const role = mapRole(m);
		const textParts: string[] = [];
		const toolCalls: OpenAIToolCall[] = [];
		const toolResults: { callId: string; content: string }[] = [];
		const contentBlocks: OpenAIChatContentBlock[] = [];
		let hasNonTextBlocks = false;

		for (const part of m.content ?? []) {
			if (part instanceof vscode.LanguageModelTextPart) {
				textParts.push(part.value);
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				const id = part.callId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
				let args;
				try {
					args = JSON.stringify(part.input ?? {});
				} catch {
					args = "{}";
				}
				toolCalls.push({ id, type: "function", function: { name: part.name, arguments: args } });
			} else if (isToolResultPart(part)) {
				const callId = (part as { callId?: string }).callId ?? "";
				const content = collectToolResultText(part as { content?: ReadonlyArray<unknown> });
				toolResults.push({ callId, content });
			} else if (part instanceof vscode.LanguageModelDataPart) {
				const block = convertDataPartToContentBlock(part);
				if (block) {
					if (block.type === "image_url") {
						imageCount++;
					} else if (block.type === "file") {
						pdfCount++;
					}
					if (textParts.length > 0) {
						contentBlocks.push({ type: "text", text: textParts.join("") });
						textParts.length = 0;
					}
					contentBlocks.push(block);
					hasNonTextBlocks = true;
				} else {
					const decoded = decodeDataPartText(part);
					if (decoded !== null) {
						textParts.push(decoded);
					} else {
						console.log(
							`[LiteLLM Model Provider] Skipping unsupported LanguageModelDataPart with MIME type: ${part.mimeType}`
						);
					}
				}
			} else if (isPromptTsxPart(part)) {
				const extracted = extractPromptTsxText(part);
				if (extracted) {
					textParts.push(extracted);
				}
			}
		}

		let emittedAssistantToolCall = false;
		if (toolCalls.length > 0) {
			out.push({ role: "assistant", content: textParts.join("") || undefined, tool_calls: toolCalls });
			emittedAssistantToolCall = true;
		}

		for (const tr of toolResults) {
			out.push({ role: "tool", tool_call_id: tr.callId, content: tr.content || "" });
		}

		if (role === "user" && hasNonTextBlocks) {
			if (textParts.length > 0) {
				contentBlocks.push({ type: "text", text: textParts.join("") });
			}
			if (contentBlocks.length > 0) {
				out.push({ role, content: contentBlocks });
			}
		} else {
			const text = textParts.join("");
			if (text && (role === "system" || role === "user" || (role === "assistant" && !emittedAssistantToolCall))) {
				if (role === "system" && options?.cacheSystemPrompt) {
					const content: OpenAIChatContentBlock[] = [
						{
							type: "text",
							text,
							cache_control: { type: "ephemeral" },
						},
					];
					out.push({ role, content });
				} else {
					out.push({ role, content: text });
				}
			}
		}
	}
	return {
		messages: out,
		multimodalContent: {
			imageCount,
			pdfCount,
		},
	};
}
