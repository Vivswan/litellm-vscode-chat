import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import { statusErrorTexts } from "../../../provider/transport/errorMapping";
import type { OneShotChatMessage, OneShotClient } from "../../../provider/transport/oneShotClient";
import type { BooleanSettingId, FeatureModelRef } from "../../../shared/config/settingSpec";
import { CONFIG_SECTION, FEATURE_MODEL_SETTING_KEYS } from "../../../shared/config/settingSpec";
import { getFeatureModelRef, getRequestTimeout, isFeatureEnabled } from "../../../shared/config/settings";
import type { Logger } from "../../../shared/logger";
import { entryConnectionFor } from "../../servers/entryConnection";
import { commandErrorActions, openSettingsAction, showActionableMessage } from "../../ui/notifier";
import { documentLabel, pickRepository, repositoryRelativePath, resolveGitApi } from "../gitAccess";
import type { API, Change, Repository } from "../gitApi";
import { noEntryForConfiguredServer } from "../modelSettingError";
import type { ReviewCommentController } from "./controller";
import type { ReviewPlacement } from "./placements";
import type { ReviewRunOutcome, ReviewUnit } from "./review";
import { REVIEW_FILE_LIMIT, runReview } from "./review";
import { buildDiffReviewPrompt, buildFileReviewPrompt, buildReplyMessages } from "./reviewPrompt";

/**
 * The review commands' surface: gating, target selection (a repository's
 * uncommitted changes, or the active file), progress, and the mapping of a
 * finished run to a notification. The per-file loop lives in review.ts, the
 * prompts in reviewPrompt.ts, the threads in controller.ts; the one-shot
 * transport in provider/transport/oneShotClient.ts.
 *
 * Every command here is registered unconditionally - the menus hide behind the
 * enable when-clause, but keybindings and executeCommand do not - so each one
 * answers a disabled invocation with the enable hint instead of doing nothing.
 * These handlers are their own single logging boundary: the transport
 * constructs classified errors without logging, and each catch below logs once.
 */

export interface ReviewCommandDeps {
	readonly oneShot: OneShotClient;
	readonly secrets: vscode.SecretStorage;
	readonly logger: Logger;
	readonly outputChannel: vscode.OutputChannel;
	/** The live controller while the feature is enabled; undefined while it is off. */
	readonly controller: () => ReviewCommentController | undefined;
	/** Defaults to the live vscode.git extension; tests inject a fake. */
	readonly resolveGit?: () => Promise<API | undefined>;
}

/**
 * The enable key, typed so a rename in BOOLEAN_SETTING_SPECS breaks this
 * compile instead of leaving the hint pointing at a dead setting.
 */
const ENABLED_SETTING_KEY: BooleanSettingId = "reviewComments.enabled";

/** The full setting IDs the commands' hints point at. */
const ENABLED_SETTING_ID = `${CONFIG_SECTION}.${ENABLED_SETTING_KEY}`;
const MODEL_SETTING_ID = `${CONFIG_SECTION}.${FEATURE_MODEL_SETTING_KEYS.reviewComments}`;

/**
 * One file this layer reviews: the generic unit plus the document version the
 * prompt described. The version is what makes a stale answer detectable - it
 * is a vscode concept, so it lives here rather than in the pure loop.
 */
interface FileReviewUnit extends ReviewUnit<vscode.Uri> {
	readonly version: number;
}

/** What every review command needs before it may touch the network or the threads. */
interface OpenGate {
	readonly ref: FeatureModelRef;
	readonly controller: ReviewCommentController;
	readonly log: (message: string, data?: unknown) => void;
}

/**
 * The feature half of the fail-closed gate: is there a live comment surface at
 * all? A missing controller while the setting reads enabled is the same state
 * from the user's side (nothing is registered), so it gives the same hint
 * rather than a second vocabulary for an unreachable case.
 */
async function openFeatureGate(deps: ReviewCommandDeps): Promise<ReviewCommentController | undefined> {
	const controller = deps.controller();
	if (!isFeatureEnabled("reviewComments") || controller === undefined) {
		await showActionableMessage(
			"info",
			l10n.t('Review comments are off. Enable "{0}" in settings to use them.', ENABLED_SETTING_ID),
			[openSettingsAction(ENABLED_SETTING_ID)]
		);
		return undefined;
	}
	return controller;
}

