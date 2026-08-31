import * as assert from "node:assert";
import * as vscode from "vscode";
import { readInlineSecretValues } from "../../../extension/dashboard/intents";
import { GroupRemovalStore } from "../../../extension/servers/groupRemovals";
import type {
	DeclaredEntryIdentity,
	DeclaredServer,
	RemovedEntryEvent,
	SecretStore,
	ServerSyncEnv,
	StoredServerSecrets,
} from "../../../extension/servers/serverSync";
import {
	acceptedEntry,
	buildGroupArgs,
	createServerSyncEnv,
	deleteServerSecrets,
	entryExpectedFailuresFor,
	entryModelCapabilitiesFor,
	entryModelParametersFor,
	GROUP_UPDATE_UNAVAILABLE_MESSAGE,
	GROUP_UPSERT_FAILED_MESSAGE,
	inlineSecretValues,
	parseServersSetting,
	SALT_UNAVAILABLE_MESSAGE,
	SECRETS_READ_FAILED_MESSAGE,
	ServerSyncEngine,
	updateServerSecret,
} from "../../../extension/servers/serverSync";
import { groupArgsFingerprint, SECRET_OWNERSHIP_MISMATCH_MESSAGE } from "../../../extension/servers/serverSync/engine";
import {
	readServerSecretsRecord,
	resolveOwnedSecrets,
	secretDestination,
	stampServerSecretOwner,
} from "../../../extension/servers/serverSync/secrets";
import {
	declaredEntryLabel,
	entryApiVersionFor,
	entryDeclaredModelsFor,
	entryHeadersFor,
	rawDeclaredLabels,
	stillDeclaredIn,
} from "../../../extension/servers/serverSync/setting";
import { groupClientId, parseGroupConfiguration } from "../../../provider/catalog/groupModels";
import { CMD } from "../../../shared/config/commandIds";
import {
	SERVER_SYNC_FINGERPRINTS_KEY,
	SYNCED_ENTRY_BASE_URLS_KEY,
	serverSecretsKey,
} from "../../../shared/config/storageKeys";
import { Logger } from "../../../shared/logger";
import { normalizeBaseUrl } from "../../../shared/util/baseUrl";
import { fingerprint } from "../../../shared/util/fingerprint";
import { expectDefined } from "../../pureHelpers";
import { fakeFingerprintSaltSession, makeExtensionStorage, withConfig } from "../../testUtils";
import { inlineOnlyIdentity } from "../dashboard/recordedEnv";

function makeSecretStore(initial: Record<string, string> = {}): SecretStore & { values: Map<string, string> } {
	const values = new Map(Object.entries(initial));
	return {
		values,
		get: async (key) => values.get(key),
		store: async (key, value) => {
			values.set(key, value);
		},
		delete: async (key) => {
			values.delete(key);
		},
	};
}

interface Recorded {
	upserts: Record<string, string>[];
	fingerprints: Record<string, string>;
	/** The persisted identity ledger (label -> normalized base URL). */
	entryBaseUrls: Record<string, string>;
	/** Every reconcileEntryIdentities call: the declared identities and the removal events. */
	reconciles: { declared: DeclaredEntryIdentity[]; events: RemovedEntryEvent[] }[];
	logged: [string, unknown][];
	loggedErrors: [string, unknown][];
	env: ServerSyncEnv;
	setting: unknown;
	secrets: Record<string, StoredServerSecrets>;
	/** Ownership stamps the fake blob read reports beside the values, by label. */
	secretOwners: Record<string, Partial<Record<"apiKey" | "oauthClientSecret" | "virtualKeyValue", string>>>;
	/** When set, addProviderGroup rejects for these labels. */
	failLabels: Set<string>;
	/** When set, addProviderGroup rejects these labels the way an add-only host refuses an existing name. */
	duplicateLabels: Set<string>;
	/** When set, the pass-end setFingerprints write rejects with this error. */
	failFingerprintWrites?: Error;
	/** What confirmFingerprintsDurable reports; false models a session-only salt. */
	saltDurable: boolean;
}

function makeSyncEnv(setting: unknown = [], secrets: Record<string, StoredServerSecrets> = {}): Recorded {
	const recorded: Recorded = {
		upserts: [],
		fingerprints: {},
		entryBaseUrls: {},
		reconciles: [],
		logged: [],
		loggedErrors: [],
		setting,
		secrets,
		secretOwners: {},
		failLabels: new Set(),
		duplicateLabels: new Set(),
		saltDurable: true,
		env: {
			readServersSetting: () => recorded.setting,
			readSecrets: async (label) => ({
				values: recorded.secrets[label] ?? {},
				owners: recorded.secretOwners[label] ?? {},
			}),
			confirmFingerprintsDurable: async () => recorded.saltDurable,
			addProviderGroup: async (args) => {
				if (recorded.failLabels.has(args.name ?? "")) {
					throw new Error("host refused the group");
				}
				if (recorded.duplicateLabels.has(args.name ?? "")) {
					throw new Error(`Language model group with name ${args.name} already exists for vendor litellm`);
				}
				recorded.upserts.push({ ...args });
			},
			getFingerprints: () => recorded.fingerprints,
			setFingerprints: async (map) => {
				if (recorded.failFingerprintWrites !== undefined) {
					throw recorded.failFingerprintWrites;
				}
				recorded.fingerprints = { ...map };
			},
			getEntryBaseUrls: () => recorded.entryBaseUrls,
			setEntryBaseUrls: async (map) => {
				recorded.entryBaseUrls = { ...map };
			},
			reconcileEntryIdentities: async (declared, events) => {
				recorded.reconciles.push({ declared: [...declared], events: [...events] });
			},
			log: (message, data) => {
				recorded.logged.push([message, data]);
			},
			logError: (message, error) => {
				recorded.loggedErrors.push([message, error]);
			},
		},
	};
	return recorded;
}

