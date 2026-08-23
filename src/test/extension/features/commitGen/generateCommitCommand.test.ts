import * as assert from "node:assert";
import { HttpResponse, http } from "msw";
import * as vscode from "vscode";
import type { GenerateCommitDeps } from "../../../../extension/features/commitGen/generateCommitCommand";
import { runGenerateCommitMessage } from "../../../../extension/features/commitGen/generateCommitCommand";
import type { API, Change, Commit, Repository } from "../../../../extension/features/gitApi";
import { OneShotClient } from "../../../../provider/transport/oneShotClient";
import { serverSecretsKey } from "../../../../shared/config/storageKeys";
import { Logger } from "../../../../shared/logger";
import { CHAT_COMPLETIONS_URL, mswServer, TEST_BASE_URL, useMsw } from "../../../mocks/handlers";
import { makeLogger } from "../../../pureHelpers";
import { withConfig } from "../../../testUtils";

/** The settings that make the feature live against the msw-mocked server. */
const ENABLED_CONFIG = {
	"commitGeneration.enabled": true,
	"commitGeneration.model": { server: "alpha", model: "gpt-test" },
	servers: [{ label: "alpha", baseUrl: TEST_BASE_URL, auth: { apiKey: "sk-test" } }],
};

interface FakeRepoParts {
	staged?: string;
	working?: string;
	untracked?: string[];
	commits?: Commit[];
	root?: string;
}

/**
 * The vendored Repository members the commit flow never touches (they serve
 * the PR flow). Present so the fake satisfies the API as declared, and
 * rejecting so a flow that starts reaching for one fails loudly here.
 */
const unusedRepositoryMembers = {
	diffWith: () => Promise.reject(new Error("diffWith is not part of the commit flow")),
	getBranch: () => Promise.reject(new Error("getBranch is not part of the commit flow")),
	getBranchBase: () => Promise.reject(new Error("getBranchBase is not part of the commit flow")),
	getMergeBase: () => Promise.reject(new Error("getMergeBase is not part of the commit flow")),
} as unknown as Pick<Repository, "diffWith" | "getBranch" | "getBranchBase" | "getMergeBase">;

function fakeRepo(parts: FakeRepoParts): Repository {
	const root = parts.root ?? "/repo";
	const untrackedChanges: Change[] = (parts.untracked ?? []).map((path) => ({
		uri: vscode.Uri.file(`${root}/${path}`),
		status: 7,
	}));
	return {
		...unusedRepositoryMembers,
		rootUri: vscode.Uri.file(root),
		inputBox: { value: "" },
		state: { HEAD: undefined, indexChanges: [], workingTreeChanges: untrackedChanges, untrackedChanges: [] },
		diff: (cached?: boolean) => Promise.resolve(cached === true ? (parts.staged ?? "") : (parts.working ?? "")),
		// Declared by the vendored API subset; the commit flow never calls it.
		diffWith: ((_ref: string, path?: string) =>
			Promise.resolve(path === undefined ? [] : "")) as Repository["diffWith"],
		log: () => Promise.resolve(parts.commits ?? []),
	};
}

function fakeGit(repo: Repository): () => Promise<API | undefined> {
	return () => Promise.resolve({ repositories: [repo] });
}

function makeDeps(): GenerateCommitDeps {
	return {
		secrets: {
			get: () => Promise.resolve(undefined),
			store: () => Promise.resolve(),
			delete: () => Promise.resolve(),
			keys: () => Promise.resolve([]),
			onDidChange: () => ({ dispose: () => {} }),
		} as unknown as vscode.SecretStorage,
		logger: makeLogger().logger,
		outputChannel: { show: () => {}, appendLine: () => {} } as unknown as vscode.OutputChannel,
	};
}

function client(): OneShotClient {
	return new OneShotClient({ userAgent: "test-agent" });
}

