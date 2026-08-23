import * as vscode from "vscode";
import type { OneShotClient } from "../../../provider/transport/oneShotClient";
import { CMD } from "../../../shared/config/commandIds";
import { CONFIG_SECTION, type FeatureModelRef } from "../../../shared/config/settingSpec";
import { isFeatureEnabled } from "../../../shared/config/settings";
import { REVIEW_COMMENT_THREADS_KEY } from "../../../shared/config/storageKeys";
import type { Logger } from "../../../shared/logger";
import type { ReviewCommandDeps } from "./commands";
import {
	deleteReviewThread,
	runReviewChanges,
	runReviewFile,
	runReviewReply,
	sendReviewMessages,
	setThreadResolved,
} from "./commands";
import { ReviewCommentController } from "./controller";
import type { ReviewThreadsByUri } from "./persistence";
import { decodeStore, encodeStore, pruneThreads } from "./persistence";
import { NO_FINDINGS_REPLY, parsePlacements } from "./placements";
import { buildDiffReviewPrompt } from "./reviewPrompt";

/**
 * Review-comments wiring: the comment controller exists ONLY while the feature
 * is enabled (opt-in by construction - disabled means no controller, no
 * threads, and zero traffic), toggled by a configuration watcher, while every
 * command is registered unconditionally so a keybinding or executeCommand on a
 * disabled feature answers with the enable hint.
 *
 * The stored threads outlive a disable on purpose: disposing the controller
 * takes the threads off the screen without touching workspaceState, so
 * re-enabling brings the same review back. `oneShot` is the activation-shared
 * client, so OAuth tokens cache across features and invalidate on 401 like the
 * chat and usage paths.
 */

/** The canned change the dashboard's Test model button reviews: small, and wrong in a way any model should catch. */
const PROBE_DIFF = [
	"@@ -1,5 +1,7 @@",
	" function averageOf(values) {",
	"-  if (values.length === 0) {",
	"-    return 0;",
	"-  }",
	"-  return values.reduce((a, b) => a + b, 0) / values.length;",
	"+  let total = 0;",
	"+  for (let i = 0; i <= values.length; i++) {",
	"+    total += values[i];",
	"+  }",
	"+  return total / values.length;",
	" }",
].join("\n");

/**
 * The probe diff's post-change line count, from its `@@ -1,5 +1,7 @@` header.
 * The parse anchors against it exactly as a real review anchors against the
 * document, so an out-of-range finding clamps here the way it would there.
 */
const PROBE_LINE_COUNT = 7;

/**
 * The dashboard's review probe: the feature's own prompt builder over a fixed
 * sample diff, sent down the feature's own transport path and read back through
 * the same parser, so the probe proves what a real review would do - connection,
 * model, surface, and a parseable answer - rather than merely that something
 * replied. Prose the parser rejects surfaces as the empty-answer warning instead
 * of a false success; the no-findings sentinel counts as a pass, because a model
 * that answered in the contract's vocabulary is configured correctly whatever it
 * concluded. It deliberately creates no threads.
 */
export function createReviewProbe(
	send: (ref: FeatureModelRef, prompt: string, token: vscode.CancellationToken) => Promise<string>
): (model: FeatureModelRef) => Promise<string | undefined> {
	return async (model) => {
		// The source exists only to satisfy the send's token seam; dispose it
		// deterministically so probes cannot accumulate live sources across
		// dashboard sessions.
		const source = new vscode.CancellationTokenSource();
		try {
			const answer = await send(model, buildDiffReviewPrompt({ path: "average.js", diff: PROBE_DIFF }), source.token);
			const parsed = parsePlacements(answer, PROBE_LINE_COUNT);
			if (parsed.placements.length > 0) {
				return parsed.placements.map((placement) => placement.body).join("\n");
			}
			return parsed.sawNoFindings ? NO_FINDINGS_REPLY : undefined;
		} finally {
			source.dispose();
		}
	};
}

