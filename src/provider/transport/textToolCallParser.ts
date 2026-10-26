/** Opens a text-form tool call; the header (the tool name and its optional ":index") follows. */
const BEGIN = "<|tool_call_begin|>";

/** Closes the header and opens the argument text. */
const ARG_BEGIN = "<|tool_call_argument_begin|>";

/** Closes the argument text; anything between it and END is discarded. */
const ARG_END = "<|tool_call_argument_end|>";

/** Closes the call; reached before ARG_BEGIN it closes a header-only call whose args read "{}". */
const END = "<|tool_call_end|>";

/** The most header text held behind a begin sigil while its argument-begin or end token is still to come. */
export const MAX_TOOL_CALL_HEADER_LENGTH = 256;

/**
 * A parsed text-form call. `seq` is a monotonic identity within one parser lifetime, letting callers pair a
 * provisional call with its completion.
 */
export interface TextToolCall {
	seq: number;

	name?: string | undefined;

	index?: number | undefined;

	args: string;
}

export type TextParseEvent = { type: "text"; text: string } | { type: "call"; call: TextToolCall };

/**
 * The events of one push; `provisionalCall` is the call whose argument section is still open, its args what has
 * arrived so far.
 */
export interface TextParseResult {
	events: TextParseEvent[];

	provisionalCall?: TextToolCall | undefined;
}

/**
 * Length of the longest proper prefix of `token` that `data` ends with, i.e. how many trailing characters must be held
 * back because the next chunk may complete the token.
 */
function longestPartialSuffixHold(data: string, token: string): number {
	for (let k = Math.min(token.length - 1, data.length); k > 0; k--) {
		if (data.endsWith(token.slice(0, k))) {
			return k;
		}
	}
	return 0;
}

function parseToolHeader(header: string): { name?: string | undefined; index?: number | undefined } {
	const m = header.trim().match(/^([A-Za-z0-9_\-.]+)(?::(\d+))?/);
	return { name: m?.[1], index: m?.[2] ? Number(m[2]) : undefined };
}

function stripControlTokens(text: string): string {
	return text
		.replace(/<\|[a-zA-Z0-9_-]+_section_(?:begin|end)\|>/g, "")
		.replace(/<\|tool_call_(?:argument_)?(?:begin|end)\|>/g, "");
}

export function isTruncatedToolCallText(text: string): boolean {
	if (text.length === 0) {
		return false;
	}
	if (text.startsWith(BEGIN)) {
		return true;
	}
	if (text.startsWith("<|") && text.includes("_section")) {
		return true;
	}
	// One- and two-character prefixes ("<", "<|") are far more likely ordinary
	// output than a truncated token; longer structural prefixes are unambiguous.
	return [BEGIN, ARG_BEGIN, ARG_END, END].some(
		(literal) => text.length >= 3 && text.length < literal.length && literal.startsWith(text)
	);
}

function isPartialControlToken(tail: string): boolean {
	for (const literal of [BEGIN, ARG_BEGIN, ARG_END, END]) {
		if (tail.length < literal.length && literal.startsWith(tail)) {
			return true;
		}
	}
	if (tail === "<" || tail === "<|") {
		return true;
	}
	const m = tail.match(/^<\|([a-zA-Z0-9_-]+)(\|)?$/);
	if (!m || m[1] === undefined) {
		return false;
	}
	// A trailing "|" can only complete to "|>" when the identifier is already a
	// full section-marker name; without it the identifier may still be growing.
	return m[2] === undefined || /_section_(?:begin|end)$/.test(m[1]);
}

/**
 * How many trailing characters must be held back because the chunk may end mid control token: the begin token that
 * opens a call, but also the strippable shapes (section markers, stray end/argument tokens), which would otherwise leak
 * into visible text when split across chunk boundaries.
 */
function controlTokenHold(data: string): number {
	const lastLt = data.lastIndexOf("<");
	if (lastLt === -1) {
		return 0;
	}
	const tail = data.slice(lastLt);
	return isPartialControlToken(tail) ? tail.length : 0;
}

/**
 * The call being parsed; `argsClosed` is set when an argument-end token closed the args, and anything before the end
 * token is then discarded.
 */
interface ActiveCall {
	seq: number;

	name?: string | undefined;

	index?: number | undefined;

	argBuffer: string;

	argsClosed: boolean;
}

/** Appends text to the event list, merging it into a trailing text event. */
function appendText(events: TextParseEvent[], text: string): void {
	if (!text) {
		return;
	}
	const last = events[events.length - 1];
	if (last?.type === "text") {
		last.text += text;
	} else {
		events.push({ type: "text", text });
	}
}

/**
 * Incremental scanner for `<|tool_call_begin|>name<|tool_call_argument_begin|>{...}<|tool_call_end|>`
 * sequences embedded in streamed text. Pure state machine: emission, dedup,
 * and call IDs are the caller's concern. A header longer than MAX_TOOL_CALL_HEADER_LENGTH means the sigil was prose:
 * the OpenAI API caps function names at 64 characters, so four times that clears longer MCP-prefixed names, while a
 * sigil a model merely wrote about holds at most this much of the reply instead of all of it until the end-of-stream
 * flush drops it.
 */
export class TextToolCallParser {
	private _buffer = "";

	private _active: ActiveCall | undefined;