/**
 * The model half of the gate: which model answers, or the advice to show and
 * no request. Split from the feature gate because the reply path must bank the
 * user's typed words BEFORE it asks this question - VS Code closes the reply
 * editor either way, so a refusal here would throw away what they wrote.
 *
 * The advice comes back as a thunk rather than being shown here, because the
 * reply path runs inside a thread's queue and a notification settles only when
 * the user dismisses it: showing it in place would let an ignored toast block
 * every later reply to that thread. The review commands, which have no queue,
 * simply invoke it at once.
 */
function reviewModelGate(deps: ReviewCommandDeps): ModelGate {
	const ref = getFeatureModelRef("reviewComments", (message, data) => {
		deps.logger.log(message, data);
	});
	if (ref !== undefined) {
		return { ref };
	}
	return {
		ref: undefined,
		notice: () =>
			showActionableMessage(
				"warning",
				l10n.t(
					'No model is configured for review comments. Pick one via the "{0}" setting or the LiteLLM dashboard.',
					MODEL_SETTING_ID
				),
				[openSettingsAction(MODEL_SETTING_ID)]
			),
	};
}

/** reviewModelGate's verdict: the configured model, or the advice to show instead. */
type ModelGate = { readonly ref: FeatureModelRef } | { readonly ref: undefined; readonly notice: ReplyNotice };

/** Both halves, for the review commands, which have nothing to bank before asking. */
async function openGate(deps: ReviewCommandDeps): Promise<OpenGate | undefined> {
	const controller = await openFeatureGate(deps);
	if (controller === undefined) {
		return undefined;
	}
	const model = reviewModelGate(deps);
	if (model.ref === undefined) {
		await model.notice();
		return undefined;
	}
	return {
		ref: model.ref,
		controller,
		log: (message: string, data?: unknown) => {
			deps.logger.log(message, data);
		},
	};
}

/**
 * Resolve the configured server label to its declared entry's connection and
 * send one non-streaming request. Connection resolution is the shared
 * entryConnectionFor; only the no-such-label advice is this feature's.
 */
export async function sendReviewMessages(
	deps: Pick<ReviewCommandDeps, "oneShot" | "secrets">,
	ref: FeatureModelRef,
	messages: readonly OneShotChatMessage[],
	token: vscode.CancellationToken,
	log: (message: string, data?: unknown) => void
): Promise<string> {
	const resolved = await entryConnectionFor(deps.secrets, ref.server);
	if (resolved === undefined) {
		throw noEntryForConfiguredServer("reviewComments", ref.server);
	}
	return deps.oneShot.completeChatOnce(resolved.connection, { model: ref.model, messages }, "reviewComments", {
		timeoutMs: getRequestTimeout(log),
		token,
	});
}

/** The review commands' one prompt-to-answer call; a review prompt is a single user turn. */
function reviewSender(
	deps: ReviewCommandDeps,
	gate: OpenGate,
	token: vscode.CancellationToken
): (prompt: string) => Promise<string> {
	return (prompt) => sendReviewMessages(deps, gate.ref, [{ role: "user", content: prompt }], token, gate.log);
}

/**
 * Review every uncommitted change in a repository, one request per file.
 * `diffWith("HEAD")` is what makes "uncommitted" mean staged AND unstaged, and
 * it leaves untracked files out - they have no diff to review, and the
 * whole-file command covers them.
 *
 * Everything after the gate runs inside the shared failure boundary, git
 * activation and the repository pick included: activating the built-in Git
 * extension can reject, and an escaped rejection would leave the command
 * silently dead instead of saying what went wrong.
 */
