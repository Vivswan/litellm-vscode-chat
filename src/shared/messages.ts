import * as vscode from "vscode";
import { audioInputFormatForMime, isImageMimeType, isPdfMimeType, isSafeMimeType, isTextMimeType } from "./mime";
import { thinkingPartCtor } from "./thinkingPart";
import type {
	OpenAIChatContentBlock,
	OpenAIChatFileContentBlock,
	OpenAIChatImageUrlContentBlock,
	OpenAIChatInputAudioContentBlock,
	OpenAIChatMessage,
	OpenAIChatRole,
	OpenAIThinkingBlock,
	OpenAIToolCall,
} from "./wire";

type LogFn = (message: string, data?: unknown) => void;

/**
 * Capability-derived conversion gates, resolved by the caller from the
 * model's registered capabilities (imageInput) and its LiteLLM input
 * modalities (audioInput); parts a gate excludes take the same drop-and-log
 * paths as if no wire mapping existed. Capabilities decide what goes on the
 * wire; nothing here injects a request parameter.
 */
export interface ConvertMessagesOptions {
	log?: LogFn | undefined;
	/**
	 * Convert image DataParts to image_url blocks: user-message images in
	 * place, tool-result images gathered into one synthesized user message per
	 * turn. Without it they drop with a log, so a replayed image-bearing
	 * history never sends image blocks to a non-vision model.
	 */
	imageInput?: boolean | undefined;
	/** Convert audio DataParts on user messages to input_audio blocks; without it they drop with the no-wire-mapping log. */
	audioInput?: boolean | undefined;
}

function imageDataPartToBlock(part: vscode.LanguageModelDataPart): OpenAIChatImageUrlContentBlock {
	const base64 = Buffer.from(part.data).toString("base64");
	return { type: "image_url", image_url: { url: `data:${part.mimeType.toLowerCase()};base64,${base64}` } };
}

