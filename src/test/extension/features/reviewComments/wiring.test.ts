/**
 * The review-comments wiring: opt-in by construction. Disabled means NO
 * comment controller, no threads, and no writes to workspaceState; enabling
 * restores what was stored, disabling takes it off screen without erasing it.
 * The commands register unconditionally either way, because a keybinding or
 * executeCommand does not honour a menu's when-clause.
 */
import * as assert from "node:assert";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { REVIEW_STORE_VERSION } from "../../../../extension/features/reviewComments/persistence";
import { createReviewProbe, wireReviewComments } from "../../../../extension/features/reviewComments/wiring";
import { OneShotClient } from "../../../../provider/transport/oneShotClient";
import { CMD, COMMENT_CONTROLLER_ID } from "../../../../shared/config/commandIds";
import { REVIEW_COMMENT_THREADS_KEY } from "../../../../shared/config/storageKeys";
import { Logger } from "../../../../shared/logger";
import { withConfig } from "../../../testUtils";
import type { CommentSpies, FakeThread } from "./commentHarness";
import { fakeReviewContext, withCommentSpies } from "./commentHarness";

const STORED_URI = "file:///workspace/stored.ts";

/** One workspaceState value carrying a single restorable thread. */
function seededStore(uri = STORED_URI) {
	return {
		version: REVIEW_STORE_VERSION,
		threads: {
			[uri]: [
				{
					id: "thread-1",
					startLine: 4,
					endLine: 6,
					resolved: false,
					comments: [{ author: "model", body: "This leaks the handle.", createdAt: 1_700_000_000_000 }],
				},
			],
		},
	};
}

function quietLogger(): Logger {
	return new Logger({ info() {}, error() {} });
}

function wire(context: vscode.ExtensionContext) {
	return wireReviewComments(context, quietLogger(), {
		oneShot: new OneShotClient({ userAgent: "test-agent" }),
		outputChannel: { show: () => {}, appendLine: () => {} } as unknown as vscode.OutputChannel,
	});
}

