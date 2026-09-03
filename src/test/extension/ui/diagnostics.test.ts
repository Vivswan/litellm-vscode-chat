import * as assert from "node:assert";
import { buildDiagnosticsSnapshot } from "../../../extension/ui/diagnostics";
import type { DiagnosticsSnapshot } from "../../../extension/ui/issueReporter";
import { IssueReporter } from "../../../extension/ui/issueReporter";
import { markLogSafe } from "../../../shared/logger";
import { expectDefined } from "../../pureHelpers";
import { makeServerStatus, withConfig } from "../../testUtils";

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

			// Non-default configuration on every settings-derived field, through
			// the same getConfiguration surface the snapshot reads (withConfig
			// restores it in its finally): a build that hardcoded the defaults
			// must fail here. Unset features keep their package.json defaults.
			const snapshot = await withConfig(
				{
					"commitGeneration.enabled": true,
					"commitGeneration.model": { server: "Prod", model: "gpt-4" },
					"chatParticipant.enabled": false,
					servers: [
						{ label: "Prod", baseUrl: "http://prod.test", mcp: true },
						{ label: "Plain", baseUrl: "http://plain.test" },
					],
				},
				() =>
					buildDiagnosticsSnapshot(
						{ state: "connected", totalModels: 7, serverStatuses: [] },
						"1.2.3",
						"9.9.9",
						reporter
					)
			);

			// The whole record: this snapshot prefills public issues, so a field
			// added to DiagnosticsSnapshot must be seen here before it ships. The
			// Required<> literal is total over the record, optional fields
			// included, and over FEATURE_IDS by construction. The error's
			// timestamp and stack are the run's own, so they are checked for
			// shape and read once into the expectation.
			const latestError = expectDefined(snapshot.latestError);
			assert.strictEqual(
				latestError.timestamp,
				new Date(latestError.timestamp).toISOString(),
				"the error timestamp is an ISO 8601 stamp"
			);
			assert.ok(latestError.stack?.startsWith("Error: fetch exploded"), "a plain error keeps its own stack");
			const expected: Required<DiagnosticsSnapshot> = {
				extensionVersion: "1.2.3",
				vscodeVersion: "9.9.9",
				platform: `${process.platform} ${process.arch}`,
				connectionState: "connected",
				modelCount: 7,
				// Unobserved native groups cannot be ruled out.
				apiKeyConfigured: "unknown",
				baseUrlConfigured: false,
				// Flags only, never the model or label the configured ref names;
				// the participant carries no model flag by construction.
				featureFlags: {
					inlineCompletions: { enabled: false, modelConfigured: false },
					commitGeneration: { enabled: true, modelConfigured: true },
					prGeneration: { enabled: false, modelConfigured: false },
					consultTool: { enabled: false, modelConfigured: false },
					quickFix: { enabled: false, modelConfigured: false },
					reviewComments: { enabled: false, modelConfigured: false },
					chatParticipant: { enabled: false },
				},
				// The opted-in entry counts; the plain one does not.
				mcpEntryCount: 1,
				latestError: {
					source: "discovery",
					message: "fetch exploded",
					stack: latestError.stack,
					timestamp: latestError.timestamp,
				},
				recentLogs: ["first log line", "second log line"],
			};
			assert.deepStrictEqual(snapshot, expected);
		});

		test("the snapshot passes the latest error's classification through", () => {
			const reporter = new IssueReporter();
			// Duck-typed like a transport RequestError: transportClassificationOf
			// reads kind/status/setupHint off any thrown value.
			reporter.recordError(
				"discovery",
				Object.assign(new Error("connect ECONNREFUSED"), { kind: "connection", setupHint: "proxy-not-running" })
			);

			const snapshot = buildDiagnosticsSnapshot(
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

		test("observed group statuses count as configuration", () => {
			const snapshot = buildDiagnosticsSnapshot(
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
			assert.strictEqual(snapshot.latestError, undefined);
			assert.deepStrictEqual(snapshot.recentLogs, []);
		});

		test("keyless groups configure a base URL but no API key", () => {
			const snapshot = buildDiagnosticsSnapshot(
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

		test("key presence is unknown until group statuses are observed", () => {
			const snapshot = buildDiagnosticsSnapshot({ state: "not-configured" }, "1.2.3", "9.9.9", new IssueReporter());

			assert.strictEqual(snapshot.baseUrlConfigured, false);
			assert.strictEqual(
				snapshot.apiKeyConfigured,
				"unknown",
				"a missing status window proves nothing about key presence"
			);
		});
	});
});
