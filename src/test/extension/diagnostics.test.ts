import * as assert from "node:assert";
import * as vscode from "vscode";
import { buildDiagnosticsSnapshot, registerDiagnosticsCommand } from "../../extension/diagnostics";
import { ServerRegistry } from "../../extension/serverRegistry";
import type { ConnectionStatus } from "../../extension/status";
import { IssueReporter } from "../../issueReporter";
import type { ServerStatus } from "../../shared/servers";
import { expectDefined, makeExtensionStorage } from "../testUtils";

function createRegistry(): ServerRegistry {
	const storage = makeExtensionStorage();
	return new ServerRegistry(storage.memento, storage.secrets);
}

function makeServerStatus(overrides: Partial<ServerStatus> = {}): ServerStatus {
	return {
		serverId: "srv1",
		label: "Prod",
		baseUrl: "http://prod.test",
		state: "ok",
		modelCount: 4,
		lastChecked: "2026-07-26T00:00:00.000Z",
		...overrides,
	};
}

suite("extension/diagnostics", () => {
	suite("buildDiagnosticsSnapshot", () => {
		test("collects environment, connection, and reporter data", async () => {
			const reporter = new IssueReporter();
			reporter.appendLog("first log line");
			reporter.appendLog("second log line");
			reporter.recordError("discovery", new Error("fetch exploded"));

			const snapshot = await buildDiagnosticsSnapshot(
				createRegistry(),
				{ state: "connected", totalModels: 7 },
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
				{ state: "connected", totalModels: 1 },
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
				{ state: "error", error: "boom" },
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

		test("junk elements in a persisted status do not crash the snapshot", async () => {
			// The status loader deliberately tolerates arbitrary array elements
			// from older extension versions.
			const junkStatus = {
				state: "connected",
				totalModels: 1,
				serverStatuses: [42, null, makeServerStatus({ serverId: "group:abc:http://prod.test", hasApiKey: true })],
			} as unknown as ConnectionStatus;

			const snapshot = await buildDiagnosticsSnapshot(
				createRegistry(),
				junkStatus,
				"1.2.3",
				"9.9.9",
				new IssueReporter()
			);

			assert.strictEqual(snapshot.baseUrlConfigured, true, "the valid group entry must still be recognized");
			assert.strictEqual(snapshot.apiKeyConfigured, true);
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

		// The activated extension already owns the litellm.showDiagnostics command
		// ID, so the handler is captured through a stubbed registerCommand and
		// invoked directly instead of going through executeCommand.
		async function runDiagnosticsCommand(
			registry: ServerRegistry,
			status: ConnectionStatus,
			choice?: string
		): Promise<CommandRun> {
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
				registerDiagnosticsCommand(context, registry, () => status, outputChannel);
			} finally {
				(vscode.commands as Record<string, unknown>).registerCommand = origRegister;
			}

			let message = "";
			let options: vscode.MessageOptions | undefined;
			let actions: string[] = [];
			const executed: string[] = [];
			const origShowMessage = vscode.window.showInformationMessage;
			const origExecute = vscode.commands.executeCommand;
			(vscode.window as Record<string, unknown>).showInformationMessage = async (
				shownMessage: string,
				shownOptions: vscode.MessageOptions,
				...items: string[]
			) => {
				message = shownMessage;
				options = shownOptions;
				actions = items;
				return choice;
			};
			(vscode.commands as Record<string, unknown>).executeCommand = async (commandId: string) => {
				executed.push(commandId);
			};
			try {
				await expectDefined(handler, "registerDiagnosticsCommand must register a handler")();
			} finally {
				(vscode.window as Record<string, unknown>).showInformationMessage = origShowMessage;
				(vscode.commands as Record<string, unknown>).executeCommand = origExecute;
			}

			return { message, options, actions, executed, outputShown, subscriptionCount: subscriptions.length };
		}

		test("registers a disposable on the extension context", async () => {
			const run = await runDiagnosticsCommand(createRegistry(), { state: "not-configured" });

			assert.strictEqual(run.subscriptionCount, 1);
		});

		test("shows a modal message with all five actions", async () => {
			const run = await runDiagnosticsCommand(createRegistry(), { state: "not-configured" });

			assert.deepStrictEqual(run.options, { modal: true });
			assert.deepStrictEqual(run.actions, [
				"View Output",
				"Test Connection",
				"Manage Servers",
				"Report Issue",
				"Help & Feedback",
			]);
		});

		const statusTextCases: ReadonlyArray<[string, ConnectionStatus, string]> = [
			["not-configured", { state: "not-configured" }, "Connection Status: Not configured"],
			["loading", { state: "loading" }, "Connection Status: Loading..."],
			["connected", { state: "connected", totalModels: 5 }, "Connection Status: Connected (5 models)"],
			["connected without a count", { state: "connected" }, "Connection Status: Connected (0 models)"],
			[
				"degraded",
				{ state: "degraded", totalModels: 3 },
				"Connection Status: Degraded (3 models, some servers failed)",
			],
			["error", { state: "error", error: "boom" }, "Connection Status: Error: boom"],
			["error without a message", { state: "error" }, "Connection Status: Error: Unknown error"],
		];

		for (const [label, status, expectedLine] of statusTextCases) {
			test(`renders the ${label} state`, async () => {
				const run = await runDiagnosticsCommand(createRegistry(), status);

				assert.ok(run.message.includes(expectedLine), `expected "${expectedLine}" in message:\n${run.message}`);
			});
		}

		test("renders the last-checked timestamp as a locale string", async () => {
			const lastChecked = "2026-07-26T01:02:03.000Z";
			const run = await runDiagnosticsCommand(createRegistry(), { state: "connected", lastChecked });

			assert.ok(run.message.includes(`Last Checked: ${new Date(lastChecked).toLocaleString()}`));
		});

		test("renders Never when the status was never checked", async () => {
			const run = await runDiagnosticsCommand(createRegistry(), { state: "not-configured" });

			assert.ok(run.message.includes("Last Checked: Never"));
		});

		test("lists per-server results when server statuses exist", async () => {
			const status: ConnectionStatus = {
				state: "degraded",
				totalModels: 4,
				serverStatuses: [
					makeServerStatus(),
					makeServerStatus({
						serverId: "srv2",
						label: "Backup",
						baseUrl: "http://backup.test",
						state: "error",
						modelCount: 0,
						error: "connection refused",
					}),
				],
			};
			// A configured registry proves that statuses take precedence over the
			// configured-server fallback listing.
			const registry = createRegistry();
			await registry.addServer("Prod", "http://prod.test", "");
			const run = await runDiagnosticsCommand(registry, status);

			assert.ok(run.message.includes("Server Details:"));
			assert.ok(run.message.includes("  Prod: OK (4 models)"));
			assert.ok(!run.message.includes("  Prod: http://prod.test"), "The fallback listing must not render");
			assert.ok(run.message.includes("    URL: http://prod.test"));
			assert.ok(run.message.includes("  Backup: Error: connection refused"));
			assert.ok(run.message.includes("    URL: http://backup.test"));
		});

		test("a degraded status without a model count renders zero", async () => {
			const run = await runDiagnosticsCommand(createRegistry(), { state: "degraded" });
			assert.ok(run.message.includes("Degraded (0 models, some servers failed)"));
		});

		test("falls back to the configured server list when no statuses exist", async () => {
			const registry = createRegistry();
			await registry.addServer("Prod", "http://prod.test", "");
			const run = await runDiagnosticsCommand(registry, { state: "loading" });

			assert.ok(run.message.includes("Servers Configured: 1"));
			assert.ok(run.message.includes("Server Details:"));
			assert.ok(run.message.includes("  Prod: http://prod.test"));
		});

		test("omits server details when nothing is configured", async () => {
			const run = await runDiagnosticsCommand(createRegistry(), { state: "not-configured" });

			assert.ok(run.message.includes("Servers Configured: 0"));
			assert.ok(!run.message.includes("Server Details:"));
		});

		test("the server count includes observed group servers even with the flag unset", async () => {
			const status: ConnectionStatus = {
				state: "connected",
				totalModels: 6,
				serverStatuses: [
					makeServerStatus({ serverId: "group:1:http://prod.test", label: "prod.test", modelCount: 4 }),
					makeServerStatus({
						serverId: "group:2:http://local.test",
						label: "local.test",
						baseUrl: "http://local.test",
						modelCount: 2,
					}),
				],
			};
			const run = await runDiagnosticsCommand(createRegistry(), status);

			assert.ok(run.message.includes("Servers Configured: 2"), run.message);
			assert.ok(run.message.includes("  prod.test: OK (4 models)"), run.message);
			assert.ok(run.message.includes("  local.test: OK (2 models)"), run.message);
		});

		test("View Output shows the output channel without running a command", async () => {
			const run = await runDiagnosticsCommand(createRegistry(), { state: "not-configured" }, "View Output");

			assert.strictEqual(run.outputShown, true);
			assert.deepStrictEqual(run.executed, []);
		});

		const delegatingActions: ReadonlyArray<[string, string]> = [
			["Test Connection", "litellm.testConnection"],
			["Manage Servers", "litellm.manage"],
			["Report Issue", "litellm.reportIssue"],
			["Help & Feedback", "litellm.helpAndFeedback"],
		];

		for (const [action, commandId] of delegatingActions) {
			test(`${action} delegates to ${commandId}`, async () => {
				const run = await runDiagnosticsCommand(createRegistry(), { state: "not-configured" }, action);

				assert.deepStrictEqual(run.executed, [commandId]);
				assert.strictEqual(run.outputShown, false);
			});
		}

		test("dismissing the dialog does nothing", async () => {
			const run = await runDiagnosticsCommand(createRegistry(), { state: "not-configured" }, undefined);

			assert.deepStrictEqual(run.executed, []);
			assert.strictEqual(run.outputShown, false);
		});
	});
});
