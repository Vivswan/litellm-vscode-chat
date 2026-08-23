import { randomUUID } from "node:crypto";
import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import { COMMENT_CONTROLLER_ID } from "../../../shared/config/commandIds";
import type { ReviewCommentAuthor, ReviewThreadsByUri, StoredReviewComment, StoredReviewThread } from "./persistence";
import type { ReviewPlacement } from "./placements";

/**
 * The feature's comment surface: one vscode.CommentController and the live
 * threads under it, plus the translation between those threads and the
 * persisted schema (persistence.ts owns the codec; this owns the live side).
 *
 * The controller exists ONLY while the feature is enabled - the wiring creates
 * it on enable and disposes it on disable, which removes every thread from the
 * editors - so this class holds no enablement state of its own.
 *
 * Every mutation the user or a review can make (threads created, a reply
 * appended, resolve, delete) ends by handing the whole snapshot to the
 * injected saver: save-on-mutation, never on a timer, never on dispose, and
 * never once disposed - that is what keeps disabling the feature, or a request
 * landing after it was disabled, from overwriting the stored threads with an
 * empty set.
 *
 * Comment bodies carry model and user text. They are rendered as plain strings
 * (VS Code renders them as untrusted markdown, so no command links execute)
 * and they never reach the logger.
 */

/** The thread contextValues the manifest's `commentThread ==` when-clauses match. */
const RESOLVED_CONTEXT = "resolved";
const UNRESOLVED_CONTEXT = "unresolved";

/** Persists the whole live snapshot; called after every mutation. */
export type ReviewThreadSaver = (threads: ReviewThreadsByUri) => void;

/** One live thread: our record of it, and the host thread rendering it. */
interface LiveThread {
	readonly id: string;
	readonly thread: vscode.CommentThread;
	comments: readonly StoredReviewComment[];
	resolved: boolean;
}

/** The author shown on a model-written comment. Brand text, so it stays English. */
function modelAuthor(): vscode.CommentAuthorInformation {
	return { name: "LiteLLM" };
}

/** The author shown on a comment the user typed. */
function userAuthor(): vscode.CommentAuthorInformation {
	return { name: l10n.t("You") };
}

export class ReviewCommentController implements vscode.Disposable {
	private readonly controller: vscode.CommentController;
	/** Live threads by document URI string - the same key the store persists under. */
	private readonly byUri = new Map<string, LiveThread[]>();
	/** The reverse lookup a menu command needs: the host hands back a CommentThread and nothing else. */
	private readonly records = new WeakMap<vscode.CommentThread, LiveThread>();
	/** Set by dispose(); every mutation reads it, so a late-landing request cannot write over the store. */
	private disposed = false;

	constructor(private readonly save: ReviewThreadSaver) {
		this.controller = vscode.comments.createCommentController(COMMENT_CONTROLLER_ID, l10n.t("LiteLLM review"));
		this.controller.options = {
			prompt: l10n.t("Reply to LiteLLM"),
			placeHolder: l10n.t("Reply to this review comment; the model answers in the thread."),
		};
		// Whole-document ranges, so a user can also START a thread anywhere and
		// ask about those lines. File-level comments stay off: every thread this
		// feature persists is anchored to lines, and a range-less thread would
		// have nothing to restore itself onto.
		//
		// Only on real files, and at the source rather than as a check further
		// in: a thread on an untitled buffer or a virtual document (a diff pane,
		// a git: URI) would be stored under a URI that names something else next
		// session, and the prune - which only removes what is definitely gone -
		// would never clear it. No gutter there means nothing to adopt.
		this.controller.commentingRangeProvider = {
			provideCommentingRanges: (document) => ({
				enableFileComments: false,
				ranges: document.uri.scheme === "file" ? [new vscode.Range(0, 0, Math.max(0, document.lineCount - 1), 0)] : [],
			}),
		};
	}

	/** Whether dispose() has run; a caller mid-request checks this before treating a landing answer as placeable. */
	get isDisposed(): boolean {
		return this.disposed;
	}

