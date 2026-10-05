/**
 * Deliberately generic over the target a unit names (the command layer passes a document URI): this module owns the
 * loop, the cancellation checks and the counting, and nothing here needs to know what a target is.
 * That keeps it vscode-free and testable without a host.
 *
 *   applied as it lands -> comments appear while a multi-file review is still going
 *   Errors are NOT swallowed -> a failed call aborts the run and propagates to the command's single logging boundary
 *   a review that silently skipped half its files -> would read as "nothing to report"
 *   the applied threads are the user's, not the run's -> Whatever landed before the failure stays
 */

import type { ReviewPlacement } from "./placements";
import { parsePlacements } from "./placements";

/**
 * A wide refactor would otherwise be one request per file with no ceiling; the command tells the user how many it left
 * out.
 */
export const REVIEW_FILE_LIMIT = 20;

export interface ReviewUnit<T> {
	readonly target: T;
	/** The reviewed document's line count; placements clamp into it. */
	readonly lineCount: number;
	readonly prompt: string;
}

export interface ReviewRunDeps<T> {
	readonly send: (prompt: string) => Promise<string>;
	/**
	 * Returns false when the caller refused - the document moved under the request, so anchoring the answer would put
	 * comments on the wrong lines.
	 */
	readonly apply: (target: T, placements: readonly ReviewPlacement[]) => boolean;
	readonly onFileStart?: (index: number, total: number) => void;
	/** Cancellation, read between files; the send's own token aborts a call in flight. */
	readonly token: { readonly isCancellationRequested: boolean };
}

/**
 * `unusable` is the honest middle ground between findings and a clean bill: an answer this parser could not read as a
 * review at all leaves that file's existing comments alone, because clearing them would claim the model said "nothing
 * to report" when it said something we could not understand.
 *
 *   `stale` -> counts the files the caller refused to anchor
 */
export interface ReviewRunOutcome {
	readonly reviewed: number;
	readonly findings: number;
	readonly unusable: number;
	readonly stale: number;
	readonly cancelled: boolean;
}

/**
 * Returns once the units are exhausted or cancellation is observed between files; a cancellation observed by the
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
			unusable += 1;
			continue;
		}
		if (deps.apply(unit.target, parsed.placements)) {
			findings += parsed.placements.length;
		} else {
			stale += 1;
		}
	}
	return { reviewed, findings, unusable, stale, cancelled: deps.token.isCancellationRequested };
}