export async function runReviewChanges(deps: ReviewCommandDeps, commandArg: unknown): Promise<void> {
	const gate = await openGate(deps);
	if (gate === undefined) {
		return;
	}
	try {
		const git = await (deps.resolveGit ?? resolveGitApi)();
		if (git === undefined) {
			await showActionableMessage(
				"warning",
				l10n.t("The built-in Git extension is unavailable, so there are no changes to review."),
				[]
			);
			return;
		}
		const repo = await pickRepository(git, commandArg, {
			title: l10n.t("Review Changes"),
			placeHolder: l10n.t("Pick the repository to review"),
		});
		if (repo === "dismissed") {
			return;
		}
		if (repo === undefined) {
			await showActionableMessage("info", l10n.t("Open a folder with a Git repository to review changes."), []);
			return;
		}
		const report = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: l10n.t("Reviewing changes..."), cancellable: true },
			async (progress, token): Promise<ReviewReport> => {
				const enumerated = await diffUnits(repo, token);
				if (token.isCancellationRequested) {
					// Cancelled while enumerating: a "no uncommitted changes" notice
					// here would be both wrong and the very thing cancellation is
					// meant to suppress.
					return { kind: "cancelled" };
				}
				if (enumerated === "unborn") {
					return { kind: "unborn" };
				}
				const { units, skipped, dirty } = enumerated;
				if (units.length === 0 && dirty === 0 && skipped === 0) {
					return { kind: "nothing", what: "changes" };
				}
				const outcome = await runReview(units, {
					send: reviewSender(deps, gate, token),
					apply: applyFindings(gate, units),
					onFileStart: (index, total) => progress.report({ message: l10n.t("File {0} of {1}", index + 1, total) }),
					token: runToken(gate, token),
				});
				return { kind: "reviewed", outcome, skipped, dirty };
			}
		);
		await announce(report);
	} catch (error) {
		await reportCommandFailure(deps, error, "Review failed");
	}
}

/** Review the active editor's file as it stands, whether or not git knows about it. */
export async function runReviewFile(deps: ReviewCommandDeps): Promise<void> {
	const gate = await openGate(deps);
	if (gate === undefined) {
		return;
	}
	const editor = vscode.window.activeTextEditor;
	if (editor === undefined) {
		await showActionableMessage("info", l10n.t("Open a file to review it."), []);
		return;
	}
	const document = editor.document;
	if (document.uri.scheme !== "file") {
		// An untitled buffer or a virtual document (a diff pane, a git: URI) has
		// no stable identity to store threads under: next session the same URI
		// would belong to a different buffer, and nothing would ever prune it.
		await showActionableMessage("info", l10n.t("Save this file before reviewing it."), []);
		return;
	}
	try {
		const report = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: l10n.t("Reviewing this file..."), cancellable: true },
			async (_progress, token): Promise<ReviewReport> => {
				if (document.getText().trim() === "") {
					return { kind: "nothing", what: "file" };
				}
				const unit: FileReviewUnit = {
					target: document.uri,
					lineCount: document.lineCount,
					// The version the prompt describes; findings are refused if the
					// document has moved on by the time the answer lands.
					version: document.version,
					prompt: buildFileReviewPrompt({
						path: documentLabel(document.uri),
						content: document.getText(),
						languageId: document.languageId,
					}),
				};
				const outcome = await runReview([unit], {
					send: reviewSender(deps, gate, token),
					apply: applyFindings(gate, [unit]),
					token: runToken(gate, token),
				});
				return { kind: "reviewed", outcome, skipped: 0, dirty: 0 };
			}
		);
		await announce(report);
	} catch (error) {
		await reportCommandFailure(deps, error, "Review failed");
	}
}

/**
 * The run's stop condition: the user cancelled, OR the feature was switched
 * off underneath it. Losing the controller ends the run for the same reason
 * cancellation does - there is nowhere left to put an answer - and the loop
 * reads this between files, including after a file whose answer was unusable
 * and never reached applyFindings.
 */
function runToken(gate: OpenGate, token: vscode.CancellationToken): { readonly isCancellationRequested: boolean } {
	return {
		get isCancellationRequested() {
			return token.isCancellationRequested || gate.controller.isDisposed;
		},
	};
}

/**
 * The apply seam, refusing a file whose document moved while its review was in
 * flight. The prompt described a specific revision; anchoring its findings onto
 * an edited buffer would put comments on lines the model never saw, and a
 * comment on the wrong line is worse than no comment. The file is counted and
 * the user is told, so a re-run is the obvious next step.
 */
function applyFindings(
	gate: OpenGate,
	units: readonly FileReviewUnit[]
): (uri: vscode.Uri, placements: readonly ReviewPlacement[]) => boolean {
	return (uri, placements) => {
		if (gate.controller.isDisposed) {
			// The user switched the feature off mid-run: the threads are gone and
			// nothing may be written. That is a cancelled run, not a finished one,
			// and the command's boundary swallows cancellation silently.
			throw new vscode.CancellationError();
		}
		const unit = units.find((candidate) => candidate.target.toString() === uri.toString());
		const document = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === uri.toString());
		if (unit !== undefined && document !== undefined && document.version !== unit.version) {
			return false;
		}
		gate.controller.replaceFileThreads(uri, placements);
		return true;
	};
}

