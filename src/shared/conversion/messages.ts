import * as vscode from "vscode";
import { type DataPartWireForm, type DataPartWireGates, dataPartWireForm } from "./dataPartForm";
import { isImageMimeType, isSafeMimeType, isTextMimeType } from "./mime";
import { thinkingPartCtor } from "./thinkingPart";
import { isToolResultPart, pairToolCallIds, type ToolCallPairing, wireIdKey } from "./toolCallIds";
import type {
	OpenAIAssistantMessage,
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
 * Parts a gate excludes take the same drop-and-log paths as if no wire mapping existed. Capabilities decide what goes
 * on the wire; nothing here injects a request parameter.
 */
export interface ConvertMessagesOptions {
	log?: LogFn | undefined;
	imageInput?: boolean | undefined;
	audioInput?: boolean | undefined;
	/** The model's replay_reasoning_content capability: see OpenAIAssistantMessage.reasoning_content. */
	replayReasoningContent?: boolean | undefined;
}

function imageDataPartToBlock(part: vscode.LanguageModelDataPart): OpenAIChatImageUrlContentBlock {
	const base64 = Buffer.from(part.data).toString("base64");
	return { type: "image_url", image_url: { url: `data:${part.mimeType.toLowerCase()};base64,${base64}` } };
}

function convertDataPartToContentBlock(
	part: vscode.LanguageModelDataPart,
	wire: DataPartWireForm
): OpenAIChatImageUrlContentBlock | OpenAIChatFileContentBlock | OpenAIChatInputAudioContentBlock | null {
	const mime = part.mimeType.toLowerCase();
	switch (wire.form) {
		case "image":
			return imageDataPartToBlock(part);
		case "pdf": {
			const base64 = Buffer.from(part.data).toString("base64");
			return { type: "file", file: { file_data: `data:${mime};base64,${base64}` } };
		}
		case "audio":
			return {
				type: "input_audio",
				input_audio: { data: Buffer.from(part.data).toString("base64"), format: wire.format },
			};
		case "text":
		case "none":
			return null;
		default:
			return wire satisfies never;
	}
}

function decodeDataPartText(part: vscode.LanguageModelDataPart): string | null {
	if (isTextMimeType(part.mimeType)) {
		return new TextDecoder().decode(part.data);
	}
	return null;
}

/** JSON.stringify returns undefined for values with no JSON rendering, so callers must treat undefined as dropped. */
function extractPromptTsxText(part: vscode.LanguageModelPromptTsxPart): string | undefined {
	if (typeof part.value === "string") {
		return part.value;
	}
	if (part.value !== undefined && part.value !== null) {
		try {
			return JSON.stringify(part.value);
		} catch {
			return undefined;
		}
	}
	return undefined;
}

export function mapRole(message: vscode.LanguageModelChatRequestMessage, log?: LogFn): Exclude<OpenAIChatRole, "tool"> {
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
 * Tool messages themselves never carry image blocks: LiteLLM forwards tool-message content verbatim and OpenAI-family
 * models reject image blocks there, so the images ride a user message after the turn instead.
 */
interface ToolResultContent {
	text: string;
	images: OpenAIChatImageUrlContentBlock[];
}

/**
 * One tool-result data part into the result's text or images. PDF and audio blocks exist only on user messages, so
 * their drop is logged like the non-vision image case (through the caller's once-per-conversion flag). The mime is
 * tool-controlled and this log feeds the issue-report buffer, so it is allowlisted by shape.
 */
function collectToolResultDataPart(
	part: vscode.LanguageModelDataPart,
	gates: DataPartWireGates,
	content: ToolResultContent,
	logDrop: LogFn
): void {
	const wire = dataPartWireForm(part.mimeType, "toolResult", gates);
	if (wire.form === "text") {
		content.text += decodeDataPartText(part) ?? "";
		return;
	}

	if (wire.form === "image") {
		content.images.push(imageDataPartToBlock(part));
		return;
	}

	if (isImageMimeType(part.mimeType)) {
		logDrop("Tool returned image data which cannot be forwarded as tool result text");
		return;
	}

	logDrop("Tool returned media with no tool-result wire mapping", {
		mimeType: isSafeMimeType(part.mimeType) ? part.mimeType : "unparseable",
	});
}

function collectToolResultItem(
	item: unknown,
	gates: DataPartWireGates,
	content: ToolResultContent,
	logDrop: LogFn
): void {
	if (item instanceof vscode.LanguageModelTextPart) {
		content.text += item.value;
		return;
	}

	if (item instanceof vscode.LanguageModelDataPart) {
		collectToolResultDataPart(item, gates, content, logDrop);
		return;
	}

	if (item instanceof vscode.LanguageModelPromptTsxPart) {
		const extracted = extractPromptTsxText(item);
		if (extracted) {
			content.text += extracted;
		}
		return;
	}

	if (typeof item === "string") {
		content.text += item;
		return;
	}

	try {
		content.text += JSON.stringify(item);
	} catch {
		/* ignore */
	}
}

function collectToolResultContent(
	pr: vscode.LanguageModelToolResultPart,
	gates: DataPartWireGates,
	logDrop: LogFn
): ToolResultContent {
	const content: ToolResultContent = { text: "", images: [] };
	for (const item of pr.content ?? []) {
		collectToolResultItem(item, gates, content, logDrop);
	}
	return content;
}

/**
 * A constant, never response-derived text: it tells the model these blocks are tool output, not a new user question.
 */
const TOOL_IMAGES_LEAD_IN = "Images returned by the tool calls above:";

type ThinkingHistoryEntry =
	| { kind: "unsigned"; text: string }
	| { kind: "signed"; text: string; signature: string }
	| { kind: "redacted"; data: string };

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

interface FoldedThinking {
	readonly blocks: OpenAIThinkingBlock[];
	/** The unsigned text no signature closed: a provider that never signs (DeepSeek's reasoning_content) leaves all of it here. */
	readonly unsignedText: string;
}

/**
 * Signatures may stream in a separate, empty-text part after the text they sign, so unsigned text accumulates until a
 * signature closes the block and belongs to that block. What no signature closed is returned beside the blocks: the
 * caller replays it as reasoning_content when the model's capability says so, and drops it otherwise, since Anthropic
 * rejects replayed thinking it did not sign.
 */
function foldThinkingBlocks(entries: readonly ThinkingHistoryEntry[]): FoldedThinking {
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
	return { blocks, unsignedText: pendingText };
}

/** A message waiting for the open tool turns to close, with the images its tool result returned. */
interface DeferredMessage {
	readonly message: OpenAIChatMessage;
	readonly toolImages: OpenAIChatImageUrlContentBlock[] | undefined;
}

/**
 * The wire order the backend requires, kept while the turns arrive in history order.
 *
 *   every tool message of a tool_calls turn directly follows its assistant message -> while any call is open,
 *     everything but its answers defers until the turns close (tool calls may ride non-assistant messages with their
 *     answers arriving messages later, so the adjacency rule needs this wire-level guarantee)
 *   the images a tool returned ride one user message per turn, after its last tool message -> the flush waits for the
 *     first non-tool message, never interleaved
 */
class WireMessageOrder {
	private readonly out: OpenAIChatMessage[] = [];

	private pendingToolImages: OpenAIChatImageUrlContentBlock[] = [];

	private readonly openCalls = new Map<string, number>();

	private openTotal = 0;

	private readonly deferred: DeferredMessage[] = [];

	/**
	 * Drains by first-emittable, not head-only: emitting a deferred tool_calls message reopens a turn, and its answers
	 * may sit behind other deferrals. Terminates because every iteration removes one entry.
	 */
	push(message: OpenAIChatMessage, toolImages?: OpenAIChatImageUrlContentBlock[]): void {
		if (this.mustDefer(message)) {
			this.deferred.push({ message, toolImages });
			return;
		}

		this.emit(message, toolImages);
		for (;;) {
			const index = this.deferred.findIndex((entry) => !this.mustDefer(entry.message));
			if (index < 0) {
				break;
			}
			const [entry] = this.deferred.splice(index, 1);
			if (entry) {
				this.emit(entry.message, entry.toolImages);
			}
		}
	}

	/**
	 * Every message in wire order. Only a call that never got its answer leaves a deferral behind; validation rejects
	 * such histories before send, but conversion stays total.
	 */
	finish(): OpenAIChatMessage[] {
		for (const entry of this.deferred) {
			this.emit(entry.message, entry.toolImages);
		}

		this.flushToolImages();

		return this.out;
	}

	private mustDefer(message: OpenAIChatMessage): boolean {
		return this.openTotal > 0 && !(message.role === "tool" && (this.openCalls.get(message.tool_call_id) ?? 0) > 0);
	}

	private emit(message: OpenAIChatMessage, toolImages: OpenAIChatImageUrlContentBlock[] | undefined): void {
		if (message.role !== "tool") {
			this.flushToolImages();
		}

		this.trackOpenCalls(message);
		this.out.push(message);
		if (toolImages) {
			// Attached only now, so a deferred tool message's images cannot flush ahead of the tool message they came
			// from.
			this.pendingToolImages.push(...toolImages);
		}
	}

	private trackOpenCalls(message: OpenAIChatMessage): void {
		if (message.role === "assistant") {
			for (const call of message.tool_calls ?? []) {
				this.openCalls.set(call.id, (this.openCalls.get(call.id) ?? 0) + 1);
				this.openTotal++;
			}
			return;
		}

		if (message.role !== "tool") {
			return;
		}

		const count = this.openCalls.get(message.tool_call_id) ?? 0;
		if (count > 0) {
			this.openCalls.set(message.tool_call_id, count - 1);
			this.openTotal--;
		}
	}

	private flushToolImages(): void {
		if (this.pendingToolImages.length === 0) {
			return;
		}

		this.out.push({ role: "user", content: [{ type: "text", text: TOOL_IMAGES_LEAD_IN }, ...this.pendingToolImages] });
		this.pendingToolImages = [];
	}
}

/** What every message of one conversion shares. */
interface Conversion {
	readonly gates: DataPartWireGates;
	readonly pairing: ToolCallPairing;
	readonly replayReasoningContent: boolean;
	readonly logDrop: LogFn;
}

/** One history message's role and parts, the parts sorted by what each becomes on the wire. */
interface MessageParts {
	readonly role: Exclude<OpenAIChatRole, "tool">;
	readonly textParts: string[];
	readonly toolCalls: OpenAIToolCall[];
	readonly toolResults: { callId: string; content: ToolResultContent }[];
	readonly contentBlocks: OpenAIChatContentBlock[];
	readonly thinkingEntries: ThinkingHistoryEntry[];
}

/** The reasoning an assistant message replays; see OpenAIAssistantMessage.reasoning_content. */
type ThinkingFields = Pick<OpenAIAssistantMessage, "thinking_blocks" | "reasoning_content">;

/**
 * A log that fires once per conversion: a media-heavy history would otherwise evict the whole issue-report buffer on
 * every turn, whether the part rode a tool result or a turn of its own.
 */
function logOnce(log: LogFn | undefined): LogFn {
	let logged = false;

	return (message, data) => {
		if (logged) {
			return;
		}
		logged = true;
		log?.(message, data);
	};
}

/**
 * The wire form of a tool call. `?? "{}"`: stringify returns undefined for an input whose toJSON yields no rendering,
 * and the wire requires an arguments string.
 */
function toolCallOf(part: vscode.LanguageModelToolCallPart, id: string): OpenAIToolCall {
	let args: string;
	try {
		args = JSON.stringify(part.input ?? {}) ?? "{}";
	} catch {
		args = "{}";
	}

	return { id, type: "function", function: { name: part.name, arguments: args } };
}

/**
 * Only user messages carry binary content blocks on the wire, so assistant-side media resolves to "text" or "none" and
 * the turn's TEXT is always kept - moving it into contentBlocks would hand it to a branch only user messages drain.
 * The mime is model-controlled on assistant turns and this log feeds the issue-report buffer, so it is allowlisted by
 * shape.
 */
function collectDataPart(part: vscode.LanguageModelDataPart, parts: MessageParts, conversion: Conversion): void {
	const wire = dataPartWireForm(part.mimeType, parts.role === "user" ? "user" : "assistant", conversion.gates);
	const block = convertDataPartToContentBlock(part, wire);
	if (block) {
		if (parts.textParts.length > 0) {
			parts.contentBlocks.push({ type: "text", text: parts.textParts.join("") });
			parts.textParts.length = 0;
		}
		parts.contentBlocks.push(block);
		return;
	}

	const decoded = decodeDataPartText(part);
	if (decoded !== null) {
		parts.textParts.push(decoded);
		return;
	}

	conversion.logDrop("Skipping LanguageModelDataPart with no wire mapping", {
		role: parts.role,
		mimeType: isSafeMimeType(part.mimeType) ? part.mimeType : "unparseable",
	});
}

/** One part into the message's parts; `wireId` is the pairing's id for this part, given its raw one. */
function collectPart(
	part: unknown,
	wireId: (raw: string) => string,
	parts: MessageParts,
	conversion: Conversion
): void {
	if (part instanceof vscode.LanguageModelTextPart) {
		parts.textParts.push(part.value);
		return;
	}

	if (part instanceof vscode.LanguageModelToolCallPart) {
		parts.toolCalls.push(toolCallOf(part, wireId(part.callId)));
		return;
	}

	if (isToolResultPart(part)) {
		parts.toolResults.push({
			callId: wireId(part.callId),
			content: collectToolResultContent(part, conversion.gates, conversion.logDrop),
		});
		return;
	}

	if (part instanceof vscode.LanguageModelDataPart) {
		collectDataPart(part, parts, conversion);
		return;
	}

	if (part instanceof vscode.LanguageModelPromptTsxPart) {
		const extracted = extractPromptTsxText(part);
		if (extracted) {
			parts.textParts.push(extracted);
		}
		return;
	}

	const thinkingEntry = parts.role === "assistant" ? extractThinkingHistoryEntry(part) : undefined;
	if (thinkingEntry) {
		parts.thinkingEntries.push(thinkingEntry);
	}
}

function collectMessageParts(
	message: vscode.LanguageModelChatRequestMessage,
	messageIndex: number,
	role: Exclude<OpenAIChatRole, "tool">,
	conversion: Conversion
): MessageParts {
	const parts: MessageParts = {
		role,
		textParts: [],
		toolCalls: [],
		toolResults: [],
		contentBlocks: [],
		thinkingEntries: [],
	};
	for (const [partIndex, part] of (message.content ?? []).entries()) {
		// The pairing covers every tool-call part; `?? raw` only satisfies the type.
		const wireId = (raw: string): string => conversion.pairing.wireIds.get(wireIdKey(messageIndex, partIndex)) ?? raw;
		collectPart(part, wireId, parts, conversion);
	}
	return parts;
}

/** Every assistant message of the turn carries these, a turn with no reasoning included: DeepSeek checks presence. */
function thinkingFieldsOf(folded: FoldedThinking, replayReasoningContent: boolean): ThinkingFields {
	const thinking: ThinkingFields = {};
	if (folded.blocks.length > 0) {
		thinking.thinking_blocks = folded.blocks;
	}

	if (replayReasoningContent) {
		thinking.reasoning_content = folded.unsignedText;
	}

	return thinking;
}

/**
 * The turn's own content message, or none when it has nothing to say: a user turn with media ships a content array,
 * an assistant turn its text (a tool_calls turn's text already rode that message), and an assistant turn with a signed
 * thinking block but no text or tool calls an empty content, so the block still replays.
 */
function ownMessageOf(parts: MessageParts, thinking: ThinkingFields): OpenAIChatMessage | undefined {
	const { role, textParts, toolCalls, contentBlocks } = parts;
	if (role === "user" && contentBlocks.length > 0) {
		if (textParts.length > 0) {
			contentBlocks.push({ type: "text", text: textParts.join("") });
		}

		return { role, content: contentBlocks };
	}

	if (role === "assistant") {
		const text = toolCalls.length === 0 ? textParts.join("") : "";
		if (text) {
			return { role, content: text, ...thinking };
		}

		if (toolCalls.length === 0 && thinking.thinking_blocks !== undefined) {
			return { role, content: "", ...thinking };
		}

		return undefined;
	}

	const text = textParts.join("");

	return text ? { role, content: text } : undefined;
}

/**
 * One history message's wire messages, in the order the backend reads them: the tool_calls turn, its tool results,
 * then the turn's own content.
 */
function emitMessage(order: WireMessageOrder, parts: MessageParts, replayReasoningContent: boolean): void {
	const thinking = thinkingFieldsOf(foldThinkingBlocks(parts.thinkingEntries), replayReasoningContent);

	if (parts.toolCalls.length > 0) {
		order.push({
			role: "assistant",
			// A non-assistant turn's text stays on its own message below;
			// copying it here would ship it twice and misattribute the speaker.
			content: (parts.role === "assistant" ? parts.textParts.join("") : "") || undefined,
			tool_calls: parts.toolCalls,
			...thinking,
		});
	}

	for (const tr of parts.toolResults) {
		order.push({ role: "tool", tool_call_id: tr.callId, content: tr.content.text }, tr.content.images);
	}

	const own = ownMessageOf(parts, thinking);
	if (own !== undefined) {
		order.push(own);
	}
}

/** Prompt-cache markers are not placed here; promptCache.ts owns them as a pass over the converted request. */
export function convertMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	options?: ConvertMessagesOptions
): OpenAIChatMessage[] {
	const log = options?.log;
	// One pairing decides every wire id; validation rejects on the same analysis, so both halves of a pair always ship
	// the same id.
	const conversion: Conversion = {
		gates: { imageInput: options?.imageInput === true, audioInput: options?.audioInput === true },
		pairing: pairToolCallIds(messages),
		replayReasoningContent: options?.replayReasoningContent === true,
		logDrop: logOnce(log),
	};

	const order = new WireMessageOrder();
	for (const [messageIndex, message] of messages.entries()) {
		const parts = collectMessageParts(message, messageIndex, mapRole(message, log), conversion);
		emitMessage(order, parts, conversion.replayReasoningContent);
	}

	return order.finish();
}
