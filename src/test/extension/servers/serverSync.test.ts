/**
 * The servers setting's parse and acceptance rules, secret blobs and ownership,
 * buildGroupArgs, per-entry records, and the secret palette and prefill parity.
 */
import * as assert from "node:assert";
import * as vscode from "vscode";
import { readInlineSecretValues } from "../../../extension/dashboard/intents";
import type { DeclaredServer, SecretStore, StoredServerSecrets } from "../../../extension/servers/serverSync";
import {
	acceptedEntry,
	buildGroupArgs,
	deleteServerSecrets,
	entryExpectedFailuresFor,
	entryModelCapabilitiesFor,
	entryModelParametersFor,
	inlineSecretValues,
	parseServersSetting,
	ServerSyncEngine,
	updateServerSecret,
} from "../../../extension/servers/serverSync";
import { SECRET_OWNERSHIP_MISMATCH_MESSAGE } from "../../../extension/servers/serverSync/engine";
import {
	readServerSecretsRecord,
	resolveOwnedSecrets,
	secretDestination,
	stampServerSecretOwner,
} from "../../../extension/servers/serverSync/secrets";
import { parseGroupConfiguration } from "../../../provider/catalog/groupModels";
import { CMD } from "../../../shared/config/commandIds";
import { serverSecretsKey } from "../../../shared/config/storageKeys";
import { normalizeBaseUrl } from "../../../shared/util/baseUrl";
import { fingerprint } from "../../../shared/util/fingerprint";
import { expectDefined } from "../../pureHelpers";
import { withConfig } from "../../testUtils";
import { inlineOnlyIdentity } from "../dashboard/recordedEnv";
import { makeSecretStore, makeSyncEnv } from "./serverSyncHelpers";

