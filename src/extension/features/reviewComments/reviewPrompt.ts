/**
 * The two review prompt builders, one per user-chosen review mode: the
 * working-tree diff of a file, or the whole file as it stands - plus the
 * follow-up builder for a reply typed into a review thread. All three carry
 * English instructions (model-facing text stays English by policy); the two
 * review modes ask for line-anchored findings in the `LINE <start>-<end>:
 * <finding>` format placements.ts parses, and the no-findings sentinel is
 * imported from there so the builders and the parser cannot drift apart.
 *
 * One file per prompt, in both modes: the finding format has no file field
 * (user-ruled placement shape), so the command layer splits a multi-file
 * working-tree diff and prompts per file. Whole-file mode prepends 1-based
 * line numbers to every content line - the model anchors against what it can
 * see, not against counting it must do itself - while diff mode anchors on
 * the hunk headers the diff already carries.
 *
 * Each mode has a stated char budget, head-truncated with an inline marker
 * appended only when actually over (the same idiom as the commit prompt's
 * DIFF_CHAR_LIMIT): a review of the head of an oversized input still has
 * value, and an unbounded prompt has a failure mode instead of a budget.
 *
 * Pure and vscode-free.
 */

import type { OneShotChatMessage } from "../../../provider/transport/oneShotClient";
import { truncateKeepingHead } from "../../../shared/util/text";
import { LINE_BREAK_PATTERN, NO_FINDINGS_REPLY } from "./placements";

/** Head-truncation bound for a file's working-tree diff inside the prompt. */
export const REVIEW_DIFF_CHAR_LIMIT = 80_000;

/** Head-truncation bound for the line-numbered file content inside the prompt. */
export const REVIEW_FILE_CHAR_LIMIT = 80_000;

/** The shared model-facing instruction; the LINE format literals here are what placements.ts parses. */
export const REVIEW_FORMAT_INSTRUCTION = [
	"You are reviewing code. Report concrete problems: bugs, security issues, race conditions, resource leaks,",
	"missing error handling, and misleading names or comments. Do not praise and do not restate the code.",
	"Report each finding on its own line, in exactly this format:",
	"LINE <start>-<end>: <one short sentence describing the problem>",
	'Use "LINE <n>: <finding>" when a finding covers a single line.',
	"Print nothing else: no preamble, no summary, no code fences.",
	`If there is nothing worth reporting, reply with exactly: ${NO_FINDINGS_REPLY}`,
].join("\n");

/** One file's working-tree diff; `path` is the workspace-relative label shown to the model. */
export interface DiffReviewPromptArgs {
	readonly path: string;
	readonly diff: string;
}

/** Build the prompt reviewing one file's working-tree diff. */
export function buildDiffReviewPrompt(args: DiffReviewPromptArgs): string {
	const diff = headTruncate(args.diff, REVIEW_DIFF_CHAR_LIMIT, "[diff truncated]");
	return [
		REVIEW_FORMAT_INSTRUCTION,
		"Line numbers refer to the file after the change: anchor each finding on the new-file line numbers from the @@ hunk headers.",
		`Working tree diff of ${args.path}:\n${diff}`,
	].join("\n\n");
}

/** One whole file; `languageId` is advisory context (VS Code's language identifier), omitted from the prompt when absent or blank. */
export interface FileReviewPromptArgs {
	readonly path: string;
	readonly content: string;
	readonly languageId?: string;
}

/** Build the prompt reviewing a whole file, its lines numbered for anchoring. */
export function buildFileReviewPrompt(args: FileReviewPromptArgs): string {
	const content = numberedHead(args.content);
	const languageId = args.languageId?.trim() ?? "";
	const language = languageId.length === 0 ? "" : ` (${languageId})`;
	return [
		REVIEW_FORMAT_INSTRUCTION,
		"Each line below is prefixed with its line number; anchor findings on those numbers.",
		`File ${args.path}${language}:\n${content}`,
	].join("\n\n");
}

/**
 * Number the content's lines up to the char budget, head-truncated with the
 * marker only when actually over. Numbering walks line breaks incrementally
 * and stops once the budget is exceeded (each slice capped at budget + 1), so
 * a newline-heavy or single-line giant never allocates much past the budget -
 * the naive split-map-join would materialize every line of a file the budget
 * is about to throw away.
 */
