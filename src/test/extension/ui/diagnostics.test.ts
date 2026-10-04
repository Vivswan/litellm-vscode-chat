import * as assert from "node:assert";
import { buildDiagnosticsSnapshot } from "../../../extension/ui/diagnostics";
import type { DiagnosticsSnapshot } from "../../../extension/ui/issueReporter";
import { IssueReporter } from "../../../extension/ui/issueReporter";
import type { ConnectionStatus } from "../../../extension/ui/status";
import { markLogSafe, recordedError } from "../../../shared/logger";
import { expectDefined } from "../../pureHelpers";
import { makeServerStatus, withConfig } from "../../testUtils";

//   The interactive diagnostics surface is the dashboard's Diagnostics tab
//     -> what remains here is the issue reporter's snapshot
suite("extension/ui/diagnostics", () => {
	suite("buildDiagnosticsSnapshot", () => {
		test("collects environment, connection, and reporter data", async () => {
			const reporter = new IssueReporter();
			reporter.appendLog("first log line");
			reporter.appendLog("second log line");
			reporter.recordError("discovery", recordedError(new Error("fetch exploded")));

			// Non-default configuration on every settings-derived field, through the same getConfiguration surface the
			// snapshot reads (withConfig restores it in its finally): a build that hardcoded the defaults must fail
			// here. Unset features keep their package.json defaults.
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

			// The whole record: this snapshot prefills public issues, so a field added to DiagnosticsSnapshot must be
			// seen here before it ships.
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
				// A secure key cannot be ruled out without a group report.
				apiKeyConfigured: "unknown",
				baseUrlConfigured: true,
				// Flags only, never the model or label the configured ref names; the participant carries no model flag
				// by construction.
				featureFlags: {
					inlineCompletions: { enabled: false, modelConfigured: false },
					commitGeneration: { enabled: true, modelConfigured: true },
					prGeneration: { enabled: false, modelConfigured: false },
					consultTool: { enabled: false, modelConfigured: false },
					quickFix: { enabled: false, modelConfigured: false },
					reviewComments: { enabled: false, modelConfigured: false },
					chatParticipant: { enabled: false },
					agentTools: { enabled: false },
				},
				// The opted-in entry counts; the plain one does not.
				mcpEntryCount: 1,
				virtualKeyHeaders: [],
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
			// Duck-typed like a transport RequestError: transportClassificationOf reads kind/status/setupHint off any
			// thrown value.
			reporter.recordError(
				"discovery",
				recordedError(
					Object.assign(new Error("connect ECONNREFUSED"), { kind: "connection", setupHint: "proxy-not-running" })
				)
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

		// The observed statuses empty out during a Test Connection pass, and a report built in that window once denied
		// a configured server (#389).
		const presenceCases: readonly {
			readonly name: string;
			readonly servers: readonly Record<string, unknown>[];
			readonly status: ConnectionStatus;
			readonly expected: Pick<DiagnosticsSnapshot, "baseUrlConfigured" | "apiKeyConfigured">;
		}[] = [
			{
				name: "nothing declared, nothing observed",
				servers: [],
				status: { state: "not-configured" },
				expected: { baseUrlConfigured: false, apiKeyConfigured: "unknown" },
			},
			{
				name: "a declared entry whose group has not reported yet (#389)",
				servers: [{ label: "Prod", baseUrl: "http://prod.test" }],
				status: { state: "connecting", attention: false },
				expected: { baseUrlConfigured: true, apiKeyConfigured: "unknown" },
			},
			{
				name: "a declared entry with an inline key proves the key before any report",
				servers: [{ label: "Prod", baseUrl: "http://prod.test", auth: { apiKey: "sk-inline" } }],
				status: { state: "connecting", attention: false },
				expected: { baseUrlConfigured: true, apiKeyConfigured: true },
			},
			{
				name: "an observed group with a key, nothing declared",
				servers: [],
				status: {
					state: "connected",
					totalModels: 4,
					serverStatuses: [makeServerStatus({ serverId: "group:abc:http://prod.test", hasApiKey: true })],
				},
				expected: { baseUrlConfigured: true, apiKeyConfigured: true },
			},
			{
				name: "an observed keyless group with nothing declared denies the key",
				servers: [],
				status: {
					state: "connected",
					totalModels: 4,
					serverStatuses: [makeServerStatus({ serverId: "group:abc:http://prod.test", hasApiKey: false })],
				},
				expected: { baseUrlConfigured: true, apiKeyConfigured: false },
			},
			{
				name: "a declared OAuth unit counts as configured authentication before any report",
				servers: [
					{
						label: "Prod",
						baseUrl: "http://prod.test",
						auth: { oauth: { tokenUrl: "https://idp.test/token", clientId: "c1", clientSecret: "shh" } },
					},
				],
				status: { state: "connecting", attention: false },
				expected: { baseUrlConfigured: true, apiKeyConfigured: true },
			},
			{
				name: "the declared entry's own keyless report denies the key",
				servers: [{ label: "Prod", baseUrl: "http://prod.test" }],
				status: {
					state: "connected",
					totalModels: 4,
					serverStatuses: [
						makeServerStatus({ serverId: "group:abc:http://prod.test", entryLabel: "Prod", hasApiKey: false }),
					],
				},
				expected: { baseUrlConfigured: true, apiKeyConfigured: false },
			},
			{
				name: "a keyless report for one of two declared entries leaves the key open",
				servers: [
					{ label: "Prod", baseUrl: "http://prod.test" },
					{ label: "Staging", baseUrl: "http://staging.test" },
				],
				status: {
					state: "connected",
					totalModels: 4,
					serverStatuses: [
						makeServerStatus({ serverId: "group:abc:http://prod.test", entryLabel: "Prod", hasApiKey: false }),
					],
				},
				expected: { baseUrlConfigured: true, apiKeyConfigured: "unknown" },
			},
			{
				name: "an unlabeled group's host display label is not the entry's own report",
				servers: [{ label: "prod.test", baseUrl: "http://prod.test" }],
				status: {
					state: "connected",
					totalModels: 4,
					serverStatuses: [
						makeServerStatus({ serverId: "group:abc:http://prod.test", label: "prod.test", hasApiKey: false }),
					],
				},
				expected: { baseUrlConfigured: true, apiKeyConfigured: "unknown" },
			},
			{
				name: "a report without a key verdict leaves the key open",
				servers: [{ label: "Prod", baseUrl: "http://prod.test" }],
				status: {
					state: "connected",
					totalModels: 4,
					serverStatuses: [makeServerStatus({ serverId: "group:abc:http://prod.test", entryLabel: "Prod" })],
				},
				expected: { baseUrlConfigured: true, apiKeyConfigured: "unknown" },
			},
			{
				name: "an inline key outranks the entry's own keyless report",
				servers: [{ label: "Prod", baseUrl: "http://prod.test", auth: { apiKey: "sk-inline" } }],
				status: {
					state: "connected",
					totalModels: 4,
					serverStatuses: [
						makeServerStatus({ serverId: "group:abc:http://prod.test", entryLabel: "Prod", hasApiKey: false }),
					],
				},
				expected: { baseUrlConfigured: true, apiKeyConfigured: true },
			},
		];
		for (const { name, servers, status, expected } of presenceCases) {
			test(`configuration presence: ${name}`, async () => {
				const snapshot = await withConfig({ servers }, () =>
					buildDiagnosticsSnapshot(status, "1.2.3", "9.9.9", new IssueReporter())
				);
				assert.deepStrictEqual(
					{ baseUrlConfigured: snapshot.baseUrlConfigured, apiKeyConfigured: snapshot.apiKeyConfigured },
					expected
				);
			});
		}
	});
});
