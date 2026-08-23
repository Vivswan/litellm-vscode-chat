/**
 * The lenient parser for a review model's answer: `LINE <n>: <finding>` or
 * `LINE <start>-<end>: <finding>` lines (the format reviewPrompt.ts instructs,
 * importing this module's constants so builder and parser cannot drift) into
 * line-anchored placements. Total over any string, in time linear in the
 * input: interleaved prose is dropped and counted, list markers, bold
 * wrappers, and code fences around otherwise well-formed findings are
 * tolerated, and out-of-range anchors clamp into the reviewed document
 * instead of failing - anchors of any length parse saturatingly, so an absurd
 * number clamps to the last line rather than dropping the finding.
 *
 * The result carries counts, never message text: a model's raw answer must
 * not ride an Error into the output channel or a public issue report, so this
 * module returns no errors at all. Finding bodies do carry model text - they
 * are the product, rendered as comment bodies, and they stay out of logs.
 *
 * Line numbers here are 1-based, as instructed to the model; the comment
 * controller converts to VS Code's 0-based ranges at thread creation.
 *
 * Pure and vscode-free.
 */

/** The exact reply the prompt requests when the model has nothing to report; recognized case- and punctuation-insensitively. */
export const NO_FINDINGS_REPLY = "NO FINDINGS";

/**
 * A line break in this feature's one splitting vocabulary: CRLF, lone LF, or
 * lone CR (VS Code's text buffer counts a bare CR as a line break, so the
 * whole-file prompt's numbering and this parser must agree with it and with
 * each other). reviewPrompt.ts imports this for its line numbering.
 */
export const LINE_BREAK_PATTERN = /\r\n|[\r\n]/;

/** One parsed finding: a 1-based inclusive line range and the model's finding text. */
export interface ReviewPlacement {
	readonly startLine: number;
	readonly endLine: number;
	readonly body: string;
}

/** Every placement parsed from the answer, plus how many non-finding lines were dropped on the way. */
export interface ParsedPlacements {
	readonly placements: readonly ReviewPlacement[];
	readonly dropped: number;
	/**
	 * Whether the answer actually carried the no-findings sentinel. A caller
	 * clearing a file's existing comments on a findingless answer needs to know
	 * the model SAID the file is clean, and no other signal proves that: an
	 * empty answer, a lone code fence, and a page of blank lines all parse to
	 * zero placements and zero drops too.
	 */
	readonly sawNoFindings: boolean;
}

/**
 * A finding line after markers are stripped: LINE <start>[-<end>]: <body>.
 * Anchors may be signed - a negative line number is out-of-range, not
 * malformed, and clamps to line one like any other out-of-range anchor.
 * The range dash tolerates en/em dashes (as escapes - source stays ASCII).
 * The optional bold closer swallows its trailing whitespace (`(?:\*\*\s*)?:`)
 * rather than sitting between two `\s*`, which would backtrack quadratically
 * on a whitespace run with no colon behind it.
 */
const FINDING_PATTERN = /^line\s*(-?\d+)(?:\s*[-\u2013\u2014]\s*(-?\d+))?\s*(?:\*\*\s*)?:\s*(.*)$/i;

/** Leading decoration models like to add: blockquote marks, list bullets, bold openers. */
const LEADING_DECORATION = /^[\s>]*(?:[-*+]\s+)?(?:\*\*)?\s*/;

/**
 * Parse a model answer into placements against a document of `lineCount`
 * lines (1-based; non-finite or smaller counts read as a one-line document).
 * Blank lines, code fences, and the no-findings reply are ignored silently;
 * any other line that is not a well-formed finding is dropped and counted.
 * Anchors clamp into [1, lineCount] and a reversed range is reordered.
 */
export function parsePlacements(answer: string, lineCount: number): ParsedPlacements {
	// The MAX_SAFE_INTEGER ceiling keeps every clamped anchor a safe integer
	// even against an absurd lineCount: saturated parses above it collapse to
	// the ceiling, and everything below it parses exactly.
	const maxLine = Number.isFinite(lineCount)
		? Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.floor(lineCount)))
		: 1;
	const clamp = (line: number): number => Math.min(maxLine, Math.max(1, line));
	const placements: ReviewPlacement[] = [];
	let dropped = 0;
	let sawNoFindings = false;
	for (const rawLine of answer.split(LINE_BREAK_PATTERN)) {
		const line = rawLine.trim();
		if (isNoFindingsReply(line)) {
			sawNoFindings = true;
			continue;
		}
		if (line.length === 0 || isCodeFence(line)) {
			continue;
		}
		const match = FINDING_PATTERN.exec(line.replace(LEADING_DECORATION, ""));
		if (match === null) {
			dropped += 1;
			continue;
		}
		const body = stripBoldWrapper((match[3] ?? "").trim());
		if (body.length === 0) {
			dropped += 1;
			continue;
		}
		// parseInt saturates on huge digit runs (up to Infinity); clamp absorbs that.
		const first = clamp(Number.parseInt(match[1] ?? "1", 10));
		const second = match[2] === undefined ? first : clamp(Number.parseInt(match[2], 10));
		placements.push({ startLine: Math.min(first, second), endLine: Math.max(first, second), body });
	}
	return { placements, dropped, sawNoFindings };
}

/** A markdown code-fence delimiter line; ignored so a fenced but well-formed answer still parses. */
function isCodeFence(line: string): boolean {
	return line.startsWith("```");
}

/**
 * The no-findings reply, tolerating case, wrapping punctuation, and extra
 * whitespace - but only punctuation: a line with other letters (any script)
 * or digits mixed in is not the sentinel and falls through to the
 * dropped-and-counted path, hence the Unicode property classes instead of
 * `\W`, which would misread non-ASCII letters as wrapping punctuation.
 */
function isNoFindingsReply(line: string): boolean {
	return /^[^\p{L}\p{N}]*no[^\p{L}\p{N}]+findings[^\p{L}\p{N}]*$/iu.test(line);
}

/**
 * Drop the one dangling bold marker a bolded anchor leaves behind
 * (`**LINE 3:** body` yields a body starting `**`; a fully bolded line yields
 * one ending `**`). Only an odd marker count is a dangling wrapper; an even
 * count is the body's own balanced emphasis and stays untouched.
 */
function stripBoldWrapper(body: string): string {
	const markerCount = body.split("**").length - 1;
	if (markerCount % 2 === 1) {
		if (body.startsWith("**")) {
			return body.slice(2).trimStart();
		}
		if (body.endsWith("**")) {
			return body.slice(0, -2).trimEnd();
		}
	}
	return body;
}