export function wireReviewComments(
	context: vscode.ExtensionContext,
	logger: Logger,
	deps: { readonly oneShot: OneShotClient; readonly outputChannel: vscode.OutputChannel }
): { readonly reviewSend: (ref: FeatureModelRef, prompt: string, token: vscode.CancellationToken) => Promise<string> } {
	const log = (message: string, data?: unknown): void => {
		logger.log(message, data);
	};
	const save = (threads: ReviewThreadsByUri): void => {
		// Fire-and-forget by design: a review must not wait on storage, and a
		// failed write costs the restored threads, never the visible ones.
		Promise.resolve(context.workspaceState.update(REVIEW_COMMENT_THREADS_KEY, encodeStore(threads))).catch(
			(error: unknown) => {
				logger.error("Saving review comment threads failed", error);
			}
		);
	};

	let controller: ReviewCommentController | undefined;
	const commandDeps: ReviewCommandDeps = {
		oneShot: deps.oneShot,
		secrets: context.secrets,
		logger,
		outputChannel: deps.outputChannel,
		controller: () => controller,
	};

	const applyEnablement = (): void => {
		const enabled = isFeatureEnabled("reviewComments");
		if (enabled && controller === undefined) {
			controller = new ReviewCommentController(save);
			restoreThreads(context, controller, logger);
		} else if (!enabled && controller !== undefined) {
			controller.dispose();
			controller = undefined;
		}
	};
	applyEnablement();

	context.subscriptions.push(
		vscode.commands.registerCommand(CMD.reviewChanges, (commandArg?: unknown) =>
			runReviewChanges(commandDeps, commandArg)
		),
		vscode.commands.registerCommand(CMD.reviewFile, () => runReviewFile(commandDeps)),
		vscode.commands.registerCommand(CMD.reviewReply, (reply: vscode.CommentReply) =>
			runReviewReply(commandDeps, reply)
		),
		vscode.commands.registerCommand(CMD.reviewResolveThread, (thread: vscode.CommentThread) => {
			setThreadResolved(commandDeps, thread, true);
		}),
		vscode.commands.registerCommand(CMD.reviewUnresolveThread, (thread: vscode.CommentThread) => {
			setThreadResolved(commandDeps, thread, false);
		}),
		vscode.commands.registerCommand(CMD.reviewDeleteThread, (thread: vscode.CommentThread) => {
			deleteReviewThread(commandDeps, thread);
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration(CONFIG_SECTION)) {
				applyEnablement();
			}
		}),
		new vscode.Disposable(() => {
			controller?.dispose();
			controller = undefined;
		})
	);

	return {
		reviewSend: (ref, prompt, token) =>
			sendReviewMessages(commandDeps, ref, [{ role: "user", content: prompt }], token, log),
	};
}

/**
 * Restore the stored threads into a freshly created controller, then prune the
 * ones whose documents are gone. Rehydration is synchronous (it needs no
 * document open); the prune's stat calls are deliberately off the critical
 * path, so activation never waits on the file system.
 */
function restoreThreads(context: vscode.ExtensionContext, controller: ReviewCommentController, logger: Logger): void {
	const decoded = decodeStore(context.workspaceState.get(REVIEW_COMMENT_THREADS_KEY));
	if (!decoded.ok) {
		logger.log("Stored review comment threads were unreadable", { reason: decoded.reason });
	} else if (decoded.dropped > 0) {
		logger.log("Dropped malformed stored review comment records", { dropped: decoded.dropped });
	}
	controller.rehydrate(decoded.threads);
	pruneThreads(decoded.threads, documentExists)
		.then((pruned) => {
			if (pruned.removedUris.length > 0) {
				controller.removeUris(pruned.removedUris);
			}
		})
		.catch((error: unknown) => {
			logger.error("Pruning review comment threads failed", error);
		});
}

/**
 * Whether a stored URI still names something on disk. Only a definite
 * FileNotFound counts as gone: any other stat failure (a permission error, an
 * unmounted drive, a scheme with no file system provider) must not delete a
 * user's review threads, so it reads as present.
 */
async function documentExists(uriString: string): Promise<boolean> {
	let uri: vscode.Uri;
	try {
		uri = vscode.Uri.parse(uriString, true);
	} catch {
		return false;
	}
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch (error) {
		return !(error instanceof vscode.FileSystemError && error.code === "FileNotFound");
	}
}
