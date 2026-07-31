import * as assert from "node:assert";
import * as vscode from "vscode";
import { registerTestCommands, runConnectionTest, runModelSync } from "../../extension/commands";
import type { ServerRegistry } from "../../extension/serverRegistry";
import type { ConnectionStatus } from "../../extension/status";
import { RequestError } from "../../provider/transport/errorMapping";
import { Logger, markLogSafe } from "../../shared/logger";
import { SECRET_FIELD_IDS } from "../../shared/serverEntry";
import { expectDefined, makeServerStatus } from "../testUtils";

suite("extension/commands", () => {
	interface QuickPickItem {
		label: string;
	}

	function mockHelpFeedback(pickLabel: string | undefined, onOpen: (uri: string) => void): { restore: () => void } {
		const origPick = vscode.window.showQuickPick;
		const origOpen = vscode.env.openExternal;
		const origExecute = vscode.commands.executeCommand;

		(vscode.window as Record<string, unknown>).showQuickPick = async (items: QuickPickItem[]) => {
			return pickLabel === undefined ? undefined : items.find((i) => i.label === pickLabel);
		};
		(vscode.env as Record<string, unknown>).openExternal = async (uri: vscode.Uri) => {
			// The browser href VS Code derives from a Uri handed to env.openExternal (openerService).
			onOpen(encodeURI(uri.toString(true)));
			return true;
		};
		(vscode.commands as Record<string, unknown>).executeCommand = async (command: string, ...args: unknown[]) => {
			if (command === "vscode.open" && typeof args[0] === "string") {
				onOpen(args[0]);
				return;
			}
			return origExecute(command, ...args);
		};

		return {
			restore() {
				(vscode.window as Record<string, unknown>).showQuickPick = origPick;
				(vscode.env as Record<string, unknown>).openExternal = origOpen;
				(vscode.commands as Record<string, unknown>).executeCommand = origExecute;
			},
		};
	}

	test("helpAndFeedback delegates to reportIssue when Report Bug selected", async () => {
		let openedUri: string | undefined;
		const mock = mockHelpFeedback("$(bug) Report Bug", (uri) => (openedUri = uri));
		try {
			await vscode.commands.executeCommand("litellm.helpAndFeedback");
			const uri = expectDefined(openedUri, "Should open a URL via reportIssue");
			assert.ok(uri.includes("issues/new"), "Should open new issue page");
			assert.ok(uri.includes("bug"), "Should include bug label");
			assert.ok(!uri.includes("%2523"), uri);
		} finally {
			mock.restore();
		}
	});

	test("helpAndFeedback opens feature request URL when Request Feature selected", async () => {
		let openedUri: string | undefined;
		const mock = mockHelpFeedback("$(lightbulb) Request Feature", (uri) => (openedUri = uri));
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
		const mock = mockHelpFeedback("$(book) Documentation", (uri) => (openedUri = uri));
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

	suite("runConnectionTest", () => {
		const logger = new Logger({ info: () => {}, error: () => {} });
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
			const statusBar = makeStatusBar({
				state: "connected",
				totalModels: 1,
				serverStatuses: [makeServerStatus({ modelCount: 1 })],
			});
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
			const statusBar = makeStatusBar({
				state: "connected",
				totalModels: 2,
				serverStatuses: [makeServerStatus({ modelCount: 2 })],
			});
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
					await statusBar.updateStatusBar({
						state: "error",
						error: "ECONNREFUSED",
						logSafeError: markLogSafe("ECONNREFUSED"),
					});
					throw new Error("ECONNREFUSED");
				},
				refreshViaHost: async () => {},
			};

			const toasts = await withToasts(() => runConnectionTest(provider, statusBar, outputChannel, logger));

			const toast = expectDefined(toasts[0]);
			assert.strictEqual(toast.kind, "error");
			assert.ok(toast.message.includes("ECONNREFUSED"), toast.message);
		});

		test("a classified refresh failure reaches the buffer as its classification, never its body", async () => {
			// The Test Connection catch logs the thrown error; with the provider
			// rethrowing the ORIGINAL classified error (never one rebuilt from the
			// display string), the buffer line stays body-free.
			const bufferLines: string[] = [];
			const bufferLogger = new Logger(
				{ info: () => {}, error: () => {} },
				{ appendLog: (line) => bufferLines.push(line), recordError: () => {} }
			);
			const statusBar = makeStatusBar({ state: "not-configured" });
			const provider = {
				provideLanguageModelChatInformation: async (): Promise<vscode.LanguageModelChatInformation[]> => {
					throw new RequestError("LiteLLM API error: 502\n<html>internal-billing-host-MARKER</html>", "http", {
						status: 502,
						logClassification: "RequestError(http, status 502)",
					});
				},
				refreshViaHost: async () => {},
			};

			await withToasts(() => runConnectionTest(provider, statusBar, outputChannel, bufferLogger));

			assert.ok(
				bufferLines.some((line) => line.includes("Connection test failed: RequestError(http, status 502)")),
				`the buffer must carry the classification; lines: ${bufferLines.join(" | ")}`
			);
			assert.ok(
				bufferLines.every((line) => !line.includes("internal-billing-host-MARKER")),
				"the response body leaked into the buffer"
			);
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

	suite("runModelSync", () => {
		test("the Sync Models Now command is contributed and registered", async () => {
			const commands = await vscode.commands.getCommands(true);
			assert.ok(commands.includes("litellm.syncModels"), "litellm.syncModels must be registered on activation");
		});

		test("asks the host to re-resolve and reports the synced model count from the status", async () => {
			const lines: string[] = [];
			const logger = new Logger({ info: (line: string) => lines.push(line), error: () => {} });
			const statusBar = makeStatusBar({
				state: "connected",
				totalModels: 3,
				serverStatuses: [makeServerStatus({ modelCount: 3 })],
			});
			let refreshed = 0;
			const provider = {
				refreshViaHost: async () => {
					refreshed += 1;
				},
			};

			const toasts = await withToasts(() => runModelSync(provider, statusBar, outputChannel, logger));

			assert.strictEqual(refreshed, 1, "the sync must trigger the cache-dropping host refresh");
			const toast = expectDefined(toasts[0]);
			assert.strictEqual(toast.kind, "info");
			assert.ok(toast.message.includes("found 3 models"), toast.message);
			assert.ok(
				lines.some((line) => line.includes("Model sync finished: 3 models")),
				`Expected the outcome in the log. Lines: ${lines.join(" | ")}`
			);
		});

		test("reports the error outcome the refresh left behind instead of claiming success", async () => {
			const lines: string[] = [];
			const logger = new Logger({ info: (line: string) => lines.push(line), error: () => {} });
			const statusBar = makeStatusBar({
				state: "connected",
				totalModels: 2,
				serverStatuses: [makeServerStatus({ modelCount: 2 })],
			});
			const provider = {
				refreshViaHost: async () => {
					await statusBar.updateStatusBar({
						state: "error",
						error: "ECONNREFUSED",
						logSafeError: markLogSafe("ECONNREFUSED"),
						totalModels: 0,
					});
				},
			};

			const toasts = await withToasts(() => runModelSync(provider, statusBar, outputChannel, logger));

			const toast = expectDefined(toasts[0]);
			assert.strictEqual(toast.kind, "error");
			assert.ok(toast.message.includes("ECONNREFUSED"), toast.message);
			assert.ok(
				lines.some((line) => line.includes("Model sync failed: ECONNREFUSED")),
				`The log must carry the real outcome, not "finished". Lines: ${lines.join(" | ")}`
			);
		});

		test("the sync-failed log carries the log-safe rendering while the toast keeps the display text", async () => {
			// The "Model sync failed" line lands in the issue-report buffer, so it
			// must use logSafeError; the toast is a UI surface and keeps `error`.
			const lines: string[] = [];
			const logger = new Logger({ info: (line: string) => lines.push(line), error: () => {} });
			const statusBar = makeStatusBar({ state: "not-configured" });
			const provider = {
				refreshViaHost: async () => {
					await statusBar.updateStatusBar({
						state: "error",
						error: "LiteLLM API error: 502\n<html>internal-billing-host-MARKER</html>",
						logSafeError: markLogSafe("RequestError(http, status 502)"),
						totalModels: 0,
					});
				},
			};

			const toasts = await withToasts(() => runModelSync(provider, statusBar, outputChannel, logger));

			const toast = expectDefined(toasts[0]);
			assert.ok(toast.message.includes("internal-billing-host-MARKER"), "the toast keeps the display rendering");
			assert.ok(
				lines.some((line) => line.includes("Model sync failed: RequestError(http, status 502)")),
				`the log must carry the classification; lines: ${lines.join(" | ")}`
			);
			assert.ok(
				lines.every((line) => !line.includes("internal-billing-host-MARKER")),
				"the display error's body text leaked into a log line"
			);
		});

		test("reports the degraded outcome with the failing server count", async () => {
			const logger = new Logger({ info: () => {}, error: () => {} });
			const statusBar = makeStatusBar({ state: "not-configured" });
			const provider = {
				refreshViaHost: async () => {
					await statusBar.updateStatusBar({
						state: "degraded",
						totalModels: 2,
						serverStatuses: [makeServerStatus({ modelCount: 2 }), makeServerStatus({ state: "error", error: "down" })],
					});
				},
			};

			const toasts = await withToasts(() => runModelSync(provider, statusBar, outputChannel, logger));

			const toast = expectDefined(toasts[0]);
			assert.strictEqual(toast.kind, "warning");
			assert.ok(toast.message.includes("2 models available"), toast.message);
			assert.ok(toast.message.includes("1 server unreachable"), toast.message);
		});

		test("a second invocation while one is running is refused", async () => {
			const logger = new Logger({ info: () => {}, error: () => {} });
			const statusBar = makeStatusBar({
				state: "connected",
				totalModels: 1,
				serverStatuses: [makeServerStatus({ modelCount: 1 })],
			});
			let release: (() => void) | undefined;
			const blocked = new Promise<void>((resolve) => {
				release = resolve;
			});
			let refreshed = 0;
			const provider = {
				refreshViaHost: async () => {
					refreshed += 1;
					await blocked;
				},
			};

			const toasts = await withToasts(async () => {
				const first = runModelSync(provider, statusBar, outputChannel, logger);
				const second = runModelSync(provider, statusBar, outputChannel, logger);
				expectDefined(release)();
				await Promise.all([first, second]);
			});

			assert.strictEqual(refreshed, 1, "the reentrant invocation must not clear and refresh again mid-run");
			assert.strictEqual(toasts.length, 1, "the reentrant invocation must not produce a second toast");
		});

		test("logs a failing refresh and still reports from the status", async () => {
			const errors: string[] = [];
			const logger = new Logger({ info: () => {}, error: (line: string) => errors.push(line) });
			const statusBar = makeStatusBar({
				state: "connected",
				totalModels: 1,
				serverStatuses: [makeServerStatus({ modelCount: 1 })],
			});
			const provider = {
				refreshViaHost: async () => {
					throw new Error("host unavailable");
				},
			};

			const toasts = await withToasts(() => runModelSync(provider, statusBar, outputChannel, logger));

			assert.ok(
				errors.some((line) => line.includes("Model sync failed")),
				`Expected the failure to be logged. Errors: ${errors.join(" | ")}`
			);
			assert.strictEqual(toasts.length, 1, "the outcome toast must still be shown");
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

	// The docker-serversync harness commands. Their behavior end to end (real
	// sync passes, real provider groups) belongs to the docker suite; what the
	// unit host pins is that they register in test mode and return the safe
	// shapes the suite's assertions build on.
	suite("test-only serversync commands", () => {
		test("the three serversync harness commands are registered in a non-production host", async () => {
			const commands = await vscode.commands.getCommands(true);
			for (const id of [
				"litellm._test.getRecentLogs",
				"litellm._test.setServerSecret",
				"litellm._test.getDeclaredServers",
			]) {
				assert.ok(commands.includes(id), `${id} must be registered on activation`);
			}
		});

		test("getRecentLogs returns the classification-only string buffer", async () => {
			const logs = (await vscode.commands.executeCommand("litellm._test.getRecentLogs")) as unknown;
			assert.ok(Array.isArray(logs), "the command returns an array");
			assert.ok(
				logs.every((line) => typeof line === "string"),
				"every buffer entry is a string"
			);
		});

		test("setServerSecret stores and clears a label's secret field", async () => {
			// No command reads secret values back (by design), so the unit host
			// pins the round trip completing; the docker suite proves the stored
			// value actually drives discovery.
			await vscode.commands.executeCommand("litellm._test.setServerSecret", "Cmd Probe", "apiKey", "sk-probe");
			await vscode.commands.executeCommand("litellm._test.setServerSecret", "Cmd Probe", "apiKey", undefined);
		});

		test("setServerSecret rejects an unknown secret field loudly", async () => {
			await assert.rejects(
				async () => {
					await vscode.commands.executeCommand("litellm._test.setServerSecret", "Cmd Probe", "notAField", "x");
				},
				/Unknown secret field/,
				"a typoed field must fail the command, not silently no-op"
			);
		});

		test("getDeclaredServers returns views that carry no secret values", async () => {
			const views = (await vscode.commands.executeCommand("litellm._test.getDeclaredServers")) as unknown;
			assert.ok(Array.isArray(views), "the command returns an array");
			for (const view of views as Record<string, unknown>[]) {
				for (const field of SECRET_FIELD_IDS) {
					assert.ok(!(field in view), `declared views must never carry a ${field} value`);
				}
			}
		});

		test("registerTestCommands is a no-op in a production-mode context", () => {
			// Everything the function registers goes through context.subscriptions,
			// so an empty array after the call proves the gate held; a broken gate
			// would also throw here on the duplicate command ids this host already
			// registered at activation.
			const context = {
				extensionMode: vscode.ExtensionMode.Production,
				subscriptions: [] as vscode.Disposable[],
			};
			registerTestCommands(
				context as unknown as vscode.ExtensionContext,
				{} as unknown as ServerRegistry,
				{ provideLanguageModelChatInformation: async () => [], getServerSnapshots: () => [] },
				{ getRecentLogs: () => [] },
				{ getDeclared: () => [] },
				{ injectMessageForTest: async () => "ok" as const }
			);
			assert.strictEqual(context.subscriptions.length, 0, "the production gate must register nothing");
		});
	});

	// The monkey fuzzer's harness commands. The fuzzer's end-to-end behavior
	// belongs to the docker-monkey suite; the unit host pins that the commands
	// register in test mode and that the injection outcome classes come from
	// the panel's real schema boundary.
	suite("test-only monkey harness commands", () => {
		test("dashboardMessage and getStorageKeys are registered in a non-production host", async () => {
			const commands = await vscode.commands.getCommands(true);
			for (const id of ["litellm._test.dashboardMessage", "litellm._test.getStorageKeys"]) {
				assert.ok(commands.includes(id), `${id} must be registered on activation`);
			}
		});

		test("getStorageKeys returns the extension's globalState key strings", async () => {
			const keys = (await vscode.commands.executeCommand("litellm._test.getStorageKeys")) as unknown;
			assert.ok(Array.isArray(keys), "the command returns an array");
			assert.ok(
				keys.every((key) => typeof key === "string"),
				"every storage key is a string"
			);
		});

		test("dashboardMessage classifies raw payloads through the real message path", async () => {
			// Schema-rejected junk never acts.
			assert.strictEqual(
				await vscode.commands.executeCommand("litellm._test.dashboardMessage", { type: "no-such-intent" }),
				"ignored-malformed"
			);
			// Schema-valid but value-invalid: validateNumberSetting refuses, no write lands.
			assert.strictEqual(
				await vscode.commands.executeCommand("litellm._test.dashboardMessage", {
					type: "setNumberSetting",
					setting: "requestTimeout",
					value: -1,
				}),
				"validation-error"
			);
			// The harmless handshake completes the whole round trip.
			assert.strictEqual(
				await vscode.commands.executeCommand("litellm._test.dashboardMessage", { type: "ready" }),
				"ok"
			);
		});
	});
});
