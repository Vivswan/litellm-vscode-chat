import { describe, test } from "bun:test";
import * as assert from "node:assert";
import type { ReplacedEntryIdentity } from "../../../dashboard/endpoints";
import { newParamRow } from "../../../dashboard/recordDraft";
import type {
	SecretFieldDraft,
	ServerFormDraft,
	ServerFormField,
	ServerFormIntent,
	ServerFormProblems,
} from "../../../dashboard/serverForm";
import {
	apiVersionDraftOf,
	applyInlinePrefill,
	CONNECTION_FIELDS,
	changedServerFormFields,
	EMPTY_SERVER_FORM,
	isUsableHttpUrl,
	mcpDraftOf,
	parseServerForm,
	parseServerFormForTest,
	SERVER_FORM_FIELD_ORDER,
	saveFailureDisposition,
	sectionFailureText,
	serverFormFieldLabel,
	staleKeyFieldsOnSave,
} from "../../../dashboard/serverForm";

/** The fields the OAuth form itself renders; problems on a partial OAuth draft may name only these. */
const OAUTH_FORM_FIELDS: readonly ServerFormField[] = [
	"oauthTokenUrl",
	"oauthClientId",
	"oauthClientSecret",
	"oauthScopes",
];

function draft(overrides: Partial<ServerFormDraft> = {}): ServerFormDraft {
	return { ...EMPTY_SERVER_FORM, label: "Prod", baseUrl: "http://localhost:4000", ...overrides };
}

function secret(overrides: Partial<SecretFieldDraft> = {}): SecretFieldDraft {
	return { value: "", location: "secure", clear: false, existing: "none", ...overrides };
}

/** The problems a draft parses to; an ok parse reads as no problems at all. */
function problemsOf(draft: ServerFormDraft, context?: Parameters<typeof parseServerForm>[1]): ServerFormProblems {
	const parse = parseServerForm(draft, context);
	return parse.ok ? {} : parse.problems;
}

