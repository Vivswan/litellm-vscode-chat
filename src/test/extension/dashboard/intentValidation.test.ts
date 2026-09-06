/**
 * The request boundary: parseDashboardRequest's envelope schema, readInlineSecretValues, and the intent value
 * validators.
 */
import * as assert from "node:assert";
import { parseDashboardRequest } from "../../../extension/dashboard/intentSchema";
import {
	readInlineSecretValues,
	validateModelParametersRecord,
	validateNumberSetting,
	validateSaveServerSetting,
} from "../../../extension/dashboard/intents";
import { inlineOnlyIdentity, KEEP_ALL, replaceIdentity, serverPayload } from "./recordedEnv";

suite("extension/dashboard/intents: request validation", () => {
	suite("parseDashboardRequest", () => {
		/** One well-formed request envelope; the payload is the case under test. */
		const req = (method: string, payload: unknown, id = "req-1"): unknown => ({ kind: "request", id, method, payload });

		test("accepts every request shape", () => {
			const requests: unknown[] = [
				req("ready", null),
				req("setNumberSetting", { setting: "chat.timeout", value: 60000 }),
				req("setBooleanSetting", { setting: "chat.promptCaching", value: false }),
				req("resetSetting", { setting: "chat.timeout" }),
				req("resetSetting", { setting: "ui.maskSecretInputs" }),
				req("revealSetting", { setting: "chat.timeout" }),
				req("revealSetting", { setting: "chat.promptCaching" }),
				req("revealSetting", { setting: "models.parameters" }),
				req("setModelParameters", { value: { "gpt-4": { temperature: 0.2, stop: ["\n"] } } }),
				req("saveServerSetting", {
					server: serverPayload({ label: "Prod", baseUrl: "http://prod.test" }),
					secrets: KEEP_ALL,
				}),
				req("saveServerSetting", {
					server: serverPayload({
						label: "Prod",
						baseUrl: "http://prod.test",
						oauthTokenUrl: "https://idp.test/token",
						oauthClientId: "client",
						oauthScopes: "read",
						virtualKeyHeader: "x-litellm-api-key",
					}),
					secrets: {
						apiKey: { action: "set", location: "secure", value: "sk-1" },
						oauthClientSecret: { action: "clear" },
						virtualKeyValue: { action: "set", location: "settings", value: "vk-1" },
					},
					replace: {
						label: "Old Prod",
						baseUrl: "http://old.test",
						secrets: { apiKey: "secure", oauthClientSecret: "none", virtualKeyValue: "none" },
					},
				}),
				req("removeServerSetting", { label: "Prod" }),
				req("testServerDraft", {
					server: serverPayload({ label: "", baseUrl: "http://prod.test", oauthTokenUrl: "https://idp.test/token" }),
					secrets: KEEP_ALL,
				}),
				req("testServerDraft", {
					server: serverPayload({ label: "Prod", baseUrl: "http://prod.test" }),
					secrets: { ...KEEP_ALL, apiKey: { action: "set", location: "secure", value: "sk-1" } },
					replace: {
						label: "Prod",
						baseUrl: "http://prod.test",
						secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" },
					},
				}),
				req("readInlineSecrets", {
					replace: {
						label: "Prod",
						baseUrl: "http://prod.test",
						secrets: { apiKey: "settings", oauthClientSecret: "none", virtualKeyValue: "none" },
					},
				}),
				req("adoptServer", {
					label: "Adopted",
					baseUrl: "http://ext.test",
					sourceHandle: "handle-ext",
					secrets: { apiKey: "secure", oauthClientSecret: "secure", virtualKeyValue: "settings" },
				}),
				req("executeCommand", { command: "openOutput" }),
			];
			for (const request of requests) {
				assert.ok(parseDashboardRequest(request).success, `rejected ${JSON.stringify(request)}`);
			}
		});

		test("rejects junk envelopes, unknown methods, unknown settings, unknown commands, and extra fields", () => {
			const rejected: unknown[] = [
				null,
				"ready",
				// The envelope frame itself: only kind "request", a bounded id, and
				// a table method pass; the old flat message shape is malformed now.
				{ type: "ready" },
				{ kind: "ready", id: "r", method: "ready", payload: null },
				{ kind: "request", method: "ready", payload: null },
				{ kind: "request", id: "", method: "ready", payload: null },
				{ kind: "request", id: "x".repeat(129), method: "ready", payload: null },
				{ kind: "request", id: "r", method: "detonate", payload: null },
				{ kind: "request", id: "r", method: "ready", payload: null, extra: 1 },
				{ kind: "request", id: "r", method: "ready" },
				req("ready", {}),
				req("detonate", {}),
				req("setNumberSetting", { setting: "notASetting", value: 1 }),
				req("setNumberSetting", { setting: "chat.timeout", value: "1000" }),
				req("setNumberSetting", { setting: "chat.timeout", value: Number.POSITIVE_INFINITY }),
				req("setBooleanSetting", { setting: "chat.promptCaching", value: "true" }),
				req("resetSetting", { setting: "notASetting" }),
				req("resetSetting", { setting: "chat.timeout", value: 1 }),
				// revealSetting: only classification-listed ids cross - never
				// arbitrary key text or fully-qualified ids.
				req("revealSetting", { setting: "serverSecrets" }),
				req("revealSetting", { setting: "litellm-vscode-chat.chat.timeout" }),
				req("revealSetting", {}),
				req("revealSetting", { setting: "chat.timeout", extra: 1 }),
				req("setHeaders", { value: { "x-bad": { nested: true } } }),
				req("executeCommand", { command: "workbench.action.terminal.sendSequence" }),
				// Syncing left the postable command set when the acked syncModels
				// wire method took over; the old id must not quietly come back.
				req("executeCommand", { command: "syncModels" }),
				req("ready", { extra: 1 }),
				// saveServerSetting: strict everywhere, so no field rides along into the setting.
				req("saveServerSetting", { server: { label: "P", baseUrl: "http://x" } }),
				req("saveServerSetting", { server: { label: "P" }, secrets: KEEP_ALL }),
				req("saveServerSetting", { server: { baseUrl: "http://x" }, secrets: KEEP_ALL }),
				req("saveServerSetting", {
					server: { label: "P", baseUrl: "http://x", apiKey: "inline-not-allowed-here" },
					secrets: KEEP_ALL,
				}),
				req("saveServerSetting", {
					server: { label: "P", baseUrl: "http://x" },
					secrets: { ...KEEP_ALL, apiKey: { action: "set", value: "missing-location" } },
				}),
				req("saveServerSetting", {
					server: { label: "P", baseUrl: "http://x" },
					secrets: { ...KEEP_ALL, apiKey: { action: "keep", value: "extra" } },
				}),
				req("saveServerSetting", {
					server: { label: "P", baseUrl: "http://x" },
					secrets: { apiKey: { action: "keep" } },
				}),
				// The always-sent fields are required: a save rebuilds the whole entry,
				// so an omission-tolerant schema would let a stale sender silently
				// delete hand-written configuration.
				...(["modelCapabilities", "expectedFailures", "headers", "declaredModels", "budget"] as const).map(
					(omitted) => {
						const server: Record<string, unknown> = { ...serverPayload({ label: "P", baseUrl: "http://x" }) };
						delete server[omitted];
						return req("saveServerSetting", { server, secrets: KEEP_ALL });
					}
				),
				req("removeServerSetting", {}),
				req("removeServerSetting", { label: 4 }),
				// The size bounds: no honest value meets them, so anything over is a
				// hostile page ballooning a settings write.
				req("removeServerSetting", { label: "x".repeat(1025) }),
				req("saveServerSetting", {
					server: serverPayload({ label: "P", baseUrl: `http://x/${"y".repeat(4096)}` }),
					secrets: KEEP_ALL,
				}),
				req("saveServerSetting", {
					server: serverPayload({ label: "P", baseUrl: "http://x" }),
					secrets: { ...KEEP_ALL, apiKey: { action: "set", location: "secure", value: "s".repeat(8193) } },
				}),
				req("setModelParameters", {
					value: Object.fromEntries(Array.from({ length: 1025 }, (_, index) => [`m${index}`, {}])),
				}),
				req("setModelParameters", { value: { [`m${"x".repeat(512)}`]: {} } }),
				req("setModelParameters", { value: { "gpt-4": { note: "x".repeat(1024 * 1024) } } }),
				req("saveServerSetting", {
					// The closed enum caps the list length: a ballooned duplicate list
					// must not ride into the setting.
					server: serverPayload({
						label: "P",
						baseUrl: "http://x",
						expectedFailures: Array.from({ length: 3 }, () => "modelInfo" as const),
					}),
					secrets: KEEP_ALL,
				}),
				// testServerDraft: the save payload's strictness verbatim - no inline
				// secret fields on the server object, no unknown fields riding along.
				req("testServerDraft", { server: { label: "P", baseUrl: "http://x" } }),
				req("testServerDraft", {
					server: { label: "P", baseUrl: "http://x", apiKey: "inline-not-allowed-here" },
					secrets: KEEP_ALL,
				}),
				req("testServerDraft", {
					server: { label: "P", baseUrl: "http://x" },
					secrets: KEEP_ALL,
					extra: 1,
				}),
				// readInlineSecrets: the displayed identity only, nothing rides along.
				req("readInlineSecrets", {}),
				req("readInlineSecrets", { label: "P" }),
				req("readInlineSecrets", {
					replace: {
						label: "P",
						baseUrl: "http://x",
						secrets: { apiKey: "keychain", oauthClientSecret: "none", virtualKeyValue: "none" },
					},
				}),
				// adoptServer: never a credential value, only storage locations.
				req("adoptServer", {
					label: "A",
					baseUrl: "http://x",
					sourceHandle: "x",
					secrets: { apiKey: "keychain", oauthClientSecret: "secure", virtualKeyValue: "secure" },
				}),
				req("adoptServer", {
					label: "A",
					baseUrl: "http://x",
					sourceHandle: "x",
					secrets: { apiKey: "secure", oauthClientSecret: "secure" },
				}),
				req("adoptServer", {
					label: "A",
					baseUrl: "http://x",
					sourceHandle: "x",
					secrets: {
						apiKey: "secure",
						oauthClientSecret: "secure",
						virtualKeyValue: "secure",
						apiKeyValue: "sk-smuggled",
					},
				}),
				req("adoptServer", {
					label: "A",
					baseUrl: "http://x",
					secrets: { apiKey: "secure", oauthClientSecret: "secure", virtualKeyValue: "secure" },
				}),
				req("adoptServer", {
					label: "A",
					baseUrl: "http://x",
					sourceHandle: "",
					secrets: { apiKey: "secure", oauthClientSecret: "secure", virtualKeyValue: "secure" },
				}),
			];
			for (const message of rejected) {
				// The label is truncated: some fixtures are megabytes by design, and
				// a failure message must stay readable.
				assert.strictEqual(
					parseDashboardRequest(message).success,
					false,
					`accepted ${JSON.stringify(message)?.slice(0, 300)}`
				);
			}
		});
	});

	suite("readInlineSecretValues", () => {
		const setting = [
			"junk entry",
			{
				label: "Inline",
				baseUrl: "http://a.test",
				auth: { apiKey: " sk-inline ", virtualKey: { header: "x-vk", value: "vk-inline" } },
			},
			{ label: "Secure", baseUrl: "http://b.test" },
			{
				label: "Mixed",
				baseUrl: "http://c.test",
				auth: {
					oauth: { tokenUrl: "https://idp.test/token", clientId: "c1", apiKey: "sk-mixed", clientSecret: "   " },
				},
			},
		];

		test("returns inline values trimmed, one key per inline-stored field", () => {
			assert.deepStrictEqual(readInlineSecretValues(setting, inlineOnlyIdentity(setting, "Inline")), {
				apiKey: "sk-inline",
				virtualKeyValue: "vk-inline",
			});
		});

		test("secure-side and absent fields get no key at all: absence, not an empty string", () => {
			// "Secure" holds nothing inline; whatever its SecretStorage blob holds
			// is not consulted here and must never come back.
			assert.deepStrictEqual(readInlineSecretValues(setting, inlineOnlyIdentity(setting, "Secure")), {});
			const mixed = readInlineSecretValues(setting, inlineOnlyIdentity(setting, "Mixed"));
			assert.deepStrictEqual(mixed, { apiKey: "sk-mixed" });
			assert.ok(!("oauthClientSecret" in mixed), "a whitespace-only inline value counts as absent");
			assert.ok(!("virtualKeyValue" in mixed));
		});

		test("an unknown label, a junk setting, and a non-string field value all yield an empty record", () => {
			assert.deepStrictEqual(readInlineSecretValues(setting, replaceIdentity("Nope", "http://x")), {});
			assert.deepStrictEqual(readInlineSecretValues("not an array", replaceIdentity("Inline", "http://a.test")), {});
			assert.deepStrictEqual(readInlineSecretValues(undefined, replaceIdentity("Inline", "http://a.test")), {});
			const emptyValued = [{ label: "N", baseUrl: "http://x", auth: { apiKey: "" } }];
			assert.deepStrictEqual(readInlineSecretValues(emptyValued, inlineOnlyIdentity(emptyValued, "N")), {});
		});

		test("labels match trimmed, like entry lookup everywhere else", () => {
			const padded = [{ label: " Prod ", baseUrl: "http://x", auth: { apiKey: "sk-1" } }];
			assert.deepStrictEqual(readInlineSecretValues(padded, inlineOnlyIdentity(padded, "Prod")), {
				apiKey: "sk-1",
			});
		});

		test("resolution agrees with parseServersSetting: a rejected same-label sibling cannot shadow the accepted entry", () => {
			// The first raw entry carries the label but has no usable baseUrl, so
			// the parser rejects it and the dashboard row describes the SECOND
			// entry; the prefill must read that same entry.
			const shadowed = [
				{ label: "Prod", auth: { apiKey: "sk-shadow" } },
				{ label: "Prod", baseUrl: "http://real.test", auth: { apiKey: "sk-real" } },
			];
			assert.deepStrictEqual(readInlineSecretValues(shadowed, inlineOnlyIdentity(shadowed, "Prod")), {
				apiKey: "sk-real",
			});
		});

		test("a label the parser rejects yields nothing, even when a raw entry carries inline fields under it", () => {
			// The dashboard never declares this entry (reserved label), so a
			// crafted request must not be able to read its inline fields.
			const rejected = [{ label: "__proto__", baseUrl: "http://x.test", auth: { apiKey: "sk-hidden" } }];
			assert.deepStrictEqual(
				readInlineSecretValues(rejected, replaceIdentity("__proto__", "http://x.test", { apiKey: "settings" })),
				{}
			);
		});

		test("duplicate accepted labels resolve to the first, matching the parser's first-entry-wins rule", () => {
			const duplicated = [
				{ label: "Prod", baseUrl: "http://a.test", auth: { apiKey: "sk-first" } },
				{ label: "Prod", baseUrl: "http://b.test", auth: { apiKey: "sk-second" } },
			];
			assert.deepStrictEqual(readInlineSecretValues(duplicated, inlineOnlyIdentity(duplicated, "Prod")), {
				apiKey: "sk-first",
			});
		});

		test("an entry that no longer matches the displayed identity prefills nothing", () => {
			// The same-label swap racing the prefill: the form displayed the entry
			// at a.test; the label now carries one at b.test with its own inline
			// key. The stale form must not receive the replacement's value.
			const swapped = [{ label: "Inline", baseUrl: "http://b.test", auth: { apiKey: "sk-swapped" } }];
			assert.deepStrictEqual(
				readInlineSecretValues(swapped, replaceIdentity("Inline", "http://a.test", { apiKey: "settings" })),
				{}
			);
		});

		test("moved secret locations prefill nothing either", () => {
			// Same host, but the entry now inlines a key the form displayed as
			// "none": a different credential shape is a different entry.
			const moved = [{ label: "Inline", baseUrl: "http://a.test", auth: { apiKey: "sk-moved-inline" } }];
			assert.deepStrictEqual(readInlineSecretValues(moved, replaceIdentity("Inline", "http://a.test")), {});
		});

		test("a changed OAuth destination prefills nothing: the stored values belong to the new token URL", () => {
			const repointed = [
				{
					label: "OAuth",
					baseUrl: "http://a.test",
					auth: { oauth: { tokenUrl: "https://idp-b.test/token", clientId: "c1", clientSecret: "cs-inline" } },
				},
			];
			const displayed = {
				...inlineOnlyIdentity(repointed, "OAuth"),
				oauthTokenUrl: "https://idp-a.test/token",
			};
			assert.deepStrictEqual(readInlineSecretValues(repointed, displayed), {});
		});
	});

	suite("intent value validation", () => {
		test("validateNumberSetting enforces the per-setting minimum", () => {
			assert.notStrictEqual(validateNumberSetting("chat.timeout", 999), undefined);
			assert.strictEqual(validateNumberSetting("chat.timeout", 1000), undefined);
			assert.strictEqual(validateNumberSetting("discovery.cacheTtl", 0), undefined);
		});

		test("null is refused: no current setting is nullable", () => {
			assert.notStrictEqual(validateNumberSetting("chat.timeout", null), undefined);
			assert.notStrictEqual(validateNumberSetting("usage.pollInterval", null), undefined);
		});

		test("validateNumberSetting refuses fractions for integer-only settings", () => {
			// The message schema admits any finite number, so this host-side gate is
			// what keeps a crafted payload from writing a fraction into a field whose
			// contribution declares "integer", driven by the spec's integer flag.
			const refused = validateNumberSetting("chat.maxToolsPerRequest", 2.5);
			assert.ok(refused !== undefined, "a fractional tool cap is refused");
			assert.ok(refused.split("\n")[1]?.includes("chat.maxToolsPerRequest"), refused);
			assert.strictEqual(validateNumberSetting("chat.maxToolsPerRequest", 129), undefined);
			assert.strictEqual(
				validateNumberSetting("chat.timeout", 1000.5),
				undefined,
				"non-integer settings still accept fractions"
			);
		});

		test("number-setting refusals are two-part: a headline, then a detail line naming the setting id", () => {
			// The banner is page-global and names no field, so the detail line must
			// carry the setting id while the headline carries the unit-aware minimum.
			const below = validateNumberSetting("chat.timeout", 999);
			assert.ok(below !== undefined, "a below-minimum value is refused");
			const [belowHeadline, belowDetail] = below.split("\n");
			assert.ok(belowHeadline?.includes("1000 ms"), below);
			assert.ok(!belowHeadline?.includes("chat.timeout"), "the headline stays jargon-free");
			assert.ok(belowDetail?.includes("chat.timeout"), below);

			const nulled = validateNumberSetting("chat.timeout", null);
			assert.ok(nulled !== undefined, "null is refused for a non-nullable setting");
			assert.ok(nulled.split("\n")[1]?.includes("chat.timeout"), nulled);
		});

		test("validateModelParametersRecord refuses prototype-polluting keys at both levels", () => {
			assert.strictEqual(validateModelParametersRecord({ "gpt-4": { temperature: 0.2 } }), undefined);
			assert.notStrictEqual(
				validateModelParametersRecord(JSON.parse('{"__proto__": {}}') as Record<string, Record<string, unknown>>),
				undefined
			);
			assert.notStrictEqual(
				validateModelParametersRecord(
					JSON.parse('{"gpt-4": {"constructor": 1}}') as Record<string, Record<string, unknown>>
				),
				undefined
			);
		});

		test("validateSaveServerSetting: the acceptance matrix", () => {
			const ok = (server: Parameters<typeof validateSaveServerSetting>[0]) =>
				assert.strictEqual(validateSaveServerSetting(server, KEEP_ALL), undefined, JSON.stringify(server));
			const bad = (server: Parameters<typeof validateSaveServerSetting>[0], why: string) =>
				assert.notStrictEqual(validateSaveServerSetting(server, KEEP_ALL), undefined, why);

			ok(serverPayload({ label: "Prod", baseUrl: "http://localhost:4000" }));
			ok(serverPayload({ label: "Prod", baseUrl: "https://litellm.example.com/" }));
			bad(serverPayload({ label: "", baseUrl: "http://x" }), "empty label");
			bad(serverPayload({ label: "   ", baseUrl: "http://x" }), "whitespace label");
			bad(serverPayload({ label: "__proto__", baseUrl: "http://x" }), "prototype-polluting label");
			bad(serverPayload({ label: "constructor", baseUrl: "http://x" }), "prototype-polluting label");
			bad(serverPayload({ label: "Prod", baseUrl: "" }), "missing baseUrl");
			bad(serverPayload({ label: "Prod", baseUrl: "localhost:4000" }), "URL without a scheme");
			bad(serverPayload({ label: "Prod", baseUrl: "ftp://host" }), "non-http scheme");
			bad(serverPayload({ label: "Prod", baseUrl: "not a url" }), "junk baseUrl");
			bad(serverPayload({ label: "Prod", baseUrl: "http://x", oauthTokenUrl: "idp.test/token" }), "bad OAuth URL");
			bad(
				serverPayload({ label: "Prod", baseUrl: "http://x", virtualKeyHeader: "bad header" }),
				"header name with a space"
			);
		});

		test("validateSaveServerSetting: secret directives must carry sendable values", () => {
			const server = serverPayload({ label: "Prod", baseUrl: "http://x" });
			assert.notStrictEqual(
				validateSaveServerSetting(server, { ...KEEP_ALL, apiKey: { action: "set", location: "secure", value: "" } }),
				undefined,
				"an empty set-value must be a clear, not a set"
			);
			assert.notStrictEqual(
				validateSaveServerSetting(server, {
					...KEEP_ALL,
					virtualKeyValue: { action: "set", location: "secure", value: "a\nb" },
				}),
				undefined,
				"a virtual key with line breaks can never travel as a header"
			);
			assert.strictEqual(
				validateSaveServerSetting(server, {
					...KEEP_ALL,
					apiKey: { action: "set", location: "settings", value: "sk-1" },
				}),
				undefined
			);
		});

		test("validateSaveServerSetting messages never repeat the entered values", () => {
			const problem = validateSaveServerSetting(serverPayload({ label: "Prod", baseUrl: "http://x" }), {
				...KEEP_ALL,
				virtualKeyValue: { action: "set", location: "secure", value: "vk-secret\n" },
			});
			assert.ok(problem !== undefined);
			assert.ok(!problem.includes("vk-secret"), problem);
		});
	});
});
