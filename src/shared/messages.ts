import * as vscode from "vscode";
import type {
	OpenAIChatContentBlock,
	OpenAIChatFileContentBlock,
	OpenAIChatImageUrlContentBlock,
	OpenAIChatMessage,
	OpenAIChatRole,
	OpenAIToolCall,
} from "../types";
import { isImageMimeType, isTextMimeType } from "./mime";

type LogFn = (message: string, data?: unknown) => void;

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
	// Tool-call parts must never be treated as tool results, regardless of
	// which order callers check part types in.
	if (value instanceof vscode.LanguageModelToolCallPart) {
		return false;
	}
	const obj = value as Record<string, unknown>;
	const hasCallId = typeof obj.callId === "string";
	const hasContent = "content" in obj;
	return hasCallId && hasContent;
}

function mapRole(message: vscode.LanguageModelChatRequestMessage, log?: LogFn): Exclude<OpenAIChatRole, "tool"> {
	if (message.role === vscode.LanguageModelChatMessageRole.User) {
		return "user";
	}
	if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
		return "assistant";
	}
	// VS Code sends role 3 for system messages via a proposed API; the stable enum only declares User and Assistant.
	if ((message.role as number) !== 3) {
		log?.("Unknown message role; treating as system", { role: message.role });
	}
	return "system";
}

export function collectToolResultText(pr: { content?: ReadonlyArray<unknown> }, log?: LogFn): string {
	let text = "";
	for (const c of pr.content ?? []) {
		if (c instanceof vscode.LanguageModelTextPart) {
			text += c.value;
		} else if (c instanceof vscode.LanguageModelDataPart) {
			const decoded = decodeDataPartText(c);
			if (decoded !== null) {
				text += decoded;
			} else if (isImageMimeType(c.mimeType)) {
				log?.("Tool returned image data which cannot be forwarded as tool result text");
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

/**
 * Convert VS Code chat request messages into OpenAI-compatible message objects.
 */
export function convertMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	options?: { cacheSystemPrompt?: boolean; log?: LogFn }
): OpenAIChatMessage[] {
	const log = options?.log;
	const out: OpenAIChatMessage[] = [];
	for (const m of messages) {
		const role = mapRole(m, log);
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
				let args: string;
				try {
					args = JSON.stringify(part.input ?? {});
				} catch {
					args = "{}";
				}
				toolCalls.push({ id, type: "function", function: { name: part.name, arguments: args } });
			} else if (isToolResultPart(part)) {
				const callId = (part as { callId?: string }).callId ?? "";
				const content = collectToolResultText(part as { content?: ReadonlyArray<unknown> }, log);
				toolResults.push({ callId, content });
			} else if (part instanceof vscode.LanguageModelDataPart) {
				const block = convertDataPartToContentBlock(part);
				if (block) {
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
						log?.(`Skipping unsupported LanguageModelDataPart with MIME type: ${part.mimeType}`);
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
	return out;
}