function convertDataPartToContentBlock(
	part: vscode.LanguageModelDataPart,
	options: { imageInput: boolean; audioInput: boolean }
): OpenAIChatImageUrlContentBlock | OpenAIChatFileContentBlock | OpenAIChatInputAudioContentBlock | null {
	const mime = part.mimeType.toLowerCase();
	if (options.imageInput && isImageMimeType(mime)) {
		return imageDataPartToBlock(part);
	}
	if (isPdfMimeType(mime)) {
		const base64 = Buffer.from(part.data).toString("base64");
		return { type: "file", file: { file_data: `data:${mime};base64,${base64}` } };
	}
	const audioFormat = audioInputFormatForMime(mime);
	if (options.audioInput && audioFormat !== undefined) {
		return {
			type: "input_audio",
			input_audio: { data: Buffer.from(part.data).toString("base64"), format: audioFormat },
		};
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

/**
 * The parts of one tool result the wire can carry: its flattened text (the
 * tool message body) and, for vision models, the image blocks the caller
 * gathers into the turn's synthesized image message. Tool messages themselves
 * never carry image blocks: LiteLLM's OpenAI transformation forwards
 * tool-message content verbatim and OpenAI-family models reject image blocks
 * there, so the images ride a user message after the turn instead (OpenAI's
 * documented shape, which Anthropic accepts too). For models without
 * imageInput the image is dropped with the log below, as before.
 */
interface ToolResultContent {
	text: string;
	images: OpenAIChatImageUrlContentBlock[];
}

function collectToolResultContent(
	pr: vscode.LanguageModelToolResultPart,
	imageInput: boolean,
	log?: LogFn
): ToolResultContent {
	const images: OpenAIChatImageUrlContentBlock[] = [];
	let text = "";
	for (const c of pr.content ?? []) {
		if (c instanceof vscode.LanguageModelTextPart) {
			text += c.value;
		} else if (c instanceof vscode.LanguageModelDataPart) {
			const decoded = decodeDataPartText(c);
			if (decoded !== null) {
				text += decoded;
			} else if (isImageMimeType(c.mimeType)) {
				if (imageInput) {
					images.push(imageDataPartToBlock(c));
				} else {
					log?.("Tool returned image data which cannot be forwarded as tool result text");
				}
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
	return { text, images };
}

/**
 * The fixed lead-in of the synthesized image message. A constant, never
 * response-derived text: it exists so the model can tell these blocks are
 * tool output, not a new user question.
 */
const TOOL_IMAGES_LEAD_IN = "Images returned by the tool calls above:";

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
	options?: ConvertMessagesOptions
): OpenAIChatMessage[] {
	const log = options?.log;
	const imageInput = options?.imageInput === true;
	const audioInput = options?.audioInput === true;
	const out: OpenAIChatMessage[] = [];
	// Tool-result images pending their synthesized user message. OpenAI
	// requires every tool message of an assistant tool_calls turn to directly
	// follow that assistant message, and the host may split one turn's results
	// across consecutive messages, so the flush waits for the first non-tool
	// message (or end of history): exactly one image message per turn, after
	// its last tool message, never interleaved between tool messages.
	let pendingToolImages: OpenAIChatImageUrlContentBlock[] = [];
	const push = (message: OpenAIChatMessage): void => {
		if (message.role !== "tool" && pendingToolImages.length > 0) {
			out.push({ role: "user", content: [{ type: "text", text: TOOL_IMAGES_LEAD_IN }, ...pendingToolImages] });
			pendingToolImages = [];
		}
		out.push(message);
	};
	// One dropped-DataPart log per conversion: a media-heavy history would
	// otherwise evict the whole issue-report buffer on every turn.
	let loggedDroppedDataPart = false;
	for (const m of messages) {
		const role = mapRole(m, log);
		const textParts: string[] = [];
		const toolCalls: OpenAIToolCall[] = [];
		const toolResults: { callId: string; content: ToolResultContent }[] = [];
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
				toolResults.push({ callId: part.callId, content: collectToolResultContent(part, imageInput, log) });
			} else if (part instanceof vscode.LanguageModelDataPart) {
				// Only user messages carry binary content blocks on the wire.
				// Assistant history may hold model-generated media (surfaced as
				// DataParts while streaming); there is no assistant-side wire
				// shape for it, so the part is dropped while the turn's TEXT is
				// always kept - moving text into contentBlocks here would hand
				// it to a branch that only user messages ever drain.
				const block = role === "user" ? convertDataPartToContentBlock(part, { imageInput, audioInput }) : null;
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
			push({
				role: "assistant",
				content: textParts.join("") || undefined,
				tool_calls: toolCalls,
				...(thinkingBlocks.length > 0 ? { thinking_blocks: thinkingBlocks } : {}),
			});
		}

		for (const tr of toolResults) {
			push({ role: "tool", tool_call_id: tr.callId, content: tr.content.text });
			pendingToolImages.push(...tr.content.images);
		}

		// contentBlocks is non-empty exactly when a binary block converted above,
		// so its emptiness is the "multimodal user message" test.
		if (role === "user" && contentBlocks.length > 0) {
			if (textParts.length > 0) {
				contentBlocks.push({ type: "text", text: textParts.join("") });
			}
			push({ role, content: contentBlocks });
		} else if (role === "assistant") {
			// The turn's text rides on the tool-call message when there is one.
			const text = toolCalls.length === 0 ? textParts.join("") : "";
			if (text) {
				push(
					thinkingBlocks.length > 0 ? { role, content: text, thinking_blocks: thinkingBlocks } : { role, content: text }
				);
			} else if (toolCalls.length === 0 && thinkingBlocks.length > 0) {
				// A signed thinking block must replay even when its assistant turn
				// carried no text or tool calls.
				push({ role, content: "", thinking_blocks: thinkingBlocks });
			}
		} else {
			const text = textParts.join("");
			if (text) {
				push({ role, content: text });
			}
		}
	}
	// Images from a trailing tool turn still need their message.
	if (pendingToolImages.length > 0) {
		out.push({ role: "user", content: [{ type: "text", text: TOOL_IMAGES_LEAD_IN }, ...pendingToolImages] });
	}
	return out;
}
