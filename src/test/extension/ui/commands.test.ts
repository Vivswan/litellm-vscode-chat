import * as assert from "node:assert";
import { APIConnectionError, APIError, AuthenticationError } from "openai";
import * as vscode from "vscode";
import { ServerRegistry } from "../../../extension/servers/serverRegistry";
import { registerTestCommands, runConnectionTest, runModelSync, runReportIssue } from "../../../extension/ui/commands";
import { IssueReporter } from "../../../extension/ui/issueReporter";
import type { ConnectionStatus } from "../../../extension/ui/status";
import { mapSdkError, RequestError, statusErrorTexts } from "../../../provider/transport/errorMapping";
import type { SetupHintKind } from "../../../shared/errorClassification";
import { Logger, markLogSafe } from "../../../shared/logger";
import { SECRET_FIELD_IDS } from "../../../shared/serverEntry";
import { SETUP_HINT_DOCS_URLS } from "../../../shared/util/links";
import { expectDefined, makeExtensionStorage, makeServerStatus } from "../../testUtils";

suite("extension/ui/commands", () => {
	/** Poll until `condition` holds: the gate flow is deliberately not awaited by the command, so its effects land later. */
	async function waitFor(condition: () => boolean, what: string): Promise<void> {
		const deadline = Date.now() + 2000;
		while (!condition()) {
			assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}

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
		// The unit host's connection status is typically not-configured, so the
		// real reportIssue command hits the setup gate; answering Report Anyway
		// keeps this test about the delegation. The gate flow is not awaited by
		// the command, so the opened URL is waited for, not read synchronously.
		const origWarn = vscode.window.showWarningMessage;
		(vscode.window as Record<string, unknown>).showWarningMessage = async (_message: string, ...buttons: string[]) =>
			buttons.includes("Report Anyway") ? "Report Anyway" : undefined;
		try {
			await vscode.commands.executeCommand("litellm.helpAndFeedback");
			await waitFor(() => openedUri !== undefined, "the issue URL to open");
			const uri = expectDefined(openedUri, "Should open a URL via reportIssue");
			assert.ok(uri.includes("issues/new"), "Should open new issue page");
			assert.ok(uri.includes("bug"), "Should include bug label");
			assert.ok(!uri.includes("%2523"), uri);
		} finally {
			(vscode.window as Record<string, unknown>).showWarningMessage = origWarn;
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
			assert.ok(expectDefined(openedUri).includes("docs/getting-started"), "Should open docs URL");
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
		buttons: string[];
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
		const record =
			(kind: Toast["kind"]) =>
			async (message: string, ...buttons: string[]) => {
				toasts.push({ kind, message, buttons });
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

		// Composed from ACTUAL transport mappings (mapSdkError -> statusErrorTexts),
		// so the toast construction cannot drift from what the transport really
		// produces: the message stays exactly the transport text (which already
		// carries its own advice - nothing is appended), and the classification
		// only adds the Troubleshooting Docs action with the cause's deep link.
		suite("classified error toasts composed from real transport mappings", () => {
			const ctx = { surface: "discovery" as const, baseUrl: "http://litellm.test", timeoutMs: 5000 };
			const causes: ReadonlyArray<[string, () => Error, SetupHintKind]> = [
				[
					"a discovery 404",
					() => mapSdkError(new APIError(404, { error: { message: "no such route" } }, undefined, new Headers()), ctx),
					"check-base-url",
				],
				[
					"a refused connection",
					() =>
						mapSdkError(
							new APIConnectionError({
								cause: Object.assign(new TypeError("fetch failed"), {
									cause: new Error("connect ECONNREFUSED 127.0.0.1:4000"),
								}),
							}),
							ctx
						),
					"proxy-not-running",
				],
				[
					"a proxy-rejected key",
					() =>
						mapSdkError(new AuthenticationError(401, { message: "Invalid API key" }, undefined, new Headers()), ctx),
					"configure-api-key",
				],
			];

			function providerLeavingError(statusBar: ReturnType<typeof makeStatusBar>, mapped: Error) {
				return {
					provideLanguageModelChatInformation: async (): Promise<vscode.LanguageModelChatInformation[]> => {
						await statusBar.updateStatusBar({ state: "error", ...statusErrorTexts(mapped) });
						return [];
					},
					refreshViaHost: async () => {},
				};
			}

			for (const [label, buildError, setupHint] of causes) {
				test(`${label} keeps the exact transport message and adds the docs action`, async () => {
					const mapped = buildError();
					assert.strictEqual(statusErrorTexts(mapped).classification?.setupHint, setupHint);
					const statusBar = makeStatusBar({ state: "not-configured" });

					const toasts = await withToasts(() =>
						runConnectionTest(providerLeavingError(statusBar, mapped), statusBar, outputChannel, logger)
					);

					const toast = expectDefined(toasts[0]);
					assert.strictEqual(toast.kind, "error");
					assert.strictEqual(toast.message, `LiteLLM: Connection failed - ${mapped.message}`);
					assert.deepStrictEqual(toast.buttons, ["View Output", "Reconfigure", "Troubleshooting Docs", "Report Issue"]);
				});
			}

			test("the Troubleshooting Docs action opens the cause's docs deep link", async () => {
				const mapped = mapSdkError(
					new APIError(404, { error: { message: "no such route" } }, undefined, new Headers()),
					ctx
				);
				const statusBar = makeStatusBar({ state: "not-configured" });
				const opened: string[] = [];
				const origError = vscode.window.showErrorMessage;
				const origExecute = vscode.commands.executeCommand;
				(vscode.window as Record<string, unknown>).showErrorMessage = async () => "Troubleshooting Docs";
				(vscode.commands as Record<string, unknown>).executeCommand = async (command: string, ...args: unknown[]) => {
					if (command === "vscode.open" && typeof args[0] === "string") {
						opened.push(args[0]);
						return;
					}
					return origExecute(command, ...args);
				};
				try {
					await runConnectionTest(providerLeavingError(statusBar, mapped), statusBar, outputChannel, logger);
					// The toast is fired without awaiting; give the chosen action's
					// run (showActionableMessage -> openUrl) a turn to land.
					await new Promise((resolve) => setTimeout(resolve, 0));
				} finally {
					(vscode.window as Record<string, unknown>).showErrorMessage = origError;
					(vscode.commands as Record<string, unknown>).executeCommand = origExecute;
				}
				assert.deepStrictEqual(opened, [SETUP_HINT_DOCS_URLS["check-base-url"]]);
			});
		});

		test("an unclassified error status renders exactly today's toast", async () => {
			const statusBar = makeStatusBar({ state: "not-configured" });
			const provider = {
				provideLanguageModelChatInformation: async (): Promise<vscode.LanguageModelChatInformation[]> => {
					await statusBar.updateStatusBar({
						state: "error",
						error: "ECONNREFUSED",
						logSafeError: markLogSafe("ECONNREFUSED"),
					});
					return [];
				},
				refreshViaHost: async () => {},
			};

			const toasts = await withToasts(() => runConnectionTest(provider, statusBar, outputChannel, logger));

			const toast = expectDefined(toasts[0]);
			assert.strictEqual(toast.message, "LiteLLM: Connection failed - ECONNREFUSED");
			assert.deepStrictEqual(toast.buttons, ["View Output", "Reconfigure", "Report Issue"]);
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

		test("a classified error status keeps the exact transport message and adds the docs action", async () => {
			// Composed from the actual transport mapping, like the connection-test
			// suite above: nothing is appended to the message.
			const logger = new Logger({ info: () => {}, error: () => {} });
			const mapped = mapSdkError(
				new AuthenticationError(401, { message: "Invalid API key" }, undefined, new Headers()),
				{
					surface: "discovery",
					baseUrl: "http://litellm.test",
					timeoutMs: 5000,
				}
			);
			const statusBar = makeStatusBar({ state: "not-configured" });
			const provider = {
				refreshViaHost: async () => {
					await statusBar.updateStatusBar({ state: "error", ...statusErrorTexts(mapped), totalModels: 0 });
				},
			};

			const toasts = await withToasts(() => runModelSync(provider, statusBar, outputChannel, logger));

			const toast = expectDefined(toasts[0]);
			assert.strictEqual(toast.kind, "error");
			assert.strictEqual(toast.message, `LiteLLM: Model sync failed - ${mapped.message}`);
			assert.deepStrictEqual(toast.buttons, ["View Output", "Reconfigure", "Troubleshooting Docs", "Report Issue"]);
		});

		test("an unclassified error status renders exactly today's toast", async () => {
			const logger = new Logger({ info: () => {}, error: () => {} });
			const statusBar = makeStatusBar({ state: "not-configured" });
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
			assert.strictEqual(toast.message, "LiteLLM: Model sync failed - ECONNREFUSED");
			assert.deepStrictEqual(toast.buttons, ["View Output", "Reconfigure", "Report Issue"]);
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

	// The Report Issue command's setup gate: setup-shaped diagnostics get one
	// non-modal offer of the faster fix before GitHub opens. The verdict comes
	// from the CURRENT connection status only - never the historical
	// latestError - and only Report Anyway opens an issue.
	suite("runReportIssue", () => {
		function makeRegistry(): ServerRegistry {
			const storage = makeExtensionStorage();
			return new ServerRegistry(storage.memento, storage.secrets);
		}

		function makeReporter(openedIssueUrls: string[]): IssueReporter {
			return new IssueReporter({
				writeClipboard: async () => {},
				openExternal: async (url) => {
					openedIssueUrls.push(url);
				},
			});
		}

		function issueBody(url: string): string {
			return new URL(url).searchParams.get("body") ?? "";
		}

		const classified404: ConnectionStatus = {
			state: "error",
			error: "answered 404",
			logSafeError: markLogSafe("RequestError(http, status 404, discovery)"),
			classification: { kind: "http", status: 404, setupHint: "check-base-url" },
		};

		interface GateMocks {
			warnings: { message: string; buttons: string[] }[];
			executed: unknown[][];
			restore: () => void;
		}

		/** Mock the gate dialog (answering with `answer`) and intercept every executeCommand the chosen action runs. */
		function mockGate(answer: string | undefined): GateMocks {
			const warnings: GateMocks["warnings"] = [];
			const executed: unknown[][] = [];
			const origWarn = vscode.window.showWarningMessage;
			const origExecute = vscode.commands.executeCommand;
			(vscode.window as Record<string, unknown>).showWarningMessage = async (message: string, ...buttons: string[]) => {
				warnings.push({ message, buttons });
				return answer;
			};
			(vscode.commands as Record<string, unknown>).executeCommand = async (command: string, ...args: unknown[]) => {
				executed.push([command, ...args]);
			};
			return {
				warnings,
				executed,
				restore() {
					(vscode.window as Record<string, unknown>).showWarningMessage = origWarn;
					(vscode.commands as Record<string, unknown>).executeCommand = origExecute;
				},
			};
		}

		/** Only the gate's own dialogs: the mocks intercept process-wide, so a stray background toast in the shared host must not shift indices. */
		function gateWarnings(mocks: GateMocks): GateMocks["warnings"] {
			return mocks.warnings.filter((warning) => warning.buttons.includes("Report Anyway"));
		}

		/** Only the commands the gate's actions run, for the same reason. */
		function gateExecuted(mocks: GateMocks): unknown[][] {
			const gateCommands = new Set<unknown>(["litellm.openDashboard", "litellm.testConnection", "vscode.open"]);
			return mocks.executed.filter((call) => gateCommands.has(call[0]));
		}

		test("a not-configured status gates with Configure Now, and Report Anyway opens the prebuilt issue", async () => {
			const openedIssueUrls: string[] = [];
			const mocks = mockGate("Report Anyway");
			try {
				await runReportIssue(
					makeRegistry(),
					() => ({ state: "not-configured" }),
					"1.2.3",
					"9.9.9",
					makeReporter(openedIssueUrls)
				);
				await waitFor(() => openedIssueUrls.length > 0, "Report Anyway to open the issue");
			} finally {
				mocks.restore();
			}
			const warning = expectDefined(gateWarnings(mocks)[0]);
			assert.ok(warning.message.includes("setup help is faster in the dashboard"), warning.message);
			assert.deepStrictEqual(warning.buttons, ["Configure Now", "Report Anyway"]);
			const url = expectDefined(openedIssueUrls[0]);
			assert.ok(url.includes("issues/new"), url);
			assert.ok(issueBody(url).includes("Connection state: not-configured"), "the prebuilt snapshot must be reported");
		});

		test("Configure Now opens the dashboard and never an issue", async () => {
			const openedIssueUrls: string[] = [];
			const mocks = mockGate("Configure Now");
			try {
				await runReportIssue(
					makeRegistry(),
					() => ({ state: "not-configured" }),
					"1.2.3",
					"9.9.9",
					makeReporter(openedIssueUrls)
				);
				await waitFor(() => gateExecuted(mocks).length > 0, "the dashboard command to run");
			} finally {
				mocks.restore();
			}
			assert.deepStrictEqual(gateExecuted(mocks), [["litellm.openDashboard"]]);
			assert.deepStrictEqual(openedIssueUrls, [], "declining the report must not open an issue");
		});

		test("a setup-hinted error status gates with the cause's docs deep link", async () => {
			const openedIssueUrls: string[] = [];
			const mocks = mockGate("Troubleshooting Docs");
			try {
				await runReportIssue(makeRegistry(), () => classified404, "1.2.3", "9.9.9", makeReporter(openedIssueUrls));
				await waitFor(() => mocks.executed.length > 0, "the docs link to open");
			} finally {
				mocks.restore();
			}
			const warning = expectDefined(gateWarnings(mocks)[0]);
			assert.ok(warning.message.includes("looks like a setup problem"), warning.message);
			assert.deepStrictEqual(warning.buttons, ["Troubleshooting Docs", "Test Connection", "Report Anyway"]);
			// The per-cause deep link, not the generic troubleshooting page.
			assert.deepStrictEqual(gateExecuted(mocks), [["vscode.open", SETUP_HINT_DOCS_URLS["check-base-url"]]]);
			assert.deepStrictEqual(openedIssueUrls, [], "the docs action must not open an issue");
		});

		test("Test Connection runs the connection test command and never an issue", async () => {
			const openedIssueUrls: string[] = [];
			const mocks = mockGate("Test Connection");
			try {
				await runReportIssue(makeRegistry(), () => classified404, "1.2.3", "9.9.9", makeReporter(openedIssueUrls));
				await waitFor(() => gateExecuted(mocks).length > 0, "the connection test command to run");
			} finally {
				mocks.restore();
			}
			assert.deepStrictEqual(gateExecuted(mocks), [["litellm.testConnection"]]);
			assert.deepStrictEqual(openedIssueUrls, [], "the test action must not open an issue");
		});

		test("dismissing the gate does nothing; rerunning the command re-offers it", async () => {
			const openedIssueUrls: string[] = [];
			const mocks = mockGate(undefined);
			try {
				const registry = makeRegistry();
				const reporter = makeReporter(openedIssueUrls);
				await runReportIssue(registry, () => classified404, "1.2.3", "9.9.9", reporter);
				await waitFor(() => gateWarnings(mocks).length === 1, "the gate to show");
				// Nothing is remembered: the second invocation offers the gate again.
				await runReportIssue(registry, () => classified404, "1.2.3", "9.9.9", reporter);
				await waitFor(() => gateWarnings(mocks).length === 2, "the gate to re-offer");
				// A settled turn for any stray action; there must be none.
				await new Promise((resolve) => setTimeout(resolve, 10));
			} finally {
				mocks.restore();
			}
			assert.deepStrictEqual(gateExecuted(mocks), [], "dismissal must run nothing");
			assert.deepStrictEqual(openedIssueUrls, [], "dismissal must not open an issue");
		});

		test("a healthy status goes straight to GitHub even with a stale classified latestError recorded", async () => {
			const openedIssueUrls: string[] = [];
			const reporter = makeReporter(openedIssueUrls);
			// The historical latestError is never cleared; a setup-shaped failure
			// recorded before recovery must not gate a now-healthy user.
			reporter.recordError(
				"discovery",
				mapSdkError(new APIError(404, { error: { message: "no such route" } }, undefined, new Headers()), {
					surface: "discovery",
					baseUrl: "http://litellm.test",
					timeoutMs: 5000,
				})
			);
			const mocks = mockGate("Report Anyway");
			try {
				await runReportIssue(
					makeRegistry(),
					() => ({ state: "connected", totalModels: 2, serverStatuses: [makeServerStatus({ modelCount: 2 })] }),
					"1.2.3",
					"9.9.9",
					reporter
				);
			} finally {
				mocks.restore();
			}
			assert.deepStrictEqual(gateWarnings(mocks), [], "a healthy status must never be gated");
			assert.strictEqual(openedIssueUrls.length, 1, "the ungated path opens the issue before the command settles");
		});

		test("an error status without a setup hint goes straight to GitHub", async () => {
			const openedIssueUrls: string[] = [];
			const mocks = mockGate("Report Anyway");
			try {
				await runReportIssue(
					makeRegistry(),
					() => ({
						state: "error",
						error: "boom",
						logSafeError: markLogSafe("boom"),
						classification: { kind: "http", status: 500 },
					}),
					"1.2.3",
					"9.9.9",
					makeReporter(openedIssueUrls)
				);
			} finally {
				mocks.restore();
			}
			assert.deepStrictEqual(gateWarnings(mocks), [], "a hintless failure is a real bug report, not a setup problem");
			assert.strictEqual(openedIssueUrls.length, 1);
		});

		test("the command settles while the gate is unanswered, and Report Anyway reports the snapshot built up front", async () => {
			const openedIssueUrls: string[] = [];
			let answer: ((choice: string | undefined) => void) | undefined;
			const origWarn = vscode.window.showWarningMessage;
			(vscode.window as Record<string, unknown>).showWarningMessage = (_message: string, ..._buttons: string[]) =>
				new Promise((resolve) => {
					answer = resolve;
				});
			try {
				let status: ConnectionStatus = { state: "not-configured" };
				// Pins the non-blocking contract: the dashboard's executeCommand
				// intent awaits this promise inside its serialized message chain, so
				// it must settle while showWarningMessage's promise is still pending
				// (an awaited gate would hang this test into its timeout).
				await runReportIssue(makeRegistry(), () => status, "1.2.3", "9.9.9", makeReporter(openedIssueUrls));
				assert.ok(answer !== undefined, "the gate must be on screen when the command settles");
				assert.strictEqual(openedIssueUrls.length, 0, "no issue opens before the gate is answered");
				// The world changes while the dialog sits unanswered; the report must
				// still carry the snapshot the gate judged.
				status = { state: "connected", totalModels: 1, serverStatuses: [makeServerStatus({ modelCount: 1 })] };
				expectDefined(answer)("Report Anyway");
				await waitFor(() => openedIssueUrls.length > 0, "Report Anyway to open the issue");
			} finally {
				(vscode.window as Record<string, unknown>).showWarningMessage = origWarn;
			}
			assert.ok(
				issueBody(expectDefined(openedIssueUrls[0])).includes("Connection state: not-configured"),
				"the issue must carry the snapshot built before the gate, not the later status"
			);
		});
	});

	// The groups-file deep link: leftover provider groups can only be deleted
	// by editing the host's chatLanguageModels.json, so the command must land
	// on exactly that file - and fail with guidance, never a bare throw, on
	// hosts that cannot reach it.
	suite("open groups file command", () => {
		test("litellm.openGroupsFile is registered on activation", async () => {
			const commands = await vscode.commands.getCommands(true);
			assert.ok(commands.includes("litellm.openGroupsFile"), "the groups-file command must be registered");
		});

		test("resolves chatLanguageModels.json two levels above global storage and shows it", async () => {
			const opened: vscode.Uri[] = [];
			let shown = 0;
			const origOpen = vscode.workspace.openTextDocument;
			const origShow = vscode.window.showTextDocument;
			(vscode.workspace as Record<string, unknown>).openTextDocument = async (uri: vscode.Uri) => {
				opened.push(uri);
				return {} as vscode.TextDocument;
			};
			(vscode.window as Record<string, unknown>).showTextDocument = async () => {
				shown += 1;
				return {} as vscode.TextEditor;
			};
			try {
				await vscode.commands.executeCommand("litellm.openGroupsFile");
			} finally {
				(vscode.workspace as Record<string, unknown>).openTextDocument = origOpen;
				(vscode.window as Record<string, unknown>).showTextDocument = origShow;
			}
			assert.strictEqual(opened.length, 1);
			const uri = expectDefined(opened[0]);
			assert.ok(uri.path.endsWith("/chatLanguageModels.json"), uri.path);
			// globalStorage/<extension-id> sits under the profile's User
			// directory; a path still inside globalStorage means the ".."
			// segments were not applied.
			assert.ok(!uri.path.includes("globalStorage"), uri.path);
			assert.strictEqual(shown, 1, "the document must be shown in an editor tab");
		});

		test("a failing open reports the friendly groups-file error instead of throwing", async () => {
			const errors: string[] = [];
			const origOpen = vscode.workspace.openTextDocument;
			const origError = vscode.window.showErrorMessage;
			(vscode.workspace as Record<string, unknown>).openTextDocument = async () => {
				throw new Error("cannot open the resource");
			};
			(vscode.window as Record<string, unknown>).showErrorMessage = async (message: string) => {
				errors.push(message);
				return undefined;
			};
			try {
				await vscode.commands.executeCommand("litellm.openGroupsFile");
			} finally {
				(vscode.workspace as Record<string, unknown>).openTextDocument = origOpen;
				(vscode.window as Record<string, unknown>).showErrorMessage = origError;
			}
			assert.strictEqual(errors.length, 1);
			assert.ok(expectDefined(errors[0]).includes("chatLanguageModels.json"), expectDefined(errors[0]));
		});
	});

	// The dashboard Diagnostics tab's Open-output-log action: an internal
	// command that shows the extension's output channel. Registered alongside
	// litellm.testConnection, whose registration holds the channel; the
	// channel instance itself lives in a closure, so the unit host pins the
	// registration and the execution path (the intents allow-list test pins
	// the dashboard mapping onto this ID).
	suite("open output command", () => {
		test("litellm.openOutput is registered on activation", async () => {
			const commands = await vscode.commands.getCommands(true);
			assert.ok(commands.includes("litellm.openOutput"), "the open-output command must be registered");
		});

		test("executing it resolves (the handler is a bare channel show)", async () => {
			await vscode.commands.executeCommand("litellm.openOutput");
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
