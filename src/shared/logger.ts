/**
 * Leveled sink, structurally satisfied by vscode.LogOutputChannel. The host adds timestamps and level tags to channel
 * lines, so callers pass bare text.
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

/** A proxy's Symbol.toStringTag read can throw too. */
function objectTag(value: unknown): string {
	try {
		return Object.prototype.toString.call(value);
	} catch {
		return "[unrenderable value]";
	}
}

/** A hostile getter must not break logging, so a throwing read is no value. */
function stringFieldOf(error: unknown, field: "logClassification" | "englishMessage"): string | undefined {
	try {
		const value = (error as Record<string, unknown> | null | undefined)?.[field];
		return typeof value === "string" ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The classification-only rendering offered by errors whose message embeds response-derived text. The canonical
 * producer is MirroredError, but the read stays duck-typed and total, because anything can be thrown at a logging
 * boundary.
 */
export function classificationOf(error: unknown): string | undefined {
	return stringFieldOf(error, "logClassification");
}

/**
 * The full English mirror of a localized display message. English-by-policy surfaces - the output channel and, absent
 * a classification, the issue-report buffer - render it instead of the message.
 */
function englishMessageOf(error: unknown): string | undefined {
	return stringFieldOf(error, "englishMessage");
}

/** Exactly two producers: publicErrorText (the gate) and markLogSafe. */
export type LogSafeErrorText = string & { readonly __brand: "logSafe" };

/** Response-derived or display text belongs in publicErrorText. */
export function markLogSafe(text: string): LogSafeErrorText {
	return text as LogSafeErrorText;
}

/**
 * The rendering of a thrown value for public surfaces (the issue-report buffer and the latest-error snapshot, both of
 * which prefill public GitHub issues).
 */
export function publicErrorText(error: unknown): LogSafeErrorText {
	return (classificationOf(error) ?? englishMessageOf(error) ?? errorMessageText(error)) as LogSafeErrorText;
}

/**
 * The error may be attacker-shaped (a response body in the message, hostile getters), so each hazard has a fixed
 * handling.
 *
 *   frame-shaped lines inside an http body in the message -> the message line goes BY LENGTH, never by shape
 *   a hostile stack getter                                -> the stack arrives pre-narrowed, so nothing swaps it
 *                                                            between check and strip
 *   a name or message getter that throws                  -> each caller wraps this in its own catch
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

/** The public rendering of a thrown value's stack. */
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
		// classificationOf and englishMessageOf are total; a hostile stack/name/message getter loses its frames, never
		// breaks logging.
		return classificationOf(error) ?? englishMessageOf(error);
	}
}

/**
 * The stack for the output channel, total against hostile proxies. The channel stays English, so sanitizeStack swaps a
 * mirrored error's message line for the English mirror rather than printing a possibly-localized first line.
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

/** Circular or otherwise unserializable data degrades to its object tag instead of throwing inside logging. */
function logDataText(data: unknown): string {
	try {
		return JSON.stringify(data, null, 2) ?? objectTag(data);
	} catch {
		return objectTag(data);
	}
}

/**
 * The single logging implementation for the extension.
 * Channel output is not readable back, so the buffer keeps its own [ISO] lines.
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
	 * The buffer is a small ring, and informational lines that recur on every serve pass would evict the real errors an
	 * issue report exists to carry. The channel is still user-pasteable, so the classification-only rule is unchanged:
	 * keys and classifications, never response-derived text.
	 */
	advisory(message: string, data?: unknown): void {
		this.output.info(data !== undefined ? `${message}: ${logDataText(data)}` : message);
	}

	error(message: string, error: unknown): void {
		// The channel stays English by policy and keeps the full message; the buffer opens public issues, so it takes
		// the classification when there is one.
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
