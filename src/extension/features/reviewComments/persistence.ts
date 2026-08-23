/**
 * The review-comment store codec: schema v1, the shape saved to and
 * rehydrated from workspaceState. `{ version: 1, threads: { <uriString>:
 * [{ id, startLine, endLine, resolved, comments: [{ author, body,
 * createdAt }] }] } }`. Encoding is total by construction; decoding is total
 * over `unknown` and version-gated - a version stamp this build does not know
 * reads as an empty store with a typed advisory, never a throw, so a
 * downgraded build starts clean instead of crashing rehydrate.
 *
 * Within a known version the decoder is lenient per entry: a malformed thread
 * or comment is dropped and counted while its valid siblings survive, because
 * losing one corrupt record beats losing the whole store. Guards are
 * hand-rolled, not zod: this codec is the schema's source of truth and zod
 * stays at the webview trust boundary.
 *
 * Line numbers are stored exactly as the comment controller hands them
 * (VS Code ranges, 0-based); the codec only requires non-negative integers
 * with start <= end and never converts bases.
 *
 * Pure and vscode-free.
 */

import { isRecord, isUnsafeRecordKey } from "../../../shared/util/json";

/** The store version this build writes and the only one it can read. */
export const REVIEW_STORE_VERSION = 1;

/** Who wrote a comment: the reviewing model or the user replying to it. */
export type ReviewCommentAuthor = "user" | "model";

/** One comment inside a review thread; `createdAt` is epoch milliseconds. */
export interface StoredReviewComment {
	readonly author: ReviewCommentAuthor;
	readonly body: string;
	readonly createdAt: number;
}

/** One review thread anchored to a line range of the document it is keyed under. */
export interface StoredReviewThread {
	readonly id: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly resolved: boolean;
	readonly comments: readonly StoredReviewComment[];
}

/** All persisted threads, keyed by the document's URI string. */
export type ReviewThreadsByUri = Readonly<Record<string, readonly StoredReviewThread[]>>;

/** The versioned envelope written to workspaceState. */
export interface ReviewCommentStore {
	readonly version: typeof REVIEW_STORE_VERSION;
	readonly threads: ReviewThreadsByUri;
}

/**
 * A decoded store, or why the stored value is not one. Every branch carries
 * `threads` (empty on failure), so rehydrate reads `result.threads`
 * unconditionally and treats `ok: false` as an advisory to log, not an error
 * to handle. On ok, `dropped` counts the malformed threads, comments, and
 * record entries the lenient walk discarded.
 */
export type DecodeStoreResult =
	| { readonly ok: true; readonly threads: ReviewThreadsByUri; readonly dropped: number }
	| { readonly ok: false; readonly reason: "not-a-store" | "unknown-version"; readonly threads: ReviewThreadsByUri };

/** Wrap the live threads in the versioned envelope for workspaceState. */
export function encodeStore(threads: ReviewThreadsByUri): ReviewCommentStore {
	return { version: REVIEW_STORE_VERSION, threads };
}

/**
 * Decode a workspaceState value; see DecodeStoreResult for the verdicts.
 * `undefined` (nothing stored) reads as an ok empty store. Total over any
 * value: workspaceState hands back JSON-shaped data, but an accessor-bearing
 * object or proxy handed in through a test or a future caller could throw
 * mid-walk, and "total" means that reads as not-a-store, never a throw.
 */
export function decodeStore(raw: unknown): DecodeStoreResult {
	try {
		return decodeStoreShape(raw);
	} catch {
		return { ok: false, reason: "not-a-store", threads: {} };
	}
}

/** The decode walk proper; decodeStore's catch makes it total over hostile objects. */
function decodeStoreShape(raw: unknown): DecodeStoreResult {
	if (raw === undefined || raw === null) {
		return { ok: true, threads: {}, dropped: 0 };
	}
	if (!isRecord(raw) || typeof raw.version !== "number") {
		return { ok: false, reason: "not-a-store", threads: {} };
	}
	if (raw.version !== REVIEW_STORE_VERSION) {
		return { ok: false, reason: "unknown-version", threads: {} };
	}
	if (!isRecord(raw.threads)) {
		return { ok: false, reason: "not-a-store", threads: {} };
	}
	const threads: Record<string, readonly StoredReviewThread[]> = {};
	let dropped = 0;
	for (const uri of Object.keys(raw.threads)) {
		if (isUnsafeRecordKey(uri)) {
			dropped += 1;
			continue;
		}
		const value = raw.threads[uri];
		if (!Array.isArray(value)) {
			dropped += 1;
			continue;
		}
		const kept: StoredReviewThread[] = [];
		for (const candidate of value) {
			const thread = decodeThread(candidate);
			if (thread === undefined) {
				dropped += 1;
			} else {
				kept.push(thread.thread);
				dropped += thread.droppedComments;
			}
		}
		threads[uri] = kept;
	}
	return { ok: true, threads, dropped };
}

/** The pruned threads and the URI keys removed because their documents no longer exist. */
export interface PruneResult {
	readonly threads: ReviewThreadsByUri;
	readonly removedUris: readonly string[];
}

/**
 * Drop the thread entries whose documents no longer exist, per an injected
 * async existence predicate (the caller stats; this stays pure). Checks run
 * concurrently. A predicate that throws counts as "exists": pruning is
 * housekeeping, and a transient stat error must never delete review threads.
 * Kept entries assemble via Object.fromEntries, which defines own data
 * properties, so even a hostile "__proto__" key round-trips as data instead
 * of touching the prototype.
 */
export async function pruneThreads(
	threads: ReviewThreadsByUri,
	exists: (uriString: string) => Promise<boolean>
): Promise<PruneResult> {
	const entries = Object.entries(threads);
	const verdicts = await Promise.all(
		entries.map(async ([uri]) => {
			try {
				return await exists(uri);
			} catch {
				return true;
			}
		})
	);
	return {
		threads: Object.fromEntries(entries.filter((_, index) => verdicts[index] === true)),
		removedUris: entries.filter((_, index) => verdicts[index] !== true).map(([uri]) => uri),
	};
}

/** Validate one stored thread; undefined means drop it. Malformed comments drop individually, counted. */
function decodeThread(raw: unknown): { thread: StoredReviewThread; droppedComments: number } | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}
	const { id, startLine, endLine, resolved, comments } = raw;
	if (typeof id !== "string" || id.length === 0) {
		return undefined;
	}
	if (!isStoredLine(startLine) || !isStoredLine(endLine) || startLine > endLine) {
		return undefined;
	}
	if (typeof resolved !== "boolean" || !Array.isArray(comments)) {
		return undefined;
	}
	const kept: StoredReviewComment[] = [];
	let droppedComments = 0;
	for (const candidate of comments) {
		const comment = decodeComment(candidate);
		if (comment === undefined) {
			droppedComments += 1;
		} else {
			kept.push(comment);
		}
	}
	return { thread: { id, startLine, endLine, resolved, comments: kept }, droppedComments };
}

/** Validate one stored comment; undefined means drop it. */
function decodeComment(raw: unknown): StoredReviewComment | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}
	const { author, body, createdAt } = raw;
	if (author !== "user" && author !== "model") {
		return undefined;
	}
	if (typeof body !== "string" || !isStoredLine(createdAt)) {
		return undefined;
	}
	return { author, body, createdAt };
}

/** A persistable non-negative integer (line numbers and epoch timestamps alike). */
function isStoredLine(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
