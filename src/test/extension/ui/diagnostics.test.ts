import * as assert from "node:assert";
import * as vscode from "vscode";
import { ServerRegistry } from "../../../extension/servers/serverRegistry";
import type { DeclaredServerView } from "../../../extension/servers/serverSync";
import { buildDiagnosticsSnapshot, registerDiagnosticsCommand } from "../../../extension/ui/diagnostics";
import { IssueReporter } from "../../../extension/ui/issueReporter";
import type { ConnectionStatus } from "../../../extension/ui/status";
import type { ServerModelsSnapshot } from "../../../provider";
import { markLogSafe } from "../../../shared/logger";
import { expectDefined, makeExtensionStorage, makeModelInfo, makeServerStatus } from "../../testUtils";

function createRegistry(): ServerRegistry {
	const storage = makeExtensionStorage();
	return new ServerRegistry(storage.memento, storage.secrets);
}

/** A live status-window snapshot whose model list agrees with its model count. */
function makeSnapshot(overrides: Parameters<typeof makeServerStatus>[0] = {}): ServerModelsSnapshot {
	const status = makeServerStatus(overrides);
	const count = status.state === "ok" ? status.modelCount : 0;
	return {
		status,
		models: Array.from({ length: count }, (_, index) =>
			makeModelInfo({ id: `model-${index}`, name: `model-${index}` })
		),
	};
}

/** A declared-server view with every secret absent; overrides fill in the specifics. */
function makeDeclared(overrides: Partial<DeclaredServerView> = {}): DeclaredServerView {
	return {
		label: "Prod",
		baseUrl: "http://prod.test",
		secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" },
		...overrides,
	};
}

