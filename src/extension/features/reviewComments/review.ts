/**
 * The review run: one model call per file, its answer parsed into
 * line-anchored placements and applied as it lands, so comments appear while a
 * multi-file review is still going.
 *
 * Deliberately generic over the target a unit names (the command layer passes
 * a document URI): this module owns the loop, the cancellation checks and the
 * counting, and nothing here needs to know what a target is. That keeps it
 * vscode-free and testable without a host.
 *
 * Errors are NOT swallowed: a failed call aborts the run and propagates to the
 * command's single logging boundary, because a review that silently skipped
 * half its files would read as "nothing to report". Whatever landed before the
 * failure stays - the applied threads are the user's, not the run's.
 */

import type { ReviewPlacement } from "./placements";
import { parsePlacements } from "./placements";

/**
 * How many files one working-tree review may send. A wide refactor would
 * otherwise be one request per file with no ceiling; the command tells the
 * user how many it left out.
 */
export const REVIEW_FILE_LIMIT = 20;

/** One file to review: what to send, how long the file is, and what the caller anchors findings on. */
export interface ReviewUnit<T> {
	readonly target: T;
	/** The reviewed document's line count; placements clamp into it. */
	readonly lineCount: number;
	readonly prompt: string;
}

/** Everything the run does to the outside world, injected so the loop stays pure. */
export interface ReviewRunDeps<T> {
	/** Sends one prompt and resolves with the model's answer text. */
	readonly send: (prompt: string) => Promise<string>;
	/**
	 * Applies one file's findings, replacing whatever that file had before.
	 * Returns false when the caller refused - the document moved under the
	 * request, so anchoring the answer would put comments on the wrong lines.
	 */
	readonly apply: (target: T, placements: readonly ReviewPlacement[]) => boolean;
	/** Called before each file's request, for progress reporting. */
	readonly onFileStart?: (index: number, total: number) => void;
	/** Cancellation, read between files; the send's own token aborts a call in flight. */
	readonly token: { readonly isCancellationRequested: boolean };
}

/**
 * What a run produced, counted per file. `unusable` is the honest middle
 * ground between findings and a clean bill: an answer this parser could not
 * read as a review at all leaves that file's existing comments alone, because
 * clearing them would claim the model said "nothing to report" when it said
 * something we could not understand. `stale` counts the files the caller
 * refused to anchor, and `cancelled` says the loop stopped early, so the
 * caller can stay silent rather than report a partial pass as a finished one.
 */
export interface ReviewRunOutcome {
	readonly reviewed: number;
	readonly findings: number;
	readonly unusable: number;
	readonly stale: number;
	readonly cancelled: boolean;
}

/**
 * Review every unit in order. Returns once the units are exhausted or
 * cancellation is observed between files; a cancellation observed by the
 * transport surfaces as its own error and propagates instead.
 */
export async function runReview<T>(units: readonly ReviewUnit<T>[], deps: ReviewRunDeps<T>): Promise<ReviewRunOutcome> {
	let reviewed = 0;
	let findings = 0;
	let unusable = 0;
	let stale = 0;
	for (const [index, unit] of units.entries()) {
		if (deps.token.isCancellationRequested) {
			return { reviewed, findings, unusable, stale, cancelled: true };
		}
		deps.onFileStart?.(index, units.length);
		const answer = await deps.send(unit.prompt);
		reviewed += 1;
		const parsed = parsePlacements(answer, unit.lineCount);
		if (parsed.placements.length === 0 && !parsed.sawNoFindings) {
			// Not a review we can act on: an empty reply, a bare code fence, or a
			// paragraph of prose. Clearing the file's comments here would claim the
			// model reported it clean, which is precisely what it did not do.
			unusable += 1;
			continue;
		}
		// Applied even when empty: the caller clears the file's previous model
		// comments on apply, so a file the model now reports as clean must lose
		// them - which is why only an explicit sentinel gets here.
		if (deps.apply(unit.target, parsed.placements)) {
			findings += parsed.placements.length;
		} else {
			stale += 1;
		}
	}
	return { reviewed, findings, unusable, stale, cancelled: deps.token.isCancellationRequested };
}
