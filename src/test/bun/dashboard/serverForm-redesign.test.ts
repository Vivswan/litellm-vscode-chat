/**
 * The redesigned server form's grammar: the Authentication selector's
 * active-form gating (only the picked form's fields validate and assemble,
 * companions per rank, inactive typed values demoted to keep), the derived
 * initial form (deriveAuthForm), and the three new entry fields the payload
 * always carries - headers, declaredModels, budget. Complements
 * serverForm.test.ts, which pins the pre-existing per-field rules.
 */
import { describe, test } from "bun:test";
import * as assert from "node:assert";
import type { SecretFieldDraft, ServerFormDraft, ServerFormIntent } from "../../../dashboard/serverForm";
import {
	CONNECTION_FIELDS,
	deriveAuthForm,
	EMPTY_SERVER_FORM,
	parseDeclaredModelsText,
	parseServerForm,
	parseServerFormForTest,
} from "../../../dashboard/serverForm";

function draft(overrides: Partial<ServerFormDraft> = {}): ServerFormDraft {
	return { ...EMPTY_SERVER_FORM, label: "Prod", baseUrl: "http://localhost:4000", ...overrides };
}

function secret(overrides: Partial<SecretFieldDraft> = {}): SecretFieldDraft {
	return { value: "", location: "secure", clear: false, existing: "none", ...overrides };
}

/** The ok arm's intent; fails the test when the draft has problems. */
function intentOf(formDraft: ServerFormDraft): ServerFormIntent {
	const parse = parseServerForm(formDraft);
	if (!parse.ok) {
		assert.fail(`expected a clean parse, got problems: ${JSON.stringify(parse.problems)}`);
	}
	return parse.intent;
}

