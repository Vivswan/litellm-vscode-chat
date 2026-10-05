/**
 * Pinned as whole outputs, because a shaped reply that drops a section or echoes an unredacted response body fails only
 * in the agent's context window, where no test would notice.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as l10n from "@vscode/l10n";
import type { AgentRequest } from "../../../../../extension/features/agentTools/planner";
import {
	describeAdoption,
	describeRecordChange,
	describeServerChange,
	describeSettingChange,
	renderJson,
	shapeConfiguration,
	shapeDiagnostics,
	shapeSubmission,
} from "../../../../../extension/features/agentTools/render";
import type { DiagnosticsSnapshot } from "../../../../../extension/ui/issueReporter";
import { markLogSafe } from "../../../../../shared/logger";
import type { ServerStatus } from "../../../../../shared/servers";
import { REPO_ROOT } from "../../../../util/repoRoot";
import { makeDeclaredServer, makeExternalServer, makeState } from "../../../webview/fixtures";
import { agentToolsState } from "./fixture";

const state = agentToolsState();

const NO_SECRETS = { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" } as const;

// A marker, not a key shape: the leak scanner must not trip on the test fixture itself.
const LEAKED_MARKER = "bearer-marker-9f8e7d";
const redact = (text: string): string => text.replaceAll(LEAKED_MARKER, "[redacted]");

describe("agentTools render", () => {
	// The rows carry a failure as a cause key and no text; the agent reads the English rendering beside the key, so the
	// result can never carry a response body (and nothing is left to redact).
	test("a server row in error comes out of shapeConfiguration with its cause rendered in English beside the key", () => {
		const failing = makeState({
			servers: [
				makeExternalServer({
					label: "Leaky",
					state: "error",
					cause: { kind: "transport", classification: { kind: "auth", status: 401 } },
				}),
			],
		});
		const shaped = shapeConfiguration(failing, ["servers"]);
		expect(shaped.servers).toEqual([
			{ ...failing.servers[0], error: "Authentication failed for http://copilot.example:4000" },
		]);
	});

	// Drifts silently: a probe failure's message carries the transport error, so a fail reply echoed verbatim hands the
	// agent the response body.
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
			// A virtual-key-only entry: the kind rides beside the presence, or the agent reads a static API key.
			hasApiKey: true,
			hasVirtualKey: true,
			state: "error",
			cause: { kind: "transport", classification: { kind: "auth", status: 401 } },
			logSafeError: markLogSafe("auth"),
			expected: false,
			declaredModelCount: 1,
		},
	];

	//   Drifts silently -> a response-derived string (latest error, log line) reaching the agent without the issue
	//                      reporter's redaction, or the stack; a server row carries its cause, which renders in English
	test.each([
		["with logs", true, 2],
		["without logs", false, 1],
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
					hasVirtualKey: undefined,
					hiddenByRemoval: false,
					modelInfoUnsupported: undefined,
				},
				{
					label: "Dev",
					baseUrl: "http://dev.test",
					state: "error",
					servedModelCount: 1,
					lastChecked: "t2",
					hasApiKey: true,
					hasOAuth: undefined,
					hasVirtualKey: true,
					error: "Authentication failed for http://dev.test",
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

	// Drifts silently: the dashboard accepts "http://alice:pw@host" as a base URL, so a configuration read or a save
	// card would hand the agent the password with no error anywhere.
	test("a base URL's userinfo never reaches a rendered result or card", () => {
		// A password with a space defeats the text scrub (it stops at whitespace); the URL fields are rebuilt from
		// parsed components instead.
		const secret = "url secret 57";
		const withCredentials = `http://alice:${secret}@localhost:4000`;
		const tokenUrl = `https://bob:${secret}@idp.test/token`;
		// Nested as a declared row's config nests them: the token URL and the MCP URL sit below the row, where a
		// top-level field scrub would miss them.
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
		const configuration = renderJson(shapeConfiguration(credState, ["servers"]));
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
		// Dropping the credentials is itself a change: both sides display the same host, and the card must still list
		// the field.
		const dropCredentials = describeServerChange(
			"Cred",
			{ baseUrl: withCredentials },
			{ baseUrl: "http://localhost:4000" },
			[],
			[]
		);
		expect(dropCredentials).toContain("baseUrl:");
		expect(dropCredentials).toMatch(
			/baseUrl: "http:\/\/localhost:4000" \(carries text the card does not show[^\n]*-> "http:\/\/localhost:4000"/
		);
		// A value that stores credentials the card cannot show is annotated on every card kind, so accepting it is an
		// informed choice.
		const recordCard = describeRecordChange(
			"parameters",
			"m",
			undefined,
			{ webhook: withCredentials },
			"global settings"
		);
		expect(recordCard).toContain("(carries text the card does not show, such as URL credentials)");
		expect(recordCard).not.toContain(secret);
		const settingCard = describeSettingChange("usage.currencySymbol", "$", withCredentials, null);
		expect(settingCard).toContain("(carries text the card does not show, such as URL credentials)");
		const adoption = describeAdoption({ label: "Cred", baseUrl: withCredentials }, "Imported", {});
		expect(adoption).toContain("the stored URL carries credentials the card does not show");
		expect(adoption).not.toContain(secret);
		expect(describeAdoption({ label: "Plain", baseUrl: "http://plain.test" }, "Imported", {})).not.toContain(
			"carries credentials"
		);
		expect(dropCredentials).not.toContain("(no field changes)");
		expect(dropCredentials).not.toContain(secret);
		// One password replaced by another renders alike on both sides; the card still says the hidden text changed.
		const rotated = describeServerChange(
			"Cred",
			{ baseUrl: withCredentials },
			{ baseUrl: "http://alice:new-pass-99@localhost:4000" },
			[],
			[]
		);
		expect(rotated).toContain("(the hidden text changed)");
		expect(rotated).not.toContain("new-pass-99");
		expect(rotated).not.toContain(secret);
		// The rebuild is per string: a text-level pass over the serialized card ran from one field's "//" to the next
		// field's "@" and ate the JSON between, showing the wrong webhook and hiding the email.
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

	// Drifts silently: a record key is agent-written text; three backticks in it would close a fixed fence and let the
	// rest of the key forge the card the user approves.
	test("a card's fence outruns any backtick run in an agent-written key", () => {
		const card = describeRecordChange("parameters", "m", undefined, { note: "a\n```\nforged: yes" }, "global settings");
		const fence = card.slice(0, card.indexOf("\n"));
		expect(fence.length).toBeGreaterThanOrEqual(4);
		expect(card.endsWith(`\n${fence}`)).toBe(true);
	});

	// Drifts silently: the card is the text the user confirms, and a builder that froze its English at module scope or
	// skipped l10n shows an English card beside a localized invocation message only in a non-English window.
	test("a confirmation card renders in the configured locale, its label interpolated", () => {
		const zhCn = JSON.parse(readFileSync(path.join(REPO_ROOT, "l10n", "bundle.l10n.zh-cn.json"), "utf8")) as Record<
			string,
			string
		>;
		const card = () =>
			describeServerChange(
				"Prod",
				undefined,
				{ label: "Prod", baseUrl: "http://a.test" },
				[],
				[{ field: "oauthClientSecret", location: "secure" }]
			);
		l10n.config({ contents: zhCn });
		try {
			expect(card()).toBe(
				[
					"```",
					(zhCn['new servers entry "{0}"'] as string).replace("{0}", "Prod"),
					`baseUrl: ${zhCn["(absent)"]} -> "http://a.test"`,
					`label: ${zhCn["(absent)"]} -> "Prod"`,
					(zhCn["{0}: you will be asked to type it (stored in {1})"] as string)
						.replace("{0}", "oauthClientSecret")
						.replace("{1}", "secure"),
					"```",
				].join("\n")
			);
		} finally {
			l10n.config({ contents: {} });
		}
		expect(card()).toBe(
			[
				"```",
				'new servers entry "Prod"',
				'baseUrl: (absent) -> "http://a.test"',
				'label: (absent) -> "Prod"',
				"oauthClientSecret: you will be asked to type it (stored in secure)",
				"```",
			].join("\n")
		);
	});
});
