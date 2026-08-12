import * as vscode from "vscode";
import type { DataPartCtor } from "../../../shared/conversion/dataPart";
import {
	dataPartCtor,
	logDataPartProbeErrorOnce,
	logMissingDataPartSupportOnce,
} from "../../../shared/conversion/dataPart";
import { isImageMimeType } from "../../../shared/conversion/mime";
import type { ThinkingPartCtor } from "../../../shared/conversion/thinkingPart";
import {
	logMissingThinkingPartSupportOnce,
	logThinkingPartProbeErrorOnce,
	thinkingPartCtor,
} from "../../../shared/conversion/thinkingPart";
import { chatErrorMessage, localizedError } from "../../../shared/mirroredError";
import { tryParseJSONObject } from "../../../shared/util/json";
import { streamErrorFrame } from "../errorMapping";
import type { TextParseResult, TextToolCall } from "../textToolCallParser";
import { isTruncatedToolCallText, TextToolCallParser } from "../textToolCallParser";
import type { ChatCompletionChunk, ChunkAudio, ChunkDelta, ChunkSearchResult, ToolCallBuffer } from "../wire";
import { parseChunk, TERMINAL_FINISH_REASONS } from "../wire";
import { ToolCallLedger } from "./dedup";
import type { AudioBuffer } from "./media";
import { audioMimeForFormat, decodeBase64DataUrl, decodeBase64Strict } from "./media";
import { sseFrames } from "./sse";
import type { DroppedReasoning, ThinkingContent } from "./thinking";
import {
	extractThinking,
	freshDroppedReasoning,
	REASONING_ONLY_RESPONSE_MESSAGE,
	reasoningOnlyResponseMessage,
} from "./thinking";
import { knownUsageCounts, usageDataPartPayload } from "./usage";

/**
 * Hands out tool-call ID numbers. Owned by the ChatClient and shared across
 * concurrent requests, so next() must advance state synchronously: two
 * overlapping streams may interleave calls but can never receive the same ID.
 */
export interface ToolCallIdSource {
	next(): number;
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
	/** The tool-call dedup ledger: inline-replay tracking plus the cross-channel max(N, M) rule (see ToolCallLedger). */
	ledger: ToolCallLedger;
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
	/** Reasoning lost to a missing or throwing thinking-part class; see DroppedReasoning. */
	droppedReasoning: DroppedReasoning;
}

function freshRequestState(): RequestState {
	return {
		toolCallBuffers: new Map(),
		completedToolCallIndices: new Set(),
		hasEmittedAssistantText: false,
		emittedBeginToolCallsHint: false,
		textParser: new TextToolCallParser(),
		ledger: new ToolCallLedger(),
		loggedRefusal: false,
		loggedImageSkip: false,
		citations: new Map(),
		usage: undefined,
		audioBuffer: undefined,
		reportedAnyPart: false,
		droppedReasoning: freshDroppedReasoning(),
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
		this._req.droppedReasoning.parts += 1;
		this._req.droppedReasoning.length += thinking.text.length;
	}

	/**
	 * Log the per-request drop aggregate once. Called from finishStream and
	 * from the transport loop's cleanup, so a request that failed mid-stream
	 * (in-band error frame, reader failure) still ties its lost reasoning to
	 * the turn a user reports; the once-per-session support notice cannot.
	 */
	private logDroppedReasoningAggregate(): void {
		const dropped = this._req.droppedReasoning;
		if (dropped.parts === 0 || dropped.logged) {
			return;
		}
		dropped.logged = true;
		this._log("Dropped reasoning output; LanguageModelThinkingPart missing or failed", {
			parts: dropped.parts,
			totalLength: dropped.length,
		});
	}

	async processStreamingResponse(
		responseBody: ReadableStream<Uint8Array>,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		let sawDone = false;
		try {
			for await (const frame of sseFrames(responseBody, token)) {
				if (frame.kind === "done") {
					sawDone = true;
					this.finishStream(progress, !token.isCancellationRequested);
					continue;
				}
				const data = frame.payload;
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
			this.endOfStream(progress, !token.isCancellationRequested);
		} finally {
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
			if (this._req.ledger.alreadyHandled(call.seq)) {
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
		if (provisional && !this._req.ledger.alreadyHandled(provisional.seq)) {
			const parsed = tryParseJSONObject(provisional.args);
			if (parsed.ok) {
				this._req.ledger.markHandled(provisional.seq);
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
		if (this._req.ledger.inlineAlreadyEmitted(name, call.index, contentKey)) {
			return false;
		}
		const emitted = this.emitToolCall(progress, { name, parsedArgs });
		// Registered even when suppressed as a cross-channel duplicate: either way
		// this inline call is accounted for, and a replay of it must not emit.
		this._req.ledger.recordInlineEmission(name, call.index, contentKey);
		return emitted;
	}

	private emitToolCall(
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		call: { id?: string | undefined; name: string; parsedArgs: Record<string, unknown> },
		bufferIndex?: number
	): boolean {
		const source = bufferIndex === undefined ? "inline" : "delta";
		const key = `${call.name}:${JSON.stringify(call.parsedArgs)}`;

		const retireBuffer = () => {
			if (bufferIndex !== undefined) {
				this._req.toolCallBuffers.delete(bufferIndex);
				this._req.completedToolCallIndices.add(bufferIndex);
			}
		};

		if (this._req.ledger.shouldSuppress(source, key)) {
			retireBuffer();
			// Classification only: the tool name can be response text on the inline channel.
			this._log("Suppressing tool call already emitted via the other channel", { source });
			return false;
		}

		this._req.ledger.recordEmission(source, key);
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
		if (call && !this._req.ledger.alreadyHandled(call.seq)) {
			const parsed = tryParseJSONObject(call.args);
			if (parsed.ok) {
				this._req.ledger.markHandled(call.seq);
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
			// The English mirror is what the output channel and issue-report
			// buffer record: distinctive, count-only, forever - tool names and
			// argument snippets are response text and must never join it.
			const detail =
				invalidCount === 1
					? vscode.l10n.t("1 tool call arrived with arguments that were not valid JSON")
					: vscode.l10n.t("{0} tool calls arrived with arguments that were not valid JSON", invalidCount);
			throw localizedError(
				chatErrorMessage(
					vscode.l10n.t(
						"The model sent a broken tool call, so this response could not be completed. Trying again usually fixes it."
					),
					detail
				),
				`Tool call flush failed at end of stream: ${invalidCount} tool call(s) with invalid JSON arguments`
			);
		}

		// A normally-finished stream that emitted nothing but did drop reasoning
		// must fail loudly instead of resolving empty ("Sorry, no response was
		// returned" with no trace). A stream that emitted nothing and dropped
		// nothing resolves as before. The flag keeps the repeated finishStream
		// runs (finish_reason, then [DONE], then EOF) from double-throwing.
		if (
			finishedNormally &&
			!this._req.reportedAnyPart &&
			this._req.droppedReasoning.parts > 0 &&
			!this._req.droppedReasoning.threw
		) {
			this._req.droppedReasoning.threw = true;
			throw localizedError(reasoningOnlyResponseMessage(), REASONING_ONLY_RESPONSE_MESSAGE);
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
