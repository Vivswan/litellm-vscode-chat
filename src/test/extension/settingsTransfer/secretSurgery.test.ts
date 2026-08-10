import * as assert from "node:assert";
import type { StoredServerSecrets } from "../../../extension/servers/serverSync/secrets";
import type { MaterializedEntry, StrippedEntry } from "../../../extension/settingsTransfer/secretSurgery";
import { materializeEntrySecrets, stripEntrySecrets } from "../../../extension/settingsTransfer/secretSurgery";

function entryWith(auth: unknown): Record<string, unknown> {
	return { label: "A", baseUrl: "http://a.test", ...(auth === undefined ? {} : { auth }) };
}

suite("extension/settingsTransfer/secretSurgery", () => {
	test("the frozen signatures", () => {
		const strip: (rawEntry: Readonly<Record<string, unknown>>) => StrippedEntry = stripEntrySecrets;
		const materialize: (rawEntry: Readonly<Record<string, unknown>>, blob: StoredServerSecrets) => MaterializedEntry =
			materializeEntrySecrets;
		assert.strictEqual(typeof strip, "function");
		assert.strictEqual(typeof materialize, "function");
	});

	suite("stripEntrySecrets", () => {
		test("the string apiKey form strips to a formless auth, which is deleted", () => {
			const { entry, secrets } = stripEntrySecrets(entryWith({ apiKey: "sk-1" }));
			assert.deepStrictEqual(entry, { label: "A", baseUrl: "http://a.test" });
			assert.deepStrictEqual(secrets, { apiKey: "sk-1" });
		});

		test("an apiKey with a sibling virtualKey companion keeps the companion's header", () => {
			const { entry, secrets } = stripEntrySecrets(
				entryWith({ apiKey: "sk-1", virtualKey: { header: "x-litellm-key", value: "vk-1" } })
			);
			assert.deepStrictEqual(entry, entryWith({ virtualKey: { header: "x-litellm-key" } }));
			assert.deepStrictEqual(secrets, { apiKey: "sk-1", virtualKeyValue: "vk-1" });
		});

		test("the oauth form keeps tokenUrl, clientId, scopes, and the companion virtualKey header", () => {
			const { entry, secrets } = stripEntrySecrets(
				entryWith({
					oauth: {
						tokenUrl: "http://idp.test/token",
						clientId: "client-1",
						clientSecret: "cs-1",
						scopes: "a b",
						apiKey: "companion-key",
						virtualKey: { header: "x-key", value: "vk-2" },
					},
				})
			);
			assert.deepStrictEqual(
				entry,
				entryWith({
					oauth: {
						tokenUrl: "http://idp.test/token",
						clientId: "client-1",
						scopes: "a b",
						virtualKey: { header: "x-key" },
					},
				})
			);
			assert.deepStrictEqual(secrets, { apiKey: "companion-key", oauthClientSecret: "cs-1", virtualKeyValue: "vk-2" });
		});

		test("the virtualKey form alone keeps its header", () => {
			const { entry, secrets } = stripEntrySecrets(entryWith({ virtualKey: { header: "x-key", value: "vk-1" } }));
			assert.deepStrictEqual(entry, entryWith({ virtualKey: { header: "x-key" } }));
			assert.deepStrictEqual(secrets, { virtualKeyValue: "vk-1" });
		});

		test("values are trimmed into the blob, matching what the parser (and the wire) would use", () => {
			const { secrets } = stripEntrySecrets(entryWith({ apiKey: "  sk-padded \t" }));
			assert.deepStrictEqual(secrets, { apiKey: "sk-padded" });
		});

		test("non-usable strings and non-string junk stay put", () => {
			for (const junk of ["", "   ", 42, null, true, ["sk"], { nested: "sk" }]) {
				const raw = entryWith({ apiKey: junk });
				const { entry, secrets, unsanitizable } = stripEntrySecrets(raw);
				assert.deepStrictEqual(entry, raw, `apiKey=${JSON.stringify(junk)} is not a secret value`);
				assert.deepStrictEqual(secrets, {});
				// A container occupant could hold secret text the walk does not
				// reach; textless scalars cannot.
				const container = Array.isArray(junk) || (typeof junk === "object" && junk !== null);
				assert.strictEqual(unsanitizable, container, `apiKey=${JSON.stringify(junk)}`);
			}
		});

		test("the later (oauth-nested) position wins a blob-field collision in a misconfigured shape", () => {
			const { secrets } = stripEntrySecrets(
				entryWith({
					apiKey: "outer",
					oauth: { tokenUrl: "http://idp.test", clientId: "c", apiKey: "inner" },
					virtualKey: { header: "x-a", value: "outer-vk" },
				})
			);
			assert.strictEqual(secrets.apiKey, "inner");
			assert.strictEqual(secrets.virtualKeyValue, "outer-vk");
			const nested = stripEntrySecrets(
				entryWith({
					virtualKey: { header: "x-a", value: "outer-vk" },
					oauth: { tokenUrl: "http://idp.test", clientId: "c", virtualKey: { header: "x-b", value: "inner-vk" } },
				})
			);
			assert.strictEqual(nested.secrets.virtualKeyValue, "inner-vk");
		});

		test("only a fully emptied auth object is deleted; unknown keys keep it alive", () => {
			const { entry } = stripEntrySecrets(entryWith({ apiKey: "sk-1", bogus: 1 }));
			assert.deepStrictEqual(entry, entryWith({ bogus: 1 }));
		});

		test("stripping an ambiguous oauth-plus-sibling-apiKey shape heals it (the secret must not survive)", () => {
			const raw = entryWith({ apiKey: "sk-1", oauth: { tokenUrl: "http://idp.test", clientId: "c" } });
			const { entry, secrets } = stripEntrySecrets(raw);
			assert.deepStrictEqual(entry, entryWith({ oauth: { tokenUrl: "http://idp.test", clientId: "c" } }));
			assert.deepStrictEqual(secrets, { apiKey: "sk-1" });
		});

		test("entries without auth (or with non-object auth) pass through untouched", () => {
			for (const auth of [undefined, "auth-as-string", 42, null, ["x"]]) {
				const raw = entryWith(auth);
				const { entry, secrets } = stripEntrySecrets(raw);
				assert.deepStrictEqual(entry, raw);
				assert.deepStrictEqual(secrets, {});
			}
		});

		test("shapes that could hide secret text flag unsanitizable; textless ones do not", () => {
			// Text (or a text-capable container) anywhere but the grammar's known
			// non-secret positions: the malformed shape could BE (or contain) the
			// secret, so a no-secrets export must not trust it.
			for (const raw of [
				entryWith("sk-in-a-bare-auth-string"),
				entryWith([{ apiKey: "sk-in-an-array" }]),
				entryWith({ oauth: [{ clientSecret: "cs-in-an-array" }] }),
				entryWith({ oauth: "cs-as-string" }),
				entryWith({ virtualKey: ["vk-in-an-array"] }),
				entryWith({ oauth: { tokenUrl: "http://idp.test", virtualKey: ["vk"] } }),
				entryWith({ apiKey: ["sk"] }),
				entryWith({ apiKey: { nested: "sk" } }),
				// Text at unknown auth keys: the parser rejects these shapes, but
				// the text is presumed to be the credential the typo misplaced.
				entryWith({ token: "sk-at-an-unknown-key" }),
				entryWith({ oauth: { tokenUrl: "http://idp.test", clientId: "c", audience: "sk-ish" } }),
				entryWith({ virtualKey: { header: "x-key", name: "sk-ish" } }),
				// A container at a known text position could hold text too.
				entryWith({ oauth: { tokenUrl: ["sk"], clientId: "c" } }),
			]) {
				assert.strictEqual(stripEntrySecrets(raw).unsanitizable, true, JSON.stringify(raw.auth));
			}
			// Textless misconfiguration and well-formed shapes are sanitizable.
			for (const raw of [
				entryWith(undefined),
				entryWith(null),
				entryWith(42),
				entryWith(true),
				entryWith("   "),
				entryWith({ apiKey: "sk-1" }),
				entryWith({ oauth: { tokenUrl: "http://idp.test", clientId: "c", clientSecret: "cs" } }),
				entryWith({ virtualKey: { header: "x", value: "vk" } }),
				entryWith({ apiKey: null, oauth: null, virtualKey: 42 }),
				entryWith({ apiKey: "sk-1", bogus: 1 }),
			]) {
				assert.strictEqual(stripEntrySecrets(raw).unsanitizable, false, JSON.stringify(raw.auth));
			}
		});

		test("never mutates its input and returns an independent copy", () => {
			const raw = entryWith({ apiKey: "sk-1", virtualKey: { header: "x-key", value: "vk-1" } });
			const pristine = structuredClone(raw);
			const { entry } = stripEntrySecrets(raw);
			assert.deepStrictEqual(raw, pristine);
			(entry as Record<string, unknown>).label = "mutated";
			assert.strictEqual(raw.label, "A");
		});
	});

	suite("materializeEntrySecrets", () => {
		test("apiKey lands at auth.apiKey, creating auth when the strip deleted it", () => {
			const { entry, unmaterialized } = materializeEntrySecrets(entryWith(undefined), { apiKey: "sk-1" });
			assert.deepStrictEqual(entry, entryWith({ apiKey: "sk-1" }));
			assert.strictEqual(unmaterialized, 0);
		});

		test("apiKey joins an existing auth object beside a virtualKey companion", () => {
			const { entry } = materializeEntrySecrets(entryWith({ virtualKey: { header: "x-key" } }), { apiKey: "sk-1" });
			assert.deepStrictEqual(entry, entryWith({ virtualKey: { header: "x-key" }, apiKey: "sk-1" }));
		});

		test("apiKey lands inside auth.oauth when the oauth object exists", () => {
			const oauth = { tokenUrl: "http://idp.test", clientId: "c" };
			const { entry } = materializeEntrySecrets(entryWith({ oauth }), { apiKey: "sk-1" });
			assert.deepStrictEqual(entry, entryWith({ oauth: { ...oauth, apiKey: "sk-1" } }));
		});

		test("every blob field round-trips into a full oauth shape", () => {
			const raw = entryWith({
				oauth: { tokenUrl: "http://idp.test", clientId: "c", virtualKey: { header: "x-key" } },
			});
			const blob: StoredServerSecrets = { apiKey: "sk-1", oauthClientSecret: "cs-1", virtualKeyValue: "vk-1" };
			const { entry, unmaterialized } = materializeEntrySecrets(raw, blob);
			assert.strictEqual(unmaterialized, 0);
			assert.deepStrictEqual(
				entry,
				entryWith({
					oauth: {
						tokenUrl: "http://idp.test",
						clientId: "c",
						virtualKey: { header: "x-key", value: "vk-1" },
						apiKey: "sk-1",
						clientSecret: "cs-1",
					},
				})
			);
		});

		test("an existing usable inline value wins over the blob", () => {
			const raw = entryWith({ apiKey: "inline-key" });
			const { entry, unmaterialized } = materializeEntrySecrets(raw, { apiKey: "blob-key" });
			assert.deepStrictEqual(entry, raw);
			assert.strictEqual(unmaterialized, 0);
		});

		test("a non-usable inline string is replaced: the blob is the effective value at runtime", () => {
			const { entry } = materializeEntrySecrets(entryWith({ apiKey: "  " }), { apiKey: "blob-key" });
			assert.deepStrictEqual(entry, entryWith({ apiKey: "blob-key" }));
		});

		test("fields with no legal position count into unmaterialized, never guessed into the file", () => {
			// clientSecret needs an oauth object; virtualKeyValue needs a virtualKey object.
			const noHomes = materializeEntrySecrets(entryWith({ apiKey: "sk" }), {
				oauthClientSecret: "cs-1",
				virtualKeyValue: "vk-1",
			});
			assert.strictEqual(noHomes.unmaterialized, 2);
			assert.deepStrictEqual(noHomes.entry, entryWith({ apiKey: "sk" }));

			// A non-object auth gives apiKey no home either.
			const garbageAuth = materializeEntrySecrets(entryWith("auth-as-string"), { apiKey: "sk-1" });
			assert.strictEqual(garbageAuth.unmaterialized, 1);
			assert.deepStrictEqual(garbageAuth.entry, entryWith("auth-as-string"));

			// A non-string occupant is junk in a misconfigured shape: kept, counted.
			const occupied = materializeEntrySecrets(entryWith({ apiKey: 42 }), { apiKey: "sk-1" });
			assert.strictEqual(occupied.unmaterialized, 1);
			assert.deepStrictEqual(occupied.entry, entryWith({ apiKey: 42 }));
		});

		test("virtualKeyValue prefers the oauth-nested position, matching the strip walk's order", () => {
			const raw = entryWith({
				virtualKey: { header: "x-outer" },
				oauth: { tokenUrl: "http://idp.test", clientId: "c", virtualKey: { header: "x-inner" } },
			});
			const { entry } = materializeEntrySecrets(raw, { virtualKeyValue: "vk-1" });
			assert.deepStrictEqual(
				entry,
				entryWith({
					virtualKey: { header: "x-outer" },
					oauth: {
						tokenUrl: "http://idp.test",
						clientId: "c",
						virtualKey: { header: "x-inner", value: "vk-1" },
					},
				})
			);
		});

		test("blob values are placed verbatim: the runtime uses stored strings untransformed", () => {
			const padded = materializeEntrySecrets(entryWith(undefined), { apiKey: " sk-padded " });
			assert.deepStrictEqual(padded.entry, entryWith({ apiKey: " sk-padded " }));
			assert.strictEqual(padded.unmaterialized, 0);
			const whitespace = materializeEntrySecrets(entryWith(undefined), { apiKey: "   " });
			assert.deepStrictEqual(whitespace.entry, entryWith({ apiKey: "   " }));
		});

		test("an empty blob is a no-op and never mutates its input", () => {
			const raw = entryWith({ apiKey: "sk-1" });
			const pristine = structuredClone(raw);
			const { entry, unmaterialized } = materializeEntrySecrets(raw, {});
			assert.deepStrictEqual(entry, raw);
			assert.strictEqual(unmaterialized, 0);
			materializeEntrySecrets(raw, { apiKey: "other", virtualKeyValue: "vk" });
			assert.deepStrictEqual(raw, pristine);
		});
	});
});
