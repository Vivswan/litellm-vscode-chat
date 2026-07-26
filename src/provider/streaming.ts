import * as vscode from "vscode";
import { tryParseJSONObject } from "../shared/json";
import type { ThinkingPartCtor } from "../shared/thinkingPart";
import {
	logMissingThinkingPartSupportOnce,
	logThinkingPartProbeErrorOnce,
	thinkingPartCtor,
} from "../shared/thinkingPart";
import type { TextParseResult, TextToolCall } from "./textToolCallParser";
import { isTruncatedToolCallText, TextToolCallParser } from "./textToolCallParser";
import type {
	ChatCompletionChunk,
	ChunkChoice,
	ChunkDelta,
	ThinkingBlock,
	ThinkingBlockDelta,
	ToolCallBuffer,
} from "./wire";
import { parseChunk } from "./wire";

/**
 * Hands out tool-call ID numbers. Owned by the ChatClient and shared across
 * concurrent requests, so next() must advance state synchronously: two
 * overlapping streams may interleave calls but can never receive the same ID.
 */
export interface ToolCallIdSource {
	next(): number;
}

interface ThinkingContent {
	text: string;
	id?: string | undefined;
	metadata?: unknown;
}

function structuredThinkingContents(raw: string | ThinkingBlock | undefined): ThinkingContent[] {
	if (raw === undefined) {
		return [];
	}
	if (typeof raw === "string") {
		return raw ? [{ text: raw }] : [];
	}
	const text = typeof raw.text === "string" ? raw.text : "";
	return text ? [{ text, id: raw.id, metadata: raw.metadata }] : [];
}

function thinkingBlockContents(blocks: readonly ThinkingBlockDelta[] | undefined): ThinkingContent[] {
	if (!blocks) {
		return [];
	}
	return blocks.flatMap((block): ThinkingContent[] => {
		if (block.type === "redacted_thinking") {
			return block.data ? [{ text: "", metadata: { type: block.type, data: block.data } }] : [];
		}
		const text = block.thinking ?? "";
		const metadata = block.signature !== undefined ? { type: block.type, signature: block.signature } : undefined;
		return text || metadata ? [{ text, metadata }] : [];
	});
}

/**
 * Extract thinking/reasoning content from a streaming choice. Covers the four
 * provider formats: a structured thinking object (choice- or delta-level), a
 * thinking_blocks array (Anthropic extended thinking via LiteLLM, whose text
 * duplicates reasoning_content but whose signature and redacted data exist
 * nowhere else), a reasoning_content string, and a reasoning string. Each
 * format wins only when it yields usable content, so an empty higher-priority
 * field never suppresses a populated lower-priority one.
 */
function extractThinking(choice: ChunkChoice, delta: ChunkDelta | undefined): ThinkingContent[] {
	const choiceStructured = structuredThinkingContents(choice.thinking);
	if (choiceStructured.length > 0) {
		return choiceStructured;
	}
	const deltaStructured = structuredThinkingContents(delta?.thinking);
	if (deltaStructured.length > 0) {
		return deltaStructured;
	}
	const blocks = thinkingBlockContents(delta?.thinking_blocks);
	if (blocks.length > 0) {
		return blocks;
	}
	const reasoning = delta?.reasoning_content || delta?.reasoning;
	return reasoning ? [{ text: reasoning }] : [];
}

