import * as assert from "node:assert";
import { ServerRegistry } from "../../../extension/servers/serverRegistry";
import { buildDiagnosticsSnapshot } from "../../../extension/ui/diagnostics";
import { IssueReporter } from "../../../extension/ui/issueReporter";
import { markLogSafe } from "../../../shared/logger";
import { expectDefined } from "../../pureHelpers";
import { makeExtensionStorage, makeServerStatus } from "../../testUtils";

function createRegistry(): ServerRegistry {
	const storage = makeExtensionStorage();
	return new ServerRegistry(storage.memento, storage.secrets);
}

// The interactive diagnostics surface is the dashboard's Diagnostics tab
// (pinned in extension/dashboard/panel.test.ts, dashboard/protocol.test.ts, and
// the webview suite); what remains here is the issue reporter's snapshot.
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
			assert.strictEqual(snapshot.commitGenerationEnabled, false, "the opt-in defaults off");
			assert.strictEqual(snapshot.commitGenerationModelConfigured, false, "no model ref is set by default");
			assert.strictEqual(snapshot.inlineCompletionsEnabled, false, "the inline opt-in defaults off");
			assert.strictEqual(snapshot.inlineCompletionsModelConfigured, false, "no inline model ref is set by default");
			assert.strictEqual(expectDefined(snapshot.latestError).source, "discovery");
			assert.strictEqual(expectDefined(snapshot.latestError).message, "fetch exploded");
			assert.deepStrictEqual(snapshot.recentLogs, ["first log line", "second log line"]);
		});

		test("the snapshot passes the latest error's classification through", async () => {
			const reporter = new IssueReporter();
			// Duck-typed like a transport RequestError: transportClassificationOf
			// reads kind/status/setupHint off any thrown value.
			reporter.recordError(
				"discovery",
				Object.assign(new Error("connect ECONNREFUSED"), { kind: "connection", setupHint: "proxy-not-running" })
			);

			const snapshot = await buildDiagnosticsSnapshot(
				createRegistry(),
				{ state: "error", error: "boom", logSafeError: markLogSafe("boom") },
				"1.2.3",
				"9.9.9",
				reporter
			);

			assert.deepStrictEqual(expectDefined(snapshot.latestError).classification, {
				kind: "connection",
				setupHint: "proxy-not-running",
			});
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
});
