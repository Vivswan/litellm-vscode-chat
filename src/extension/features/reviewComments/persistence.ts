/**
 * The review-comment store codec: schema v1, the shape saved to and rehydrated from workspaceState.
 *
 *   { version: 1,
 *     threads: { <uriString>: [{ id, startLine, endLine, resolved, comments: [{ author, body, createdAt }] }] } }
 *   a version stamp this build does not know reads as an empty store -> a downgraded build starts clean
 *   losing one corrupt record beats losing the whole store -> a malformed thread or comment is dropped and counted
 *   this codec is the schema's source of truth -> Guards are hand-rolled, not zod
 *   Line numbers -> are stored exactly as the comment controller hands them (VS Code ranges, 0-based)
 */

import { isRecord, isUnsafeRecordKey } from "../../../shared/util/json";

export const REVIEW_STORE_VERSION = 1;

export type ReviewCommentAuthor = "user" | "model";

/** One comment inside a review thread; `createdAt` is epoch milliseconds. */
export interface StoredReviewComment {
	readonly author: ReviewCommentAuthor;
	readonly body: string;
	readonly createdAt: number;
}

export interface StoredReviewThread {
	readonly id: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly resolved: boolean;
	readonly comments: readonly StoredReviewComment[];
}

export type ReviewThreadsByUri = Readonly<Record<string, readonly StoredReviewThread[]>>;

export interface ReviewCommentStore {
	readonly version: typeof REVIEW_STORE_VERSION;
	readonly threads: ReviewThreadsByUri;
}

/**
 * Every branch carries `threads` (empty on failure), so rehydrate reads `result.threads` unconditionally and treats
 * `ok: false` as an advisory to log, not an error to handle. On ok, `dropped` counts the malformed threads, comments,
 * and record entries the lenient walk discarded.
 */
export type DecodeStoreResult =
	| { readonly ok: true; readonly threads: ReviewThreadsByUri; readonly dropped: number }
	| { readonly ok: false; readonly reason: "not-a-store" | "unknown-version"; readonly threads: ReviewThreadsByUri };

export function encodeStore(threads: ReviewThreadsByUri): ReviewCommentStore {
	return { version: REVIEW_STORE_VERSION, threads };
}

/**
 * Total over any value: workspaceState hands back JSON-shaped data, but an accessor-bearing object or proxy handed in
 * through a test or a future caller could throw mid-walk, and "total" means that reads as not-a-store, never a throw.
 */
export function decodeStore(raw: unknown): DecodeStoreResult {
	try {
		return decodeStoreShape(raw);
	} catch {
		return { ok: false, reason: "not-a-store", threads: {} };
	}
}

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

export interface PruneResult {
	readonly threads: ReviewThreadsByUri;
	readonly removedUris: readonly string[];
}

/**
 * A predicate that throws counts as "exists": pruning is housekeeping, and a transient stat error must never delete
 * review threads. Kept entries assemble via Object.fromEntries, which defines own data properties, so even a hostile
 * "__proto__" key round-trips as data instead of touching the prototype.
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
