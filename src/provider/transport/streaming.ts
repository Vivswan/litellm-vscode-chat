import * as vscode from "vscode";
import type { DataPartCtor } from "../../shared/dataPart";
import { dataPartCtor, logDataPartProbeErrorOnce, logMissingDataPartSupportOnce } from "../../shared/dataPart";
import { isRecord, tryParseJSONObject } from "../../shared/json";
import { isImageMimeType, isSafeMimeType } from "../../shared/mime";
import type { ThinkingPartCtor } from "../../shared/thinkingPart";
import {
	logMissingThinkingPartSupportOnce,
	logThinkingPartProbeErrorOnce,
	thinkingPartCtor,
} from "../../shared/thinkingPart";
import { streamErrorFrame } from "./errorMapping";
import type { TextParseResult, TextToolCall } from "./textToolCallParser";
import { isTruncatedToolCallText, TextToolCallParser } from "./textToolCallParser";
import type {
	ChatCompletionChunk,
	ChunkAudio,
	ChunkChoice,
	ChunkDelta,
	ChunkSearchResult,
	ThinkingBlock,
	ThinkingBlockDelta,
	ToolCallBuffer,
} from "./wire";
import { parseChunk, TERMINAL_FINISH_REASONS } from "./wire";

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

/**
 * Canonical base64 to bytes. ASCII whitespace is stripped first (MIME-style
 * wrapped base64 is the one legitimate variation); after that the payload
 * must be full 4-character groups over the standard alphabet with padding
 * only as a correct-length suffix, and re-encoding must reproduce it byte for
 * byte - Buffer.from(_, "base64") silently truncates short groups and zeroes
 * noncanonical pad bits ("AB=="), and corrupt media must surface as a logged
 * skip, never as garbage bytes.
 */
function decodeBase64Strict(data: string): Uint8Array | undefined {
	const compact = data.replace(/[ \t\r\n]/g, "");
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
		return undefined;
	}
	const bytes = Buffer.from(compact, "base64");
	if (bytes.toString("base64") !== compact) {
		return undefined;
	}
	return new Uint8Array(bytes);
}

interface DecodedDataUrl {
	mime: string;
	bytes: Uint8Array;
}

/**
 * Decode a base64 data URL (the shape image-generating models emit); anything
 * else is undefined, for log-and-skip. The mime is model-controlled and later
 * reaches the host, so it is validated here at the source: type/subtype over
 * a conservative character set, with a length cap.
 */
function decodeBase64DataUrl(url: string): DecodedDataUrl | undefined {
	const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
	if (!match) {
		return undefined;
	}
	const mime = match[1] as string;
	if (!isSafeMimeType(mime)) {
		return undefined;
	}
	const bytes = decodeBase64Strict(match[2] as string);
	return bytes === undefined ? undefined : { mime, bytes };
}

/** Base64 fragments of the in-flight generated audio output; see the accumulation comment on processAudioDelta. */
interface AudioBuffer {
	id: string | undefined;
	base64: string;
}

/**
 * The request's audio.format values mapped to the mime stamped on the emitted
 * DataPart. The wire delta carries no format field, so the request parameter
 * is the only place the encoding is stated. pcm16 is raw samples without a
 * container; audio/pcm is the conventional type.
 */
const AUDIO_FORMAT_MIMES: Readonly<Record<string, string>> = {
	wav: "audio/wav",
	mp3: "audio/mpeg",
	flac: "audio/flac",
	opus: "audio/opus",
	aac: "audio/aac",
	pcm16: "audio/pcm",
};

