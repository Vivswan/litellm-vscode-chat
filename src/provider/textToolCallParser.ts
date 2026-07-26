const BEGIN = "<|tool_call_begin|>";
const ARG_BEGIN = "<|tool_call_argument_begin|>";
const ARG_END = "<|tool_call_argument_end|>";
const END = "<|tool_call_end|>";

/** Inline tool call recovered from control tokens embedded in streamed text. */
export interface TextToolCall {
	/** Monotonic identity within one parser lifetime; lets callers pair a provisional call with its completion. */
	seq: number;
	name?: string | undefined;
	index?: number | undefined;
	args: string;
}

export type TextParseEvent = { type: "text"; text: string } | { type: "call"; call: TextToolCall };

export interface TextParseResult {
	/** Text and completed calls in the order they appeared in the input. */
	events: TextParseEvent[];
	/** Call whose argument section is still open; args reflect what has arrived so far. */
	provisionalCall?: TextToolCall | undefined;
}

/**
 * Length of the longest proper prefix of `token` that `data` ends with, i.e.
 * how many trailing characters must be held back because the next chunk may
 * complete the token.
 */
function longestPartialSuffixHold(data: string, token: string): number {
	for (let k = Math.min(token.length - 1, data.length); k > 0; k--) {
		if (data.endsWith(token.slice(0, k))) {
			return k;
		}
	}
	return 0;
}

/** Parse the "name" or "name:index" header between the begin token and the next delimiter. */
function parseToolHeader(header: string): { name?: string | undefined; index?: number | undefined } {
	const m = header.trim().match(/^([A-Za-z0-9_\-.]+)(?::(\d+))?/);
	return { name: m?.[1], index: m?.[2] ? Number(m[2]) : undefined };
}

function stripControlTokens(text: string): string {
	return text
		.replace(/<\|[a-zA-Z0-9_-]+_section_(?:begin|end)\|>/g, "")
		.replace(/<\|tool_call_(?:argument_)?(?:begin|end)\|>/g, "");
}

/**
 * True when `text` is the remains of a tool call the stream truncated: either
 * a nonempty proper prefix of a structural token, or a call opened by a
 * complete begin token that never reached its end token (the parser buffers
 * those as BEGIN + remainder while waiting for the argument delimiter).
 */
export function isTruncatedToolCallText(text: string): boolean {
	if (text.length === 0) {
		return false;
	}
	if (text.startsWith(BEGIN)) {
		return true;
	}
	// A tail that already spells out "_section" can only be a truncated section
	// marker, which is protocol text, never model output.
	if (text.startsWith("<|") && text.includes("_section")) {
		return true;
	}
	// One- and two-character prefixes ("<", "<|") are far more likely the tail
	// of ordinary output than a truncated token, and dropping them saves the
	// user from nothing; longer structural prefixes are unambiguous.
	return [BEGIN, ARG_BEGIN, ARG_END, END].some(
		(literal) => text.length >= 3 && text.length < literal.length && literal.startsWith(text)
	);
}

/** True when `tail` (starting at "<") could still grow into a control token. */
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
 * How many trailing characters must be held back because the chunk may end in
 * the middle of a control token — the begin token that opens a call, but also
 * the strippable shapes (section markers, stray end/argument tokens), which
 * would otherwise leak into visible text when split across chunk boundaries.
 */
function controlTokenHold(data: string): number {
	const lastLt = data.lastIndexOf("<");
	if (lastLt === -1) {
		return 0;
	}
	const tail = data.slice(lastLt);
	return isPartialControlToken(tail) ? tail.length : 0;
}

interface ActiveCall {
	seq: number;
	name?: string | undefined;
	index?: number | undefined;
	argBuffer: string;
	/** Set when an argument-end token closed the args; anything before the end token is then discarded. */
	argsClosed: boolean;
}

/**
 * Incremental scanner for `<|tool_call_begin|>name<|tool_call_argument_begin|>{...}<|tool_call_end|>`
 * sequences embedded in streamed text. Pure state machine: emission, dedup,
 * and call IDs are the caller's concern.
 */
export class TextToolCallParser {
	private _buffer = "";
	private _active: ActiveCall | undefined;
	private _seqCounter = 0;

	push(chunk: string): TextParseResult {
		let data = this._buffer + chunk;
		this._buffer = "";
		const events: TextParseEvent[] = [];
		const pushText = (text: string) => {
			if (!text) {
				return;
			}
			const last = events[events.length - 1];
			if (last?.type === "text") {
				last.text += text;
			} else {
				events.push({ type: "text", text });
			}
		};

		while (data.length > 0) {
			if (!this._active) {
				const beginAt = data.indexOf(BEGIN);
				if (beginAt === -1) {
					const hold = controlTokenHold(data);
					pushText(stripControlTokens(data.slice(0, data.length - hold)));
					this._buffer = data.slice(data.length - hold);
					break;
				}
				pushText(stripControlTokens(data.slice(0, beginAt)));
				data = data.slice(beginAt + BEGIN.length);

				const argAt = data.indexOf(ARG_BEGIN);
				const endAt = data.indexOf(END);
				if (argAt !== -1 && (endAt === -1 || argAt < endAt)) {
					const header = parseToolHeader(data.slice(0, argAt));
					this._active = {
						seq: ++this._seqCounter,
						name: header.name,
						index: header.index,
						argBuffer: "",
						argsClosed: false,
					};
					data = data.slice(argAt + ARG_BEGIN.length);
				} else if (endAt !== -1) {
					const header = parseToolHeader(data.slice(0, endAt));
					events.push({
						type: "call",
						call: { seq: ++this._seqCounter, name: header.name, index: header.index, args: "{}" },
					});
					data = data.slice(endAt + END.length);
				} else {
					this._buffer = BEGIN + data;
					break;
				}
				continue;
			}

			const endAt = data.indexOf(END);
			if (!this._active.argsClosed) {
				const argEndAt = data.indexOf(ARG_END);
				if (argEndAt !== -1 && (endAt === -1 || argEndAt < endAt)) {
					// Some providers close arguments explicitly; the token must not
					// contaminate the JSON or the whole call fails to parse.
					this._active.argBuffer += data.slice(0, argEndAt);
					this._active.argsClosed = true;
					data = data.slice(argEndAt + ARG_END.length);
					continue;
				}
				if (endAt === -1) {
					const hold = Math.max(longestPartialSuffixHold(data, END), longestPartialSuffixHold(data, ARG_END));
					this._active.argBuffer += data.slice(0, data.length - hold);
					this._buffer = data.slice(data.length - hold);
					break;
				}
				this._active.argBuffer += data.slice(0, endAt);
			} else if (endAt === -1) {
				const hold = longestPartialSuffixHold(data, END);
				this._buffer = data.slice(data.length - hold);
				break;
			}
			data = data.slice(endAt + END.length);
			events.push({
				type: "call",
				call: {
					seq: this._active.seq,
					name: this._active.name,
					index: this._active.index,
					args: this._active.argBuffer,
				},
			});
			this._active = undefined;
		}

		return { events, provisionalCall: this.snapshotActive() };
	}

	/**
	 * Drain end-of-stream state. A text event carries any held-back partial
	 * token text; provisionalCall carries a call still missing its end token.
	 * While a call is active the buffer is call-internal (a partial end token),
	 * never visible text, so it is discarded rather than emitted.
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