/** A displayed-entry identity for edit-form contexts; locations default to "none". */
function identity(label: string, baseUrl = "http://localhost:4000"): ReplacedEntryIdentity {
	return { label, baseUrl, secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" } };
}

function intentOf(draft: ServerFormDraft, original?: ReplacedEntryIdentity): ServerFormIntent {
	const parse = parseServerForm(draft, original !== undefined ? { original } : {});
	if (!parse.ok) {
		assert.fail(`expected a clean parse, got problems: ${JSON.stringify(parse.problems)}`);
	}
	return parse.intent;
}

describe("dashboard/serverForm", () => {
	describe("isUsableHttpUrl", () => {
		test("accepts http(s) URLs with a host and refuses everything else", () => {
			assert.ok(isUsableHttpUrl("http://localhost:4000"));
			assert.ok(isUsableHttpUrl("https://litellm.example.com/path"));
			assert.ok(!isUsableHttpUrl("localhost:4000"));
			assert.ok(!isUsableHttpUrl("ftp://host"));
			assert.ok(!isUsableHttpUrl("http://"));
			assert.ok(!isUsableHttpUrl("not a url"));
			assert.ok(!isUsableHttpUrl(""));
		});
	});

	describe("parseServerForm problems", () => {
		test("a minimal valid draft parses clean", () => {
			assert.ok(parseServerForm(draft()).ok);
			assert.deepStrictEqual(problemsOf(draft()), {});
		});

		test("label and baseUrl are required; reserved labels are refused", () => {
			assert.notStrictEqual(problemsOf(draft({ label: " " })).label, undefined);
			assert.notStrictEqual(problemsOf(draft({ label: "__proto__" })).label, undefined);
			assert.notStrictEqual(problemsOf(draft({ baseUrl: "" })).baseUrl, undefined);
			assert.notStrictEqual(problemsOf(draft({ baseUrl: "litellm.example.com" })).baseUrl, undefined);
		});

		test("a rename onto a sibling label is a blocking problem; adds keep their upsert semantics", () => {
			const context = { takenLabels: ["Prod", "Staging"], original: identity("Prod") };
			assert.notStrictEqual(problemsOf(draft({ label: "Staging" }), context).label, undefined);
			assert.strictEqual(problemsOf(draft({ label: "Prod" }), context).label, undefined, "keeping the label is fine");
			assert.strictEqual(problemsOf(draft({ label: "Fresh" }), context).label, undefined);
			assert.strictEqual(
				problemsOf(draft({ label: "Staging" }), { takenLabels: ["Staging"] }).label,
				undefined,
				"an add over an existing label replaces it; no original identity, no collision problem"
			);
		});

		test("OAuth fields are one unit: any of them present requires the token URL and client ID", () => {
			const clientOnly = problemsOf(draft({ authForm: "oauth", oauthClientId: "client" }));
			assert.notStrictEqual(clientOnly.oauthTokenUrl, undefined);

			const urlOnly = problemsOf(draft({ authForm: "oauth", oauthTokenUrl: "https://idp.test/token" }));
			assert.notStrictEqual(urlOnly.oauthClientId, undefined);

			const secretOnly = problemsOf(draft({ authForm: "oauth", oauthClientSecret: secret({ value: "s" }) }));
			assert.notStrictEqual(secretOnly.oauthTokenUrl, undefined);
			assert.notStrictEqual(secretOnly.oauthClientId, undefined);

			const complete = problemsOf(
				draft({ authForm: "oauth", oauthTokenUrl: "https://idp.test/token", oauthClientId: "client" })
			);
			assert.deepStrictEqual(complete, {});
		});

		test("a kept secure-side client secret also demands the OAuth pair", () => {
			const problems = problemsOf(draft({ authForm: "oauth", oauthClientSecret: secret({ existing: "secure" }) }));
			assert.notStrictEqual(problems.oauthTokenUrl, undefined);
		});

		test("the virtual key pair is both-or-neither and must be header-sendable", () => {
			assert.notStrictEqual(
				problemsOf(draft({ authForm: "virtualKey", virtualKeyHeader: "bad name" })).virtualKeyHeader,
				undefined
			);
			assert.notStrictEqual(
				problemsOf(draft({ authForm: "virtualKey", virtualKeyHeader: "x-key" })).virtualKeyValue,
				undefined
			);
			assert.notStrictEqual(
				problemsOf(draft({ authForm: "virtualKey", virtualKeyValue: secret({ value: "v" }) })).virtualKeyHeader,
				undefined
			);
			assert.notStrictEqual(
				problemsOf(
					draft({ authForm: "virtualKey", virtualKeyHeader: "x-key", virtualKeyValue: secret({ value: "a\nb" }) })
				).virtualKeyValue,
				undefined
			);
			assert.deepStrictEqual(
				problemsOf(
					draft({ authForm: "virtualKey", virtualKeyHeader: "x-key", virtualKeyValue: secret({ value: "vk-1" }) })
				),
				{}
			);
		});

		test("a header whose value is kept in secure storage satisfies the pair", () => {
			const problems = problemsOf(
				draft({ authForm: "virtualKey", virtualKeyHeader: "x-key", virtualKeyValue: secret({ existing: "secure" }) })
			);
			assert.deepStrictEqual(problems, {});
		});

		test("clearing the kept value re-breaks the pair", () => {
			const problems = problemsOf(
				draft({
					authForm: "virtualKey",
					virtualKeyHeader: "x-key",
					virtualKeyValue: secret({ existing: "secure", clear: true }),
				})
			);
			assert.notStrictEqual(problems.virtualKeyValue, undefined);
		});

		test("a cleared virtual key with stale typed text saves as clear instead of blocking on a disabled input", () => {
			// The parse-once shape's regression: validation once read the raw input
			// text where assembly read the clear directive, so stale text in a
			// disabled input blocked Save on a problem the user could not edit
			// away. A value that is going away cannot block.
			const parse = parseServerForm(
				draft({ authForm: "virtualKey", virtualKeyValue: secret({ value: "a\nb", clear: true, existing: "secure" }) })
			);
			assert.ok(parse.ok, "the stale text of a cleared field is not validated");
			assert.deepStrictEqual(parse.intent.secrets.virtualKeyValue, { action: "clear" });
		});
	});

	describe("apiVersion", () => {
		test("apiVersionDraftOf maps absent to auto, the empty string to none, and text to custom", () => {
			assert.deepStrictEqual(apiVersionDraftOf(undefined), { mode: "auto", custom: "" });
			assert.deepStrictEqual(apiVersionDraftOf(""), { mode: "none", custom: "" });
			assert.deepStrictEqual(apiVersionDraftOf("v2"), { mode: "custom", custom: "v2" });
		});

		test("auto omits the payload key, none sends the empty string, custom sends the trimmed text", () => {
			assert.ok(!("apiVersion" in intentOf(draft()).server), "auto writes no key");
			assert.strictEqual(intentOf(draft({ apiVersion: { mode: "none", custom: "" } })).server.apiVersion, "");
			assert.strictEqual(intentOf(draft({ apiVersion: { mode: "custom", custom: " v2 " } })).server.apiVersion, "v2");
		});

		test("custom with no text is a blocking problem instead of silently meaning none", () => {
			assert.notStrictEqual(problemsOf(draft({ apiVersion: { mode: "custom", custom: "  " } })).apiVersion, undefined);
		});

		test("a custom segment with slashes or whitespace is a named problem, never appended verbatim", () => {
			// "/v2" would build http://host//v2 - routers do not collapse the
			// double slash, so every request would 404 with no hint in the form.
			assert.notStrictEqual(problemsOf(draft({ apiVersion: { mode: "custom", custom: "/v2" } })).apiVersion, undefined);
			assert.notStrictEqual(problemsOf(draft({ apiVersion: { mode: "custom", custom: "v2/" } })).apiVersion, undefined);
			assert.notStrictEqual(problemsOf(draft({ apiVersion: { mode: "custom", custom: "v 2" } })).apiVersion, undefined);
			assert.strictEqual(
				intentOf(draft({ apiVersion: { mode: "custom", custom: "v2beta" } })).server.apiVersion,
				"v2beta"
			);
		});

		test("stale custom text never leaks into a none or auto parse", () => {
			assert.strictEqual(intentOf(draft({ apiVersion: { mode: "none", custom: "v2" } })).server.apiVersion, "");
			assert.ok(!("apiVersion" in intentOf(draft({ apiVersion: { mode: "auto", custom: "v2" } })).server));
		});

		test("the probe intent carries the override and blocks on the same custom-empty problem", () => {
			const noneParse = parseServerFormForTest(draft({ apiVersion: { mode: "none", custom: "" } }));
			assert.ok(noneParse.ok);
			assert.strictEqual(noneParse.intent.server.apiVersion, "");

			const blocked = parseServerFormForTest(draft({ apiVersion: { mode: "custom", custom: "" } }));
			assert.ok(!blocked.ok, "the probe would test a different configuration than the picked custom mode");
			assert.notStrictEqual(blocked.problems.apiVersion, undefined);
		});
	});

	describe("field catalog", () => {
		test("the field order covers every draft field exactly once, with a display label each", () => {
			const draftFields = Object.keys(EMPTY_SERVER_FORM).sort();
			assert.deepStrictEqual([...SERVER_FORM_FIELD_ORDER].sort(), draftFields);
			for (const field of SERVER_FORM_FIELD_ORDER) {
				assert.ok(serverFormFieldLabel(field).length > 0, field);
			}
		});

		test("OAuth-section fields are a subset of the order, so a summary can always point into the form", () => {
			for (const field of OAUTH_FORM_FIELDS) {
				assert.ok(SERVER_FORM_FIELD_ORDER.includes(field), field);
			}
		});

		test("a partial-OAuth draft's problems all sit on the OAuth form's own fields", () => {
			const problems = problemsOf(draft({ authForm: "oauth", oauthTokenUrl: "https://idp.test/token" }));
			const failing = SERVER_FORM_FIELD_ORDER.filter((field) => problems[field] !== undefined);
			assert.ok(failing.length > 0);
			for (const field of failing) {
				assert.ok(OAUTH_FORM_FIELDS.includes(field), field);
			}
		});
	});

	describe("parseServerForm intent", () => {
		test("trims fields and omits empty optionals entirely", () => {
			const intent = intentOf(draft({ label: " Prod ", baseUrl: " http://localhost:4000 ", oauthScopes: "  " }));
			// The entry-record and list fields ride every intent, even empty, so the
			// save can tell a deliberate clear from a pre-editor payload.
			assert.deepStrictEqual(intent.server, {
				label: "Prod",
				baseUrl: "http://localhost:4000",
				modelCapabilities: {},
				expectedFailures: [],
				headers: {},
				declaredModels: [],
				budget: null,
				mcp: null,
			});
			assert.strictEqual(intent.replace, undefined);
		});

		test("empty secret inputs become keep, typed values become set with their location, clear wins", () => {
			// The kept client secret makes the draft OAuth-shaped, so the pair it
			// demands is present: only clean drafts parse to an intent at all.
			const intent = intentOf(
				draft({
					authForm: "oauth",
					oauthTokenUrl: "https://idp.test/token",
					oauthClientId: "client",
					apiKey: secret({ value: " sk-1 ", location: "secure" }),
					oauthClientSecret: secret({ existing: "settings" }),
					virtualKeyValue: secret({ value: "ignored", clear: true }),
				})
			);
			assert.deepStrictEqual(intent.secrets, {
				apiKey: { action: "set", location: "secure", value: "sk-1" },
				oauthClientSecret: { action: "keep" },
				virtualKeyValue: { action: "clear" },
			});
		});

		test("an edit carries the displayed entry's identity as replace", () => {
			const intent = intentOf(draft({ label: "Renamed" }), identity("Prod"));
			assert.deepStrictEqual(intent.replace, identity("Prod"));
			assert.strictEqual(intent.server.label, "Renamed");
		});

		test("an untouched prefilled inline value assembles as keep, never a rewrite", () => {
			const prefilled = secret({
				value: "sk-inline",
				prefill: "sk-inline",
				location: "settings",
				existing: "settings",
			});
			const intent = intentOf(draft({ authForm: "apiKey", apiKey: prefilled }));
			assert.deepStrictEqual(intent.secrets.apiKey, { action: "keep" });
		});

		test("an edited prefill assembles as set with the new value; reverting to the prefill is keep again", () => {
			const prefilled = secret({ value: "sk-new", prefill: "sk-old", location: "settings", existing: "settings" });
			const intent = intentOf(draft({ authForm: "apiKey", apiKey: prefilled }));
			assert.deepStrictEqual(intent.secrets.apiKey, { action: "set", location: "settings", value: "sk-new" });

			const reverted = intentOf(draft({ authForm: "apiKey", apiKey: { ...prefilled, value: " sk-old " } }));
			assert.deepStrictEqual(reverted.secrets.apiKey, { action: "keep" }, "untouched means unchanged value, trimmed");
		});

		test("an emptied prefill assembles as keep; the remove checkbox is the explicit clear gesture", () => {
			const emptied = secret({ value: "", prefill: "sk-inline", location: "settings", existing: "settings" });
			assert.deepStrictEqual(intentOf(draft({ authForm: "apiKey", apiKey: emptied })).secrets.apiKey, {
				action: "keep",
			});
			assert.deepStrictEqual(
				intentOf(draft({ authForm: "apiKey", apiKey: { ...emptied, clear: true } })).secrets.apiKey,
				{
					action: "clear",
				}
			);
		});

		test("a prefill with the storage choice moved to secure assembles as a set there: a real relocation", () => {
			const moved = secret({ value: "sk-inline", prefill: "sk-inline", location: "secure", existing: "settings" });
			const intent = intentOf(draft({ authForm: "apiKey", apiKey: moved }));
			assert.deepStrictEqual(intent.secrets.apiKey, { action: "set", location: "secure", value: "sk-inline" });
		});
	});

	describe("per-entry model parameters", () => {
		test("blocked rows surface on the field slot and row-aligned, like the global editor renders them", () => {
			const parse = parseServerForm(
				draft({ modelParameters: [{ prefix: "gpt-4", params: [newParamRow("temperature", "not json")] }] })
			);
			assert.ok(!parse.ok);
			assert.notStrictEqual(parse.problems.modelParameters, undefined, "the save summary can point at the field");
			assert.strictEqual(parse.modelParameterProblems.length, 1);
			assert.notStrictEqual(parse.modelParameterProblems[0]?.params[0], undefined);
		});

		test("a draft blocked by another field carries no row problems for clean parameter rows", () => {
			const parse = parseServerForm(
				draft({ label: "", modelParameters: [{ prefix: "gpt-4", params: [newParamRow("top_p", "0.9")] }] })
			);
			assert.ok(!parse.ok);
			assert.strictEqual(parse.problems.modelParameters, undefined);
			assert.deepStrictEqual(parse.modelParameterProblems, []);
		});

		test("clean rows assemble into the intent; a draft without rows omits the field entirely", () => {
			const intent = intentOf(
				draft({
					modelParameters: [
						{
							prefix: "gpt-4",
							params: [newParamRow("temperature", "0.2"), newParamRow("stop", '["END"]')],
						},
					],
				})
			);
			assert.deepStrictEqual(intent.server.modelParameters, { "gpt-4": { temperature: 0.2, stop: ["END"] } });
			assert.ok(!("modelParameters" in intentOf(draft()).server));
		});
	});

	describe("per-entry model capabilities and expected failures", () => {
		test("blocked capability rows surface on the field slot and row-aligned", () => {
			const parse = parseServerForm(
				draft({
					modelCapabilities: [{ prefix: "gpt-4", params: [newParamRow("context_length", "not a number")] }],
				})
			);
			assert.ok(!parse.ok);
			assert.notStrictEqual(parse.problems.modelCapabilities, undefined, "the save summary can point at the field");
			assert.notStrictEqual(parse.modelCapabilityIssues[0]?.rows[0]?.problem, undefined);
		});

		test("unknown-key hints ride a clean parse without blocking it, gated on the entry's observed evidence", () => {
			// No evidence in the context: the hint stays suppressed.
			const silent = parseServerForm(
				draft({ modelCapabilities: [{ prefix: "gpt-4", params: [newParamRow("supports_web_search", "true")] }] })
			);
			assert.ok(silent.ok, "unknown keys never block");
			assert.strictEqual(silent.modelCapabilityIssues[0]?.rows[0]?.hint, undefined, "no evidence, no hint");
			assert.deepStrictEqual(silent.intent.server.modelCapabilities, { "gpt-4": { supports_web_search: true } });

			// Observed keys lacking the field: the hint rides the clean parse.
			const hinted = parseServerForm(
				draft({
					modelCapabilities: [{ prefix: "gpt-4", params: [newParamRow("supports_web_search", "true")] }],
				}),
				{ observedModelInfoKeys: ["litellm_provider", "mode"] }
			);
			assert.ok(hinted.ok, "unknown keys hint, never block");
			assert.match(hinted.modelCapabilityIssues[0]?.rows[0]?.hint ?? "", /applied as an override as-is/);

			// Observed keys naming the field: an observed key is real, no hint.
			const observed = parseServerForm(
				draft({
					modelCapabilities: [{ prefix: "gpt-4", params: [newParamRow("supports_web_search", "true")] }],
				}),
				{ observedModelInfoKeys: ["supports_web_search"] }
			);
			assert.ok(observed.ok);
			assert.strictEqual(observed.modelCapabilityIssues[0]?.rows[0]?.hint, undefined);
		});

		test("clean rows and the checkbox list assemble into the intent; empty drafts send both fields empty", () => {
			const intent = intentOf(
				draft({
					modelCapabilities: [
						{
							prefix: "my-model",
							params: [
								newParamRow("context_length", "128000"),
								newParamRow("supports_vision", "true"),
								newParamRow("_future", "true"),
								newParamRow("_openrouter_model", "openai/gpt-4o"),
							],
						},
					],
					expectedFailures: ["modelListing", "modelInfo"],
				})
			);
			assert.deepStrictEqual(intent.server.modelCapabilities, {
				"my-model": {
					context_length: 128000,
					supports_vision: true,
					_future: true,
					_openrouter_model: "openai/gpt-4o",
				},
			});
			assert.deepStrictEqual(intent.server.expectedFailures, ["modelListing", "modelInfo"]);
			// Empty drafts still send both fields: present-but-empty is the
			// deliberate clear; absent is reserved for pre-editor payloads.
			const empty = intentOf(draft()).server;
			assert.deepStrictEqual(empty.modelCapabilities, {});
			assert.deepStrictEqual(empty.expectedFailures, []);
		});
	});

	describe("applyInlinePrefill", () => {
		test("fills empty inline-located fields and marks them as the prefill", () => {
			const base = draft({
				apiKey: secret({ existing: "settings", location: "settings" }),
				virtualKeyValue: secret({ existing: "settings", location: "settings" }),
			});
			const next = applyInlinePrefill(base, { apiKey: "sk-inline", virtualKeyValue: "vk-inline" });
			assert.deepStrictEqual(next.apiKey, {
				value: "sk-inline",
				prefill: "sk-inline",
				location: "settings",
				clear: false,
				existing: "settings",
			});
			assert.strictEqual(next.virtualKeyValue.value, "vk-inline");
			assert.strictEqual(next.oauthClientSecret.value, "", "fields the response omits stay untouched");
		});

		test("never clobbers a typed value, a cleared field, or a field not stored inline", () => {
			const typed = secret({ existing: "settings", location: "settings", value: "sk-user-typed" });
			const cleared = secret({ existing: "settings", location: "settings", clear: true });
			const secure = secret({ existing: "secure" });
			const base = draft({ apiKey: typed, oauthClientSecret: cleared, virtualKeyValue: secure });
			const next = applyInlinePrefill(base, {
				apiKey: "sk-late",
				oauthClientSecret: "sk-late",
				virtualKeyValue: "sk-late",
			});
			assert.deepStrictEqual(next.apiKey, typed, "a typed value outranks a slow response");
			assert.deepStrictEqual(next.oauthClientSecret, cleared, "a field marked for removal stays marked");
			assert.deepStrictEqual(next.virtualKeyValue, secure, "a secure-side field never receives a value");
		});

		test("an empty response leaves the draft alone", () => {
			const base = draft({ apiKey: secret({ existing: "settings", location: "settings" }) });
			assert.deepStrictEqual(applyInlinePrefill(base, {}), base);
		});

		test("an invalid stored inline virtual-key value blocks Save once prefilled, flagged on its own field", () => {
			// Previously unreachable: the value input was always empty on edit, so a
			// hand-written non-sendable inline value slid through. The problem must
			// sit on the value field, not the header, and clear once it is edited.
			const base = draft({
				authForm: "virtualKey",
				virtualKeyHeader: "x-key",
				virtualKeyValue: secret({ existing: "settings", location: "settings" }),
			});
			const prefilled = applyInlinePrefill(base, { virtualKeyValue: "vk\nbroken" });
			const problems = problemsOf(prefilled);
			assert.strictEqual(problems.virtualKeyValue, "The value cannot be sent as an HTTP header");
			assert.strictEqual(problems.virtualKeyHeader, undefined, "the problem points at the value field only");
			assert.ok(!parseServerForm(prefilled).ok, "the form is not savable until the value is edited or removed");

			const edited = { ...prefilled, virtualKeyValue: { ...prefilled.virtualKeyValue, value: "vk-fixed" } };
			assert.deepStrictEqual(problemsOf(edited), {});
		});

		test("relocation race lifecycle: a location flip before the response arrives still relocates once it does", () => {
			// The hazard the form's Save gate exists for: flipping the inline key's
			// radio to secret storage and saving before the prefill lands would
			// read the empty field as "keep" and drop the relocation, so
			// servers.tsx holds the form in its prefill phase until the response
			// arrives; the flipped location then survives the prefill.
			const flipped = draft({ authForm: "apiKey", apiKey: secret({ existing: "settings", location: "secure" }) });
			assert.deepStrictEqual(
				intentOf(flipped).secrets.apiKey,
				{ action: "keep" },
				"saving before the response would no-op the relocation; Save must be gated until it arrives"
			);

			const arrived = applyInlinePrefill(flipped, { apiKey: "sk-inline" });
			assert.strictEqual(arrived.apiKey.location, "secure", "the user's storage choice survives the prefill");
			assert.deepStrictEqual(intentOf(arrived).secrets.apiKey, {
				action: "set",
				location: "secure",
				value: "sk-inline",
			});
		});
	});

	describe("staleKeyFieldsOnSave", () => {
		/** An edit identity whose apiKey is stored in secret storage. */
		function storedIdentity(
			baseUrl: string,
			extra: Partial<Omit<ReplacedEntryIdentity, "secrets">> & {
				secrets?: Partial<ReplacedEntryIdentity["secrets"]>;
			} = {}
		) {
			return {
				...identity("Prod", baseUrl),
				...extra,
				secrets: {
					apiKey: "secure" as const,
					oauthClientSecret: "none" as const,
					virtualKeyValue: "none" as const,
					...(extra.secrets ?? {}),
				},
			};
		}

		test("a kept secure key under a moved base URL raises the question", () => {
			const original = storedIdentity("http://old.test");
			const moved = draft({ authForm: "apiKey", baseUrl: "http://new.test", apiKey: secret({ existing: "secure" }) });
			assert.deepStrictEqual(staleKeyFieldsOnSave(intentOf(moved, original)), ["apiKey"]);
		});

		test("each field compares its OWN destination: a base-URL move takes the keys, not the client secret", () => {
			// The stamp rule is per field (shared secretDestination): the keys pair
			// with the base URL, the client secret with the token URL, so a base
			// URL move with the token URL standing still leaves it out.
			const original = storedIdentity("http://old.test", {
				oauthTokenUrl: "https://idp.test/token",
				oauthClientId: "client",
				secrets: { oauthClientSecret: "secure", virtualKeyValue: "secure" },
			});
			const moved = draft({
				authForm: "oauth",
				baseUrl: "http://new.test",
				oauthTokenUrl: "https://idp.test/token",
				oauthClientId: "client",
				apiKey: secret({ existing: "secure" }),
				oauthClientSecret: secret({ existing: "secure" }),
				virtualKeyHeader: "x-key",
				virtualKeyValue: secret({ existing: "secure" }),
			});
			assert.deepStrictEqual(staleKeyFieldsOnSave(intentOf(moved, original)), ["apiKey", "virtualKeyValue"]);
		});

		test("a moved token URL raises the question for the kept client secret alone", () => {
			const original = storedIdentity("http://old.test", {
				oauthTokenUrl: "https://idp-a.test/token",
				oauthClientId: "client",
				secrets: { oauthClientSecret: "secure" },
			});
			const moved = draft({
				authForm: "oauth",
				baseUrl: "http://old.test",
				oauthTokenUrl: "https://idp-b.test/token",
				oauthClientId: "client",
				apiKey: secret({ existing: "secure" }),
				oauthClientSecret: secret({ existing: "secure" }),
			});
			assert.deepStrictEqual(staleKeyFieldsOnSave(intentOf(moved, original)), ["oauthClientSecret"]);
			// The token URL compares VERBATIM (the exchange fetches it exactly), so
			// even a trailing slash is a different destination.
			const slashed = draft({
				authForm: "oauth",
				baseUrl: "http://old.test",
				oauthTokenUrl: "https://idp-a.test/token/",
				oauthClientId: "client",
				apiKey: secret({ existing: "secure" }),
				oauthClientSecret: secret({ existing: "secure" }),
			});
			assert.deepStrictEqual(staleKeyFieldsOnSave(intentOf(slashed, original)), ["oauthClientSecret"]);
		});

		test("no question without a URL move: unchanged, or changed only by the trailing slash the stamp rule ignores", () => {
			const original = storedIdentity("http://old.test");
			const kept = (baseUrl: string) => draft({ authForm: "apiKey", baseUrl, apiKey: secret({ existing: "secure" }) });
			assert.deepStrictEqual(staleKeyFieldsOnSave(intentOf(kept("http://old.test"), original)), []);
			assert.deepStrictEqual(staleKeyFieldsOnSave(intentOf(kept("http://old.test/"), original)), []);
		});

		test("no question without a kept stored value: inline location, a typed replacement, a clear, or an add form", () => {
			const inline = storedIdentity("http://old.test", { secrets: { apiKey: "settings" } });
			const inlineDraft = draft({
				authForm: "apiKey",
				baseUrl: "http://new.test",
				apiKey: secret({ existing: "settings", location: "settings", value: "sk-inline", prefill: "sk-inline" }),
			});
			assert.deepStrictEqual(staleKeyFieldsOnSave(intentOf(inlineDraft, inline)), []);

			const original = storedIdentity("http://old.test");
			const typed = draft({
				authForm: "apiKey",
				baseUrl: "http://new.test",
				apiKey: secret({ existing: "secure", value: "sk-rotated" }),
			});
			assert.deepStrictEqual(staleKeyFieldsOnSave(intentOf(typed, original)), [], "a set stamps fresh on its own");

			const cleared = draft({
				authForm: "apiKey",
				baseUrl: "http://new.test",
				apiKey: secret({ existing: "secure", clear: true }),
			});
			assert.deepStrictEqual(staleKeyFieldsOnSave(intentOf(cleared, original)), [], "a clear already answers it");

			const added = draft({ authForm: "apiKey", baseUrl: "http://new.test" });
			assert.deepStrictEqual(staleKeyFieldsOnSave(intentOf(added)), [], "an add form shows no credentials");
		});
	});

	describe("saveFailureDisposition", () => {
		test("an operation-kind failure closes the form (the save committed, the draft is stale); validation returns to editing", () => {
			assert.strictEqual(saveFailureDisposition("operation"), "close");
			assert.strictEqual(saveFailureDisposition("validation"), "edit");
		});
	});

	describe("parseServerFormForTest", () => {
		test("label and model-parameter problems never gate a probe; the real label still rides the intent", () => {
			// An empty label plus a broken parameter row block Save but not Test.
			const parse = parseServerFormForTest(
				draft({ label: "  ", modelParameters: [{ prefix: "", params: [newParamRow("", "not json")] }] })
			);
			assert.ok(parse.ok, "connection-clean drafts must parse");
			assert.strictEqual(parse.intent.server.label, "");
			assert.strictEqual(parse.intent.server.modelParameters, undefined);
			assert.strictEqual(parse.intent.replace, undefined);
		});

		test("connection-relevant problems block with the same rules and messages as the save parse", () => {
			const broken = draft({
				authForm: "oauth",
				baseUrl: "not a url",
				oauthClientId: "client-1",
				virtualKeyHeader: "bad header",
			});
			const parse = parseServerFormForTest(broken);
			assert.ok(!parse.ok);
			const full = parseServerForm(broken);
			assert.ok(!full.ok);
			// Field for field the same problems the save parse computes.
			for (const field of CONNECTION_FIELDS) {
				assert.strictEqual(parse.problems[field], full.problems[field], field);
			}
			assert.strictEqual(parse.problems.label, undefined, "label problems stay out");
		});

		test("the assembled intent carries the save parse's directives and the edited entry's replace identity", () => {
			const edited = draft({
				authForm: "oauth",
				label: "Renamed",
				apiKey: secret({ value: " sk-typed ", location: "settings" }),
				// A stored OAuth secret resolves through "keep", so the pairing rules
				// require its token URL and client ID, for a test as for a save.
				oauthTokenUrl: "https://idp.test/token",
				oauthClientId: "client-1",
				oauthClientSecret: secret({ existing: "secure" }),
			});
			const parse = parseServerFormForTest(edited, { original: identity("Prod") });
			assert.ok(parse.ok, `expected a clean parse, got ${JSON.stringify(parse)}`);
			assert.deepStrictEqual(parse.intent.replace, identity("Prod"));
			assert.strictEqual(parse.intent.server.label, "Renamed");
			assert.strictEqual(parse.intent.server.oauthClientId, "client-1");
			assert.deepStrictEqual(parse.intent.secrets, {
				apiKey: { action: "set", location: "settings", value: "sk-typed" },
				oauthClientSecret: { action: "keep" },
				virtualKeyValue: { action: "keep" },
			});
		});

		test("CONNECTION_FIELDS is exactly the field catalog minus label and the record, list, budget, and mcp fields", () => {
			// A new connection-shaped field must join CONNECTION_FIELDS or this
			// fails. modelCapabilities, expectedFailures, declaredModels, and
			// budget stay out by design: they shape the probe's OUTCOME
			// presentation, never the connection it tests, and mcp names a second
			// endpoint the probe never dials. The auth-form pick and the header
			// rows ARE connection-shaped: the probe sends what they say.
			const expected = SERVER_FORM_FIELD_ORDER.filter(
				(field) =>
					field !== "label" &&
					field !== "modelParameters" &&
					field !== "modelCapabilities" &&
					field !== "expectedFailures" &&
					field !== "declaredModels" &&
					field !== "budget" &&
					field !== "mcp"
			);
			assert.deepStrictEqual([...CONNECTION_FIELDS].sort(), [...expected].sort());
		});

		test("clean capability rows and expectedFailures ride the probe intent; broken rows are dropped, not blocking", () => {
			const withCaps = parseServerFormForTest(
				draft({
					modelCapabilities: [{ prefix: "my-model", params: [newParamRow("supports_vision", "true")] }],
					expectedFailures: ["modelListing"],
				})
			);
			assert.ok(withCaps.ok);
			assert.deepStrictEqual(withCaps.intent.server.modelCapabilities, { "my-model": { supports_vision: true } });
			assert.deepStrictEqual(withCaps.intent.server.expectedFailures, ["modelListing"]);

			const withBrokenCaps = parseServerFormForTest(
				draft({
					modelCapabilities: [{ prefix: "my-model", params: [newParamRow("context_length", "not a number")] }],
					expectedFailures: ["modelInfo"],
				})
			);
			assert.ok(withBrokenCaps.ok, "broken capability rows never gate a probe");
			assert.deepStrictEqual(
				withBrokenCaps.intent.server.modelCapabilities,
				{},
				"dropped rows leave the always-present record empty"
			);
			assert.deepStrictEqual(withBrokenCaps.intent.server.expectedFailures, ["modelInfo"]);
		});
	});

	describe("sectionFailureText", () => {
		test("a field-prefixed boundary message is promoted to the field's display name, no double colon", () => {
			assert.strictEqual(
				sectionFailureText("Saving the server failed:", "label: an entry with this label already exists"),
				"Label: an entry with this label already exists"
			);
			assert.strictEqual(
				sectionFailureText("Saving the server failed:", "virtualKeyValue: enter the key sent in this header"),
				"Virtual key value: enter the key sent in this header"
			);
		});

		test("messages without a field prefix keep the section prefix, for removals too", () => {
			assert.strictEqual(
				sectionFailureText("Removing failed:", "No servers setting entry has this label"),
				"Removing failed: No servers setting entry has this label"
			);
			assert.strictEqual(
				sectionFailureText("Saving the server failed:", "The change was not applied; see the LiteLLM output log."),
				"Saving the server failed: The change was not applied; see the LiteLLM output log."
			);
		});

		test("a colon whose prefix is not a form field is left alone", () => {
			assert.strictEqual(
				sectionFailureText("Saving the server failed:", "toString: reserved name"),
				"Saving the server failed: toString: reserved name"
			);
		});

		test("a translated message body behind the ASCII field prefix still routes to the field", () => {
			// The intent boundary localizes only the body of a field-prefixed
			// message; the "fieldId:" prefix stays untranslated ASCII, so the
			// promotion must recognize the field in any language.
			assert.strictEqual(
				sectionFailureText("Saving the server failed:", "label: 此标签的条目已存在"),
				"Label: 此标签的条目已存在"
			);
			assert.strictEqual(
				sectionFailureText("Adopting the server failed:", "baseUrl: 不是可用的位址"),
				"Base URL: 不是可用的位址"
			);
		});
	});

	describe("changedServerFormFields", () => {
		test("a draft that has not moved reports nothing, however it was built", () => {
			assert.deepStrictEqual(changedServerFormFields(draft(), draft()), []);
			const rich = draft({
				headers: [{ name: "x-env", valueText: "prod" }],
				modelParameters: [{ prefix: "gpt-5*", params: [newParamRow("temperature", "0.2")] }],
				expectedFailures: ["modelInfo"],
				apiVersion: apiVersionDraftOf("v2"),
			});
			assert.deepStrictEqual(changedServerFormFields(rich, { ...rich }), []);
		});

		test("scalar, structured, and secret edits each count once, in field order", () => {
			const baseline = draft({ authForm: "apiKey", apiKey: secret({ existing: "secure" }) });
			const changed = {
				...baseline,
				label: "Staging",
				apiVersion: apiVersionDraftOf(""),
				apiKey: secret({ existing: "secure", value: "sk-new" }),
				headers: [{ name: "x-env", valueText: "prod" }],
			};
			assert.deepStrictEqual(changedServerFormFields(changed, baseline), ["label", "apiVersion", "apiKey", "headers"]);
		});

		test("a secret compares on what the user can change, never on where the value already lives", () => {
			const baseline = draft({
				authForm: "apiKey",
				apiKey: secret({ existing: "settings", prefill: "sk-stored", value: "sk-stored" }),
			});
			// Same value, different provenance metadata: not an edit.
			const rebadged = {
				...baseline,
				apiKey: secret({ existing: "secure", prefill: undefined, value: "sk-stored" }),
			};
			assert.deepStrictEqual(changedServerFormFields(rebadged, baseline), []);
			// The three things the user CAN change each count; the storage pick
			// counts only on a field that holds a value (see the next test).
			for (const patch of [{ value: "sk-other" }, { location: "settings" as const }, { clear: true }]) {
				const edited = { ...baseline, apiKey: { ...baseline.apiKey, ...patch } };
				assert.deepStrictEqual(changedServerFormFields(edited, baseline), ["apiKey"]);
			}
		});

		test("what the save would not write does not count: an empty field's storage pick, a reordered failure list", () => {
			// parseSecret returns "keep" for an empty field whatever the radio
			// says, so flipping it writes nothing and must not read as unsaved.
			const empty = draft({ authForm: "apiKey", apiKey: secret({ existing: "secure" }) });
			const flipped = { ...empty, apiKey: secret({ existing: "secure", location: "settings" }) };
			assert.deepStrictEqual(changedServerFormFields(flipped, empty), []);
			// The same flip on a TYPED value does change where it lands.
			const typed = draft({ authForm: "apiKey", apiKey: secret({ value: "sk-new" }) });
			const relocated = { ...typed, apiKey: secret({ value: "sk-new", location: "settings" }) };
			assert.deepStrictEqual(changedServerFormFields(relocated, typed), ["apiKey"]);
			// The checkbox set canonicalizes its order; the stored entry keeps
			// the author's. Same set, nothing to save.
			const stored = draft({ expectedFailures: ["modelInfo", "modelListing"] });
			const toggled = draft({ expectedFailures: ["modelListing", "modelInfo"] });
			assert.deepStrictEqual(changedServerFormFields(toggled, stored), []);
			assert.deepStrictEqual(changedServerFormFields(draft({ expectedFailures: ["modelInfo"] }), stored), [
				"expectedFailures",
			]);
		});

		test("whitespace-only and padded edits do not count; a trim-visible one does", () => {
			// parseSecret trims, so a lone space still saves as "keep"; the save
			// bar must not promise a write Save will not perform.
			const stored = draft({ authForm: "apiKey", apiKey: secret({ existing: "secure" }) });
			const spaced = { ...stored, apiKey: { ...stored.apiKey, value: " " } };
			assert.deepStrictEqual(intentOf(spaced).secrets.apiKey, { action: "keep" });
			assert.deepStrictEqual(changedServerFormFields(spaced, stored), []);
			// Trailing whitespace on an untouched inline prefill: still the
			// prefill after the trim, so Save keeps and the count stays empty.
			const prefilled = draft({
				authForm: "apiKey",
				apiKey: secret({ existing: "settings", prefill: "sk-stored", value: "sk-stored", location: "settings" }),
			});
			const padded = { ...prefilled, apiKey: { ...prefilled.apiKey, value: "sk-stored " } };
			assert.deepStrictEqual(intentOf(padded).secrets.apiKey, { action: "keep" });
			assert.deepStrictEqual(changedServerFormFields(padded, prefilled), []);
			// Padding around a typed value saves the same trimmed set: no change;
			// a trim-visible difference still counts.
			const typed = draft({ authForm: "apiKey", apiKey: secret({ value: "sk-new" }) });
			const repadded = { ...typed, apiKey: { ...typed.apiKey, value: " sk-new " } };
			assert.deepStrictEqual(changedServerFormFields(repadded, typed), []);
			const other = { ...typed, apiKey: { ...typed.apiKey, value: " sk-other " } };
			assert.deepStrictEqual(changedServerFormFields(other, typed), ["apiKey"]);
		});

		test("an inactive field's leftover text does not count; its remove mark still does", () => {
			// Typed while OAuth was picked, then the form switched back: Save
			// emits "keep" for the inactive client secret, so the bar stays quiet.
			const baseline = draft({ authForm: "apiKey" });
			const leftover = { ...baseline, oauthClientSecret: secret({ value: "s3cret" }) };
			assert.deepStrictEqual(intentOf(leftover).secrets.oauthClientSecret, { action: "keep" });
			assert.deepStrictEqual(changedServerFormFields(leftover, baseline), []);
			// The remove mark stays honored on an inactive field, so it counts.
			const kept = { ...baseline, oauthClientSecret: secret({ existing: "secure" }) };
			const cleared = { ...baseline, oauthClientSecret: secret({ existing: "secure", clear: true }) };
			assert.deepStrictEqual(changedServerFormFields(cleared, kept), ["oauthClientSecret"]);
		});

		test("an inline prefill applied to draft and baseline alike counts as nothing to save", () => {
			// What the form does when the readInlineSecrets response lands: the same
			// transform runs over both, so a value the form filled in is not an edit.
			const opened = draft({ authForm: "apiKey", apiKey: secret({ existing: "settings" }) });
			const values = { apiKey: "sk-inline" } as const;
			assert.deepStrictEqual(
				changedServerFormFields(applyInlinePrefill(opened, values), applyInlinePrefill(opened, values)),
				[]
			);
			// A prefill that reached only the draft is a real difference.
			assert.deepStrictEqual(changedServerFormFields(applyInlinePrefill(opened, values), opened), ["apiKey"]);
		});

		test("leftover auth text on a form that does not send it does not count; the same text sent does", () => {
			// Typed while OAuth was picked, then the selector switched to apiKey:
			// Save excludes the inactive texts, so the bar stays quiet - and the
			// connection caveat with it (both oauth fields are CONNECTION_FIELDS).
			const baseline = draft({ authForm: "apiKey" });
			const leftover = { ...baseline, oauthTokenUrl: "https://idp.test/token", oauthScopes: "read" };
			assert.strictEqual(intentOf(leftover).server.oauthTokenUrl, undefined);
			assert.deepStrictEqual(changedServerFormFields(leftover, baseline), []);
			// The same texts under an active OAuth form are saved, so they count.
			const oauthBaseline = draft({ authForm: "oauth", oauthTokenUrl: "https://idp.test/token", oauthClientId: "c" });
			const scoped = { ...oauthBaseline, oauthScopes: "read" };
			assert.deepStrictEqual(changedServerFormFields(scoped, oauthBaseline), ["oauthScopes"]);
		});

		test("a padded scalar saves the same trimmed value and does not count; a trim-visible edit does", () => {
			const baseline = draft({ budget: "5" });
			assert.deepStrictEqual(changedServerFormFields({ ...baseline, label: "Prod " }, baseline), []);
			assert.deepStrictEqual(changedServerFormFields({ ...baseline, baseUrl: " http://localhost:4000" }, baseline), []);
			assert.deepStrictEqual(changedServerFormFields({ ...baseline, budget: " 5 " }, baseline), []);
			// The budget compares the number Save writes, not its spelling.
			assert.deepStrictEqual(changedServerFormFields({ ...baseline, budget: "5.0" }, baseline), []);
			assert.deepStrictEqual(changedServerFormFields({ ...baseline, label: "Staging" }, baseline), ["label"]);
			assert.deepStrictEqual(changedServerFormFields({ ...baseline, budget: "6" }, baseline), ["budget"]);
			// Unsavable budget text still counts (trimmed): the bar must not go
			// quiet on an edit Save will refuse.
			assert.deepStrictEqual(changedServerFormFields({ ...baseline, budget: "abc" }, baseline), ["budget"]);
			assert.deepStrictEqual(
				changedServerFormFields({ ...baseline, budget: " abc " }, { ...baseline, budget: "abc" }),
				[]
			);
		});

		test("declaredModels compares the parsed list: blank lines, padding, and duplicates never count", () => {
			const baseline = draft({ declaredModels: "gpt-4" });
			const noisy = { ...baseline, declaredModels: " gpt-4 \n\ngpt-4\n" };
			assert.deepStrictEqual(intentOf(noisy).server.declaredModels, ["gpt-4"]);
			assert.deepStrictEqual(changedServerFormFields(noisy, baseline), []);
			// A new model and a reordered list both save a different array.
			assert.deepStrictEqual(changedServerFormFields({ ...baseline, declaredModels: "gpt-4\ngpt-5" }, baseline), [
				"declaredModels",
			]);
			const ordered = draft({ declaredModels: "gpt-4\ngpt-5" });
			assert.deepStrictEqual(changedServerFormFields({ ...ordered, declaredModels: "gpt-5\ngpt-4" }, ordered), [
				"declaredModels",
			]);
		});

		test("the apiVersion custom text counts only in custom mode, trimmed; a mode switch always counts", () => {
			const baseline = draft({ apiVersion: { mode: "custom", custom: "v2" } });
			assert.deepStrictEqual(
				changedServerFormFields({ ...baseline, apiVersion: { mode: "custom", custom: " v2 " } }, baseline),
				[]
			);
			assert.deepStrictEqual(
				changedServerFormFields({ ...baseline, apiVersion: { mode: "custom", custom: "v3" } }, baseline),
				["apiVersion"]
			);
			// Leftover custom text under auto or none is never saved.
			const auto = draft({ apiVersion: { mode: "auto", custom: "" } });
			assert.deepStrictEqual(
				changedServerFormFields({ ...auto, apiVersion: { mode: "auto", custom: "v2" } }, auto),
				[]
			);
			// Custom with no text yet blocks Save, but the mode was picked: it counts.
			assert.deepStrictEqual(changedServerFormFields({ ...auto, apiVersion: { mode: "custom", custom: "" } }, auto), [
				"apiVersion",
			]);
		});

		test("the always-visible controls count by draft, even when the save would write the same payload", () => {
			// The deliberate carve-out: the auth selector and the row grids are
			// visible controls, so a move the user can see always registers. A
			// switch that strands a stored credential is refused (the redesign
			// suite pins that); a switch toward an unfilled form or between forms
			// that still send everything stored stays byte-identical and counts.
			const baseline = draft({ authForm: "none" });
			const switched = { ...baseline, authForm: "virtualKey" as const };
			assert.deepStrictEqual(intentOf(switched).server, intentOf(baseline).server);
			assert.deepStrictEqual(intentOf(switched).secrets, intentOf(baseline).secrets);
			assert.deepStrictEqual(changedServerFormFields(switched, baseline), ["authForm"]);
			// The stored shape of that remainder: apiKey carries the virtual-key
			// companion, so nothing is stranded and the switch saves the same entry.
			const vkStored = draft({
				authForm: "virtualKey",
				virtualKeyHeader: "x-key",
				virtualKeyValue: secret({ existing: "secure" }),
			});
			const toApiKey = { ...vkStored, authForm: "apiKey" as const };
			assert.deepStrictEqual(intentOf(toApiKey).server, intentOf(vkStored).server);
			assert.deepStrictEqual(intentOf(toApiKey).secrets, intentOf(vkStored).secrets);
			assert.deepStrictEqual(changedServerFormFields(toApiKey, vkStored), ["authForm"]);
			// Matcher keys persist verbatim (the grammar trims nothing), so the
			// byte-identical example is a padded VALUE: the JSON parse reads the
			// same number, and the grid still reports the edit.
			const rows = draft({
				modelCapabilities: [{ prefix: "gpt-5*", params: [newParamRow("max_output_tokens", "8")] }],
			});
			const padded = draft({
				modelCapabilities: [{ prefix: "gpt-5*", params: [newParamRow("max_output_tokens", " 8 ")] }],
			});
			assert.deepStrictEqual(intentOf(padded).server.modelCapabilities, intentOf(rows).server.modelCapabilities);
			assert.deepStrictEqual(changedServerFormFields(padded, rows), ["modelCapabilities"]);
		});
	});
	describe("the MCP control", () => {
		test("off writes no opt-in", () => {
			assert.strictEqual(intentOf(draft()).server.mcp, null);
		});

		test("on with no URL publishes the derived endpoint; a usable URL names another one", () => {
			assert.strictEqual(intentOf(draft({ mcp: { enabled: true, url: "" } })).server.mcp, true);
			assert.strictEqual(intentOf(draft({ mcp: { enabled: true, url: "   " } })).server.mcp, true);
			assert.deepStrictEqual(intentOf(draft({ mcp: { enabled: true, url: " https://gw.example/mcp " } })).server.mcp, {
				url: "https://gw.example/mcp",
			});
		});

		test("an unusable URL blocks the save, naming the field", () => {
			assert.deepStrictEqual(problemsOf(draft({ mcp: { enabled: true, url: "not a url" } })), {
				mcp: "Must be a usable http(s) URL",
			});
			// Off, the same text is inert: the parse never reads a control the
			// user turned off.
			assert.deepStrictEqual(problemsOf(draft({ mcp: { enabled: false, url: "not a url" } })), {});
		});

		test("the draft-test intent carries no opt-in: a probe is a connection check, not a save", () => {
			const parse = parseServerFormForTest(draft({ mcp: { enabled: true, url: "https://gw.example/mcp" } }));
			assert.ok(parse.ok);
			assert.strictEqual(parse.intent.server.mcp, null);
		});

		test("an unusable URL does not block the probe: the endpoint is not a connection field", () => {
			const parse = parseServerFormForTest(draft({ mcp: { enabled: true, url: "not a url" } }));
			assert.ok(parse.ok);
		});

		test("the save bar counts what Save would write, so leftover text under an off switch stays quiet", () => {
			const off = draft();
			assert.deepStrictEqual(
				changedServerFormFields(draft({ mcp: { enabled: false, url: "https://x.test" } }), off),
				[]
			);
			assert.deepStrictEqual(changedServerFormFields(draft({ mcp: { enabled: true, url: "" } }), off), ["mcp"]);
			assert.deepStrictEqual(changedServerFormFields(draft({ mcp: { enabled: true, url: " https://x.test " } }), off), [
				"mcp",
			]);
			// Padding alone is not an edit; a blocking URL still counts, or the
			// bar would go quiet on an edit that refuses to save.
			const url = draft({ mcp: { enabled: true, url: "https://x.test" } });
			assert.deepStrictEqual(
				changedServerFormFields(draft({ mcp: { enabled: true, url: " https://x.test " } }), url),
				[]
			);
			assert.deepStrictEqual(changedServerFormFields(draft({ mcp: { enabled: true, url: "nope" } }), url), ["mcp"]);
		});

		test("the prefill round-trips every stored shape", () => {
			assert.deepStrictEqual(mcpDraftOf(undefined), { enabled: false, url: "" });
			assert.deepStrictEqual(mcpDraftOf(true), { enabled: true, url: "" });
			assert.deepStrictEqual(mcpDraftOf({ url: "https://gw.example/mcp" }), {
				enabled: true,
				url: "https://gw.example/mcp",
			});
			for (const stored of [true, { url: "https://gw.example/mcp" }] as const) {
				assert.deepStrictEqual(intentOf(draft({ mcp: mcpDraftOf(stored) })).server.mcp, stored);
			}
		});
	});
});
