import * as assert from "node:assert";
import { APIConnectionError, APIError, AuthenticationError } from "openai";
import * as vscode from "vscode";
import { ServerRegistry } from "../../../extension/servers/serverRegistry";
import { registerTestCommands, runConnectionTest, runModelSync, runReportIssue } from "../../../extension/ui/commands";
import { IssueReporter } from "../../../extension/ui/issueReporter";
import { statusErrorHeadline } from "../../../extension/ui/notifier";
import type { ConnectionStatus } from "../../../extension/ui/status";
import type { LiteLLMModelInfo } from "../../../provider/catalog/groupModels";
import { mapSdkError, RequestError, statusErrorTexts } from "../../../provider/transport/errorMapping";
import { LAST_ISSUE_REPORT_KEY } from "../../../shared/config/storageKeys";
import type { SetupHintKind } from "../../../shared/errorClassification";
import { Logger, markLogSafe } from "../../../shared/logger";
import { SECRET_FIELD_IDS } from "../../../shared/serverEntry";
import { SETUP_HINT_DOCS_URLS } from "../../../shared/util/links";
import { expectDefined } from "../../pureHelpers";
import { makeExtensionStorage, makeServerStatus } from "../../testUtils";

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
		// The unit host's status is not-configured, so reportIssue hits the setup
		// gate; answering Report Anyway keeps this test about the delegation. The
		// gate flow is not awaited, so the opened URL is waited for.
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
				serverStatuses: [makeServerStatus({ servedModelCount: 3 })],
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

		test("the zero-model verdict is not framed as a connection failure; a hidden group earns Open Dashboard", async () => {
			// The verdict text already names the removal and the recovery, so the
			// "Connection failed - " framing must not wrap it; warning-grade like
			// the bar and the notifier (one judgment, one severity).
			const lines: string[] = [];
			const bufferLogger = new Logger({ info: (line: string) => lines.push(line), error: () => {} });
			const statusBar = makeStatusBar({
				state: "connected",
				totalModels: 0,
				serverStatuses: [makeServerStatus({ servedModelCount: 0, hiddenByRemoval: true })],
			});
			const provider = {
				provideLanguageModelChatInformation: async () => [],
				refreshViaHost: async () => {},
			};

			const toasts = await withToasts(() => runConnectionTest(provider, statusBar, outputChannel, bufferLogger));

			const toast = expectDefined(toasts[0]);
			assert.strictEqual(toast.kind, "warning");
			assert.ok(!toast.message.includes("Connection failed"), toast.message);
			assert.ok(toast.message.includes("hidden by an explicit removal"), toast.message);
			assert.deepStrictEqual(toast.buttons, ["View Output", "Open Dashboard", "Report Issue"]);
			assert.ok(
				lines.some((line) => line.includes("Connection test finished with 0 models")),
				`Expected the finished-not-failed log line. Lines: ${lines.join(" | ")}`
			);
		});

		test("asks the host to re-resolve provider groups for a real round trip", async () => {
			const statusBar = makeStatusBar({
				state: "connected",
				totalModels: 1,
				serverStatuses: [makeServerStatus({ servedModelCount: 1 })],
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
				serverStatuses: [makeServerStatus({ servedModelCount: 2 })],
			});
			let release: (() => void) | undefined;
			const blocked = new Promise<void>((resolve) => {
				release = resolve;
			});
			const provider = {
				provideLanguageModelChatInformation: async (): Promise<LiteLLMModelInfo[]> => {
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
						serverStatuses: [
							makeServerStatus({ servedModelCount: 2 }),
							makeServerStatus({ state: "error", error: "down" }),
						],
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

		test("the degraded toast counts only unexpected failures, like the status bar tooltip", async () => {
			// One expected + one real failure once showed "1 unreachable" in the
			// tooltip and "2" here; the shared count pins them together.
			const statusBar = makeStatusBar({ state: "not-configured" });
			const provider = {
				provideLanguageModelChatInformation: async () => {
					await statusBar.updateStatusBar({
						state: "degraded",
						totalModels: 2,
						serverStatuses: [
							makeServerStatus({ servedModelCount: 2 }),
							makeServerStatus({ serverId: "srv2", state: "error", error: "down" }),
							makeServerStatus({ serverId: "srv3", state: "error", error: "404 on /models", expected: true }),
						],
					});
					return [];
				},
				refreshViaHost: async () => {},
			};

			const toasts = await withToasts(() => runConnectionTest(provider, statusBar, outputChannel, logger));

			const toast = expectDefined(toasts[0]);
			assert.ok(toast.message.includes("1 server unreachable"), toast.message);
		});

		test("a throwing refresh reports the error status it left behind", async () => {
			const statusBar = makeStatusBar({ state: "not-configured" });
			const provider = {
				provideLanguageModelChatInformation: async (): Promise<LiteLLMModelInfo[]> => {
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

		// Composed from ACTUAL transport mappings (mapSdkError -> statusErrorTexts) so
		// the toast cannot drift from what the transport produces: the toast carries the
		// message's headline line only, plus the Troubleshooting Docs deep link.
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
					provideLanguageModelChatInformation: async (): Promise<LiteLLMModelInfo[]> => {
						await statusBar.updateStatusBar({ state: "error", ...statusErrorTexts(mapped) });
						return [];
					},
					refreshViaHost: async () => {},
				};
			}

			for (const [label, buildError, setupHint] of causes) {
				test(`${label} keeps the exact transport headline and adds the docs action`, async () => {
					const mapped = buildError();
					assert.strictEqual(statusErrorTexts(mapped).classification?.setupHint, setupHint);
					const statusBar = makeStatusBar({ state: "not-configured" });

					const toasts = await withToasts(() =>
						runConnectionTest(providerLeavingError(statusBar, mapped), statusBar, outputChannel, logger)
					);

					const toast = expectDefined(toasts[0]);
					assert.strictEqual(toast.kind, "error");
					assert.strictEqual(toast.message, `LiteLLM: Connection failed - ${statusErrorHeadline(mapped.message)}`);
					assert.ok(!toast.message.includes("\n"), "notifications render newlines poorly; the toast stays one line");
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
				provideLanguageModelChatInformation: async (): Promise<LiteLLMModelInfo[]> => {
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

		test("a two-part status error toasts the headline line only", async () => {
			const statusBar = makeStatusBar({ state: "not-configured" });
			const provider = {
				provideLanguageModelChatInformation: async (): Promise<LiteLLMModelInfo[]> => {
					await statusBar.updateStatusBar({
						state: "error",
						error: "The server could not be reached.\nGET http://litellm.test/v1/models: ECONNREFUSED",
						logSafeError: markLogSafe("connection error"),
					});
					return [];
				},
				refreshViaHost: async () => {},
			};

			const toasts = await withToasts(() => runConnectionTest(provider, statusBar, outputChannel, logger));

			const toast = expectDefined(toasts[0]);
			assert.strictEqual(toast.message, "LiteLLM: Connection failed - The server could not be reached.");
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
				provideLanguageModelChatInformation: async (): Promise<LiteLLMModelInfo[]> => {
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
		test("a second call mid-pass joins the running one instead of answering immediately", async () => {
			// The re-entrancy guard refuses a duplicate pass, but it must NOT answer the
			// second caller instantly: the dashboard's Retry waits on this promise to
			// decide the sync is over.
			const lines: string[] = [];
			const logger = new Logger({ info: (line: string) => lines.push(line), error: () => {} });
			const statusBar = makeStatusBar({
				state: "connected",
				totalModels: 1,
				serverStatuses: [makeServerStatus({ servedModelCount: 1 })],
			});
			let releaseRefresh: (() => void) | undefined;
			const provider = {
				refreshViaHost: () =>
					new Promise<void>((resolve) => {
						releaseRefresh = resolve;
					}),
			};

			await withToasts(async () => {
				const first = runModelSync(provider, statusBar, outputChannel, logger);
				let secondSettled = false;
				const second = runModelSync(provider, statusBar, outputChannel, logger).then(() => {
					secondSettled = true;
				});
				// The first pass is parked inside refreshViaHost; neither caller
				// may have an answer yet.
				await Promise.resolve();
				assert.strictEqual(secondSettled, false, "the second call answered while the first pass was still running");

				expectDefined(releaseRefresh)();
				await Promise.all([first, second]);
				assert.strictEqual(secondSettled, true);
			});

			assert.ok(
				lines.some((line) => line.includes("already running")),
				`Expected the joined-pass log line. Lines: ${lines.join(" | ")}`
			);
		});

		test("the zero-model verdict is not framed as a failed sync; answered-empty keeps the plain Reconfigure", async () => {
			const lines: string[] = [];
			const bufferLogger = new Logger({ info: (line: string) => lines.push(line), error: () => {} });
			const statusBar = makeStatusBar({
				state: "connected",
				totalModels: 0,
				serverStatuses: [makeServerStatus({ servedModelCount: 0 })],
			});
			const provider = { refreshViaHost: async () => {} };

			const toasts = await withToasts(() => runModelSync(provider, statusBar, outputChannel, bufferLogger));

			const toast = expectDefined(toasts[0]);
			assert.strictEqual(toast.kind, "warning");
			assert.strictEqual(toast.message, "LiteLLM: The server answered but listed no models.");
			assert.deepStrictEqual(toast.buttons, ["View Output", "Reconfigure", "Report Issue"]);
			assert.ok(
				lines.some((line) => line.includes("Model sync finished with 0 models")),
				`Expected the finished-not-failed log line. Lines: ${lines.join(" | ")}`
			);
			assert.ok(
				lines.every((line) => !line.includes("Model sync failed")),
				`The buffer must not misdescribe the sync as failed. Lines: ${lines.join(" | ")}`
			);
		});

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
				serverStatuses: [makeServerStatus({ servedModelCount: 3 })],
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
				serverStatuses: [makeServerStatus({ servedModelCount: 2 })],
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

		test("the sync-failed log carries the log-safe rendering while the toast keeps the display headline", async () => {
			// The "Model sync failed" line lands in the issue-report buffer, so it
			// must use logSafeError; the toast keeps `error`'s headline line, while
			// the detail line (which may carry response bodies) stays off it.
			const lines: string[] = [];
			const logger = new Logger({ info: (line: string) => lines.push(line), error: () => {} });
			const statusBar = makeStatusBar({ state: "not-configured" });
			const provider = {
				refreshViaHost: async () => {
					await statusBar.updateStatusBar({
						state: "error",
						error: "LiteLLM API error: 502 internal-billing-host-MARKER\n<html>detail-body-MARKER</html>",
						logSafeError: markLogSafe("RequestError(http, status 502)"),
						totalModels: 0,
					});
				},
			};

			const toasts = await withToasts(() => runModelSync(provider, statusBar, outputChannel, logger));

			const toast = expectDefined(toasts[0]);
			assert.ok(toast.message.includes("internal-billing-host-MARKER"), "the toast keeps the display headline");
			assert.ok(!toast.message.includes("detail-body-MARKER"), "the detail line stays off the notification");
			assert.ok(
				lines.some((line) => line.includes("Model sync failed: RequestError(http, status 502)")),
				`the log must carry the classification; lines: ${lines.join(" | ")}`
			);
			assert.ok(
				lines.every((line) => !line.includes("internal-billing-host-MARKER") && !line.includes("detail-body-MARKER")),
				"the display error's text leaked into a log line"
			);
		});

		test("a classified error status keeps the exact transport headline and adds the docs action", async () => {
			// Composed from the actual transport mapping, like the connection-test
			// suite above: the toast carries the message's first line, nothing else.
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
			assert.strictEqual(toast.message, `LiteLLM: Model sync failed - ${statusErrorHeadline(mapped.message)}`);
			assert.ok(!toast.message.includes("\n"), "notifications render newlines poorly; the toast stays one line");
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
						serverStatuses: [
							makeServerStatus({ servedModelCount: 2 }),
							makeServerStatus({ state: "error", error: "down" }),
						],
					});
				},
			};

			const toasts = await withToasts(() => runModelSync(provider, statusBar, outputChannel, logger));

			const toast = expectDefined(toasts[0]);
			assert.strictEqual(toast.kind, "warning");
			assert.ok(toast.message.includes("2 models available"), toast.message);
			assert.ok(toast.message.includes("1 server unreachable"), toast.message);
		});

		test("the degraded sync toast counts only unexpected failures, like the status bar tooltip", async () => {
			// The sync toast reads the same shared count as the connection test and
			// the tooltip: an expected failure never inflates it.
			const logger = new Logger({ info: () => {}, error: () => {} });
			const statusBar = makeStatusBar({ state: "not-configured" });
			const provider = {
				refreshViaHost: async () => {
					await statusBar.updateStatusBar({
						state: "degraded",
						totalModels: 2,
						serverStatuses: [
							makeServerStatus({ servedModelCount: 2 }),
							makeServerStatus({ serverId: "srv2", state: "error", error: "down" }),
							makeServerStatus({ serverId: "srv3", state: "error", error: "404 on /models", expected: true }),
						],
					});
				},
			};

			const toasts = await withToasts(() => runModelSync(provider, statusBar, outputChannel, logger));

			const toast = expectDefined(toasts[0]);
			assert.ok(toast.message.includes("1 server unreachable"), toast.message);
		});

		test("a second invocation while one is running is refused", async () => {
			const logger = new Logger({ info: () => {}, error: () => {} });
			const statusBar = makeStatusBar({
				state: "connected",
				totalModels: 1,
				serverStatuses: [makeServerStatus({ servedModelCount: 1 })],
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
				serverStatuses: [makeServerStatus({ servedModelCount: 1 })],
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

	// The Report Issue command's setup gate: setup-shaped diagnostics get one non-modal
	// offer of the faster fix before GitHub opens. The verdict comes from the CURRENT
	// connection status only, never the historical latestError.
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

		const freshMemento = () => makeExtensionStorage().memento;

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

		/** Only the gate's own dialogs: the mocks intercept process-wide, so a stray host toast must not shift indices. */
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
					makeReporter(openedIssueUrls),
					freshMemento()
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
					makeReporter(openedIssueUrls),
					freshMemento()
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
				await runReportIssue(
					makeRegistry(),
					() => classified404,
					"1.2.3",
					"9.9.9",
					makeReporter(openedIssueUrls),
					freshMemento()
				);
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
				await runReportIssue(
					makeRegistry(),
					() => classified404,
					"1.2.3",
					"9.9.9",
					makeReporter(openedIssueUrls),
					freshMemento()
				);
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
				await runReportIssue(registry, () => classified404, "1.2.3", "9.9.9", reporter, freshMemento());
				await waitFor(() => gateWarnings(mocks).length === 1, "the gate to show");
				// Nothing is remembered: the second invocation offers the gate again.
				await runReportIssue(registry, () => classified404, "1.2.3", "9.9.9", reporter, freshMemento());
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
					() => ({ state: "connected", totalModels: 2, serverStatuses: [makeServerStatus({ servedModelCount: 2 })] }),
					"1.2.3",
					"9.9.9",
					reporter,
					freshMemento()
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
					makeReporter(openedIssueUrls),
					freshMemento()
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
				// Pins the non-blocking contract: the dashboard's executeCommand intent
				// awaits this promise inside its serialized message chain, so it must
				// settle while showWarningMessage's promise is still pending.
				await runReportIssue(
					makeRegistry(),
					() => status,
					"1.2.3",
					"9.9.9",
					makeReporter(openedIssueUrls),
					freshMemento()
				);
				assert.ok(answer !== undefined, "the gate must be on screen when the command settles");
				assert.strictEqual(openedIssueUrls.length, 0, "no issue opens before the gate is answered");
				// The world changes while the dialog sits unanswered; the report must
				// still carry the snapshot the gate judged.
				status = { state: "connected", totalModels: 1, serverStatuses: [makeServerStatus({ servedModelCount: 1 })] };
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

		// The repeat-report hint: each opened report's diagnostic fingerprint is
		// remembered in globalState, and a look-alike attempt inside the window
		// gets a modal prompt first.
		suite("repeat-report hint", () => {
			const healthy: ConnectionStatus = {
				state: "connected",
				totalModels: 2,
				serverStatuses: [makeServerStatus({ servedModelCount: 2 })],
			};

			interface HintMocks {
				dialogs: { message: string; modal: boolean; buttons: string[] }[];
				executed: unknown[][];
				restore: () => void;
			}

			/** Mock the modal hint (answering with `answer`) and intercept executeCommand for the issues-list link. */
			function mockHint(answer: string | undefined): HintMocks {
				const dialogs: HintMocks["dialogs"] = [];
				const executed: unknown[][] = [];
				const origInfo = vscode.window.showInformationMessage;
				const origExecute = vscode.commands.executeCommand;
				(vscode.window as Record<string, unknown>).showInformationMessage = async (
					message: string,
					options: unknown,
					...buttons: string[]
				) => {
					const modal =
						typeof options === "object" && options !== null && (options as { modal?: boolean }).modal === true;
					dialogs.push({ message, modal, buttons: modal ? buttons : [] });
					return answer;
				};
				(vscode.commands as Record<string, unknown>).executeCommand = async (command: string, ...args: unknown[]) => {
					executed.push([command, ...args]);
				};
				return {
					dialogs,
					executed,
					restore() {
						(vscode.window as Record<string, unknown>).showInformationMessage = origInfo;
						(vscode.commands as Record<string, unknown>).executeCommand = origExecute;
					},
				};
			}

			/** Only the hint's own dialogs: the mock intercepts process-wide, and the shared host toasts too. */
			function hintDialogs(mocks: HintMocks): HintMocks["dialogs"] {
				return mocks.dialogs.filter((dialog) => dialog.buttons.includes("Report Anyway"));
			}

			function storedReport(storage: ReturnType<typeof makeExtensionStorage>): {
				fingerprint: string;
				openedAt: number;
			} {
				const raw = storage.mementoStore.get(LAST_ISSUE_REPORT_KEY);
				assert.ok(typeof raw === "object" && raw !== null, "a report must be remembered");
				return raw as { fingerprint: string; openedAt: number };
			}

			test("the first report opens without a prompt and stores a text-free fingerprint", async () => {
				const storage = makeExtensionStorage();
				const openedIssueUrls: string[] = [];
				const reporter = makeReporter(openedIssueUrls);
				reporter.appendLog("log-line-MARKER");
				reporter.recordError(
					"discovery",
					new RequestError("LiteLLM API error: 502\n<html>resp-body-MARKER</html>", "http", {
						status: 502,
						logClassification: "RequestError(http, status 502)",
					})
				);
				const mocks = mockHint(undefined);
				try {
					await runReportIssue(makeRegistry(), () => healthy, "1.2.3", "9.9.9", reporter, storage.memento);
				} finally {
					mocks.restore();
				}
				assert.strictEqual(openedIssueUrls.length, 1, "the first report opens directly");
				assert.deepStrictEqual(hintDialogs(mocks), [], "no prompt without a remembered report");
				const stored = storedReport(storage);
				assert.deepStrictEqual(Object.keys(stored).sort(), ["fingerprint", "openedAt"]);
				assert.strictEqual(typeof stored.fingerprint, "string");
				assert.strictEqual(typeof stored.openedAt, "number");
				assert.ok(!JSON.stringify(stored).includes("MARKER"), "the ledger must never carry log or response text");
			});

			test("a look-alike report within the window prompts, and dismissal aborts silently", async () => {
				const storage = makeExtensionStorage();
				const openedIssueUrls: string[] = [];
				const reporter = makeReporter(openedIssueUrls);
				const registry = makeRegistry();
				const mocks = mockHint(undefined);
				try {
					await runReportIssue(registry, () => healthy, "1.2.3", "9.9.9", reporter, storage.memento);
					assert.strictEqual(openedIssueUrls.length, 1);
					const before = storedReport(storage);
					await runReportIssue(registry, () => healthy, "1.2.3", "9.9.9", reporter, storage.memento);
					await waitFor(() => hintDialogs(mocks).length === 1, "the repeat hint to show");
					// A settled turn for any stray action; there must be none.
					await new Promise((resolve) => setTimeout(resolve, 10));
					const dialog = expectDefined(hintDialogs(mocks)[0]);
					assert.ok(dialog.modal, "the hint must be modal");
					assert.ok(dialog.message.includes("looks the same"), dialog.message);
					assert.ok(dialog.message.includes("less than an hour ago"), dialog.message);
					assert.deepStrictEqual(dialog.buttons, ["Open Existing Issues", "Report Anyway"]);
					assert.strictEqual(openedIssueUrls.length, 1, "dismissal must not open an issue");
					assert.deepStrictEqual(storedReport(storage), before, "dismissal must not refresh the ledger");
				} finally {
					mocks.restore();
				}
			});

			test("Report Anyway opens the issue and refreshes the stored fingerprint", async () => {
				const storage = makeExtensionStorage();
				const openedIssueUrls: string[] = [];
				const reporter = makeReporter(openedIssueUrls);
				const registry = makeRegistry();
				const first = mockHint(undefined);
				try {
					await runReportIssue(registry, () => healthy, "1.2.3", "9.9.9", reporter, storage.memento);
				} finally {
					first.restore();
				}
				// Age the remembered report so the refreshed timestamp is observable.
				const aged = { ...storedReport(storage), openedAt: Date.now() - 60 * 60 * 1000 };
				storage.mementoStore.set(LAST_ISSUE_REPORT_KEY, aged);
				const mocks = mockHint("Report Anyway");
				try {
					await runReportIssue(registry, () => healthy, "1.2.3", "9.9.9", reporter, storage.memento);
					await waitFor(() => openedIssueUrls.length === 2, "Report Anyway to open the issue");
					await waitFor(() => storedReport(storage).openedAt > aged.openedAt, "the ledger to refresh");
				} finally {
					mocks.restore();
				}
				const dialog = expectDefined(hintDialogs(mocks)[0]);
				assert.ok(dialog.message.includes("1 hour ago"), dialog.message);
				assert.strictEqual(storedReport(storage).fingerprint, aged.fingerprint, "the same state fingerprints alike");
			});

			test("Open Existing Issues opens the filtered issues list and never a new issue", async () => {
				const storage = makeExtensionStorage();
				const openedIssueUrls: string[] = [];
				const reporter = makeReporter(openedIssueUrls);
				const registry = makeRegistry();
				const first = mockHint(undefined);
				try {
					await runReportIssue(registry, () => healthy, "1.2.3", "9.9.9", reporter, storage.memento);
				} finally {
					first.restore();
				}
				const before = storedReport(storage);
				const mocks = mockHint("Open Existing Issues");
				try {
					await runReportIssue(registry, () => healthy, "1.2.3", "9.9.9", reporter, storage.memento);
					await waitFor(() => mocks.executed.some((call) => call[0] === "vscode.open"), "the issues list to open");
					await new Promise((resolve) => setTimeout(resolve, 10));
				} finally {
					mocks.restore();
				}
				const opened = mocks.executed.filter((call) => call[0] === "vscode.open");
				assert.strictEqual(opened.length, 1);
				const url = String(expectDefined(opened[0])[1]);
				assert.ok(url.startsWith("https://github.com/Vivswan/litellm-vscode-chat/issues?"), url);
				assert.ok(url.includes(encodeURIComponent("is:issue is:open label:bug")), url);
				assert.strictEqual(openedIssueUrls.length, 1, "the issues-list action must not open a new issue");
				assert.deepStrictEqual(
					storedReport(storage),
					before,
					"pointing at existing issues must not refresh the ledger"
				);
			});

			test("a changed diagnostic state skips the prompt", async () => {
				const storage = makeExtensionStorage();
				const openedIssueUrls: string[] = [];
				const reporter = makeReporter(openedIssueUrls);
				const registry = makeRegistry();
				const mocks = mockHint(undefined);
				try {
					await runReportIssue(registry, () => healthy, "1.2.3", "9.9.9", reporter, storage.memento);
					await runReportIssue(
						registry,
						() => ({ state: "connected", totalModels: 3, serverStatuses: [makeServerStatus({ servedModelCount: 3 })] }),
						"1.2.3",
						"9.9.9",
						reporter,
						storage.memento
					);
				} finally {
					mocks.restore();
				}
				assert.deepStrictEqual(hintDialogs(mocks), [], "a different fingerprint must not prompt");
				assert.strictEqual(openedIssueUrls.length, 2, "the changed state reports directly");
			});

			test("a remembered report older than the window skips the prompt", async () => {
				const storage = makeExtensionStorage();
				const openedIssueUrls: string[] = [];
				const reporter = makeReporter(openedIssueUrls);
				const registry = makeRegistry();
				const mocks = mockHint(undefined);
				try {
					await runReportIssue(registry, () => healthy, "1.2.3", "9.9.9", reporter, storage.memento);
					const stored = storedReport(storage);
					storage.mementoStore.set(LAST_ISSUE_REPORT_KEY, {
						...stored,
						openedAt: Date.now() - 73 * 60 * 60 * 1000,
					});
					await runReportIssue(registry, () => healthy, "1.2.3", "9.9.9", reporter, storage.memento);
				} finally {
					mocks.restore();
				}
				assert.deepStrictEqual(hintDialogs(mocks), [], "an expired window must not prompt");
				assert.strictEqual(openedIssueUrls.length, 2, "the report past the window opens directly");
				assert.ok(storedReport(storage).openedAt > Date.now() - 60_000, "the fresh report re-arms the window");
			});

			test("a future-dated ledger (clock rollback) skips the prompt instead of prompting forever", async () => {
				const storage = makeExtensionStorage();
				const openedIssueUrls: string[] = [];
				const reporter = makeReporter(openedIssueUrls);
				const registry = makeRegistry();
				const mocks = mockHint(undefined);
				try {
					await runReportIssue(registry, () => healthy, "1.2.3", "9.9.9", reporter, storage.memento);
					const stored = storedReport(storage);
					storage.mementoStore.set(LAST_ISSUE_REPORT_KEY, {
						...stored,
						openedAt: Date.now() + 24 * 60 * 60 * 1000,
					});
					await runReportIssue(registry, () => healthy, "1.2.3", "9.9.9", reporter, storage.memento);
				} finally {
					mocks.restore();
				}
				assert.deepStrictEqual(hintDialogs(mocks), [], "a negative elapsed must count as expired");
				assert.strictEqual(openedIssueUrls.length, 2, "the report opens directly");
			});

			test("the command settles while the modal hint is unanswered", async () => {
				const storage = makeExtensionStorage();
				const openedIssueUrls: string[] = [];
				const reporter = makeReporter(openedIssueUrls);
				const registry = makeRegistry();
				const first = mockHint(undefined);
				try {
					await runReportIssue(registry, () => healthy, "1.2.3", "9.9.9", reporter, storage.memento);
				} finally {
					first.restore();
				}
				let answer: ((choice: string | undefined) => void) | undefined;
				const origInfo = vscode.window.showInformationMessage;
				(vscode.window as Record<string, unknown>).showInformationMessage = (
					_message: string,
					_options: unknown,
					..._buttons: string[]
				) =>
					new Promise((resolve) => {
						answer = resolve;
					});
				try {
					// Pins the non-blocking contract, like the setup-gate twin above:
					// the dashboard awaits this command in its serialized message
					// chain, so it must settle while the modal is still pending.
					await runReportIssue(registry, () => healthy, "1.2.3", "9.9.9", reporter, storage.memento);
					assert.ok(answer !== undefined, "the modal must be on screen when the command settles");
					assert.strictEqual(openedIssueUrls.length, 1, "no issue opens before the modal is answered");
					expectDefined(answer)("Report Anyway");
					await waitFor(() => openedIssueUrls.length === 2, "Report Anyway to open the issue");
				} finally {
					(vscode.window as Record<string, unknown>).showInformationMessage = origInfo;
				}
			});

			test("the setup gate keeps precedence over the repeat hint", async () => {
				const storage = makeExtensionStorage();
				const openedIssueUrls: string[] = [];
				const reporter = makeReporter(openedIssueUrls);
				const registry = makeRegistry();
				// First gated report: Report Anyway opens and remembers the fingerprint.
				const firstGate = mockGate("Report Anyway");
				try {
					await runReportIssue(registry, () => classified404, "1.2.3", "9.9.9", reporter, storage.memento);
					await waitFor(() => openedIssueUrls.length === 1, "the gated report to open");
					await waitFor(() => storage.mementoStore.has(LAST_ISSUE_REPORT_KEY), "the gated report to be remembered");
				} finally {
					firstGate.restore();
				}
				// The second attempt, same state, inside the window: the gate shows
				// again (a setup problem keeps showing its guidance) and the modal
				// hint never appears.
				const gate = mockGate("Report Anyway");
				const hint = mockHint(undefined);
				try {
					await runReportIssue(registry, () => classified404, "1.2.3", "9.9.9", reporter, storage.memento);
					await waitFor(() => openedIssueUrls.length === 2, "Report Anyway to open the second report");
				} finally {
					hint.restore();
					gate.restore();
				}
				assert.strictEqual(gateWarnings(gate).length, 1, "the setup gate must show on the repeat attempt");
				assert.deepStrictEqual(hintDialogs(hint), [], "the repeat hint must never preempt the setup gate");
			});
		});
	});

	// The groups-file deep link: leftover provider groups can only be deleted by
	// editing the host's chatLanguageModels.json, so the command must land on
	// exactly that file, and fail with guidance rather than a bare throw.
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
			// globalStorage/<extension-id> sits under the profile's User directory;
			// a path still inside globalStorage means ".." was not applied.
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

	// The dashboard Diagnostics tab's Open-output-log action. The channel lives
	// in a closure, so the unit host pins the registration and the execution
	// path; the intents allow-list test pins the dashboard mapping onto this ID.
	suite("open output command", () => {
		test("litellm.openOutput is registered on activation", async () => {
			const commands = await vscode.commands.getCommands(true);
			assert.ok(commands.includes("litellm.openOutput"), "the open-output command must be registered");
		});

		test("executing it resolves (the handler is a bare channel show)", async () => {
			await vscode.commands.executeCommand("litellm.openOutput");
		});
	});

	// The docker-serversync harness commands. Their end-to-end behavior belongs
	// to the docker suite; the unit host pins that they register in test mode
	// and return the safe shapes the suite's assertions build on.
	suite("test-only serversync commands", () => {
		test("the serversync harness commands are registered in a non-production host", async () => {
			const commands = await vscode.commands.getCommands(true);
			for (const id of [
				"litellm._test.getRecentLogs",
				"litellm._test.getSessionLogs",
				"litellm._test.getLatestError",
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

		test("getSessionLogs reads the lossless session tee through a cursor", async () => {
			type Batch = { next: number; lines: string[]; dropped: number };
			const first = (await vscode.commands.executeCommand("litellm._test.getSessionLogs", 0)) as Batch;
			assert.ok(
				Array.isArray(first.lines) && first.lines.every((line) => typeof line === "string"),
				"the tee returns string lines"
			);
			assert.strictEqual(first.dropped, 0, "nothing can have been evicted this early in a unit host");
			assert.strictEqual(first.next, first.lines.length, "the cursor counts every line from zero");
			assert.ok(first.lines.length > 0, "activation must have logged something");
			const resumed = (await vscode.commands.executeCommand("litellm._test.getSessionLogs", first.next)) as Batch;
			assert.strictEqual(resumed.dropped, 0, "a current cursor loses nothing");
			assert.strictEqual(
				resumed.next - first.next,
				resumed.lines.length,
				"a resumed read returns exactly the lines logged since the cursor"
			);
			// A junk cursor reads from the start instead of throwing: the seam
			// must stay usable from the command palette during debugging.
			const junk = (await vscode.commands.executeCommand("litellm._test.getSessionLogs", "junk")) as Batch;
			assert.ok(junk.lines.length >= first.lines.length, "a junk cursor reads from the beginning");
		});

		test("setServerSecret stores and clears a label's secret field", async () => {
			// No command reads secret values back (by design), so this pins the
			// round trip completing; the docker suite proves the stored value
			// actually drives discovery.
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
			// so an empty array proves the gate held; a broken gate would also
			// throw here on this host's already-registered command ids.
			const context = {
				extensionMode: vscode.ExtensionMode.Production,
				subscriptions: [] as vscode.Disposable[],
			};
			registerTestCommands(
				context as unknown as vscode.ExtensionContext,
				{ provideLanguageModelChatInformation: async () => [], getServerSnapshots: () => [] },
				{ getRecentLogs: () => [], getLatestError: () => undefined },
				{ getDeclared: () => [], resolveGroupArgs: async () => undefined },
				{ injectMessageForTest: async () => "ok" as const },
				{ readSince: () => ({ next: 0, lines: [], dropped: 0 }) }
			);
			assert.strictEqual(context.subscriptions.length, 0, "the production gate must register nothing");
		});
	});

	// The monkey fuzzer's harness commands. Its end-to-end behavior belongs to
	// the docker-monkey suite; the unit host pins that the commands register in
	// test mode and that injection outcomes come from the panel's real schema.
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
			// Schema-rejected junk never acts (the retired flat shape included).
			assert.strictEqual(
				await vscode.commands.executeCommand("litellm._test.dashboardMessage", { type: "no-such-intent" }),
				"ignored-malformed"
			);
			// Schema-valid but value-invalid: validateNumberSetting refuses, no write lands.
			assert.strictEqual(
				await vscode.commands.executeCommand("litellm._test.dashboardMessage", {
					kind: "request",
					id: "cmd-1",
					method: "setNumberSetting",
					payload: { setting: "chat.timeout", value: -1 },
				}),
				"validation-error"
			);
			// The harmless handshake completes the whole round trip.
			assert.strictEqual(
				await vscode.commands.executeCommand("litellm._test.dashboardMessage", {
					kind: "request",
					id: "cmd-2",
					method: "ready",
					payload: null,
				}),
				"ok"
			);
		});
	});
});
