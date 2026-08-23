/**
 * The review commands end to end against an msw-mocked server: the fail-closed
 * gate (off, or on without a model, means advice and zero traffic), a whole-file
 * review turning a model answer into anchored threads, and a reply appending
 * the user's words before the model's - by REASSIGNING the thread's readonly
 * comments array, which is the only way the host sees a new comment.
 */
import * as assert from "node:assert";
import * as os from "node:os";
import * as path from "node:path";
import { HttpResponse, http } from "msw";
import * as vscode from "vscode";
import type { API, Change, Repository } from "../../../../extension/features/gitApi";
import type { ReviewCommandDeps } from "../../../../extension/features/reviewComments/commands";
import {
	deleteReviewThread,
	runReviewChanges,
	runReviewFile,
	runReviewReply,
	sendReviewMessages,
	setThreadResolved,
} from "../../../../extension/features/reviewComments/commands";
import { ReviewCommentController } from "../../../../extension/features/reviewComments/controller";
import type { ReviewThreadsByUri } from "../../../../extension/features/reviewComments/persistence";
import { REVIEW_FILE_LIMIT } from "../../../../extension/features/reviewComments/review";
import { OneShotClient } from "../../../../provider/transport/oneShotClient";
import { MirroredError } from "../../../../shared/mirroredError";
import { CHAT_COMPLETIONS_URL, mswServer, TEST_BASE_URL, useMsw } from "../../../mocks/handlers";
import { makeLogger } from "../../../pureHelpers";
import { withConfig } from "../../../testUtils";
import type { FakeController } from "./commentHarness";
import { liveThreads, withCommentSpies } from "./commentHarness";

/** The settings that make the feature live against the msw-mocked server. */
const ENABLED_CONFIG = {
	"reviewComments.enabled": true,
	"reviewComments.model": { server: "alpha", model: "gpt-test" },
	servers: [{ label: "alpha", baseUrl: TEST_BASE_URL, auth: { apiKey: "sk-test" } }],
};

/** One chat completion carrying `content` as the whole reply. */
function chatReply(content: string) {
	return HttpResponse.json({ choices: [{ message: { role: "assistant", content } }] });
}

function fakeSecrets(): vscode.SecretStorage {
	return {
		get: () => Promise.resolve(undefined),
		store: () => Promise.resolve(),
		delete: () => Promise.resolve(),
		keys: () => Promise.resolve([]),
		onDidChange: () => ({ dispose: () => {} }),
	} as unknown as vscode.SecretStorage;
}

/** What a stand-in repository answers with; every field has a boring default. */
interface FakeRepoParts {
	/** The commit HEAD points at; undefined leaves HEAD absent, the state-not-loaded case. */
	readonly head?: string;
	/** Repository-relative paths reported as changed, each with a one-hunk diff. */
	readonly files?: readonly string[];
	/** Changed files named by URI instead, for documents the test already opened. */
	readonly uris?: readonly vscode.Uri[];
	/** Overrides the no-path `diffWith` call, for failure cases. */
	readonly enumerate?: () => Promise<Change[]>;
	/** The repository root the changed URIs sit under; defaults to /repo. */
	readonly root?: vscode.Uri;
}

const REPO_ROOT_URI = vscode.Uri.file("/repo");

/** A one-file diff whose new-file lines exist, so a finding could anchor. */
function oneHunkDiff(path: string): string {
	return [
		`diff --git a/${path} b/${path}`,
		`--- a/${path}`,
		`+++ b/${path}`,
		"@@ -1,2 +1,3 @@",
		" alpha",
		"+added",
	].join("\n");
}

function fakeRepo(parts: FakeRepoParts): Repository {
	const root = parts.root ?? REPO_ROOT_URI;
	const uris = parts.uris ?? (parts.files ?? []).map((file) => vscode.Uri.joinPath(root, file));
	const changes: Change[] = uris.map((uri) => ({ uri, status: 5 }));
	const diffWith = ((_ref: string, filePath?: string) => {
		if (filePath === undefined) {
			return parts.enumerate?.() ?? Promise.resolve(changes);
		}
		return Promise.resolve(oneHunkDiff(filePath));
	}) as Repository["diffWith"];
	return {
		rootUri: root,
		inputBox: { value: "" },
		state: {
			indexChanges: [],
			workingTreeChanges: [],
			untrackedChanges: [],
			// No commit means no HEAD at all here: the repository state has not
			// loaded yet. An unborn branch is the other commitless shape - HEAD
			// present with a name - and unbornRepo builds it.
			HEAD: parts.head === undefined ? undefined : { name: "main", commit: parts.head },
		},
		diff: () => Promise.resolve(""),
		diffWith,
		// Declared by the vendored API subset; the review flow never calls these.
		getBranch: () => Promise.reject(new Error("not used by review comments")),
		getBranchBase: () => Promise.resolve(undefined),
		getMergeBase: () => Promise.resolve(undefined),
		log: () => Promise.resolve([]),
	};
}

/**
 * A repository that has no commits yet. Both halves mirror the real vscode.git:
 * `git diff HEAD` exits 128 there ("fatal: bad revision 'HEAD'") and the
 * extension's exec rejects on any nonzero exit, so diffWith throws rather than
 * reporting a clean tree; and HEAD is present but commitless, because upstream
 * builds it from `.git/HEAD` (giving the branch name) before resolving the ref,
 * and the resolve is what fails on an unborn branch. Distinct from a repository
 * whose state has not loaded, which has no HEAD at all.
 */