suite("extension/ui/diagnostics", () => {
	suite("buildDiagnosticsSnapshot", () => {
		test("collects environment, connection, and reporter data", async () => {
			const reporter = new IssueReporter();
			reporter.appendLog("first log line");
			reporter.appendLog("second log line");
			reporter.recordError("discovery", new Error("fetch exploded"));

			const snapshot = await buildDiagnosticsSnapshot(
				createRegistry(),
				{ state: "connected", totalModels: 7, serverStatuses: [] },
				"1.2.3",
				"9.9.9",
				reporter
			);

			assert.strictEqual(snapshot.extensionVersion, "1.2.3");
			assert.strictEqual(snapshot.vscodeVersion, "9.9.9");
			assert.strictEqual(snapshot.platform, `${process.platform} ${process.arch}`);
			assert.strictEqual(snapshot.connectionState, "connected");
			assert.strictEqual(snapshot.modelCount, 7);
			assert.strictEqual(snapshot.apiKeyConfigured, "unknown", "unobserved native groups cannot be ruled out");
			assert.strictEqual(snapshot.baseUrlConfigured, false);
			assert.strictEqual(expectDefined(snapshot.latestError).source, "discovery");
			assert.strictEqual(expectDefined(snapshot.latestError).message, "fetch exploded");
			assert.deepStrictEqual(snapshot.recentLogs, ["first log line", "second log line"]);
		});

		test("reports a configured server with an API key", async () => {
			const registry = createRegistry();
			await registry.addServer("Prod", "http://prod.test", "sk-secret");

			const snapshot = await buildDiagnosticsSnapshot(
				registry,
				{ state: "connected", totalModels: 1, serverStatuses: [] },
				"1.2.3",
				"9.9.9",
				new IssueReporter()
			);

			assert.strictEqual(snapshot.baseUrlConfigured, true);
			assert.strictEqual(snapshot.apiKeyConfigured, true);
			assert.strictEqual(snapshot.latestError, undefined);
			assert.deepStrictEqual(snapshot.recentLogs, []);
		});

		test("a whitespace-only API key does not count as configured", async () => {
			const registry = createRegistry();
			await registry.addServer("Prod", "http://prod.test", "   ");

			const snapshot = await buildDiagnosticsSnapshot(
				registry,
				{ state: "error", error: "boom", logSafeError: markLogSafe("boom") },
				"1.2.3",
				"9.9.9",
				new IssueReporter()
			);

			assert.strictEqual(snapshot.baseUrlConfigured, true);
			assert.strictEqual(snapshot.apiKeyConfigured, false);
			assert.strictEqual(snapshot.connectionState, "error");
			assert.strictEqual(snapshot.modelCount, undefined);
		});

		test("observed group statuses count as configuration even with the migration flag unset", async () => {
			const snapshot = await buildDiagnosticsSnapshot(
				createRegistry(),
				{
					state: "connected",
					totalModels: 4,
					serverStatuses: [makeServerStatus({ serverId: "group:abc:http://prod.test", hasApiKey: true })],
				},
				"1.2.3",
				"9.9.9",
				new IssueReporter()
			);

			assert.strictEqual(snapshot.baseUrlConfigured, true, "an observed group server counts as configured");
			assert.strictEqual(snapshot.apiKeyConfigured, true, "a group that carries a key counts as key-configured");
		});

		test("keyless groups configure a base URL but no API key", async () => {
			const snapshot = await buildDiagnosticsSnapshot(
				createRegistry(),
				{
					state: "connected",
					totalModels: 4,
					serverStatuses: [makeServerStatus({ serverId: "group:abc:http://prod.test", hasApiKey: false })],
				},
				"1.2.3",
				"9.9.9",
				new IssueReporter()
			);

			assert.strictEqual(snapshot.baseUrlConfigured, true);
			assert.strictEqual(snapshot.apiKeyConfigured, false, "keyless groups must not report a configured key");
		});

		test("key presence is unknown until group statuses are observed", async () => {
			const snapshot = await buildDiagnosticsSnapshot(
				createRegistry(),
				{ state: "not-configured" },
				"1.2.3",
				"9.9.9",
				new IssueReporter()
			);

			assert.strictEqual(snapshot.baseUrlConfigured, false);
			assert.strictEqual(
				snapshot.apiKeyConfigured,
				"unknown",
				"a missing status window proves nothing about key presence"
			);
		});
	});

	suite("litellm.showDiagnostics", () => {
		interface CommandRun {
			message: string;
			options: vscode.MessageOptions | undefined;
			actions: string[];
			executed: string[];
			outputShown: boolean;
			subscriptionCount: number;
		}

		interface RunOptions {
			registry?: ServerRegistry;
			snapshots?: readonly ServerModelsSnapshot[];
			declared?: readonly DeclaredServerView[];
			status?: ConnectionStatus;
			/** The value the stubbed configuration returns for the servers setting. */
			serversSetting?: unknown;
			choice?: string;
		}

		// The activated extension already owns the litellm.showDiagnostics command
		// ID, so the handler is captured through a stubbed registerCommand and
		// invoked directly instead of going through executeCommand. Configuration
		// reads are stubbed too, so the fallback-to-setting path is testable and
		// the assertions never depend on the test host's real settings.
		async function runDiagnosticsCommand(options: RunOptions = {}): Promise<CommandRun> {
			let handler: (() => Promise<void>) | undefined;
			const origRegister = vscode.commands.registerCommand;
			(vscode.commands as Record<string, unknown>).registerCommand = (id: string, callback: () => Promise<void>) => {
				assert.strictEqual(id, "litellm.showDiagnostics");
				handler = callback;
				return { dispose() {} };
			};
			const subscriptions: vscode.Disposable[] = [];
			const context = { subscriptions } as unknown as vscode.ExtensionContext;
			let outputShown = false;
			const outputChannel = {
				show: () => {
					outputShown = true;
				},
			} as unknown as vscode.OutputChannel;
			try {
				registerDiagnosticsCommand(
					context,
					options.registry ?? createRegistry(),
					() => options.snapshots ?? [],
					() => options.declared ?? [],
					() => options.status ?? { state: "not-configured" },
					outputChannel
				);
			} finally {
				(vscode.commands as Record<string, unknown>).registerCommand = origRegister;
			}

			let message = "";
			let dialogOptions: vscode.MessageOptions | undefined;
			let actions: string[] = [];
			const executed: string[] = [];
			const origShowMessage = vscode.window.showInformationMessage;
			const origExecute = vscode.commands.executeCommand;
			const origGetConfiguration = vscode.workspace.getConfiguration;
			(vscode.window as Record<string, unknown>).showInformationMessage = async (
				shownMessage: string,
				shownOptions: vscode.MessageOptions,
				...items: string[]
			) => {
				message = shownMessage;
				dialogOptions = shownOptions;
				actions = items;
				return options.choice;
			};
			(vscode.commands as Record<string, unknown>).executeCommand = async (commandId: string) => {
				executed.push(commandId);
			};
			(vscode.workspace as Record<string, unknown>).getConfiguration = (section: string) => {
				assert.strictEqual(section, "litellm-vscode-chat");
				return {
					get: (key: string) => (key === "servers" ? options.serversSetting : undefined),
					inspect: () => undefined,
				};
			};
			try {
				await expectDefined(handler, "registerDiagnosticsCommand must register a handler")();
			} finally {
				(vscode.window as Record<string, unknown>).showInformationMessage = origShowMessage;
				(vscode.commands as Record<string, unknown>).executeCommand = origExecute;
				(vscode.workspace as Record<string, unknown>).getConfiguration = origGetConfiguration;
			}

			return {
				message,
				options: dialogOptions,
				actions,
				executed,
				outputShown,
				subscriptionCount: subscriptions.length,
			};
		}

		test("registers a disposable on the extension context", async () => {
			const run = await runDiagnosticsCommand();

			assert.strictEqual(run.subscriptionCount, 1);
		});

		test("shows a modal message with all five actions", async () => {
			const run = await runDiagnosticsCommand();

			assert.deepStrictEqual(run.options, { modal: true });
			assert.deepStrictEqual(run.actions, [
				"View Output",
				"Test Connection",
				"Manage Servers",
				"Report Issue",
				"Help & Feedback",
			]);
		});

		test("a live group joined with its declared entry renders as one connected server", async () => {
			const lastChecked = "2026-07-26T01:02:03.000Z";
			const run = await runDiagnosticsCommand({
				snapshots: [
					makeSnapshot({
						serverId: "group:fp:http://x.test",
						label: "x.test",
						baseUrl: "http://x.test",
						modelCount: 3,
						lastChecked,
					}),
				],
				declared: [
					makeDeclared({ label: "Fake", baseUrl: "http://x.test", expectedClientId: "group:fp:http://x.test" }),
				],
			});

			assert.ok(run.message.includes("Servers Configured: 1"), run.message);
			assert.ok(run.message.includes("Connection Status: Connected (3 models)"), run.message);
			assert.ok(run.message.includes(`Last Checked: ${new Date(lastChecked).toLocaleString()}`), run.message);
			assert.ok(run.message.includes("  Fake: OK (3 models)"), "the declared label names the row");
			assert.ok(run.message.includes("    URL: http://x.test"), run.message);
			assert.ok(!run.message.includes("Legacy Registry"), "an empty registry earns no legacy line");
		});

		test("reports not configured when nothing is configured anywhere", async () => {
			const run = await runDiagnosticsCommand();

			assert.ok(run.message.includes("Servers Configured: 0"), run.message);
			assert.ok(run.message.includes("Connection Status: Not configured"), run.message);
			assert.ok(run.message.includes("Last Checked: Never"), run.message);
			assert.ok(!run.message.includes("Server Details:"), run.message);
			assert.ok(!run.message.includes("Legacy Registry"), run.message);
		});

		test("a declared entry no discovery pass has seen renders as waiting", async () => {
			const run = await runDiagnosticsCommand({
				declared: [makeDeclared({ label: "New", baseUrl: "http://new.test" })],
			});

			assert.ok(run.message.includes("Servers Configured: 1"), run.message);
			assert.ok(run.message.includes("Connection Status: Waiting for first sync"), run.message);
			assert.ok(run.message.includes("Last Checked: Never"), run.message);
			assert.ok(run.message.includes("  New: Not checked yet"), run.message);
		});

		test("a declared entry whose group upsert failed renders its sync error", async () => {
			const run = await runDiagnosticsCommand({
				declared: [makeDeclared({ label: "Broken", baseUrl: "http://broken.test", syncError: "upsert refused" })],
			});

			assert.ok(run.message.includes("Connection Status: Error: upsert refused"), run.message);
			assert.ok(run.message.includes("  Broken: Error: upsert refused"), run.message);
		});

		test("an unresolved declared entry still joins its live group by base URL", async () => {
			const run = await runDiagnosticsCommand({
				snapshots: [
					makeSnapshot({
						serverId: "group:fp:http://x.test",
						label: "x.test",
						baseUrl: "http://x.test/",
						modelCount: 2,
					}),
				],
				declared: [makeDeclared({ label: "Fake", baseUrl: "http://x.test" })],
			});

			assert.ok(run.message.includes("Servers Configured: 1"), "the joined pair must not double-count");
			assert.ok(run.message.includes("  Fake: OK (2 models)"), run.message);
		});

		test("before the first sync pass, declared entries come straight from the setting", async () => {
			const run = await runDiagnosticsCommand({
				serversSetting: [{ label: "Declared", baseUrl: "http://d.test" }],
			});

			assert.ok(run.message.includes("Servers Configured: 1"), run.message);
			assert.ok(run.message.includes("Connection Status: Waiting for first sync"), run.message);
			assert.ok(run.message.includes("  Declared: Not checked yet"), run.message);
		});

		test("a reachable server whose upsert failed shows both the models and the sync error", async () => {
			const run = await runDiagnosticsCommand({
				snapshots: [
					makeSnapshot({
						serverId: "group:fp:http://x.test",
						label: "x.test",
						baseUrl: "http://x.test",
						modelCount: 2,
					}),
				],
				declared: [
					makeDeclared({
						label: "Fake",
						baseUrl: "http://x.test",
						expectedClientId: "group:fp:http://x.test",
						syncError: "upsert refused",
					}),
				],
			});

			assert.ok(run.message.includes("Connection Status: Connected (2 models)"), run.message);
			assert.ok(run.message.includes("  Fake: OK (2 models) - upsert refused"), run.message);
		});

		test("the dialog never renders a transient loading verdict", async () => {
			// The old status-bar-backed "Loading..." state was removed on purpose:
			// invoked mid-first-refresh, the dialog now says what is actually known
			// (declared entries waiting for their first sync) instead of a stale
			// persisted loading claim.
			const run = await runDiagnosticsCommand({
				declared: [makeDeclared()],
				status: { state: "loading" },
			});

			assert.ok(!run.message.includes("Loading"), run.message);
			assert.ok(run.message.includes("Connection Status: Waiting for first sync"), run.message);
		});

		test("a legacy-only registry cold start renders the registry, not a not-configured claim", async () => {
			const registry = createRegistry();
			await registry.addServer("Prod", "http://prod.test", "");
			const run = await runDiagnosticsCommand({ registry, status: { state: "loading" } });

			assert.ok(run.message.includes("Servers Configured: 0"), run.message);
			assert.ok(run.message.includes("Connection Status: Legacy registry only (1 server)"), run.message);
			assert.ok(!run.message.includes("Not configured"), run.message);
			assert.ok(run.message.includes("  Prod: http://prod.test"), "the configured list renders before any sweep");
		});

		test("a legacy-only registry with sweep results renders their outcomes and timestamp", async () => {
			const registry = createRegistry();
			await registry.addServer("Prod", "http://prod.test", "");
			await registry.addServer("Backup", "http://backup.test", "");
			const lastChecked = "2026-07-26T01:02:03.000Z";
			const run = await runDiagnosticsCommand({
				registry,
				status: {
					state: "degraded",
					totalModels: 4,
					lastChecked,
					serverStatuses: [
						makeServerStatus(),
						makeServerStatus({
							serverId: "srv2",
							label: "Backup",
							baseUrl: "http://backup.test",
							state: "error",
							error: "connection refused",
						}),
					],
				},
			});

			assert.ok(run.message.includes("Connection Status: Legacy registry only (2 servers)"), run.message);
			assert.ok(run.message.includes(`Last Checked: ${new Date(lastChecked).toLocaleString()}`), run.message);
			assert.ok(run.message.includes("  Prod: OK (4 models)"), run.message);
			assert.ok(run.message.includes("  Backup: Error: connection refused"), run.message);
		});

		test("the legacy path ignores a previous session's group statuses and falls back to the configured list", async () => {
			const registry = createRegistry();
			await registry.addServer("Prod", "http://prod.test", "");
			const run = await runDiagnosticsCommand({
				registry,
				// A stale status for a server no longer in the registry (a prior
				// session's provider group); it must not render as a legacy row.
				status: {
					state: "connected",
					totalModels: 9,
					serverStatuses: [
						makeServerStatus({ serverId: "group:1:http://gone.test", label: "gone.test", baseUrl: "http://gone.test" }),
					],
				},
			});

			assert.ok(!run.message.includes("gone.test"), "a status outside the current registry must not render");
			assert.ok(run.message.includes("  Prod: http://prod.test"), "with no matching status it falls back to the list");
		});

		// Junk persisted status elements never reach this command anymore: the
		// status bar's normalizing restore drops them at the persistence trust
		// boundary (pinned in status.test.ts), so ConnectionStatus values here
		// only ever carry real ServerStatus elements.

		test("a partial sweep renders outcomes where known and listings for the rest", async () => {
			const registry = createRegistry();
			await registry.addServer("Prod", "http://prod.test", "");
			await registry.addServer("Backup", "http://backup.test", "");
			const run = await runDiagnosticsCommand({
				registry,
				// Only one of the two registry servers has a persisted outcome; the
				// other must still get its configured listing instead of vanishing
				// while the header counts it.
				status: { state: "connected", totalModels: 4, serverStatuses: [makeServerStatus()] },
			});

			assert.ok(run.message.includes("Connection Status: Legacy registry only (2 servers)"), run.message);
			assert.ok(run.message.includes("  Prod: OK (4 models)"), run.message);
			assert.ok(run.message.includes("  Backup: http://backup.test"), "the unswept server still renders as a listing");
		});

		test("live groups without declared entries still count", async () => {
			const run = await runDiagnosticsCommand({
				snapshots: [
					makeSnapshot({ serverId: "group:1:http://prod.test", label: "prod.test", modelCount: 4 }),
					makeSnapshot({
						serverId: "group:2:http://local.test",
						label: "local.test",
						baseUrl: "http://local.test",
						modelCount: 2,
					}),
				],
			});

			assert.ok(run.message.includes("Servers Configured: 2"), run.message);
			assert.ok(run.message.includes("Connection Status: Connected (6 models)"), run.message);
			assert.ok(run.message.includes("  prod.test: OK (4 models)"), run.message);
			assert.ok(run.message.includes("  local.test: OK (2 models)"), run.message);
		});

		test("one failing server among reachable ones renders degraded with the failure detail", async () => {
			const run = await runDiagnosticsCommand({
				snapshots: [
					makeSnapshot({ serverId: "group:1:http://prod.test", label: "prod.test", modelCount: 4 }),
					makeSnapshot({
						serverId: "group:2:http://backup.test",
						label: "backup.test",
						baseUrl: "http://backup.test",
						state: "error",
						error: "connection refused",
					}),
				],
			});

			assert.ok(run.message.includes("Connection Status: Degraded (4 models, some servers failed)"), run.message);
			assert.ok(run.message.includes("  backup.test: Error: connection refused"), run.message);
			assert.ok(run.message.includes("    URL: http://backup.test"), run.message);
		});

		test("every server failing renders the first error as the status", async () => {
			const run = await runDiagnosticsCommand({
				snapshots: [
					makeSnapshot({
						serverId: "group:1:http://prod.test",
						state: "error",
						error: "connection refused",
					}),
				],
			});

			assert.ok(run.message.includes("Connection Status: Error: connection refused"), run.message);
		});

		test("the legacy registry gets its extra line only while it holds entries", async () => {
			const registry = createRegistry();
			await registry.addServer("Old", "http://old.test", "");
			const run = await runDiagnosticsCommand({
				registry,
				snapshots: [makeSnapshot({ serverId: "group:1:http://prod.test", label: "prod.test", modelCount: 2 })],
			});

			assert.ok(run.message.includes("Legacy Registry Servers: 1"), run.message);
			assert.ok(
				run.message.includes("Servers Configured: 1"),
				"legacy entries stay out of the count the dashboard shows"
			);
		});

		test("a legacy server already shown as a snapshot row earns no duplicate legacy line", async () => {
			const registry = createRegistry();
			// Same base URL as the live snapshot below: after a sweep the registry
			// server surfaces as an external row, so it must not also be counted on
			// the Legacy Registry Servers line.
			await registry.addServer("Prod", "http://prod.test", "");
			const run = await runDiagnosticsCommand({
				registry,
				snapshots: [makeSnapshot({ serverId: "group:1:http://prod.test", label: "prod.test", modelCount: 3 })],
			});

			assert.ok(run.message.includes("Servers Configured: 1"), run.message);
			assert.ok(!run.message.includes("Legacy Registry Servers"), "the overlapping server is stated once, not twice");
		});

		test("View Output shows the output channel without running a command", async () => {
			const run = await runDiagnosticsCommand({ choice: "View Output" });

			assert.strictEqual(run.outputShown, true);
			assert.deepStrictEqual(run.executed, []);
		});

		const delegatingActions: ReadonlyArray<[string, string]> = [
			["Test Connection", "litellm.testConnection"],
			["Manage Servers", "litellm.manageServers"],
			["Report Issue", "litellm.reportIssue"],
			["Help & Feedback", "litellm.helpAndFeedback"],
		];

		for (const [action, commandId] of delegatingActions) {
			test(`${action} delegates to ${commandId}`, async () => {
				const run = await runDiagnosticsCommand({ choice: action });

				assert.deepStrictEqual(run.executed, [commandId]);
				assert.strictEqual(run.outputShown, false);
			});
		}

		test("dismissing the dialog does nothing", async () => {
			const run = await runDiagnosticsCommand();

			assert.deepStrictEqual(run.executed, []);
			assert.strictEqual(run.outputShown, false);
		});
	});
});
