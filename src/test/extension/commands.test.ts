import * as assert from "node:assert";
import * as vscode from "vscode";
import { runConnectionTest } from "../../extension/commands";
import type { ConnectionStatus } from "../../extension/status";
import { Logger } from "../../shared/logger";
import { expectDefined, makeServerStatus } from "../testUtils";

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

	suite("runConnectionTest", () => {
		interface Toast {
			kind: "info" | "warning" | "error";
			message: string;
		}

		function makeStatusBar(initial: ConnectionStatus) {
			let current = initial;
			return {
				get connectionStatus() {
					return current;
				},
				updateStatusBar: async (status?: ConnectionStatus) => {
					if (status) {
						current = status;
					}
				},
			};
		}

		const outputChannel = { show: () => {} } as unknown as vscode.OutputChannel;
		const logger = new Logger({ info: () => {}, error: () => {} });

		async function withToasts(fn: () => Promise<void>): Promise<Toast[]> {
			const toasts: Toast[] = [];
			const origInfo = vscode.window.showInformationMessage;
			const origWarn = vscode.window.showWarningMessage;
			const origError = vscode.window.showErrorMessage;
			const record = (kind: Toast["kind"]) => async (message: string) => {
				toasts.push({ kind, message });
				return undefined;
			};
			(vscode.window as Record<string, unknown>).showInformationMessage = record("info");
			(vscode.window as Record<string, unknown>).showWarningMessage = record("warning");
			(vscode.window as Record<string, unknown>).showErrorMessage = record("error");
			try {
				await fn();
			} finally {
				(vscode.window as Record<string, unknown>).showInformationMessage = origInfo;
				(vscode.window as Record<string, unknown>).showWarningMessage = origWarn;
				(vscode.window as Record<string, unknown>).showErrorMessage = origError;
			}
			return toasts;
		}

		test("reports the last known group statuses when the refresh cannot fetch them itself", async () => {
			// After the migration the host owns group fetches: the triggered
			// refresh returns nothing and reports nothing.
			const statusBar = makeStatusBar({
				state: "connected",
				totalModels: 3,
				serverStatuses: [makeServerStatus({ modelCount: 3 })],
			});
			const provider = {
				provideLanguageModelChatInformation: async () => [],
				refreshViaHost: async () => {},
			};

			const toasts = await withToasts(() => runConnectionTest(provider, statusBar, outputChannel, logger));

			const toast = expectDefined(toasts[0]);
			assert.strictEqual(toast.kind, "info");
			assert.ok(toast.message.includes("Found 3 models"), toast.message);
			assert.strictEqual(statusBar.connectionStatus.state, "connected", "the pre-test status must be restored");
		});

		test("asks the host to re-resolve provider groups for a real round trip", async () => {
			const statusBar = makeStatusBar({ state: "connected", totalModels: 1 });
			let refreshed = 0;
			const provider = {
				provideLanguageModelChatInformation: async () => [],
				refreshViaHost: async () => {
					refreshed += 1;
				},
			};

			await withToasts(() => runConnectionTest(provider, statusBar, outputChannel, logger));

			assert.strictEqual(refreshed, 1, "the connection test must trigger the host-driven group refresh");
		});

		test("a second invocation while one is running is refused instead of misreporting", async () => {
			const statusBar = makeStatusBar({ state: "connected", totalModels: 2 });
			let release: (() => void) | undefined;
			const blocked = new Promise<void>((resolve) => {
				release = resolve;
			});
			const provider = {
				provideLanguageModelChatInformation: async (): Promise<vscode.LanguageModelChatInformation[]> => {
					await blocked;
					return [];
				},
				refreshViaHost: async () => {},
			};

			const toasts = await withToasts(async () => {
				const first = runConnectionTest(provider, statusBar, outputChannel, logger);
				const second = runConnectionTest(provider, statusBar, outputChannel, logger);
				expectDefined(release)();
				await Promise.all([first, second]);
			});

			assert.strictEqual(toasts.length, 1, "the reentrant invocation must not produce a second toast");
			const toast = expectDefined(toasts[0]);
			assert.ok(toast.message.includes("Found 2 models"), toast.message);
		});

		test("reports a degraded outcome with the failing server count", async () => {
			const statusBar = makeStatusBar({ state: "not-configured" });
			const provider = {
				provideLanguageModelChatInformation: async () => {
					await statusBar.updateStatusBar({
						state: "degraded",
						totalModels: 2,
						serverStatuses: [makeServerStatus({ modelCount: 2 }), makeServerStatus({ state: "error", error: "down" })],
					});
					return [];
				},
				refreshViaHost: async () => {},
			};

			const toasts = await withToasts(() => runConnectionTest(provider, statusBar, outputChannel, logger));

			const toast = expectDefined(toasts[0]);
			assert.strictEqual(toast.kind, "warning");
			assert.ok(toast.message.includes("2 models available"), toast.message);
			assert.ok(toast.message.includes("1 server unreachable"), toast.message);
		});

		test("a throwing refresh reports the error status it left behind", async () => {
			const statusBar = makeStatusBar({ state: "not-configured" });
			const provider = {
				provideLanguageModelChatInformation: async (): Promise<vscode.LanguageModelChatInformation[]> => {
					await statusBar.updateStatusBar({ state: "error", error: "ECONNREFUSED" });
					throw new Error("ECONNREFUSED");
				},
				refreshViaHost: async () => {},
			};

			const toasts = await withToasts(() => runConnectionTest(provider, statusBar, outputChannel, logger));

			const toast = expectDefined(toasts[0]);
			assert.strictEqual(toast.kind, "error");
			assert.ok(toast.message.includes("ECONNREFUSED"), toast.message);
		});

		test("reports not configured when nothing was ever configured", async () => {
			const statusBar = makeStatusBar({ state: "not-configured" });
			const provider = {
				provideLanguageModelChatInformation: async () => [],
				refreshViaHost: async () => {},
			};

			const toasts = await withToasts(() => runConnectionTest(provider, statusBar, outputChannel, logger));

			const toast = expectDefined(toasts[0]);
			assert.strictEqual(toast.kind, "error");
			assert.ok(toast.message.includes("No servers configured"), toast.message);
		});
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
