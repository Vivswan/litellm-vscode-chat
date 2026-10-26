/**
 * Total over any string, in time linear in the input: interleaved prose is dropped and counted, list markers, bold
 * wrappers, and code fences around otherwise well-formed findings are tolerated, and out-of-range anchors clamp into
 * the reviewed document instead of failing - anchors of any length parse saturatingly, so an absurd number clamps to
 * the last line rather than dropping the finding.
 *
 *   A model's raw answer must not ride an Error into the output channel or a public issue report -> this module
 *     returns no errors at all
 *   Finding bodies do carry model text - they are the product, rendered as comment bodies -> they stay out of logs
 *   Line numbers here are 1-based -> the comment controller converts to VS Code's 0-based ranges at thread creation
 *
 * FINDING_PATTERN writes its en/em dashes as escapes so the source stays ASCII, and its optional bold closer swallows
 * its trailing whitespace (`(?:\*\*\s*)?:`) rather than sitting between two `\s*`, which would backtrack quadratically
 * on a whitespace run with no colon behind it. A signed anchor is out-of-range, not malformed: a negative line number
 * clamps to line one.
 */

/** The exact reply the prompt requests for a clean file; recognized case- and punctuation-insensitively. */
export const NO_FINDINGS_REPLY = "NO FINDINGS";

/** CRLF, lone LF, or lone CR: VS Code's buffer counts a bare CR, so the prompt's numbering and this parser agree. */
export const LINE_BREAK_PATTERN = /\r\n|[\r\n]/;

/** One parsed finding: a 1-based inclusive line range and the model's finding text. */
export interface ReviewPlacement {
	readonly startLine: number;
	readonly endLine: number;
	readonly body: string;
}

/**
 * What the parse read out of one answer. `dropped` counts the lines dropped: interleaved prose, and a finding line
 * with no body. `sawNoFindings` says the model SAID the file is clean: a caller clearing a file's existing comments on
 * a findingless answer needs that, and no other signal proves it, since an empty answer, a lone code fence, and a page
 * of blank lines all parse to zero placements and zero drops too.
 */
export interface ParsedPlacements {
	readonly placements: readonly ReviewPlacement[];
	readonly dropped: number;
	readonly sawNoFindings: boolean;
}

/** LINE <n>[-<m>]: <text>, with en/em dashes and an optional bold closer tolerated; anchors may be signed. */
const FINDING_PATTERN = /^line\s*(-?\d+)(?:\s*[-\u2013\u2014]\s*(-?\d+))?\s*(?:\*\*\s*)?:\s*(.*)$/i;

/** Leading decoration models like to add: blockquote marks, list bullets, bold openers. */
const LEADING_DECORATION = /^[\s>]*(?:[-*+]\s+)?(?:\*\*)?\s*/;

export function parsePlacements(answer: string, lineCount: number): ParsedPlacements {
	// The MAX_SAFE_INTEGER ceiling keeps every clamped anchor a safe integer even against an absurd lineCount:
	// saturated parses above it collapse to the ceiling, and everything below it parses exactly.
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

function isCodeFence(line: string): boolean {
	return line.startsWith("```");
}

/**
 *   a line with other letters (any script) or digits mixed in is not the sentinel and falls through to the
 *     dropped-and-counted path -> the Unicode property classes instead of `\W`, which would misread non-ASCII letters
 *     as wrapping punctuation
 */
function isNoFindingsReply(line: string): boolean {
	return /^[^\p{L}\p{N}]*no[^\p{L}\p{N}]+findings[^\p{L}\p{N}]*$/iu.test(line);
}

/**
 * Drop the one dangling bold marker a bolded anchor leaves behind (`**LINE 3:** body` yields a body starting `**`; a
 * fully bolded line yields one ending `**`).
 *
 *   Only an odd marker count -> is a dangling wrapper
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