function unbornRepo(): Repository {
	return {
		...fakeRepo({ enumerate: () => Promise.reject(new Error("fatal: bad revision 'HEAD'")) }),
		state: { indexChanges: [], workingTreeChanges: [], untrackedChanges: [], HEAD: { name: "main" } },
	};
}

function fakeGit(repo: Repository): API {
	return { repositories: [repo] };
}

suite("extension/features/reviewComments commands", () => {
	useMsw();

	/** One scratch directory per suite run; openActive puts its files here. */
	const scratchRoot = vscode.Uri.file(path.join(os.tmpdir(), `lvt-review-cmd-${process.pid}-${Date.now()}`));
	let scratchCount = 0;

	suiteSetup(async () => {
		await vscode.workspace.fs.createDirectory(scratchRoot);
	});

	suiteTeardown(async () => {
		await vscode.workspace.fs.delete(scratchRoot, { recursive: true, useTrash: false });
	});

	const shown: { level: string; message: string }[] = [];
	let saved: ReviewThreadsByUri[] = [];
	let controller: ReviewCommentController | undefined;
	let deps: ReviewCommandDeps;
	let originals: Record<string, unknown> = {};

	setup(() => {
		shown.length = 0;
		saved = [];
		controller = undefined;
		const record = (level: string) => (message: string) => {
			shown.push({ level, message });
			return Promise.resolve(undefined);
		};
		originals = {
			info: vscode.window.showInformationMessage,
			warn: vscode.window.showWarningMessage,
			error: vscode.window.showErrorMessage,
		};
		(vscode.window as Record<string, unknown>).showInformationMessage = record("info");
		(vscode.window as Record<string, unknown>).showWarningMessage = record("warning");
		(vscode.window as Record<string, unknown>).showErrorMessage = record("error");
		deps = {
			oneShot: new OneShotClient({ userAgent: "test-agent" }),
			secrets: fakeSecrets(),
			logger: makeLogger().logger,
			outputChannel: { show: () => {}, appendLine: () => {} } as unknown as vscode.OutputChannel,
			controller: () => controller,
		};
	});

	teardown(() => {
		controller?.dispose();
		(vscode.window as Record<string, unknown>).showInformationMessage = originals.info;
		(vscode.window as Record<string, unknown>).showWarningMessage = originals.warn;
		(vscode.window as Record<string, unknown>).showErrorMessage = originals.error;
	});

	/** A live controller over the recording double, saving into `saved`. */
	function liveController(): ReviewCommentController {
		controller = new ReviewCommentController((threads) => {
			saved.push(threads);
		});
		return controller;
	}

	/**
	 * Write a real file, open it, and make it the active editor - which is what
	 * runReviewFile reviews. A real file rather than an untitled buffer because
	 * the command refuses anything with no stable identity to store threads
	 * under, and these tests are about what it does with a reviewable one.
	 */
	async function openActive(content: string): Promise<vscode.TextDocument> {
		const uri = vscode.Uri.joinPath(scratchRoot, `file-${scratchCount++}.ts`);
		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
		const document = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(document, { preview: true });
		return document;
	}

	test("disabled: the enable hint, zero traffic", async () => {
		// No msw handler is registered for the chat URL, so any request would fail
		// the suite through onUnhandledRequest: "error".
		await withCommentSpies(async () => {
			liveController();
			await withConfig({ ...ENABLED_CONFIG, "reviewComments.enabled": false }, () => runReviewFile(deps));
			assert.strictEqual(shown.length, 1);
			assert.strictEqual(shown[0]?.level, "info");
			assert.ok(shown[0]?.message.includes("litellm-vscode-chat.reviewComments.enabled"));
		});
	});

	test("enabled but with no controller answers the same way, never half-registered", async () => {
		await withCommentSpies(async () => {
			await withConfig(ENABLED_CONFIG, () => runReviewFile(deps));
			assert.strictEqual(shown[0]?.level, "info");
			assert.ok(shown[0]?.message.includes("litellm-vscode-chat.reviewComments.enabled"));
		});
	});

	test("enabled without a model: the model hint, zero traffic", async () => {
		await withCommentSpies(async () => {
			liveController();
			await withConfig({ ...ENABLED_CONFIG, "reviewComments.model": null }, () => runReviewFile(deps));
			assert.strictEqual(shown.length, 1);
			assert.strictEqual(shown[0]?.level, "warning");
			assert.ok(shown[0]?.message.includes("litellm-vscode-chat.reviewComments.model"));
		});
	});

	test("a whole-file review anchors one thread per finding, 0-based, with the model as author", async () => {
		mswServer.use(http.post(CHAT_COMPLETIONS_URL, () => chatReply("LINE 2: unchecked cast\nLINE 3-4: leaks a handle")));
		await withCommentSpies(async (spies) => {
			liveController();
			await openActive("one\ntwo\nthree\nfour\nfive");
			await withConfig(ENABLED_CONFIG, () => runReviewFile(deps));

			const threads = liveThreads(spies.controllers[0] as FakeController);
			assert.strictEqual(threads.length, 2);
			// The model answers in 1-based lines; VS Code ranges are 0-based.
			assert.strictEqual(threads[0]?.range?.start.line, 1);
			assert.strictEqual(threads[1]?.range?.start.line, 2);
			assert.strictEqual(threads[1]?.range?.end.line, 3);
			assert.strictEqual(threads[0]?.comments[0]?.body, "unchecked cast");
			assert.strictEqual(threads[0]?.comments[0]?.author.name, "LiteLLM");
			assert.strictEqual(threads[0]?.contextValue, "unresolved");
			assert.ok(shown.at(-1)?.message.includes("2"), "the notice counts the comments");
		});
	});

	test("the review request sends exactly the provider-owned keys, and the prompt is the file's", async () => {
		let body: Record<string, unknown> | undefined;
		mswServer.use(
			http.post(CHAT_COMPLETIONS_URL, async ({ request }) => {
				body = (await request.json()) as Record<string, unknown>;
				return chatReply("NO FINDINGS");
			})
		);
		await withCommentSpies(async () => {
			liveController();
			await openActive("const x: any = 1;");
			await withConfig(ENABLED_CONFIG, () => runReviewFile(deps));
		});
		assert.ok(body);
		assert.deepStrictEqual(Object.keys(body).sort(), ["messages", "model", "stream"]);
		assert.strictEqual(body.model, "gpt-test");
		const messages = body.messages as { role: string; content: string }[];
		assert.strictEqual(messages.length, 1);
		assert.strictEqual(messages[0]?.role, "user");
		assert.ok(messages[0]?.content.includes("1: const x: any = 1;"), "the file rides line-numbered");
	});

	test("a clean answer replaces the previous review instead of stacking a second one", async () => {
		await withCommentSpies(async (spies) => {
			liveController();
			const document = await openActive("one\ntwo\nthree");
			mswServer.use(http.post(CHAT_COMPLETIONS_URL, () => chatReply("LINE 2: unchecked cast")));
			await withConfig(ENABLED_CONFIG, () => runReviewFile(deps));
			assert.strictEqual(liveThreads(spies.controllers[0] as FakeController).length, 1);

			mswServer.use(http.post(CHAT_COMPLETIONS_URL, () => chatReply("NO FINDINGS")));
			await withConfig(ENABLED_CONFIG, () => runReviewFile(deps));
			assert.strictEqual(
				liveThreads(spies.controllers[0] as FakeController).length,
				0,
				"a file that now reads clean loses its old comments"
			);
			assert.strictEqual(document.lineCount, 3);
			assert.ok(shown.at(-1)?.message.includes("nothing to report"));
		});
	});

	test("an empty file is not sent for review at all", async () => {
		await withCommentSpies(async () => {
			liveController();
			await openActive("   \n\n");
			await withConfig(ENABLED_CONFIG, () => runReviewFile(deps));
			assert.ok(shown.at(-1)?.message.includes("nothing in this file"));
		});
	});

	test("a reply lands the user's words first, then the model's, by reassigning the array", async () => {
		mswServer.use(http.post(CHAT_COMPLETIONS_URL, () => chatReply("You are right, values.length is the count.")));
		await withCommentSpies(async (spies) => {
			const live = liveController();
			const uri = vscode.Uri.parse("file:///workspace/a.ts");
			live.replaceFileThreads(uri, [{ startLine: 1, endLine: 1, body: "reads past the end" }]);
			const thread = liveThreads(spies.controllers[0] as FakeController)[0];
			assert.ok(thread !== undefined);
			const beforeReply = thread.comments;

			await withConfig(ENABLED_CONFIG, () =>
				runReviewReply(deps, { thread: thread as unknown as vscode.CommentThread, text: "  Does it?  " })
			);

			assert.notStrictEqual(thread.comments, beforeReply, "the readonly array is replaced, never mutated");
			assert.deepStrictEqual(
				thread.comments.map((comment) => [comment.author.name, comment.body]),
				[
					["LiteLLM", "reads past the end"],
					["You", "Does it?"],
					["LiteLLM", "You are right, values.length is the count."],
				]
			);
		});
	});

	test("the reply request replays the thread as turns and quotes the anchored line", async () => {
		let body: Record<string, unknown> | undefined;
		mswServer.use(
			http.post(CHAT_COMPLETIONS_URL, async ({ request }) => {
				body = (await request.json()) as Record<string, unknown>;
				return chatReply("Fair point.");
			})
		);
		await withCommentSpies(async (spies) => {
			const live = liveController();
			const document = await openActive("alpha\nbeta\ngamma");
			live.replaceFileThreads(document.uri, [{ startLine: 2, endLine: 2, body: "beta is unused" }]);
			const thread = liveThreads(spies.controllers[0] as FakeController)[0];
			assert.ok(thread !== undefined);
			await withConfig(ENABLED_CONFIG, () =>
				runReviewReply(deps, { thread: thread as unknown as vscode.CommentThread, text: "It is used below." })
			);
		});
		assert.ok(body);
		const messages = body.messages as { role: string; content: string }[];
		assert.deepStrictEqual(
			messages.map((message) => message.role),
			["system", "assistant", "user"]
		);
		assert.ok(messages[0]?.content.includes("2: beta"), "the anchored line is quoted back");
		assert.strictEqual(messages[1]?.content, "beta is unused");
		assert.strictEqual(messages[2]?.content, "It is used below.");
	});

	test("an empty reply sends nothing and appends nothing", async () => {
		await withCommentSpies(async (spies) => {
			const live = liveController();
			live.replaceFileThreads(vscode.Uri.parse("file:///workspace/a.ts"), [
				{ startLine: 1, endLine: 1, body: "a finding" },
			]);
			const thread = liveThreads(spies.controllers[0] as FakeController)[0];
			assert.ok(thread !== undefined);
			await withConfig(ENABLED_CONFIG, () =>
				runReviewReply(deps, { thread: thread as unknown as vscode.CommentThread, text: "   " })
			);
			assert.strictEqual(thread.comments.length, 1);
		});
	});

	test("a failed reply keeps the user's comment rather than discarding what they typed", async () => {
		mswServer.use(
			http.post(CHAT_COMPLETIONS_URL, () => HttpResponse.json({ error: { message: "nope" } }, { status: 500 }))
		);
		await withCommentSpies(async (spies) => {
			const live = liveController();
			live.replaceFileThreads(vscode.Uri.parse("file:///workspace/a.ts"), [
				{ startLine: 1, endLine: 1, body: "a finding" },
			]);
			const thread = liveThreads(spies.controllers[0] as FakeController)[0];
			assert.ok(thread !== undefined);
			await withConfig(ENABLED_CONFIG, () =>
				runReviewReply(deps, { thread: thread as unknown as vscode.CommentThread, text: "why?" })
			);
			assert.deepStrictEqual(
				thread.comments.map((comment) => comment.body),
				["a finding", "why?"]
			);
			assert.strictEqual(shown.at(-1)?.level, "error");
		});
	});

	test("resolve, unresolve, and delete move the host state, the contextValue, and the store together", async () => {
		await withCommentSpies(async (spies) => {
			const live = liveController();
			live.replaceFileThreads(vscode.Uri.parse("file:///workspace/a.ts"), [
				{ startLine: 1, endLine: 1, body: "a finding" },
			]);
			const thread = liveThreads(spies.controllers[0] as FakeController)[0];
			assert.ok(thread !== undefined);
			const hostThread = thread as unknown as vscode.CommentThread;

			setThreadResolved(deps, hostThread, true);
			assert.strictEqual(thread.state, vscode.CommentThreadState.Resolved);
			assert.strictEqual(thread.contextValue, "resolved");
			assert.strictEqual(Object.values(saved.at(-1) ?? {})[0]?.[0]?.resolved, true);

			setThreadResolved(deps, hostThread, false);
			assert.strictEqual(thread.contextValue, "unresolved");

			deleteReviewThread(deps, hostThread);
			assert.strictEqual(thread.disposed, true);
			assert.deepStrictEqual(saved.at(-1), {}, "the last save no longer carries the deleted thread");
		});
	});

	test("a git extension that fails to activate reports through the command's own failure boundary", async () => {
		// The activation await sits outside withProgress; an escaped rejection
		// would leave the command silently dead instead of saying anything.
		await withCommentSpies(async () => {
			liveController();
			await withConfig(ENABLED_CONFIG, () =>
				runReviewChanges({ ...deps, resolveGit: () => Promise.reject(new Error("activation exploded")) }, undefined)
			);
			assert.strictEqual(shown.at(-1)?.level, "error");
		});
	});

	test("a thread the USER started from the gutter is adopted, not silently swallowed", async () => {
		// The host creates that thread itself, so it reaches the reply command
		// unindexed. Without adoption the user's question would vanish.
		mswServer.use(http.post(CHAT_COMPLETIONS_URL, () => chatReply("Because the index runs one past the end.")));
		await withCommentSpies(async (spies) => {
			liveController();
			const document = await openActive("alpha\nbeta\ngamma");
			const hostThread = spies.controllers[0]?.createHostThread(document.uri, new vscode.Range(1, 0, 1, 0));
			assert.ok(hostThread !== undefined);

			await withConfig(ENABLED_CONFIG, () =>
				runReviewReply(deps, {
					thread: hostThread as unknown as vscode.CommentThread,
					text: "Why is this wrong?",
				})
			);

			assert.deepStrictEqual(
				hostThread.comments.map((comment) => [comment.author.name, comment.body]),
				[
					["You", "Why is this wrong?"],
					["LiteLLM", "Because the index runs one past the end."],
				]
			);
			assert.strictEqual(hostThread.contextValue, "unresolved", "an adopted thread joins the resolve menus");
			// And it persists like any other thread, so it survives a reload.
			assert.deepStrictEqual(Object.keys(saved.at(-1) ?? {}), [document.uri.toString()]);
		});
	});

	test("another thread's persist does not bank an adopted thread the user has not written in yet", async () => {
		// adopt() indexes the thread before any comment lands; a persist from
		// elsewhere in that window must omit it - and its URI entirely - or the
		// store banks a comments:[] thread that rehydrates as an empty widget.
		await withCommentSpies(async (spies) => {
			const live = liveController();
			const reviewedUri = vscode.Uri.parse("file:///workspace/a.ts");
			live.replaceFileThreads(reviewedUri, [{ startLine: 1, endLine: 1, body: "a finding" }]);
			const modelThread = liveThreads(spies.controllers[0] as FakeController)[0];
			assert.ok(modelThread !== undefined);
			const adoptedUri = vscode.Uri.parse("file:///workspace/b.ts");
			const hostThread = spies.controllers[0]?.createHostThread(adoptedUri, new vscode.Range(2, 0, 2, 0));
			assert.ok(hostThread !== undefined);
			assert.strictEqual(live.adopt(hostThread as unknown as vscode.CommentThread), true);

			live.setResolved(modelThread as unknown as vscode.CommentThread, true);
			assert.deepStrictEqual(
				Object.keys(saved.at(-1) ?? {}),
				[reviewedUri.toString()],
				"the adopted thread's URI is omitted entirely, not banked as an empty entry"
			);

			live.appendComment(hostThread as unknown as vscode.CommentThread, "user", "Why is this wrong?");
			const banked = saved.at(-1)?.[adoptedUri.toString()];
			assert.strictEqual(banked?.length, 1, "once the user's words land, the thread persists like any other");
			assert.strictEqual(banked?.[0]?.comments[0]?.body, "Why is this wrong?");
		});
	});

	test("a review landing after the feature was disabled writes nothing at all", async () => {
		// The dangerous shape: the callback still holds the controller, so an
		// unguarded apply would save an emptied snapshot over the whole store.
		let release: (() => void) | undefined;
		mswServer.use(
			http.post(CHAT_COMPLETIONS_URL, async () => {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return chatReply("LINE 1: too late");
			})
		);
		await withCommentSpies(async (spies) => {
			const live = liveController();
			live.replaceFileThreads(vscode.Uri.parse("file:///workspace/earlier.ts"), [
				{ startLine: 1, endLine: 1, body: "an earlier finding" },
			]);
			await openActive("alpha\nbeta");
			const pending = withConfig(ENABLED_CONFIG, () => runReviewFile(deps));
			for (let attempt = 0; attempt < 100 && release === undefined; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			const writesBefore = saved.length;
			const shownBefore = shown.length;
			live.dispose();
			release?.();
			await pending;

			assert.strictEqual(saved.length, writesBefore, "a disposed controller must not persist anything");
			assert.strictEqual(shown.length, shownBefore, "and the run ends silently rather than reporting a result");
			assert.strictEqual(liveThreads(spies.controllers[0] as FakeController).length, 0);
		});
	});

	test("a file edited while its review was in flight keeps its old comments and says so", async () => {
		let release: (() => void) | undefined;
		mswServer.use(
			http.post(CHAT_COMPLETIONS_URL, async () => {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return chatReply("LINE 2: stale finding");
			})
		);
		await withCommentSpies(async (spies) => {
			liveController();
			const document = await openActive("alpha\nbeta\ngamma");
			const pending = withConfig(ENABLED_CONFIG, () => runReviewFile(deps));
			for (let attempt = 0; attempt < 100 && release === undefined; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			// The document moves under the request: the answer describes a revision
			// that no longer exists, so anchoring it would land on the wrong lines.
			const edit = new vscode.WorkspaceEdit();
			edit.insert(document.uri, new vscode.Position(0, 0), "inserted\n");
			await vscode.workspace.applyEdit(edit);
			release?.();
			await pending;

			assert.strictEqual(liveThreads(spies.controllers[0] as FakeController).length, 0, "nothing was anchored");
			assert.ok(shown.at(-1)?.message.includes("changed while"), shown.at(-1)?.message ?? "no notice shown");
		});
	});

	test("an answer that is not a review keeps the file's earlier comments instead of clearing them", async () => {
		await withCommentSpies(async (spies) => {
			liveController();
			await openActive("alpha\nbeta\ngamma");
			mswServer.use(http.post(CHAT_COMPLETIONS_URL, () => chatReply("LINE 2: beta is unused")));
			await withConfig(ENABLED_CONFIG, () => runReviewFile(deps));
			assert.strictEqual(liveThreads(spies.controllers[0] as FakeController).length, 1);

			mswServer.use(http.post(CHAT_COMPLETIONS_URL, () => chatReply("Sure! Happy to help with that.")));
			await withConfig(ENABLED_CONFIG, () => runReviewFile(deps));
			assert.strictEqual(
				liveThreads(spies.controllers[0] as FakeController).length,
				1,
				"prose is not a clean bill of health"
			);
			assert.ok(shown.at(-1)?.message.includes("no readable review"), shown.at(-1)?.message ?? "no notice shown");
		});
	});

	test("re-reviewing a file keeps the threads the user has spoken in and replaces only the model's", async () => {
		mswServer.use(http.post(CHAT_COMPLETIONS_URL, () => chatReply("LINE 1: first pass")));
		await withCommentSpies(async (spies) => {
			liveController();
			const document = await openActive("alpha\nbeta\ngamma");
			await withConfig(ENABLED_CONFIG, () => runReviewFile(deps));
			const modelThread = liveThreads(spies.controllers[0] as FakeController)[0];
			assert.ok(modelThread !== undefined);
			// The user answers that finding, which makes the thread theirs too.
			mswServer.use(http.post(CHAT_COMPLETIONS_URL, () => chatReply("Fair enough.")));
			await withConfig(ENABLED_CONFIG, () =>
				runReviewReply(deps, { thread: modelThread as unknown as vscode.CommentThread, text: "Are you sure?" })
			);
			// And starts a question of their own elsewhere in the file.
			const ownThread = spies.controllers[0]?.createHostThread(document.uri, new vscode.Range(2, 0, 2, 0));
			assert.ok(ownThread !== undefined);
			mswServer.use(http.post(CHAT_COMPLETIONS_URL, () => chatReply("Because of the cast.")));
			await withConfig(ENABLED_CONFIG, () =>
				runReviewReply(deps, { thread: ownThread as unknown as vscode.CommentThread, text: "What about this?" })
			);

			mswServer.use(http.post(CHAT_COMPLETIONS_URL, () => chatReply("LINE 2: second pass")));
			await withConfig(ENABLED_CONFIG, () => runReviewFile(deps));

			assert.strictEqual(modelThread.disposed, false, "a thread the user replied in is theirs, not the run's");
			assert.strictEqual(ownThread.disposed, false, "a thread the user started is theirs too");
			assert.ok(
				modelThread.comments.some((comment) => comment.body === "Are you sure?"),
				"the user's reply survived the second pass"
			);
			assert.ok(
				ownThread.comments.some((comment) => comment.body === "What about this?"),
				"the user's own question survived it"
			);
			const controllerThreads = liveThreads(spies.controllers[0] as FakeController);
			const bodies = controllerThreads.flatMap((thread) => thread.comments.map((comment) => comment.body));
			assert.ok(bodies.includes("second pass"), "and the fresh finding landed");
			// The first pass's finding is still there because the user replied to
			// it - that thread became theirs. What was replaced is the model-only
			// set, so the second pass added exactly one thread rather than stacking.
			assert.strictEqual(controllerThreads.length, 2, "one kept user thread plus one fresh finding");
		});
	});

	test("a repository with no commits yet names that reason rather than claiming a clean tree", async () => {
		// Whatever is staged there is the first commit's content, which a
		// comparison against HEAD cannot describe.
		await withCommentSpies(async () => {
			liveController();
			await withConfig(ENABLED_CONFIG, () =>
				runReviewChanges({ ...deps, resolveGit: () => Promise.resolve(fakeGit(unbornRepo())) }, undefined)
			);
			assert.strictEqual(shown.at(-1)?.level, "info");
			assert.ok(shown.at(-1)?.message.includes("no commits yet"), shown.at(-1)?.message ?? "");
		});
	});

	test("a real git failure reaches the error boundary rather than reading as a clean tree", async () => {
		await withCommentSpies(async () => {
			liveController();
			const repo = fakeRepo({ head: "abc123", enumerate: () => Promise.reject(new Error("git exploded")) });
			await withConfig(ENABLED_CONFIG, () =>
				runReviewChanges({ ...deps, resolveGit: () => Promise.resolve(fakeGit(repo)) }, undefined)
			);
			assert.strictEqual(shown.at(-1)?.level, "error");
		});
	});

	test("changed files become one request each, capped, with the rest counted as left out", async () => {
		const prompts: string[] = [];
		mswServer.use(
			http.post(CHAT_COMPLETIONS_URL, async ({ request }) => {
				const body = (await request.json()) as { messages: { content: string }[] };
				prompts.push(body.messages[0]?.content ?? "");
				return chatReply("NO FINDINGS");
			})
		);
		// Real files: diffUnits opens each changed document, so a fake path would
		// simply be skipped and the cap would never be reached.
		const root = vscode.Uri.file(path.join(os.tmpdir(), `lvt-review-cap-${process.pid}-${Date.now()}`));
		await vscode.workspace.fs.createDirectory(root);
		const uris: vscode.Uri[] = [];
		for (let index = 0; index < REVIEW_FILE_LIMIT + 3; index += 1) {
			const uri = vscode.Uri.joinPath(root, `file-${index}.ts`);
			await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode("alpha\nadded\n"));
			uris.push(uri);
		}
		try {
			await withCommentSpies(async () => {
				liveController();
				const repo = fakeRepo({ head: "abc123", uris, root });
				await withConfig(ENABLED_CONFIG, () =>
					runReviewChanges({ ...deps, resolveGit: () => Promise.resolve(fakeGit(repo)) }, undefined)
				);
				assert.strictEqual(prompts.length, REVIEW_FILE_LIMIT, "the cap bounds the requests");
				assert.ok(prompts[0]?.includes("Working tree diff of file-0.ts:"), prompts[0] ?? "no prompt sent");
				assert.ok(shown.at(-1)?.message.includes("3 more files were left out"), shown.at(-1)?.message ?? "");
			});
		} finally {
			await vscode.workspace.fs.delete(root, { recursive: true, useTrash: false });
		}
	});

	test("a file with unsaved changes is not diff-reviewed, and the notice says to save it", async () => {
		// The diff comes from disk while the comments would anchor into the
		// buffer: the model would describe one revision and the comments land on
		// another.
		await withCommentSpies(async () => {
			liveController();
			const document = await openActive("alpha\nbeta");
			const edit = new vscode.WorkspaceEdit();
			edit.insert(document.uri, new vscode.Position(0, 0), "unsaved\n");
			await vscode.workspace.applyEdit(edit);
			assert.strictEqual(document.isDirty, true);
			const repo = fakeRepo({ head: "abc123", uris: [document.uri] });
			await withConfig(ENABLED_CONFIG, () =>
				runReviewChanges({ ...deps, resolveGit: () => Promise.resolve(fakeGit(repo)) }, undefined)
			);
			assert.ok(shown.at(-1)?.message.includes("unsaved changes"), shown.at(-1)?.message ?? "");
		});
	});

	test("cancelling while the changes are still being enumerated announces nothing at all", async () => {
		// The branch that would otherwise say "There are no uncommitted changes to
		// review" for a run the user deliberately stopped.
		await withCommentSpies(async () => {
			liveController();
			const originalWithProgress = vscode.window.withProgress;
			(vscode.window as Record<string, unknown>).withProgress = (
				_options: unknown,
				task: (progress: unknown, token: vscode.CancellationToken) => Promise<unknown>
			) => {
				const source = new vscode.CancellationTokenSource();
				source.cancel();
				return task({ report: () => {} }, source.token);
			};
			try {
				const repo = fakeRepo({ head: "abc123", files: ["a.ts"] });
				const shownBefore = shown.length;
				await withConfig(ENABLED_CONFIG, () =>
					runReviewChanges({ ...deps, resolveGit: () => Promise.resolve(fakeGit(repo)) }, undefined)
				);
				assert.strictEqual(shown.length, shownBefore, "a cancelled run says nothing");
			} finally {
				(vscode.window as Record<string, unknown>).withProgress = originalWithProgress;
			}
		});
	});

	test("a second reply typed while the first is in flight waits its turn, in order", async () => {
		// Appending it immediately would put the user's second question ABOVE the
		// answer to their first, and that out-of-order thread is what gets
		// replayed to the model on the next turn.
		const release: (() => void)[] = [];
		let requests = 0;
		mswServer.use(
			http.post(CHAT_COMPLETIONS_URL, async () => {
				requests += 1;
				const answer = `answer ${requests}`;
				await new Promise<void>((resolve) => {
					release.push(resolve);
				});
				return chatReply(answer);
			})
		);
		await withCommentSpies(async (spies) => {
			const live = liveController();
			live.replaceFileThreads(vscode.Uri.parse("file:///workspace/a.ts"), [
				{ startLine: 1, endLine: 1, body: "a finding" },
			]);
			const thread = liveThreads(spies.controllers[0] as FakeController)[0];
			assert.ok(thread !== undefined);
			const hostThread = thread as unknown as vscode.CommentThread;

			// ONE withConfig around both: the second reply resolves its model after
			// the first settles, so a per-call scope would restore the settings out
			// from under the queued turn.
			await withConfig(ENABLED_CONFIG, async () => {
				const first = runReviewReply(deps, { thread: hostThread, text: "first" });
				for (let attempt = 0; attempt < 100 && release.length === 0; attempt += 1) {
					await new Promise((resolve) => setTimeout(resolve, 5));
				}
				const second = runReviewReply(deps, { thread: hostThread, text: "second" });
				// The queued reply has not touched the thread yet: its words wait with it.
				assert.deepStrictEqual(
					thread.comments.map((comment) => comment.body),
					["a finding", "first"],
					"the queued turn does not jump ahead of the answer it would follow"
				);
				release[0]?.();
				for (let attempt = 0; attempt < 100 && release.length < 2; attempt += 1) {
					await new Promise((resolve) => setTimeout(resolve, 5));
				}
				release[1]?.();
				await Promise.all([first, second]);
			});

			assert.strictEqual(requests, 2, "both replies asked, one after the other");
			assert.deepStrictEqual(
				thread.comments.map((comment) => comment.body),
				["a finding", "first", "answer 1", "second", "answer 2"],
				"question, answer, question, answer"
			);
		});
	});

	test("an undismissed notification from one reply cannot block the next one in that thread", async () => {
		// The queue's tail must cover the THREAD WORK only. A notification promise
		// settles when the user dismisses it, so awaiting one inside the queued
		// section would let an ignored toast wedge the thread forever - and the
		// suite's other tests would not notice, because their stubs resolve at
		// once. This one never settles.
		(vscode.window as Record<string, unknown>).showWarningMessage = (message: string) => {
			shown.push({ level: "warning", message });
			// Never settles: the toast is on screen and nobody touches it.
			return new Promise<undefined>(() => {});
		};
		// The first reply gets an empty answer, which is a warning notification.
		mswServer.use(http.post(CHAT_COMPLETIONS_URL, () => chatReply("   ")));
		await withCommentSpies(async (spies) => {
			const live = liveController();
			live.replaceFileThreads(vscode.Uri.parse("file:///workspace/a.ts"), [
				{ startLine: 1, endLine: 1, body: "a finding" },
			]);
			const thread = liveThreads(spies.controllers[0] as FakeController)[0];
			assert.ok(thread !== undefined);
			const hostThread = thread as unknown as vscode.CommentThread;

			await withConfig(ENABLED_CONFIG, async () => {
				// Deliberately NOT awaited: its notification never settles.
				void runReviewReply(deps, { thread: hostThread, text: "first" });
				for (let attempt = 0; attempt < 100 && shown.length === 0; attempt += 1) {
					await new Promise((resolve) => setTimeout(resolve, 5));
				}
				assert.strictEqual(shown.length, 1, "the first reply reached its warning");

				mswServer.use(http.post(CHAT_COMPLETIONS_URL, () => chatReply("A real answer.")));
				// This resolves only if the tail was released before that warning.
				await runReviewReply(deps, { thread: hostThread, text: "second" });
			});

			assert.deepStrictEqual(
				thread.comments.map((comment) => comment.body),
				["a finding", "first", "second", "A real answer."],
				"the second reply ran to completion behind the undismissed toast"
			);
		});
	});

	test("an undismissed no-model warning cannot block the next reply either", async () => {
		// The other notification inside the queued section. Same rule, different
		// path: the advice is handed back as a thunk, not awaited in the tail.
		(vscode.window as Record<string, unknown>).showWarningMessage = (message: string) => {
			shown.push({ level: "warning", message });
			return new Promise<undefined>(() => {});
		};
		await withCommentSpies(async (spies) => {
			const live = liveController();
			live.replaceFileThreads(vscode.Uri.parse("file:///workspace/a.ts"), [
				{ startLine: 1, endLine: 1, body: "a finding" },
			]);
			const thread = liveThreads(spies.controllers[0] as FakeController)[0];
			assert.ok(thread !== undefined);
			const hostThread = thread as unknown as vscode.CommentThread;

			await withConfig({ ...ENABLED_CONFIG, "reviewComments.model": null }, async () => {
				// NEITHER is awaited: each ends by showing its own warning, and those
				// never settle. What must still happen is the SECOND turn's append -
				// it only runs once the first released the thread's queue.
				void runReviewReply(deps, { thread: hostThread, text: "first" });
				for (let attempt = 0; attempt < 100 && shown.length === 0; attempt += 1) {
					await new Promise((resolve) => setTimeout(resolve, 5));
				}
				assert.strictEqual(shown.length, 1, "the first reply reached its warning");
				void runReviewReply(deps, { thread: hostThread, text: "second" });
				for (let attempt = 0; attempt < 100 && thread.comments.length < 3; attempt += 1) {
					await new Promise((resolve) => setTimeout(resolve, 5));
				}
			});

			assert.deepStrictEqual(
				thread.comments.map((comment) => comment.body),
				["a finding", "first", "second"],
				"both replies were banked; only their answers are missing"
			);
		});
	});

	test("a reply typed with no model configured keeps the user's words and only misses the answer", async () => {
		// VS Code closes the reply editor on submit either way, so refusing before
		// the append would silently throw away what they wrote.
		await withCommentSpies(async (spies) => {
			const live = liveController();
			live.replaceFileThreads(vscode.Uri.parse("file:///workspace/a.ts"), [
				{ startLine: 1, endLine: 1, body: "a finding" },
			]);
			const thread = liveThreads(spies.controllers[0] as FakeController)[0];
			assert.ok(thread !== undefined);
			await withConfig({ ...ENABLED_CONFIG, "reviewComments.model": null }, () =>
				runReviewReply(deps, { thread: thread as unknown as vscode.CommentThread, text: "why?" })
			);
			assert.deepStrictEqual(
				thread.comments.map((comment) => comment.body),
				["a finding", "why?"],
				"the reply is banked before the model question"
			);
			assert.strictEqual(shown.at(-1)?.level, "warning");
			assert.ok(shown.at(-1)?.message.includes("litellm-vscode-chat.reviewComments.model"));
		});
	});

	test("disabling the feature stops a multi-file run even when the answers are unusable", async () => {
		// An unusable answer never reaches applyFindings, which is the other place
		// disposal is noticed; without the loop's own check the run would keep
		// sending files for a feature that is off.
		let requests = 0;
		let release: (() => void) | undefined;
		mswServer.use(
			http.post(CHAT_COMPLETIONS_URL, async () => {
				requests += 1;
				if (requests === 1) {
					await new Promise<void>((resolve) => {
						release = resolve;
					});
				}
				// Prose, not a review: the unusable path.
				return chatReply("Looks fine to me.");
			})
		);
		const root = vscode.Uri.file(path.join(os.tmpdir(), `lvt-review-stop-${process.pid}-${Date.now()}`));
		await vscode.workspace.fs.createDirectory(root);
		const uris: vscode.Uri[] = [];
		for (const name of ["one.ts", "two.ts", "three.ts"]) {
			const uri = vscode.Uri.joinPath(root, name);
			await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode("alpha\nadded\n"));
			uris.push(uri);
		}
		try {
			await withCommentSpies(async () => {
				const live = liveController();
				const repo = fakeRepo({ head: "abc123", uris, root });
				const pending = withConfig(ENABLED_CONFIG, () =>
					runReviewChanges({ ...deps, resolveGit: () => Promise.resolve(fakeGit(repo)) }, undefined)
				);
				for (let attempt = 0; attempt < 100 && release === undefined; attempt += 1) {
					await new Promise((resolve) => setTimeout(resolve, 5));
				}
				const shownBefore = shown.length;
				live.dispose();
				release?.();
				await pending;

				assert.strictEqual(requests, 1, "the run stopped instead of walking the remaining files");
				assert.strictEqual(shown.length, shownBefore, "and it ended silently");
			});
		} finally {
			await vscode.workspace.fs.delete(root, { recursive: true, useTrash: false });
		}
	});

	test("a git failure while the repository state is still loading is not mistaken for an unborn branch", async () => {
		// HEAD absent means "not loaded yet", which proves nothing about why the
		// diff failed; only HEAD-without-a-commit is an unborn branch.
		await withCommentSpies(async () => {
			liveController();
			const repo = fakeRepo({ enumerate: () => Promise.reject(new Error("git exploded")) });
			await withConfig(ENABLED_CONFIG, () =>
				runReviewChanges({ ...deps, resolveGit: () => Promise.resolve(fakeGit(repo)) }, undefined)
			);
			assert.strictEqual(shown.at(-1)?.level, "error", "it reaches the error boundary, not the unborn branch");
		});
	});

	test("a model ref naming no entry throws the feature's classified error, zero traffic", async () => {
		await withCommentSpies(async () => {
			await withConfig({ ...ENABLED_CONFIG, servers: [] }, () =>
				assert.rejects(
					sendReviewMessages(
						deps,
						{ server: "alpha", model: "gpt-test" },
						[{ role: "user", content: "prompt" }],
						new vscode.CancellationTokenSource().token,
						() => {}
					),
					(error: unknown) => {
						assert.ok(error instanceof MirroredError);
						assert.strictEqual(error.logClassification, "ReviewComments(configured server label matches no entry)");
						return true;
					}
				)
			);
		});
	});

	test("no repository to review answers with advice, never an error", async () => {
		await withCommentSpies(async () => {
			liveController();
			await withConfig(ENABLED_CONFIG, () =>
				runReviewChanges({ ...deps, resolveGit: () => Promise.resolve({ repositories: [] }) }, undefined)
			);
			assert.strictEqual(shown.at(-1)?.level, "info");
			assert.ok(shown.at(-1)?.message.includes("Git repository"));
		});
	});

	test("an unavailable Git extension answers with advice, never an error", async () => {
		await withCommentSpies(async () => {
			liveController();
			await withConfig(ENABLED_CONFIG, () =>
				runReviewChanges({ ...deps, resolveGit: () => Promise.resolve(undefined) }, undefined)
			);
			assert.strictEqual(shown.at(-1)?.level, "warning");
			assert.ok(shown.at(-1)?.message.includes("Git extension is unavailable"));
		});
	});
});
