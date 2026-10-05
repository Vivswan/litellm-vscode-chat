/**
 * All three carry English instructions (model-facing text stays English by policy); the two review modes ask for
 * line-anchored findings in the `LINE <start>-<end>: <finding>` format placements.ts parses, and the no-findings
 * sentinel is imported from there so the builders and the parser cannot drift apart. Each mode has a stated char
 * budget, head-truncated through the shared truncateHeadWithMarker (the marker rides inside the budget, the same
 * contract as the commit prompt's DIFF_CHAR_LIMIT): a review of the head of an oversized input still has value, and an
 * unbounded prompt has a failure mode instead of a budget.
 *
 *   the finding format has no file field -> the command layer splits a multi-file working-tree diff
 *   the model anchors against what it can see -> Whole-file mode prepends 1-based line numbers to every content line
 */

import type { OneShotChatMessage } from "../../../provider/transport/oneShotClient";
import { truncateHeadWithMarker, truncationMarker } from "../../../shared/util/text";
import { LINE_BREAK_PATTERN, NO_FINDINGS_REPLY } from "./placements";

export const REVIEW_DIFF_CHAR_LIMIT = 80_000;

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

export interface DiffReviewPromptArgs {
	readonly path: string;
	readonly diff: string;
}

export function buildDiffReviewPrompt(args: DiffReviewPromptArgs): string {
	const diff = truncateHeadWithMarker(args.diff, REVIEW_DIFF_CHAR_LIMIT, truncationMarker("diff"));
	return [
		REVIEW_FORMAT_INSTRUCTION,
		"Line numbers refer to the file after the change: anchor each finding on the new-file line numbers from the @@ hunk headers.",
		`Working tree diff of ${args.path}:\n${diff}`,
	].join("\n\n");
}

export interface FileReviewPromptArgs {
	readonly path: string;
	readonly content: string;
	readonly languageId?: string;
}

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
 * Numbering walks line breaks incrementally and stops once the budget is exceeded (each slice capped at budget + 1), so
 * a newline-heavy or single-line giant never allocates much past the budget - the naive split-map-join would
 * materialize every line of a file the budget is about to throw away.
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
	return truncateHeadWithMarker(numbered, REVIEW_FILE_CHAR_LIMIT, truncationMarker("file"));
}

export const REVIEW_SNIPPET_CHAR_LIMIT = 8_000;

export const REVIEW_COMMENT_CHAR_LIMIT = 4_000;

/**
 * Bounding the bodies alone leaves the TURN COUNT unbounded, so a long-running thread would grow the request without
 * limit; the newest turns are the ones the reply is about, so the oldest are what a long thread drops.
 */
export const REVIEW_REPLY_TURN_LIMIT = 20;

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
 * A conversation rather than one flattened prompt, because that is what the thread IS, and it keeps the model's
 * retained earlier wording available to it. It deliberately does NOT ask for the LINE format the review prompts use,
 * since the answer goes into an existing thread as prose and parsing it as placements would be a category error.
 */
export function buildReplyMessages(args: ReplyPromptArgs): readonly OneShotChatMessage[] {
	const snippet = truncateHeadWithMarker(args.snippet, REVIEW_SNIPPET_CHAR_LIMIT, truncationMarker("snippet"));
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
			content: truncateHeadWithMarker(turn.body, REVIEW_COMMENT_CHAR_LIMIT, truncationMarker("comment")),
		})),
	];
}
