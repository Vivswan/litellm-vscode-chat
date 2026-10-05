import * as l10n from "@vscode/l10n";
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
import { errorLabel } from "../../../shared/util/errorLabel";
import { tryParseJSONObject } from "../../../shared/util/json";
import { StreamErrorFrame } from "../errorMapping";
import type { TextParseResult, TextToolCall } from "../textToolCallParser";
import { isTruncatedToolCallText, TextToolCallParser } from "../textToolCallParser";
import type { ChatCompletionChunk, ChunkAudio, ChunkDelta, ChunkSearchResult, ToolCallBuffer } from "../wire";
import { parseChunk } from "../wire";
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
 * Shared across concurrent requests, so next() must advance state synchronously: two overlapping streams may
 * interleave calls but can never receive the same ID.
 */
export interface ToolCallIdSource {
	next(): number;
}

export interface ResponsePartSink {
	report(part: vscode.LanguageModelResponsePart): void;
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
	ledger: ToolCallLedger;
	loggedRefusal: boolean;
	/** One log per request, so a burst of bad entries cannot flood the issue-report buffer. */
	loggedImageSkip: boolean;
	citations: Map<string, string>;
	usage: Record<string, unknown> | undefined;
	audioBuffer: AudioBuffer | undefined;
	/**
	 * Parts the model produced. The trailers emitTrailers adds are not counted, so they cannot stand in for a
	 * response.
	 */
	contentParts: number;
	droppedReasoning: DroppedReasoning;
	lastFinishReason: string | undefined;
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
		contentParts: 0,
		droppedReasoning: freshDroppedReasoning(),
		lastFinishReason: undefined,
	};
}

export class StreamProcessor {
	private _req: RequestState;
	private readonly _progress: ResponsePartSink;
	private _toolCallIds: ToolCallIdSource;
	private _log: (message: string, data?: unknown) => void;
	private _thinkingPartCtor: ThinkingPartCtor | undefined;
	private _dataPartCtor: DataPartCtor | undefined;
	private _audioMime: string;

