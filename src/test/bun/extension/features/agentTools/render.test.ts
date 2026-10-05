/**
 * Pinned as whole outputs, because a shaped reply that drops a section or echoes an unredacted response body fails only
 * in the agent's context window, where no test would notice.
 */
import { describe, expect, test } from "bun:test";
import { CREDENTIAL_HEADER_PLACEHOLDER } from "../../../../../extension/features/agentTools/inputSchema";
import type { AgentRequest } from "../../../../../extension/features/agentTools/planner";
import {
	describeAdoption as adoptionParts,
	modelFacing,
	type Parts,
	describeRecordChange as recordChangeParts,
	refusalText,
	renderJson,
	describeServerChange as serverChangeParts,
	describeSettingChange as settingChangeParts,
	shapeConfiguration,
	shapeDiagnostics,
	shapeSubmission,
} from "../../../../../extension/features/agentTools/render";
import type { DiagnosticsSnapshot } from "../../../../../extension/ui/issueReporter";
import { markLogSafe } from "../../../../../shared/logger";
import type { ServerStatus } from "../../../../../shared/servers";
import { KnownSecrets } from "../../../../../shared/util/knownSecrets";
import { makeDeclaredServer, makeExternalServer, makeState } from "../../../webview/fixtures";
import { agentToolsState, PROD_CONFIG, PROD_HEADER_SECRET } from "./fixture";

const state = agentToolsState();

/** A card as the user reads it: the builders return parts, the exit's one function renders them with no values. */
const asCard = (parts: Parts): string => modelFacing(parts, []);

describe("agentTools/render with runtime-minted values", () => {
	test("a minted OAuth token reaches the exit through values() and renders redacted", () => {
		// renderJson({ message: "Authorization: Bearer oauth-access-Q7" }, known.values()) returned the token verbatim
		// while only configured values were known.
		const known = new KnownSecrets();
		known.set(["configured-Q7"]);
		known.mint("oauth-access-Q7");
		const reply = JSON.parse(
			renderJson({ message: "401: Authorization: Bearer oauth-access-Q7 rejected" }, known.values())
		) as { message: string };
		expect(reply.message).toBe("401: Authorization: Bearer [redacted] rejected");
	});
});
const describeAdoption = (...args: Parameters<typeof adoptionParts>): string => asCard(adoptionParts(...args));
const describeRecordChange = (...args: Parameters<typeof recordChangeParts>): string =>
	asCard(recordChangeParts(...args));
const describeServerChange = (...args: Parameters<typeof serverChangeParts>): string =>
	asCard(serverChangeParts(...args));
const describeSettingChange = (...args: Parameters<typeof settingChangeParts>): string =>
	asCard(settingChangeParts(...args));

