import * as assert from "node:assert";
import * as vscode from "vscode";
import { expectDefined } from "../testUtils";

suite("extension/commands", () => {
	interface QuickPickItem {
		label: string;
		id: string;
	}

	function mockHelpFeedback(pickId: string | undefined, onOpen: (uri: string) => void): { restore: () => void } {
		const origPick = vscode.window.showQuickPick;
		const origOpen = vscode.env.openExternal;

		(vscode.window as Record<string, unknown>).showQuickPick = async (items: QuickPickItem[]) => {
			return pickId ? items.find((i) => i.id === pickId) : undefined;
		};
		(vscode.env as Record<string, unknown>).openExternal = async (uri: vscode.Uri) => {
			onOpen(uri.toString());
			return true;
		};

		return {
			restore() {
				(vscode.window as Record<string, unknown>).showQuickPick = origPick;
				(vscode.env as Record<string, unknown>).openExternal = origOpen;
			},
		};
	}

	test("helpAndFeedback delegates to reportIssue when Report Bug selected", async () => {
		let openedUri: string | undefined;
		const mock = mockHelpFeedback("bug", (uri) => (openedUri = uri));
		try {
			await vscode.commands.executeCommand("litellm.helpAndFeedback");
			const uri = expectDefined(openedUri, "Should open a URL via reportIssue");
			assert.ok(uri.includes("issues/new"), "Should open new issue page");
			assert.ok(uri.includes("bug"), "Should include bug label");
		} finally {
			mock.restore();
		}
	});

	test("helpAndFeedback opens feature request URL when Request Feature selected", async () => {
		let openedUri: string | undefined;
		const mock = mockHelpFeedback("feature", (uri) => (openedUri = uri));
		try {
			await vscode.commands.executeCommand("litellm.helpAndFeedback");
			const uri = expectDefined(openedUri, "Should open a URL");
			assert.ok(uri.includes("issues/new"), "Should open new issue page");
			assert.ok(uri.includes("enhancement"), "Should include enhancement label");
		} finally {
			mock.restore();
		}
	});

	test("helpAndFeedback opens docs URL when Documentation selected", async () => {
		let openedUri: string | undefined;
		const mock = mockHelpFeedback("docs", (uri) => (openedUri = uri));
		try {
			await vscode.commands.executeCommand("litellm.helpAndFeedback");
			assert.ok(openedUri, "Should open a URL");
			assert.ok(expectDefined(openedUri).includes("quick-start"), "Should open docs URL");
		} finally {
			mock.restore();
		}
	});

	test("helpAndFeedback does nothing when user cancels", async () => {
		let openedUri: string | undefined;
		const mock = mockHelpFeedback(undefined, (uri) => (openedUri = uri));
		try {
			await vscode.commands.executeCommand("litellm.helpAndFeedback");
			assert.equal(openedUri, undefined, "Should not open any URL when cancelled");
		} finally {
			mock.restore();
		}
	});

	suite("test-only mutation commands", () => {
		teardown(async () => {
			await vscode.commands.executeCommand("litellm._test.clearServers");
		});

		test("mutations are serialized and a superseded mutation returns null", async () => {
			await vscode.commands.executeCommand("litellm._test.clearServers");

			// Fire both without awaiting: the addServer mutation is enqueued first,
			// clearServers second, so the final state must be empty and the
			// superseded addServer must report null instead of model IDs.
			const addPromise = vscode.commands.executeCommand("litellm._test.addServer", "Racer", "http://127.0.0.1:9", "");
			const clearPromise = vscode.commands.executeCommand("litellm._test.clearServers");
			const [addResult, clearResult] = await Promise.all([addPromise, clearPromise]);

			const add = addResult as { server?: { label: string }; modelIds: string[] | null };
			assert.strictEqual(add.server?.label, "Racer", "The superseded mutation itself must still be applied");
			assert.strictEqual(add.modelIds, null, "A superseded mutation must report null model IDs");
			assert.deepStrictEqual(clearResult, [], "The last mutation returns the fresh (empty) model list");
			assert.deepStrictEqual(await vscode.commands.executeCommand("litellm._test.getServers"), []);
		});
	});
});