/**
 * A reply typed into a review thread: the user's text lands, then the model
 * answers in the same thread. The user's comment is appended BEFORE the
 * request, so a failure leaves their words in place rather than discarding
 * what they typed. A thread the USER started from the gutter is adopted here -
 * the host created it, so it reaches us unindexed - which makes their question
 * the thread's first turn.
 *
 * Replies to one thread run ONE AT A TIME, queued rather than dropped: the
 * reply widget stays usable while a request runs, and a second submission
 * appended immediately would sit above the answer to the first, so a
 * conversation would read out of order and be REPLAYED to the model that way.
 * Waiting its turn keeps both the words and the order. Different threads are
 * independent and run concurrently.
 */
export async function runReviewReply(deps: ReviewCommandDeps, reply: vscode.CommentReply): Promise<void> {
	const controller = await openFeatureGate(deps);
	if (controller === undefined) {
		return;
	}
	const text = reply.text.trim();
	if (text === "") {
		return;
	}
	if (!controller.adopt(reply.thread)) {
		return;
	}
	// The per-thread queue. The tail covers the THREAD WORK alone - append,
	// ask, append - and is released before any notification is shown, because a
	// notification promise settles only when the user dismisses or answers it:
	// leaving one in the tail would let an ignored toast block every later
	// reply to that thread indefinitely.
	const previous = replyQueue.get(reply.thread) ?? Promise.resolve();
	let release: () => void = () => {};
	replyQueue.set(
		reply.thread,
		new Promise<void>((resolve) => {
			release = resolve;
		})
	);
	let notice: ReplyNotice | undefined;
	try {
		// Every queued tail is one of these manually-settled promises, so it
		// never rejects and a failed turn cannot wedge the chain.
		await previous;
		notice = await answerReply(deps, controller, reply, text);
	} finally {
		release();
	}
	await notice?.();
}

/**
 * What a finished turn still owes the user, deferred so that showing it cannot
 * hold the thread's queue: an actionable notification resolves only once it is
 * dismissed or answered.
 */
type ReplyNotice = () => Promise<void>;

/** One queued reply: append the user's turn, ask the model, append the answer. */
async function answerReply(
	deps: ReviewCommandDeps,
	controller: ReviewCommentController,
	reply: vscode.CommentReply,
	text: string
): Promise<ReplyNotice | undefined> {
	// Banked before the model question: the reply editor is already closed by
	// the time this runs, so an unanswered turn is better than a lost one.
	const turns = controller.appendComment(reply.thread, "user", text);
	if (turns === undefined) {
		// The controller was disposed between the adopt and the append (the
		// feature was switched off); there is nothing left to continue.
		return undefined;
	}
	const model = reviewModelGate(deps);
	if (model.ref === undefined) {
		// Their words are on screen and in the store; only the answer is missing,
		// and its advice waits until the queue has been released.
		return model.notice;
	}
	const ref = model.ref;
	const log = (message: string, data?: unknown): void => {
		deps.logger.log(message, data);
	};
	const range = reply.thread.range;
	try {
		const snippet = await anchoredSnippet(reply.thread.uri, range);
		const answer = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: l10n.t("Asking the model..."), cancellable: true },
			(_progress, token) =>
				sendReviewMessages(
					deps,
					ref,
					buildReplyMessages({
						path: documentLabel(reply.thread.uri),
						snippet,
						// The prompt speaks the 1-based numbering the model was given;
						// the host's ranges are 0-based.
						startLine: (range?.start.line ?? 0) + 1,
						endLine: (range?.end.line ?? 0) + 1,
						turns,
					}),
					token,
					log
				)
		);
		if (answer.trim() === "") {
			return () => showActionableMessage("warning", l10n.t("The model replied with nothing. Try asking again."), []);
		}
		controller.appendComment(reply.thread, "model", answer.trim());
		return undefined;
	} catch (error) {
		return () => reportCommandFailure(deps, error, "Review reply failed");
	}
}

/**
 * Each thread's in-flight reply chain: a promise that settles when that turn's
 * THREAD WORK is done, never when its notification is dismissed. See
 * runReviewReply.
 */
const replyQueue = new WeakMap<vscode.CommentThread, Promise<void>>();

