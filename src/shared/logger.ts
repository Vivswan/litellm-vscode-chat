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
 * instanceof check, the message read, and String() can all throw (a revoked
 * or hostile proxy, a non-callable toString, a hostile Symbol.toPrimitive),
 * so every step degrades to the next fallback. Every boundary that renders a
 * caught unknown (status construction, the log sink) goes through here so
 * none of them can die on a hostile value.
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
 * Errors whose user-facing message embeds response-derived text offer a
 * classification-only rendering under a `logClassification` property. The
 * canonical producer is MirroredError (shared/mirroredError.ts, RequestError
 * included), whose constructor demands the field or its englishMessage twin;
 * the read here stays duck-typed and total against hostile getters, because
 * anything can be thrown at a logging boundary. Exported for log sites that
 * want the classification alone (never the message fallback publicErrorText
 * carries).
 */
export function classificationOf(error: unknown): string | undefined {
	try {
		const classification = (error as { logClassification?: unknown } | null | undefined)?.logClassification;
		return typeof classification === "string" ? classification : undefined;
	} catch {
		// A hostile logClassification getter must not break logging.
		return undefined;
	}
}

/**
 * The full English mirror of a localized display message, offered under an
 * `englishMessage` property. The canonical producer is MirroredError
 * (shared/mirroredError.ts; RequestError and the localizedError factory ride
 * on it). English-by-policy surfaces - the output channel and, absent a
 * classification, the issue-report buffer - render it instead of the message,
 * so a translated display string never lands in logs or public issues. The
 * read stays duck-typed and total against hostile getters.
 */
function englishMessageOf(error: unknown): string | undefined {
	try {
		const english = (error as { englishMessage?: unknown } | null | undefined)?.englishMessage;
		return typeof english === "string" ? english : undefined;
	} catch {
		// A hostile englishMessage getter must not break logging.
		return undefined;
	}
}

/**
 * A string proven to have gone through the public-rendering gate, so it may
 * sit in a field that log lines interpolate (ServerStatus.logSafeError, the
 * status bar's error state). The brand has exactly two producers:
 * publicErrorText (the gate) and markLogSafe (compile-time template
 * constants and this extension's own persistence, which only ever stored
 * gate output). A display string does not compile into a branded slot, so
 * the "never log `.error`" rule is enforced by the type checker, not by
 * convention.
 */
export type LogSafeErrorText = string & { readonly __brand: "logSafe" };

/**
 * Brand a string as log-safe WITHOUT the gate. Only for compile-time
 * template constants ("Unknown error", restore placeholders) and values read
 * back from this extension's own persistence (which only ever stored branded
 * values). Passing response-derived or display text here defeats the brand -
 * use publicErrorText.
 */
export function markLogSafe(text: string): LogSafeErrorText {
	return text as LogSafeErrorText;
}

/**
 * The rendering of a thrown value for public surfaces (the issue-report
 * buffer and the latest-error snapshot, both of which prefill public GitHub
 * issues): its classification when it offers one, its English mirror when
 * the display message is localized, its message text otherwise.
 */
export function publicErrorText(error: unknown): LogSafeErrorText {
	return (classificationOf(error) ?? englishMessageOf(error) ?? errorMessageText(error)) as LogSafeErrorText;
}

/**
 * The public rendering of a thrown value's stack. When the value classifies
 * its message away (or mirrors it in English), the `${name}: ${message}`
 * prefix V8 puts on the stack is stripped BY LENGTH, never by line shape: an
 * http body can contain lines shaped like stack frames ("\tat
 * com.acme.internal...(...)"), so a shape filter alone would keep
 * attacker-controlled lines. A stack that does not start with the exact
 * prefix fails closed to the replacement alone; the frame filter afterwards
 * is belt and braces. A classification replaces the whole message line; an
 * English mirror keeps the `${name}: ` convention.
 */
export function publicErrorStack(error: unknown): string | undefined {
	try {
		if (!(error instanceof Error) || typeof error.stack !== "string") {
			return undefined;
		}
		const classification = classificationOf(error);
		const english = englishMessageOf(error);
		if (classification === undefined && english === undefined) {
			return error.stack;
		}
		const replacement = classification ?? `${error.name}: ${english}`;
		const prefix = `${error.name}: ${error.message}`;
		if (!error.stack.startsWith(prefix)) {
			return replacement;
		}
		const frames = error.stack
			.slice(prefix.length)
			.split("\n")
			.filter((line) => /^\s+at /.test(line));
		return [replacement, ...frames].join("\n");
	} catch {
		// classificationOf and englishMessageOf are total; a hostile
		// stack/name/message getter loses its frames, never breaks logging.
		return classificationOf(error) ?? englishMessageOf(error);
	}
}

/**
 * The stack for the output channel, total: instanceof and the stack getter
 * can both throw on hostile proxies. The channel stays English, so a
 * mirrored error's stack has its `${name}: ${message}` prefix stripped BY
 * LENGTH (publicErrorStack's technique) and replaced with the English
 * mirror; a stack that does not start with the exact prefix fails closed to
 * the mirror line alone rather than printing a possibly-localized first
 * line. Unmirrored errors keep their raw stack - their message is English
 * already.
 */
function channelErrorStack(error: unknown): string | undefined {
	try {
		if (!(error instanceof Error) || typeof error.stack !== "string" || error.stack.length === 0) {
			return undefined;
		}
		const english = englishMessageOf(error);
		if (english === undefined) {
			return error.stack;
		}
		const replacement = `${error.name}: ${english}`;
		const prefix = `${error.name}: ${error.message}`;
		if (!error.stack.startsWith(prefix)) {
			return replacement;
		}
		const frames = error.stack
			.slice(prefix.length)
			.split("\n")
			.filter((line) => /^\s+at /.test(line));
		return [replacement, ...frames].join("\n");
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
 * so litellm.reportIssue sees logs from all layers - except advisory(), the
 * one deliberate channel-only path. Channel output is not readable back, so
 * the buffer keeps its own hand-formatted [ISO] lines.
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
	 * An advisory note: the output channel only, never the issue-report
	 * buffer. The buffer is a small ring (the issue reporter's 50-entry
	 * budget), and informational lines that recur on every serve pass - open
	 * capability fields applied as-is, for one - would evict the real errors
	 * an issue report exists to carry. Problems stay on log()/error(). The
	 * channel is still user-pasteable, so the classification-only rule is
	 * unchanged: keys and classifications, never response-derived text or
	 * values. The dashboard's ConfigDiagnosticSeverity "advisory"
	 * (dashboard/protocol.ts) is the same informational-not-problem
	 * concept on the diagnostics surface.
	 */
	advisory(message: string, data?: unknown): void {
		this.output.info(data !== undefined ? `${message}: ${logDataText(data)}` : message);
	}

	error(message: string, error: unknown): void {
		// The output channel stays English by policy: a localized display
		// message defers to the full English mirror when the error carries one
		// (response detail included; the channel is the local debugging surface).
		const text = `${message}: ${englishMessageOf(error) ?? errorMessageText(error)}`;
		this.output.error(text);
		// The channel keeps the full message (local debugging surface); the
		// buffer opens public issues, so it takes the classification when the
		// error carries one.
		this.recorder?.appendLog(`[${new Date().toISOString()}] ERROR: ${message}: ${publicErrorText(error)}`);
		const stack = channelErrorStack(error);
		if (stack !== undefined) {
			this.output.error(`Stack trace: ${stack}`);
		}
		this.recorder?.recordError(message, error);
	}
}