	/**
	 * Replace one document's MODEL-WRITTEN review threads with the given
	 * findings. Replacing rather than adding is what makes re-reviewing a file
	 * idempotent: a second pass would otherwise stack a duplicate thread on
	 * every line it still disagrees with.
	 *
	 * A thread the user has spoken in - their reply, or a question they started
	 * themselves - survives untouched. Those are their words, not the run's, and
	 * a fresh review is not permission to delete them.
	 */
	replaceFileThreads(uri: vscode.Uri, placements: readonly ReviewPlacement[]): number {
		if (this.disposed) {
			// A per-file answer landing after the user disabled the feature: the
			// threads are gone from the editor, and repopulating byUri here would
			// save this one file over the whole stored review.
			return 0;
		}
		this.disposeModelThreads(uri.toString());
		const now = Date.now();
		const created = placements.map((placement) =>
			this.createThread(uri, {
				id: randomUUID(),
				// The placements are 1-based (what the model was asked for); VS Code
				// ranges are 0-based, and this is the one conversion point.
				startLine: Math.max(0, placement.startLine - 1),
				endLine: Math.max(0, placement.endLine - 1),
				resolved: false,
				comments: [{ author: "model", body: placement.body, createdAt: now }],
			})
		);
		this.persist();
		return created.length;
	}

	/**
	 * Restore threads from the persisted store. Works on closed documents (the
	 * comment controller does not need one open), and saves nothing: rehydration
	 * changes no state, it recreates it.
	 */
	rehydrate(threads: ReviewThreadsByUri): void {
		for (const [uriString, stored] of Object.entries(threads)) {
			let uri: vscode.Uri;
			try {
				uri = vscode.Uri.parse(uriString, true);
			} catch {
				// A key that is not a URI cannot address a document; the next
				// mutation's snapshot drops it.
				continue;
			}
			for (const thread of stored) {
				this.createThread(uri, thread, vscode.CommentThreadCollapsibleState.Collapsed);
			}
		}
	}

	/** Drop every thread stored under these URI strings (the prune's removals), then persist. */
	removeUris(uriStrings: readonly string[]): void {
		// The prune's .then() can land after a disable; this return, not dispose() clearing byUri, keeps "disposed means inert" true.
		if (this.disposed) {
			return;
		}
		let removed = false;
		for (const uriString of uriStrings) {
			removed = this.disposeUri(uriString) || removed;
		}
		if (removed) {
			this.persist();
		}
	}

	/**
	 * The thread's record, adopting it first when the USER started it from the
	 * gutter: the commenting range provider lets them open a thread anywhere, and
	 * the host creates that one itself, so it reaches us unindexed. Adopting is
	 * what makes their question a real thread - persisted, resolvable, deletable -
	 * instead of a widget that swallows what they typed. False only once the
	 * controller is disposed, which is the caller's cue to do nothing.
	 */
	adopt(thread: vscode.CommentThread): boolean {
		if (this.disposed) {
			return false;
		}
		if (this.records.get(thread) !== undefined) {
			return true;
		}
		const live: LiveThread = { id: randomUUID(), thread, comments: [], resolved: false };
		thread.label = l10n.t("LiteLLM review");
		applyResolution(thread, false);
		const uriString = thread.uri.toString();
		this.byUri.set(uriString, [...(this.byUri.get(uriString) ?? []), live]);
		this.records.set(thread, live);
		return true;
	}

	/**
	 * Append one comment to a thread and return the thread's turns INCLUDING it;
	 * undefined when the thread is not ours or the controller is disposed. The
	 * host's `comments` array is readonly: mutating it in place changes nothing
	 * on screen, so the whole array is REASSIGNED, which is what makes the new
	 * comment render. Returning the new turns is what lets a caller build its
	 * follow-up request without re-reading state that another await could have
	 * moved underneath it.
	 */
	appendComment(
		thread: vscode.CommentThread,
		author: ReviewCommentAuthor,
		body: string
	): readonly StoredReviewComment[] | undefined {
		const record = this.liveRecord(thread);
		if (record === undefined) {
			return undefined;
		}
		record.comments = [...record.comments, { author, body, createdAt: Date.now() }];
		thread.comments = record.comments.map(renderComment);
		this.persist();
		return record.comments;
	}

	/** Mark a thread resolved or unresolved: the host state, our record, and the menus' contextValue together. */
	setResolved(thread: vscode.CommentThread, resolved: boolean): void {
		const record = this.liveRecord(thread);
		if (record === undefined) {
			return;
		}
		record.resolved = resolved;
		applyResolution(thread, resolved);
		this.persist();
	}

	/** Delete one thread outright: gone from the editor and from the store. */
	deleteThread(thread: vscode.CommentThread): void {
		const record = this.liveRecord(thread);
		if (record === undefined) {
			return;
		}
		const uriString = thread.uri.toString();
		const remaining = (this.byUri.get(uriString) ?? []).filter((candidate) => candidate !== record);
		if (remaining.length === 0) {
			this.byUri.delete(uriString);
		} else {
			this.byUri.set(uriString, remaining);
		}
		this.records.delete(thread);
		thread.dispose();
		this.persist();
	}