/** Mark a thread resolved or unresolved; no network, no gate beyond the controller existing. */
export function setThreadResolved(deps: ReviewCommandDeps, thread: vscode.CommentThread, resolved: boolean): void {
	deps.controller()?.setResolved(thread, resolved);
}

/** Delete one review thread outright. */
export function deleteReviewThread(deps: ReviewCommandDeps, thread: vscode.CommentThread): void {
	deps.controller()?.deleteThread(thread);
}

/** What a finished run has to say; the notification texts live in one place below. */
type ReviewReport =
	| { readonly kind: "nothing"; readonly what: "changes" | "file" }
	| { readonly kind: "cancelled" }
	| { readonly kind: "unborn" }
	| {
			readonly kind: "reviewed";
			readonly outcome: ReviewRunOutcome;
			readonly skipped: number;
			readonly dirty: number;
	  };

/**
 * Show the completion notice, unless the run was cancelled: a cancelled pass
 * keeps whatever landed - the applied comments are already the user's - and
 * says nothing, like every other cancelled command in this extension.
 */
async function announce(report: ReviewReport): Promise<void> {
	if (report.kind === "cancelled" || (report.kind === "reviewed" && report.outcome.cancelled)) {
		return;
	}
	await showActionableMessage("info", reportText(report), []);
}

/**
 * The completion notice: counts only, never a word of what the model wrote.
 * Each case is its own whole sentence rather than assembled fragments, so a
 * translation can order the numbers however its language needs.
 */
function reportText(report: ReviewReport): string {
	if (report.kind === "cancelled") {
		return "";
	}
	if (report.kind === "unborn") {
		return l10n.t(
			"This repository has no commits yet, so there is nothing to compare against. Review a file on its own instead."
		);
	}
	if (report.kind === "nothing") {
		return report.what === "changes"
			? l10n.t("There are no uncommitted changes to review.")
			: l10n.t("There is nothing in this file to review.");
	}
	const { outcome } = report;
	const landed = outcome.reviewed - outcome.unusable - outcome.stale;
	// No leading sentence when no file made it through: "Reviewed 0 files -
	// nothing to report." would be the opposite of what happened, and the
	// sentences below say what actually did.
	const sentences = landed > 0 ? [reviewedSentence(outcome.findings, landed)] : [];
	if (outcome.unusable === 1) {
		sentences.push(l10n.t("1 file got no readable review back and kept its earlier comments."));
	} else if (outcome.unusable > 1) {
		sentences.push(l10n.t("{0} files got no readable review back and kept their earlier comments.", outcome.unusable));
	}
	if (outcome.stale === 1) {
		sentences.push(l10n.t("1 file changed while it was being reviewed, so its comments were not placed."));
	} else if (outcome.stale > 1) {
		sentences.push(
			l10n.t("{0} files changed while they were being reviewed, so their comments were not placed.", outcome.stale)
		);
	}
	if (report.dirty === 1) {
		sentences.push(l10n.t("1 file has unsaved changes; save it and review it on its own."));
	} else if (report.dirty > 1) {
		sentences.push(l10n.t("{0} files have unsaved changes; save them and review them on their own.", report.dirty));
	}
	if (report.skipped > 0) {
		// "more" only reads right after another sentence; on its own - a change
		// set of pure deletions or renames - it would dangle.
		const leading = sentences.length === 0;
		if (report.skipped === 1) {
			sentences.push(
				leading ? l10n.t("1 file had nothing reviewable in it.") : l10n.t("1 more file was left out of this pass.")
			);
		} else {
			sentences.push(
				leading
					? l10n.t("{0} files had nothing reviewable in them.", report.skipped)
					: l10n.t("{0} more files were left out of this pass.", report.skipped)
			);
		}
	}
	return sentences.join(" ");
}

/** The counted outcome as one sentence, with a literal key per plural combination. */
function reviewedSentence(findings: number, files: number): string {
	if (findings === 0) {
		return files === 1
			? l10n.t("Reviewed 1 file - nothing to report.")
			: l10n.t("Reviewed {0} files - nothing to report.", files);
	}
	if (findings === 1) {
		return files === 1 ? l10n.t("1 review comment on 1 file.") : l10n.t("1 review comment across {0} files.", files);
	}
	return files === 1
		? l10n.t("{0} review comments on 1 file.", findings)
		: l10n.t("{0} review comments across {1} files.", findings, files);
}

