import * as assert from "node:assert";
import type { SecretFieldDraft, ServerFormDraft } from "../../../extension/dashboard/serverForm";
import {
	applyInlinePrefill,
	assembleServerForm,
	EMPTY_SERVER_FORM,
	hasServerFormProblems,
	isUsableHttpUrl,
	OAUTH_SECTION_FIELDS,
	SERVER_FORM_FIELD_LABELS,
	SERVER_FORM_FIELD_ORDER,
	saveFailureDisposition,
	sectionFailureText,
	validateServerForm,
} from "../../../extension/dashboard/serverForm";

function draft(overrides: Partial<ServerFormDraft> = {}): ServerFormDraft {
	return { ...EMPTY_SERVER_FORM, label: "Prod", baseUrl: "http://localhost:4000", ...overrides };
}

function secret(overrides: Partial<SecretFieldDraft> = {}): SecretFieldDraft {
	return { value: "", location: "secure", clear: false, existing: "none", ...overrides };
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

	suite("validateServerForm", () => {
		test("a minimal valid draft has no problems", () => {
			assert.deepStrictEqual(validateServerForm(draft()), {});
			assert.strictEqual(hasServerFormProblems(validateServerForm(draft())), false);
		});

		test("label and baseUrl are required; reserved labels are refused", () => {
			assert.notStrictEqual(validateServerForm(draft({ label: " " })).label, undefined);
			assert.notStrictEqual(validateServerForm(draft({ label: "__proto__" })).label, undefined);
			assert.notStrictEqual(validateServerForm(draft({ baseUrl: "" })).baseUrl, undefined);
			assert.notStrictEqual(validateServerForm(draft({ baseUrl: "litellm.example.com" })).baseUrl, undefined);
		});

		test("a rename onto a sibling label is a blocking problem; adds keep their upsert semantics", () => {
			const context = { takenLabels: ["Prod", "Staging"], originalLabel: "Prod" };
			assert.notStrictEqual(validateServerForm(draft({ label: "Staging" }), context).label, undefined);
			assert.strictEqual(
				validateServerForm(draft({ label: "Prod" }), context).label,
				undefined,
				"keeping the label is fine"
			);
			assert.strictEqual(validateServerForm(draft({ label: "Fresh" }), context).label, undefined);
			assert.strictEqual(
				validateServerForm(draft({ label: "Staging" }), { takenLabels: ["Staging"] }).label,
				undefined,
				"an add over an existing label replaces it; no originalLabel, no collision problem"
			);
		});

		test("OAuth fields are one unit: any of them present requires the token URL and client ID", () => {
			const clientOnly = validateServerForm(draft({ oauthClientId: "client" }));
			assert.notStrictEqual(clientOnly.oauthTokenUrl, undefined);

			const urlOnly = validateServerForm(draft({ oauthTokenUrl: "https://idp.test/token" }));
			assert.notStrictEqual(urlOnly.oauthClientId, undefined);

			const secretOnly = validateServerForm(draft({ oauthClientSecret: secret({ value: "s" }) }));
			assert.notStrictEqual(secretOnly.oauthTokenUrl, undefined);
			assert.notStrictEqual(secretOnly.oauthClientId, undefined);

			const complete = validateServerForm(draft({ oauthTokenUrl: "https://idp.test/token", oauthClientId: "client" }));
			assert.deepStrictEqual(complete, {});
		});

		test("a kept secure-side client secret also demands the OAuth pair", () => {
			const problems = validateServerForm(draft({ oauthClientSecret: secret({ existing: "secure" }) }));
			assert.notStrictEqual(problems.oauthTokenUrl, undefined);
		});

		test("the virtual key pair is both-or-neither and must be header-sendable", () => {
			assert.notStrictEqual(validateServerForm(draft({ virtualKeyHeader: "bad name" })).virtualKeyHeader, undefined);
			assert.notStrictEqual(validateServerForm(draft({ virtualKeyHeader: "x-key" })).virtualKeyValue, undefined);
			assert.notStrictEqual(
				validateServerForm(draft({ virtualKeyValue: secret({ value: "v" }) })).virtualKeyHeader,
				undefined
			);
			assert.notStrictEqual(
				validateServerForm(draft({ virtualKeyHeader: "x-key", virtualKeyValue: secret({ value: "a\nb" }) }))
					.virtualKeyValue,
				undefined
			);
			assert.deepStrictEqual(
				validateServerForm(draft({ virtualKeyHeader: "x-key", virtualKeyValue: secret({ value: "vk-1" }) })),
				{}
			);
		});

		test("a header whose value is kept in secure storage satisfies the pair", () => {
			const problems = validateServerForm(
				draft({ virtualKeyHeader: "x-key", virtualKeyValue: secret({ existing: "secure" }) })
			);
			assert.deepStrictEqual(problems, {});
		});

		test("clearing the kept value re-breaks the pair", () => {
			const problems = validateServerForm(
				draft({ virtualKeyHeader: "x-key", virtualKeyValue: secret({ existing: "secure", clear: true }) })
			);
			assert.notStrictEqual(problems.virtualKeyValue, undefined);
		});
	});

	suite("field catalog", () => {
		test("the field order covers every draft field exactly once, with a display label each", () => {
			const draftFields = Object.keys(EMPTY_SERVER_FORM).sort();
			assert.deepStrictEqual([...SERVER_FORM_FIELD_ORDER].sort(), draftFields);
			assert.deepStrictEqual(Object.keys(SERVER_FORM_FIELD_LABELS).sort(), draftFields);
		});

		test("OAuth-section fields are a subset of the order, so a summary can always point into the form", () => {
			for (const field of OAUTH_SECTION_FIELDS) {
				assert.ok(SERVER_FORM_FIELD_ORDER.includes(field), field);
			}
		});

		test("a partial-OAuth draft's problems all sit inside the collapsible section", () => {
			// The section must be forced open on save: with label and baseUrl
			// valid, every blocking problem here would otherwise be invisible.
			const problems = validateServerForm(draft({ oauthTokenUrl: "https://idp.test/token" }));
			const failing = SERVER_FORM_FIELD_ORDER.filter((field) => problems[field] !== undefined);
			assert.ok(failing.length > 0);
			for (const field of failing) {
				assert.ok(OAUTH_SECTION_FIELDS.includes(field), field);
			}
		});
	});

	suite("assembleServerForm", () => {
		test("trims fields and omits empty optionals entirely", () => {
			const intent = assembleServerForm(
				draft({ label: " Prod ", baseUrl: " http://localhost:4000 ", oauthScopes: "  " })
			);
			assert.deepStrictEqual(intent.server, { label: "Prod", baseUrl: "http://localhost:4000" });
			assert.strictEqual(intent.replaceLabel, undefined);
		});

		test("empty secret inputs become keep, typed values become set with their location, clear wins", () => {
			const intent = assembleServerForm(
				draft({
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
			const intent = assembleServerForm(draft({ label: "Renamed" }), "Prod");
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
			const intent = assembleServerForm(draft({ apiKey: prefilled }));
			assert.deepStrictEqual(intent.secrets.apiKey, { action: "keep" });
		});

		test("an edited prefill assembles as set with the new value; reverting to the prefill is keep again", () => {
			const prefilled = secret({ value: "sk-new", prefill: "sk-old", location: "settings", existing: "settings" });
			const intent = assembleServerForm(draft({ apiKey: prefilled }));
			assert.deepStrictEqual(intent.secrets.apiKey, { action: "set", location: "settings", value: "sk-new" });

			const reverted = assembleServerForm(draft({ apiKey: { ...prefilled, value: " sk-old " } }));
			assert.deepStrictEqual(reverted.secrets.apiKey, { action: "keep" }, "untouched means unchanged value, trimmed");
		});

		test("an emptied prefill assembles as keep; the remove checkbox is the explicit clear gesture", () => {
			const emptied = secret({ value: "", prefill: "sk-inline", location: "settings", existing: "settings" });
			assert.deepStrictEqual(assembleServerForm(draft({ apiKey: emptied })).secrets.apiKey, { action: "keep" });
			assert.deepStrictEqual(assembleServerForm(draft({ apiKey: { ...emptied, clear: true } })).secrets.apiKey, {
				action: "clear",
			});
		});

		test("a prefill with the storage choice moved to secure assembles as a set there: a real relocation", () => {
			const moved = secret({ value: "sk-inline", prefill: "sk-inline", location: "secure", existing: "settings" });
			const intent = assembleServerForm(draft({ apiKey: moved }));
			assert.deepStrictEqual(intent.secrets.apiKey, { action: "set", location: "secure", value: "sk-inline" });
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
			const problems = validateServerForm(prefilled);
			assert.strictEqual(problems.virtualKeyValue, "The value cannot be sent as an HTTP header");
			assert.strictEqual(problems.virtualKeyHeader, undefined, "the problem points at the value field only");
			assert.ok(hasServerFormProblems(problems), "the form is not savable until the value is edited or removed");

			const edited = { ...prefilled, virtualKeyValue: { ...prefilled.virtualKeyValue, value: "vk-fixed" } };
			assert.deepStrictEqual(validateServerForm(edited), {});
		});

		test("relocation race lifecycle: a location flip before the response arrives still relocates once it does", () => {
			// The hazard the form's Save gate exists for: the user opens Edit,
			// flips the inline key's radio to "secret storage", and hits Save
			// before the prefill response lands. Assembling at that moment would
			// read the empty field as "keep" and silently drop the relocation -
			// pinned here - so servers.tsx disables Save while the response is
			// pending; once it arrives, the flipped location survives the prefill
			// and the save assembles the relocation the user asked for.
			const flipped = draft({ apiKey: secret({ existing: "settings", location: "secure" }) });
			assert.deepStrictEqual(
				assembleServerForm(flipped).secrets.apiKey,
				{ action: "keep" },
				"saving before the response would no-op the relocation; Save must be gated until it arrives"
			);

			const arrived = applyInlinePrefill(flipped, { apiKey: "sk-inline" });
			assert.strictEqual(arrived.apiKey.location, "secure", "the user's storage choice survives the prefill");
			assert.deepStrictEqual(assembleServerForm(arrived).secrets.apiKey, {
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
	});
});
