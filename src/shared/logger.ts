/**
 * Leveled sink, structurally satisfied by vscode.LogOutputChannel. The host
 * adds timestamps and level tags to channel lines, so callers pass bare text.
 */
export interface LogSink {
	info(message: string): void;
	error(message: string): void;
}

/** Structurally matched by IssueReporter; kept as an interface so unit tests can omit it. */
export interface ErrorRecorder {
	appendLog(line: string): void;
	recordError(source: string, error: unknown): void;
}

/**
 * The message text of an unknown thrown value, total by construction: the
 * instanceof check, the message read, and String() can all throw on a hostile
 * value, so every step degrades to the next fallback. Every boundary that
 * renders a caught unknown goes through here.
 */
export function errorMessageText(error: unknown): string {
	try {
		if (error instanceof Error) {
			return error.message;
		}
		return String(error);
	} catch {
		return objectTag(error);
	}
}

/** The Object.prototype.toString tag, itself guarded: a proxy's Symbol.toStringTag read can throw too. */
function objectTag(value: unknown): string {
	try {
		return Object.prototype.toString.call(value);
	} catch {
		return "[unrenderable value]";
	}
}

/**
 * A duck-typed optional string field of an unknown thrown value, total: a
 * hostile getter must not break logging, so a throwing read is no value.
 */
