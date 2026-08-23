/**
 * The generate-pull-request-description command: every outcome the local
 * branch walk can produce, mapped to advice rather than to an error, and the
 * generated draft landing on the clipboard. The send is injected, so this
 * suite pins the command's own behavior without a wire.
 */
import * as assert from "node:assert";
import * as vscode from "vscode";
import type { API, Branch, Change, Commit, Repository } from "../../../../extension/features/gitApi";
import {
	clipboardText,
	type GeneratePrDeps,
	runGeneratePrDescription,
} from "../../../../extension/features/prGen/generatePrCommand";
import { makeLogger } from "../../../pureHelpers";
import { withConfig } from "../../../testUtils";

const ENABLED_CONFIG = {
	"prGeneration.enabled": true,
	"prGeneration.model": { server: "alpha", model: "gpt-test" },
};

interface FakeRepoParts {
	head?: Branch | undefined;
	branchBase?: Branch | undefined;
	mergeBase?: string | undefined;
	commits?: Commit[];
	changes?: Change[];
	patches?: Record<string, string>;
}

function fakeRepo(parts: FakeRepoParts): Repository {
	return {
		rootUri: vscode.Uri.file("/repo"),
		inputBox: { value: "" },
		state: { HEAD: parts.head, indexChanges: [], workingTreeChanges: [], untrackedChanges: [] },
		diff: () => Promise.resolve(""),
		diffWith: ((_ref: string, path?: string) =>
			path === undefined
				? Promise.resolve(parts.changes ?? [])
				: Promise.resolve(parts.patches?.[path] ?? "")) as Repository["diffWith"],
		log: () => Promise.resolve(parts.commits ?? []),
		getBranch: () => Promise.reject(new Error("not used by the command")),
		getBranchBase: () => Promise.resolve(parts.branchBase),
		getMergeBase: () => Promise.resolve(parts.mergeBase),
	};
}

function fakeGit(repo: Repository): () => Promise<API | undefined> {
	return () => Promise.resolve({ repositories: [repo] });
}

/** A branch with one commit and one patch over origin/main. */
function readyRepo(): Repository {
	return fakeRepo({
		head: { name: "feature/x", commit: "abc" },
		branchBase: { name: "main", upstream: { remote: "origin", name: "main" } },
		mergeBase: "base-sha",
		commits: [{ hash: "a", message: "feat: add the retry", parents: ["p"] }],
		changes: [{ uri: vscode.Uri.file("/repo/upload.ts"), status: 5 }],
		patches: { [vscode.Uri.file("/repo/upload.ts").fsPath]: "@@ upload" },
	});
}

/** What the injected copy seam last received; reset per test. */
let copied = "";

/** Whether the stubbed progress hands the task an already-cancelled token. */
let cancelProgress = false;

function makeDeps(): GeneratePrDeps {
	return {
		logger: makeLogger().logger,
		outputChannel: { show: () => {}, appendLine: () => {} } as unknown as vscode.OutputChannel,
		copy: (text: string) => {
			copied = text;
			return Promise.resolve();
		},
	};
}