const NO_SECRETS = { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" } as const;

describe("dashboard/serverForm redesign", () => {
	describe("deriveAuthForm", () => {
		test("oauth wins when the token URL and client ID pair is configured", () => {
			assert.strictEqual(
				deriveAuthForm({
					oauthTokenUrl: "https://idp.test/token",
					oauthClientId: "client",
					secrets: { ...NO_SECRETS, apiKey: "secure" },
				}),
				"oauth"
			);
			// Half a pair is not the OAuth form; the stored key decides instead.
			assert.strictEqual(
				deriveAuthForm({ oauthTokenUrl: "https://idp.test/token", secrets: { ...NO_SECRETS, apiKey: "secure" } }),
				"apiKey"
			);
		});

		test("a stored API key reads as the API-key form, even beside a virtual-key pair (rank)", () => {
			assert.strictEqual(deriveAuthForm({ secrets: { ...NO_SECRETS, apiKey: "settings" } }), "apiKey");
			assert.strictEqual(
				deriveAuthForm({
					virtualKeyHeader: "x-key",
					secrets: { ...NO_SECRETS, apiKey: "secure", virtualKeyValue: "secure" },
				}),
				"apiKey"
			);
		});

		test("a virtual-key header or stored value reads as the virtualKey form; nothing reads as none", () => {
			assert.strictEqual(deriveAuthForm({ virtualKeyHeader: "x-key", secrets: NO_SECRETS }), "virtualKey");
			assert.strictEqual(deriveAuthForm({ secrets: { ...NO_SECRETS, virtualKeyValue: "secure" } }), "virtualKey");
			assert.strictEqual(deriveAuthForm({ secrets: NO_SECRETS }), "none");
		});
	});

	describe("active-form gating", () => {
		test("inactive forms' text never validates or assembles: oauth leftovers vanish on the apiKey form", () => {
			// The same text blocks under the oauth form (partial pair)...
			const oauthDraft = draft({ authForm: "oauth", oauthClientId: "client" });
			const blocked = parseServerForm(oauthDraft);
			assert.ok(!blocked.ok);
			assert.notStrictEqual(blocked.problems.oauthTokenUrl, undefined);

			// ...and is excluded wholesale once the selector moves on.
			const parse = parseServerForm(draft({ authForm: "apiKey", oauthClientId: "client" }));
			assert.ok(parse.ok, "inactive oauth text neither validates nor blocks");
			assert.ok(!("oauthClientId" in parse.intent.server));
		});

		test("the virtual key pair is live on its own form and as the apiKey and oauth companions, not on none", () => {
			// Header without value blocks wherever the pair is active...
			for (const authForm of ["virtualKey", "apiKey"] as const) {
				const parse = parseServerForm(draft({ authForm, virtualKeyHeader: "x-key" }));
				assert.ok(!parse.ok, authForm);
				assert.notStrictEqual(parse.problems.virtualKeyValue, undefined, authForm);
			}
			const oauthParse = parseServerForm(
				draft({
					authForm: "oauth",
					oauthTokenUrl: "https://idp.test/token",
					oauthClientId: "client",
					virtualKeyHeader: "x-key",
				})
			);
			assert.ok(!oauthParse.ok);
			assert.notStrictEqual(oauthParse.problems.virtualKeyValue, undefined);

			// ...and is excluded on none: the header text does not reach the payload.
			const noneParse = parseServerForm(draft({ authForm: "none", virtualKeyHeader: "x-key" }));
			assert.ok(noneParse.ok);
			assert.ok(!("virtualKeyHeader" in noneParse.intent.server));
		});

		test("a complete pair assembles as the apiKey form's companion", () => {
			const intent = intentOf(
				draft({
					authForm: "apiKey",
					apiKey: secret({ value: "sk-1" }),
					virtualKeyHeader: "x-key",
					virtualKeyValue: secret({ value: "vk-1", location: "settings" }),
				})
			);
			assert.strictEqual(intent.server.virtualKeyHeader, "x-key");
			assert.deepStrictEqual(intent.secrets.apiKey, { action: "set", location: "secure", value: "sk-1" });
			assert.deepStrictEqual(intent.secrets.virtualKeyValue, { action: "set", location: "settings", value: "vk-1" });
		});

		test("a value typed into an inactive form's secret demotes to keep, never a set", () => {
			const intent = intentOf(draft({ authForm: "none", apiKey: secret({ value: "sk-typed" }) }));
			assert.deepStrictEqual(intent.secrets.apiKey, { action: "keep" });
		});

		test("all three directives always ride the intent, and clear survives inactivity", () => {
			const intent = intentOf(
				draft({ authForm: "none", oauthClientSecret: secret({ existing: "secure", clear: true }) })
			);
			assert.deepStrictEqual(intent.secrets, {
				apiKey: { action: "keep" },
				oauthClientSecret: { action: "clear" },
				virtualKeyValue: { action: "keep" },
			});
		});

		test("a kept stored client secret blocks every non-oauth form until removed (the save would refuse it)", () => {
			for (const authForm of ["none", "apiKey", "virtualKey"] as const) {
				const parse = parseServerForm(draft({ authForm, oauthClientSecret: secret({ existing: "secure" }) }));
				assert.ok(!parse.ok, authForm);
				assert.notStrictEqual(parse.problems.oauthClientSecret, undefined, authForm);
			}
			// Removing it unblocks; so does switching back to OAuth (with its pair).
			assert.ok(
				parseServerForm(draft({ authForm: "none", oauthClientSecret: secret({ existing: "secure", clear: true }) })).ok
			);
		});

		test("a kept stored virtual key value blocks only the none form (elsewhere the pair rules own it)", () => {
			const parse = parseServerForm(draft({ authForm: "none", virtualKeyValue: secret({ existing: "secure" }) }));
			assert.ok(!parse.ok);
			assert.notStrictEqual(parse.problems.virtualKeyValue, undefined);
			// A stored API key does not block: the shape rule activates the bearer,
			// which the form surfaces as a hint, not a refusal.
			assert.ok(parseServerForm(draft({ authForm: "none", apiKey: secret({ existing: "secure" }) })).ok);
		});
	});

	describe("headers, declared models, budget", () => {
		test("the payload always carries the three fields, empty included", () => {
			const server = intentOf(draft()).server;
			assert.deepStrictEqual(server.headers, {});
			assert.deepStrictEqual(server.declaredModels, []);
			assert.strictEqual(server.budget, null);
		});

		test("header rows assemble with typed values; a broken row blocks with row-aligned problems", () => {
			const intent = intentOf(
				draft({
					headers: [
						{ name: "x-routing-env", valueText: "prod" },
						{ name: "x-retries", valueText: "3" },
					],
				})
			);
			assert.deepStrictEqual(intent.server.headers, { "x-routing-env": "prod", "x-retries": 3 });

			const blocked = parseServerForm(
				draft({
					headers: [
						{ name: "x-ok", valueText: "fine" },
						{ name: "bad name", valueText: "x" },
					],
				})
			);
			assert.ok(!blocked.ok);
			assert.notStrictEqual(blocked.problems.headers, undefined, "the save summary can point at the field");
			assert.strictEqual(blocked.headerProblems[0], undefined);
			assert.notStrictEqual(blocked.headerProblems[1], undefined);
		});

		test("declared models parse one ID per line: trimmed, empties dropped, deduplicated in order", () => {
			assert.deepStrictEqual(parseDeclaredModelsText("  deepseek-r1 \n\n qwen2.5 \ndeepseek-r1\n"), [
				"deepseek-r1",
				"qwen2.5",
			]);
			const intent = intentOf(draft({ declaredModels: "deepseek-r1\ndeepseek-r1\n qwen2.5 " }));
			assert.deepStrictEqual(intent.server.declaredModels, ["deepseek-r1", "qwen2.5"]);
		});

		test("budget: empty clears (null), a positive number rides, everything else blocks", () => {
			assert.strictEqual(intentOf(draft({ budget: " 50 " })).server.budget, 50);
			assert.strictEqual(intentOf(draft({ budget: "" })).server.budget, null);
			for (const text of ["0", "-1", "abc", "Infinity"]) {
				const parse = parseServerForm(draft({ budget: text }));
				assert.ok(!parse.ok, text);
				assert.strictEqual(parse.problems.budget, "Must be a number greater than 0", text);
			}
		});
	});

	describe("parseServerFormForTest under the new grammar", () => {
		test("budget and record problems never gate a probe; broken header rows do", () => {
			const parse = parseServerFormForTest(draft({ budget: "not a number" }));
			assert.ok(parse.ok, "a malformed budget must not gate a probe");
			assert.strictEqual(parse.intent.server.budget, null, "the probe intent carries the neutralized budget");

			const blocked = parseServerFormForTest(draft({ headers: [{ name: "bad name", valueText: "x" }] }));
			assert.ok(!blocked.ok, "the probe sends the headers, so broken rows gate it");
			assert.notStrictEqual(blocked.problems.headers, undefined);
		});

		test("the probe intent carries the parsed headers and declared models", () => {
			const parse = parseServerFormForTest(
				draft({ headers: [{ name: "x-routing-env", valueText: "prod" }], declaredModels: "deepseek-r1" })
			);
			assert.ok(parse.ok);
			assert.deepStrictEqual(parse.intent.server.headers, { "x-routing-env": "prod" });
			assert.deepStrictEqual(parse.intent.server.declaredModels, ["deepseek-r1"]);
		});

		test("CONNECTION_FIELDS covers the auth selector and the header rows", () => {
			assert.ok(CONNECTION_FIELDS.includes("authForm"));
			assert.ok(CONNECTION_FIELDS.includes("headers"));
			assert.ok(!CONNECTION_FIELDS.includes("declaredModels"));
			assert.ok(!CONNECTION_FIELDS.includes("budget"));
		});
	});
});