function numberedHead(content: string): string {
	const breaks = new RegExp(LINE_BREAK_PATTERN.source, "g");
	const parts: string[] = [];
	let joinedLength = -1;
	let lineNumber = 1;
	let start = 0;
	for (;;) {
		const match = breaks.exec(content);
		const end = match === null ? content.length : match.index;
		const line = `${lineNumber}: ${content.slice(start, Math.min(end, start + REVIEW_FILE_CHAR_LIMIT + 1))}`;
		parts.push(line);
		joinedLength += line.length + 1;
		if (match === null || joinedLength > REVIEW_FILE_CHAR_LIMIT) {
			break;
		}
		start = match.index + match[0].length;
		lineNumber += 1;
	}
	const numbered = parts.join("\n");
	return headTruncate(numbered, REVIEW_FILE_CHAR_LIMIT, "[file truncated]");
}

/** Head-truncation bound for the code a thread anchors, quoted back as context for a reply. */
export const REVIEW_SNIPPET_CHAR_LIMIT = 8_000;

/** Head-truncation bound for one comment body inside a reply conversation. */
export const REVIEW_COMMENT_CHAR_LIMIT = 4_000;

/**
 * How many turns of a thread ride the follow-up request. Bounding the bodies
 * alone leaves the TURN COUNT unbounded, so a long-running thread would grow
 * the request without limit; the newest turns are the ones the reply is about,
 * so the oldest are what a long thread drops.
 */
export const REVIEW_REPLY_TURN_LIMIT = 20;

/** A reply's context: where the thread sits, the code it anchors, and the conversation so far. */
export interface ReplyPromptArgs {
	readonly path: string;
	/** The anchored lines, already line-numbered by the caller; empty when the document could not be read. */
	readonly snippet: string;
	/** The thread's 1-based inclusive line range, as shown to the model. */
	readonly startLine: number;
	readonly endLine: number;
	/** The thread so far, oldest first, ending with the user turn being answered. */
	readonly turns: readonly { readonly author: "user" | "model"; readonly body: string }[];
}

/**
 * Build the follow-up request for a reply typed into a review thread: one
 * system turn carrying the instruction and the anchored code, then the thread
 * replayed as alternating turns (the model's comments as assistant, the user's
 * as user). A conversation rather than one flattened prompt, because that is
 * what the thread IS - and it keeps the model's own earlier wording available
 * to it verbatim.
 *
 * The follow-up deliberately does NOT ask for the LINE format: the answer goes
 * into an existing thread, so it is prose, and parsing it as placements would
 * be a category error. The snippet and each body are head-truncated and the
 * turns themselves are capped at the newest REVIEW_REPLY_TURN_LIMIT, so
 * neither a long comment nor a long thread can grow the request without bound.
 */
export function buildReplyMessages(args: ReplyPromptArgs): readonly OneShotChatMessage[] {
	const snippet = headTruncate(args.snippet, REVIEW_SNIPPET_CHAR_LIMIT, "[snippet truncated]");
	const range = args.startLine === args.endLine ? `line ${args.startLine}` : `lines ${args.startLine}-${args.endLine}`;
	const context = snippet.trim() === "" ? "" : `\n\nThe lines under discussion:\n${snippet}`;
	const system = [
		"You are continuing a code review conversation with the developer who wrote this code.",
		`The thread is anchored on ${args.path}, ${range}.`,
		"Answer their reply directly and briefly, in plain prose: no line-anchored findings, no code fences unless you are quoting a fix, no restating the whole thread.",
		"If they are right that your earlier comment was wrong, say so plainly.",
	].join("\n");
	return [
		{ role: "system" as const, content: `${system}${context}` },
		...args.turns.slice(-REVIEW_REPLY_TURN_LIMIT).map((turn) => ({
			role: turn.author === "model" ? ("assistant" as const) : ("user" as const),
			content: headTruncate(turn.body, REVIEW_COMMENT_CHAR_LIMIT, "[truncated]"),
		})),
	];
}

/**
 * The budgeted head plus this module's inline marker, appended only when the
 * text was actually over the bound. The cut itself is the shared
 * truncateKeepingHead, so an astral character at the boundary cannot leave a
 * lone surrogate in the JSON body; the marker stays caller-side, like the
 * commit prompt does it.
 */
function headTruncate(text: string, limit: number, marker: string): string {
	return text.length > limit ? `${truncateKeepingHead(text, limit)}\n${marker}` : text;
}