suite("extension/features/commitGen generateCommitCommand", () => {
	useMsw();

	// Toast promises stay pending until dismissed in a live host, which would
	// hang any await on showActionableMessage; the stubs record and resolve.
	const shownMessages: string[] = [];
	let origInfo: unknown;
	let origWarn: unknown;
	let origError: unknown;
	setup(() => {
		shownMessages.length = 0;
		const record = (message: string) => {
			shownMessages.push(message);
			return Promise.resolve(undefined);
		};
		origInfo = vscode.window.showInformationMessage;
		origWarn = vscode.window.showWarningMessage;
		origError = vscode.window.showErrorMessage;
		(vscode.window as Record<string, unknown>).showInformationMessage = record;
		(vscode.window as Record<string, unknown>).showWarningMessage = record;
		(vscode.window as Record<string, unknown>).showErrorMessage = record;
	});
	teardown(() => {
		(vscode.window as Record<string, unknown>).showInformationMessage = origInfo;
		(vscode.window as Record<string, unknown>).showWarningMessage = origWarn;
		(vscode.window as Record<string, unknown>).showErrorMessage = origError;
	});

	test("the staged diff drives the request and the reply lands in the commit input box", async () => {
		let seenBody: Record<string, unknown> | undefined;
		mswServer.use(
			http.post(CHAT_COMPLETIONS_URL, async ({ request }) => {
				seenBody = (await request.json()) as Record<string, unknown>;
				return HttpResponse.json({ choices: [{ message: { role: "assistant", content: "feat: from staged" } }] });
			})
		);
		const repo = fakeRepo({
			staged: "+staged line",
			working: "+working line",
			commits: [{ hash: "a", message: "feat: earlier subject\n\nbody stays out", parents: [] }],
		});

		await withConfig(ENABLED_CONFIG, () => runGenerateCommitMessage(client(), makeDeps(), undefined, fakeGit(repo)));

		assert.strictEqual(repo.inputBox.value, "feat: from staged");
		assert.ok(seenBody, "the request must have been sent");
		assert.strictEqual(seenBody.model, "gpt-test");
		const prompt = (seenBody.messages as { content: string }[])[0]?.content ?? "";
		assert.ok(prompt.includes("+staged line"), "the staged diff rides the prompt");
		assert.ok(!prompt.includes("+working line"), "the working tree stays out when something is staged");
		assert.ok(prompt.includes("- feat: earlier subject"), "style examples ride along");
		assert.ok(!prompt.includes("body stays out"), "commit bodies never ride along");
	});

	test("an empty index falls back to the working-tree diff plus untracked paths", async () => {
		let prompt = "";
		mswServer.use(
			http.post(CHAT_COMPLETIONS_URL, async ({ request }) => {
				const body = (await request.json()) as { messages: { content: string }[] };
				prompt = body.messages[0]?.content ?? "";
				return HttpResponse.json({ choices: [{ message: { role: "assistant", content: "feat: fallback" } }] });
			})
		);
		const repo = fakeRepo({ working: "+edited line", untracked: ["new-file.ts"] });

		await withConfig(ENABLED_CONFIG, () => runGenerateCommitMessage(client(), makeDeps(), undefined, fakeGit(repo)));

		assert.strictEqual(repo.inputBox.value, "feat: fallback");
		assert.ok(prompt.includes("+edited line"), "the working-tree diff rides the prompt");
		assert.ok(prompt.includes("- new-file.ts"), "untracked paths ride along on the fallback");
	});

	test("disabled and model-less invocations send nothing", async () => {
		// No msw handler for the chat endpoint: any request would fail the test
		// through onUnhandledRequest: "error".
		const repo = fakeRepo({ staged: "+staged line" });

		await withConfig({ ...ENABLED_CONFIG, "commitGeneration.enabled": false }, () =>
			runGenerateCommitMessage(client(), makeDeps(), undefined, fakeGit(repo))
		);
		assert.strictEqual(repo.inputBox.value, "", "a disabled invocation must not write the input box");
		assert.ok(
			shownMessages.some((message) => message.includes("commitGeneration.enabled")),
			`the enable hint names the setting, got ${JSON.stringify(shownMessages)}`
		);

		await withConfig({ ...ENABLED_CONFIG, "commitGeneration.model": null }, () =>
			runGenerateCommitMessage(client(), makeDeps(), undefined, fakeGit(repo))
		);
		assert.strictEqual(repo.inputBox.value, "", "a model-less invocation must not write the input box");
		assert.ok(
			shownMessages.some((message) => message.includes("commitGeneration.model")),
			`the no-model hint names the setting, got ${JSON.stringify(shownMessages)}`
		);
	});

	test("a configured label matching no servers entry fails classified, without a request", async () => {
		// The output channel gets the English mirror (indistinguishable from the
		// localized text under the test host's English locale), so the
		// discriminating pin is the issue-report buffer: publicErrorText prefers
		// the logClassification, which exists only if localizedError was built
		// with one.
		const buffered: string[] = [];
		const logger = new Logger(
			{ info: () => {}, error: () => {} },
			{ appendLog: (line: string) => buffered.push(line), recordError: () => {} }
		);
		const deps = { ...makeDeps(), logger };
		const repo = fakeRepo({ staged: "+staged line" });

		await withConfig({ ...ENABLED_CONFIG, servers: [] }, () =>
			runGenerateCommitMessage(client(), deps, undefined, fakeGit(repo))
		);

		assert.strictEqual(repo.inputBox.value, "");
		assert.ok(
			buffered.some((line) => line.includes("CommitGeneration(configured server label matches no entry)")),
			`the issue-report buffer carries the classification, got ${JSON.stringify(buffered)}`
		);
	});

	test("stored secrets authenticate the request, and inline settings values win over them", async () => {
		const auths: (string | null)[] = [];
		mswServer.use(
			http.post(CHAT_COMPLETIONS_URL, ({ request }) => {
				auths.push(request.headers.get("authorization"));
				return HttpResponse.json({ choices: [{ message: { role: "assistant", content: "feat: authed" } }] });
			})
		);
		const secrets = {
			get: (key: string) =>
				Promise.resolve(key === serverSecretsKey("alpha") ? JSON.stringify({ apiKey: "sk-stored" }) : undefined),
		} as unknown as vscode.SecretStorage;
		const deps = { ...makeDeps(), secrets };

		// Stored-only: the entry carries no inline key, so the blob authenticates.
		const storedOnly = fakeRepo({ staged: "+x" });
		await withConfig({ ...ENABLED_CONFIG, servers: [{ label: "alpha", baseUrl: TEST_BASE_URL }] }, () =>
			runGenerateCommitMessage(client(), deps, undefined, fakeGit(storedOnly))
		);
		// Inline wins: the same blob loses to the entry's inline auth.apiKey.
		const inlineWins = fakeRepo({ staged: "+x" });
		await withConfig(ENABLED_CONFIG, () => runGenerateCommitMessage(client(), deps, undefined, fakeGit(inlineWins)));

		assert.deepStrictEqual(auths, ["Bearer sk-stored", "Bearer sk-test"]);
		assert.strictEqual(storedOnly.inputBox.value, "feat: authed");
		assert.ok(
			!shownMessages.join("\n").includes("sk-stored"),
			"the stored secret must never reach a user-facing message"
		);
	});

	test("the SCM-title argument routes to the matching repository", async () => {
		mswServer.use(
			http.post(CHAT_COMPLETIONS_URL, () =>
				HttpResponse.json({ choices: [{ message: { role: "assistant", content: "feat: routed" } }] })
			)
		);
		const target = fakeRepo({ staged: "+target", root: "/repo-target" });
		const other = fakeRepo({ staged: "+other", root: "/repo-other" });
		const git: API = { repositories: [other, target] };

		await withConfig(ENABLED_CONFIG, () =>
			runGenerateCommitMessage(client(), makeDeps(), { rootUri: target.rootUri }, () => Promise.resolve(git))
		);

		assert.strictEqual(target.inputBox.value, "feat: routed", "the argument's rootUri picks the repository");
		assert.strictEqual(other.inputBox.value, "");
	});
});
