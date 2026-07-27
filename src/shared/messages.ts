import * as vscode from "vscode";
import { isImageMimeType, isTextMimeType } from "./mime";
import { thinkingPartCtor } from "./thinkingPart";
import type {
	OpenAIChatContentBlock,
	OpenAIChatFileContentBlock,
	OpenAIChatImageUrlContentBlock,
	OpenAIChatMessage,
	OpenAIChatRole,
	OpenAIThinkingBlock,
	OpenAIToolCall,
} from "./wire";

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

function extractPromptTsxText(part: vscode.LanguageModelPromptTsxPart): string | null {
	if (typeof part.value === "string") {
		return part.value;
	}
	if (part.value !== undefined && part.value !== null) {
		try {
			return JSON.stringify(part.value);
		} catch {
			return null;
		}
	}
	return null;
}

export function isToolResultPart(value: unknown): value is vscode.LanguageModelToolResultPart {
	return value instanceof vscode.LanguageModelToolResultPart;
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

function collectToolResultText(pr: vscode.LanguageModelToolResultPart, log?: LogFn): string {
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
		} else if (c instanceof vscode.LanguageModelPromptTsxPart) {
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

interface ThinkingHistoryEntry {
	text: string;
	signature?: string;
	redactedData?: string;
}

/**
 * Read a thinking part from assistant history. Recognized via the proposed
 * LanguageModelThinkingPart class when the host exposes it, otherwise by the
 * replay metadata this extension itself attaches while streaming (a signature
 * or redacted data).
 */
function extractThinkingHistoryEntry(part: unknown): ThinkingHistoryEntry | undefined {
	if (!part || typeof part !== "object" || part instanceof vscode.LanguageModelToolCallPart) {
		return undefined;
	}
	const record = part as { value?: unknown; metadata?: unknown };
	const metadata =
		record.metadata && typeof record.metadata === "object"
			? (record.metadata as { type?: unknown; signature?: unknown; data?: unknown })
			: undefined;
	const text = typeof record.value === "string" ? record.value : "";
	if (metadata?.type === "redacted_thinking" && typeof metadata.data === "string") {
		return { text, redactedData: metadata.data };
	}
	if (typeof metadata?.signature === "string") {
		return { text, signature: metadata.signature };
	}
	if (thinkingPartCtor && part instanceof thinkingPartCtor) {
		return { text };
	}
	return undefined;
}

/**
 * Fold the thinking parts of one assistant message back into Anthropic replay
 * blocks. Signatures may stream in a separate, empty-text part after the text
 * they sign, so unsigned text accumulates until a signature closes the block.
 * Trailing unsigned text has no replay value and is dropped, as is plain
 * thinking on providers that never sign.
 */
function foldThinkingBlocks(entries: readonly ThinkingHistoryEntry[]): OpenAIThinkingBlock[] {
	const blocks: OpenAIThinkingBlock[] = [];
	let pendingText = "";
	for (const entry of entries) {
		if (entry.redactedData !== undefined) {
			blocks.push({ type: "redacted_thinking", data: entry.redactedData });
			pendingText = "";
		} else if (entry.signature !== undefined) {
			blocks.push({ type: "thinking", thinking: pendingText + entry.text, signature: entry.signature });
			pendingText = "";
		} else {
			pendingText += entry.text;
		}
	}
	return blocks;
}

/**
 * Convert VS Code chat request messages into OpenAI-compatible message objects.
 * Prompt-cache markers are not placed here; shared/promptCache.ts owns them
 * as a pass over the converted request.
 */
export function convertMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	options?: { log?: LogFn }
): OpenAIChatMessage[] {
	const log = options?.log;
	const out: OpenAIChatMessage[] = [];
	for (const m of messages) {
		const role = mapRole(m, log);
		const textParts: string[] = [];
		const toolCalls: OpenAIToolCall[] = [];
		const toolResults: { callId: string; content: string }[] = [];
		const contentBlocks: OpenAIChatContentBlock[] = [];
		const thinkingEntries: ThinkingHistoryEntry[] = [];
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
				toolResults.push({ callId: part.callId, content: collectToolResultText(part, log) });
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
			} else if (part instanceof vscode.LanguageModelPromptTsxPart) {
				const extracted = extractPromptTsxText(part);
				if (extracted) {
					textParts.push(extracted);
				}
			} else {
				const thinkingEntry = role === "assistant" ? extractThinkingHistoryEntry(part) : undefined;
				if (thinkingEntry) {
					thinkingEntries.push(thinkingEntry);
				}
			}
		}

		const thinkingBlocks = foldThinkingBlocks(thinkingEntries);
		let emittedForMessage = false;

		let emittedAssistantToolCall = false;
		if (toolCalls.length > 0) {
			out.push({
				role: "assistant",
				content: textParts.join("") || undefined,
				tool_calls: toolCalls,
				...(thinkingBlocks.length > 0 ? { thinking_blocks: thinkingBlocks } : {}),
			});
			emittedAssistantToolCall = true;
			emittedForMessage = true;
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
				if (role === "assistant" && thinkingBlocks.length > 0) {
					out.push({ role, content: text, thinking_blocks: thinkingBlocks });
				} else {
					out.push({ role, content: text });
				}
				emittedForMessage = true;
			}
		}

		// A signed thinking block must replay even when its assistant turn
		// carried no text or tool calls.
		if (role === "assistant" && thinkingBlocks.length > 0 && !emittedForMessage) {
			out.push({ role, content: "", thinking_blocks: thinkingBlocks });
		}
	}
	return out;
}