const NO_SECRETS = { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" } as const;

// A marker, not a key shape: the leak scanner must not trip on the test fixture itself.
const LEAKED_MARKER = "bearer-marker-9f8e7d";

describe("agentTools render", () => {
	// Drifts silently: a server row's error, a fail reply, and the latest error are the transport's display text and
	// embed the response body, which can echo the request's own key. The shapes leave the text as it is; the one pass
	// at the exit sees the original, so a value is "[redacted]" whole, never "sk-abcd[REDACTED]" from an earlier pass.
	test("response-derived text reaches the exit unrewritten, where the one pass redacts the whole value", () => {
		const key = "sk-abcd1234567890"; // gitleaks:allow
		const failing = makeState({
			servers: [
				makeExternalServer({
					label: "Leaky",
					state: "error",
					error: `Denied ${key}`,
					errorEnglish: `Denied ${key} (en)`,
				}),
			],
		});
		const rows = JSON.parse(renderJson(shapeConfiguration(failing, ["servers"]), [key])) as {
			servers: { error: string; errorEnglish: string }[];
		};
		expect(rows.servers[0]?.error).toBe("Denied [redacted]");
		expect(rows.servers[0]?.errorEnglish).toBe("Denied [redacted] (en)");
		const request: AgentRequest = { method: "testServerDraft", payload: null };
		const reply = JSON.parse(
			renderJson(
				shapeSubmission(request, {
					outcome: "validation-error",
					reply: {
						kind: "fail",
						id: "x",
						method: "testServerDraft",
						message: `Denied ${key}`,
						failureKind: "operation",
						classification: { kind: "auth", status: 401 },
					},
				}),
				[key]
			)
		) as { message: string };
		expect(reply.message).toBe("Denied [redacted]");
		const latest = JSON.parse(
			renderJson(
				shapeDiagnostics(
					{
						...snapshot,
						latestError: {
							source: "discovery",
							message: `Denied ${key}`,
							timestamp: "2026-09-14T00:00:00Z",
							classification: { kind: "auth", status: 401 },
						},
					},
					[],
					state.diagnostics,
					false
				),
				[key]
			)
		) as { latestError: { message: string } };
		expect(latest.latestError.message).toBe("Denied [redacted]");
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
		virtualKeyHeaders: [],
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

	//   Drifts silently -> a response-derived string (server error, latest error, log line) reaching the agent without
	//                      the exit's pass, or the stack, which the report itself never includes
	test.each([
		["with logs", true, 3],
		["without logs", false, 2],
	])(
		"shapeDiagnostics %s leaves every response-derived string to the one pass and carries no stack",
		(_name, includeLogs, redactions) => {
			const text: string = renderJson(shapeDiagnostics(snapshot, servers, state.diagnostics, includeLogs), [
				LEAKED_MARKER,
			]);
			const shaped = JSON.parse(text) as Record<string, unknown>;
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

	// Drifts silently: only the ENTRY's headers are custom HTTP headers (the transport sends exactly those); a
	// `headers` field inside a models record is request-body text the user wrote and must render as written, or an
	// echoed read would store the placeholder as the parameter. A record key is text the model reads too.
	test.each<[string, unknown, unknown]>([
		[
			"a credentialed URL after prose keeps the prose",
			{ note: "see https://u:pw-one@one.test/a" },
			{ note: "see https://one.test/a" },
		],
		[
			"a headers value that is not a record, and a plain header value, pass through the string scrub",
			{
				headers: "https://u:pw@one.test",
				server: { baseUrl: "http://a.test", headers: { "X-Hook": "https://u:pw@one.test" } },
			},
			{ headers: "https://one.test", server: { baseUrl: "http://a.test", headers: { "X-Hook": "https://one.test" } } },
		],
		[
			"a `headers` field inside a models record is a request parameter the user wrote, rendered as written",
			{ modelParameters: { "gpt-*": { headers: { Authorization: "body-text", "X-Team": "t" } } } },
			{ modelParameters: { "gpt-*": { headers: { Authorization: "body-text", "X-Team": "t" } } } },
		],
		[
			"prose between a URL and a later @ reads as that URL's userinfo to the shared scrub and is cut (its declared boundary)",
			{ note: "Visit https://example.com and email example-user@example.com" },
			{ note: "Visit https://example.com" },
		],
		["a record key is text too", { "https://u:pw-one@one.test": 1 }, { "https://one.test": 1 }],
		[
			"two keys differing only in userinfo stay two entries",
			{ "https://alice:pw-a@host.test": 1, "https://bob:pw-b@host.test": 2, "https://host.test #2": 3 },
			{ "https://host.test": 1, "https://host.test #2": 2, "https://host.test #2 #2": 3 },
		],
	])("renderJson: %s", (_name, value, rendered) => {
		expect(JSON.parse(renderJson(value))).toEqual(rendered);
	});

	test("a card heading built from an agent-written identifier goes through the URL scrub", () => {
		const key = "https://u:pw-one@one.test";
		expect(describeRecordChange("parameters", key, undefined, { temperature: 0.2 }, `servers entry "${key}"`)).toBe(
			[
				"```",
				'models.parameters["https://one.test"]  (servers entry "https://one.test")',
				"before: (absent)",
				'after:  {"temperature":0.2}',
				"```",
			].join("\n")
		);
		expect(describeServerChange(key, undefined, { label: key }, [], [])).toBe(
			[
				"```",
				'new servers entry "https://one.test"',
				`label: (absent) -> "https://one.test" (carries text the card does not show, such as URL credentials)`,
				"```",
			].join("\n")
		);
		// A refusal is read by the model directly (wiring throws it), so its interpolated label is scrubbed too, and
		// the one function replaces a known value wherever the message quotes it.
		const refusal: string = modelFacing(
			refusalText("credential-header-placeholder", { label: key, headers: "X-API-Key" }),
			[]
		);
		expect(refusal).toBe(
			'headers X-API-Key carry the placeholder litellm_configuration shows for a credential header, but "https://one.test" stores no such header to keep. Give the value, or leave the header out.'
		);
		expect<string>(modelFacing(`${refusal} Server said: Denied plain-key-Q7.`, ["plain-key-Q7"])).toBe(
			`${refusal} Server said: Denied [redacted].`
		);
	});

	// Drifts silently: the fixture's Prod row is what every planner suite plans against, so its header value
	// reaching the configuration read or the save card is the leak a user's real entry would have.
	test("a credential-bearing custom header value never reaches a rendered result or card", () => {
		const configuration = renderJson(shapeConfiguration(state, ["servers"]));
		expect(configuration).not.toContain(PROD_HEADER_SECRET);
		expect(configuration).toContain('"X-Team": "platform"');
		// The entry's own virtualKeyHeader names a second credential header, in any case; a header merely NAMED
		// virtualKeyHeader is an ordinary header, not a carrier.
		const keyedRow = makeDeclaredServer({
			label: "Keyed",
			baseUrl: "http://keyed.test",
			config: {
				secrets: { kind: "proven", locations: NO_SECRETS },
				virtualKeyHeader: "X-LiteLLM-Key",
				headers: {
					authorization: "Bearer tok-1",
					"x-litellm-key": "vk-1",
					"X-Team": "platform",
					virtualKeyHeader: "X-Team",
				},
			},
		});
		const keyed = makeState({ servers: [keyedRow] });
		expect(JSON.parse(renderJson(shapeConfiguration(keyed, ["servers"])))).toEqual({
			servers: [
				{
					...keyedRow,
					config: {
						...keyedRow.config,
						headers: {
							authorization: CREDENTIAL_HEADER_PLACEHOLDER,
							"x-litellm-key": CREDENTIAL_HEADER_PLACEHOLDER,
							"X-Team": "platform",
							virtualKeyHeader: "X-Team",
						},
					},
				},
			],
			servedModelCount: keyed.servedModelCount,
		});
		const hidden = "(carries text the card does not show, such as URL credentials)";
		const card = describeServerChange(
			"Prod",
			{ headers: PROD_CONFIG.headers },
			{ headers: { ...PROD_CONFIG.headers, "X-New": "1" } },
			[],
			[]
		);
		expect(card).toBe(
			[
				"```",
				'servers entry "Prod"',
				`headers: {"X-Team":"platform","Authorization":"${CREDENTIAL_HEADER_PLACEHOLDER}"} ${hidden} -> {"X-Team":"platform","Authorization":"${CREDENTIAL_HEADER_PLACEHOLDER}","X-New":"1"} ${hidden}`,
				"```",
			].join("\n")
		);
		// A renamed carrier: the after side names X-Next, yet the kept X-Private value is still a credential on the
		// card because the before side named it.
		const renamedCarrier = describeServerChange(
			"Prod",
			{ virtualKeyHeader: "X-Private", headers: { "X-Private": PROD_HEADER_SECRET } },
			{ virtualKeyHeader: "X-Next", headers: { "X-Private": PROD_HEADER_SECRET, "X-New": "1" } },
			[],
			[]
		);
		expect(renamedCarrier).toBe(
			[
				"```",
				'servers entry "Prod"',
				`headers: {"X-Private":"${CREDENTIAL_HEADER_PLACEHOLDER}"} ${hidden} -> {"X-Private":"${CREDENTIAL_HEADER_PLACEHOLDER}","X-New":"1"} ${hidden}`,
				'virtualKeyHeader: "X-Private" -> "X-Next"',
				"```",
			].join("\n")
		);
	});

	// Drifts silently: response-derived text (a 403 body, a probe failure, a token exchange error) can quote the
	// very value it rejected, and no field shape finds it there; only the values the extension knows do.
	const failing = makeExternalServer({
		label: "Denied",
		state: "error",
		error: "403: Denied plain-key-Q7",
		errorEnglish: "403 for plain-key-Q7",
	});
	const failingState = makeState({ servers: [failing] });
	const keyedRow = makeDeclaredServer({
		label: "Keyed",
		baseUrl: "http://keyed.test",
		config: { secrets: { kind: "proven", locations: NO_SECRETS }, headers: { Authorization: "Bearer tok-1" } },
	});
	const keyedState = makeState({ servers: [keyedRow] });
	const exchangeFailed: DiagnosticsSnapshot = {
		...snapshot,
		latestError: {
			source: "discovery",
			message: "exchange rejected cs-marker-55",
			timestamp: "2026-09-14T00:00:00Z",
			classification: { kind: "auth", status: 401 },
		},
		recentLogs: [],
	};
	// An error's source names the failing operation and can carry its URL or a header value, like its message.
	const taintedSource: DiagnosticsSnapshot = {
		...snapshot,
		latestError: {
			source: "probe of https://user:pass@host.test with X-Private private-marker",
			message: "exchange rejected",
			timestamp: "2026-09-14T00:00:00Z",
			classification: { kind: "auth", status: 401 },
		},
		recentLogs: [],
	};
	const probeRequest: AgentRequest = { method: "testServerDraft", payload: null };
	test.each<[string, unknown, readonly string[], unknown]>([
		[
			"a 403 body quoting the configured key, in a configuration read",
			shapeConfiguration(failingState, ["servers"]),
			["plain-key-Q7"],
			{
				servers: [{ ...failing, error: "403: Denied [redacted]", errorEnglish: "403 for [redacted]" }],
				servedModelCount: failingState.servedModelCount,
			},
		],
		[
			"an OAuth client secret quoted by a token exchange error, in diagnostics",
			shapeDiagnostics(exchangeFailed, [], state.diagnostics, false),
			["cs-marker-55"],
			{
				extensionVersion: "0.6.4",
				vscodeVersion: "1.104.0",
				platform: "darwin",
				connectionState: "connected",
				modelCount: 2,
				servers: [],
				features: snapshot.featureFlags,
				mcpEntryCount: 1,
				configurationProblems: [],
				latestError: {
					source: "discovery",
					timestamp: "2026-09-14T00:00:00Z",
					classification: { kind: "auth", status: 401 },
					message: "exchange rejected [redacted]",
				},
			},
		],
		[
			"an error's source carrying a credentialed URL and a header value, in diagnostics",
			shapeDiagnostics(taintedSource, [], state.diagnostics, false),
			["private-marker"],
			{
				extensionVersion: "0.6.4",
				vscodeVersion: "1.104.0",
				platform: "darwin",
				connectionState: "connected",
				modelCount: 2,
				servers: [],
				features: snapshot.featureFlags,
				mcpEntryCount: 1,
				configurationProblems: [],
				latestError: {
					source: "probe of https://host.test with X-Private [redacted]",
					timestamp: "2026-09-14T00:00:00Z",
					classification: { kind: "auth", status: 401 },
					message: "exchange rejected",
				},
			},
		],
		[
			"a probe failure body quoting a header value the entry's virtualKeyHeader carries",
			shapeSubmission(probeRequest, {
				outcome: "validation-error",
				reply: {
					kind: "fail",
					id: "x",
					method: "testServerDraft",
					message: 'Probe failed: {"X-Private":"private-marker"}',
					failureKind: "operation",
				},
			}),
			["private-marker"],
			{
				method: "testServerDraft",
				ok: false,
				failureKind: "operation",
				message: 'Probe failed: {"X-Private":"[redacted]"}',
			},
		],
		[
			"a known value is replaced in keys as in strings: a models record keyed by the key itself names it nowhere",
			{ modelCount: 1234, note: "the model key is model", modelParameters: { "plain-key-Q7": { temperature: 0 } } },
			["model", "plain-key-Q7"],
			{
				"[redacted]Count": 1234,
				note: "the [redacted] key is [redacted]",
				"[redacted]Parameters": { "[redacted]": { temperature: 0 } },
			},
		],
		[
			"a known value inside the placeholder's own words leaves a real placeholder whole: it is a marker the renderer owns",
			shapeConfiguration(keyedState, ["servers"]),
			["settings"],
			{
				servers: [
					{ ...keyedRow, config: { ...keyedRow.config, headers: { Authorization: CREDENTIAL_HEADER_PLACEHOLDER } } },
				],
				servedModelCount: keyedState.servedModelCount,
			},
		],
		[
			"a known value that itself contains the placeholder's text is still replaced wherever it appears",
			{ note: `Denied pre${CREDENTIAL_HEADER_PLACEHOLDER}post`, kept: CREDENTIAL_HEADER_PLACEHOLDER },
			[`pre${CREDENTIAL_HEADER_PLACEHOLDER}post`],
			{ note: "Denied [redacted]", kept: CREDENTIAL_HEADER_PLACEHOLDER },
		],
		[
			"a value that is a prefix of a longer one leaves no tail",
			{ note: `Denied pre${CREDENTIAL_HEADER_PLACEHOLDER}post and tok-1234-tail`, kept: CREDENTIAL_HEADER_PLACEHOLDER },
			[`pre${CREDENTIAL_HEADER_PLACEHOLDER}`, `pre${CREDENTIAL_HEADER_PLACEHOLDER}post`, "tok-1234", "tok-1234-tail"],
			{ note: "Denied [redacted] and [redacted]", kept: CREDENTIAL_HEADER_PLACEHOLDER },
		],
		[
			"a placeholder a server quotes is text like any other: its words are redacted, no spelling is spared",
			{ note: `Denied ${CREDENTIAL_HEADER_PLACEHOLDER}` },
			["settings"],
			{ note: "Denied [credential header: value kept in [redacted], not shown]" },
		],
		[
			"two values of one length that overlap in the text leave no fragment of either",
			{ note: "Denied abc123xyz; again abc123 and 123xyz" },
			["abc123", "123xyz"],
			{ note: "Denied [redacted]; again [redacted] and [redacted]" },
		],
		[
			"a value containing the placeholder and a value overlapping its tail are one span; a bare placeholder stays",
			{ note: `Denied pre${CREDENTIAL_HEADER_PLACEHOLDER}postxyz`, kept: CREDENTIAL_HEADER_PLACEHOLDER },
			[`pre${CREDENTIAL_HEADER_PLACEHOLDER}post`, "postxyz"],
			{ note: "Denied [redacted]", kept: CREDENTIAL_HEADER_PLACEHOLDER },
		],
	])("renderJson with the known values: %s", (_name, shaped, secrets, rendered) => {
		expect(JSON.parse(renderJson(shaped, secrets))).toEqual(rendered);
	});

	// The marker-free construction: a placeholder is a part modelFacing inserts after redacting the text around it, so
	// values that would touch any random marker (one per hex digit before a UUID's "-4") change nothing; the shared
	// redactor does the cutting, so a value split by the cut is found whole.
	test("a placeholder is positional, and the cut with its suffix passes the known values, straddling ones included", () => {
		const everyNibble = "0123456789abcdef".split("").map((hex) => `${hex}-4`);
		const rendered = JSON.parse(renderJson(shapeConfiguration(keyedState, ["servers"]), everyNibble)) as {
			servers: { config: { headers: Record<string, string> } }[];
		};
		expect(rendered.servers[0]?.config.headers).toEqual({ Authorization: CREDENTIAL_HEADER_PLACEHOLDER });
		const suffix = '\n... [truncated: ask for fewer "sections", or inspect one model at a time]';
		const cut: string = renderJson({ note: "sections", filler: "x".repeat(61_000) }, ["sections"]);
		expect(cut.endsWith('\n... [truncated: ask for fewer "[redacted]", or inspect one model at a time]')).toBe(true);
		expect(cut).toContain(" more characters cut]");
		expect(cut).not.toContain('"sections"');
		expect(cut.length).toBeLessThanOrEqual(60_000);
		// The shared redactor cuts with its window reaching past the budget: a value whose serialized form starts before
		// the cut (within the room the redactor's marker is left) is redacted whole, never left as a prefix.
		const room = 60_000 - suffix.length;
		const prefix = '{\n  "note": "';
		const between = '",\n  "head": "';
		const head = `SECRET-START${"y".repeat(100)}`;
		const note = "x".repeat(room - 60 - prefix.length - between.length);
		const straddled: string = renderJson({ note, head, tail: "SECRET-END" }, [`${head}",\n  "tail": "SECRET-END`]);
		expect(straddled).not.toContain("SECRET-START");
		expect(straddled).not.toContain("SECRET-END");
		expect(straddled).toContain("[redacted]");
		// Values whose redaction lengthens the text: the cut still lands and the hint still follows it.
		const swelling: string = renderJson(
			{ pad: "p".repeat(58_477), values: [...Array<string>(86).fill("x"), ...Array<string>(20).fill("y".repeat(100))] },
			[JSON.stringify("x"), JSON.stringify("y".repeat(100))]
		);
		expect(swelling.endsWith(suffix)).toBe(true);
		expect(swelling.length).toBeLessThanOrEqual(60_000);
		expect(swelling).toContain(" more characters cut]");
		expect(swelling).not.toContain('"x"');
		// The cut marker counts every omitted character, the pieces after the cut one (a placeholder among them)
		// included; with nothing to redact the kept text is the original's prefix, so the count is checkable exactly.
		const wide = makeState({
			servers: [
				makeDeclaredServer({
					label: "Keyed",
					baseUrl: `http://keyed.test/${"p".repeat(61_000)}`,
					config: { secrets: { kind: "proven", locations: NO_SECRETS }, headers: { Authorization: "Bearer tok-1" } },
				}),
			],
		});
		const shaped = shapeConfiguration(wide, ["servers"]);
		const full = JSON.stringify(
			shaped,
			(_key, value: unknown) => (typeof value === "symbol" ? CREDENTIAL_HEADER_PLACEHOLDER : value),
			2
		).length;
		const counted: string = renderJson(shaped);
		const body = counted.slice(0, counted.length - suffix.length);
		const at = body.lastIndexOf(" [");
		expect(body.slice(at)).toBe(` [${full - at} more characters cut]`);
		expect(counted.length).toBeLessThanOrEqual(60_000);
	});

	// Drifts silently: a record key is agent-written text; three backticks in it would close a fixed fence and let the
	// rest of the key forge the card the user approves.
	test("a card's fence outruns any backtick run in an agent-written key", () => {
		const card = describeRecordChange("parameters", "m", undefined, { note: "a\n```\nforged: yes" }, "global settings");
		const fence = card.slice(0, card.indexOf("\n"));
		expect(fence.length).toBeGreaterThanOrEqual(4);
		expect(card.endsWith(`\n${fence}`)).toBe(true);
	});
});
