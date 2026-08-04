import * as assert from "node:assert";
import type {
	SecretFieldDraft,
	ServerFormDraft,
	ServerFormIntent,
	ServerFormProblems,
} from "../../../extension/dashboard/serverForm";
import {
	applyInlinePrefill,
	CONNECTION_FIELDS,
	EMPTY_SERVER_FORM,
	isUsableHttpUrl,
	OAUTH_SECTION_FIELDS,
	parseServerForm,
	parseServerFormForTest,
	SERVER_FORM_FIELD_ORDER,
	saveFailureDisposition,
	sectionFailureText,
	serverFormFieldLabel,
} from "../../../extension/dashboard/serverForm";

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

/** The ok arm's intent; fails the test when the draft has problems. */
function intentOf(draft: ServerFormDraft, originalLabel?: string): ServerFormIntent {
	const parse = parseServerForm(draft, originalLabel !== undefined ? { originalLabel } : {});
	if (!parse.ok) {
		assert.fail(`expected a clean parse, got problems: ${JSON.stringify(parse.problems)}`);
	}
	return parse.intent;
}

suite("extension/dashboard/serverForm", () => {
	suite("isUsableHttpUrl", () => {
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

	suite("parseServerForm problems", () => {
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
			const context = { takenLabels: ["Prod", "Staging"], originalLabel: "Prod" };
			assert.notStrictEqual(problemsOf(draft({ label: "Staging" }), context).label, undefined);
			assert.strictEqual(problemsOf(draft({ label: "Prod" }), context).label, undefined, "keeping the label is fine");
			assert.strictEqual(problemsOf(draft({ label: "Fresh" }), context).label, undefined);
			assert.strictEqual(
				problemsOf(draft({ label: "Staging" }), { takenLabels: ["Staging"] }).label,
				undefined,
				"an add over an existing label replaces it; no originalLabel, no collision problem"
			);
		});

		test("OAuth fields are one unit: any of them present requires the token URL and client ID", () => {
			const clientOnly = problemsOf(draft({ oauthClientId: "client" }));
			assert.notStrictEqual(clientOnly.oauthTokenUrl, undefined);

			const urlOnly = problemsOf(draft({ oauthTokenUrl: "https://idp.test/token" }));
			assert.notStrictEqual(urlOnly.oauthClientId, undefined);

			const secretOnly = problemsOf(draft({ oauthClientSecret: secret({ value: "s" }) }));
			assert.notStrictEqual(secretOnly.oauthTokenUrl, undefined);
			assert.notStrictEqual(secretOnly.oauthClientId, undefined);

			const complete = problemsOf(draft({ oauthTokenUrl: "https://idp.test/token", oauthClientId: "client" }));
			assert.deepStrictEqual(complete, {});
		});

		test("a kept secure-side client secret also demands the OAuth pair", () => {
			const problems = problemsOf(draft({ oauthClientSecret: secret({ existing: "secure" }) }));
			assert.notStrictEqual(problems.oauthTokenUrl, undefined);
		});

		test("the virtual key pair is both-or-neither and must be header-sendable", () => {
			assert.notStrictEqual(problemsOf(draft({ virtualKeyHeader: "bad name" })).virtualKeyHeader, undefined);
			assert.notStrictEqual(problemsOf(draft({ virtualKeyHeader: "x-key" })).virtualKeyValue, undefined);
			assert.notStrictEqual(problemsOf(draft({ virtualKeyValue: secret({ value: "v" }) })).virtualKeyHeader, undefined);
			assert.notStrictEqual(
				problemsOf(draft({ virtualKeyHeader: "x-key", virtualKeyValue: secret({ value: "a\nb" }) })).virtualKeyValue,
				undefined
			);
			assert.deepStrictEqual(
				problemsOf(draft({ virtualKeyHeader: "x-key", virtualKeyValue: secret({ value: "vk-1" }) })),
				{}
			);
		});

		test("a header whose value is kept in secure storage satisfies the pair", () => {
			const problems = problemsOf(
				draft({ virtualKeyHeader: "x-key", virtualKeyValue: secret({ existing: "secure" }) })
			);
			assert.deepStrictEqual(problems, {});
		});

		test("clearing the kept value re-breaks the pair", () => {
			const problems = problemsOf(
				draft({ virtualKeyHeader: "x-key", virtualKeyValue: secret({ existing: "secure", clear: true }) })
			);
			assert.notStrictEqual(problems.virtualKeyValue, undefined);
		});

		test("a cleared virtual key with stale typed text saves as clear instead of blocking on a disabled input", () => {
			// The regression the parse-once shape fixes: the old validator read the
			// raw input text where assembly read the clear directive, so a value
			// like "a\nb" left in the (disabled) input of a field marked remove
			// blocked Save on a problem the user could not edit away. The directive
			// says the value is going away; nothing about it can block.
			const parse = parseServerForm(
				draft({ virtualKeyValue: secret({ value: "a\nb", clear: true, existing: "secure" }) })
			);
			assert.ok(parse.ok, "the stale text of a cleared field is not validated");
			assert.deepStrictEqual(parse.intent.secrets.virtualKeyValue, { action: "clear" });
		});
	});

	suite("field catalog", () => {
		test("the field order covers every draft field exactly once, with a display label each", () => {
			const draftFields = Object.keys(EMPTY_SERVER_FORM).sort();
			assert.deepStrictEqual([...SERVER_FORM_FIELD_ORDER].sort(), draftFields);
			for (const field of SERVER_FORM_FIELD_ORDER) {
				assert.ok(serverFormFieldLabel(field).length > 0, field);
			}
		});

		test("OAuth-section fields are a subset of the order, so a summary can always point into the form", () => {
			for (const field of OAUTH_SECTION_FIELDS) {
				assert.ok(SERVER_FORM_FIELD_ORDER.includes(field), field);
			}
		});

		test("a partial-OAuth draft's problems all sit inside the collapsible section", () => {
			// The section must be forced open on save: with label and baseUrl
			// valid, every blocking problem here would otherwise be invisible.
			const problems = problemsOf(draft({ oauthTokenUrl: "https://idp.test/token" }));
			const failing = SERVER_FORM_FIELD_ORDER.filter((field) => problems[field] !== undefined);
			assert.ok(failing.length > 0);
			for (const field of failing) {
				assert.ok(OAUTH_SECTION_FIELDS.includes(field), field);
			}
		});
	});

	suite("parseServerForm intent", () => {
		test("trims fields and omits empty optionals entirely", () => {
			const intent = intentOf(draft({ label: " Prod ", baseUrl: " http://localhost:4000 ", oauthScopes: "  " }));
			// The two entry-record fields are the exception: they ride every
			// intent, even empty, so the save can tell a deliberate clear from
			// a payload that predates their editors.
			assert.deepStrictEqual(intent.server, {
				label: "Prod",
				baseUrl: "http://localhost:4000",
				modelCapabilities: {},
				expectedFailures: [],
			});
			assert.strictEqual(intent.replaceLabel, undefined);
		});

		test("empty secret inputs become keep, typed values become set with their location, clear wins", () => {
			// The kept client secret makes the draft OAuth-shaped, so the pair it
			// demands is present: only clean drafts parse to an intent at all.
			const intent = intentOf(
				draft({
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

		test("an edit carries the original label as replaceLabel", () => {
			const intent = intentOf(draft({ label: "Renamed" }), "Prod");
			assert.strictEqual(intent.replaceLabel, "Prod");
			assert.strictEqual(intent.server.label, "Renamed");
		});

		test("an untouched prefilled inline value assembles as keep, never a rewrite", () => {
			const prefilled = secret({
				value: "sk-inline",
				prefill: "sk-inline",
				location: "settings",
				existing: "settings",
			});
			const intent = intentOf(draft({ apiKey: prefilled }));
			assert.deepStrictEqual(intent.secrets.apiKey, { action: "keep" });
		});

		test("an edited prefill assembles as set with the new value; reverting to the prefill is keep again", () => {
			const prefilled = secret({ value: "sk-new", prefill: "sk-old", location: "settings", existing: "settings" });
			const intent = intentOf(draft({ apiKey: prefilled }));
			assert.deepStrictEqual(intent.secrets.apiKey, { action: "set", location: "settings", value: "sk-new" });

			const reverted = intentOf(draft({ apiKey: { ...prefilled, value: " sk-old " } }));
			assert.deepStrictEqual(reverted.secrets.apiKey, { action: "keep" }, "untouched means unchanged value, trimmed");
		});

		test("an emptied prefill assembles as keep; the remove checkbox is the explicit clear gesture", () => {
			const emptied = secret({ value: "", prefill: "sk-inline", location: "settings", existing: "settings" });
			assert.deepStrictEqual(intentOf(draft({ apiKey: emptied })).secrets.apiKey, { action: "keep" });
			assert.deepStrictEqual(intentOf(draft({ apiKey: { ...emptied, clear: true } })).secrets.apiKey, {
				action: "clear",
			});
		});

		test("a prefill with the storage choice moved to secure assembles as a set there: a real relocation", () => {
			const moved = secret({ value: "sk-inline", prefill: "sk-inline", location: "secure", existing: "settings" });
			const intent = intentOf(draft({ apiKey: moved }));
			assert.deepStrictEqual(intent.secrets.apiKey, { action: "set", location: "secure", value: "sk-inline" });
		});
	});

	suite("per-entry model parameters", () => {
		test("blocked rows surface on the field slot and row-aligned, like the global editor renders them", () => {
			const parse = parseServerForm(
				draft({ modelParameters: [{ prefix: "gpt-4", params: [{ key: "temperature", valueText: "not json" }] }] })
			);
			assert.ok(!parse.ok);
			assert.notStrictEqual(parse.problems.modelParameters, undefined, "the save summary can point at the field");
			assert.strictEqual(parse.modelParameterProblems.length, 1);
			assert.notStrictEqual(parse.modelParameterProblems[0]?.params[0], undefined);
		});

		test("a draft blocked by another field carries no row problems for clean parameter rows", () => {
			const parse = parseServerForm(
				draft({ label: "", modelParameters: [{ prefix: "gpt-4", params: [{ key: "top_p", valueText: "0.9" }] }] })
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
							params: [
								{ key: "temperature", valueText: "0.2" },
								{ key: "stop", valueText: '["END"]' },
							],
						},
					],
				})
			);
			assert.deepStrictEqual(intent.server.modelParameters, { "gpt-4": { temperature: 0.2, stop: ["END"] } });
			assert.ok(!("modelParameters" in intentOf(draft()).server));
		});
	});

	suite("per-entry model capabilities and expected failures", () => {
		test("blocked capability rows surface on the field slot and row-aligned", () => {
			const parse = parseServerForm(
				draft({
					modelCapabilities: [{ prefix: "gpt-4", params: [{ key: "context_length", valueText: "not a number" }] }],
				})
			);
			assert.ok(!parse.ok);
			assert.notStrictEqual(parse.problems.modelCapabilities, undefined, "the save summary can point at the field");
			assert.notStrictEqual(parse.modelCapabilityIssues[0]?.rows[0]?.problem, undefined);
		});

		test("unknown-key hints ride a clean parse without blocking it", () => {
			const parse = parseServerForm(
				draft({ modelCapabilities: [{ prefix: "gpt-4", params: [{ key: "supports_pdf_input", valueText: "true" }] }] })
			);
			assert.ok(parse.ok, "unknown keys hint, never block");
			assert.notStrictEqual(parse.modelCapabilityIssues[0]?.rows[0]?.hint, undefined);
			assert.deepStrictEqual(parse.intent.server.modelCapabilities, { "gpt-4": { supports_pdf_input: true } });
		});

		test("clean rows and the checkbox list assemble into the intent; empty drafts send both fields empty", () => {
			const intent = intentOf(
				draft({
					modelCapabilities: [
						{
							prefix: "my-model",
							params: [
								{ key: "context_length", valueText: "128000" },
								{ key: "supports_vision", valueText: "true" },
								{ key: "_declare", valueText: "true" },
								{ key: "_openrouter_model", valueText: "openai/gpt-4o" },
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
					_declare: true,
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

	suite("applyInlinePrefill", () => {
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
			// Previously unreachable: the value input was always empty on edit, so
			// a hand-written non-header-sendable inline value slid through. The
			// prefill makes the stored value visible to validation; the problem
			// must sit on the value field (not the header) and clear once the
			// value is edited to something sendable.
			const base = draft({
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
			// The hazard the form's Save gate exists for: the user opens Edit,
			// flips the inline key's radio to "secret storage", and hits Save
			// before the prefill response lands. Assembling at that moment would
			// read the empty field as "keep" and silently drop the relocation -
			// pinned here - so servers.tsx holds the form in its prefill phase
			// while the response is pending; once it arrives, the flipped location
			// survives the prefill and the save assembles the relocation the user
			// asked for.
			const flipped = draft({ apiKey: secret({ existing: "settings", location: "secure" }) });
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

	suite("saveFailureDisposition", () => {
		test("an operation-kind failure closes the form (the save committed, the draft is stale); validation returns to editing", () => {
			assert.strictEqual(saveFailureDisposition("operation"), "close");
			assert.strictEqual(saveFailureDisposition("validation"), "edit");
		});
	});

	suite("parseServerFormForTest", () => {
		test("label and model-parameter problems never gate a probe; the real label still rides the intent", () => {
			// An empty label plus a broken parameter row block Save but not Test.
			const parse = parseServerFormForTest(
				draft({ label: "  ", modelParameters: [{ prefix: "", params: [{ key: "", valueText: "not json" }] }] })
			);
			assert.ok(parse.ok, "connection-clean drafts must parse");
			assert.strictEqual(parse.intent.server.label, "");
			assert.strictEqual(parse.intent.server.modelParameters, undefined);
			assert.strictEqual(parse.intent.replaceLabel, undefined);
		});

		test("connection-relevant problems block with the same rules and messages as the save parse", () => {
			const broken = draft({
				baseUrl: "not a url",
				oauthClientId: "client-1",
				virtualKeyHeader: "bad header",
			});
			const parse = parseServerFormForTest(broken);
			assert.ok(!parse.ok);
			const full = parseServerForm(broken);
			assert.ok(!full.ok);
			// Field for field the same problems the save parse computes: one rule
			// set, two gates.
			for (const field of CONNECTION_FIELDS) {
				assert.strictEqual(parse.problems[field], full.problems[field], field);
			}
			assert.strictEqual(parse.problems.label, undefined, "label problems stay out");
		});

		test("the assembled intent carries the save parse's directives and the edited entry's replaceLabel", () => {
			const edited = draft({
				label: "Renamed",
				apiKey: secret({ value: " sk-typed ", location: "settings" }),
				// A stored OAuth secret resolves through "keep", so the pairing
				// rules require its token URL and client ID - for a test exactly
				// as for a save.
				oauthTokenUrl: "https://idp.test/token",
				oauthClientId: "client-1",
				oauthClientSecret: secret({ existing: "secure" }),
			});
			const parse = parseServerFormForTest(edited, { originalLabel: "Prod" });
			assert.ok(parse.ok, `expected a clean parse, got ${JSON.stringify(parse)}`);
			assert.strictEqual(parse.intent.replaceLabel, "Prod");
			assert.strictEqual(parse.intent.server.label, "Renamed");
			assert.strictEqual(parse.intent.server.oauthClientId, "client-1");
			assert.deepStrictEqual(parse.intent.secrets, {
				apiKey: { action: "set", location: "settings", value: "sk-typed" },
				oauthClientSecret: { action: "keep" },
				virtualKeyValue: { action: "keep" },
			});
		});

		test("CONNECTION_FIELDS is exactly the field catalog minus label and the record and list fields", () => {
			// The clear-on-edit rule and the field catalog cannot drift: a new
			// connection-shaped field must join CONNECTION_FIELDS or this fails.
			// modelCapabilities and expectedFailures stay out by design: they
			// shape the probe's OUTCOME presentation (declared counts, expected
			// downgrades), never the connection it tests.
			const expected = SERVER_FORM_FIELD_ORDER.filter(
				(field) =>
					field !== "label" &&
					field !== "modelParameters" &&
					field !== "modelCapabilities" &&
					field !== "expectedFailures"
			);
			assert.deepStrictEqual([...CONNECTION_FIELDS].sort(), [...expected].sort());
		});

		test("clean capability rows and expectedFailures ride the probe intent; broken rows are dropped, not blocking", () => {
			const withCaps = parseServerFormForTest(
				draft({
					modelCapabilities: [{ prefix: "my-model", params: [{ key: "_declare", valueText: "true" }] }],
					expectedFailures: ["modelListing"],
				})
			);
			assert.ok(withCaps.ok);
			assert.deepStrictEqual(withCaps.intent.server.modelCapabilities, { "my-model": { _declare: true } });
			assert.deepStrictEqual(withCaps.intent.server.expectedFailures, ["modelListing"]);

			const withBrokenCaps = parseServerFormForTest(
				draft({
					modelCapabilities: [{ prefix: "my-model", params: [{ key: "context_length", valueText: "not a number" }] }],
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

	suite("sectionFailureText", () => {
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
			// message; the "fieldId:" prefix stays an untranslated ASCII
			// identifier, so the promotion must keep recognizing the field no
			// matter what language the body arrives in.
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
});