	/**
	 * The live threads in the persisted shape. The line numbers are the ones the
	 * thread was created with: the editor moves a thread on screen as its
	 * document is edited, but that adjustment lives on the UI side - the API
	 * pushes nothing back to `CommentThread.range` (the extension host only ever
	 * receives collapse-state updates). So a thread restored into a file that
	 * changed while it was stored can sit on the wrong line, and re-reviewing
	 * the file is the fix. Tracking edits ourselves would be a line-tracking
	 * engine, which this feature deliberately does not carry.
	 */
	snapshot(): ReviewThreadsByUri {
		const snapshot: Record<string, readonly StoredReviewThread[]> = {};
		for (const [uriString, threads] of this.byUri) {
			// adopt() indexes a thread before any comment lands, so another thread's mutation persisting inside the reply
			// queue's await window would otherwise bank a comments:[] thread that rehydrates as an empty widget next session.
			const spoken = threads.filter((live) => live.comments.length > 0);
			if (spoken.length === 0) {
				continue;
			}
			snapshot[uriString] = spoken.map((live) => {
				const range = live.thread.range;
				return {
					id: live.id,
					startLine: range?.start.line ?? 0,
					endLine: range?.end.line ?? 0,
					resolved: live.resolved,
					comments: live.comments,
				};
			});
		}
		return snapshot;
	}

	dispose(): void {
		// Disposing the controller removes its threads; the persisted store is
		// deliberately left alone, so re-enabling the feature restores them. The
		// flag is what keeps it that way: a request still in flight when the user
		// disabled the feature lands on this instance afterwards, and a mutation
		// then would save an emptied snapshot over the user's whole review.
		this.disposed = true;
		this.byUri.clear();
		this.controller.dispose();
	}

	/**
	 * The record a mutation may act on: known to this controller, and this
	 * controller still live. Every mutating method reads through here, so
	 * "disposed means inert" holds by construction rather than per method.
	 */
	private liveRecord(thread: vscode.CommentThread): LiveThread | undefined {
		return this.disposed ? undefined : this.records.get(thread);
	}

	/** Create one host thread from a stored record and index it both ways. */
	private createThread(
		uri: vscode.Uri,
		stored: StoredReviewThread,
		collapsibleState = vscode.CommentThreadCollapsibleState.Expanded
	): LiveThread {
		const range = new vscode.Range(stored.startLine, 0, stored.endLine, 0);
		const thread = this.controller.createCommentThread(uri, range, stored.comments.map(renderComment));
		thread.label = l10n.t("LiteLLM review");
		thread.collapsibleState = collapsibleState;
		applyResolution(thread, stored.resolved);
		const live: LiveThread = { id: stored.id, thread, comments: stored.comments, resolved: stored.resolved };
		this.byUri.set(uri.toString(), [...(this.byUri.get(uri.toString()) ?? []), live]);
		this.records.set(thread, live);
		return live;
	}

	/** Dispose every thread under one URI string; reports whether anything was there. */
	private disposeUri(uriString: string): boolean {
		const threads = this.byUri.get(uriString);
		if (threads === undefined) {
			return false;
		}
		for (const live of threads) {
			this.records.delete(live.thread);
			live.thread.dispose();
		}
		this.byUri.delete(uriString);
		return true;
	}

	/**
	 * Dispose only the threads under one URI that the user has never spoken in,
	 * keeping theirs. See replaceFileThreads for why the distinction exists.
	 */
	private disposeModelThreads(uriString: string): void {
		const threads = this.byUri.get(uriString);
		if (threads === undefined) {
			return;
		}
		const kept: LiveThread[] = [];
		for (const live of threads) {
			if (live.comments.some((comment) => comment.author === "user")) {
				kept.push(live);
				continue;
			}
			this.records.delete(live.thread);
			live.thread.dispose();
		}
		if (kept.length === 0) {
			this.byUri.delete(uriString);
		} else {
			this.byUri.set(uriString, kept);
		}
	}

	private persist(): void {
		this.save(this.snapshot());
	}
}

/** One stored comment as the host renders it; Preview mode, since these are never edited in place. */
function renderComment(comment: StoredReviewComment): vscode.Comment {
	return {
		body: comment.body,
		mode: vscode.CommentMode.Preview,
		author: comment.author === "model" ? modelAuthor() : userAuthor(),
		timestamp: new Date(comment.createdAt),
	};
}

/** The two faces of a thread's resolution: the host's own state, and the contextValue the menus match. */
function applyResolution(thread: vscode.CommentThread, resolved: boolean): void {
	thread.state = resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
	thread.contextValue = resolved ? RESOLVED_CONTEXT : UNRESOLVED_CONTEXT;
}