/** The one failure path every review command shares: cancellation is silent, everything else logs once and shows. */
async function reportCommandFailure(deps: ReviewCommandDeps, error: unknown, logLine: string): Promise<void> {
	if (error instanceof vscode.CancellationError) {
		// User cancellation: never logged, nothing to show.
		return;
	}
	deps.logger.error(logLine, error);
	const texts = statusErrorTexts(error);
	await showActionableMessage("error", texts.error, commandErrorActions(texts.classification, deps.outputChannel));
}

/** What one enumeration pass found; see diffUnits. */
interface DiffUnits {
	readonly units: readonly FileReviewUnit[];
	readonly skipped: number;
	readonly dirty: number;
}

/**
 * The repository's uncommitted files as review units, capped. A file whose
 * document cannot be opened (deleted, binary, unreadable) is skipped before
 * its diff is fetched, and a file whose diff came back empty (a pure rename)
 * contributes nothing to review.
 *
 * A file with UNSAVED edits is skipped too, and counted apart: the diff comes
 * from what is on disk while the comments would be anchored into the buffer,
 * so the model would be describing one revision and the comments would land on
 * another. Reviewing the file itself is the answer there, and the notice says
 * so.
 *
 * A repository with no commits yet has no HEAD to diff against; that state is
 * "nothing uncommitted to review" (only untracked files, which the whole-file
 * command covers), and it is the ONLY enumeration failure swallowed here - any
 * other one is a real git failure and belongs to the command's error boundary.
 */
async function diffUnits(repo: Repository, token: vscode.CancellationToken): Promise<DiffUnits | "unborn"> {
	let changes: readonly Change[];
	try {
		changes = await repo.diffWith("HEAD");
	} catch (error) {
		// HEAD present with no commit is an unborn branch; HEAD ABSENT means the
		// repository state has not loaded yet, which proves nothing about why the
		// diff failed - that one belongs to the error boundary.
		if (repo.state.HEAD !== undefined && repo.state.HEAD.commit === undefined) {
			// No commit to diff against. Whatever is staged here is the first
			// commit's content, which this comparison cannot describe, so the
			// answer names the reason instead of claiming the tree is clean.
			return "unborn";
		}
		throw error;
	}
	const units: FileReviewUnit[] = [];
	let dirty = 0;
	for (const change of changes) {
		if (token.isCancellationRequested || units.length >= REVIEW_FILE_LIMIT) {
			break;
		}
		// Two different strings on purpose: git is asked about the path relative
		// to ITS root, while the model is shown the same label every other review
		// path uses - which never carries an absolute path.
		const gitPath = repositoryRelativePath(repo.rootUri, change.uri);
		let document: vscode.TextDocument;
		try {
			document = await vscode.workspace.openTextDocument(change.uri);
		} catch {
			continue;
		}
		if (document.isDirty) {
			dirty += 1;
			continue;
		}
		const version = document.version;
		const diff = await repo.diffWith("HEAD", gitPath);
		if (document.isDirty || document.version !== version) {
			// Edited while its diff was being read: the diff describes what is on
			// disk, which the buffer no longer matches.
			dirty += 1;
			continue;
		}
		if (diff.trim() === "") {
			continue;
		}
		units.push({
			target: change.uri,
			lineCount: document.lineCount,
			version,
			prompt: buildDiffReviewPrompt({ path: documentLabel(change.uri), diff }),
		});
	}
	return { units, skipped: Math.max(0, changes.length - units.length - dirty), dirty };
}

/**
 * The lines a thread anchors, numbered the way the whole-file prompt numbers
 * them so the model reads one numbering everywhere. Empty when the document
 * cannot be read or the thread carries no range - a reply about code we cannot
 * quote is still worth sending, just without the quote.
 */
async function anchoredSnippet(uri: vscode.Uri, range: vscode.Range | undefined): Promise<string> {
	if (range === undefined) {
		return "";
	}
	let document: vscode.TextDocument;
	try {
		document = await vscode.workspace.openTextDocument(uri);
	} catch {
		return "";
	}
	const last = Math.min(range.end.line, document.lineCount - 1);
	const lines: string[] = [];
	for (let line = Math.max(0, range.start.line); line <= last; line += 1) {
		lines.push(`${line + 1}: ${document.lineAt(line).text}`);
	}
	return lines.join("\n");
}