/** audio/wav is the fallback for an absent or unknown format; every mapped value must still pass the safe-mime gate. */
function audioMimeForFormat(format: string | undefined): string {
	const mime = format === undefined ? undefined : AUDIO_FORMAT_MIMES[format.toLowerCase()];
	return mime !== undefined && isSafeMimeType(mime) ? mime : "audio/wav";
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
	/** Whether an undecodable generated-image entry was already logged for this request (no per-entry flood). */
	loggedImageSkip: boolean;
	/**
	 * Citation URL to title, emitted once at end of stream. Collected from
	 * annotation deltas, chunk-root citations/search_results, and the delta's
	 * provider_specific_fields.search_results, all through one rule (see
	 * recordSource).
	 */
	citations: Map<string, string>;
	/** The latest usage trailer observed on any chunk (the last one wins), emitted at end of stream. */
	usage: Record<string, unknown> | undefined;
	/** The generated audio being accumulated, or undefined when none is in flight (also after each flush). */
	audioBuffer: AudioBuffer | undefined;
	/** Set by every part handed to progress; the end-of-stream empty-response check reads it. */
	reportedAnyPart: boolean;
	/**
	 * Aggregate of reasoning parts dropped because no thinking part could be
	 * built (class missing, or its constructor threw): counts and lengths only,
	 * never the text. "Parts" counts thinking items, not SSE chunks - one delta
	 * carrying three thinking_blocks counts three.
	 */
	droppedReasoningParts: number;
	droppedReasoningLength: number;
	/** Set once the per-request drop classification was logged; finishStream runs more than once per stream. */
	loggedDroppedReasoning: boolean;
	/** Set once the reasoning-only empty response error was thrown; finishStream runs more than once per stream. */
	threwReasoningOnly: boolean;
}

/**
 * The fixed message for a normally-finished stream that produced no parts at
 * all while reasoning output was dropped - because the host has no
 * LanguageModelThinkingPart class, or because the class it has failed to
 * construct. A thrown error rather than a fallback text part: text parts
 * round-trip into replayed chat history, and an error surfaces in the chat UI
 * and flows through the provider boundary's single-point logging. Static
 * string only; nothing response-derived.
 */
const REASONING_ONLY_RESPONSE_MESSAGE =
	"The model produced only reasoning output, which this version of VS Code could not display: the LanguageModelThinkingPart API is missing or failed. Update VS Code to a version that supports thinking parts, or use a model that returns final text.";

/**
 * The known numeric token counts of a usage trailer. The record is
 * response-owned, so logging it wholesale would let arbitrary server keys
 * ride into the issue-report buffer; only these counts have diagnostic
 * value, and only numbers pass.
 */
function knownUsageCounts(usage: object): Record<string, number> {
	const record = usage as Record<string, unknown>;
	const counts: Record<string, number> = {};
	// Number.isFinite, not typeof: a server literal like 1e999 parses to
	// Infinity, which is useless as a diagnostic count.
	for (const key of [
		"prompt_tokens",
		"completion_tokens",
		"total_tokens",
		"cache_creation_input_tokens",
		"cache_read_input_tokens",
	]) {
		const value = record[key];
		if (Number.isFinite(value)) {
			counts[key] = value as number;
		}
	}
	const detailGroups: ReadonlyArray<readonly [string, readonly string[]]> = [
		["prompt_tokens_details", ["cached_tokens", "cache_creation_input_tokens", "audio_tokens"]],
		["completion_tokens_details", ["reasoning_tokens", "audio_tokens"]],
	];
	for (const [group, keys] of detailGroups) {
		const nested = record[group];
		if (typeof nested !== "object" || nested === null) {
			continue;
		}
		for (const key of keys) {
			const value = (nested as Record<string, unknown>)[key];
			if (Number.isFinite(value)) {
				counts[`${group}.${key}`] = value as number;
			}
		}
	}
	return counts;
}

/**
 * The sanitized payload of the end-of-stream "usage" DataPart, or undefined
 * when the trailer lacks any of the three required counts (the consumer's
 * shape check rejects such a payload outright, so emitting it would be
 * noise). The trailer is response-owned, so it is never forwarded verbatim:
 * only these known numeric counts pass, the same discipline as
 * knownUsageCounts. Cache accounting reads the OpenAI-style
 * prompt_tokens_details keys first and falls back to the top-level
 * cache_read_input_tokens/cache_creation_input_tokens fields LiteLLM emits on
 * Anthropic routes, mapping both shapes onto the prompt_tokens_details keys
 * the consumer reads. Number.isFinite guards every count: a server literal
 * like 1e999 parses to Infinity, JSON.stringify would serialize it as null,
 * and the consumer's shape check would then reject the whole payload.
 */