/** Wait for a fire-and-forget effect, or give up; the prune runs off the critical path on purpose. */
async function eventually(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 50 && !predicate(); attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

suite("extension/features/reviewComments wiring", () => {
	test("disabled creates no controller, restores nothing, and still registers every command", async () => {
		await withCommentSpies(async (spies: CommentSpies) => {
			const context = fakeReviewContext({ [REVIEW_COMMENT_THREADS_KEY]: seededStore() });
			await withConfig({ "reviewComments.enabled": false }, () => {
				wire(context);
			});
			assert.strictEqual(spies.controllers.length, 0, "no controller while the feature is off");
			assert.deepStrictEqual(
				spies.commandIds.sort(),
				[
					CMD.reviewChanges,
					CMD.reviewDeleteThread,
					CMD.reviewFile,
					CMD.reviewReply,
					CMD.reviewResolveThread,
					CMD.reviewUnresolveThread,
				].sort()
			);
		});
	});

	test("enabled creates the controller under its pinned id, with a commenting range provider", async () => {
		await withCommentSpies(async (spies) => {
			await withConfig({ "reviewComments.enabled": true }, () => {
				wire(fakeReviewContext());
			});
			assert.strictEqual(spies.controllers.length, 1);
			const controller = spies.controllers[0];
			assert.strictEqual(controller?.id, COMMENT_CONTROLLER_ID);
			assert.ok(controller?.commentingRangeProvider !== undefined, "users can start their own threads");
		});
	});

	test("the commenting ranges cover a real file, and offer no gutter anywhere threads could not be stored", async () => {
		const root = vscode.Uri.file(path.join(os.tmpdir(), `lvt-review-ranges-${process.pid}-${Date.now()}`));
		await vscode.workspace.fs.createDirectory(root);
		const file = vscode.Uri.joinPath(root, "ranges.ts");
		await vscode.workspace.fs.writeFile(file, new TextEncoder().encode("a\nb\nc"));
		try {
			await withCommentSpies(async (spies) => {
				await withConfig({ "reviewComments.enabled": true }, () => {
					wire(fakeReviewContext());
				});
				const provider = spies.controllers[0]?.commentingRangeProvider;
				assert.ok(provider !== undefined);
				const token = new vscode.CancellationTokenSource().token;

				const ranges = await provider.provideCommentingRanges(await vscode.workspace.openTextDocument(file), token);
				assert.ok(ranges !== undefined && ranges !== null && !Array.isArray(ranges));
				assert.strictEqual(ranges.enableFileComments, false, "every thread is line-anchored, so no file comments");
				assert.strictEqual(ranges.ranges?.[0]?.start.line, 0);
				assert.strictEqual(ranges.ranges?.[0]?.end.line, 2);

				// An untitled buffer or a virtual document would be stored under a
				// URI that names something else next session, and the prune could
				// never clear it - so there is no gutter to start one from.
				const untitled = await vscode.workspace.openTextDocument({ content: "a\nb", language: "typescript" });
				const scratch = await provider.provideCommentingRanges(untitled, token);
				assert.ok(scratch !== undefined && scratch !== null && !Array.isArray(scratch));
				assert.deepStrictEqual(scratch.ranges, []);
			});
		} finally {
			await vscode.workspace.fs.delete(root, { recursive: true, useTrash: false });
		}
	});

	test("stored threads rehydrate at init, on a document that is never opened", async () => {
		await withCommentSpies(async (spies) => {
			await withConfig({ "reviewComments.enabled": true }, () => {
				wire(fakeReviewContext({ [REVIEW_COMMENT_THREADS_KEY]: seededStore() }));
			});
			const threads = spies.controllers[0]?.threads ?? [];
			assert.strictEqual(threads.length, 1);
			const thread = threads[0] as FakeThread;
			assert.strictEqual(thread.uri.toString(), STORED_URI);
			assert.strictEqual(thread.range?.start.line, 4);
			assert.strictEqual(thread.range?.end.line, 6);
			assert.strictEqual(thread.comments[0]?.body, "This leaks the handle.");
			assert.strictEqual(thread.contextValue, "unresolved");
			assert.strictEqual(
				thread.collapsibleState,
				vscode.CommentThreadCollapsibleState.Collapsed,
				"a restored thread does not pop open on every window reload"
			);
		});
	});

	test("rehydration writes nothing back: restoring state is not a mutation", async () => {
		await withCommentSpies(async () => {
			const context = fakeReviewContext({ [REVIEW_COMMENT_THREADS_KEY]: seededStore() });
			await withConfig({ "reviewComments.enabled": true }, () => {
				wire(context);
			});
			assert.deepStrictEqual(context.writes, []);
		});
	});

	test("an unreadable stored value restores nothing and throws nothing", async () => {
		await withCommentSpies(async (spies) => {
			const context = fakeReviewContext({ [REVIEW_COMMENT_THREADS_KEY]: { version: 99, threads: {} } });
			await withConfig({ "reviewComments.enabled": true }, () => {
				wire(context);
			});
			assert.strictEqual(spies.controllers[0]?.threads.length, 0);
			assert.deepStrictEqual(context.writes, [], "a failed decode must not overwrite the store");
		});
	});

	test("disable disposes the controller and stops persisting; re-enable restores from the untouched store", async () => {
		await withCommentSpies(async (spies) => {
			const context = fakeReviewContext({ [REVIEW_COMMENT_THREADS_KEY]: seededStore() });
			await withConfig({ "reviewComments.enabled": true }, () => {
				wire(context);
			});
			assert.strictEqual(spies.controllers[0]?.threads.length, 1);

			await withConfig({ "reviewComments.enabled": false }, () => {
				spies.fireConfigChange();
			});
			assert.strictEqual(spies.controllers[0]?.disposed, true, "disable disposes the controller");
			assert.deepStrictEqual(context.writes, [], "disabling must not erase the stored review");

			await withConfig({ "reviewComments.enabled": true }, () => {
				spies.fireConfigChange();
			});
			assert.strictEqual(spies.controllers.length, 2, "re-enable creates a fresh controller");
			assert.strictEqual(spies.controllers[1]?.threads.length, 1, "and restores the same review");
		});
	});

	test("the prune drops the threads of a file that is gone and keeps the ones whose file is still there", async () => {
		// Real files on disk rather than a stubbed stat: vscode.workspace.fs is
		// frozen, and this way the whole chain is proven - the FileNotFound
		// mapping included. The "a stat that failed for another reason counts as
		// present" rule is the pure codec's, pinned in persistence.test.ts.
		const root = vscode.Uri.file(path.join(os.tmpdir(), `lvt-review-prune-${process.pid}-${Date.now()}`));
		const gone = vscode.Uri.joinPath(root, "gone.ts");
		const kept = vscode.Uri.joinPath(root, "kept.ts");
		await vscode.workspace.fs.createDirectory(root);
		const bytes = new TextEncoder().encode("const x = 1;\n");
		await vscode.workspace.fs.writeFile(gone, bytes);
		await vscode.workspace.fs.writeFile(kept, bytes);
		await vscode.workspace.fs.delete(gone);
		try {
			await withCommentSpies(async (spies) => {
				const context = fakeReviewContext({
					[REVIEW_COMMENT_THREADS_KEY]: {
						version: REVIEW_STORE_VERSION,
						threads: {
							...seededStore(gone.toString()).threads,
							...seededStore(kept.toString()).threads,
						},
					},
				});
				await withConfig({ "reviewComments.enabled": true }, () => {
					wire(context);
				});
				const controller = spies.controllers[0];
				assert.strictEqual(controller?.threads.length, 2, "both restore before the prune has run");
				await eventually(() => context.writes.length > 0);
				assert.strictEqual(
					controller?.threads.filter((thread) => !thread.disposed).length,
					1,
					"only the missing file loses its threads"
				);
				const stored = context.writes.at(-1) as { threads: Record<string, unknown> } | undefined;
				assert.deepStrictEqual(Object.keys(stored?.threads ?? {}), [kept.toString()]);
			});
		} finally {
			await vscode.workspace.fs.delete(root, { recursive: true, useTrash: false });
		}
	});

	test("the real comments API accepts this controller's id, thread, and comment shapes", () => {
		// The suite's other tests run against a recording double; this one proves
		// the shapes it records are ones the host itself takes.
		const controller = vscode.comments.createCommentController(`${COMMENT_CONTROLLER_ID}.test`, "LiteLLM review");
		try {
			const thread = controller.createCommentThread(vscode.Uri.parse(STORED_URI), new vscode.Range(0, 0, 1, 0), [
				{
					body: "a finding",
					mode: vscode.CommentMode.Preview,
					author: { name: "LiteLLM" },
					timestamp: new Date(0),
				},
			]);
			thread.contextValue = "unresolved";
			thread.state = vscode.CommentThreadState.Unresolved;
			thread.comments = [
				...thread.comments,
				{ body: "a reply", mode: vscode.CommentMode.Preview, author: { name: "You" } },
			];
			assert.strictEqual(thread.comments.length, 2);
			thread.dispose();
		} finally {
			controller.dispose();
		}
	});

	test("the dashboard probe disposes its cancellation source, success and failure alike", async () => {
		const originalDispose = vscode.CancellationTokenSource.prototype.dispose;
		let disposals = 0;
		vscode.CancellationTokenSource.prototype.dispose = function (this: vscode.CancellationTokenSource) {
			disposals += 1;
			return originalDispose.call(this);
		};
		try {
			let seenPrompt = "";
			const okProbe = createReviewProbe(async (_ref, prompt) => {
				seenPrompt = prompt;
				return "LINE 3: reads past the end";
			});
			// The probe answers with what the PARSER read, not the raw reply.
			assert.strictEqual(await okProbe({ server: "Main", model: "gpt-test" }), "reads past the end");
			assert.strictEqual(disposals, 1, "a resolved probe releases its source");
			// The probe runs the feature's own prompt builder over a canned diff, so
			// it proves the real pipeline rather than a bare ping.
			assert.ok(seenPrompt.includes("Working tree diff of average.js:"));
			assert.ok(seenPrompt.includes("LINE <start>-<end>:"));

			const failProbe = createReviewProbe(async () => {
				throw new Error("boom");
			});
			await assert.rejects(failProbe({ server: "Main", model: "gpt-test" }));
			assert.strictEqual(disposals, 2, "a rejected probe releases its source too");
		} finally {
			vscode.CancellationTokenSource.prototype.dispose = originalDispose;
		}
	});

	test("the dashboard probe reports prose as no answer, and the no-findings reply as one", async () => {
		// A model that ignores the format is not a working review model, so the
		// probe must fail it rather than count characters: the dashboard turns
		// undefined into the empty-answer warning. Without the parse, every one
		// of these reads as a green probe.
		for (const prose of [
			"Sure! The loop looks like it might read past the end of the array.",
			"```\n```",
			"   \n\n  ",
			"",
		]) {
			const probe = createReviewProbe(async () => prose);
			assert.strictEqual(
				await probe({ server: "Main", model: "gpt-test" }),
				undefined,
				`an unparseable reply is no answer: ${JSON.stringify(prose)}`
			);
		}

		// The sentinel is the contract's own vocabulary for a clean file, so it
		// proves the model understood the format and passes.
		const cleanProbe = createReviewProbe(async () => "NO FINDINGS");
		const clean = await cleanProbe({ server: "Main", model: "gpt-test" });
		assert.ok(clean !== undefined && clean !== "", "the no-findings reply is a parseable answer");
	});
});
