import * as vscode from "vscode";
import { tryParseJSONObject } from "../shared/json";
import type { ChatCompletionChunk, ChunkChoice, ChunkDelta, ToolCallBuffer } from "../types";
import { parseChunk } from "../types";
import type { TextParseResult, TextToolCall } from "./textToolCallParser";
import { TextToolCallParser } from "./textToolCallParser";

export type ThinkingPartCtor = new (text: string, id?: string, metadata?: unknown) => vscode.LanguageModelResponsePart;

/**
 * Hands out tool-call ID numbers. Owned by the ChatClient and shared across
 * concurrent requests, so next() must advance state synchronously — two
 * overlapping streams may interleave calls but can never receive the same ID.
 */
export interface ToolCallIdSource {
	next(): number;
}

// LanguageModelThinkingPart is still a proposed API, and hosts may expose
// proposed classes behind throwing getters, so the single property read is
// probed once at module load. A probe failure is kept for the processor to log.
const defaultThinkingProbe: { ctor: ThinkingPartCtor | undefined; error?: string } = (() => {
	try {
		const ctor = (vscode as unknown as Record<string, unknown>).LanguageModelThinkingPart;
		return { ctor: typeof ctor === "function" ? (ctor as unknown as ThinkingPartCtor) : undefined };
	} catch (e) {
		return { ctor: undefined, error: String(e) };
	}
})();

export interface ThinkingContent {
	text: string;
	id?: string;
	metadata?: unknown;
}

/**
 * Extract thinking/reasoning text from a streaming choice. Covers the three
 * provider formats: a structured thinking object (choice- or delta-level),
 * a reasoning_content string, and a reasoning string.
 */
export function extractThinking(choice: ChunkChoice, delta: ChunkDelta | undefined): ThinkingContent | undefined {
	const raw = choice.thinking ?? delta?.thinking ?? delta?.reasoning_content ?? delta?.reasoning;
	if (raw === undefined) {
		return undefined;
	}
	if (typeof raw === "string") {
		return raw ? { text: raw } : undefined;
	}
	const text = typeof raw.text === "string" ? raw.text : "";
	return text ? { text, id: raw.id, metadata: raw.metadata } : undefined;
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
}

export function freshRequestState(): RequestState {
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
		thinkingPartCtor: ThinkingPartCtor | null | undefined = defaultThinkingProbe.ctor
	) {
		this._req = freshRequestState();
		this._toolCallIds = toolCallIds;
		this._log = log;
		this._thinkingPartCtor = thinkingPartCtor ?? undefined;
		if (thinkingPartCtor === defaultThinkingProbe.ctor && defaultThinkingProbe.error) {
			this._log("LanguageModelThinkingPart probe failed", { error: defaultThinkingProbe.error });
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

		const thinking = extractThinking(choice, delta);
		if (thinking && this._thinkingPartCtor) {
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
		call: { id?: string; name: string; parsedArgs: Record<string, unknown> },
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
			this._log("Dropping trailing partial control token text at end of stream", {
				text: trailingText.slice(0, 200),
			});
		}

		if (invalidCount > 0 && throwOnInvalid) {
			throw new Error("Invalid JSON for tool call");
		}
	}
}