	private _seqCounter = 0;

	/**
	 * Behind a begin sigil: a complete header opens the call (or emits a header-only one), a short incomplete header
	 * waits for more, and anything longer was prose. Returns what is left to scan, or undefined once the remainder is
	 * buffered for the next chunk.
	 */
	private openCall(data: string, events: TextParseEvent[]): string | undefined {
		const argAt = data.indexOf(ARG_BEGIN);
		const endAt = data.indexOf(END);
		const opensArgs = argAt !== -1 && (endAt === -1 || argAt < endAt);
		const headerEnd = opensArgs ? argAt : endAt;
		if (headerEnd !== -1 && headerEnd <= MAX_TOOL_CALL_HEADER_LENGTH) {
			const header = parseToolHeader(data.slice(0, headerEnd));
			if (opensArgs) {
				this._active = {
					seq: ++this._seqCounter,
					name: header.name,
					index: header.index,
					argBuffer: "",
					argsClosed: false,
				};
				return data.slice(argAt + ARG_BEGIN.length);
			}
			events.push({
				type: "call",
				call: { seq: ++this._seqCounter, name: header.name, index: header.index, args: "{}" },
			});
			return data.slice(endAt + END.length);
		}
		// The header candidate: everything up to the terminator, or, with none in sight, everything but a tail
		// that may still grow into one.
		const candidate = headerEnd === -1 ? data.length - controlTokenHold(data) : headerEnd;
		if (headerEnd === -1 && candidate <= MAX_TOOL_CALL_HEADER_LENGTH) {
			this._buffer = BEGIN + data;
			return undefined;
		}
		// Longer than any header: the sigil was prose. The text streams up to the next sigil, which the rescan
		// judges on its own, so a real call behind the prose still parses.
		const nextBegin = data.indexOf(BEGIN);
		const release = nextBegin !== -1 && nextBegin < candidate ? nextBegin : candidate;
		appendText(events, stripControlTokens(data.slice(0, release)));
		return data.slice(release);
	}

	/**
	 * Outside a call: the prose up to the next begin sigil streams, and the call behind the sigil opens. Returns what
	 * is left to scan, or undefined once the remainder is buffered for the next chunk.
	 */
	private consumeProse(data: string, events: TextParseEvent[]): string | undefined {
		const beginAt = data.indexOf(BEGIN);
		if (beginAt === -1) {
			const hold = controlTokenHold(data);
			appendText(events, stripControlTokens(data.slice(0, data.length - hold)));
			this._buffer = data.slice(data.length - hold);
			return undefined;
		}
		appendText(events, stripControlTokens(data.slice(0, beginAt)));
		return this.openCall(data.slice(beginAt + BEGIN.length), events);
	}

	/**
	 * Inside a call: argument text accumulates until the end token closes the call, an explicit argument-end token
	 * closing the arguments first. Returns what is left to scan, or undefined once the remainder is buffered for the
	 * next chunk.
	 */
	private consumeArguments(data: string, events: TextParseEvent[], active: ActiveCall): string | undefined {
		const endAt = data.indexOf(END);
		if (!active.argsClosed) {
			const argEndAt = data.indexOf(ARG_END);
			if (argEndAt !== -1 && (endAt === -1 || argEndAt < endAt)) {
				// Some providers close arguments explicitly; the token must not contaminate the JSON or the whole
				// call fails to parse.
				active.argBuffer += data.slice(0, argEndAt);
				active.argsClosed = true;
				return data.slice(argEndAt + ARG_END.length);
			}
			if (endAt === -1) {
				const hold = Math.max(longestPartialSuffixHold(data, END), longestPartialSuffixHold(data, ARG_END));
				active.argBuffer += data.slice(0, data.length - hold);
				this._buffer = data.slice(data.length - hold);
				return undefined;
			}
			active.argBuffer += data.slice(0, endAt);
		} else if (endAt === -1) {
			const hold = longestPartialSuffixHold(data, END);
			this._buffer = data.slice(data.length - hold);
			return undefined;
		}
		events.push({
			type: "call",
			call: { seq: active.seq, name: active.name, index: active.index, args: active.argBuffer },
		});
		this._active = undefined;
		return data.slice(endAt + END.length);
	}

	push(chunk: string): TextParseResult {
		let data = this._buffer + chunk;
		this._buffer = "";
		const events: TextParseEvent[] = [];

		while (data.length > 0) {
			const rest = this._active ? this.consumeArguments(data, events, this._active) : this.consumeProse(data, events);
			if (rest === undefined) {
				break;
			}
			data = rest;
		}

		return { events, provisionalCall: this.snapshotActive() };
	}

	/**
	 * While a call is active the buffer is call-internal (a partial end token), never visible text, so it is
	 * discarded.
	 */
	flush(): TextParseResult {
		const events: TextParseEvent[] = this._buffer && !this._active ? [{ type: "text", text: this._buffer }] : [];
		const provisionalCall = this.snapshotActive();
		this._buffer = "";
		this._active = undefined;
		return { events, provisionalCall };
	}

	private snapshotActive(): TextToolCall | undefined {
		if (!this._active) {
			return undefined;
		}
		return { seq: this._active.seq, name: this._active.name, index: this._active.index, args: this._active.argBuffer };
	}
}
