import * as vscode from "vscode";
import type {
	CacheControl,
	OpenAIChatContentBlock,
	OpenAIChatFileContentBlock,
	OpenAIChatImageUrlContentBlock,
	OpenAIChatMessage,
	OpenAIChatRole,
	OpenAIToolCall,
} from "../types";

function isImageMimeType(mime: string): boolean {
	return mime.toLowerCase().startsWith("image/");
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

/** Cache TTL accepted by the breakpoint helpers. "5m" omits the wire field. */
export type AnchorTtl = "5m" | "1h";

/**
 * Build a `cache_control` object, omitting `ttl` for the default 5m tier.
 * Returns the shared {@link CacheControl} wire type so the on-the-wire shape
 * stays in one place (see `types.ts`).
 */
function buildCacheControl(ttl: AnchorTtl): CacheControl {
	return ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

/** Numeric rank for a TTL so we can compare lifetimes (1h > 5m). */
function ttlRank(ttl: AnchorTtl): number {
	return ttl === "1h" ? 1 : 0;
}

/** Numeric rank for an existing wire `cache_control` marker. */
function existingTtlRank(cc: CacheControl | undefined): number {
	if (!cc) {
		return -1;
	}
	return cc.ttl === "1h" ? 1 : 0;
}

/**
 * Apply an Anthropic ephemeral cache breakpoint to a message by tagging its
 * last text content block. String content is promoted to a single text block.
 * Returns true if a breakpoint is present on the block after this call.
 *
 * Upgrade-only: if the target block already carries a `cache_control` marker
 * with a *longer* lifetime (e.g. firstUser already tagged it 1h), we keep the
 * longer one rather than demoting it to the requested (shorter) TTL. This
 * prevents the rolling-last anchor (always 5m) from silently downgrading a
 * first-user 1h anchor when both land on the same message — which would also
 * violate Bedrock's non-increasing-TTL ordering invariant.
 */
function applyCacheControlToMessage(msg: OpenAIChatMessage, ttl: AnchorTtl): boolean {
	if (typeof msg.content === "string") {
		if (msg.content.length === 0) {
			return false;
		}
		msg.content = [{ type: "text", text: msg.content, cache_control: buildCacheControl(ttl) }];
		return true;
	}
	if (Array.isArray(msg.content) && msg.content.length > 0) {
		for (let i = msg.content.length - 1; i >= 0; i--) {
			const block = msg.content[i];
			if (block.type === "text") {
				// Only overwrite when the new TTL is at least as long-lived as any
				// existing marker; never demote a longer cache lifetime.
				if (ttlRank(ttl) >= existingTtlRank(block.cache_control)) {
					block.cache_control = buildCacheControl(ttl);
				}
				return true;
			}
		}
	}
	return false;
}

/**
 * Placement strategy for the rolling-last cache_control breakpoint.
 *  - "always":          tag whatever the last message is.
 *  - "stableTurnsOnly": skip the rolling-last breakpoint when the last message
 *                       is a tool result (role: "tool"). Walks backward and
 *                       tags the first non-tool message instead. This avoids
 *                       anchoring the cache on tool-result bytes that VS Code
 *                       may re-render or truncate between turns.
 *  - "never":           never place a rolling-last breakpoint. Static anchors
 *                       (tools / system / first user) still fire when their
 *                       respective specs are set.
 */
export type RollingPlacement = "always" | "stableTurnsOnly" | "never";

/** Per-anchor cache spec. `undefined` means "do not place this anchor". */
export interface AnchorSpec {
	ttl: AnchorTtl;
}

/** Rolling-last anchor spec: a TTL plus a placement strategy. */
export interface RollingSpec extends AnchorSpec {
	placement: RollingPlacement;
}

/** Cache plan consumed by {@link convertMessages}. */
export interface MessageCacheSpec {
	/** Tag the system prompt at this TTL. Omit to skip. */
	system?: AnchorSpec;
	/** Tag the first user message at this TTL. Omit to skip. */
	firstUser?: AnchorSpec;
	/** Rolling-last anchor. Omit to skip. */
	rolling?: RollingSpec;
}

/**
 * Convert VS Code chat request messages into OpenAI-compatible message objects.
 *
 * `cache` is a resolved per-anchor plan (see {@link MessageCacheSpec}). Each
 * present anchor places a `cache_control` marker at its specified TTL; absent
 * anchors are skipped. Note the tools anchor is handled separately in
 * `convertTools`.
 *
 * `placedRollingOn` is an optional out-parameter: if provided, its `role` field
 * is filled with the role of the message that received the rolling-last marker
 * ("user" / "assistant" / "tool" / "system"), or "skipped" when no marker was
 * placed. ("system" can occur when the only cacheable tail is a leading system
 * message — e.g. a system-only transcript with placement "always".)
 */
export function convertMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	options?: {
		cache?: MessageCacheSpec;
		placedRollingOn?: { role: string };
	}
): OpenAIChatMessage[] {
	const out: OpenAIChatMessage[] = [];
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
				out.push({ role, content: text });
			}
		}
	}

	// System-prompt breakpoint: VS Code can split the leading system prompt
	// across multiple messages. Tag only the final leading system message so the
	// cached prefix still covers the entire system block without consuming more
	// than one of Anthropic's four allowed cache_control breakpoints.
	if (options?.cache?.system && out.length > 0) {
		let lastLeadingSystem: OpenAIChatMessage | undefined;
		for (const msg of out) {
			if (msg.role !== "system") {
				break;
			}
			lastLeadingSystem = msg;
		}
		if (lastLeadingSystem) {
			applyCacheControlToMessage(lastLeadingSystem, options.cache.system.ttl);
		}
	}

	// First-user-message breakpoint: tag the first user message so its prefix
	// (tools + system + first user turn) becomes a long-lived cacheable anchor.
	// Why: in long agent runs the very first user prompt + the system prompt +
	// the tools array form a multi-thousand-token block that is byte-identical
	// for every subsequent turn. A breakpoint here guarantees that block is
	// cached even if the rolling-conversation breakpoint moves to a later
	// message that diverges between turns. Anthropic allows up to 4 breakpoints
	// (system + tools + first-user + rolling-last = 4) so this stays in budget.
	if (options?.cache?.firstUser && out.length > 0) {
		const firstUserTtl = options.cache.firstUser.ttl;
		for (const msg of out) {
			if (msg.role === "user" && applyCacheControlToMessage(msg, firstUserTtl)) {
				break;
			}
		}
	}

	// Rolling conversation breakpoint: tag the last message so the entire
	// prefix (system + tools + prior turns) is cached and reused on the next
	// agent round-trip. Anthropic allows up to 4 breakpoints; combined with the
	// single system-prompt, last-tool, and first-user breakpoints this stays within
	// budget. If the rolling tag lands on the same message as the first-user
	// tag (only one user message in the conversation), the helper is idempotent
	// and we still emit a single cache_control marker for that message.
	//
	// Placement strategy (orthogonal to TTL):
	//   "always"          -> tag the last message regardless of role.
	//   "stableTurnsOnly" -> skip role:"tool" tails (volatile bytes); tag the
	//                        first non-tool message walking backwards.
	//   "never"           -> place no rolling marker (spec absent).
	const rolling = options?.cache?.rolling;
	if (rolling && rolling.placement !== "never" && out.length > 0) {
		const skipToolResults = rolling.placement === "stableTurnsOnly";
		for (let i = out.length - 1; i >= 0; i--) {
			const msg = out[i];
			if (skipToolResults && msg.role === "tool") {
				continue;
			}
			if (applyCacheControlToMessage(msg, rolling.ttl)) {
				if (options?.placedRollingOn) {
					options.placedRollingOn.role = msg.role;
				}
				break;
			}
		}
	}

	if (options?.placedRollingOn && !options.placedRollingOn.role) {
		options.placedRollingOn.role = "skipped";
	}

	return out;
}