/** The removal/rename events the recorded env saw, flattened across passes (most passes record none). */
function recordedEvents(recorded: Recorded): RemovedEntryEvent[] {
	return recorded.reconciles.flatMap((reconcile) => reconcile.events);
}

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

	suite("ServerSyncEngine", () => {
		test("a first pass upserts every entry with resolved secrets and records fingerprints", async () => {
			const recorded = makeSyncEnv(
				[
					{ label: "A", baseUrl: "http://a.test", auth: { apiKey: "sk-a" } },
					{ label: "B", baseUrl: "http://b.test" },
				],
				{ B: { apiKey: "sk-b-stored" } }
			);
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();

			assert.deepStrictEqual(
				recorded.upserts.map((args) => [args.name, args.apiKey]),
				[
					["A", "sk-a"],
					["B", "sk-b-stored"],
				]
			);
			assert.deepStrictEqual(Object.keys(recorded.fingerprints).sort(), ["A", "B"]);
		});

		test("a mid-pass settings edit skips the add: a stale entry never pairs with fresh secrets", async () => {
			// The pass reads the setting once and each entry's secrets later; this
			// edit lands inside that window (the readSecrets await). Without the
			// pre-add re-read the add goes out pairing the OLD host with the NEW
			// secret - permanent, because the host is add-only. The skip is
			// silent, and the next pass syncs the true pairing.
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://old.test" }], { A: { apiKey: "sk-new" } });
			const originalRead = recorded.env.readSecrets.bind(recorded.env);
			recorded.env.readSecrets = async (label) => {
				recorded.setting = [{ label: "A", baseUrl: "http://new.test" }];
				return originalRead(label);
			};
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();

			assert.strictEqual(recorded.upserts.length, 0, "no group may pair old.test with the rotated secret");
			assert.ok(
				recorded.logged.some(([message]) => message.includes("changed mid-pass")),
				"the skip logs a classification"
			);
			assert.strictEqual(engine.getDeclared()[0]?.syncFailure?.message, undefined, "a silent skip, not an error state");

			await engine.syncNow();
			assert.deepStrictEqual(
				recorded.upserts.map((args) => [args.baseUrl, args.apiKey]),
				[["http://new.test", "sk-new"]],
				"the follow-up pass adds the true pairing"
			);
		});

		test("a secret rotated mid-pass no longer blocks the add: identity is what the pre-add re-read guards", async () => {
			// The identity fingerprint does not cover credentials, so the pass-start
			// pairing may reach the host even when the secret rotates between the
			// loop's read and the add. Harmless where it was once permanent: the
			// baked credentials are a serve-time-overridden fallback, and the
			// rotation's own follow-up pass reads as in-sync without another add.
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://a.test" }], { A: { apiKey: "sk-1" } });
			const originalRead = recorded.env.readSecrets.bind(recorded.env);
			let rotated = false;
			recorded.env.readSecrets = async (label) => {
				const value = await originalRead(label);
				if (!rotated) {
					// The rotation lands after the loop's read and before the add.
					rotated = true;
					recorded.secrets = { A: { apiKey: "sk-2" } };
				}
				return value;
			};
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();
			assert.deepStrictEqual(
				recorded.upserts.map((args) => args.apiKey),
				["sk-1"],
				"the add lands with the pass-start pairing"
			);
			assert.strictEqual(engine.getDeclared()[0]?.syncFailure?.message, undefined);

			await engine.syncNow();
			assert.strictEqual(recorded.upserts.length, 1, "the rotation's follow-up pass is in-sync, no re-add");
		});

		test("dispose settles a queued syncNow, and no pass may start after disposal", async () => {
			// A queued follow-up will never run once the engine is disposed, so
			// its waiters must settle instead of hanging - and neither the queued
			// follow-up nor a later syncNow may reach the host (a disposed
			// engine's window is going away; its adds would be unobservable).
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://a.test" }]);
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const originalAdd = recorded.env.addProviderGroup.bind(recorded.env);
			recorded.env.addProviderGroup = async (args) => {
				await gate;
				return originalAdd(args);
			};
			const engine = new ServerSyncEngine(recorded.env, 0);
			const first = engine.syncNow();
			const queued = engine.syncNow(true);
			engine.dispose();
			release();
			await first;
			await queued;

			assert.strictEqual(recorded.upserts.length, 1, "only the in-flight pass's add lands; the queued one is gone");
			await engine.syncNow(true);
			assert.strictEqual(recorded.upserts.length, 1, "post-dispose syncNow is a no-op");
			engine.requestSync();
			await new Promise((resolve) => setTimeout(resolve, 5));
			assert.strictEqual(recorded.upserts.length, 1, "post-dispose requestSync schedules nothing");
		});

		test("an unchanged entry skips the upsert; a rotated secret is in-sync; a baseUrl edit re-upserts", async () => {
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://a.test" }], { A: { apiKey: "sk-1" } });
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();
			await engine.syncNow();
			assert.strictEqual(recorded.upserts.length, 1, "the second identical pass upserts nothing");

			// A credential rotation is a sync no-op BY DESIGN: the identity print
			// does not cover secrets, the host could not update the group anyway,
			// and the serve-time overlay delivers the new value.
			recorded.secrets = { A: { apiKey: "sk-2" } };
			await engine.syncNow();
			assert.strictEqual(recorded.upserts.length, 1, "a secret change owes the host nothing");
			assert.strictEqual(engine.getDeclared()[0]?.syncFailure?.message, undefined, "and raises no failure");

			recorded.setting = [{ label: "A", baseUrl: "http://b.test" }];
			await engine.syncNow();
			assert.strictEqual(recorded.upserts.length, 2, "an identity change re-upserts");
		});

		test("entries removed from the setting are reported once and dropped from the fingerprint map", async () => {
			const recorded = makeSyncEnv([
				{ label: "A", baseUrl: "http://a.test" },
				{ label: "B", baseUrl: "http://b.test" },
			]);
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();
			assert.deepStrictEqual(recordedEvents(recorded), [], "nothing removed yet");
			assert.deepStrictEqual(
				recorded.entryBaseUrls,
				{ A: "http://a.test", B: "http://b.test" },
				"the identity ledger records every declared entry"
			);

			recorded.setting = [{ label: "A", baseUrl: "http://a.test" }];
			await engine.syncNow();

			assert.deepStrictEqual(recordedEvents(recorded), [{ kind: "removed", label: "B", baseUrl: "http://b.test" }]);
			assert.deepStrictEqual(Object.keys(recorded.fingerprints), ["A"]);
			assert.deepStrictEqual(Object.keys(recorded.entryBaseUrls), ["A"], "the ledger prunes with the entry");
			assert.deepStrictEqual(
				recorded.reconciles.at(-1)?.declared,
				[{ label: "A", baseUrl: "http://a.test" }],
				"every pass reports the declared identities (the tombstone auto-clear input)"
			);

			await engine.syncNow();
			assert.deepStrictEqual(recordedEvents(recorded), [{ kind: "removed", label: "B", baseUrl: "http://b.test" }]);
			assert.ok(
				recorded.reconciles.every((reconcile, index) => index === 1 || reconcile.events.length === 0),
				"no repeat removal event"
			);
		});

		test("declared views publish only after removal reconciliation completes", async () => {
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://a.test" }]);
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();
			assert.deepStrictEqual(
				engine.getDeclared().map((view) => view.label),
				["A"]
			);

			// A caller that sees the view disappear may rely on the removal's tombstone
			// already being installed, so the view must still show the previous pass's
			// truth while reconciliation runs.
			let releaseReconcile!: () => void;
			const gate = new Promise<void>((resolve) => {
				releaseReconcile = resolve;
			});
			let enterReconcile!: () => void;
			const entered = new Promise<void>((resolve) => {
				enterReconcile = resolve;
			});
			const reconcile = recorded.env.reconcileEntryIdentities;
			recorded.env.reconcileEntryIdentities = async (declared, events) => {
				enterReconcile();
				await gate;
				return reconcile(declared, events);
			};
			recorded.setting = [];
			const pass = engine.syncNow();
			await entered;
			assert.deepStrictEqual(
				engine.getDeclared().map((view) => view.label),
				["A"],
				"the removed entry's view must hold until its reconciliation resolves"
			);
			releaseReconcile();
			await pass;
			assert.deepStrictEqual(engine.getDeclared(), []);
			assert.deepStrictEqual(recordedEvents(recorded), [{ kind: "removed", label: "A", baseUrl: "http://a.test" }]);
		});

		test("resolveGroupArgs renders exactly the entry's group configuration, secrets read included", async () => {
			const recorded = makeSyncEnv(
				[
					{ label: "A", baseUrl: "http://a.test" },
					{ label: "Broken", baseUrl: "http://broken.test", auth: { oauth: {} } },
				],
				{ A: { apiKey: "sk-stored" } }
			);
			const engine = new ServerSyncEngine(recorded.env);

			assert.deepStrictEqual(await engine.resolveGroupArgs("A"), {
				name: "A",
				vendor: "litellm",
				baseUrl: "http://a.test",
				label: "A",
				apiKey: "sk-stored",
			});
			assert.strictEqual(await engine.resolveGroupArgs("Nope"), undefined, "an undeclared label resolves to nothing");
			assert.strictEqual(
				await engine.resolveGroupArgs("Broken"),
				undefined,
				"a misconfigured entry resolves to nothing, exactly as the sync pass would skip it"
			);
		});

		test("a removed label whose base URL a brand-new label now declares reads as a rename", async () => {
			const recorded = makeSyncEnv([{ label: "Old", baseUrl: "http://host.test/" }]);
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();

			recorded.setting = [{ label: "New", baseUrl: "http://host.test" }];
			await engine.syncNow();

			assert.deepStrictEqual(recordedEvents(recorded), [
				{ kind: "renamed", oldLabel: "Old", newLabel: "New", baseUrl: "http://host.test" },
			]);
		});

		test("a removal whose base URL another EXISTING entry declares stays a removal, not a rename", async () => {
			const recorded = makeSyncEnv([
				{ label: "Old", baseUrl: "http://host.test" },
				{ label: "Twin", baseUrl: "http://host.test" },
			]);
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();

			recorded.setting = [{ label: "Twin", baseUrl: "http://host.test" }];
			await engine.syncNow();

			assert.deepStrictEqual(recordedEvents(recorded), [
				{ kind: "removed", label: "Old", baseUrl: "http://host.test" },
			]);
		});

		test("a stale ledger re-read cannot degrade a removal to the untracked notice (#220)", async () => {
			// The session ledger is the truth for a removed label's base URL; the store
			// read only fills gaps. A stale read leaves the event without a URL, so the
			// env writes no tombstone and the removed group's models never leave.
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://a.test" }]);
			recorded.env.getEntryBaseUrls = () => ({}); // every read is the stale pre-declare snapshot
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();

			recorded.setting = [];
			await engine.syncNow();
			assert.deepStrictEqual(recordedEvents(recorded), [{ kind: "removed", label: "A", baseUrl: "http://a.test" }]);
		});

		test("a removal the identity ledger predates carries no base URL (the env must not tombstone a guess)", async () => {
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://a.test" }]);
			// A fingerprint record from an older version, with no ledger entry to resolve its host.
			recorded.fingerprints = { Ghost: "stale-record" };
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();

			assert.deepStrictEqual(recordedEvents(recorded), [{ kind: "removed", label: "Ghost", baseUrl: undefined }]);
		});

		test("a present-but-malformed entry is not a removal: records carry and no event fires", async () => {
			const recorded = makeSyncEnv([{ label: "Prod", baseUrl: "http://prod.test" }]);
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();
			assert.strictEqual(recorded.upserts.length, 1);

			// A mid-edit settings.json: the entry is present, just unusable. Tombstoning
			// it would suppress a group the user did not remove, and shedding its records
			// would wedge the repaired entry on an unrecognizable duplicate.
			recorded.setting = [{ label: "Prod" }];
			await engine.syncNow();
			assert.deepStrictEqual(recordedEvents(recorded), [], "a carried label is present, not removed");
			assert.deepStrictEqual(Object.keys(recorded.fingerprints), ["Prod"], "the fingerprint record carries");
			assert.deepStrictEqual(recorded.entryBaseUrls, { Prod: "http://prod.test" }, "the ledger record carries");

			// The edit completes: the unchanged entry reads as in-sync again (no
			// host call, no spurious name-conflict error) and still no event.
			recorded.setting = [{ label: "Prod", baseUrl: "http://prod.test" }];
			await engine.syncNow();
			assert.deepStrictEqual(recordedEvents(recorded), []);
			assert.strictEqual(recorded.upserts.length, 1, "the repaired entry matches its carried fingerprint");
			assert.strictEqual(engine.getDeclared()[0]?.syncFailure?.message, undefined);
		});

		test("a failing pass-end fingerprint write cannot swallow a removal's reconciliation", async () => {
			const recorded = makeSyncEnv([{ label: "Prod", baseUrl: "http://prod.test" }]);
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();

			// The session map drops the removed label before the persist, so an
			// aborting persist would lose the removal's only evidence: the event
			// (and its tombstone) must still go out.
			recorded.setting = [];
			recorded.failFingerprintWrites = new Error("memento write failed");
			await engine.syncNow();

			assert.deepStrictEqual(recordedEvents(recorded), [
				{ kind: "removed", label: "Prod", baseUrl: "http://prod.test" },
			]);
			assert.ok(
				recorded.loggedErrors.some(([message]) => message.includes("fingerprint map")),
				"the failed persist is logged"
			);
		});

		test("a malformed setting CONTAINER proves nothing: no removals, all records carried", async () => {
			const recorded = makeSyncEnv([{ label: "Prod", baseUrl: "http://prod.test" }]);
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();

			// A mid-edit settings.json where the array itself is broken: presence
			// is unknowable, so nothing may read as removed and nothing may shed
			// its records.
			recorded.setting = "not an array";
			await engine.syncNow();
			assert.deepStrictEqual(recordedEvents(recorded), []);
			assert.deepStrictEqual(Object.keys(recorded.fingerprints), ["Prod"]);
			assert.deepStrictEqual(recorded.entryBaseUrls, { Prod: "http://prod.test" });

			// undefined and null prove nothing either: the setting declares an array
			// schema with a [] default, so a non-array is a malformed or partial state,
			// never how a real "remove everything" arrives.
			recorded.setting = undefined;
			await engine.syncNow();
			recorded.setting = null;
			await engine.syncNow();
			assert.deepStrictEqual(recordedEvents(recorded), []);
			assert.deepStrictEqual(Object.keys(recorded.fingerprints), ["Prod"]);

			// Clearing the setting for real IS explicit removal of every entry,
			// and it arrives as the schema's empty array.
			recorded.setting = [];
			await engine.syncNow();
			assert.deepStrictEqual(recordedEvents(recorded), [
				{ kind: "removed", label: "Prod", baseUrl: "http://prod.test" },
			]);
		});

		test("a malformed-container pass cannot erase a pending upsert retry", async () => {
			const recorded = makeSyncEnv([{ label: "Prod", baseUrl: "http://prod.test" }]);
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();
			assert.strictEqual(recorded.upserts.length, 1);

			// The next forced add fails outright (the live group may have been
			// removed natively), leaving the upsertFailed marker that must send
			// this exact configuration back to the host.
			recorded.failLabels.add("Prod");
			await engine.syncNow(true);
			assert.strictEqual(engine.getDeclared()[0]?.syncFailure?.class, "upsertFailed");

			// A mid-edit container proves nothing: the entry is present, not removed, so
			// the pending retry must survive like the fingerprint and ledger records -
			// erasing it would read the carried fingerprint as in-sync and skip the retry.
			recorded.setting = null;
			await engine.syncNow();

			recorded.setting = [{ label: "Prod", baseUrl: "http://prod.test" }];
			recorded.failLabels.delete("Prod");
			await engine.syncNow();
			assert.strictEqual(recorded.upserts.length, 2, "the restored entry retries the failed add");
			assert.strictEqual(engine.getDeclared()[0]?.syncFailure?.message, undefined, "the retry heals the entry");
		});

		test("a rejected label's carry also accepts another window's store record, presence-only", async () => {
			const recorded = makeSyncEnv([{ label: "Prod", baseUrl: "http://prod.test" }]);
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();

			// Another window persisted "Other" after this engine seeded its session map,
			// and the entry then goes malformed here. The carry must take the store's
			// proof (carryLastGood's asymmetry), or this pass-end write erases the copy.
			recorded.fingerprints = { ...recorded.fingerprints, Other: "other-window-record" };
			recorded.entryBaseUrls = { ...recorded.entryBaseUrls, Other: "http://other.test" };
			recorded.setting = [{ label: "Prod", baseUrl: "http://prod.test" }, { label: "Other" }];
			await engine.syncNow();

			assert.strictEqual(recorded.fingerprints.Other, "other-window-record", "the other window's proof survives");
			assert.strictEqual(recorded.entryBaseUrls.Other, "http://other.test");
			assert.deepStrictEqual(recordedEvents(recorded), []);
		});

		test("a blocked URL change with no prior ledger record yields an untracked removal, never a guessed tombstone", async () => {
			// The URL changed before the first pass and the add was refused, so the
			// declared URL was never proven and must not enter the ledger: a later
			// removal degrades to the untracked notice instead of guessing a tombstone.
			const recorded = makeSyncEnv([{ label: "Prod", baseUrl: "http://new.test" }]);
			recorded.fingerprints = { Prod: "pre-ledger-record" };
			recorded.duplicateLabels.add("Prod");
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();
			assert.deepStrictEqual(recorded.entryBaseUrls, {}, "no unproven URL is recorded");

			recorded.setting = [];
			await engine.syncNow();
			assert.deepStrictEqual(recordedEvents(recorded), [{ kind: "removed", label: "Prod", baseUrl: undefined }]);
		});

		test("a blocked entry keeps its previous ledger URL, so a later removal tombstones the group that exists", async () => {
			const recorded = makeSyncEnv([{ label: "Prod", baseUrl: "http://old.test" }]);
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();
			assert.deepStrictEqual(recorded.entryBaseUrls, { Prod: "http://old.test" });

			// The URL changes but the add-only host refuses the update: the live
			// group keeps the OLD connection, so the ledger must not move.
			recorded.setting = [{ label: "Prod", baseUrl: "http://new.test" }];
			recorded.duplicateLabels.add("Prod");
			await engine.syncNow();
			assert.strictEqual(engine.getDeclared()[0]?.syncFailure?.class, "blocked");
			assert.deepStrictEqual(
				recorded.entryBaseUrls,
				{ Prod: "http://old.test" },
				"the ledger records the group that exists, not the configuration that never landed"
			);

			// Removing the entry now names the live group's identity.
			recorded.setting = [];
			await engine.syncNow();
			assert.deepStrictEqual(recordedEvents(recorded), [
				{ kind: "removed", label: "Prod", baseUrl: "http://old.test" },
			]);
		});

		test("a failed upsert is classified, keeps no fingerprint, surfaces on the view, and retries next pass", async () => {
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://a.test" }]);
			recorded.failLabels.add("A");
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();

			assert.deepStrictEqual(recorded.loggedErrors, [], "upsert failures are classified, not raw-logged");
			const failureLog = recorded.logged.find(([message]) => message === "Provider group upsert failed");
			assert.ok(failureLog, "the failure is logged with a classification");
			assert.ok(!JSON.stringify(recorded.logged).includes("host refused"), "the raw host text stays out of the log");
			assert.deepStrictEqual(recorded.fingerprints, {});
			assert.strictEqual(engine.getDeclared()[0]?.syncFailure?.message, GROUP_UPSERT_FAILED_MESSAGE);
			assert.strictEqual(engine.getDeclared()[0]?.syncFailure?.class, "upsertFailed");

			recorded.failLabels.clear();
			await engine.syncNow();
			assert.strictEqual(recorded.upserts.length, 1, "the retry lands");
			assert.strictEqual(engine.getDeclared()[0]?.syncFailure?.message, undefined, "the error clears on success");
			assert.strictEqual(engine.getDeclared()[0]?.syncFailure?.class, undefined, "the class clears with it");
		});

		test("a forced pass re-upserts unchanged entries and rewrites the fingerprints", async () => {
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://a.test" }]);
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();
			await engine.syncNow(true);

			assert.strictEqual(recorded.upserts.length, 2, "force ignores the matching fingerprint");
			assert.deepStrictEqual(Object.keys(recorded.fingerprints), ["A"]);
		});

		test("a duplicate rejection for an unchanged entry counts as in-sync (the add-only host's steady state)", async () => {
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://a.test" }]);
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();

			// The group now exists host-side, so the forced activation re-add is
			// refused as a duplicate; that must not surface as an error.
			recorded.duplicateLabels.add("A");
			await engine.syncNow(true);

			assert.strictEqual(
				engine.getDeclared()[0]?.syncFailure?.message,
				undefined,
				"an existing unchanged group is in sync"
			);
			assert.deepStrictEqual(Object.keys(recorded.fingerprints), ["A"], "the fingerprint survives the forced pass");
			assert.ok(
				!JSON.stringify(recorded.logged).includes("already exists"),
				"the steady-state duplicate is not logged"
			);
		});

		test("a duplicate rejection for a changed entry surfaces the actionable error and does not hammer", async () => {
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://a.test" }], { A: { apiKey: "sk-1" } });
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();
			assert.strictEqual(recorded.upserts.length, 1);

			// The entry's identity changes, but the host cannot update the existing group.
			recorded.setting = [{ label: "A", baseUrl: "http://changed.test" }];
			recorded.duplicateLabels.add("A");
			await engine.syncNow();
			assert.strictEqual(engine.getDeclared()[0]?.syncFailure?.message, GROUP_UPDATE_UNAVAILABLE_MESSAGE);
			assert.strictEqual(engine.getDeclared()[0]?.syncFailure?.class, "blocked");
			assert.ok(
				!JSON.stringify(recorded.logged).includes("sk-1"),
				"the classification log never carries secret material"
			);

			await engine.syncNow();
			await engine.syncNow();
			assert.strictEqual(recorded.upserts.length, 1, "no add attempts while blocked");
			assert.strictEqual(engine.getDeclared()[0]?.syncFailure?.message, GROUP_UPDATE_UNAVAILABLE_MESSAGE);

			// After the user removes the stale group natively, a forced pass recreates it.
			recorded.duplicateLabels.clear();
			await engine.syncNow(true);
			assert.strictEqual(recorded.upserts.length, 2, "the forced retry lands");
			assert.strictEqual(engine.getDeclared()[0]?.syncFailure?.message, undefined);
			assert.deepStrictEqual(Object.keys(recorded.fingerprints), ["A"]);
		});

		test("reverting a refused change lands back in sync silently instead of wedging", async () => {
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://a.test" }], { A: { apiKey: "sk-1" } });
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();
			assert.strictEqual(recorded.upserts.length, 1);

			// The identity change is refused: the host cannot update the existing group.
			recorded.setting = [{ label: "A", baseUrl: "http://b.test" }];
			recorded.duplicateLabels.add("A");
			await engine.syncNow();
			assert.strictEqual(engine.getDeclared()[0]?.syncFailure?.message, GROUP_UPDATE_UNAVAILABLE_MESSAGE);
			assert.deepStrictEqual(
				Object.keys(recorded.fingerprints),
				["A"],
				"the last-known-good fingerprint is carried, not dropped"
			);

			// The user reverts the entry instead of removing the group natively:
			// the live group already holds this content, so the error clears
			// without a host call.
			recorded.setting = [{ label: "A", baseUrl: "http://a.test" }];
			await engine.syncNow();
			assert.strictEqual(engine.getDeclared()[0]?.syncFailure?.message, undefined, "the revert unwedges the entry");
			assert.strictEqual(recorded.upserts.length, 1, "the revert is a silent no-op, not a retry");
			assert.deepStrictEqual(Object.keys(recorded.fingerprints), ["A"]);

			// A genuine change afterwards still surfaces the error.
			recorded.setting = [{ label: "A", baseUrl: "http://c.test" }];
			await engine.syncNow();
			assert.strictEqual(engine.getDeclared()[0]?.syncFailure?.message, GROUP_UPDATE_UNAVAILABLE_MESSAGE);
		});

		test("a transient failure on a synced entry keeps last-known-good, so the retry's duplicate reads as in-sync", async () => {
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://a.test" }]);
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();
			assert.deepStrictEqual(Object.keys(recorded.fingerprints), ["A"]);

			// A forced pass (activation) re-adds the healthy entry and the host
			// fails transiently. The fingerprint record must survive: it is the
			// only thing that lets the next duplicate response read as in-sync.
			recorded.failLabels.add("A");
			await engine.syncNow(true);
			assert.strictEqual(engine.getDeclared()[0]?.syncFailure?.message, GROUP_UPSERT_FAILED_MESSAGE);
			assert.deepStrictEqual(Object.keys(recorded.fingerprints), ["A"], "last-known-good survives the failure");

			// The next unforced pass retries and gets the healthy group's normal
			// duplicate rejection; misreading it as changed/name-taken would
			// block the entry forever.
			recorded.failLabels.delete("A");
			recorded.duplicateLabels.add("A");
			await engine.syncNow();
			assert.strictEqual(
				engine.getDeclared()[0]?.syncFailure?.message,
				undefined,
				"the duplicate is the synced steady state"
			);
			assert.deepStrictEqual(Object.keys(recorded.fingerprints), ["A"]);
		});

		test("a transient failure on a changed entry does not wedge the later revert", async () => {
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://a.test" }], { A: { apiKey: "sk-1" } });
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();
			assert.strictEqual(recorded.upserts.length, 1);

			// The entry's identity changes and the add for the NEW configuration
			// fails transiently (not as a duplicate).
			recorded.setting = [{ label: "A", baseUrl: "http://b.test" }];
			recorded.failLabels.add("A");
			await engine.syncNow();
			assert.strictEqual(engine.getDeclared()[0]?.syncFailure?.message, GROUP_UPSERT_FAILED_MESSAGE);
			assert.deepStrictEqual(Object.keys(recorded.fingerprints), ["A"], "last-known-good survives the failure");

			// The user reverts instead: the entry matches the live group again,
			// and the pending retry concerned a configuration that no longer
			// exists, so this is in sync without a host call.
			recorded.failLabels.delete("A");
			recorded.setting = [{ label: "A", baseUrl: "http://a.test" }];
			await engine.syncNow();
			assert.strictEqual(engine.getDeclared()[0]?.syncFailure?.message, undefined, "the revert lands in sync");
			assert.strictEqual(recorded.upserts.length, 1, "no host call for the revert");
		});

		test("a generic failure clears stale duplicate knowledge, so the retry is not suppressed", async () => {
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://a.test" }], { A: { apiKey: "sk-1" } });
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();
			assert.strictEqual(recorded.upserts.length, 1);

			// The entry's identity changes and the host refuses the duplicate: blocked.
			recorded.setting = [{ label: "A", baseUrl: "http://b.test" }];
			recorded.duplicateLabels.add("A");
			await engine.syncNow();
			assert.strictEqual(engine.getDeclared()[0]?.syncFailure?.message, GROUP_UPDATE_UNAVAILABLE_MESSAGE);

			// The user removes the group natively and forces a sync, but the
			// re-add fails transiently. The stale duplicate knowledge must clear
			// with it, or the blocked shortcut would suppress every retry below.
			recorded.duplicateLabels.delete("A");
			recorded.failLabels.add("A");
			await engine.syncNow(true);
			assert.strictEqual(
				engine.getDeclared()[0]?.syncFailure?.message,
				GROUP_UPSERT_FAILED_MESSAGE,
				"the classification follows the latest outcome"
			);

			// The next UNFORCED pass reaches the host and lands.
			recorded.failLabels.delete("A");
			await engine.syncNow();
			assert.strictEqual(recorded.upserts.length, 2, "the unforced retry reaches the host");
			assert.strictEqual(engine.getDeclared()[0]?.syncFailure?.message, undefined);
		});

		test("one entry's secret-read failure neither aborts the pass nor loses another entry's fresh fingerprint", async () => {
			const recorded = makeSyncEnv([
				{ label: "A", baseUrl: "http://a.test" },
				{ label: "B", baseUrl: "http://b.test" },
			]);
			const readSecrets = recorded.env.readSecrets;
			recorded.env.readSecrets = async (label) => {
				if (label === "B") {
					throw new Error("keychain locked");
				}
				return readSecrets(label);
			};
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();

			// A landed and is recorded; B is skipped with the classified error.
			assert.deepStrictEqual(
				recorded.upserts.map((upsert) => upsert.name),
				["A"]
			);
			assert.deepStrictEqual(Object.keys(recorded.fingerprints), ["A"], "A's add survives B's failure");
			const byLabel = new Map(engine.getDeclared().map((view) => [view.label, view]));
			assert.strictEqual(byLabel.get("A")?.syncFailure?.message, undefined);
			assert.strictEqual(byLabel.get("B")?.syncFailure?.message, SECRETS_READ_FAILED_MESSAGE);
			// The read-failure class stands alone: consumers key on it to mark the
			// view's secret locations unproven, which the other skip classes
			// (saltUnavailable, secretsMismatched) must never imply.
			assert.strictEqual(byLabel.get("B")?.syncFailure?.class, "secretsUnreadable");

			// The store recovers and a forced pass re-adds both: A's duplicate response
			// reads as the steady state - only possible because its fingerprint survived
			// B's failure - and B's first add lands.
			recorded.env.readSecrets = readSecrets;
			recorded.duplicateLabels.add("A");
			await engine.syncNow(true);
			const after = new Map(engine.getDeclared().map((view) => [view.label, view]));
			assert.strictEqual(after.get("A")?.syncFailure?.message, undefined);
			assert.strictEqual(after.get("B")?.syncFailure?.message, undefined);
			assert.deepStrictEqual(Object.keys(recorded.fingerprints).sort(), ["A", "B"]);
		});

		test("a completed add survives a failing end-of-pass fingerprint write (write-through)", async () => {
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://a.test" }]);
			const setFingerprints = recorded.env.setFingerprints;
			let calls = 0;
			recorded.env.setFingerprints = async (map) => {
				calls += 1;
				// Call 1 is the write-through after A's add; call 2 is the
				// end-of-pass wholesale write.
				if (calls === 2) {
					throw new Error("memento write failed");
				}
				await setFingerprints(map);
			};
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();
			assert.deepStrictEqual(Object.keys(recorded.fingerprints), ["A"], "the write-through record survives");

			// A forced pass re-adds the group and gets the duplicate response;
			// only the write-through record makes it read as the steady state
			// instead of a name conflict.
			recorded.env.setFingerprints = setFingerprints;
			recorded.duplicateLabels.add("A");
			await engine.syncNow(true);
			assert.strictEqual(
				engine.getDeclared()[0]?.syncFailure?.message,
				undefined,
				"the group's duplicate response reads as in-sync, not a name conflict"
			);
		});

		test("the blocked shortcut re-asserts its classification after an unrelated failure pass", async () => {
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://a.test" }], { A: { apiKey: "sk-1" } });
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();

			// The identity change is refused as a duplicate: blocked, actionable text.
			recorded.setting = [{ label: "A", baseUrl: "http://b.test" }];
			recorded.duplicateLabels.add("A");
			await engine.syncNow();
			assert.strictEqual(engine.getDeclared()[0]?.syncFailure?.message, GROUP_UPDATE_UNAVAILABLE_MESSAGE);

			// One pass cannot read the stored secrets; its classification takes
			// over for that pass.
			const readSecrets = recorded.env.readSecrets;
			recorded.env.readSecrets = async () => {
				throw new Error("keychain locked");
			};
			await engine.syncNow();
			assert.strictEqual(engine.getDeclared()[0]?.syncFailure?.message, SECRETS_READ_FAILED_MESSAGE);

			// The store recovers and the entry still holds the refused
			// configuration: the shortcut must show the name-conflict text
			// again, not the stale secrets text.
			recorded.env.readSecrets = readSecrets;
			await engine.syncNow();
			assert.strictEqual(engine.getDeclared()[0]?.syncFailure?.message, GROUP_UPDATE_UNAVAILABLE_MESSAGE);
			assert.strictEqual(recorded.upserts.length, 1, "the shortcut still avoids hammering the host");
		});

		test("a new entry under a name the host already uses gets the actionable error immediately", async () => {
			const recorded = makeSyncEnv([{ label: "Taken", baseUrl: "http://a.test" }]);
			recorded.duplicateLabels.add("Taken");
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();

			assert.strictEqual(engine.getDeclared()[0]?.syncFailure?.message, GROUP_UPDATE_UNAVAILABLE_MESSAGE);
			assert.deepStrictEqual(recorded.fingerprints, {}, "no fingerprint for an entry that never landed");
		});

		test("a genuine name conflict recovers once the conflicting group is removed natively", async () => {
			const recorded = makeSyncEnv([{ label: "Taken", baseUrl: "http://a.test" }]);
			recorded.duplicateLabels.add("Taken");
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();
			assert.strictEqual(engine.getDeclared()[0]?.syncFailure?.message, GROUP_UPDATE_UNAVAILABLE_MESSAGE);

			// The user deletes the stale group from the models file and runs Sync
			// Models Now: the forced pass retries the add, and this time it lands.
			recorded.duplicateLabels.delete("Taken");
			await engine.syncNow(true);
			assert.strictEqual(engine.getDeclared()[0]?.syncFailure?.message, undefined, "the blocked entry heals");
			assert.deepStrictEqual(Object.keys(recorded.fingerprints), ["Taken"], "the landed add records its fingerprint");
		});

		test("a stale fingerprint re-read cannot misclassify the engine's own group as a name conflict", async () => {
			// The engine's session map is in-memory and the persisted map only seeds the
			// first pass: a stale re-read must not make the engine re-add its own group
			// and read the duplicate rejection as a foreign name conflict.
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://a.test" }]);
			recorded.env.getFingerprints = () => ({});
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow(true);
			assert.deepStrictEqual(Object.keys(recorded.fingerprints), ["A"], "the add persisted its fingerprint");
			recorded.duplicateLabels.add("A");

			// The debounced follow-up pass: in-sync from the session map, so no
			// host call at all and no spurious error - even though the store's
			// re-read still claims no fingerprint exists.
			await engine.syncNow();
			assert.strictEqual(recorded.upserts.length, 1, "the in-sync entry must not be re-added");
			assert.strictEqual(
				engine.getDeclared()[0]?.syncFailure?.message,
				undefined,
				"no spurious name-conflict classification"
			);

			// Even a forced pass (activation, Sync Models Now) reads the duplicate
			// rejection as the add-only steady state, not a conflict.
			await engine.syncNow(true);
			assert.strictEqual(
				engine.getDeclared()[0]?.syncFailure?.message,
				undefined,
				"the forced re-add reads as steady state"
			);
		});

		test("a restarted engine seeds from the persisted map, so the steady-state duplicate stays silent", async () => {
			// The most-executed production path: every activation after the first
			// runs a forced pass whose adds all come back as duplicates, and the
			// silence depends entirely on the seed from the persisted map.
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://a.test" }]);
			await new ServerSyncEngine(recorded.env).syncNow();
			recorded.duplicateLabels.add("A");

			const restarted = new ServerSyncEngine(recorded.env);
			await restarted.syncNow(true);
			assert.strictEqual(
				restarted.getDeclared()[0]?.syncFailure?.message,
				undefined,
				"the re-add reads as steady state"
			);
			assert.deepStrictEqual(Object.keys(recorded.fingerprints), ["A"], "the record survives the restart pass");
		});

		test("a secrets-unreadable pass preserves a store record this window never seeded", async () => {
			// The pass-end write is whole-key: a record another window persisted after
			// this window's session map seeded must ride through a pass that cannot read
			// the entry's secrets, or the write destroys the only copy.
			const recorded = makeSyncEnv([]);
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();

			recorded.setting = [{ label: "A", baseUrl: "http://a.test" }];
			recorded.fingerprints = { A: "another-windows-record" };
			recorded.env.readSecrets = async () => {
				throw new Error("secret store failed");
			};
			await engine.syncNow();

			assert.strictEqual(engine.getDeclared()[0]?.syncFailure?.message, SECRETS_READ_FAILED_MESSAGE);
			assert.deepStrictEqual(
				recorded.fingerprints,
				{ A: "another-windows-record" },
				"the unseen record survives the pass-end write"
			);
		});

		test("a failed upsert preserves a store record this window never seeded", async () => {
			// Same whole-key hazard on the non-duplicate failure path: a failed add
			// changes nothing about the live group, so a record this window has no
			// memory of must not be the one thing the pass deletes.
			const recorded = makeSyncEnv([]);
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();

			recorded.setting = [{ label: "A", baseUrl: "http://a.test" }];
			recorded.fingerprints = { A: "another-windows-record" };
			recorded.failLabels.add("A");
			await engine.syncNow();

			assert.strictEqual(engine.getDeclared()[0]?.syncFailure?.message, GROUP_UPSERT_FAILED_MESSAGE);
			assert.deepStrictEqual(
				recorded.fingerprints,
				{ A: "another-windows-record" },
				"the unseen record survives the pass-end write"
			);
		});

		test("an unconfirmed salt pauses the pass: no adds, classified skip, last-known-good carried", async () => {
			// Under a salt no later session will see, an added group could never be
			// confirmed again and a recorded fingerprint would match nothing, so the
			// pass skips every entry: classified error, stored records carried.
			const setting = [
				{ label: "A", baseUrl: "http://a.test", auth: { apiKey: "sk-1" } },
				{ label: "New", baseUrl: "http://new.test", auth: { apiKey: "sk-2" } },
			];
			const recorded = makeSyncEnv(setting);
			recorded.fingerprints = { A: "durable-record" };
			recorded.saltDurable = false;

			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow(true);

			assert.deepStrictEqual(recorded.upserts, [], "no group may be created under an unconfirmed salt");
			assert.deepStrictEqual(
				recorded.fingerprints,
				{ A: "durable-record" },
				"last-known-good carries; the new entry records nothing"
			);
			for (const view of engine.getDeclared()) {
				assert.strictEqual(view.syncFailure?.message, SALT_UNAVAILABLE_MESSAGE);
				assert.strictEqual(view.syncFailure?.class, "saltUnavailable");
			}
		});

		test("the pause lifts once the salt confirms durable again", async () => {
			const setting = [{ label: "A", baseUrl: "http://a.test", auth: { apiKey: "sk-1" } }];
			const recorded = makeSyncEnv(setting);
			recorded.saltDurable = false;
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow(true);
			assert.deepStrictEqual(recorded.upserts, []);

			recorded.saltDurable = true;
			await engine.syncNow(true);
			assert.strictEqual(recorded.upserts.length, 1, "the next confirmed pass syncs normally");
			assert.strictEqual(engine.getDeclared()[0]?.syncFailure?.message, undefined);
			assert.deepStrictEqual(Object.keys(recorded.fingerprints), ["A"]);
		});

		test("a salt mutation detected mid-pass stops further adds", async () => {
			// The salt is re-confirmed immediately before EACH host add, not only
			// at pass start: a group created after the store mutated could only
			// ever be proven by a fingerprint no later session can recompute.
			const setting = [
				{ label: "A", baseUrl: "http://a.test", auth: { apiKey: "sk-1" } },
				{ label: "B", baseUrl: "http://b.test", auth: { apiKey: "sk-2" } },
			];
			const recorded = makeSyncEnv(setting);
			// Pass-start confirm, A's pre-add confirm, then the mutation lands.
			const answers = [true, true, false];
			recorded.env.confirmFingerprintsDurable = async () => answers.shift() ?? false;

			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow(true);

			assert.strictEqual(recorded.upserts.length, 1, "only the add confirmed before the mutation lands");
			assert.strictEqual(recorded.upserts[0]?.label, "A");
			const views = engine.getDeclared();
			assert.strictEqual(views[0]?.syncFailure?.message, undefined, "A synced normally");
			assert.strictEqual(views[1]?.syncFailure?.message, SALT_UNAVAILABLE_MESSAGE, "B is skipped, not added");
			assert.strictEqual(views[1]?.syncFailure?.class, "saltUnavailable");
		});

		test("a duplicate for a configuration another window already synced confirms against the store", async () => {
			// Two windows share the setting, globalState, and the host's groups but run
			// separate engines. This window seeded before the other's add landed, so the
			// fresh store read on the duplicate path is the positive confirmation that
			// the live group holds exactly these args; the pass-end persist must keep it.
			const setting = [{ label: "A", baseUrl: "http://a.test" }];
			const recorded = makeSyncEnv(setting);
			const parsed = expectDefined(parseServersSetting(setting).entries[0]);
			const printed = groupArgsFingerprint(buildGroupArgs(parsed, {}));
			let seeded = false;
			recorded.env.getFingerprints = () => {
				if (!seeded) {
					seeded = true;
					return {};
				}
				return { A: printed };
			};
			recorded.duplicateLabels.add("A");
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();
			assert.strictEqual(
				engine.getDeclared()[0]?.syncFailure?.message,
				undefined,
				"the other window's record confirms"
			);
			assert.deepStrictEqual(Object.keys(recorded.fingerprints), ["A"], "the persist keeps the shared record");
		});

		test("a store record for a different configuration does not confirm; the conflict stays", async () => {
			// The confirmation is positive-only: a stale store can under-report
			// but never invent a match, so anything but an exact fingerprint
			// match keeps the actionable name-conflict classification.
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://a.test" }]);
			let seeded = false;
			recorded.env.getFingerprints = () => {
				if (!seeded) {
					seeded = true;
					return {};
				}
				return { A: "some-other-configuration" };
			};
			recorded.duplicateLabels.add("A");
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();
			assert.strictEqual(engine.getDeclared()[0]?.syncFailure?.message, GROUP_UPDATE_UNAVAILABLE_MESSAGE);
		});

		test("a confirmed fingerprint joins the session map at once, so a later write-through keeps it", async () => {
			// Confirmed A, then successfully-added B, in ONE pass: B's write-through
			// persists a spread of the session map, so a confirmation that flowed only
			// into the pass's `next` would re-clobber the other window's record mid-pass.
			const setting = [
				{ label: "A", baseUrl: "http://a.test" },
				{ label: "B", baseUrl: "http://b.test" },
			];
			const recorded = makeSyncEnv(setting);
			const parsedA = expectDefined(parseServersSetting(setting).entries[0]);
			const printedA = groupArgsFingerprint(buildGroupArgs(parsedA, {}));
			let seeded = false;
			recorded.env.getFingerprints = () => {
				if (!seeded) {
					seeded = true;
					return {};
				}
				return { A: printedA };
			};
			const persists: Record<string, string>[] = [];
			const setFingerprints = recorded.env.setFingerprints;
			recorded.env.setFingerprints = async (map) => {
				persists.push({ ...map });
				await setFingerprints(map);
			};
			recorded.duplicateLabels.add("A"); // the other window's group holds A
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();

			assert.ok(persists.length >= 2, "B's write-through and the pass-end write both persist");
			for (const [index, map] of persists.entries()) {
				assert.strictEqual(map.A, printedA, `persist #${index + 1} must carry the confirmed record`);
			}
			assert.deepStrictEqual(Object.keys(recorded.fingerprints).sort(), ["A", "B"], "the final map holds both");
			assert.ok(
				engine.getDeclared().every((view) => view.syncFailure?.message === undefined),
				"both entries read as synced"
			);
		});

		test("syncNow during an in-flight pass resolves after the pass that includes the request", async () => {
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://a.test" }]);
			let releaseFirst = () => {};
			const gate = new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
			let calls = 0;
			recorded.env.addProviderGroup = async (args) => {
				calls += 1;
				if (calls === 1) {
					await gate;
				}
				recorded.upserts.push({ ...args });
			};
			const engine = new ServerSyncEngine(recorded.env);

			const first = engine.syncNow();
			// The setting changes while the first pass is blocked mid-flight.
			recorded.setting = [
				{ label: "A", baseUrl: "http://a.test" },
				{ label: "B", baseUrl: "http://b.test" },
			];
			const second = engine.syncNow();
			releaseFirst();
			await second;

			assert.ok(
				recorded.upserts.some((args) => args.name === "B"),
				"the caller's request is included by the time its promise resolves"
			);
			await first;
		});

		test("the declared view carries secret locations and non-secret fields, never values", async () => {
			const recorded = makeSyncEnv(
				[
					{
						label: "A",
						baseUrl: "http://a.test",
						auth: { oauth: { tokenUrl: "https://idp.test/token", clientId: "client", apiKey: "sk-inline" } },
					},
				],
				{ A: { oauthClientSecret: "oauth-secret" } }
			);
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();

			const view = engine.getDeclared()[0];
			assert.ok(view);
			assert.deepStrictEqual(view.secrets, {
				apiKey: "settings",
				oauthClientSecret: "secure",
				virtualKeyValue: "none",
			});
			assert.strictEqual(view.oauthTokenUrl, "https://idp.test/token");
			assert.ok(!JSON.stringify(engine.getDeclared()).includes("sk-inline"));
			assert.ok(!JSON.stringify(engine.getDeclared()).includes("oauth-secret"));
		});

		test("the declared view carries the group client ID its resolved configuration produces", async () => {
			const recorded = makeSyncEnv(
				[
					{ label: "A", baseUrl: "http://x.test", auth: { apiKey: "sk-a" } },
					{ label: "B", baseUrl: "http://x.test" },
				],
				{ B: { apiKey: "sk-b" } }
			);
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();

			const [a, b] = engine.getDeclared();
			assert.ok(a !== undefined && b !== undefined);
			assert.strictEqual(
				a.expectedClientId,
				groupClientId({ baseUrl: normalizeBaseUrl("http://x.test"), apiKey: "sk-a", label: "A" }),
				"the same identity the provider stamps on its status snapshots, entry label included"
			);
			assert.notStrictEqual(
				a.expectedClientId,
				b.expectedClientId,
				"entries sharing a base URL with different credentials get distinct identities"
			);
			assert.ok(
				a.expectedClientId !== undefined && !a.expectedClientId.includes("sk-a"),
				"a fingerprint, not the secret"
			);
		});

		test("entries sharing one connection get distinct client IDs but one shared connection ID", async () => {
			// Two declared entries, one base URL, one key: the labeled IDs keep their
			// status entries apart, and the label-agnostic connection ID is what both
			// share, so the dashboard join can hand a pre-label snapshot to both.
			const recorded = makeSyncEnv([
				{ label: "A", baseUrl: "http://x.test", auth: { apiKey: "sk-shared" } },
				{ label: "B", baseUrl: "http://x.test", auth: { apiKey: "sk-shared" } },
			]);
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();

			const [a, b] = engine.getDeclared();
			assert.ok(a !== undefined && b !== undefined);
			assert.notStrictEqual(a.expectedClientId, b.expectedClientId, "same connection, distinct entry identities");
			assert.strictEqual(
				a.expectedConnectionId,
				groupClientId({ baseUrl: normalizeBaseUrl("http://x.test"), apiKey: "sk-shared" }),
				"the connection ID is the label-less identity pre-label groups report under"
			);
			assert.strictEqual(a.expectedConnectionId, b.expectedConnectionId, "one connection, one shared connection ID");
			assert.ok(!JSON.stringify(engine.getDeclared()).includes("sk-shared"), "fingerprints only, never the secret");
		});

		test("the client ID mirrors the provider's narrowing for OAuth and virtual-key entries too", async () => {
			// If the narrowOAuth/narrowVirtualKey mirroring drifts, pass 0 of the
			// dashboard join silently falls through to the URL join, so equality with an
			// independently built GroupServer is pinned per credential shape.
			const recorded = makeSyncEnv(
				[
					{
						label: "OAuth",
						baseUrl: "http://oauth.test",
						auth: { oauth: { tokenUrl: "https://idp.test/token", clientId: "client", scopes: "read write" } },
					},
					{ label: "VirtualKey", baseUrl: "http://vk.test", auth: { virtualKey: { header: "x-litellm-api-key" } } },
				],
				{ OAuth: { oauthClientSecret: "cs-1" }, VirtualKey: { virtualKeyValue: "vk-1" } }
			);
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();

			const [oauth, virtualKey] = engine.getDeclared();
			assert.strictEqual(
				oauth?.expectedClientId,
				groupClientId({
					baseUrl: normalizeBaseUrl("http://oauth.test"),
					apiKey: "",
					label: "OAuth",
					oauth: { tokenUrl: "https://idp.test/token", clientId: "client", clientSecret: "cs-1", scopes: "read write" },
				}),
				"the OAuth block, secure-side client secret included, fingerprints like the provider's"
			);
			assert.strictEqual(
				virtualKey?.expectedClientId,
				groupClientId({
					baseUrl: normalizeBaseUrl("http://vk.test"),
					apiKey: "",
					label: "VirtualKey",
					virtualKey: { header: "x-litellm-api-key", value: "vk-1" },
				}),
				"the virtual-key pair fingerprints like the provider's"
			);
			const serialized = JSON.stringify(engine.getDeclared());
			assert.ok(!serialized.includes("cs-1") && !serialized.includes("vk-1"), "fingerprints only, never the secrets");
		});

		test("no log line carries a secret, only booleans", async () => {
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://a.test", auth: { apiKey: "sk-very-secret" } }]);
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();

			const logged = JSON.stringify([recorded.logged, recorded.loggedErrors]);
			assert.ok(!logged.includes("sk-very-secret"), logged);
			assert.ok(logged.includes('"hasApiKey":true'));
		});

		test("onDidSync fires after every pass, even a failing one", async () => {
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://a.test" }]);
			recorded.failLabels.add("A");
			const engine = new ServerSyncEngine(recorded.env);
			let fired = 0;
			engine.onDidSync(() => {
				fired += 1;
			});
			await engine.syncNow();

			assert.strictEqual(fired, 1);
		});

		test("onDidSync listeners are independent: disposal detaches one, a throw is logged and starves nobody", async () => {
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://a.test" }]);
			const engine = new ServerSyncEngine(recorded.env);
			let first = 0;
			let second = 0;
			const subscription = engine.onDidSync(() => {
				first += 1;
				throw new Error("listener boom");
			});
			engine.onDidSync(() => {
				second += 1;
			});
			await engine.syncNow();
			assert.strictEqual(first, 1);
			assert.strictEqual(second, 1, "the throwing listener must not starve the next one");
			assert.ok(
				recorded.loggedErrors.some(([message]) => message === "Server sync listener failed"),
				JSON.stringify(recorded.loggedErrors)
			);

			subscription.dispose();
			await engine.syncNow();
			assert.strictEqual(first, 1, "a disposed listener no longer fires");
			assert.strictEqual(second, 2);
		});

		test("requestSync debounces bursts into one pass", async () => {
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://a.test" }]);
			const engine = new ServerSyncEngine(recorded.env, 5);
			let passes = 0;
			engine.onDidSync(() => {
				passes += 1;
			});
			engine.requestSync();
			engine.requestSync();
			engine.requestSync();
			await new Promise((resolve) => setTimeout(resolve, 40));

			assert.strictEqual(passes, 1);
			assert.strictEqual(recorded.upserts.length, 1);
			engine.dispose();
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

suite("extension/servers/serverSync: createServerSyncEnv fingerprint persistence", () => {
	function makeEnv(salt: "durable" | "session-only") {
		const storage = makeExtensionStorage({ [SERVER_SYNC_FINGERPRINTS_KEY]: { A: "before" } });
		const lines: string[] = [];
		const logger = new Logger({
			info: (message: string) => lines.push(message),
			error: (message: string) => lines.push(`ERROR: ${message}`),
		});
		const context = {
			globalState: storage.memento,
			secrets: storage.secrets,
		} as unknown as vscode.ExtensionContext;
		return {
			env: createServerSyncEnv(
				context,
				logger,
				fakeFingerprintSaltSession(salt),
				new GroupRemovalStore(storage.memento)
			),
			storage,
			lines,
		};
	}

	test("a durable salt persists the map as before", async () => {
		const { env, storage } = makeEnv("durable");
		await env.setFingerprints({ A: "after" });
		assert.deepStrictEqual(storage.mementoStore.get(SERVER_SYNC_FINGERPRINTS_KEY), { A: "after" });
		assert.deepStrictEqual(env.getFingerprints(), { A: "after" });
	});

	test("a carried legacy-format record never overwrites a store record another window projected", async () => {
		// Only pre-projection records lack the "i1:" prefix, and the engine
		// carries them purely as last-known-good, so the projected store record
		// is strictly newer knowledge; the engine's next duplicate response
		// confirms against the store and adopts it into the session map.
		const { env, storage } = makeEnv("durable");
		await env.setFingerprints({ A: "i1:projected-elsewhere", B: "i1:fresh" });
		await env.setFingerprints({ A: "legacy-carried", B: "i1:fresh" });
		assert.deepStrictEqual(storage.mementoStore.get(SERVER_SYNC_FINGERPRINTS_KEY), {
			A: "i1:projected-elsewhere",
			B: "i1:fresh",
		});
	});

	test("a session-only salt never touches the stored map", async () => {
		// Session-only renderings match nothing next session, so persisting them would
		// overwrite the durable records that let a healthy group read as in-sync once
		// the real salt is back. The in-memory map still carries the session's state.
		const { env, storage, lines } = makeEnv("session-only");
		await env.setFingerprints({ A: "ephemeral" });
		assert.deepStrictEqual(
			storage.mementoStore.get(SERVER_SYNC_FINGERPRINTS_KEY),
			{ A: "before" },
			"the stored records survive untouched"
		);
		assert.ok(
			lines.some((line) => line.includes("will not persist fingerprints")),
			"the disabled persistence announces itself once"
		);
	});

	test("a corrupted stored map is validated at the read boundary", async () => {
		// The key is engine-owned and only ever written with strings under
		// parser-accepted labels, so a non-string value (storage corruption, an
		// external write) must not reach the session map behind an unchecked cast,
		// a value that is not a map reads as empty, and a reserved
		// (prototype-mutating) key is dropped HERE - the engine assigns these keys
		// into plain records unguarded, so the boundary is the one filter.
		const { env, storage } = makeEnv("durable");
		storage.mementoStore.set(SERVER_SYNC_FINGERPRINTS_KEY, { A: "ok", B: 42 });
		assert.deepStrictEqual(env.getFingerprints(), { A: "ok" });

		storage.mementoStore.set(SERVER_SYNC_FINGERPRINTS_KEY, "not-a-map");
		assert.deepStrictEqual(env.getFingerprints(), {});

		// JSON.parse so __proto__ is an own key (an object literal would set the
		// prototype instead of a data property).
		storage.mementoStore.set(
			SERVER_SYNC_FINGERPRINTS_KEY,
			JSON.parse('{"A": "ok", "__proto__": "fp", "constructor": "fp", "prototype": "fp"}')
		);
		assert.deepStrictEqual(env.getFingerprints(), { A: "ok" });

		storage.mementoStore.set(
			SYNCED_ENTRY_BASE_URLS_KEY,
			JSON.parse('{"A": "http://a.test", "__proto__": "http://evil.test", "B": 7}')
		);
		assert.deepStrictEqual(env.getEntryBaseUrls(), { A: "http://a.test" });
	});

	test("a salt mutation detected at write time stops that persist", async () => {
		// setFingerprints re-confirms per write, not per pass: a store mutation
		// landing between two writes must stop the second one.
		const storage = makeExtensionStorage({ [SERVER_SYNC_FINGERPRINTS_KEY]: { A: "before" } });
		const context = {
			globalState: storage.memento,
			secrets: storage.secrets,
		} as unknown as vscode.ExtensionContext;
		const answers: ("durable" | "session-only")[] = ["durable", "session-only"];
		const env = createServerSyncEnv(
			context,
			new Logger({ info: () => {}, error: () => {} }),
			{
				state: () => "durable",
				confirmDurable: async () => answers.shift() ?? "session-only",
			},
			new GroupRemovalStore(storage.memento)
		);

		await env.setFingerprints({ A: "first" });
		assert.deepStrictEqual(storage.mementoStore.get(SERVER_SYNC_FINGERPRINTS_KEY), { A: "first" });
		await env.setFingerprints({ A: "second" });
		assert.deepStrictEqual(
			storage.mementoStore.get(SERVER_SYNC_FINGERPRINTS_KEY),
			{ A: "first" },
			"the write after the mutation is refused"
		);
	});
});

suite("extension/servers/serverSync: the nested entry shape", () => {
	const parseOne = (entry: Record<string, unknown>) =>
		parseServersSetting([{ label: "S", baseUrl: "http://s.test", ...entry }]);

	suite("auth forms", () => {
		test("each single form flattens onto the internal credential fields", () => {
			const apiKey = parseOne({ auth: { apiKey: "sk-1" } });
			assert.deepStrictEqual(apiKey.entries[0], { label: "S", baseUrl: "http://s.test", apiKey: "sk-1" });

			const oauth = parseOne({
				auth: { oauth: { tokenUrl: "https://idp.test/token", clientId: "c1", clientSecret: "shh", scopes: "read" } },
			});
			assert.deepStrictEqual(oauth.entries[0], {
				label: "S",
				baseUrl: "http://s.test",
				oauthTokenUrl: "https://idp.test/token",
				oauthClientId: "c1",
				oauthClientSecret: "shh",
				oauthScopes: "read",
			});

			const virtualKey = parseOne({ auth: { virtualKey: { header: "x-litellm-key", value: "vk-1" } } });
			assert.deepStrictEqual(virtualKey.entries[0], {
				label: "S",
				baseUrl: "http://s.test",
				virtualKeyHeader: "x-litellm-key",
				virtualKeyValue: "vk-1",
			});
		});

		test("the oauth companions nest inside the oauth object", () => {
			const { entries, problems } = parseOne({
				auth: {
					oauth: {
						tokenUrl: "https://idp.test/token",
						clientId: "c1",
						apiKey: "sk-companion",
						virtualKey: { header: "x-vk", value: "vk-companion" },
					},
				},
			});
			assert.deepStrictEqual(problems, []);
			assert.deepStrictEqual(entries[0], {
				label: "S",
				baseUrl: "http://s.test",
				apiKey: "sk-companion",
				oauthTokenUrl: "https://idp.test/token",
				oauthClientId: "c1",
				virtualKeyHeader: "x-vk",
				virtualKeyValue: "vk-companion",
			});
		});

		test("the apiKey form may carry a sibling virtualKey companion (forms rank oauth > apiKey > virtualKey)", () => {
			const { entries, problems } = parseOne({
				auth: { apiKey: "sk-1", virtualKey: { header: "x-vk", value: "vk-1" } },
			});
			assert.deepStrictEqual(problems, []);
			assert.deepStrictEqual(entries[0], {
				label: "S",
				baseUrl: "http://s.test",
				apiKey: "sk-1",
				virtualKeyHeader: "x-vk",
				virtualKeyValue: "vk-1",
			});
		});

		test("a form waiting for its secret VALUE is not misconfiguration: the entry works without the value", () => {
			// The normal add-entry-then-set-secret state (docs: servers.md,
			// Authentication): the shape is complete, only the secret is elsewhere.
			const virtualKey = parseOne({ auth: { virtualKey: { header: "x-vk" } } });
			assert.deepStrictEqual(virtualKey.problems, []);
			assert.deepStrictEqual(virtualKey.entries[0], {
				label: "S",
				baseUrl: "http://s.test",
				virtualKeyHeader: "x-vk",
			});

			const emptyApiKey = parseOne({ auth: { apiKey: "" } });
			assert.deepStrictEqual(emptyApiKey.problems, []);
			assert.deepStrictEqual(emptyApiKey.entries[0], { label: "S", baseUrl: "http://s.test" });
		});

		test("misconfigured auth skips the entry with a diagnostic: sibling forms beside oauth", () => {
			const { entries, problems } = parseOne({
				auth: { oauth: { tokenUrl: "https://idp.test/token", clientId: "c1" }, apiKey: "sk-1" },
			});
			assert.deepStrictEqual(entries, []);
			assert.ok(
				problems.some((problem) => problem.includes("has auth.apiKey beside auth.oauth; move it to auth.oauth.apiKey")),
				`${problems}`
			);
			assert.ok(
				problems.some((problem) => problem.includes("misconfigured")),
				`${problems}`
			);

			const virtualKeyBeside = parseOne({
				auth: {
					oauth: { tokenUrl: "https://idp.test/token", clientId: "c1" },
					virtualKey: { header: "x-vk", value: "vk-1" },
				},
			});
			assert.deepStrictEqual(virtualKeyBeside.entries, []);
			assert.ok(
				virtualKeyBeside.problems.some((problem) =>
					problem.includes("has auth.virtualKey beside auth.oauth; move it to auth.oauth.virtualKey")
				),
				`${virtualKeyBeside.problems}`
			);
			// Per-key precision: only the offending key is named.
			assert.ok(
				!virtualKeyBeside.problems.some((problem) => problem.includes("has auth.apiKey beside")),
				`${virtualKeyBeside.problems}`
			);

			// Both companions beside oauth: one problem per offending key.
			const bothBeside = parseOne({
				auth: {
					oauth: { tokenUrl: "https://idp.test/token", clientId: "c1" },
					apiKey: "sk-1",
					virtualKey: { header: "x-vk", value: "vk-1" },
				},
			});
			assert.deepStrictEqual(bothBeside.entries, []);
			for (const key of ["apiKey", "virtualKey"]) {
				assert.ok(
					bothBeside.problems.some((problem) =>
						problem.includes(`has auth.${key} beside auth.oauth; move it to auth.oauth.${key}`)
					),
					`${bothBeside.problems}`
				);
			}
		});

		test("misconfigured auth: shape-incomplete oauth and virtualKey (config-shape errors never guess)", () => {
			const noClientId = parseOne({ auth: { oauth: { tokenUrl: "https://idp.test/token" } } });
			assert.deepStrictEqual(noClientId.entries, []);
			assert.ok(noClientId.problems.some((problem) => problem.includes("incomplete auth.oauth")));

			const noHeader = parseOne({ auth: { virtualKey: { value: "vk-1" } } });
			assert.deepStrictEqual(noHeader.entries, []);
			assert.ok(noHeader.problems.some((problem) => problem.includes("without a usable header name")));

			const badHeader = parseOne({ auth: { virtualKey: { header: "bad header", value: "vk-1" } } });
			assert.deepStrictEqual(badHeader.entries, []);
			assert.ok(badHeader.problems.some((problem) => problem.includes("not a valid HTTP header name")));
		});

		test("misconfigured auth: unknown keys are named (a typo must not silently read as no auth)", () => {
			const { entries, problems } = parseOne({ auth: { apikey: "sk-1" } });
			assert.deepStrictEqual(entries, []);
			assert.ok(
				problems.some((problem) => problem.includes('unknown auth key "apikey"')),
				`${problems}`
			);

			const emptyAuth = parseOne({ auth: {} });
			assert.deepStrictEqual(emptyAuth.entries, []);
			assert.ok(emptyAuth.problems.some((problem) => problem.includes("configures no form")));

			const notAnObject = parseOne({ auth: "sk-1" });
			assert.deepStrictEqual(notAnObject.entries, []);
			assert.ok(notAnObject.problems.some((problem) => problem.includes("not an object")));
		});

		test("a misconfigured entry stays PRESENT: rawDeclaredLabels keeps its label, so no removal is inferred", () => {
			const raw = [{ label: "S", baseUrl: "http://s.test", auth: { apiKey: 42 } }];
			assert.deepStrictEqual(parseServersSetting(raw).entries, []);
			assert.deepStrictEqual([...rawDeclaredLabels(raw)], ["S"]);
		});

		test("declaredEntryLabel mirrors rawDeclaredLabels' per-entry rule", () => {
			assert.strictEqual(declaredEntryLabel({ label: " alpha " }), "alpha");
			assert.strictEqual(declaredEntryLabel({ label: "" }), undefined);
			assert.strictEqual(declaredEntryLabel({ label: "__proto__" }), undefined);
			assert.strictEqual(declaredEntryLabel({ label: 42 }), undefined);
			assert.strictEqual(declaredEntryLabel("not-an-object"), undefined);
		});

		test("stillDeclaredIn judges presence, not acceptance, and a non-array container proves nothing", () => {
			const present = stillDeclaredIn([{ label: "S", baseUrl: "http://s.test", auth: { apiKey: 42 } }]);
			assert.ok(present("S"), "a misconfigured entry's label is still declared");
			assert.ok(!present("gone"), "a label no raw entry carries reads as removed");
			assert.ok(stillDeclaredIn(undefined)("anything"), "a non-array container reads everything as present");
			assert.ok(!stillDeclaredIn([])("anything"), "an empty array is a real remove-everything");
		});
	});

	suite("headers, discovery.declared, and budget", () => {
		test("apiVersion parses trimmed and KEEPS the empty string (append nothing is a real value)", () => {
			assert.strictEqual(parseOne({ apiVersion: "v2" }).entries[0]?.apiVersion, "v2");
			assert.strictEqual(parseOne({ apiVersion: " v2 " }).entries[0]?.apiVersion, "v2");
			assert.strictEqual(parseOne({ apiVersion: "" }).entries[0]?.apiVersion, "");
			assert.strictEqual(parseOne({ apiVersion: "  " }).entries[0]?.apiVersion, "");
			assert.ok(!("apiVersion" in (parseOne({}).entries[0] ?? {})), "absent stays absent");
		});

		test("a non-string apiVersion is a diagnostic and is ignored; the entry stays usable (it is not auth)", () => {
			const invalid = parseOne({ apiVersion: 2 });
			assert.strictEqual(invalid.entries.length, 1);
			assert.ok(!("apiVersion" in (invalid.entries[0] ?? {})));
			assert.ok(
				invalid.problems.some((problem) => problem.includes("apiVersion that is not a string")),
				`${invalid.problems}`
			);
		});

		test("headers parse under the request path's charset rules; case collisions keep the first and report", () => {
			const { entries, problems } = parseOne({
				headers: { "X-Env": "prod", "x-env": "stage", "bad header": "v", "x-count": 2 },
			});
			assert.deepStrictEqual(entries[0]?.headers, { "X-Env": "prod", "x-count": "2" });
			assert.ok(
				problems.some((problem) => problem.includes("repeats an earlier name")),
				`${problems}`
			);
			assert.ok(
				problems.some((problem) => problem.includes("invalid custom header name")),
				`${problems}`
			);
		});

		test("discovery.declared keeps usable exact IDs, deduplicated; junk entries are counted", () => {
			const { entries, problems } = parseOne({
				discovery: { declared: ["deepseek-r1", "deepseek-r1", "  ", 42, "qwen"] },
			});
			assert.deepStrictEqual(entries[0]?.declaredModels, ["deepseek-r1", "qwen"]);
			assert.ok(
				problems.some((problem) => problem.includes("2 unusable discovery.declared value(s)")),
				`${problems}`
			);
		});

		test("unknown discovery keys are named (a typo must not silently read as nothing configured)", () => {
			// The same per-key precision as the unknown auth keys: the report names
			// the structural key, so "expectedFailure" cannot silently read as "no
			// expected failures". Diagnostic only - the entry stays usable.
			const { entries, problems } = parseOne({
				discovery: { expectedFailure: ["modelInfo"], declared: ["deepseek-r1"] },
			});
			assert.strictEqual(entries.length, 1, "an unknown discovery key is a diagnostic, not a rejection");
			assert.ok(!("expectedFailures" in (entries[0] ?? {})), "the typo must not apply as expectedFailures");
			assert.deepStrictEqual(entries[0]?.declaredModels, ["deepseek-r1"], "the known sibling key still applies");
			assert.deepStrictEqual(problems, ['entry 1 has an unknown discovery key "expectedFailure", ignored']);
		});

		test("unknown models keys are named (a typo must not silently read as no per-entry records)", () => {
			const { entries, problems } = parseOne({
				models: { parameter: { "*": { temperature: 0 } }, capabilities: { "*": { supports_vision: true } } },
			});
			assert.strictEqual(entries.length, 1, "an unknown models key is a diagnostic, not a rejection");
			assert.ok(!("modelParameters" in (entries[0] ?? {})), "the typo must not apply as models.parameters");
			assert.deepStrictEqual(
				entries[0]?.modelCapabilities,
				{ "*": { supports_vision: true } },
				"the known sibling key still applies"
			);
			assert.deepStrictEqual(problems, ['entry 1 has an unknown models key "parameter", ignored']);
		});

		test("an invalid budget is a diagnostic and is ignored; the entry stays usable (it is not auth)", () => {
			const invalid = parseOne({ budget: 0 });
			assert.strictEqual(invalid.entries.length, 1);
			assert.ok(!("budget" in (invalid.entries[0] ?? {})));
			assert.ok(invalid.problems.some((problem) => problem.includes("budget")));

			const valid = parseOne({ budget: 50 });
			assert.strictEqual(valid.entries[0]?.budget, 50);
			assert.deepStrictEqual(valid.problems, []);
		});

		test("the accessors resolve headers and declared models only when label and normalized base URL agree", () => {
			const raw = [
				{
					label: "Prod",
					baseUrl: "http://prod.test/",
					apiVersion: "",
					headers: { "x-env": "prod" },
					discovery: { declared: ["deepseek-r1"] },
				},
			];
			assert.deepStrictEqual(entryHeadersFor(raw, "Prod", "http://prod.test"), { "x-env": "prod" });
			assert.deepStrictEqual(entryDeclaredModelsFor(raw, "Prod", "http://prod.test"), ["deepseek-r1"]);
			assert.strictEqual(entryApiVersionFor(raw, "Prod", "http://prod.test"), "", '"" resolves as a real value');
			assert.strictEqual(entryHeadersFor(raw, "Prod", "http://other.test"), undefined);
			assert.strictEqual(entryDeclaredModelsFor(raw, "Nope", "http://prod.test"), undefined);
			assert.strictEqual(entryApiVersionFor(raw, "Prod", "http://other.test"), undefined);
		});

		test("none of apiVersion, headers, declaredModels, or budget enter the group args or their fingerprint", () => {
			const bare: DeclaredServer = { label: "Prod", baseUrl: "http://prod.test", apiKey: "sk-1" };
			const withFields: DeclaredServer = {
				...bare,
				apiVersion: "v2",
				headers: { "x-env": "prod" },
				declaredModels: ["deepseek-r1"],
				budget: 50,
			};
			const stored: StoredServerSecrets = {};
			assert.deepStrictEqual(buildGroupArgs(withFields, stored), buildGroupArgs(bare, stored));
			assert.strictEqual(
				fingerprint(JSON.stringify(buildGroupArgs(withFields, stored))),
				fingerprint(JSON.stringify(buildGroupArgs(bare, stored)))
			);
		});

		test("the engine's view carries apiVersion, the empty override included (the edit form's prefill)", async () => {
			const recorded = makeSyncEnv([
				{ label: "A", baseUrl: "http://a.test", apiVersion: "v2" },
				{ label: "B", baseUrl: "http://b.test", apiVersion: "" },
				{ label: "C", baseUrl: "http://c.test" },
			]);
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();
			const byLabel = new Map(engine.getDeclared().map((view) => [view.label, view]));
			assert.strictEqual(byLabel.get("A")?.apiVersion, "v2");
			assert.strictEqual(byLabel.get("B")?.apiVersion, "", '"" must survive the view construction');
			assert.ok(!("apiVersion" in (byLabel.get("C") ?? {})), "absent stays absent");
		});
	});

	suite("FINGERPRINT STABILITY across the entry restructure (R3's migration depends on this pin)", () => {
		// The migration rewrites entries from the flat pre-redesign fields to the nested
		// auth shape without touching SERVER_SYNC_FINGERPRINTS_KEY or any SecretStorage
		// value. That is sound only while a migrated entry flattens to byte-identical
		// group args - same keys, same values, same insertion order - as its flat
		// original, for every credential combination the old world honored.
		const pin = (flat: DeclaredServer, nested: Record<string, unknown>, stored: StoredServerSecrets = {}) => {
			const { entries, problems } = parseServersSetting([nested]);
			assert.deepStrictEqual(problems, [], JSON.stringify(nested));
			const parsed = entries[0];
			assert.ok(parsed, "the nested entry must parse");
			const flatArgs = buildGroupArgs(flat, stored);
			const nestedArgs = buildGroupArgs(parsed, stored);
			assert.deepStrictEqual(nestedArgs, flatArgs);
			assert.deepStrictEqual(Object.keys(nestedArgs), Object.keys(flatArgs), "key order is part of the rendering");
			assert.strictEqual(fingerprint(JSON.stringify(nestedArgs)), fingerprint(JSON.stringify(flatArgs)));
		};

		test("apiKey only", () => {
			pin(
				{ label: "A", baseUrl: "http://a.test", apiKey: "sk-1" },
				{ label: "A", baseUrl: "http://a.test", auth: { apiKey: "sk-1" } }
			);
		});

		test("oauth with every field", () => {
			pin(
				{
					label: "A",
					baseUrl: "http://a.test",
					oauthTokenUrl: "https://idp.test/token",
					oauthClientId: "c1",
					oauthClientSecret: "shh",
					oauthScopes: "read write",
				},
				{
					label: "A",
					baseUrl: "http://a.test",
					auth: {
						oauth: { tokenUrl: "https://idp.test/token", clientId: "c1", clientSecret: "shh", scopes: "read write" },
					},
				}
			);
		});

		test("the old apiKey+oauth combo maps to the oauth apiKey companion", () => {
			pin(
				{
					label: "A",
					baseUrl: "http://a.test",
					apiKey: "sk-1",
					oauthTokenUrl: "https://idp.test/token",
					oauthClientId: "c1",
				},
				{
					label: "A",
					baseUrl: "http://a.test",
					auth: { oauth: { tokenUrl: "https://idp.test/token", clientId: "c1", apiKey: "sk-1" } },
				}
			);
		});

		test("the old oauth+virtualKey combo maps to the oauth virtualKey companion", () => {
			pin(
				{
					label: "A",
					baseUrl: "http://a.test",
					oauthTokenUrl: "https://idp.test/token",
					oauthClientId: "c1",
					virtualKeyHeader: "x-vk",
					virtualKeyValue: "vk-1",
				},
				{
					label: "A",
					baseUrl: "http://a.test",
					auth: {
						oauth: {
							tokenUrl: "https://idp.test/token",
							clientId: "c1",
							virtualKey: { header: "x-vk", value: "vk-1" },
						},
					},
				}
			);
		});

		test("virtualKey only", () => {
			pin(
				{ label: "A", baseUrl: "http://a.test", virtualKeyHeader: "x-vk", virtualKeyValue: "vk-1" },
				{ label: "A", baseUrl: "http://a.test", auth: { virtualKey: { header: "x-vk", value: "vk-1" } } }
			);
		});

		test("the old apiKey+virtualKey combo (no oauth) maps to the apiKey form with a sibling companion", () => {
			pin(
				{ label: "A", baseUrl: "http://a.test", apiKey: "sk-1", virtualKeyHeader: "x-vk", virtualKeyValue: "vk-1" },
				{
					label: "A",
					baseUrl: "http://a.test",
					auth: { apiKey: "sk-1", virtualKey: { header: "x-vk", value: "vk-1" } },
				}
			);
		});

		test("stored-only secrets keep resolving: a no-auth entry with a stored apiKey still sends the bearer", () => {
			// The quick-start shape: the entry omits auth entirely and the value
			// sits in SecretStorage; the migration writes no auth object for it.
			pin({ label: "A", baseUrl: "http://a.test" }, { label: "A", baseUrl: "http://a.test" }, { apiKey: "sk-stored" });
			assert.strictEqual(
				buildGroupArgs(parseServersSetting([{ label: "A", baseUrl: "http://a.test" }]).entries[0] as DeclaredServer, {
					apiKey: "sk-stored",
				}).apiKey,
				"sk-stored"
			);
		});

		test("stored virtualKey value fills the declared header's slot", () => {
			pin(
				{ label: "A", baseUrl: "http://a.test", virtualKeyHeader: "x-vk" },
				{ label: "A", baseUrl: "http://a.test", auth: { virtualKey: { header: "x-vk" } } },
				{ virtualKeyValue: "vk-stored" }
			);
		});

		// The ruled exceptions: auth fragments the old runtime never honored on the wire
		// drop at migration, so THESE entries' fingerprints change once on upgrade - a
		// single group update with identical wire behavior.
		test("ACCEPTED EXCEPTION: a wire-inert partial-oauth fragment drops and the fingerprint changes once", () => {
			const flat: DeclaredServer = { label: "A", baseUrl: "http://a.test", apiKey: "sk-1", oauthClientId: "c1" };
			// entries.ts drops the lone oauth piece: the migrated entry is the
			// plain apiKey form.
			const { entries, problems } = parseServersSetting([
				{ label: "A", baseUrl: "http://a.test", auth: { apiKey: "sk-1" } },
			]);
			assert.deepStrictEqual(problems, []);
			const migrated = entries[0];
			assert.ok(migrated, "the migrated entry must parse");
			const flatArgs = buildGroupArgs(flat, {});
			const migratedArgs = buildGroupArgs(migrated, {});
			assert.notDeepStrictEqual(migratedArgs, flatArgs, "the fragment was in the old args, so the args differ");
			assert.strictEqual(migratedArgs.baseUrl, flatArgs.baseUrl);
			assert.strictEqual(migratedArgs.apiKey, flatArgs.apiKey, "every wire-relevant credential is unchanged");
			assert.strictEqual(migratedArgs.oauthTokenUrl, undefined, "neither side could ever exchange a token");
		});

		test("ACCEPTED EXCEPTION: a header-less virtualKey value drops and the fingerprint changes once", () => {
			const flat: DeclaredServer = { label: "A", baseUrl: "http://a.test", apiKey: "sk-1", virtualKeyValue: "vk-1" };
			const { entries, problems } = parseServersSetting([
				{ label: "A", baseUrl: "http://a.test", auth: { apiKey: "sk-1" } },
			]);
			assert.deepStrictEqual(problems, []);
			const migrated = entries[0];
			assert.ok(migrated, "the migrated entry must parse");
			const flatArgs = buildGroupArgs(flat, {});
			const migratedArgs = buildGroupArgs(migrated, {});
			assert.notDeepStrictEqual(migratedArgs, flatArgs);
			assert.strictEqual(migratedArgs.apiKey, flatArgs.apiKey);
			assert.strictEqual(
				migratedArgs.virtualKeyValue,
				undefined,
				"a value without its header never left the process on either side"
			);
		});
	});
});
