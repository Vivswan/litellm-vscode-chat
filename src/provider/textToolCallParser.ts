const BEGIN = "<|tool_call_begin|>";
const ARG_BEGIN = "<|tool_call_argument_begin|>";
const END = "<|tool_call_end|>";

/** Inline tool call recovered from control tokens embedded in streamed text. */
export interface TextToolCall {
	/** Monotonic identity within one parser lifetime; lets callers pair a provisional call with its completion. */
	seq: number;
	name?: string;
	index?: number;
	args: string;
}

export type TextParseEvent = { type: "text"; text: string } | { type: "call"; call: TextToolCall };

export interface TextParseResult {
	/** Text and completed calls in the order they appeared in the input. */
	events: TextParseEvent[];
	/** Call whose argument section is still open; args reflect what has arrived so far. */
	provisionalCall?: TextToolCall;
}

/**
 * Length of the longest proper prefix of `token` that `data` ends with, i.e.
 * how many trailing characters must be held back because the next chunk may
 * complete the token.
 */
export function longestPartialSuffixHold(data: string, token: string): number {
	for (let k = Math.min(token.length - 1, data.length); k > 0; k--) {
		if (data.endsWith(token.slice(0, k))) {
			return k;
		}
	}
	return 0;
}

/** Parse the "name" or "name:index" header between the begin token and the next delimiter. */
export function parseToolHeader(header: string): { name?: string; index?: number } {
	const m = header.trim().match(/^([A-Za-z0-9_\-.]+)(?::(\d+))?/);
	return { name: m?.[1], index: m?.[2] ? Number(m[2]) : undefined };
}

export function stripControlTokens(text: string): string {
	return text
		.replace(/<\|[a-zA-Z0-9_-]+_section_(?:begin|end)\|>/g, "")
		.replace(/<\|tool_call_(?:argument_)?(?:begin|end)\|>/g, "");
}

interface ActiveCall {
	seq: number;
	name?: string;
	index?: number;
	argBuffer: string;
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
					const hold = longestPartialSuffixHold(data, BEGIN);
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
					this._active = { seq: ++this._seqCounter, name: header.name, index: header.index, argBuffer: "" };
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
			if (endAt === -1) {
				const hold = longestPartialSuffixHold(data, END);
				this._active.argBuffer += data.slice(0, data.length - hold);
				this._buffer = data.slice(data.length - hold);
				break;
			}
			this._active.argBuffer += data.slice(0, endAt);
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
	 */
	flush(): TextParseResult {
		const events: TextParseEvent[] = this._buffer ? [{ type: "text", text: this._buffer }] : [];
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