function usageDataPartPayload(usage: Record<string, unknown>): Record<string, unknown> | undefined {
	const num = (value: unknown): number | undefined => (Number.isFinite(value) ? (value as number) : undefined);
	const promptTokens = num(usage.prompt_tokens);
	const completionTokens = num(usage.completion_tokens);
	const totalTokens = num(usage.total_tokens);
	if (promptTokens === undefined || completionTokens === undefined || totalTokens === undefined) {
		return undefined;
	}
	const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined;
	const completionDetails = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : undefined;
	const cachedTokens = num(promptDetails?.cached_tokens) ?? num(usage.cache_read_input_tokens);
	const cacheCreationTokens = num(promptDetails?.cache_creation_input_tokens) ?? num(usage.cache_creation_input_tokens);
	const reasoningTokens = num(completionDetails?.reasoning_tokens);
	const payload: Record<string, unknown> = {
		prompt_tokens: promptTokens,
		completion_tokens: completionTokens,
		total_tokens: totalTokens,
	};
	const details: Record<string, number> = {
		...(cachedTokens !== undefined ? { cached_tokens: cachedTokens } : {}),
		...(cacheCreationTokens !== undefined ? { cache_creation_input_tokens: cacheCreationTokens } : {}),
	};
	if (Object.keys(details).length > 0) {
		payload.prompt_tokens_details = details;
	}
	if (reasoningTokens !== undefined) {
		payload.completion_tokens_details = { reasoning_tokens: reasoningTokens };
	}
	return payload;
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
		loggedImageSkip: false,
		citations: new Map(),
		usage: undefined,
		audioBuffer: undefined,
		reportedAnyPart: false,
		droppedReasoningParts: 0,
		droppedReasoningLength: 0,
		loggedDroppedReasoning: false,
		threwReasoningOnly: false,
	};
}

export class StreamProcessor {
	private _req: RequestState;
	private _toolCallIds: ToolCallIdSource;
	private _log: (message: string, data?: unknown) => void;
	private _thinkingPartCtor: ThinkingPartCtor | undefined;
	private _dataPartCtor: DataPartCtor | undefined;
	private _audioMime: string;

	constructor(
		toolCallIds: ToolCallIdSource,
		log: (message: string, data?: unknown) => void,
		partCtor: ThinkingPartCtor | null | undefined = thinkingPartCtor,
		dataCtor: DataPartCtor | null | undefined = dataPartCtor,
		requestAudioFormat: string | undefined = undefined
	) {
		this._req = freshRequestState();
		this._toolCallIds = toolCallIds;
		this._log = log;
		this._thinkingPartCtor = partCtor ?? undefined;
		if (partCtor === thinkingPartCtor) {
			logThinkingPartProbeErrorOnce(this._log);
		}
		this._dataPartCtor = dataCtor ?? undefined;
		if (dataCtor === dataPartCtor) {
			logDataPartProbeErrorOnce(this._log);
		}
		this._audioMime = audioMimeForFormat(requestAudioFormat);
	}

	resetState(): void {
		this._req = freshRequestState();
	}

	/** Every part reaches the host through here, so the end-of-stream empty-response check sees all emissions. */
	private reportPart(
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		part: vscode.LanguageModelResponsePart
	): void {
		this._req.reportedAnyPart = true;
		progress.report(part);
	}

	/** Aggregate only (part count and character length); the reasoning text never reaches the logs. */
	private recordDroppedReasoning(thinking: ThinkingContent): void {
		this._req.droppedReasoningParts += 1;
		this._req.droppedReasoningLength += thinking.text.length;
	}

	/**
	 * Log the per-request drop aggregate once. Called from finishStream and
	 * from the transport loop's cleanup, so a request that failed mid-stream
	 * (in-band error frame, reader failure) still ties its lost reasoning to
	 * the turn a user reports; the once-per-session support notice cannot.
	 */
	private logDroppedReasoningAggregate(): void {
		if (this._req.droppedReasoningParts === 0 || this._req.loggedDroppedReasoning) {
			return;
		}
		this._req.loggedDroppedReasoning = true;
		this._log("Dropped reasoning output; LanguageModelThinkingPart missing or failed", {
			parts: this._req.droppedReasoningParts,
			totalLength: this._req.droppedReasoningLength,
		});
	}

