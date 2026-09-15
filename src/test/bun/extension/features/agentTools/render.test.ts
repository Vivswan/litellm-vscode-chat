/**
 * The agent-tools text shaping: what a model reads back. Pinned as whole
 * outputs, because a shaped reply that drops a section or echoes an
 * unredacted response body fails only in the agent's context window, where
 * no test would notice.
 */
import { describe, expect, test } from "bun:test";
import type { AgentRequest } from "../../../../../extension/features/agentTools/planner";
import {
	describeRecordChange,
	describeServerChange,
	renderJson,
	shapeConfiguration,
	shapeDiagnostics,
	shapeSubmission,
} from "../../../../../extension/features/agentTools/render";
import type { DiagnosticsSnapshot } from "../../../../../extension/ui/issueReporter";
import { markLogSafe } from "../../../../../shared/logger";
import type { ServerStatus } from "../../../../../shared/servers";
import { makeDeclaredServer, makeExternalServer, makeState } from "../../../webview/fixtures";
import { agentToolsState } from "./fixture";

const state = agentToolsState();

const NO_SECRETS = { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" } as const;

// A marker, not a key shape: the leak scanner must not trip on the test fixture itself.
const LEAKED_MARKER = "bearer-marker-9f8e7d";
const redact = (text: string): string => text.replaceAll(LEAKED_MARKER, "[redacted]");

describe("agentTools render", () => {
	// Drifts silently: a server row's error is the transport's display text
	// and embeds the response body, which can echo the request's own
	// Authorization header; the row must pass through the report's redaction.
	test("a server row in error comes out of shapeConfiguration with both error texts redacted", () => {
		const failing = makeState({
			servers: [
				makeExternalServer({
					label: "Leaky",
					state: "error",
					error: `401: Authorization: Bearer ${LEAKED_MARKER} rejected`,
					errorEnglish: `401 for Authorization: Bearer ${LEAKED_MARKER}`,
				}),
			],
		});
		const shaped = shapeConfiguration(failing, ["servers"], redact);
		expect(JSON.stringify(shaped)).not.toContain(LEAKED_MARKER);
		expect(shaped.servers).toEqual([
			{
				...failing.servers[0],
				error: "401: Authorization: Bearer [redacted] rejected",
				errorEnglish: "401 for Authorization: Bearer [redacted]",
			},
		]);
	});

	// Drifts silently: a probe failure's message carries the transport error,
	// so a fail reply echoed verbatim hands the agent the response body.
	test("a fail reply's message is redacted by shapeSubmission", () => {
		const request: AgentRequest = { method: "testServerDraft", payload: null };
		const shaped = shapeSubmission(
			request,
			{
				outcome: "validation-error",
				reply: {
					kind: "fail",
					id: "x",
					method: "testServerDraft",
					message: `Probe failed: Authorization: Bearer ${LEAKED_MARKER}`,
					failureKind: "operation",
					classification: { kind: "auth", status: 401 },
				},
			},
			redact
		);
		expect(shaped).toEqual({
			method: "testServerDraft",
			ok: false,
			failureKind: "operation",
			message: "Probe failed: Authorization: Bearer [redacted]",
			classification: { kind: "auth", status: 401 },
		});
	});

	const snapshot: DiagnosticsSnapshot = {
		extensionVersion: "0.6.4",
		vscodeVersion: "1.104.0",
		platform: "darwin",
		connectionState: "connected",
		modelCount: 2,
		apiKeyConfigured: true,
		baseUrlConfigured: true,
		featureFlags: {
			inlineCompletions: { enabled: false, modelConfigured: false },
			commitGeneration: { enabled: true, modelConfigured: true },
			prGeneration: { enabled: false, modelConfigured: false },
			consultTool: { enabled: false, modelConfigured: false },
			quickFix: { enabled: false, modelConfigured: false },
			reviewComments: { enabled: false, modelConfigured: false },
			chatParticipant: { enabled: true },
			agentTools: { enabled: true },
		},
		mcpEntryCount: 1,
		latestError: {
			source: "discovery",
			message: `401 for ${LEAKED_MARKER}`,
			stack: `stack ${LEAKED_MARKER}`,
			timestamp: "2026-09-14T00:00:00Z",
			classification: { kind: "auth", status: 401 },
		},
		recentLogs: [`sent ${LEAKED_MARKER}`, "plain line"],
	};
	const servers: readonly ServerStatus[] = [
		{
			serverId: "prod",
			label: "Prod",
			baseUrl: "http://prod.test",
			lastChecked: "t1",
			servedModelCount: 2,
			hasApiKey: true,
			state: "ok",
			hiddenByRemoval: false,
		},
		{
			serverId: "dev",
			label: "Dev",
			baseUrl: "http://dev.test",
			lastChecked: "t2",
			servedModelCount: 1,
			state: "error",
			error: `body mentions ${LEAKED_MARKER}`,
			logSafeError: markLogSafe("auth"),
			classification: { kind: "auth", status: 401 },
			expected: false,
			declaredModelCount: 1,
		},
	];

	// Drifts silently: a response-derived string (server error, latest error,
	// log line) reaching the agent without the issue reporter's redaction, or
	// the stack, which the report itself never includes, riding along.
	test.each([
		["with logs", true, 3],
		["without logs", false, 2],
	])(
		"shapeDiagnostics %s redacts every response-derived string and carries no stack",
		(_name, includeLogs, redactions) => {
			const shaped = shapeDiagnostics(snapshot, servers, state.diagnostics, redact, includeLogs);
			const text = JSON.stringify(shaped);
			expect(text).not.toContain(LEAKED_MARKER);
			expect(text).not.toContain("stack");
			expect(text.split("[redacted]").length - 1).toBe(redactions);
			expect("recentLogs" in shaped).toBe(includeLogs);
			expect(shaped.servers).toEqual([
				{
					label: "Prod",
					baseUrl: "http://prod.test",
					state: "ok",
					servedModelCount: 2,
					lastChecked: "t1",
					hasApiKey: true,
					hasOAuth: undefined,
					hiddenByRemoval: false,
					modelInfoUnsupported: undefined,
				},
				{
					label: "Dev",
					baseUrl: "http://dev.test",
					state: "error",
					servedModelCount: 1,
					lastChecked: "t2",
					hasApiKey: undefined,
					hasOAuth: undefined,
					error: "body mentions [redacted]",
					classification: { kind: "auth", status: 401 },
					expected: false,
					declaredModelCount: 1,
				},
			]);
			expect(shaped.latestError).toEqual({
				source: "discovery",
				timestamp: "2026-09-14T00:00:00Z",
				classification: { kind: "auth", status: 401 },
				message: "401 for [redacted]",
			});
		}
	);

	// Drifts silently: the dashboard accepts "http://alice:pw@host" as a base
	// URL, so a configuration read or a save card would hand the agent the
	// password with no error anywhere. Every URL-shaped string in a value is
	// rebuilt before it renders, so nested fields and card values are covered.
	test("a base URL's userinfo never reaches a rendered result or card", () => {
		// A password with a space defeats the text scrub (it stops at whitespace);
		// the URL fields are rebuilt from parsed components instead.
		const secret = "url secret 57";
		const withCredentials = `http://alice:${secret}@localhost:4000`;
		const tokenUrl = `https://bob:${secret}@idp.test/token`;
		// Nested as a declared row's config nests them: the token URL and the
		// MCP URL sit below the row, where a top-level field scrub would miss them.
		const credState = makeState({
			servers: [
				makeExternalServer({ label: "Cred", baseUrl: withCredentials }),
				makeDeclaredServer({
					label: "Oauth",
					baseUrl: "http://oauth.test",
					config: {
						secrets: { kind: "proven", locations: NO_SECRETS },
						oauthTokenUrl: tokenUrl,
						mcp: { url: tokenUrl },
					},
				}),
			],
		});
		const configuration = renderJson(shapeConfiguration(credState, ["servers"], (text) => text));
		expect(configuration).not.toContain(secret);
		expect(configuration).toContain("http://localhost:4000");
		expect(configuration).toContain("https://idp.test/token");
		const card = describeServerChange(
			"Cred",
			{ baseUrl: "http://old.test" },
			{ baseUrl: withCredentials, oauthTokenUrl: tokenUrl, mcp: { url: tokenUrl } },
			[],
			[]
		);
		expect(card).not.toContain(secret);
		expect(card).toContain("//localhost:4000");
		// Dropping the credentials is itself a change: both sides display the
		// same host, and the card must still list the field.
		const dropCredentials = describeServerChange(
			"Cred",
			{ baseUrl: withCredentials },
			{ baseUrl: "http://localhost:4000" },
			[],
			[]
		);
		expect(dropCredentials).toContain("baseUrl:");
		expect(dropCredentials).not.toContain("(no field changes)");
		expect(dropCredentials).not.toContain(secret);
		// The rebuild is per string: a text-level pass over the serialized card
		// ran from one field's "//" to the next field's "@" and ate the JSON
		// between, showing the wrong webhook and hiding the email.
		const neighbours = describeRecordChange(
			"parameters",
			"m",
			undefined,
			{ webhook: "https://hooks.example", email: "user@example.com" },
			"global settings"
		);
		expect(neighbours).toContain('"webhook":"https://hooks.example"');
		expect(neighbours).toContain('"email":"user@example.com"');
	});
});
