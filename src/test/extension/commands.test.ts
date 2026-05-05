import * as assert from "assert";
import * as vscode from "vscode";

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
			assert.ok(openedUri, "Should open a URL via reportIssue");
			assert.ok(openedUri!.includes("issues/new"), "Should open new issue page");
			assert.ok(openedUri!.includes("bug"), "Should include bug label");
		} finally {
			mock.restore();
		}
	});

	test("helpAndFeedback opens feature request URL when Request Feature selected", async () => {
		let openedUri: string | undefined;
		const mock = mockHelpFeedback("feature", (uri) => (openedUri = uri));
		try {
			await vscode.commands.executeCommand("litellm.helpAndFeedback");
			assert.ok(openedUri, "Should open a URL");
			assert.ok(openedUri!.includes("issues/new"), "Should open new issue page");
			assert.ok(openedUri!.includes("enhancement"), "Should include enhancement label");
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
			assert.ok(openedUri!.includes("quick-start"), "Should open docs URL");
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
});
