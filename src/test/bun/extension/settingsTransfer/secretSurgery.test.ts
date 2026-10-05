import { describe, test } from "bun:test";
import * as assert from "node:assert";
import type { StoredServerSecrets } from "../../../../extension/servers/serverSync/secrets";
import type { MaterializedEntry, StrippedEntry } from "../../../../extension/settingsTransfer/secretSurgery";
import {
	materializeEntrySecrets,
	stripCredentialHeaders,
	stripEntrySecrets,
	stripUrlUserinfo,
} from "../../../../extension/settingsTransfer/secretSurgery";

function entryWith(auth: unknown): Record<string, unknown> {
	return { label: "A", baseUrl: "http://a.test", ...(auth === undefined ? {} : { auth }) };
}

// The frozen signatures are pinned at compile time: a drift fails typecheck, so no runtime test restates what the
// types already prove.
void (stripEntrySecrets satisfies (rawEntry: Readonly<Record<string, unknown>>) => StrippedEntry);
void (materializeEntrySecrets satisfies (
	rawEntry: Readonly<Record<string, unknown>>,
	blob: StoredServerSecrets
) => MaterializedEntry);

describe("extension/settingsTransfer/secretSurgery", () => {
	describe("stripEntrySecrets", () => {
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
				// A container occupant could hold secret text the walk does not reach; textless scalars cannot.
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
			// Text (or a text-capable container) anywhere but the grammar's known non-secret positions: the malformed
			// shape could BE (or contain) the secret, so a no-secrets export must not trust it.
			for (const raw of [
				entryWith("sk-in-a-bare-auth-string"),
				entryWith([{ apiKey: "sk-in-an-array" }]),
				entryWith({ oauth: [{ clientSecret: "cs-in-an-array" }] }),
				entryWith({ oauth: "cs-as-string" }),
				entryWith({ virtualKey: ["vk-in-an-array"] }),
				entryWith({ oauth: { tokenUrl: "http://idp.test", virtualKey: ["vk"] } }),
				entryWith({ apiKey: ["sk"] }),
				entryWith({ apiKey: { nested: "sk" } }),
				// Text at unknown auth keys: the parser rejects these shapes, but the text is presumed to be the
				// credential the typo misplaced.
				entryWith({ token: "sk-at-an-unknown-key" }),
				entryWith({ oauth: { tokenUrl: "http://idp.test", clientId: "c", audience: "sk-ish" } }),
				entryWith({ virtualKey: { header: "x-key", name: "sk-ish" } }),
				// A container at a known text position could hold text too.
				entryWith({ oauth: { tokenUrl: ["sk"], clientId: "c" } }),
				// auth: { constructor: "sk" } certified clean through a raw-key index into the recursion table.
				entryWith({ toString: "sk-at-an-inherited-name" }),
				entryWith({ constructor: "sk-at-the-constructor-key" }),
				entryWith({ hasOwnProperty: "sk-at-a-method-name" }),
				entryWith(JSON.parse('{"__proto__": "sk-at-a-prototype-key"}')),
			]) {
				assert.strictEqual(stripEntrySecrets(raw).unsanitizable, true, JSON.stringify(raw.auth));
			}
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

		test("flat top-level secret fields (the pre-redesign shape) move into the blob 1:1", () => {
			const raw = {
				label: "A",
				baseUrl: "http://a.test",
				apiKey: "sk-test-flat",
				oauthClientSecret: " sk-test-flat-cs ",
				virtualKeyValue: "sk-test-flat-vk",
				oauthTokenUrl: "http://idp.test/token",
			};
			const stripped = stripEntrySecrets(raw);
			assert.strictEqual(stripped.unsanitizable, false, "the flat shape is fully sanitizable");
			assert.deepStrictEqual(stripped.secrets, {
				apiKey: "sk-test-flat",
				oauthClientSecret: "sk-test-flat-cs",
				virtualKeyValue: "sk-test-flat-vk",
			});
			// Non-secret flat fields ride through as inert junk for the activation-time restructure; the secret
			// positions are emptied.
			assert.deepStrictEqual(stripped.entry, {
				label: "A",
				baseUrl: "http://a.test",
				oauthTokenUrl: "http://idp.test/token",
			});
		});

		test("a nested auth position outranks its flat twin on a blob-slot collision", () => {
			const raw = { label: "A", baseUrl: "http://a.test", apiKey: "sk-flat-old", auth: { apiKey: "sk-nested-new" } };
			const stripped = stripEntrySecrets(raw);
			assert.deepStrictEqual(stripped.secrets, { apiKey: "sk-nested-new" });
			assert.deepStrictEqual(stripped.entry, { label: "A", baseUrl: "http://a.test" });
			assert.strictEqual(stripped.unsanitizable, false);
		});

		test("a record auth wins WHOLESALE: a flat secret beside it is discarded, never moved into the blob", () => {
			// The settings-redesign migration drops every flat auth field once a nested auth object exists, so the
			// transfer must too - taking the flat virtualKeyValue into the blob would make an export+import round trip
			// send a credential the migrated live entry never sends.
			const raw = {
				label: "A",
				baseUrl: "http://a.test",
				virtualKeyValue: "vk-flat-forgotten",
				auth: { apiKey: "sk-nested" },
			};
			const stripped = stripEntrySecrets(raw);
			assert.deepStrictEqual(stripped.secrets, { apiKey: "sk-nested" });
			assert.deepStrictEqual(stripped.entry, { label: "A", baseUrl: "http://a.test" });
			assert.strictEqual(stripped.unsanitizable, false);
			assert.ok(!JSON.stringify(stripped).includes("vk-flat-forgotten"));
		});

		test("a container left at a flat secret key flags unsanitizable; textless occupants do not", () => {
			for (const flat of [{ apiKey: ["sk-test-hidden"] }, { virtualKeyValue: { nested: "sk-test-hidden" } }]) {
				const raw = { label: "A", baseUrl: "http://a.test", ...flat };
				assert.strictEqual(stripEntrySecrets(raw).unsanitizable, true, JSON.stringify(flat));
			}
			for (const flat of [{ apiKey: "   " }, { apiKey: 42 }, { oauthClientSecret: null }]) {
				const raw = { label: "A", baseUrl: "http://a.test", ...flat };
				assert.strictEqual(stripEntrySecrets(raw).unsanitizable, false, JSON.stringify(flat));
			}
		});
	});

	describe("stripCredentialHeaders", () => {
		// Drifts silently: the header names come from the shared predicate, so a no-secrets export that kept an
		// Authorization value would fail only in a file the user hands to someone else. Names are matched as the
		// settings parser accepts them (trimmed, any case), and a headers shape the strip cannot walk is presumed to
		// hide a credential, like an uncertifiable auth shape.
		test.each<[string, Record<string, unknown>, Record<string, unknown> | undefined, string[], boolean]>([
			[
				"the fixed auth names go, in any case and padding; other headers stay",
				{
					headers: {
						" Authorization ": "Bearer sk",
						"proxy-authorization": "Basic x",
						"X-API-KEY": "k",
						"X-Team": "t",
					},
				},
				{ headers: { "X-Team": "t" } },
				[" Authorization ", "proxy-authorization", "X-API-KEY"],
				false,
			],
			[
				"the entry's virtualKey header names a credential header at each raw position",
				{
					auth: {
						oauth: { tokenUrl: "http://idp.test", virtualKey: { header: " x-inner " } },
						virtualKey: { header: "x-outer" },
					},
					virtualKeyHeader: "x-flat",
					headers: { "X-Inner": "1", "X-Outer": "2", "X-Flat": "3", "X-Team": "t" },
				},
				{
					auth: {
						oauth: { tokenUrl: "http://idp.test", virtualKey: { header: " x-inner " } },
						virtualKey: { header: "x-outer" },
					},
					virtualKeyHeader: "x-flat",
					headers: { "X-Team": "t" },
				},
				["X-Inner", "X-Outer", "X-Flat"],
				false,
			],
			[
				"a textless headers field is misconfiguration, not a credential",
				{ headers: null },
				{ headers: null },
				[],
				false,
			],
			[
				"headers as text is unwalkable, so the entry is unsanitizable",
				{ headers: "Authorization: sk" },
				undefined,
				[],
				true,
			],
			[
				"headers as an array is unwalkable, so the entry is unsanitizable",
				{ headers: [{ Authorization: "sk" }] },
				undefined,
				[],
				true,
			],
			[
				"a container at a header value could hide text, so the entry is unsanitizable",
				{ headers: { Authorization: "sk", "X-Team": { nested: "sk" } } },
				undefined,
				["Authorization"],
				true,
			],
		])("%s", (_name, fields, stripped, removed, unsanitizable) => {
			const raw = { label: "A", baseUrl: "http://a.test", ...fields };
			const result = stripCredentialHeaders(raw);
			assert.strictEqual(result.unsanitizable, unsanitizable);
			assert.deepStrictEqual(result.removed, removed);
			if (!result.unsanitizable) {
				assert.deepStrictEqual(result.entry, { label: "A", baseUrl: "http://a.test", ...stripped });
			}
		});
	});

	describe("stripUrlUserinfo", () => {
		// Drifts silently: the URL positions come from the shared field table and the credential verdict mirrors
		// displayUrl, so a position the walk missed would leave `user:pw@` in a no-secrets file, a form only displayUrl
		// hides (a credentialed URL inside a query parameter, the fail-closed tail of a refused value) would ride out
		// uncounted, and a URL rewritten for a reason other than a credential (a tab the parser drops) would count as a
		// secret in the export summary.
		test.each<[string, Record<string, unknown>, Record<string, unknown> | undefined, number]>([
			[
				"every URL position (baseUrl, flat oauthTokenUrl, auth.oauth.tokenUrl, mcp.url) is rebuilt and counted",
				{
					baseUrl: "http://u:base-pw@a.test",
					oauthTokenUrl: "http://u:flat-pw@idp.test",
					auth: { oauth: { tokenUrl: "http://u:nested-pw@idp.test", clientId: "c" } },
					mcp: { url: "http://u:mcp-pw@a.test/mcp" },
				},
				{
					baseUrl: "http://a.test",
					oauthTokenUrl: "http://idp.test",
					auth: { oauth: { tokenUrl: "http://idp.test", clientId: "c" } },
					mcp: { url: "http://a.test/mcp" },
				},
				4,
			],
			[
				"a credentialed URL inside a query parameter is a cut the display form makes, so it counts",
				{ baseUrl: "https://a.test/?next=https://u:query-pw@b.test" },
				{ baseUrl: "https://a.test/?next=https://b.test" },
				1,
			],
			[
				'a refused value with an "@" fails closed to its tail, as displayUrl shows it, and counts',
				{ baseUrl: "sk-credential-Q7@a.test:443" },
				{ baseUrl: "a.test:443" },
				1,
			],
			[
				"a URL without a credential rides as written: a tab the parser drops is not one",
				{ baseUrl: "http://a.test\t/v1", mcp: { url: "http://a.test/mcp" } },
				{ baseUrl: "http://a.test\t/v1", mcp: { url: "http://a.test/mcp" } },
				0,
			],
			[
				"a URL-named key inside a models record is request text the user wrote, not an entry URL position",
				{ models: { parameters: { "gpt-*": { url: "http://u:record-pw@hook.test" } } } },
				{ models: { parameters: { "gpt-*": { url: "http://u:record-pw@hook.test" } } } },
				0,
			],
			[
				"a URL spelling at a key the grammar does not read (mcp.tokenUrl) is not a URL position",
				{ mcp: { url: "http://a.test/mcp", tokenUrl: [] } },
				{ mcp: { url: "http://a.test/mcp", tokenUrl: [] } },
				0,
			],
			["the boolean mcp opt-in is textless and rides", { mcp: true }, { mcp: true }, 0],
			[
				"an mcp slot the walk cannot enter could hold a credentialed URL, so the entry is unsanitizable",
				{ mcp: ["http://u:array-pw@a.test/mcp"] },
				undefined,
				0,
			],
		])("%s", (_name, fields, stripped, removed) => {
			const raw = { label: "A", ...fields };
			const result = stripUrlUserinfo(raw);
			assert.strictEqual(result.unsanitizable, stripped === undefined);
			assert.strictEqual(result.removed, removed);
			if (!result.unsanitizable) {
				assert.deepStrictEqual(result.entry, { label: "A", ...stripped });
			}
		});
	});

	describe("materializeEntrySecrets", () => {
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