suite("extension/features/prGen generatePrCommand", () => {
	// Toast promises stay pending until dismissed in a live host, which would
	// hang any await on showActionableMessage; the stubs record and resolve.
	const shownMessages: string[] = [];
	let origInfo: unknown;
	let origWarn: unknown;
	let origError: unknown;
	let origProgress: unknown;
	setup(() => {
		shownMessages.length = 0;
		copied = "";
		cancelProgress = false;
		const record = (message: string) => {
			shownMessages.push(message);
			return Promise.resolve(undefined);
		};
		origInfo = vscode.window.showInformationMessage;
		origWarn = vscode.window.showWarningMessage;
		origError = vscode.window.showErrorMessage;
		origProgress = vscode.window.withProgress;
		(vscode.window as Record<string, unknown>).showInformationMessage = record;
		(vscode.window as Record<string, unknown>).showWarningMessage = record;
		(vscode.window as Record<string, unknown>).showErrorMessage = record;
		// The real progress host would need a live window; the task is what matters.
		(vscode.window as Record<string, unknown>).withProgress = (
			_options: unknown,
			task: (progress: unknown, token: vscode.CancellationToken) => Thenable<unknown>
		) => {
			const source = new vscode.CancellationTokenSource();
			if (cancelProgress) {
				source.cancel();
			}
			return task({ report: () => {} }, source.token);
		};
	});
	teardown(() => {
		(vscode.window as Record<string, unknown>).showInformationMessage = origInfo;
		(vscode.window as Record<string, unknown>).showWarningMessage = origWarn;
		(vscode.window as Record<string, unknown>).showErrorMessage = origError;
		(vscode.window as Record<string, unknown>).withProgress = origProgress;
	});

	test("a disabled feature answers with the enable hint and sends nothing", async () => {
		let sends = 0;
		await withConfig({ "prGeneration.enabled": false }, () =>
			runGeneratePrDescription(
				() => {
					sends += 1;
					return Promise.resolve("Title: t");
				},
				makeDeps(),
				undefined,
				fakeGit(readyRepo())
			)
		);
		assert.strictEqual(sends, 0);
		assert.strictEqual(shownMessages.length, 1);
		assert.match(shownMessages[0] ?? "", /litellm-vscode-chat\.prGeneration\.enabled/);
	});

	test("no configured model answers with the model hint and sends nothing", async () => {
		let sends = 0;
		await withConfig({ "prGeneration.enabled": true, "prGeneration.model": null }, () =>
			runGeneratePrDescription(
				() => {
					sends += 1;
					return Promise.resolve("Title: t");
				},
				makeDeps(),
				undefined,
				fakeGit(readyRepo())
			)
		);
		assert.strictEqual(sends, 0);
		assert.match(shownMessages[0] ?? "", /litellm-vscode-chat\.prGeneration\.model/);
	});

	test("an unavailable Git extension is advice, not an error", async () => {
		await withConfig(ENABLED_CONFIG, () =>
			runGeneratePrDescription(
				() => Promise.resolve("Title: t"),
				makeDeps(),
				undefined,
				() => Promise.resolve(undefined)
			)
		);
		assert.match(shownMessages[0] ?? "", /Git extension is unavailable/);
	});

	test("no open repository is advice, not an error", async () => {
		await withConfig(ENABLED_CONFIG, () =>
			runGeneratePrDescription(
				() => Promise.resolve("Title: t"),
				makeDeps(),
				undefined,
				() => Promise.resolve({ repositories: [] })
			)
		);
		assert.match(shownMessages[0] ?? "", /Open a folder with a Git repository/);
	});

	test("a branch with no resolvable base is advice, and nothing is sent", async () => {
		let sends = 0;
		const repo = fakeRepo({ head: { name: "feature/x" }, branchBase: undefined });
		await withConfig(ENABLED_CONFIG, () =>
			runGeneratePrDescription(
				() => {
					sends += 1;
					return Promise.resolve("Title: t");
				},
				makeDeps(),
				undefined,
				fakeGit(repo)
			)
		);
		assert.strictEqual(sends, 0);
		assert.match(shownMessages[0] ?? "", /No base branch could be resolved/);
	});

	test("a branch level with its base is advice, and nothing is sent", async () => {
		let sends = 0;
		const repo = fakeRepo({
			head: { name: "feature/x" },
			branchBase: { name: "main" },
			mergeBase: "base-sha",
			commits: [],
			changes: [],
		});
		await withConfig(ENABLED_CONFIG, () =>
			runGeneratePrDescription(
				() => {
					sends += 1;
					return Promise.resolve("Title: t");
				},
				makeDeps(),
				undefined,
				fakeGit(repo)
			)
		);
		assert.strictEqual(sends, 0);
		assert.match(shownMessages[0] ?? "", /no commits or file changes/);
	});

	test("a generated draft reaches the clipboard, and the notification names the title", async () => {
		let seenPrompt = "";
		await withConfig(ENABLED_CONFIG, () =>
			runGeneratePrDescription(
				(model, prompt) => {
					assert.deepStrictEqual(model, { server: "alpha", model: "gpt-test" });
					seenPrompt = prompt;
					return Promise.resolve("Title: feat: retry uploads\nDescription:\nUploads flake, so retry them.");
				},
				makeDeps(),
				undefined,
				fakeGit(readyRepo())
			)
		);
		assert.ok(seenPrompt.includes("feat: add the retry"), "the branch's commit message rides the prompt");
		assert.ok(seenPrompt.includes("@@ upload"), "the branch's patch rides the prompt");
		assert.strictEqual(copied, "feat: retry uploads\n\nUploads flake, so retry them.");
		assert.match(shownMessages[0] ?? "", /feat: retry uploads/);
		assert.match(shownMessages[0] ?? "", /and its description/);
	});

	test("a runaway title is bounded in the notification, and the clipboard still gets it whole", async () => {
		// parseTitleAndDescription puts no length bound on the title, so a model
		// that ignores the one-line instruction must not fill the screen.
		const huge = `feat: ${"x".repeat(4000)}`;
		await withConfig(ENABLED_CONFIG, () =>
			runGeneratePrDescription(() => Promise.resolve(`Title: ${huge}`), makeDeps(), undefined, fakeGit(readyRepo()))
		);
		assert.strictEqual(copied, huge, "the clipboard receives the title whole");
		assert.ok((shownMessages[0] ?? "").length < 300, `the toast was not bounded: ${(shownMessages[0] ?? "").length}`);
		assert.match(shownMessages[0] ?? "", /\.\.\./);
	});

	test("a title-only answer copies just the title and says so", async () => {
		await withConfig(ENABLED_CONFIG, () =>
			runGeneratePrDescription(
				() => Promise.resolve("Title: feat: retry uploads"),
				makeDeps(),
				undefined,
				fakeGit(readyRepo())
			)
		);
		assert.strictEqual(copied, "feat: retry uploads");
		assert.ok(!/and its description/.test(shownMessages[0] ?? ""));
	});

	test("an unusable answer warns and leaves the clipboard alone", async () => {
		await withConfig(ENABLED_CONFIG, () =>
			runGeneratePrDescription(() => Promise.resolve("   "), makeDeps(), undefined, fakeGit(readyRepo()))
		);
		assert.strictEqual(copied, "");
		assert.match(shownMessages[0] ?? "", /did not return a usable pull request title/);
	});

	test("a cancelled walk sends nothing and says nothing - the partial gather never reaches the wire", async () => {
		// The dangerous shape: the walk gathered some patches, the user hit
		// Cancel, and the flow carried on to assemble and send them anyway.
		cancelProgress = true;
		let sends = 0;
		const { logger, lines } = makeLogger();
		await withConfig(ENABLED_CONFIG, () =>
			runGeneratePrDescription(
				() => {
					sends += 1;
					return Promise.resolve("Title: t");
				},
				{ ...makeDeps(), logger },
				undefined,
				fakeGit(readyRepo())
			)
		);
		assert.strictEqual(sends, 0, "a cancelled invocation must not reach the wire");
		assert.strictEqual(copied, "");
		assert.deepStrictEqual(shownMessages, [], "cancellation says nothing, not 'no changes'");
		assert.ok(!lines.some((entry) => /pull request/i.test(entry)), `cancellation was logged: ${lines.join("\n")}`);
	});

	test("a base that is the branch's own upstream gets advice that can actually be acted on", async () => {
		const repo = fakeRepo({
			head: { name: "feature/x", commit: "abc", upstream: { remote: "origin", name: "feature/x" } },
			branchBase: { name: "feature/x", remote: "origin" },
			mergeBase: "base-sha",
			commits: [{ hash: "a", message: "feat: x", parents: ["p"] }],
			changes: [],
		});
		await withConfig(ENABLED_CONFIG, () =>
			runGeneratePrDescription(() => Promise.resolve("Title: t"), makeDeps(), undefined, fakeGit(repo))
		);
		// Not the "set its upstream" advice: this branch already has one.
		assert.match(shownMessages[0] ?? "", /compared against itself/);
		assert.ok(!/Set its upstream/.test(shownMessages[0] ?? ""));
	});

	test("a rejecting Git activation reaches the command's own error boundary", async () => {
		const { logger, lines } = makeLogger();
		await withConfig(ENABLED_CONFIG, () =>
			runGeneratePrDescription(
				() => Promise.resolve("Title: t"),
				{ ...makeDeps(), logger },
				undefined,
				() => Promise.reject(new Error("git failed to activate"))
			)
		);
		assert.strictEqual(shownMessages.length, 1, "the user is told, rather than nothing happening");
		assert.strictEqual(lines.filter((entry) => entry.includes("Pull request description generation failed")).length, 1);
	});

	test("cancellation is silent: no notification, no log line", async () => {
		const { logger, lines } = makeLogger();
		await withConfig(ENABLED_CONFIG, () =>
			runGeneratePrDescription(
				() => Promise.reject(new vscode.CancellationError()),
				{ ...makeDeps(), logger },
				undefined,
				fakeGit(readyRepo())
			)
		);
		assert.deepStrictEqual(shownMessages, []);
		assert.ok(!lines.some((entry) => /pull request/i.test(entry)), `cancellation was logged: ${lines.join("\n")}`);
	});

	test("a send failure logs once at the command's own boundary and surfaces the transport text", async () => {
		const { logger, lines } = makeLogger();
		await withConfig(ENABLED_CONFIG, () =>
			runGeneratePrDescription(
				() => Promise.reject(new Error("upstream exploded")),
				{ ...makeDeps(), logger },
				undefined,
				fakeGit(readyRepo())
			)
		);
		assert.strictEqual(shownMessages.length, 1);
		assert.match(shownMessages[0] ?? "", /upstream exploded/);
		assert.strictEqual(
			lines.filter((entry) => entry.includes("Pull request description generation failed")).length,
			1,
			"exactly one log line, at the one boundary"
		);
	});
});

suite("extension/features/prGen clipboardText", () => {
	test("a description rides under a blank line; without one, the title stands alone", () => {
		assert.strictEqual(clipboardText("title", "body"), "title\n\nbody");
		assert.strictEqual(clipboardText("title", undefined), "title");
	});
});
