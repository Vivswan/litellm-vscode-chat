import * as vscode from "vscode";
import { isImageMimeType, isPdfMimeType, isSafeMimeType, isTextMimeType } from "./mime";
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
	if (isPdfMimeType(mime)) {
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

/**
 * One thinking part read back from assistant history, in the three replay
 * shapes extractThinkingHistoryEntry can prove: signed text (replayable),
 * a redacted payload (replayable), or unsigned text (replayable only if a
 * later signature closes over it).
 */
type ThinkingHistoryEntry =
	| { kind: "unsigned"; text: string }
	| { kind: "signed"; text: string; signature: string }
	| { kind: "redacted"; data: string };

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
		return { kind: "redacted", data: metadata.data };
	}
	if (typeof metadata?.signature === "string") {
		return { kind: "signed", text, signature: metadata.signature };
	}
	if (thinkingPartCtor && part instanceof thinkingPartCtor) {
		return { kind: "unsigned", text };
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
		switch (entry.kind) {
			case "redacted":
				blocks.push({ type: "redacted_thinking", data: entry.data });
				pendingText = "";
				break;
			case "signed":
				blocks.push({ type: "thinking", thinking: pendingText + entry.text, signature: entry.signature });
				pendingText = "";
				break;
			case "unsigned":
				pendingText += entry.text;
				break;
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
	// One dropped-DataPart log per conversion: a media-heavy history would
	// otherwise evict the whole issue-report buffer on every turn.
	let loggedDroppedDataPart = false;
	for (const m of messages) {
		const role = mapRole(m, log);
		const textParts: string[] = [];
		const toolCalls: OpenAIToolCall[] = [];
		const toolResults: { callId: string; content: string }[] = [];
		const contentBlocks: OpenAIChatContentBlock[] = [];
		const thinkingEntries: ThinkingHistoryEntry[] = [];

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
				// Only user messages carry binary content blocks on the wire.
				// Assistant history may hold model-generated media (surfaced as
				// DataParts while streaming); there is no assistant-side wire
				// shape for it, so the part is dropped while the turn's TEXT is
				// always kept - moving text into contentBlocks here would hand
				// it to a branch that only user messages ever drain.
				const block = role === "user" ? convertDataPartToContentBlock(part) : null;
				if (block) {
					if (textParts.length > 0) {
						contentBlocks.push({ type: "text", text: textParts.join("") });
						textParts.length = 0;
					}
					contentBlocks.push(block);
				} else {
					const decoded = decodeDataPartText(part);
					if (decoded !== null) {
						textParts.push(decoded);
					} else {
						// The mime is model-controlled on assistant turns and this log
						// feeds the issue-report buffer, so it is allowlisted by shape.
						if (!loggedDroppedDataPart) {
							loggedDroppedDataPart = true;
							log?.("Skipping LanguageModelDataPart with no wire mapping", {
								role,
								mimeType: isSafeMimeType(part.mimeType) ? part.mimeType : "unparseable",
							});
						}
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

		if (toolCalls.length > 0) {
			out.push({
				role: "assistant",
				content: textParts.join("") || undefined,
				tool_calls: toolCalls,
				...(thinkingBlocks.length > 0 ? { thinking_blocks: thinkingBlocks } : {}),
			});
		}

		for (const tr of toolResults) {
			out.push({ role: "tool", tool_call_id: tr.callId, content: tr.content || "" });
		}

		// contentBlocks is non-empty exactly when a binary block converted above,
		// so its emptiness is the "multimodal user message" test.
		if (role === "user" && contentBlocks.length > 0) {
			if (textParts.length > 0) {
				contentBlocks.push({ type: "text", text: textParts.join("") });
			}
			out.push({ role, content: contentBlocks });
		} else if (role === "assistant") {
			// The turn's text rides on the tool-call message when there is one.
			const text = toolCalls.length === 0 ? textParts.join("") : "";
			if (text) {
				out.push(
					thinkingBlocks.length > 0 ? { role, content: text, thinking_blocks: thinkingBlocks } : { role, content: text }
				);
			} else if (toolCalls.length === 0 && thinkingBlocks.length > 0) {
				// A signed thinking block must replay even when its assistant turn
				// carried no text or tool calls.
				out.push({ role, content: "", thinking_blocks: thinkingBlocks });
			}
		} else {
			const text = textParts.join("");
			if (text) {
				out.push({ role, content: text });
			}
		}
	}
	return out;
}