	async processStreamingResponse(
		responseBody: ReadableStream<Uint8Array>,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		const reader = responseBody.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let sawDone = false;

		try {
			while (!token.isCancellationRequested) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const rawLine of lines) {
					// SSE over CRLF frames every line with a trailing \r; JSON payloads
					// never end in a raw \r (it is escaped), so stripping it is safe and
					// keeps "data: [DONE]\r\n" recognized instead of logged as malformed.
					const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
					if (!line.startsWith("data: ")) {
						continue;
					}
					const data = line.slice(6);
					if (data === "[DONE]") {
						sawDone = true;
						this.finishStream(progress, !token.isCancellationRequested);
						continue;
					}

					let chunk: ChatCompletionChunk | undefined;
					try {
						chunk = parseChunk(JSON.parse(data));
					} catch (e) {
						// Classifications only: neither the raw line nor the JSON error
						// message (V8 embeds an input excerpt) may reach the logs.
						this._log("Skipping malformed SSE line", {
							length: data.length,
							errorClass: e instanceof Error ? e.name : typeof e,
						});
						continue;
					}
					if (!chunk) {
						this._log("Skipping malformed SSE line", { length: data.length });
						continue;
					}
					// An in-band error frame with no usable choices terminates the
					// request: LiteLLM streams `data: {"error": {...}}` when an
					// upstream dies after the 200, and swallowing it would end the
					// request as a silent truncation. This is NOT the log-and-skip
					// path - that leniency covers unparseable junk, and an error
					// frame is a perfectly parseable statement of failure. After
					// [DONE] the response already completed, so a late frame must
					// not turn success into failure.
					if (!sawDone && chunk.error && !(chunk.choices && chunk.choices.length > 0)) {
						throw streamErrorFrame(chunk.error);
					}
					this.processDelta(chunk, progress, token);
				}
			}
			this.endOfStream(progress, !token.isCancellationRequested);
		} finally {
			try {
				reader.releaseLock();
			} catch {
				// The stream may already be errored (e.g. aborted fetch); the lock is moot then.
			}
			// A request that fails mid-stream (in-band error frame, reader
			// failure) never reaches finishStream; its drop aggregate still logs
			// here before the state resets.
			this.logDroppedReasoningAggregate();
			this._req = freshRequestState();
		}
	}

	/**
	 * The post-loop end-of-stream run, the only run where the trailers may
	 * emit. The transport loop calls this once its reader drains; a harness
	 * that feeds processDelta directly calls it to mirror that loop.
	 */
	endOfStream(progress: vscode.Progress<vscode.LanguageModelResponsePart>, finishedNormally = true): void {
		this.finishStream(progress, finishedNormally, true);
	}

	/**
	 * Record one source URL into the request's citations map, which the
	 * end-of-stream Sources trailer renders. One rule for every source shape
	 * (annotation deltas, chunk-root citations, search results): the first
	 * REAL title wins, a URL without one titles itself as a placeholder, and a
	 * later real title may upgrade that placeholder - the same source
	 * routinely arrives titled on one field and bare on another. Truthiness,
	 * not presence: an empty-string title is no title, so it can neither
	 * label a source nor block a later upgrade.
	 */
	private recordSource(url: string | undefined, title: string | undefined): void {
		if (!url) {
			return;
		}
		const existing = this._req.citations.get(url);
		if (existing === undefined) {
			this._req.citations.set(url, title || url);
		} else if (existing === url && title && title !== url) {
			this._req.citations.set(url, title);
		}
	}

	/** Chunk-root and provider-specific sources; Perplexity repeats the list per chunk, recordSource dedupes. */
	private collectSources(
		citations: readonly string[] | undefined,
		searchResults: readonly ChunkSearchResult[] | undefined
	): void {
		for (const url of citations ?? []) {
			this.recordSource(url, undefined);
		}
		for (const result of searchResults ?? []) {
			this.recordSource(result.url, result.title);
		}
	}

	processDelta(
		chunk: ChatCompletionChunk,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token?: vscode.CancellationToken
	): boolean {
		let emitted = false;

		if (chunk.usage) {
			this._log("Token usage", knownUsageCounts(chunk.usage));
			// Retained for the end-of-stream usage DataPart; runs before the
			// empty-choices early return below, so the standard trailer chunk
			// (choices: []) is captured. The last trailer wins.
			this._req.usage = chunk.usage;
		}

		// Chunk-root sources (Perplexity via LiteLLM repeats them on every
		// chunk, including choice-less ones) collect before the choice gate so
		// none are lost; the delta's provider_specific_fields escape hatch
		// feeds the same map below.
		this.collectSources(chunk.citations, chunk.search_results);

		const choice = chunk.choices?.[0];
		if (!choice) {
			return false;
		}
		const delta = choice.delta;
		this.collectSources(undefined, delta?.search_results);

		// Thinking parts pass through as-is: the host merges adjacent thinking
		// parts itself (empty chunks and non-thinking output separate runs) and
		// mints an id when a part has none, so minting ids here would only risk
		// colliding with wire ids or the host's thinking-title cache.
		const thinkingContents = extractThinking(choice, delta);
		if (this._thinkingPartCtor) {
			for (const thinking of thinkingContents) {
				let part: vscode.LanguageModelResponsePart | undefined;
				try {
					part = new this._thinkingPartCtor(thinking.text, thinking.id, thinking.metadata);
				} catch (e) {
					this._log("Failed to construct thinking part", { error: String(e) });
				}
				if (part) {
					this.reportPart(progress, part);
					emitted = true;
				} else {
					// A host class that throws loses the reasoning exactly like a
					// missing one; both routes feed the same per-request aggregate.
					this.recordDroppedReasoning(thinking);
				}
			}
		} else if (thinkingContents.length > 0) {
			logMissingThinkingPartSupportOnce(this._log);
			for (const thinking of thinkingContents) {
				this.recordDroppedReasoning(thinking);
			}
		}

		if (delta?.refusal) {
			if (!this._req.loggedRefusal) {
				this._req.loggedRefusal = true;
				// No content: refusal text can echo user data into issue reports.
				this._log("Model refused the request");
			}
			this.reportPart(progress, new vscode.LanguageModelTextPart(delta.refusal));
			this._req.hasEmittedAssistantText = true;
			emitted = true;
		}

		if (delta?.annotations) {
			for (const annotation of delta.annotations) {
				this.recordSource(annotation.url_citation?.url, annotation.url_citation?.title);
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

		if (delta?.images && delta.images.length > 0) {
			if (this.processImagesDelta(delta.images, progress)) {
				emitted = true;
			}
		}

		if (delta?.audio) {
			// The transcript is the model's textual output (a gpt-4o-audio turn
			// has no delta.content), so it streams as ordinary text - fragment by
			// fragment, like the data field, and independently of DataPart
			// support, which only gates the binary clip.
			if (delta.audio.transcript) {
				const res = this.processTextContent(delta.audio.transcript, progress);
				if (res.emittedText) {
					this._req.hasEmittedAssistantText = true;
				}
				if (res.emittedAny) {
					emitted = true;
				}
			}
			if (this.processAudioDelta(delta.audio, progress)) {
				emitted = true;
			}
		}

		if (delta?.tool_calls) {
			if (!this._req.emittedBeginToolCallsHint && this._req.hasEmittedAssistantText && delta.tool_calls.length > 0) {
				this.reportPart(progress, new vscode.LanguageModelTextPart(" "));
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

		if (choice.finish_reason !== undefined && TERMINAL_FINISH_REASONS.includes(choice.finish_reason)) {
			this.finishStream(progress, !token?.isCancellationRequested);
		}

		return emitted;
	}

	/**
	 * Emit one DataPart per decodable entry of a delta.images list, in stream
	 * order relative to the surrounding text. A malformed entry (no data URL,
	 * an unsafe or non-image mime, undecodable base64, or an empty payload) is
	 * skipped and logged as a classification - once per request, so a burst of
	 * bad entries cannot flood the issue-report buffer; the stream continues
	 * either way.
	 */
	private processImagesDelta(
		images: NonNullable<ChunkDelta["images"]>,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>
	): boolean {
		if (!this._dataPartCtor) {
			logMissingDataPartSupportOnce(this._log);
			return false;
		}
		let emitted = false;
		for (const image of images) {
			const url = image.image_url?.url;
			const decoded = url === undefined ? undefined : decodeBase64DataUrl(url);
			// The image/* gate kills both a mislabeled DataPart and the
			// second-order round-trip where a text-mime part's bytes would
			// re-enter assistant text on the next turn. image/svg+xml passes
			// the gate; whether to render it is the host's concern.
			if (!decoded || decoded.bytes.length === 0 || !isImageMimeType(decoded.mime)) {
				if (!this._req.loggedImageSkip) {
					this._req.loggedImageSkip = true;
					// Classification only: the raw field can carry response-derived text.
					this._log("Skipping generated image without a decodable image data URL");
				}
				continue;
			}
			const part = this.constructDataPart(decoded.bytes, decoded.mime);
			if (part) {
				this.reportPart(progress, part);
				emitted = true;
			}
		}
		return emitted;
	}

	/**
	 * Generated audio accumulates instead of streaming out per delta: real
	 * deployments fragment delta.audio.data into base64 pieces sharing an id,
	 * and the pieces need not align to 4-character base64 groups, so only the
	 * concatenation is decodable. One DataPart is emitted per audio id - when
	 * a delta carrying a different id starts, or at end of stream. The mime
	 * derives from the request's audio.format (the wire delta carries no
	 * format field), falling back to audio/wav; see audioMimeForFormat.
	 */
	private processAudioDelta(audio: ChunkAudio, progress: vscode.Progress<vscode.LanguageModelResponsePart>): boolean {
		if (!this._dataPartCtor) {
			logMissingDataPartSupportOnce(this._log);
			return false;
		}
		let emitted = false;
		const previous = this._req.audioBuffer;
		if (previous !== undefined && previous.id !== undefined && audio.id !== undefined && audio.id !== previous.id) {
			emitted = this.flushAudioBuffer(progress);
		}
		const buffer = this._req.audioBuffer ?? { id: undefined, base64: "" };
		// Real deployments send the id on the first fragment only, so the first observed id sticks.
		buffer.id = buffer.id ?? audio.id;
		buffer.base64 += audio.data ?? "";
		this._req.audioBuffer = buffer;
		return emitted;
	}

	/** Emit the accumulated audio as one DataPart; an undecodable or empty payload is logged as a classification and dropped. */
	private flushAudioBuffer(progress: vscode.Progress<vscode.LanguageModelResponsePart>): boolean {
		const buffer = this._req.audioBuffer;
		this._req.audioBuffer = undefined;
		if (buffer === undefined || buffer.base64 === "") {
			// No data ever arrived (e.g. transcript-only deltas): nothing to report.
			return false;
		}
		const bytes = decodeBase64Strict(buffer.base64);
		if (bytes === undefined || bytes.length === 0) {
			this._log("Skipping generated audio without a decodable payload");
			return false;
		}
		const part = this.constructDataPart(bytes, this._audioMime);
		if (!part) {
			return false;
		}
		this.reportPart(progress, part);
		return true;
	}

	/** Guarded construction, mirroring the thinking-part path: a throwing host class is logged, never propagated. */
	private constructDataPart(bytes: Uint8Array, mime: string): vscode.LanguageModelResponsePart | undefined {
		if (!this._dataPartCtor) {
			return undefined;
		}
		try {
			return new this._dataPartCtor(bytes, mime);
		} catch (e) {
			this._log("Failed to construct data part", { error: String(e) });
			return undefined;
		}
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
				this.reportPart(progress, new vscode.LanguageModelTextPart(event.text));
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
				// Classification only: the name and arguments are response text.
				this._log("Dropping inline tool call with invalid JSON arguments", { argsLength: call.args.length });
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
			// Classification only: the tool name can be response text on the inline channel.
			this._log("Suppressing tool call already emitted via the other channel", { source });
			return false;
		}

		ownCounts.set(key, (ownCounts.get(key) ?? 0) + 1);
		const id = call.id ?? `call_${this._toolCallIds.next()}`;
		this.reportPart(progress, new vscode.LanguageModelToolCallPart(id, call.name, call.parsedArgs));
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
				// Classification only: buffered arguments are response text.
				this._log("Invalid JSON for tool call", { index, argsLength: (buf.args || "").length });
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
	 * finishedNormally is false only when the request was cancelled; a
	 * cancelled stream downgrades unparseable leftovers to logged drops and
	 * discards accumulated media instead of emitting it. `isFinal` is true
	 * only for the post-loop EOF run - [DONE] is handled with `continue`, so
	 * that run always happens last and is the only place the end-of-stream
	 * trailers (the Sources list and the usage DataPart) may emit, after the
	 * terminal validations pass; both the finish_reason and [DONE] runs can
	 * still be followed by more chunks.
	 */
	private finishStream(
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		finishedNormally: boolean,
		isFinal = false
	): void {
		let invalidCount = this.flushToolCallBuffers(progress);

		const rest = this._req.textParser.flush();
		const call = rest.provisionalCall;
		if (call && !this._req.handledTextCallSeqs.has(call.seq)) {
			const parsed = tryParseJSONObject(call.args);
			if (parsed.ok) {
				this._req.handledTextCallSeqs.add(call.seq);
				this.emitInlineToolCall(call, parsed.value, progress);
			} else {
				// Classification only: the name and arguments are response text.
				this._log("Dropping unterminated inline tool call with invalid JSON arguments", {
					argsLength: call.args.length,
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
				// Classification only: the held-back text is response content.
				this._log("Dropping trailing partial control token text at end of stream", {
					length: trailingText.length,
				});
			} else {
				this.reportPart(progress, new vscode.LanguageModelTextPart(trailingText));
			}
		}

		// Audio flushes only from a normally-finished stream: a cancelled
		// request drops its partial accumulation rather than emit a truncated
		// clip. Flushing clears the buffer, so the repeated finishStream runs
		// (finish_reason, then [DONE], then EOF) cannot emit the audio twice.
		if (finishedNormally) {
			this.flushAudioBuffer(progress);
		} else {
			this._req.audioBuffer = undefined;
		}

		this.logDroppedReasoningAggregate();

		if (invalidCount > 0 && finishedNormally) {
			throw new Error("Invalid JSON for tool call");
		}

		// A normally-finished stream that emitted nothing but did drop reasoning
		// must fail loudly instead of resolving empty ("Sorry, no response was
		// returned" with no trace). A stream that emitted nothing and dropped
		// nothing resolves as before. The flag keeps the repeated finishStream
		// runs (finish_reason, then [DONE], then EOF) from double-throwing.
		if (
			finishedNormally &&
			!this._req.reportedAnyPart &&
			this._req.droppedReasoningParts > 0 &&
			!this._req.threwReasoningOnly
		) {
			this._req.threwReasoningOnly = true;
			throw new Error(REASONING_ONLY_RESPONSE_MESSAGE);
		}

		// One rule for the end-of-stream trailers (the Sources list, then the
		// usage DataPart): they emit only here, on the single post-loop EOF run
		// of a stream that finished normally and passed the terminal checks
		// above. Earlier runs are premature - after finish_reason (and even
		// after [DONE], which `continue`s back into the loop) more chunks may
		// still deliver sources, title upgrades, or a later usage trailer, and
		// last-wins must hold - and a cancelled or failed stream has no
		// successful response to trail, so it ships neither the sources nor
		// the accounting.
		if (!isFinal || !finishedNormally) {
			return;
		}

		if (this._req.citations.size > 0) {
			const escapeTitle = (title: string) => title.replace(/[\r\n]+/g, " ").replace(/[[\]\\]/g, "\\$&");
			// encodeURIComponent leaves "(" and ")" alone, and those break
			// markdown link targets; everything else needs UTF-8-safe encoding.
			const escapeUrl = (url: string) =>
				url.replace(/[\s()]/g, (c) => (c === "(" ? "%28" : c === ")" ? "%29" : encodeURIComponent(c)));
			const lines = Array.from(this._req.citations.entries()).map(
				([url, title]) => `- [${escapeTitle(title)}](${escapeUrl(url)})`
			);
			// Reported directly, not through reportPart: the trailer decorates a
			// response, it is not the response, so it must not satisfy the
			// reasoning-only check above - a stream whose only visible output
			// would be its sources still failed to deliver the reasoning it
			// dropped.
			progress.report(new vscode.LanguageModelTextPart(`\n\nSources:\n${lines.join("\n")}`));
		}

		// The retained usage trailer rides out as one DataPart with the bare
		// mimeType "usage", the convention the host-side consumer decodes into
		// its token accounting (context-window widget, cache and reasoning
		// stats). Reported directly, not through reportPart: usage is
		// bookkeeping, so a usage-only stream must still count as empty for the
		// reasoning-only check above. A host without the DataPart class drops
		// it silently - the pre-feature behavior, and
		// logMissingDataPartSupportOnce's message is about generated media,
		// which this is not.
		if (this._req.usage !== undefined) {
			const payload = usageDataPartPayload(this._req.usage);
			if (payload !== undefined && this._dataPartCtor) {
				const part = this.constructDataPart(new TextEncoder().encode(JSON.stringify(payload)), "usage");
				if (part !== undefined) {
					progress.report(part);
				}
			}
		}
	}
}