function stringFieldOf(error: unknown, field: "logClassification" | "englishMessage"): string | undefined {
	try {
		const value = (error as Record<string, unknown> | null | undefined)?.[field];
		return typeof value === "string" ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The classification-only rendering offered by errors whose message embeds
 * response-derived text. The canonical producer is MirroredError, but the read
 * stays duck-typed and total, because anything can be thrown at a logging
 * boundary.
 */
export function classificationOf(error: unknown): string | undefined {
	return stringFieldOf(error, "logClassification");
}

/**
 * The full English mirror of a localized display message. English-by-policy
 * surfaces - the output channel and, absent a classification, the issue-report
 * buffer - render it instead of the message, so translated text never lands in
 * logs or public issues. Duck-typed and total, like classificationOf.
 */
function englishMessageOf(error: unknown): string | undefined {
	return stringFieldOf(error, "englishMessage");
}

/**
 * A string proven to have gone through the public-rendering gate, so it may
 * sit in a field that log lines interpolate. Exactly two producers:
 * publicErrorText (the gate) and markLogSafe. A display string does not
 * compile into a branded slot, so "never log `.error`" is type-checked rather
 * than a convention.
 */
export type LogSafeErrorText = string & { readonly __brand: "logSafe" };

/**
 * Brand a string as log-safe WITHOUT the gate. Only for compile-time template
 * constants and values read back from this extension's own persistence, which
 * only ever stored branded values. Response-derived or display text belongs in
 * publicErrorText.
 */
export function markLogSafe(text: string): LogSafeErrorText {
	return text as LogSafeErrorText;
}

/**
 * The rendering of a thrown value for public surfaces (the issue-report buffer
 * and the latest-error snapshot, both of which prefill public GitHub issues):
 * its classification when it offers one, its English mirror when the display
 * message is localized, its message text otherwise.
 */
export function publicErrorText(error: unknown): LogSafeErrorText {
	return (classificationOf(error) ?? englishMessageOf(error) ?? errorMessageText(error)) as LogSafeErrorText;
}

/**
 * The single stack sanitizer behind every public stack rendering: strip V8's
 * `${name}: ${message}` first line BY LENGTH, never by line shape - an http
 * body can contain lines shaped like stack frames, so a shape filter alone
 * would keep attacker-controlled lines - and reattach the real call frames
 * under the caller's replacement first line. A stack not starting with the
 * exact prefix fails closed to the replacement alone. Takes the stack as the
 * caller's already-narrowed value so a hostile getter cannot swap it between
 * the check and the strip; name/message reads can still throw, so each caller
 * wraps this in its own catch fallback.
 */
function sanitizeStack(error: Error, stack: string, firstLine: string): string {
	const prefix = `${error.name}: ${error.message}`;
	if (!stack.startsWith(prefix)) {
		return firstLine;
	}
	const frames = stack
		.slice(prefix.length)
		.split("\n")
		.filter((line) => /^\s+at /.test(line));
	return [firstLine, ...frames].join("\n");
}

/**
 * The public rendering of a thrown value's stack (the issue-report buffer and
 * the latest-error snapshot). When the value classifies or mirrors its
 * message, sanitizeStack swaps the message line for the classification or the
 * English mirror.
 */
export function publicErrorStack(error: unknown): string | undefined {
	try {
		if (!(error instanceof Error)) {
			return undefined;
		}
		const stack = error.stack;
		if (typeof stack !== "string") {
			return undefined;
		}
		const classification = classificationOf(error);
		const english = englishMessageOf(error);
		if (classification === undefined && english === undefined) {
			return stack;
		}
		return sanitizeStack(error, stack, classification ?? `${error.name}: ${english}`);
	} catch {
		// classificationOf and englishMessageOf are total; a hostile
		// stack/name/message getter loses its frames, never breaks logging.
		return classificationOf(error) ?? englishMessageOf(error);
	}
}

/**
 * The stack for the output channel, total against hostile proxies. The channel
 * stays English, so sanitizeStack swaps a mirrored error's message line for
 * the English mirror rather than printing a possibly-localized first line.
 */
function channelErrorStack(error: unknown): string | undefined {
	try {
		if (!(error instanceof Error)) {
			return undefined;
		}
		const stack = error.stack;
		if (typeof stack !== "string" || stack.length === 0) {
			return undefined;
		}
		const english = englishMessageOf(error);
		if (english === undefined) {
			return stack;
		}
		return sanitizeStack(error, stack, `${error.name}: ${english}`);
	} catch {
		return undefined;
	}
}

/** JSON for log data, total: circular or otherwise unserializable data degrades to its object tag instead of throwing inside logging. */
function logDataText(data: unknown): string {
	try {
		return JSON.stringify(data, null, 2) ?? objectTag(data);
	} catch {
		return objectTag(data);
	}
}

/**
 * The single logging implementation for the extension. Every line goes to the
 * output channel and, when a recorder is attached, to the issue-report buffer,
 * except advisory(), the one deliberate channel-only path. Channel output is
 * not readable back, so the buffer keeps its own [ISO] lines.
 */
export class Logger {
	constructor(
		private readonly output: LogSink,
		private readonly recorder?: ErrorRecorder
	) {}

	log(message: string, data?: unknown): void {
		const text = data !== undefined ? `${message}: ${logDataText(data)}` : message;
		this.output.info(text);
		this.recorder?.appendLog(`[${new Date().toISOString()}] ${text}`);
	}

	/**
	 * An advisory note: the output channel only, never the issue-report buffer.
	 * The buffer is a small ring, and informational lines that recur on every
	 * serve pass would evict the real errors an issue report exists to carry.
	 * The channel is still user-pasteable, so the classification-only rule is
	 * unchanged: keys and classifications, never response-derived text.
	 */
	advisory(message: string, data?: unknown): void {
		this.output.info(data !== undefined ? `${message}: ${logDataText(data)}` : message);
	}

	error(message: string, error: unknown): void {
		// The channel stays English by policy and keeps the full message; the
		// buffer opens public issues, so it takes the classification when there
		// is one.
		const text = `${message}: ${englishMessageOf(error) ?? errorMessageText(error)}`;
		this.output.error(text);
		this.recorder?.appendLog(`[${new Date().toISOString()}] ERROR: ${message}: ${publicErrorText(error)}`);
		const stack = channelErrorStack(error);
		if (stack !== undefined) {
			this.output.error(`Stack trace: ${stack}`);
		}
		this.recorder?.recordError(message, error);
	}
}