	constructor(
		toolCallIds: ToolCallIdSource,
		log: (message: string, data?: unknown) => void,
		progress: ResponsePartSink,
		partCtor: ThinkingPartCtor | null | undefined = thinkingPartCtor,
		dataCtor: DataPartCtor | null | undefined = dataPartCtor,
		requestAudioFormat: string | undefined = undefined
	) {
		this._req = freshRequestState();
		this._progress = progress;
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

	/**
	 * The dropped-reasoning aggregate is logged here so every way a request ends (the finish, an error frame, a reader
	 * failure) reports it exactly once.
	 */
	private closeRequest(): void {
		const dropped = this._req.droppedReasoning;
		if (dropped.parts > 0) {
			this._log("Dropped reasoning output; LanguageModelThinkingPart missing or failed", {
				parts: dropped.parts,
				totalLength: dropped.length,
			});
		}
		this._req = freshRequestState();
	}

	private emit(part: vscode.LanguageModelResponsePart): void {
		this._req.contentParts += 1;
		this._progress.report(part);
	}

	/** Aggregate only (part count and character length); the reasoning text never reaches the logs. */
	private recordDroppedReasoning(thinking: ThinkingContent): void {
		this._req.droppedReasoning.parts += 1;
		this._req.droppedReasoning.length += thinking.text.length;
	}

	async processStreamingResponse(
		responseBody: ReadableStream<Uint8Array>,
		token: vscode.CancellationToken
	): Promise<void> {
		// [DONE] does not end the stream: providers trail usage and sources behind it, so only EOF finishes. It does
		// retire the error-frame rule, so a straggling error cannot fail a reply the user has already watched complete.
		let sawDone = false;
		try {
			for await (const frame of sseFrames(responseBody, token)) {
				if (frame.kind === "done") {
					sawDone = true;
					continue;
				}
				const data = frame.payload;
				let chunk: ChatCompletionChunk | undefined;
				try {
					chunk = parseChunk(JSON.parse(data));
				} catch (e) {
					// Classifications only: neither the raw line nor the JSON error message (V8 embeds an input
					// excerpt) may reach the logs.
					this._log("Skipping malformed SSE line", {
						length: data.length,
						errorClass: errorLabel(e),
					});
					continue;
				}
				if (!chunk) {
					this._log("Skipping malformed SSE line", { length: data.length });
					continue;
				}
				// LiteLLM streams `data: {"error": {...}}` when an upstream dies after the 200, and swallowing it would
				// end the request as a silent truncation. This is NOT the log-and-skip path.
				if (!sawDone && chunk.error && !(chunk.choices && chunk.choices.length > 0)) {
					throw new StreamErrorFrame(chunk.error);
				}
				this.processDelta(chunk);
			}
		} catch (e) {
			// A failed request has no end-of-stream finish: nothing buffered may flush behind the error.
			this.closeRequest();
			throw e;
		}
		this.endOfStream(!token.isCancellationRequested);
	}

	/** The one finish, run at EOF. A harness that feeds processDelta directly calls it to mirror the transport loop. */
	endOfStream(finishedNormally = true): void {
		try {
			this.finishStream(finishedNormally);
		} finally {
			this.closeRequest();
		}
	}

	/**
	 * Truthiness, not presence: an empty-string title is no title, so it can neither label a source nor block a later
	 * upgrade.
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

	processDelta(chunk: ChatCompletionChunk): boolean {
		let emitted = false;

		if (chunk.usage) {
			this._log("Token usage", knownUsageCounts(chunk.usage));
			// Retained for the end-of-stream usage DataPart; runs before the empty-choices early return below, so the
			// standard trailer chunk (choices: []) is captured. The last trailer wins.
			this._req.usage = chunk.usage;
		}

		// Chunk-root sources (Perplexity via LiteLLM repeats them on every chunk, including choice-less ones) collect
		// before the choice gate so none are lost.
		this.collectSources(chunk.citations, chunk.search_results);

		const choice = chunk.choices?.[0];
		if (!choice) {
			return false;
		}
		const delta = choice.delta;
		this.collectSources(undefined, delta?.search_results);

		// Thinking parts pass through as-is: the host merges adjacent thinking parts itself and mints an id when a part
		// has none, so minting ids here would only risk colliding with wire ids or the host's thinking-title cache.
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
					this.emit(part);
					emitted = true;
				} else {
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
			this.emit(new vscode.LanguageModelTextPart(delta.refusal));
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
				const res = this.processTextContent(text);
				if (res.emittedText) {
					this._req.hasEmittedAssistantText = true;
				}
				if (res.emittedAny) {
					emitted = true;
				}
			}
		}

		if (delta?.images && delta.images.length > 0) {
			if (this.processImagesDelta(delta.images)) {
				emitted = true;
			}
		}

		if (delta?.audio) {
			// The transcript is the model's textual output (a gpt-4o-audio turn has no delta.content), so it streams as
			// ordinary text, independently of DataPart support, which only gates the binary clip.
			if (delta.audio.transcript) {
				const res = this.processTextContent(delta.audio.transcript);
				if (res.emittedText) {
					this._req.hasEmittedAssistantText = true;
				}
				if (res.emittedAny) {
					emitted = true;
				}
			}
			if (this.processAudioDelta(delta.audio)) {
				emitted = true;
			}
		}

		if (delta?.tool_calls) {
			if (!this._req.emittedBeginToolCallsHint && this._req.hasEmittedAssistantText && delta.tool_calls.length > 0) {
				this.emit(new vscode.LanguageModelTextPart(" "));
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

				this.tryEmitBufferedToolCall(idx);
			}
		}

		if (choice.finish_reason !== undefined) {
			this._req.lastFinishReason = choice.finish_reason;
		}

		return emitted;
	}

	private processImagesDelta(images: NonNullable<ChunkDelta["images"]>): boolean {
		if (!this._dataPartCtor) {
			logMissingDataPartSupportOnce(this._log);
			return false;
		}
		let emitted = false;
		for (const image of images) {
			const url = image.image_url?.url;
			const decoded = url === undefined ? undefined : decodeBase64DataUrl(url);
			// The image/* gate kills both a mislabeled DataPart and the second-order round-trip where a text-mime
			// part's bytes would re-enter assistant text on the next turn.
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
				this.emit(part);
				emitted = true;
			}
		}
		return emitted;
	}

	/**
	 * Generated audio accumulates instead of streaming out per delta: real deployments fragment delta.audio.data into
	 * base64 pieces that need not align to 4-character groups, so only the concatenation is decodable.
	 *
	 * The mime derives from the request's audio.format (the wire delta carries no format field); see
	 * audioMimeForFormat.
	 */
	private processAudioDelta(audio: ChunkAudio): boolean {
		if (!this._dataPartCtor) {
			logMissingDataPartSupportOnce(this._log);
			return false;
		}
		let emitted = false;
		const previous = this._req.audioBuffer;
		if (previous !== undefined && previous.id !== undefined && audio.id !== undefined && audio.id !== previous.id) {
			emitted = this.flushAudioBuffer();
		}
		const buffer = this._req.audioBuffer ?? { id: undefined, base64: "" };
		// Real deployments send the id on the first fragment only, so the first observed id sticks.
		buffer.id = buffer.id ?? audio.id;
		buffer.base64 += audio.data ?? "";
		this._req.audioBuffer = buffer;
		return emitted;
	}

	private flushAudioBuffer(): boolean {
		const buffer = this._req.audioBuffer;
		this._req.audioBuffer = undefined;
		if (buffer === undefined || buffer.base64 === "") {
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
		this.emit(part);
		return true;
	}

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

	processTextContent(input: string): { emittedText: boolean; emittedAny: boolean } {
		const result: TextParseResult = this._req.textParser.push(input);
		let emittedText = false;
		let emittedAny = false;

		for (const event of result.events) {
			if (event.type === "text") {
				this.emit(new vscode.LanguageModelTextPart(event.text));
				emittedText = true;
				emittedAny = true;
				continue;
			}
			const call = event.call;
			if (this._req.ledger.alreadyHandled(call.seq)) {
				continue;
			}
			// A COMPLETE call's end token arrived, so its argument section is final: an explicit-but-empty section
			// reads as the no-argument call (the parser only synthesizes "{}" when the argument-begin token itself is
			// absent).
			const parsed = tryParseJSONObject(StreamProcessor.flushArgsText(call.args));
			if (!parsed.ok) {
				// Classification only: the name and arguments are response text.
				this._log("Dropping inline tool call with invalid JSON arguments", { argsLength: call.args.length });
				continue;
			}
			if (this.emitInlineToolCall(call, parsed.value)) {
				emittedAny = true;
			}
		}

		const provisional = result.provisionalCall;
		if (provisional && !this._req.ledger.alreadyHandled(provisional.seq)) {
			const parsed = tryParseJSONObject(provisional.args);
			if (parsed.ok) {
				this._req.ledger.markHandled(provisional.seq);
				if (this.emitInlineToolCall(provisional, parsed.value)) {
					emittedAny = true;
				}
			}
		}

		return { emittedText, emittedAny };
	}

	private emitInlineToolCall(call: TextToolCall, parsedArgs: Record<string, unknown>): boolean {
		const name = call.name ?? "unknown_tool";
		const contentKey = `${name}:${JSON.stringify(parsedArgs)}`;
		if (this._req.ledger.inlineAlreadyEmitted(name, call.index, contentKey)) {
			return false;
		}
		const emitted = this.emitToolCall({ name, parsedArgs });
		// Registered even when suppressed as a cross-channel duplicate: either way this inline call is accounted for,
		// and a replay of it must not emit.
		this._req.ledger.recordInlineEmission(name, call.index, contentKey);
		return emitted;
	}

	private emitToolCall(
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
		this.emit(new vscode.LanguageModelToolCallPart(id, call.name, call.parsedArgs));
		retireBuffer();
		return true;
	}

	private tryEmitBufferedToolCall(index: number): void {
		const buf = this._req.toolCallBuffers.get(index);
		if (!buf?.name) {
			return;
		}
		const parsed = tryParseJSONObject(buf.args);
		if (!parsed.ok) {
			return;
		}
		this.emitToolCall({ id: buf.id, name: buf.name, parsedArgs: parsed.value }, index);
	}

	/**
	 * An empty accumulation reads as the empty object, the same rule textToolCallParser.ts applies to a call with no
	 * argument-begin token and shared/conversion/messages.ts applies to a missing input.
	 */
	private static flushArgsText(args: string): string {
		return args.trim() === "" ? "{}" : args;
	}

	/**
	 * finishedNormally is false only when the request was cancelled: unparseable leftovers then downgrade to logged
	 * drops and accumulated media is discarded. flushArgsText's empty-argument reading applies only to a complete,
	 * uncut stream: a call cut off before any argument bytes (cancelled, or finish_reason "length") classifies instead
	 * of running with arguments the model never sent.
	 */
	private finishStream(finishedNormally: boolean): void {
		const emptyArgsAreNoArgs = finishedNormally && this._req.lastFinishReason !== "length";
		const finalArgsText = (args: string) => (emptyArgsAreNoArgs ? StreamProcessor.flushArgsText(args) : args);
		let invalidCount = 0;

		for (const [index, buf] of this._req.toolCallBuffers) {
			const parsed = tryParseJSONObject(finalArgsText(buf.args));
			if (!parsed.ok) {
				// Classification only: buffered arguments are response text.
				this._log("Invalid JSON for tool call", { index, argsLength: buf.args.length });
				invalidCount++;
				this._req.toolCallBuffers.delete(index);
				continue;
			}
			this.emitToolCall({ id: buf.id, name: buf.name ?? "unknown_tool", parsedArgs: parsed.value }, index);
		}

		const rest = this._req.textParser.flush();
		const call = rest.provisionalCall;
		if (call && !this._req.ledger.alreadyHandled(call.seq)) {
			const parsed = tryParseJSONObject(finalArgsText(call.args));
			if (parsed.ok) {
				this._req.ledger.markHandled(call.seq);
				this.emitInlineToolCall(call, parsed.value);
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
			if (isTruncatedToolCallText(trailingText)) {
				// Classification only: the held-back text is response content.
				this._log("Dropping trailing partial control token text at end of stream", {
					length: trailingText.length,
				});
			} else {
				this.emit(new vscode.LanguageModelTextPart(trailingText));
			}
		}

		if (!finishedNormally) {
			this._req.audioBuffer = undefined;
			return;
		}
		this.flushAudioBuffer();

		if (invalidCount > 0) {
			// The English mirror is what the output channel and issue-report buffer record: count only - tool names and
			// argument snippets are response text and must never join it.
			if (this._req.lastFinishReason === "length") {
				//   The output limit cut the call mid-arguments -> the advice points at the limit instead
				const lengthDetail =
					invalidCount === 1
						? l10n.t("the output limit cut 1 tool call off mid-arguments")
						: l10n.t("the output limit cut {0} tool calls off mid-arguments", invalidCount);
				throw localizedError(
					chatErrorMessage(
						l10n.t(
							"The response hit the model's output limit in the middle of a tool call. Raise the model's max output tokens (a models.capabilities override, or max_tokens in models.parameters), or trim the request."
						),
						lengthDetail
					),
					`Tool call flush failed at end of stream: output limit cut ${invalidCount} tool call(s) mid-arguments`
				);
			}
			const detail =
				invalidCount === 1
					? l10n.t("1 tool call arrived with arguments that were not valid JSON")
					: l10n.t("{0} tool calls arrived with arguments that were not valid JSON", invalidCount);
			throw localizedError(
				chatErrorMessage(
					l10n.t(
						"The model sent a broken tool call, so this response could not be completed. Trying again usually fixes it."
					),
					detail
				),
				`Tool call flush failed at end of stream: ${invalidCount} tool call(s) with invalid JSON arguments`
			);
		}

		// A stream that produced nothing the host can show, but did drop reasoning, fails loudly instead of resolving
		// empty.
		if (this._req.contentParts === 0 && this._req.droppedReasoning.parts > 0) {
			throw localizedError(reasoningOnlyResponseMessage(), REASONING_ONLY_RESPONSE_MESSAGE);
		}

		this.emitTrailers();
	}

	/** Decoration, not response: the trailers report around the contentParts count, so they never satisfy a check. */
	private emitTrailers(): void {
		if (this._req.citations.size > 0) {
			const escapeTitle = (title: string) => title.replace(/[\r\n]+/g, " ").replace(/[[\]\\]/g, "\\$&");
			// encodeURIComponent leaves "(" and ")" alone, and those break markdown link targets; everything else needs
			// UTF-8-safe encoding.
			const escapeUrl = (url: string) =>
				url.replace(/[\s()]/g, (c) => (c === "(" ? "%28" : c === ")" ? "%29" : encodeURIComponent(c)));
			const lines = Array.from(this._req.citations.entries()).map(
				([url, title]) => `- [${escapeTitle(title)}](${escapeUrl(url)})`
			);
			this._progress.report(new vscode.LanguageModelTextPart(`\n\nSources:\n${lines.join("\n")}`));
		}

		// The retained usage trailer rides out as one DataPart with the bare mimeType "usage", the convention the
		// host-side consumer decodes into its token accounting. A host without the DataPart class drops it silently.
		if (this._req.usage !== undefined) {
			const payload = usageDataPartPayload(this._req.usage);
			if (payload !== undefined && this._dataPartCtor) {
				const part = this.constructDataPart(new TextEncoder().encode(JSON.stringify(payload)), "usage");
				if (part !== undefined) {
					this._progress.report(part);
				}
			}
		}
	}
}