suite("extension/servers/serverSync", () => {
	suite("parseServersSetting", () => {
		test("keeps usable entries and reports the unusable ones", () => {
			const { entries, problems } = parseServersSetting([
				{ label: "Prod", baseUrl: "http://prod.test", auth: { apiKey: "sk-1" }, extra: "ignored" },
				{ label: "  ", baseUrl: "http://x" },
				{ baseUrl: "http://x" },
				"not an object",
				{ label: "__proto__", baseUrl: "http://x" },
				{ label: "Prod", baseUrl: "http://dupe.test" },
			]);

			assert.deepStrictEqual(entries, [{ label: "Prod", baseUrl: "http://prod.test", apiKey: "sk-1" }]);
			assert.strictEqual(problems.length, 5);
			assert.ok(
				problems.every((problem) => !problem.includes("Prod") && !problem.includes("proto")),
				"problems reference entry indexes only, never user text (they are logged)"
			);
		});

		test("an absent or non-array setting reads as empty", () => {
			assert.deepStrictEqual(parseServersSetting(undefined), { entries: [], problems: [] });
			assert.strictEqual(parseServersSetting("junk").entries.length, 0);
			assert.strictEqual(parseServersSetting("junk").problems.length, 1);
		});
	});

	suite("acceptedEntry", () => {
		test("returns exactly the entry parseServersSetting accepts for the label, with its raw index", () => {
			const raw = [
				"not an object",
				{ label: "Prod" }, // rejected: no baseUrl; must not shadow the accepted entry below
				{ label: "Prod", baseUrl: "http://real.test" },
				{ label: "Prod", baseUrl: "http://dupe.test" }, // rejected: duplicate of the accepted label
				{ label: " Staging ", baseUrl: "http://s.test" },
			];
			assert.deepStrictEqual(acceptedEntry(raw, "Prod"), {
				index: 2,
				entry: { label: "Prod", baseUrl: "http://real.test" },
			});
			assert.strictEqual(acceptedEntry(raw, "Staging")?.index, 4, "labels compare trimmed on both sides");
			assert.strictEqual(acceptedEntry(raw, "Staging")?.entry.label, "Staging", "the entry is the parsed view");
			assert.strictEqual(acceptedEntry(raw, " Prod ")?.index, 2);
		});

		test("labels the parser rejects resolve to nothing", () => {
			assert.strictEqual(acceptedEntry([{ label: "__proto__", baseUrl: "http://x" }], "__proto__"), undefined);
			assert.strictEqual(acceptedEntry([{ label: "NoUrl" }], "NoUrl"), undefined);
			assert.strictEqual(acceptedEntry([], "Prod"), undefined);
			assert.strictEqual(acceptedEntry("junk", "Prod"), undefined);
		});
	});

	suite("secret blobs", () => {
		test("read/update round-trip one field at a time; an emptied blob deletes the key", async () => {
			const store = makeSecretStore();
			await updateServerSecret(store, "Prod", "apiKey", "sk-1", undefined);
			await updateServerSecret(store, "Prod", "virtualKeyValue", "vk-1", undefined);
			assert.deepStrictEqual((await readServerSecretsRecord(store, "Prod")).values, {
				apiKey: "sk-1",
				virtualKeyValue: "vk-1",
			});

			await updateServerSecret(store, "Prod", "apiKey", undefined, undefined);
			assert.deepStrictEqual((await readServerSecretsRecord(store, "Prod")).values, { virtualKeyValue: "vk-1" });

			await updateServerSecret(store, "Prod", "virtualKeyValue", undefined, undefined);
			assert.strictEqual(store.values.has(serverSecretsKey("Prod")), false, "an empty blob leaves no key behind");
		});

		test("a corrupt blob reads as empty instead of failing the sync", async () => {
			const store = makeSecretStore({ [serverSecretsKey("Prod")]: "not json" });
			assert.deepStrictEqual((await readServerSecretsRecord(store, "Prod")).values, {});
		});

		test("deleteServerSecrets removes the label's whole blob", async () => {
			const store = makeSecretStore({ [serverSecretsKey("Old")]: JSON.stringify({ apiKey: "sk-1" }) });
			await deleteServerSecrets(store, "Old");
			assert.strictEqual(store.values.has(serverSecretsKey("Old")), false);
		});

		test("ownership stamps round-trip beside their values and die with them", async () => {
			const store = makeSecretStore();
			await updateServerSecret(store, "Prod", "apiKey", "sk-1", "http://prod.test");
			await updateServerSecret(store, "Prod", "virtualKeyValue", "vk-1", undefined);
			assert.deepStrictEqual(await readServerSecretsRecord(store, "Prod"), {
				values: { apiKey: "sk-1", virtualKeyValue: "vk-1" },
				owners: { apiKey: "http://prod.test" },
			});
			// The values half is unchanged: old readers ignore the stamp key.
			assert.deepStrictEqual((await readServerSecretsRecord(store, "Prod")).values, {
				apiKey: "sk-1",
				virtualKeyValue: "vk-1",
			});

			await updateServerSecret(store, "Prod", "apiKey", undefined, undefined);
			assert.deepStrictEqual(await readServerSecretsRecord(store, "Prod"), {
				values: { virtualKeyValue: "vk-1" },
				owners: {},
			});
		});

		test("a pre-stamping blob reads with empty owners; stampServerSecretOwner back-fills without overwriting", async () => {
			const store = makeSecretStore({
				[serverSecretsKey("Old")]: JSON.stringify({ apiKey: "sk-1", virtualKeyValue: "vk-1" }),
			});
			assert.deepStrictEqual((await readServerSecretsRecord(store, "Old")).owners, {});

			await stampServerSecretOwner(store, "Old", "apiKey", "http://a.test");
			// Never overwrites: a second stamp for another destination is a no-op.
			await stampServerSecretOwner(store, "Old", "apiKey", "http://b.test");
			// Never invents: stamping a field with no value writes nothing.
			await stampServerSecretOwner(store, "Old", "oauthClientSecret", "http://idp.test");
			assert.deepStrictEqual(await readServerSecretsRecord(store, "Old"), {
				values: { apiKey: "sk-1", virtualKeyValue: "vk-1" },
				owners: { apiKey: "http://a.test" },
			});
		});

		test("concurrent writes to one label serialize: a cleared field cannot resurrect", async () => {
			// A SecretStore whose reads yield, so unserialized read-modify-writes
			// would interleave: both writers read the same snapshot and the last
			// store wins, resurrecting the cleared apiKey (the pre-fix defect).
			const values = new Map<string, string>([[serverSecretsKey("Prod"), JSON.stringify({ apiKey: "sk-live" })]]);
			const store: SecretStore = {
				get: async (key) => {
					await new Promise((resolve) => setTimeout(resolve, 1));
					return values.get(key);
				},
				store: async (key, value) => {
					values.set(key, value);
				},
				delete: async (key) => {
					values.delete(key);
				},
			};
			await Promise.all([
				updateServerSecret(store, "Prod", "apiKey", undefined, undefined),
				updateServerSecret(store, "Prod", "virtualKeyValue", "vk-new", "http://prod.test"),
			]);
			assert.deepStrictEqual(await readServerSecretsRecord(store, "Prod"), {
				values: { virtualKeyValue: "vk-new" },
				owners: { virtualKeyValue: "http://prod.test" },
			});
		});

		test("resolveOwnedSecrets: matching or missing stamps resolve, mismatches refuse only where the entry sends", () => {
			const entry: DeclaredServer = {
				label: "A",
				baseUrl: "http://a.test/",
				oauthTokenUrl: "https://idp.test/token",
				oauthClientId: "client",
			};
			assert.strictEqual(secretDestination(entry, "apiKey"), "http://a.test");
			assert.strictEqual(secretDestination(entry, "oauthClientSecret"), "https://idp.test/token");
			// The token URL compares VERBATIM: the token exchange fetches it
			// exactly as configured, so /token/ is a different wire request and a
			// trailing-slash edit refuses (fail closed) rather than resolving.
			assert.strictEqual(
				secretDestination({ ...entry, oauthTokenUrl: "https://idp.test/token/" }, "oauthClientSecret"),
				"https://idp.test/token/"
			);

			const record = {
				values: { apiKey: "sk-1", oauthClientSecret: "cs-1", virtualKeyValue: "vk-1" },
				owners: { apiKey: "http://a.test", oauthClientSecret: "https://other-idp.test/token" },
			};
			assert.deepStrictEqual(resolveOwnedSecrets(entry, record), {
				values: { apiKey: "sk-1", virtualKeyValue: "vk-1" },
				refused: ["oauthClientSecret"],
				mismatched: ["oauthClientSecret"],
			});

			// The same mismatch behind an inline value is dormant: dropped from the
			// resolution but not a refusal (the inline value is what would be sent).
			const shadowed: DeclaredServer = { ...entry, oauthClientSecret: "cs-inline" };
			assert.deepStrictEqual(resolveOwnedSecrets(shadowed, record), {
				values: { apiKey: "sk-1", virtualKeyValue: "vk-1" },
				refused: [],
				mismatched: [],
			});

			// The same mismatch on a field the entry cannot send is inert, not a
			// refusal: refusal is scoped by the one wire rule (entryUsesSecretField),
			// so a stale-stamped headerless virtualKeyValue drops without blocking,
			// and an oauthClientSecret without an active OAuth unit likewise. Both
			// still list as mismatched, the export's accounting superset.
			const staleUnsent = {
				values: { virtualKeyValue: "vk-old", oauthClientSecret: "cs-old" },
				owners: { virtualKeyValue: "http://old.test", oauthClientSecret: "https://old-idp.test/token" },
			};
			assert.deepStrictEqual(resolveOwnedSecrets({ label: "B", baseUrl: "http://a.test/" }, staleUnsent), {
				values: {},
				refused: [],
				mismatched: ["oauthClientSecret", "virtualKeyValue"],
			});
			// Declaring the header makes the field used: the SAME stored value now
			// refuses (the field-becomes-used transition; consent fires then).
			assert.deepStrictEqual(
				resolveOwnedSecrets({ label: "B", baseUrl: "http://a.test/", virtualKeyHeader: "x-key" }, staleUnsent),
				{ values: {}, refused: ["virtualKeyValue"], mismatched: ["oauthClientSecret", "virtualKeyValue"] }
			);

			// A stamp recorded with no destination ("") refuses once the entry
			// gains one: re-pairing stays deliberate.
			const stampedEmpty = { values: { oauthClientSecret: "cs-1" }, owners: { oauthClientSecret: "" } };
			assert.deepStrictEqual(resolveOwnedSecrets(entry, stampedEmpty), {
				values: {},
				refused: ["oauthClientSecret"],
				mismatched: ["oauthClientSecret"],
			});
		});
	});

	suite("secret ownership refusal", () => {
		test("a stored secret stamped for another destination refuses the entry, forced passes included", async () => {
			// The delete-failure residual and the removal-keeps-blobs re-add alike:
			// the label's surviving blob belongs to http://retired.test, and the
			// entry now declares http://new.test. Pre-stamping, buildGroupArgs
			// resolved the blob by label alone and the activation force-sync sent
			// the retired credential to the new host permanently.
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://new.test" }], { A: { apiKey: "sk-retired" } });
			recorded.secretOwners = { A: { apiKey: "http://retired.test" } };
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow(true);

			assert.strictEqual(recorded.upserts.length, 0, "the refused pairing must never reach the host");
			const view = engine.getDeclared()[0];
			assert.strictEqual(view?.syncFailure?.message, SECRET_OWNERSHIP_MISMATCH_MESSAGE);
			assert.strictEqual(view?.syncFailure?.class, "secretsMismatched");
			assert.strictEqual(view?.secrets.apiKey, "none", "a refused field displays as no credential");
			const line = recorded.logged.find(([message]) => message.includes("stamped for a different destination"));
			assert.ok(line, "the skip logs a classification");
			assert.ok(!JSON.stringify(recorded.logged).includes("sk-retired"), "no log line carries the value");
		});

		test("the refusal precedes the add-only path: a re-pointed entry with a secret stamped for the old URL skips as secretsMismatched", async () => {
			// The composed case the monkey fuzzer found (FUZZ_SEED=285569): sync a
			// label, stamp its stored key for that URL, then change the URL. The
			// entry now BOTH diverges from its immutable group (the blocked path)
			// and fails the ownership check; the check runs at the read boundary,
			// before any host call, so the pass classifies secretsMismatched.
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://first.test" }], { A: { apiKey: "sk-first" } });
			recorded.secretOwners = { A: { apiKey: "http://first.test" } };
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();
			assert.strictEqual(engine.getDeclared()[0]?.syncFailure?.message, undefined, "the matching stamp syncs cleanly");
			assert.strictEqual(recorded.upserts.length, 1);

			recorded.setting = [{ label: "A", baseUrl: "http://first.test/changed" }];
			await engine.syncNow();
			assert.strictEqual(recorded.upserts.length, 1, "the refused pairing must never reach the host");
			const view = engine.getDeclared()[0];
			assert.strictEqual(view?.syncFailure?.message, SECRET_OWNERSHIP_MISMATCH_MESSAGE);
			assert.strictEqual(view?.syncFailure?.class, "secretsMismatched");
		});

		test("the save path's staging window is covered: a staged secret for a re-pointed host refuses until the settings write lands", async () => {
			// A dashboard save stages secure writes BEFORE the settings write. A
			// pass running inside that window reads the OLD entry with the NEW
			// blob - a consistent snapshot entryStillCurrent cannot catch. The
			// staged value carries the stamp of the entry being SAVED, so the
			// ownership check refuses the transient pairing; once the settings
			// write lands, the next pass syncs the true pairing.
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://old.test" }], { A: { apiKey: "sk-new" } });
			recorded.secretOwners = { A: { apiKey: "http://new.test" } };
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();
			assert.strictEqual(recorded.upserts.length, 0, "old.test must never receive the staged credential");

			recorded.setting = [{ label: "A", baseUrl: "http://new.test" }];
			await engine.syncNow();
			assert.deepStrictEqual(
				recorded.upserts.map((args) => [args.baseUrl, args.apiKey]),
				[["http://new.test", "sk-new"]]
			);
			assert.strictEqual(engine.getDeclared()[0]?.syncFailure?.message, undefined);
		});

		test("a matching stamp and a pre-stamping blob both sync; an inline value keeps a mismatch dormant", async () => {
			const recorded = makeSyncEnv(
				[
					{ label: "Stamped", baseUrl: "http://stamped.test" },
					{ label: "Legacy", baseUrl: "http://legacy.test" },
					{ label: "Inline", baseUrl: "http://inline.test", auth: { apiKey: "sk-inline" } },
				],
				{
					Stamped: { apiKey: "sk-stamped" },
					Legacy: { apiKey: "sk-legacy" },
					Inline: { apiKey: "sk-mismatched" },
				}
			);
			recorded.secretOwners = {
				Stamped: { apiKey: "http://stamped.test" },
				Inline: { apiKey: "http://elsewhere.test" },
			};
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();

			assert.deepStrictEqual(
				recorded.upserts.map((args) => [args.name, args.apiKey]),
				[
					["Stamped", "sk-stamped"],
					["Legacy", "sk-legacy"],
					["Inline", "sk-inline"],
				]
			);
			assert.ok(engine.getDeclared().every((view) => view.syncFailure?.message === undefined));
		});
		test("resolveGroupArgs never hands the internal test command a refused field", async () => {
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://new.test" }], {
				A: { apiKey: "sk-retired", virtualKeyValue: "vk-ok" },
			});
			recorded.secretOwners = { A: { apiKey: "http://retired.test", virtualKeyValue: "http://new.test" } };
			const engine = new ServerSyncEngine(recorded.env);

			const args = await engine.resolveGroupArgs("A");

			assert.strictEqual(args?.apiKey, undefined, "the refused field must not ride the group path");
			assert.strictEqual(args?.virtualKeyValue, "vk-ok");
		});

		test("a stale stamp on a field the entry cannot send is inert: the entry syncs, and refusal starts when the field becomes used", async () => {
			// The USER RULING: refusal is scoped by the one wire rule
			// (entryUsesSecretField). A headerless entry can never send a
			// virtualKeyValue, so a stale-stamped one blocks nothing - it drops
			// from the resolution (never rides the group args) and raises no
			// secretsMismatched skip.
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://a.test" }], { A: { virtualKeyValue: "vk-old" } });
			recorded.secretOwners = { A: { virtualKeyValue: "http://old.test" } };
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();

			assert.strictEqual(engine.getDeclared()[0]?.syncFailure, undefined, "an inert stale stamp is no mismatch");
			assert.strictEqual(recorded.upserts.length, 1, "the entry syncs");
			assert.strictEqual(recorded.upserts[0]?.virtualKeyValue, undefined, "the stale value still never rides");

			// The field-becomes-used transition: declaring the header makes the
			// entry's shape send the field, so the SAME stored value refuses now -
			// the consent moment is when the user is actually deciding to send it.
			recorded.setting = [{ label: "A", baseUrl: "http://a.test", auth: { virtualKey: { header: "x-key" } } }];
			await engine.syncNow();
			const view = engine.getDeclared()[0];
			assert.strictEqual(view?.syncFailure?.class, "secretsMismatched");
			assert.strictEqual(view?.syncFailure?.message, SECRET_OWNERSHIP_MISMATCH_MESSAGE);
			assert.strictEqual(recorded.upserts.length, 1, "the refused pairing must never reach the host");
		});
	});

	suite("buildGroupArgs", () => {
		test("inline secret values win over stored ones; absent fields stay omitted", () => {
			const args = buildGroupArgs(
				{ label: "Prod", baseUrl: "http://prod.test", apiKey: "sk-inline", oauthTokenUrl: "https://idp.test/token" },
				{ apiKey: "sk-stored", virtualKeyValue: "vk-stored" }
			);

			assert.deepStrictEqual(args, {
				name: "Prod",
				vendor: "litellm",
				baseUrl: "http://prod.test",
				label: "Prod",
				apiKey: "sk-inline",
				oauthTokenUrl: "https://idp.test/token",
				virtualKeyValue: "vk-stored",
			});
		});

		test("emits keys in the pinned order the persisted fingerprints hash", () => {
			// The fingerprint hashes JSON.stringify(args), so key insertion order is
			// durable state: reordering it invalidates every stored fingerprint.
			// The list is spelled out on purpose; do not derive it from the descriptor.
			const args = buildGroupArgs(
				{
					label: "Prod",
					baseUrl: "http://prod.test",
					apiKey: "sk-inline",
					oauthTokenUrl: "https://idp.test/token",
					oauthClientId: "client-1",
					oauthClientSecret: "shh",
					oauthScopes: "models.read",
					virtualKeyHeader: "x-litellm-key",
					virtualKeyValue: "vk-1",
				},
				{}
			);

			assert.deepStrictEqual(Object.keys(args), [
				"name",
				"vendor",
				"baseUrl",
				"label",
				"apiKey",
				"oauthTokenUrl",
				"oauthClientId",
				"oauthClientSecret",
				"oauthScopes",
				"virtualKeyHeader",
				"virtualKeyValue",
			]);
		});

		test("the mcp opt-in never reaches the group args, so editing it cannot change a fingerprint", () => {
			// The fingerprint hashes JSON.stringify(these args), so anything that
			// enters them churns the group. MCP is read extension-side only: turning
			// it on, pointing it at another URL, and turning it off must all render
			// byte-identically, or a user toggling tools would silently re-push the
			// provider group (and, since the host is add-only, could lose it).
			const base = { label: "Prod", baseUrl: "http://prod.test", apiKey: "sk-1" } as const;
			const rendered = [undefined, true as const, { url: "https://gateway.internal/tools/mcp" }, { url: "" }].map(
				(mcp) => JSON.stringify(buildGroupArgs({ ...base, ...(mcp !== undefined ? { mcp } : {}) }, {}))
			);

			assert.deepStrictEqual(new Set(rendered).size, 1, "every mcp shape renders the same group args");
			assert.ok(!expectDefined(rendered[0]).includes("mcp"), "the args carry no mcp key at all");
		});
	});

	suite("buildGroupArgs round trip through parseGroupConfiguration", () => {
		test("an entry populating every descriptor field survives the host-configuration parse intact", () => {
			// buildGroupArgs writes the provider-group configuration and
			// parseGroupConfiguration reads it; both iterate OPTIONAL_ENTRY_FIELDS, so a
			// descriptor field can only ship if it round-trips here.
			const entry: DeclaredServer = {
				label: "Everything",
				baseUrl: "http://round.test/",
				apiKey: "sk-inline",
				oauthTokenUrl: "https://idp.test/token",
				oauthClientId: "client-1",
				oauthClientSecret: "cs-1",
				oauthScopes: "models.read models.write",
				virtualKeyHeader: "x-litellm-key",
				virtualKeyValue: "vk-1",
			};
			const args = buildGroupArgs(entry, {});
			const server = parseGroupConfiguration(args);

			assert.deepStrictEqual(server, {
				baseUrl: normalizeBaseUrl("http://round.test"),
				apiKey: "sk-inline",
				label: "Everything",
				oauth: {
					tokenUrl: "https://idp.test/token",
					clientId: "client-1",
					clientSecret: "cs-1",
					scopes: "models.read models.write",
				},
				virtualKey: { header: "x-litellm-key", value: "vk-1" },
			});
		});
	});

	suite("per-entry modelParameters", () => {
		test("parseServersSetting keeps a usable record and drops malformed shapes silently", () => {
			const { entries, problems } = parseServersSetting([
				{
					label: "Prod",
					baseUrl: "http://prod.test",
					models: {
						// JSON.parse so __proto__ is an own key (an object literal would
						// set the prototype instead of a property).
						parameters: JSON.parse(
							'{"gpt-4": {"temperature": 0.2, "stop": ["END"]}, "claude": "not a record", "__proto__": {"polluted": true}}'
						) as unknown,
					},
				},
				{ label: "Junk", baseUrl: "http://junk.test", models: { parameters: "junk" } },
				{ label: "Empty", baseUrl: "http://empty.test", models: { parameters: {} } },
				{ label: "Bare", baseUrl: "http://bare.test" },
			]);

			assert.deepStrictEqual(problems, [], "a malformed modelParameters shape never rejects the entry");
			assert.deepStrictEqual(entries[0]?.modelParameters, { "gpt-4": { temperature: 0.2, stop: ["END"] } });
			for (const entry of entries.slice(1)) {
				assert.ok(!("modelParameters" in entry), `"${entry.label}" must read as carrying no entry parameters`);
			}
		});

		test("acceptedEntry resolves the entry with its modelParameters, for the request path's read", () => {
			const raw = [{ label: "Prod", baseUrl: "http://prod.test", models: { parameters: { "gpt-4": { top_p: 0.9 } } } }];
			assert.deepStrictEqual(acceptedEntry(raw, "Prod")?.entry.modelParameters, { "gpt-4": { top_p: 0.9 } });
		});

		test("entryModelParametersFor resolves only when the label and the normalized base URL agree", () => {
			const raw = [
				{ label: "Prod", baseUrl: "http://prod.test/", models: { parameters: { "gpt-4": { top_p: 0.9 } } } },
				{ label: "Stage", baseUrl: "http://stage.test", models: { parameters: { "gpt-4": { top_p: 0.2 } } } },
			];
			assert.deepStrictEqual(
				entryModelParametersFor(raw, "Prod", "http://prod.test"),
				{ "gpt-4": { top_p: 0.9 } },
				"trailing slashes are insignificant on both sides"
			);
			assert.strictEqual(
				entryModelParametersFor(raw, "Prod", "http://stage.test"),
				undefined,
				"a label match at another entry's URL resolves to nothing"
			);
			assert.strictEqual(
				entryModelParametersFor(raw, "Nope", "http://prod.test"),
				undefined,
				"a URL match under an undeclared label resolves to nothing"
			);
		});

		test("modelParameters never enter the group args or their fingerprint", () => {
			const bare: DeclaredServer = { label: "Prod", baseUrl: "http://prod.test", apiKey: "sk-1" };
			const withParams: DeclaredServer = { ...bare, modelParameters: { "gpt-4": { temperature: 0.2 } } };
			const stored: StoredServerSecrets = { virtualKeyValue: "vk-1" };

			assert.deepStrictEqual(buildGroupArgs(withParams, stored), buildGroupArgs(bare, stored));
			assert.strictEqual(
				fingerprint(JSON.stringify(buildGroupArgs(withParams, stored))),
				fingerprint(JSON.stringify(buildGroupArgs(bare, stored)))
			);
		});

		test("editing an entry's modelParameters neither re-pushes its group nor changes its fingerprint", async () => {
			const recorded = makeSyncEnv([
				{ label: "A", baseUrl: "http://a.test", models: { parameters: { "gpt-4": { temperature: 0.2 } } } },
			]);
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();
			assert.strictEqual(recorded.upserts.length, 1);
			assert.ok(!("modelParameters" in (recorded.upserts[0] ?? {})), "params stay out of the host configuration");
			const printed = recorded.fingerprints.A;
			assert.ok(printed !== undefined);
			assert.deepStrictEqual(engine.getDeclared()[0]?.modelParameters, { "gpt-4": { temperature: 0.2 } });

			recorded.setting = [
				{ label: "A", baseUrl: "http://a.test", models: { parameters: { "gpt-4": { temperature: 0.9 } } } },
			];
			await engine.syncNow();
			assert.strictEqual(recorded.upserts.length, 1, "an unforced pass reads the entry as unchanged");
			assert.strictEqual(recorded.fingerprints.A, printed);
			assert.deepStrictEqual(
				engine.getDeclared()[0]?.modelParameters,
				{ "gpt-4": { temperature: 0.9 } },
				"the dashboard view still tracks the live setting"
			);
			engine.dispose();
		});
	});

	suite("per-entry modelCapabilities and expectedFailures", () => {
		test("parseServersSetting keeps usable values and drops malformed shapes without rejecting the entry", () => {
			const { entries, problems } = parseServersSetting([
				{
					label: "Prod",
					baseUrl: "http://prod.test",
					models: {
						capabilities: JSON.parse(
							'{"gpt-4": {"context_length": 200000, "supports_vision": true}, "claude": "not a record", "__proto__": {"polluted": true}}'
						) as unknown,
					},
					discovery: { expectedFailures: ["modelInfo", "modelListing", "modelInfo", "not-a-category", 42] },
				},
				{
					label: "Junk",
					baseUrl: "http://junk.test",
					models: { capabilities: "junk" },
					discovery: { expectedFailures: "junk" },
				},
				{
					label: "Empty",
					baseUrl: "http://empty.test",
					models: { capabilities: {} },
					discovery: { expectedFailures: [] },
				},
				{ label: "Bare", baseUrl: "http://bare.test" },
			]);

			// Unknown expectedFailures values are counted, never echoed: the
			// problems are logged and the tokens are user text.
			assert.deepStrictEqual(problems, ["entry 1 lists 2 unknown discovery.expectedFailures value(s), ignored"]);
			assert.deepStrictEqual(entries[0]?.modelCapabilities, {
				"gpt-4": { context_length: 200000, supports_vision: true },
			});
			assert.deepStrictEqual(entries[0]?.expectedFailures, ["modelInfo", "modelListing"], "known tokens, deduplicated");
			for (const entry of entries.slice(1)) {
				assert.ok(!("modelCapabilities" in entry), `"${entry.label}" must read as carrying no entry capabilities`);
				assert.ok(!("expectedFailures" in entry), `"${entry.label}" must read as expecting no failures`);
			}
		});

		test("the accessors resolve only when the label and the normalized base URL agree", () => {
			const raw = [
				{
					label: "Prod",
					baseUrl: "http://prod.test/",
					models: { capabilities: { "gpt-4": { supports_reasoning: true } } },
					discovery: { expectedFailures: ["modelInfo"] },
				},
				{
					label: "Stage",
					baseUrl: "http://stage.test",
					models: { capabilities: { "gpt-4": { supports_vision: true } } },
				},
			];
			assert.deepStrictEqual(
				entryModelCapabilitiesFor(raw, "Prod", "http://prod.test"),
				{ "gpt-4": { supports_reasoning: true } },
				"trailing slashes are insignificant on both sides"
			);
			assert.deepStrictEqual(entryExpectedFailuresFor(raw, "Prod", "http://prod.test"), ["modelInfo"]);
			assert.strictEqual(
				entryModelCapabilitiesFor(raw, "Prod", "http://stage.test"),
				undefined,
				"a label match at another entry's URL resolves to nothing"
			);
			assert.strictEqual(
				entryExpectedFailuresFor(raw, "Prod", "http://stage.test"),
				undefined,
				"a label match at another entry's URL resolves to nothing"
			);
			assert.strictEqual(
				entryModelCapabilitiesFor(raw, "Nope", "http://prod.test"),
				undefined,
				"a URL match under an undeclared label resolves to nothing"
			);
			assert.strictEqual(
				entryExpectedFailuresFor(raw, "Stage", "http://stage.test"),
				undefined,
				"an entry without the field resolves to nothing"
			);
		});

		test("neither field enters the group args or their fingerprint", () => {
			const bare: DeclaredServer = { label: "Prod", baseUrl: "http://prod.test", apiKey: "sk-1" };
			const withFields: DeclaredServer = {
				...bare,
				modelCapabilities: { "gpt-4": { context_length: 200000 } },
				expectedFailures: ["modelListing", "modelInfo"],
			};
			const stored: StoredServerSecrets = { virtualKeyValue: "vk-1" };

			assert.deepStrictEqual(buildGroupArgs(withFields, stored), buildGroupArgs(bare, stored));
			assert.strictEqual(
				fingerprint(JSON.stringify(buildGroupArgs(withFields, stored))),
				fingerprint(JSON.stringify(buildGroupArgs(bare, stored)))
			);
		});

		test("editing an entry's capabilities or expectedFailures neither re-pushes its group nor changes its fingerprint", async () => {
			const recorded = makeSyncEnv([
				{
					label: "A",
					baseUrl: "http://a.test",
					models: { capabilities: { "gpt-4": { supports_vision: true } } },
					discovery: { expectedFailures: ["modelInfo"] },
				},
			]);
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();
			assert.strictEqual(recorded.upserts.length, 1);
			assert.ok(
				!("modelCapabilities" in (recorded.upserts[0] ?? {})),
				"capabilities stay out of the host configuration"
			);
			assert.ok(!("expectedFailures" in (recorded.upserts[0] ?? {})), "expectedFailures stay out too");
			const printed = recorded.fingerprints.A;
			assert.ok(printed !== undefined);
			assert.deepStrictEqual(engine.getDeclared()[0]?.modelCapabilities, { "gpt-4": { supports_vision: true } });
			assert.deepStrictEqual(engine.getDeclared()[0]?.expectedFailures, ["modelInfo"]);

			recorded.setting = [
				{
					label: "A",
					baseUrl: "http://a.test",
					models: { capabilities: { "gpt-4": { supports_vision: false, context_length: 1000000 } } },
					discovery: { expectedFailures: ["modelListing"] },
				},
			];
			await engine.syncNow();
			assert.strictEqual(recorded.upserts.length, 1, "an unforced pass reads the entry as unchanged");
			assert.strictEqual(recorded.fingerprints.A, printed);
			assert.deepStrictEqual(
				engine.getDeclared()[0]?.modelCapabilities,
				{ "gpt-4": { supports_vision: false, context_length: 1000000 } },
				"the dashboard view still tracks the live setting"
			);
			assert.deepStrictEqual(engine.getDeclared()[0]?.expectedFailures, ["modelListing"]);
			engine.dispose();
		});
	});

	suite("inlineSecretValues", () => {
		test("reports exactly the secret fields the entry carries inline", () => {
			const entry: DeclaredServer = {
				label: "Prod",
				baseUrl: "http://prod.test",
				apiKey: "sk-inline",
				oauthClientId: "client-1",
				virtualKeyValue: "vk-inline",
			};
			assert.deepStrictEqual(inlineSecretValues(entry), { apiKey: "sk-inline", virtualKeyValue: "vk-inline" });
			assert.deepStrictEqual(inlineSecretValues({ label: "Bare", baseUrl: "http://bare.test" }), {});
		});

		test("buildGroupArgs prefers the inline value exactly where inlineSecretValues reports one", () => {
			// The dormancy rule: for every secret field, the argument sent to the host is
			// the inline value when inlineSecretValues holds the field, the stored one
			// otherwise.
			const entry: DeclaredServer = {
				label: "Mixed",
				baseUrl: "http://mixed.test",
				apiKey: "sk-inline",
				virtualKeyHeader: "x-vk",
			};
			const stored: StoredServerSecrets = { apiKey: "sk-stored", oauthClientSecret: "cs-stored" };
			const args = buildGroupArgs(entry, stored);
			const inline = inlineSecretValues(entry);
			for (const field of ["apiKey", "oauthClientSecret", "virtualKeyValue"] as const) {
				assert.strictEqual(args[field], inline[field] ?? stored[field], field);
			}
		});
	});

	suite("secret-location parity with the dashboard prefill", () => {
		test("the edit form's prefill keys are exactly the fields whose pushed location is settings", async () => {
			// One fixture through both paths: the declared views carry the locations the
			// dashboard state pushes and readInlineSecretValues answers the edit form's
			// prefill, and both derive from inlineSecretValues.
			const setting = [
				{
					label: "Mixed",
					baseUrl: "http://mixed.test",
					auth: {
						oauth: {
							tokenUrl: "https://idp.test/token",
							clientId: "client-1",
							apiKey: "sk-inline",
							virtualKey: { header: "x-vk", value: "vk-inline" },
						},
					},
				},
				{ label: "Secure", baseUrl: "http://secure.test" },
			];
			const recorded = makeSyncEnv(setting, { Secure: { apiKey: "sk-stored" } });
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();

			for (const view of engine.getDeclared()) {
				const prefill = readInlineSecretValues(setting, inlineOnlyIdentity(setting, view.label));
				const settingsLocated = Object.entries(view.secrets)
					.filter(([, location]) => location === "settings")
					.map(([field]) => field)
					.sort();
				assert.deepStrictEqual(
					Object.keys(prefill).sort(),
					settingsLocated,
					`prefill keys for "${view.label}" must equal the fields pushed as "settings"`
				);
			}
			const secure = engine.getDeclared().find((view) => view.label === "Secure");
			assert.strictEqual(secure?.secrets.apiKey, "secure", "the stored-only field reads secure, never prefilled");
		});
	});

	suite("Set Server Secret palette", () => {
		test("warns that the stored secret stays dormant when the entry holds an inline value", async () => {
			const original = {
				showQuickPick: vscode.window.showQuickPick,
				showInputBox: vscode.window.showInputBox,
				showWarningMessage: vscode.window.showWarningMessage,
			};
			const warnings: string[] = [];
			let storedValue = "sk-freshly-stored";
			(vscode.window as Record<string, unknown>).showQuickPick = async (items: { label: string }[]) => items[0];
			(vscode.window as Record<string, unknown>).showInputBox = async () => storedValue;
			(vscode.window as Record<string, unknown>).showWarningMessage = async (message: string) => {
				warnings.push(message);
				return undefined;
			};
			try {
				// The registered command re-reads the setting through
				// getConfiguration, so withConfig serves it the fixture entry whose
				// apiKey (the first quick-pick field) sits inline.
				await withConfig(
					{ servers: [{ label: "Dormancy Probe", baseUrl: "http://dormant.test", auth: { apiKey: "sk-inline" } }] },
					async () => {
						await vscode.commands.executeCommand(CMD.setServerSecret);
						assert.strictEqual(warnings.length, 1, "storing behind an inline value must warn");
						const warning = warnings[0] ?? "";
						assert.ok(/inline values take precedence/.test(warning), warning);
						assert.ok(!warning.includes("sk-"), "the warning names the field, never a value");

						// Cleanup through the same command: an empty value removes the
						// stored secret, and removal must not warn about dormancy.
						storedValue = "";
						await vscode.commands.executeCommand(CMD.setServerSecret);
						assert.strictEqual(warnings.length, 1, "clearing the stored value fires no dormancy warning");
					}
				);
			} finally {
				(vscode.window as Record<string, unknown>).showQuickPick = original.showQuickPick;
				(vscode.window as Record<string, unknown>).showInputBox = original.showInputBox;
				(vscode.window as Record<string, unknown>).showWarningMessage = original.showWarningMessage;
			}
		});

		test("refuses to store when the entry changed while the prompts were open", async () => {
			const original = {
				showQuickPick: vscode.window.showQuickPick,
				showInputBox: vscode.window.showInputBox,
				showWarningMessage: vscode.window.showWarningMessage,
			};
			const warnings: string[] = [];
			// Mutated inside the input stub: the prompts stay open indefinitely,
			// and this models a hand edit of settings.json re-pointing the label at
			// another host while the user types the secret.
			const sectionValues: Record<string, unknown> = {
				servers: [{ label: "Drift Probe", baseUrl: "http://old.test" }],
			};
			(vscode.window as Record<string, unknown>).showQuickPick = async (items: { label: string }[]) => items[0];
			(vscode.window as Record<string, unknown>).showInputBox = async () => {
				sectionValues.servers = [{ label: "Drift Probe", baseUrl: "http://re-pointed.test" }];
				return "sk-typed-for-old";
			};
			(vscode.window as Record<string, unknown>).showWarningMessage = async (message: string) => {
				warnings.push(message);
				return undefined;
			};
			const linesBefore = (
				(await vscode.commands.executeCommand("litellm._test.getSessionLogs", 0)) as { lines: string[] }
			).lines.length;
			try {
				await withConfig(sectionValues, async () => {
					await vscode.commands.executeCommand(CMD.setServerSecret);
				});
			} finally {
				(vscode.window as Record<string, unknown>).showQuickPick = original.showQuickPick;
				(vscode.window as Record<string, unknown>).showInputBox = original.showInputBox;
				(vscode.window as Record<string, unknown>).showWarningMessage = original.showWarningMessage;
			}
			assert.strictEqual(warnings.length, 1, "the drift must warn exactly once");
			assert.ok(/changed while the prompts were open/.test(warnings[0] ?? ""), warnings[0] ?? "no warning shown");
			assert.ok(!(warnings[0] ?? "").includes("sk-"), "the warning never carries the entered value");
			// The lossless session tee proves the refusal: the classification line
			// landed and the store-success line never did, so updateServerSecret
			// was never reached.
			const batch = (await vscode.commands.executeCommand("litellm._test.getSessionLogs", 0)) as {
				lines: string[];
			};
			const delta = batch.lines.slice(linesBefore).join("\n");
			assert.ok(delta.includes("Set Server Secret refused"), delta);
			assert.ok(!delta.includes("Server secret updated from the palette"), "nothing may be stored on drift");
		});
	});
});