function normalizeToolCallIndex(index: number | string | undefined): number {
	if (typeof index === "number") {
		return index;
	}
	if (typeof index === "string" && index.trim() !== "") {
		const parsed = Number(index);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return 0;
}

interface RequestState {
	toolCallBuffers: Map<number, ToolCallBuffer>;
	completedToolCallIndices: Set<number>;
	hasEmittedAssistantText: boolean;
	emittedBeginToolCallsHint: boolean;
	textParser: TextToolCallParser;
	/** Inline calls already decided (emitted or deduped) while provisional, so their completion is not re-emitted. */
	handledTextCallSeqs: Set<number>;
	/** name:index pairs from inline headers, deduping re-sent inline calls that carry an explicit index. */
	inlineEmittedIndexIds: Set<string>;
	/** name:args keys of emitted inline calls, deduping re-sent inline calls without an explicit index. */
	inlineEmittedContentKeys: Set<string>;
	/**
	 * Per-channel counts of emitted name:args keys. A call arriving on one
	 * channel consumes one pending count from the other channel (the same call
	 * surfaced twice) and is suppressed; with no pending count it emits and
	 * increments its own channel. N delta plus M inline occurrences of the same
	 * key therefore emit max(N, M) calls, so identical parallel calls on one
	 * channel all survive while cross-channel duplicates collapse in either
	 * arrival order.
	 */
	deltaEmittedCounts: Map<string, number>;
	inlineEmittedCounts: Map<string, number>;
	/** Whether a refusal delta was already logged for this request. */
	loggedRefusal: boolean;
	/** Citation URL to title, collected from annotation deltas and emitted once at end of stream. */
	citations: Map<string, string>;
	/** Set once the citations trailer has been emitted; finishStream runs more than once per stream. */
	emittedCitations: boolean;
}

function freshRequestState(): RequestState {
	return {
		toolCallBuffers: new Map(),
		completedToolCallIndices: new Set(),
		hasEmittedAssistantText: false,
		emittedBeginToolCallsHint: false,
		textParser: new TextToolCallParser(),
		handledTextCallSeqs: new Set(),
		inlineEmittedIndexIds: new Set(),
		inlineEmittedContentKeys: new Set(),
		deltaEmittedCounts: new Map(),
		inlineEmittedCounts: new Map(),
		loggedRefusal: false,
		citations: new Map(),
		emittedCitations: false,
	};
}

export class StreamProcessor {
	private _req: RequestState;
	private _toolCallIds: ToolCallIdSource;
	private _log: (message: string, data?: unknown) => void;
	private _thinkingPartCtor: ThinkingPartCtor | undefined;

	constructor(
		toolCallIds: ToolCallIdSource,
		log: (message: string, data?: unknown) => void,
		partCtor: ThinkingPartCtor | null | undefined = thinkingPartCtor
	) {
		this._req = freshRequestState();
		this._toolCallIds = toolCallIds;
		this._log = log;
		this._thinkingPartCtor = partCtor ?? undefined;
		if (partCtor === thinkingPartCtor) {
			logThinkingPartProbeErrorOnce(this._log);
		}
	}

	resetState(): void {
		this._req = freshRequestState();
	}

	async processStreamingResponse(
		responseBody: ReadableStream<Uint8Array>,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		const reader = responseBody.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (!token.isCancellationRequested) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (!line.startsWith("data: ")) {
						continue;
					}
					const data = line.slice(6);
					if (data === "[DONE]") {
						this.finishStream(progress, !token.isCancellationRequested);
						continue;
					}

					let chunk: ChatCompletionChunk | undefined;
					try {
						chunk = parseChunk(JSON.parse(data));
					} catch (e) {
						this._log("Skipping malformed SSE line", { error: String(e), data: data.slice(0, 200) });
						continue;
					}
					if (!chunk) {
						this._log("Skipping malformed SSE line", { data: data.slice(0, 200) });
						continue;
					}
					this.processDelta(chunk, progress, token);
				}
			}
			this.finishStream(progress, !token.isCancellationRequested);
		} finally {
			try {
				reader.releaseLock();
			} catch {
				// The stream may already be errored (e.g. aborted fetch); the lock is moot then.
			}
			this._req = freshRequestState();
		}
	}

	processDelta(
		chunk: ChatCompletionChunk,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token?: vscode.CancellationToken
	): boolean {
		let emitted = false;

		if (chunk.usage) {
			this._log("Token usage", chunk.usage);
		}

		const choice = chunk.choices?.[0];
		if (!choice) {
			return false;
		}
		const delta = choice.delta;

		// Thinking parts pass through as-is: the host merges adjacent thinking
		// parts itself (empty chunks and non-thinking output separate runs) and
		// mints an id when a part has none, so minting ids here would only risk
		// colliding with wire ids or the host's thinking-title cache.
		const thinkingContents = extractThinking(choice, delta);
		if (thinkingContents.length > 0 && !this._thinkingPartCtor) {
			logMissingThinkingPartSupportOnce(this._log);
		}
		if (this._thinkingPartCtor) {
			for (const thinking of thinkingContents) {
				let part: vscode.LanguageModelResponsePart | undefined;
				try {
					part = new this._thinkingPartCtor(thinking.text, thinking.id, thinking.metadata);
				} catch (e) {
					this._log("Failed to construct thinking part", { error: String(e) });
				}
				if (part) {
					progress.report(part);
					emitted = true;
				}
			}
		}

		if (delta?.refusal) {
			if (!this._req.loggedRefusal) {
				this._req.loggedRefusal = true;
				// No content: refusal text can echo user data into issue reports.
				this._log("Model refused the request");
			}
			progress.report(new vscode.LanguageModelTextPart(delta.refusal));
			this._req.hasEmittedAssistantText = true;
			emitted = true;
		}

		if (delta?.annotations) {
			for (const annotation of delta.annotations) {
				const url = annotation.url_citation?.url;
				if (url && !this._req.citations.has(url)) {
					this._req.citations.set(url, annotation.url_citation?.title ?? url);
				}
			}
		}

		if (delta?.content !== undefined && delta.content !== null) {
			const texts =
				typeof delta.content === "string"
					? [delta.content]
					: delta.content.flatMap((block) =>
							block.type === "text" && typeof block.text === "string" ? [block.text] : []
						);
			for (const text of texts) {
				const res = this.processTextContent(text, progress);
				if (res.emittedText) {
					this._req.hasEmittedAssistantText = true;
				}
				if (res.emittedAny) {
					emitted = true;
				}
			}
		}

		if (delta?.tool_calls) {
			if (!this._req.emittedBeginToolCallsHint && this._req.hasEmittedAssistantText && delta.tool_calls.length > 0) {
				progress.report(new vscode.LanguageModelTextPart(" "));
				this._req.emittedBeginToolCallsHint = true;
			}

			for (const tc of delta.tool_calls) {
				const idx = normalizeToolCallIndex(tc.index);
				if (this._req.completedToolCallIndices.has(idx)) {
					continue;
				}
				const buf = this._req.toolCallBuffers.get(idx) ?? { args: "" };
				if (tc.id) {
					buf.id = tc.id;
				}
				if (tc.function?.name) {
					buf.name = tc.function.name;
				}
				if (typeof tc.function?.arguments === "string") {
					buf.args += tc.function.arguments;
				}
				this._req.toolCallBuffers.set(idx, buf);

				this.tryEmitBufferedToolCall(idx, progress);
			}
		}

		if (choice.finish_reason === "tool_calls" || choice.finish_reason === "stop") {
			this.finishStream(progress, !token?.isCancellationRequested);
		}

		return emitted;
	}

	processTextContent(
		input: string,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>
	): { emittedText: boolean; emittedAny: boolean } {
		return this.handleTextParse(this._req.textParser.push(input), progress);
	}

	private handleTextParse(
		result: TextParseResult,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>
	): { emittedText: boolean; emittedAny: boolean } {
		let emittedText = false;
		let emittedAny = false;

		for (const event of result.events) {
			if (event.type === "text") {
				progress.report(new vscode.LanguageModelTextPart(event.text));
				emittedText = true;
				emittedAny = true;
				continue;
			}
			const call = event.call;
			if (this._req.handledTextCallSeqs.has(call.seq)) {
				continue;
			}
			const parsed = tryParseJSONObject(call.args);
			if (!parsed.ok) {
				this._log("Dropping inline tool call with invalid JSON arguments", {
					name: call.name,
					snippet: call.args.slice(0, 200),
				});
				continue;
			}
			if (this.emitInlineToolCall(call, parsed.value, progress)) {
				emittedAny = true;
			}
		}

		const provisional = result.provisionalCall;
		if (provisional && !this._req.handledTextCallSeqs.has(provisional.seq)) {
			const parsed = tryParseJSONObject(provisional.args);
			if (parsed.ok) {
				this._req.handledTextCallSeqs.add(provisional.seq);
				if (this.emitInlineToolCall(provisional, parsed.value, progress)) {
					emittedAny = true;
				}
			}
		}

		return { emittedText, emittedAny };
	}

	private emitInlineToolCall(
		call: TextToolCall,
		parsedArgs: Record<string, unknown>,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>
	): boolean {
		const name = call.name ?? "unknown_tool";
		const contentKey = `${name}:${JSON.stringify(parsedArgs)}`;
		if (typeof call.index === "number") {
			if (this._req.inlineEmittedIndexIds.has(`${name}:${call.index}`)) {
				return false;
			}
		} else if (this._req.inlineEmittedContentKeys.has(contentKey)) {
			return false;
		}
		const emitted = this.emitToolCall(progress, { name, parsedArgs });
		// Registered even when suppressed as a cross-channel duplicate: either way
		// this inline call is accounted for, and a replay of it must not emit.
		if (typeof call.index === "number") {
			this._req.inlineEmittedIndexIds.add(`${name}:${call.index}`);
		}
		this._req.inlineEmittedContentKeys.add(contentKey);
		return emitted;
	}

	private emitToolCall(
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		call: { id?: string | undefined; name: string; parsedArgs: Record<string, unknown> },
		bufferIndex?: number
	): boolean {
		const source = bufferIndex === undefined ? "inline" : "delta";
		const key = `${call.name}:${JSON.stringify(call.parsedArgs)}`;
		const ownCounts = source === "inline" ? this._req.inlineEmittedCounts : this._req.deltaEmittedCounts;
		const otherCounts = source === "inline" ? this._req.deltaEmittedCounts : this._req.inlineEmittedCounts;

		const retireBuffer = () => {
			if (bufferIndex !== undefined) {
				this._req.toolCallBuffers.delete(bufferIndex);
				this._req.completedToolCallIndices.add(bufferIndex);
			}
		};

		const pending = otherCounts.get(key) ?? 0;
		if (pending > 0) {
			if (pending === 1) {
				otherCounts.delete(key);
			} else {
				otherCounts.set(key, pending - 1);
			}
			retireBuffer();
			this._log("Suppressing tool call already emitted via the other channel", { name: call.name, source });
			return false;
		}

		ownCounts.set(key, (ownCounts.get(key) ?? 0) + 1);
		const id = call.id ?? `call_${this._toolCallIds.next()}`;
		progress.report(new vscode.LanguageModelToolCallPart(id, call.name, call.parsedArgs));
		retireBuffer();
		return true;
	}

	private tryEmitBufferedToolCall(index: number, progress: vscode.Progress<vscode.LanguageModelResponsePart>): void {
		const buf = this._req.toolCallBuffers.get(index);
		if (!buf?.name) {
			return;
		}
		const parsed = tryParseJSONObject(buf.args);
		if (!parsed.ok) {
			return;
		}
		this.emitToolCall(progress, { id: buf.id, name: buf.name, parsedArgs: parsed.value }, index);
	}

	/** Flushes every buffer, logging each invalid one; returns the invalid count. */
	private flushToolCallBuffers(progress: vscode.Progress<vscode.LanguageModelResponsePart>): number {
		let invalidCount = 0;
		for (const [index, buf] of Array.from(this._req.toolCallBuffers.entries())) {
			const parsed = tryParseJSONObject(buf.args);
			if (!parsed.ok) {
				this._log("Invalid JSON for tool call", { index, snippet: (buf.args || "").slice(0, 200) });
				invalidCount++;
				this._req.toolCallBuffers.delete(index);
				continue;
			}
			this.emitToolCall(progress, { id: buf.id, name: buf.name ?? "unknown_tool", parsedArgs: parsed.value }, index);
		}
		return invalidCount;
	}

	/**
	 * Single end-of-stream path shared by finish_reason, [DONE], and EOF.
	 * Every dropped buffer is logged first; unparseable leftovers then throw
	 * when throwOnInvalid is set (i.e. unless the request was cancelled).
	 */
	private finishStream(progress: vscode.Progress<vscode.LanguageModelResponsePart>, throwOnInvalid: boolean): void {
		let invalidCount = this.flushToolCallBuffers(progress);

		const rest = this._req.textParser.flush();
		const call = rest.provisionalCall;
		if (call && !this._req.handledTextCallSeqs.has(call.seq)) {
			const parsed = tryParseJSONObject(call.args);
			if (parsed.ok) {
				this._req.handledTextCallSeqs.add(call.seq);
				this.emitInlineToolCall(call, parsed.value, progress);
			} else {
				this._log("Dropping unterminated inline tool call with invalid JSON arguments", {
					name: call.name,
					snippet: call.args.slice(0, 200),
				});
				invalidCount++;
			}
		}
		const trailingText = rest.events
			.filter((e): e is { type: "text"; text: string } => e.type === "text")
			.map((e) => e.text)
			.join("");
		if (trailingText) {
			// Held-back text that turned out to be a truncated tool-call token is
			// dropped as before; anything else is legitimate output the hold-back
			// delayed (a one-shot parse of the full text would have emitted it).
			if (isTruncatedToolCallText(trailingText)) {
				this._log("Dropping trailing partial control token text at end of stream", {
					text: trailingText.slice(0, 200),
				});
			} else {
				progress.report(new vscode.LanguageModelTextPart(trailingText));
			}
		}

		if (this._req.citations.size > 0 && !this._req.emittedCitations) {
			this._req.emittedCitations = true;
			const escapeTitle = (title: string) => title.replace(/[\r\n]+/g, " ").replace(/[[\]\\]/g, "\\$&");
			// encodeURIComponent leaves "(" and ")" alone, and those break
			// markdown link targets; everything else needs UTF-8-safe encoding.
			const escapeUrl = (url: string) =>
				url.replace(/[\s()]/g, (c) => (c === "(" ? "%28" : c === ")" ? "%29" : encodeURIComponent(c)));
			const lines = Array.from(this._req.citations.entries()).map(
				([url, title]) => `- [${escapeTitle(title)}](${escapeUrl(url)})`
			);
			progress.report(new vscode.LanguageModelTextPart(`\n\nSources:\n${lines.join("\n")}`));
		}

		if (invalidCount > 0 && throwOnInvalid) {
			throw new Error("Invalid JSON for tool call");
		}
	}
}
