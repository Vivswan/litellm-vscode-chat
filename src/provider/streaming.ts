import * as vscode from "vscode";
import type { DataPartCtor } from "../shared/dataPart";
import { dataPartCtor, logDataPartProbeErrorOnce, logMissingDataPartSupportOnce } from "../shared/dataPart";
import { tryParseJSONObject } from "../shared/json";
import { isImageMimeType, isSafeMimeType } from "../shared/mime";
import type { ThinkingPartCtor } from "../shared/thinkingPart";
import {
	logMissingThinkingPartSupportOnce,
	logThinkingPartProbeErrorOnce,
	thinkingPartCtor,
} from "../shared/thinkingPart";
import { streamErrorFrame } from "./errorMapping";
import type { TextParseResult, TextToolCall } from "./textToolCallParser";
import { isTruncatedToolCallText, TextToolCallParser } from "./textToolCallParser";
import type {
	ChatCompletionChunk,
	ChunkAudio,
	ChunkChoice,
	ChunkDelta,
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
	/** Citation URL to title, collected from annotation deltas and emitted once at end of stream. */
	citations: Map<string, string>;
	/** Set once the citations trailer has been emitted; finishStream runs more than once per stream. */
	emittedCitations: boolean;
	/** The generated audio being accumulated, or undefined when none is in flight (also after each flush). */
	audioBuffer: AudioBuffer | undefined;
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
		emittedCitations: false,
		audioBuffer: undefined,
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
				progress.report(part);
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
		progress.report(part);
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
	 * discards accumulated media instead of emitting it.
	 */
	private finishStream(progress: vscode.Progress<vscode.LanguageModelResponsePart>, finishedNormally: boolean): void {
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
				progress.report(new vscode.LanguageModelTextPart(trailingText));
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

		if (invalidCount > 0 && finishedNormally) {
			throw new Error("Invalid JSON for tool call");
		}
	}
}
