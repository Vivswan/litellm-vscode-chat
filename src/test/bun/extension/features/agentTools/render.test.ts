/**
 * Pinned as whole outputs, because a shaped reply that drops a section fails only in the agent's context window, where
 * no test would notice.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as l10n from "@vscode/l10n";
import type { DashboardState } from "../../../../../dashboard/viewModels";
import type { AgentRequest } from "../../../../../extension/features/agentTools/planner";
import {
	CREDENTIAL_HEADER_PLACEHOLDER,
	describeAction,
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
import { Logger, markLogSafe } from "../../../../../shared/logger";
import type { ServerStatus } from "../../../../../shared/servers";
import { REPO_ROOT } from "../../../../util/repoRoot";
import { makeDeclaredServer, makeExternalServer, makeState } from "../../../webview/fixtures";
import { agentToolsState } from "./fixture";

const state = agentToolsState();

const NO_SECRETS = { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" } as const;

// A marker, not a key shape: the leak scanner must not trip on the test fixture itself.
const BODY_MARKER = "bearer-marker-9f8e7d";

describe("agentTools render", () => {
	test("renderJson and a fenced card body pass the output door whole: a registered value and a URL's userinfo mask", () => {
		const key = `sk-live-${"A".repeat(32)}`;
		Logger.registerSecrets([key]);
		expect(renderJson({ key, url: "http://bob:pw@hub.test/v1" })).toBe(
			'{\n  "key": "sk-liv...",\n  "url": "http://[redacted]@hub.test/v1"\n}'
		);
		expect(describeAction("remove", `Prod at http://bob:pw@hub.test with ${key}`)).toBe(
			"```\nremove: Prod at http://[redacted]@hub.test with sk-liv...\n```"
		);
	});

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

	// Drifts silently: the configuration read lands in the agent's context window, where no dashboard test would notice
	// a header value leaving.
	test("a configuration read hides every credential-bearing header value behind the placeholder, nothing else", () => {
		const headers = {
			"X-Team": "platform",
			Authorization: "Bearer header-marker-Q7",
			"X-Monkey": "tenant-marker-Q8",
		};
		const credentialed: DashboardState = {
			...state,
			servers: state.servers.map((server) =>
				server.origin === "declared" && server.label === "Prod"
					? { ...server, config: { ...server.config, virtualKeyHeader: "X-Monkey", headers } }
					: server
			),
		};
		const shaped = shapeConfiguration(credentialed, ["servers"]);
		expect(shaped).toEqual({
			servers: credentialed.servers.map((server) =>
				server.origin === "declared" && server.label === "Prod"
					? {
							...server,
							config: {
								...server.config,
								headers: {
									"X-Team": "platform",
									Authorization: CREDENTIAL_HEADER_PLACEHOLDER,
									"X-Monkey": CREDENTIAL_HEADER_PLACEHOLDER,
								},
							},
						}
					: server
			),
			servedModelCount: credentialed.servedModelCount,
		});
		const rendered = renderJson(shaped);
		expect(rendered).not.toContain("header-marker-Q7");
		expect(rendered).not.toContain("tenant-marker-Q8");
		expect(rendered).toContain("platform");
	});

	test("a fail reply's message comes out of shapeSubmission as the dashboard sent it", () => {
		const request: AgentRequest = { method: "testServerDraft", payload: null };
		const shaped = shapeSubmission(request, {
			outcome: "validation-error",
			reply: {
				kind: "fail",
				id: "x",
				method: "testServerDraft",
				message: `Probe failed: Authorization: Bearer ${BODY_MARKER}`,
				failureKind: "operation",
				classification: { kind: "auth", status: 401 },
			},
		});
		expect(shaped).toEqual({
			method: "testServerDraft",
			ok: false,
			failureKind: "operation",
			message: `Probe failed: Authorization: Bearer ${BODY_MARKER}`,
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
			message: `401 for ${BODY_MARKER}`,
			stack: `stack ${BODY_MARKER}`,
			timestamp: "2026-09-14T00:00:00Z",
			classification: { kind: "auth", status: 401 },
		},
		recentLogs: [`sent ${BODY_MARKER}`, "plain line"],
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

	//   Drifts silently -> the stack reaching the agent, or the log lines riding along unasked; a server row carries
	//                      its cause, which renders in English beside the row
	test.each([
		["with logs", true],
		["without logs", false],
	])("shapeDiagnostics %s carries the texts as logged, the cause rendered, and no stack", (_name, includeLogs) => {
		const shaped = shapeDiagnostics(snapshot, servers, state.diagnostics, includeLogs);
		const text = JSON.stringify(shaped);
		expect(text).not.toContain("stack");
		expect(shaped.recentLogs).toEqual(includeLogs ? snapshot.recentLogs : undefined);
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
			message: `401 for ${BODY_MARKER}`,
		});
	});

	// Drifts silently: a result or card reaches the agent's context window alone, where no test looks; every exit
	// passes the one output door, so the userinfo goes and the host stays.
	test("a base URL keeps its host and loses its userinfo in every result and card", () => {
		const withCredentials = "http://alice:url-secret-57@localhost:4000";
		const tokenUrl = "https://bob:url-secret-57@idp.test/token";
		const shownBase = "http://[redacted]@localhost:4000";
		const shownToken = "https://[redacted]@idp.test/token";
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
		const surfaces: readonly [name: string, rendered: string, expected: string][] = [
			["configuration read", renderJson(shapeConfiguration(credState, ["servers"])), shownBase],
			["configuration read, nested", renderJson(shapeConfiguration(credState, ["servers"])), shownToken],
			[
				"server card",
				describeServerChange("Cred", { baseUrl: "http://old.test" }, { baseUrl: withCredentials }, [], []),
				`baseUrl: "http://old.test" -> "${shownBase}"`,
			],
			[
				"record card",
				describeRecordChange("parameters", "m", undefined, { webhook: withCredentials }, "global settings"),
				`{"webhook":"${shownBase}"}`,
			],
			[
				"setting card",
				describeSettingChange("usage.currencySymbol", "$", withCredentials, null),
				`after:  "${shownBase}"`,
			],
			[
				"adoption card",
				describeAdoption({ label: "Cred", baseUrl: withCredentials }, "Imported", {}),
				`adopt provider group "Cred" at ${shownBase} as servers entry "Imported"`,
			],
		];
		for (const [name, rendered, expected] of surfaces) {
			expect(rendered, name).toContain(expected);
		}
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
