import type { TransportErrorClassification } from "./errorClassification";
import { transportClassificationOf } from "./errorClassification";
import { REDACTED_MARKER, revealOf, safeCut, secretSpans } from "./util/secretMask";

/**
 * Leveled sink, structurally satisfied by vscode.LogOutputChannel. The host adds timestamps and level tags to channel
 * lines, so callers pass bare text.
 */
export interface LogSink {
	info(message: string): void;
	error(message: string): void;
}

/** What a recorder receives for a thrown value: its public renderings, never the value itself. */
export interface RecordedError {
	readonly message: string;
	readonly stack?: string | undefined;
	/** Enum ids and a status number, read off a transport error; absent for anything else. */
	readonly classification?: TransportErrorClassification | undefined;
}

/**
 * Structurally matched by IssueReporter; kept as an interface so unit tests can omit it. `appendLog` is for a recorder
 * that also wants every report line as it is written (the session log tee); the report itself reads the Logger's
 * history (reportLines).
 */
export interface ErrorRecorder {
	appendLog?(line: string): void;
	recordError(source: string, error: RecordedError): void;
}

export function errorMessageText(error: unknown): string {
	try {
		if (error instanceof Error) {
			// Read once: Error.message is declared a string, but a getter can hand back anything, differently each time.
			const message: unknown = error.message;
			return typeof message === "string" ? message : String(message);
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
function classificationOf(error: unknown): string | undefined {
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

/** What the public surfaces record for a thrown value that carries neither a classification nor an English mirror. */
const UNCLASSIFIED = "unclassified";

/**
 * The rendering of a thrown value for public surfaces (the issue-report buffer, the latest-error snapshot, and the
 * status window, all of which prefill public GitHub issues): the classification, else the English mirror, else the
 * word "unclassified". A thrown message never reaches them - it may be localized, or a response body - so an
 * unclassified throw records nothing but the fact of it; the output channel keeps the message (Logger.error).
 */
export function publicErrorText(error: unknown): LogSafeErrorText {
	return (classificationOf(error) ?? englishMessageOf(error) ?? UNCLASSIFIED) as LogSafeErrorText;
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

/**
 * The public rendering of a thrown value's stack: the frames under the public text (publicErrorText), never under the
 * thrown message.
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
		return sanitizeStack(
			error,
			stack,
			classification ?? (english === undefined ? UNCLASSIFIED : `${error.name}: ${english}`)
		);
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
 * What replay restores after a logs.redactSecrets flip: the channel's own history, held raw. The line and character
 * bounds evict channel-only entries (advisory lines, stack prints), oldest first, so a run of stack prints cannot pin
 * hundreds of megabytes in the extension host; a single line past CHANNEL_LINE_CHARS is cut at write, with a marker,
 * since neither the channel nor the replay can use it whole. The raw cut never splits a value the door would replace
 * (safeCut), so the kept prefix masks the same in either mode; a report rendering is cut and charged the same way,
 * since the report masks it later. The masked rendering masks FIRST and cuts the masked text plainly, so a value
 * astride the bound is masked whole, never cut.
 */
const CHANNEL_HISTORY_LINES = 200;
const CHANNEL_HISTORY_CHARS = 1_048_576;
const CHANNEL_LINE_CHARS = 262_144;
/**
 * The issue report's share of the same history: the entries that carry a report rendering, capped by their own count
 * so channel-only traffic never evicts the errors a report exists to carry.
 */
const REPORT_LOG_LINES = 50;

/** A text cut at `at` with a marker saying how much went; the identity when nothing is past `at`. */
function cutAt(text: string, at: number): string {
	return text.length <= at ? text : `${text.slice(0, at)} [${text.length - at} more characters cut]`;
}

function cutPlainly(text: string): string {
	return cutAt(text, CHANNEL_LINE_CHARS);
}

/** The replacement for one merged span: a long single value keeps its first six characters, everything else goes whole. */
function replacementFor(value: string | undefined): string {
	return (value === undefined ? undefined : revealOf(value)) ?? REDACTED_MARKER;
}

/**
 * The recorder's view of a thrown value: its public renderings (publicErrorText, publicErrorStack) and the transport
 * classification, never the thrown text. The snapshot prefills public issues.
 */
export function recordedError(error: unknown): RecordedError {
	const stack = publicErrorStack(error);
	const classification = transportClassificationOf(error);
	return {
		message: publicErrorText(error),
		...(stack !== undefined ? { stack } : {}),
		...(classification !== undefined ? { classification } : {}),
	};
}

/**
 * One channel line as remembered: its level, its channel text, and the [ISO] line the issue report shows for it. The
 * report rendering is dropped on its own once REPORT_LOG_LINES newer ones exist; the channel text stays until the
 * channel bounds evict it.
 */
interface HistoryEntry {
	readonly level: keyof LogSink;
	readonly text: string;
	report?: string | undefined;
}

/**
 * The single logging implementation for the extension, and the owner of the one output door: the store of every
 * configured credential value and the one masking rule every surface applies to text that leaves the extension.
 * Channel output is not readable back, so the Logger keeps the one history of what it wrote: every line raw, with
 * the [ISO] rendering the issue report shows where a line has one. Replay reads the whole history, the report its
 * REPORT_LOG_LINES report-bearing entries; the channel write passes through the door only while logs.redactSecrets
 * is on, every other door always.
 */
export class Logger {
	/** Every configured credential value the collector has published this session (wiring/knownSecrets.ts). */
	private static secrets: readonly string[] = [];
	private readonly history: HistoryEntry[] = [];
	private historyChars = 0;
	private reportCount = 0;

	/**
	 * The set only grows within a session: the history and the latest error keep raw lines that may quote a value the
	 * collector has since retired (a rotated key).
	 */
	static registerSecrets(values: readonly string[]): void {
		Logger.secrets = [...new Set([...Logger.secrets, ...values])];
	}

	/**
	 * The one masking rule for text that leaves the extension: every registered value in the spellings a line can
	 * carry it, and every URL userinfo, replaced once per merged span. A value of REVEAL_FROM_LENGTH or more keeps
	 * its first REVEALED_CHARS ("sk-liv..."), a shorter value and any userinfo go whole. Hosts, paths, and every
	 * other word stay.
	 */
	static redact(text: string): string {
		let out = "";
		let cursor = 0;
		for (const { from, to, value } of secretSpans(text, Logger.secrets)) {
			out += `${text.slice(cursor, from)}${replacementFor(value)}`;
			cursor = to;
		}
		return out + text.slice(cursor);
	}

	/** `redactionEnabled` is the logs.redactSecrets setting, read at every channel write. */
	constructor(
		private readonly output: LogSink,
		private readonly recorder?: ErrorRecorder,
		private readonly redactionEnabled: () => boolean = () => false
	) {}

	/**
	 * The channel rendering of a line under the mode of the moment: masked, the door runs over the whole text FIRST
	 * and the masked text is cut plainly (a cut through a marker is harmless); raw, the text is cut where no value is
	 * split. `kept` is the raw text already cut that way, which replay renders without cutting again.
	 */
	private rendered(text: string, kept: string): string {
		return this.redactionEnabled() ? cutPlainly(Logger.redact(text)) : kept;
	}

	/** A text past CHANNEL_LINE_CHARS cut where no value is split, with a marker saying how much went. */
	private bounded(text: string): string {
		if (text.length <= CHANNEL_LINE_CHARS) {
			return text;
		}
		return cutAt(text, safeCut(text, CHANNEL_LINE_CHARS, Logger.secrets));
	}

	/**
	 * The one channel write: every line the channel shows is remembered raw (cut where no value is split), so replay
	 * restores it under the mode of the moment. A report rendering leaves only when REPORT_LOG_LINES newer ones exist,
	 * and its channel text stays; the channel bounds evict entries without a report rendering, oldest first, and stop
	 * when none is left.
	 */
	private write(level: keyof LogSink, text: string, reportText?: string): void {
		const kept = this.bounded(text);
		const report = reportText === undefined ? undefined : this.bounded(reportText);
		this.history.push({ level, text: kept, report });
		this.historyChars += kept.length + (report?.length ?? 0);
		if (report !== undefined) {
			this.reportCount += 1;
			if (this.reportCount > REPORT_LOG_LINES) {
				this.dropOldestReport();
			}
		}
		while (
			(this.history.length > CHANNEL_HISTORY_LINES || this.historyChars > CHANNEL_HISTORY_CHARS) &&
			this.evict((entry) => entry.report === undefined)
		) {
			// Each pass drops the oldest channel-only entry.
		}
		this.output[level](this.rendered(text, kept));
		if (report !== undefined) {
			this.recorder?.appendLog?.(report);
		}
	}

	/** The oldest report rendering goes; its entry stays in the channel history as a channel-only line. */
	private dropOldestReport(): void {
		const entry = this.history.find((candidate) => candidate.report !== undefined);
		if (entry?.report !== undefined) {
			this.historyChars -= entry.report.length;
			this.reportCount -= 1;
			entry.report = undefined;
		}
	}

	/** Drops the oldest entry `pick` accepts; false when there is none. */
	private evict(pick: (entry: HistoryEntry) => boolean): boolean {
		const index = this.history.findIndex(pick);
		if (index === -1) {
			return false;
		}
		const [dropped] = this.history.splice(index, 1) as [HistoryEntry];
		this.historyChars -= dropped.text.length + (dropped.report?.length ?? 0);
		if (dropped.report !== undefined) {
			this.reportCount -= 1;
		}
		return true;
	}

	/** The issue report's lines: the report renderings in the history, oldest first. */
	reportLines(): string[] {
		return this.history.flatMap((entry) => (entry.report === undefined ? [] : [entry.report]));
	}

	/**
	 * The channel's history (its last CHANNEL_HISTORY_LINES lines within CHANNEL_HISTORY_CHARS) written again under the
	 * mask now in force, at their levels, for the caller that has cleared the channel on a logs.redactSecrets flip.
	 */
	replay(): void {
		for (const { level, text } of this.history) {
			// The remembered text is already cut where no value is split, so the mask applies to it whole.
			this.output[level](this.redactionEnabled() ? Logger.redact(text) : text);
		}
	}

	log(message: string, data?: unknown): void {
		const text = data !== undefined ? `${message}: ${logDataText(data)}` : message;
		this.write("info", text, `[${new Date().toISOString()}] ${text}`);
	}

	/**
	 * A channel-only line: informational lines that recur on every serve pass would evict the real errors an issue
	 * report exists to carry, so they get no report rendering. The channel is still user-pasteable, so the
	 * classification-only rule is unchanged: keys and classifications, never response-derived text.
	 */
	advisory(message: string, data?: unknown): void {
		this.write("info", data !== undefined ? `${message}: ${logDataText(data)}` : message);
	}

	error(message: string, error: unknown): void {
		// The channel stays English by policy and keeps the full message; the buffer opens public issues, so it takes
		// the classification when there is one.
		const text = `${message}: ${englishMessageOf(error) ?? errorMessageText(error)}`;
		this.write("error", text, `[${new Date().toISOString()}] ERROR: ${message}: ${publicErrorText(error)}`);
		const stack = channelErrorStack(error);
		if (stack !== undefined) {
			this.write("error", `Stack trace: ${stack}`);
		}
		this.recorder?.recordError(message, recordedError(error));
	}

	/**
	 * An error-level line whose text is the caller's data (the failure's classification), for a failure whose own text
	 * may be response-derived: the channel and the buffer get the data, and the recorder's latest-error snapshot takes
	 * the error through its public renderings. A failure with a public rendering (a classification or an English
	 * mirror) is named by that line and that rendering; an unclassified throw is not, so the PRIVATE channel also takes
	 * its message and stack, as error() does, while the public sinks keep the word alone - the user can diagnose from
	 * the output log, and the issue report cannot quote the text.
	 */
	failure(message: string, data: unknown, error: unknown): void {
		const text = `${message}: ${logDataText(data)}`;
		this.write("error", text, `[${new Date().toISOString()}] ERROR: ${text}`);
		if (classificationOf(error) === undefined && englishMessageOf(error) === undefined) {
			// Channel-only lines, through the one channel write like every other, so they mask under the setting too.
			this.write("error", `${message}: ${errorMessageText(error)}`);
			const stack = channelErrorStack(error);
			if (stack !== undefined) {
				this.write("error", `Stack trace: ${stack}`);
			}
		}
		this.recorder?.recordError(message, recordedError(error));
	}
}
