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
	copyServerSecrets,
	createServerSyncEnv,
	deleteServerSecrets,
	entryModelParametersFor,
	GROUP_UPDATE_UNAVAILABLE_MESSAGE,
	GROUP_UPSERT_FAILED_MESSAGE,
	inlineSecretValues,
	parseServersSetting,
	readServerSecrets,
	SALT_UNAVAILABLE_MESSAGE,
	SECRETS_READ_FAILED_MESSAGE,
	ServerSyncEngine,
	updateServerSecret,
} from "../../../extension/servers/serverSync";
import { groupClientId, parseGroupConfiguration } from "../../../provider/catalog/groupModels";
import { CMD } from "../../../shared/config/commandIds";
import { SERVER_SYNC_FINGERPRINTS_KEY, serverSecretsKey } from "../../../shared/config/storageKeys";
import { Logger } from "../../../shared/logger";
import { normalizeBaseUrl } from "../../../shared/util/baseUrl";
import { fingerprint } from "../../../shared/util/fingerprint";
import { expectDefined, fakeFingerprintSaltSession, makeExtensionStorage, withConfig } from "../../testUtils";

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
		failLabels: new Set(),
		duplicateLabels: new Set(),
		saltDurable: true,
		env: {
			readServersSetting: () => recorded.setting,
			readSecrets: async (label) => recorded.secrets[label] ?? {},
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
				{ label: "Prod", baseUrl: "http://prod.test", apiKey: "sk-1", extra: "ignored" },
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
			await updateServerSecret(store, "Prod", "apiKey", "sk-1");
			await updateServerSecret(store, "Prod", "virtualKeyValue", "vk-1");
			assert.deepStrictEqual(await readServerSecrets(store, "Prod"), { apiKey: "sk-1", virtualKeyValue: "vk-1" });

			await updateServerSecret(store, "Prod", "apiKey", undefined);
			assert.deepStrictEqual(await readServerSecrets(store, "Prod"), { virtualKeyValue: "vk-1" });

			await updateServerSecret(store, "Prod", "virtualKeyValue", undefined);
			assert.strictEqual(store.values.has(serverSecretsKey("Prod")), false, "an empty blob leaves no key behind");
		});

		test("a corrupt blob reads as empty instead of failing the sync", async () => {
			const store = makeSecretStore({ [serverSecretsKey("Prod")]: "not json" });
			assert.deepStrictEqual(await readServerSecrets(store, "Prod"), {});
		});

		test("copyServerSecrets duplicates the blob without touching the source; deleteServerSecrets removes it", async () => {
			const store = makeSecretStore({ [serverSecretsKey("Old")]: JSON.stringify({ apiKey: "sk-1" }) });
			await copyServerSecrets(store, "Old", "New");
			assert.deepStrictEqual(await readServerSecrets(store, "New"), { apiKey: "sk-1" });
			assert.deepStrictEqual(await readServerSecrets(store, "Old"), { apiKey: "sk-1" }, "a copy leaves the source");

			await deleteServerSecrets(store, "Old");
			assert.strictEqual(store.values.has(serverSecretsKey("Old")), false);

			await copyServerSecrets(store, "Missing", "Elsewhere");
			assert.strictEqual(store.values.has(serverSecretsKey("Elsewhere")), false, "no blob, no copy");
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
			// The sync fingerprint is fingerprint(JSON.stringify(args)), so the
			// args object's key insertion order is durable state: reordering it
			// (including "tidying" secrets and non-secrets apart - they interleave)
			// would invalidate every stored fingerprint and force a re-push of all
			// groups. `label` sits right after baseUrl so that removing it yields
			// the pre-label key sequence byte for byte - the unsalted-fingerprint
			// migration's pre-label rendering depends on exactly that. The expected
			// list is spelled out on purpose; do not derive it from the descriptor
			// this test exists to pin.
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
	});

	suite("ServerSyncEngine", () => {
		test("a first pass upserts every entry with resolved secrets and records fingerprints", async () => {
			const recorded = makeSyncEnv(
				[
					{ label: "A", baseUrl: "http://a.test", apiKey: "sk-a" },
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

		test("an unchanged entry skips the upsert; a changed secret re-upserts", async () => {
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://a.test" }], { A: { apiKey: "sk-1" } });
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();
			await engine.syncNow();
			assert.strictEqual(recorded.upserts.length, 1, "the second identical pass upserts nothing");

			recorded.secrets = { A: { apiKey: "sk-2" } };
			await engine.syncNow();
			assert.strictEqual(recorded.upserts.length, 2, "a secret change re-upserts");
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

		test("a removal the identity ledger predates carries no base URL (the env must not tombstone a guess)", async () => {
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://a.test" }]);
			// A fingerprint record persisted by an older version, with no ledger
			// entry to resolve its host.
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

			// A mid-edit settings.json: the entry is still there, just unusable
			// (its baseUrl vanished for a moment). Tombstoning it would suppress
			// a group the user did not remove, and shedding its records would
			// wedge the repaired entry on an unrecognizable duplicate.
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
			assert.strictEqual(engine.getDeclared()[0]?.syncError, undefined);
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

			// Clearing the setting for real IS explicit removal of every entry.
			recorded.setting = undefined;
			await engine.syncNow();
			assert.deepStrictEqual(recordedEvents(recorded), [
				{ kind: "removed", label: "Prod", baseUrl: "http://prod.test" },
			]);
		});

		test("a rejected label's carry also accepts another window's store record, presence-only", async () => {
			const recorded = makeSyncEnv([{ label: "Prod", baseUrl: "http://prod.test" }]);
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();

			// Another window synced "Other" and persisted its records after this
			// engine seeded its session map; the entry then goes malformed here.
			// The carry must take the store's proof (carryLastGood's asymmetry),
			// or this pass-end write would erase the only copy.
			recorded.fingerprints = { ...recorded.fingerprints, Other: "other-window-record" };
			recorded.entryBaseUrls = { ...recorded.entryBaseUrls, Other: "http://other.test" };
			recorded.setting = [{ label: "Prod", baseUrl: "http://prod.test" }, { label: "Other" }];
			await engine.syncNow();

			assert.strictEqual(recorded.fingerprints.Other, "other-window-record", "the other window's proof survives");
			assert.strictEqual(recorded.entryBaseUrls.Other, "http://other.test");
			assert.deepStrictEqual(recordedEvents(recorded), []);
		});

		test("a blocked URL change with no prior ledger record yields an untracked removal, never a guessed tombstone", async () => {
			// An install upgrading from a pre-ledger version changes the entry's
			// URL before the first pass: the add is refused, so the declared URL
			// was never proven and must not enter the ledger - a later removal
			// degrades to the untracked notice instead of tombstoning a group
			// that does not exist.
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
			assert.strictEqual(engine.getDeclared()[0]?.syncErrorClass, "blocked");
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
			assert.strictEqual(engine.getDeclared()[0]?.syncError, GROUP_UPSERT_FAILED_MESSAGE);
			assert.strictEqual(engine.getDeclared()[0]?.syncErrorClass, "upsertFailed");

			recorded.failLabels.clear();
			await engine.syncNow();
			assert.strictEqual(recorded.upserts.length, 1, "the retry lands");
			assert.strictEqual(engine.getDeclared()[0]?.syncError, undefined, "the error clears on success");
			assert.strictEqual(engine.getDeclared()[0]?.syncErrorClass, undefined, "the class clears with it");
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

			assert.strictEqual(engine.getDeclared()[0]?.syncError, undefined, "an existing unchanged group is in sync");
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

			// The entry changes, but the host cannot update the existing group.
			recorded.secrets = { A: { apiKey: "sk-2" } };
			recorded.duplicateLabels.add("A");
			await engine.syncNow();
			assert.strictEqual(engine.getDeclared()[0]?.syncError, GROUP_UPDATE_UNAVAILABLE_MESSAGE);
			assert.strictEqual(engine.getDeclared()[0]?.syncErrorClass, "blocked");
			assert.ok(
				!JSON.stringify(recorded.logged).includes("sk-2"),
				"the classification log never carries secret material"
			);

			// Further unforced passes keep the error without re-calling the host.
			await engine.syncNow();
			await engine.syncNow();
			assert.strictEqual(recorded.upserts.length, 1, "no add attempts while blocked");
			assert.strictEqual(engine.getDeclared()[0]?.syncError, GROUP_UPDATE_UNAVAILABLE_MESSAGE);

			// After the user removes the stale group natively, a forced pass
			// (Sync Models Now, next activation) recreates it and clears the error.
			recorded.duplicateLabels.clear();
			await engine.syncNow(true);
			assert.strictEqual(recorded.upserts.length, 2, "the forced retry lands");
			assert.strictEqual(engine.getDeclared()[0]?.syncError, undefined);
			assert.deepStrictEqual(Object.keys(recorded.fingerprints), ["A"]);
		});

		test("reverting a refused change lands back in sync silently instead of wedging", async () => {
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://a.test" }], { A: { apiKey: "sk-1" } });
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();
			assert.strictEqual(recorded.upserts.length, 1);

			// The change is refused: the host cannot update the existing group.
			recorded.secrets = { A: { apiKey: "sk-2" } };
			recorded.duplicateLabels.add("A");
			await engine.syncNow();
			assert.strictEqual(engine.getDeclared()[0]?.syncError, GROUP_UPDATE_UNAVAILABLE_MESSAGE);
			assert.deepStrictEqual(
				Object.keys(recorded.fingerprints),
				["A"],
				"the last-known-good fingerprint is carried, not dropped"
			);

			// The user reverts the entry instead of removing the group natively:
			// the live group already holds this content, so the error clears
			// without a host call.
			recorded.secrets = { A: { apiKey: "sk-1" } };
			await engine.syncNow();
			assert.strictEqual(engine.getDeclared()[0]?.syncError, undefined, "the revert unwedges the entry");
			assert.strictEqual(recorded.upserts.length, 1, "the revert is a silent no-op, not a retry");
			assert.deepStrictEqual(Object.keys(recorded.fingerprints), ["A"]);

			// A genuine change afterwards still surfaces the error.
			recorded.secrets = { A: { apiKey: "sk-3" } };
			await engine.syncNow();
			assert.strictEqual(engine.getDeclared()[0]?.syncError, GROUP_UPDATE_UNAVAILABLE_MESSAGE);
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
			assert.strictEqual(engine.getDeclared()[0]?.syncError, GROUP_UPSERT_FAILED_MESSAGE);
			assert.deepStrictEqual(Object.keys(recorded.fingerprints), ["A"], "last-known-good survives the failure");

			// The next unforced pass retries and gets the healthy group's normal
			// duplicate rejection; misreading it as changed/name-taken would
			// block the entry forever.
			recorded.failLabels.delete("A");
			recorded.duplicateLabels.add("A");
			await engine.syncNow();
			assert.strictEqual(engine.getDeclared()[0]?.syncError, undefined, "the duplicate is the synced steady state");
			assert.deepStrictEqual(Object.keys(recorded.fingerprints), ["A"]);
		});

		test("a transient failure on a changed entry does not wedge the later revert", async () => {
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://a.test" }], { A: { apiKey: "sk-1" } });
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();
			assert.strictEqual(recorded.upserts.length, 1);

			// The entry changes and the add for the NEW configuration fails
			// transiently (not as a duplicate).
			recorded.secrets = { A: { apiKey: "sk-2" } };
			recorded.failLabels.add("A");
			await engine.syncNow();
			assert.strictEqual(engine.getDeclared()[0]?.syncError, GROUP_UPSERT_FAILED_MESSAGE);
			assert.deepStrictEqual(Object.keys(recorded.fingerprints), ["A"], "last-known-good survives the failure");

			// The user reverts instead: the entry matches the live group again,
			// and the pending retry concerned a configuration that no longer
			// exists, so this is in sync without a host call.
			recorded.failLabels.delete("A");
			recorded.secrets = { A: { apiKey: "sk-1" } };
			await engine.syncNow();
			assert.strictEqual(engine.getDeclared()[0]?.syncError, undefined, "the revert lands in sync");
			assert.strictEqual(recorded.upserts.length, 1, "no host call for the revert");
		});

		test("a generic failure clears stale duplicate knowledge, so the retry is not suppressed", async () => {
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://a.test" }], { A: { apiKey: "sk-1" } });
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();
			assert.strictEqual(recorded.upserts.length, 1);

			// The entry changes and the host refuses the duplicate: blocked.
			recorded.secrets = { A: { apiKey: "sk-2" } };
			recorded.duplicateLabels.add("A");
			await engine.syncNow();
			assert.strictEqual(engine.getDeclared()[0]?.syncError, GROUP_UPDATE_UNAVAILABLE_MESSAGE);

			// The user removes the group natively and forces a sync, but the
			// re-add fails transiently. The stale duplicate knowledge must clear
			// with it, or the blocked shortcut would suppress every retry below.
			recorded.duplicateLabels.delete("A");
			recorded.failLabels.add("A");
			await engine.syncNow(true);
			assert.strictEqual(
				engine.getDeclared()[0]?.syncError,
				GROUP_UPSERT_FAILED_MESSAGE,
				"the classification follows the latest outcome"
			);

			// The next UNFORCED pass reaches the host and lands.
			recorded.failLabels.delete("A");
			await engine.syncNow();
			assert.strictEqual(recorded.upserts.length, 2, "the unforced retry reaches the host");
			assert.strictEqual(engine.getDeclared()[0]?.syncError, undefined);
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
			assert.strictEqual(byLabel.get("A")?.syncError, undefined);
			assert.strictEqual(byLabel.get("B")?.syncError, SECRETS_READ_FAILED_MESSAGE);

			// The store recovers and a forced pass (Sync Models Now) re-adds
			// both: A's duplicate response reads as the steady state - only
			// possible because its fingerprint survived B's failure - and B's
			// first add lands.
			recorded.env.readSecrets = readSecrets;
			recorded.duplicateLabels.add("A");
			await engine.syncNow(true);
			const after = new Map(engine.getDeclared().map((view) => [view.label, view]));
			assert.strictEqual(after.get("A")?.syncError, undefined);
			assert.strictEqual(after.get("B")?.syncError, undefined);
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
				engine.getDeclared()[0]?.syncError,
				undefined,
				"the group's duplicate response reads as in-sync, not a name conflict"
			);
		});

		test("the blocked shortcut re-asserts its classification after an unrelated failure pass", async () => {
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://a.test" }], { A: { apiKey: "sk-1" } });
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();

			// The change is refused as a duplicate: blocked, actionable text.
			recorded.secrets = { A: { apiKey: "sk-2" } };
			recorded.duplicateLabels.add("A");
			await engine.syncNow();
			assert.strictEqual(engine.getDeclared()[0]?.syncError, GROUP_UPDATE_UNAVAILABLE_MESSAGE);

			// One pass cannot read the stored secrets; its classification takes
			// over for that pass.
			const readSecrets = recorded.env.readSecrets;
			recorded.env.readSecrets = async () => {
				throw new Error("keychain locked");
			};
			await engine.syncNow();
			assert.strictEqual(engine.getDeclared()[0]?.syncError, SECRETS_READ_FAILED_MESSAGE);

			// The store recovers and the entry still holds the refused
			// configuration: the shortcut must show the name-conflict text
			// again, not the stale secrets text.
			recorded.env.readSecrets = readSecrets;
			await engine.syncNow();
			assert.strictEqual(engine.getDeclared()[0]?.syncError, GROUP_UPDATE_UNAVAILABLE_MESSAGE);
			assert.strictEqual(recorded.upserts.length, 1, "the shortcut still avoids hammering the host");
		});

		test("a new entry under a name the host already uses gets the actionable error immediately", async () => {
			const recorded = makeSyncEnv([{ label: "Taken", baseUrl: "http://a.test" }]);
			recorded.duplicateLabels.add("Taken");
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();

			assert.strictEqual(engine.getDeclared()[0]?.syncError, GROUP_UPDATE_UNAVAILABLE_MESSAGE);
			assert.deepStrictEqual(recorded.fingerprints, {}, "no fingerprint for an entry that never landed");
		});

		test("a genuine name conflict recovers once the conflicting group is removed natively", async () => {
			const recorded = makeSyncEnv([{ label: "Taken", baseUrl: "http://a.test" }]);
			recorded.duplicateLabels.add("Taken");
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();
			assert.strictEqual(engine.getDeclared()[0]?.syncError, GROUP_UPDATE_UNAVAILABLE_MESSAGE);

			// The user removes the stale group in the native editor and runs Sync
			// Models Now: the forced pass retries the add, and this time it lands.
			recorded.duplicateLabels.delete("Taken");
			await engine.syncNow(true);
			assert.strictEqual(engine.getDeclared()[0]?.syncError, undefined, "the blocked entry heals");
			assert.deepStrictEqual(Object.keys(recorded.fingerprints), ["Taken"], "the landed add records its fingerprint");
		});

		test("a stale fingerprint re-read cannot misclassify the engine's own group as a name conflict", async () => {
			// The monkey fuzzer caught globalState losing an awaited update: the
			// fingerprint map read moments after a group add came back as its
			// pre-add value, so the engine re-added its own group, took the
			// duplicate rejection as a foreign name conflict, and - with no
			// last-known-good left to carry - kept the error on every later pass.
			// The engine's session map is therefore in-memory; the persisted map
			// only seeds the first pass. Simulated here by a store whose reads
			// always return the stale pre-add snapshot.
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
			assert.strictEqual(engine.getDeclared()[0]?.syncError, undefined, "no spurious name-conflict classification");

			// Even a forced pass (activation, Sync Models Now) reads the duplicate
			// rejection as the add-only steady state, not a conflict.
			await engine.syncNow(true);
			assert.strictEqual(engine.getDeclared()[0]?.syncError, undefined, "the forced re-add reads as steady state");
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
			assert.strictEqual(restarted.getDeclared()[0]?.syncError, undefined, "the re-add reads as steady state");
			assert.deepStrictEqual(Object.keys(recorded.fingerprints), ["A"], "the record survives the restart pass");
		});

		test("a secrets-unreadable pass preserves a store record this window never seeded", async () => {
			// The pass-end write is whole-key: a record another window persisted
			// after this window's session map seeded must ride through a pass
			// that cannot read the entry's secrets, or the write would destroy
			// the only copy (for a legacy-form record, the only proof the
			// unsaltedSyncFingerprints migration can still rewrite).
			const recorded = makeSyncEnv([]);
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();

			recorded.setting = [{ label: "A", baseUrl: "http://a.test" }];
			recorded.fingerprints = { A: "another-windows-record" };
			recorded.env.readSecrets = async () => {
				throw new Error("secret store failed");
			};
			await engine.syncNow();

			assert.strictEqual(engine.getDeclared()[0]?.syncError, SECRETS_READ_FAILED_MESSAGE);
			assert.deepStrictEqual(
				recorded.fingerprints,
				{ A: "another-windows-record" },
				"the unseen record survives the pass-end write"
			);
		});

		test("a failed upsert preserves a store record this window never seeded", async () => {
			// Same whole-key hazard on the non-duplicate failure path: the
			// branch's contract says a failed add changes nothing about the
			// live group, so a record this window has no memory of must not be
			// the one thing the pass deletes.
			const recorded = makeSyncEnv([]);
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();

			recorded.setting = [{ label: "A", baseUrl: "http://a.test" }];
			recorded.fingerprints = { A: "another-windows-record" };
			recorded.failLabels.add("A");
			await engine.syncNow();

			assert.strictEqual(engine.getDeclared()[0]?.syncError, GROUP_UPSERT_FAILED_MESSAGE);
			assert.deepStrictEqual(
				recorded.fingerprints,
				{ A: "another-windows-record" },
				"the unseen record survives the pass-end write"
			);
		});

		test("an unconfirmed salt pauses the pass: no adds, classified skip, last-known-good carried", async () => {
			// Under a salt no later session will see, an added group could never
			// be confirmed again (add-only host) and a recorded fingerprint
			// would match nothing, so the pass skips every entry the way it
			// skips unreadable secrets: classified error, stored records carried.
			const setting = [
				{ label: "A", baseUrl: "http://a.test", apiKey: "sk-1" },
				{ label: "New", baseUrl: "http://new.test", apiKey: "sk-2" },
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
				assert.strictEqual(view.syncError, SALT_UNAVAILABLE_MESSAGE);
				assert.strictEqual(view.syncErrorClass, "secretsUnreadable");
			}
		});

		test("the pause lifts once the salt confirms durable again", async () => {
			const setting = [{ label: "A", baseUrl: "http://a.test", apiKey: "sk-1" }];
			const recorded = makeSyncEnv(setting);
			recorded.saltDurable = false;
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow(true);
			assert.deepStrictEqual(recorded.upserts, []);

			recorded.saltDurable = true;
			await engine.syncNow(true);
			assert.strictEqual(recorded.upserts.length, 1, "the next confirmed pass syncs normally");
			assert.strictEqual(engine.getDeclared()[0]?.syncError, undefined);
			assert.deepStrictEqual(Object.keys(recorded.fingerprints), ["A"]);
		});

		test("a salt mutation detected mid-pass stops further adds", async () => {
			// The salt is re-confirmed immediately before EACH host add, not only
			// at pass start: a group created after the store mutated could only
			// ever be proven by a fingerprint no later session can recompute.
			const setting = [
				{ label: "A", baseUrl: "http://a.test", apiKey: "sk-1" },
				{ label: "B", baseUrl: "http://b.test", apiKey: "sk-2" },
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
			assert.strictEqual(views[0]?.syncError, undefined, "A synced normally");
			assert.strictEqual(views[1]?.syncError, SALT_UNAVAILABLE_MESSAGE, "B is skipped, not added");
			assert.strictEqual(views[1]?.syncErrorClass, "secretsUnreadable");
		});

		test("a duplicate for a configuration another window already synced confirms against the store", async () => {
			// Two windows share the machine-scoped setting, globalState, and the
			// host's groups, but run separate engines. This window seeded before
			// the other window's add landed, so its session map is empty; the
			// fresh store read on the duplicate path is the positive confirmation
			// that the live group holds exactly these args. The pass-end persist
			// must keep the record, not clobber the other window's write.
			const setting = [{ label: "A", baseUrl: "http://a.test" }];
			const recorded = makeSyncEnv(setting);
			const parsed = expectDefined(parseServersSetting(setting).entries[0]);
			const printed = fingerprint(JSON.stringify(buildGroupArgs(parsed, {})));
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
			assert.strictEqual(engine.getDeclared()[0]?.syncError, undefined, "the other window's record confirms");
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
			assert.strictEqual(engine.getDeclared()[0]?.syncError, GROUP_UPDATE_UNAVAILABLE_MESSAGE);
		});

		test("a confirmed fingerprint joins the session map at once, so a later write-through keeps it", async () => {
			// Confirmed A, then successfully-added B, in ONE pass: B's
			// write-through persists a spread of the session map, so if the
			// confirmation only flowed into the pass's `next`, that persist
			// would re-clobber the other window's record mid-pass - the exact
			// loss the confirmation path exists to prevent.
			const setting = [
				{ label: "A", baseUrl: "http://a.test" },
				{ label: "B", baseUrl: "http://b.test" },
			];
			const recorded = makeSyncEnv(setting);
			const parsedA = expectDefined(parseServersSetting(setting).entries[0]);
			const printedA = fingerprint(JSON.stringify(buildGroupArgs(parsedA, {})));
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
				engine.getDeclared().every((view) => view.syncError === undefined),
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
						apiKey: "sk-inline",
						oauthTokenUrl: "https://idp.test/token",
						oauthClientId: "client",
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
					{ label: "A", baseUrl: "http://x.test", apiKey: "sk-a" },
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
			// The exact user scenario behind per-entry identity: two declared
			// entries, one base URL, one key. The labeled IDs keep their status
			// entries apart; the label-agnostic connection ID is what both share,
			// so the dashboard join can hand a pre-label group's snapshot to both.
			const recorded = makeSyncEnv([
				{ label: "A", baseUrl: "http://x.test", apiKey: "sk-shared" },
				{ label: "B", baseUrl: "http://x.test", apiKey: "sk-shared" },
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
			// The OAuth and virtual-key blocks pass through the provider's
			// narrowOAuth/narrowVirtualKey rules on both sides; if the mirroring
			// ever drifts, pass 0 of the dashboard join silently falls through to
			// the URL join, so equality with an independently built GroupServer is
			// pinned per credential shape.
			const recorded = makeSyncEnv(
				[
					{
						label: "OAuth",
						baseUrl: "http://oauth.test",
						oauthTokenUrl: "https://idp.test/token",
						oauthClientId: "client",
						oauthScopes: "read write",
					},
					{ label: "VirtualKey", baseUrl: "http://vk.test", virtualKeyHeader: "x-litellm-api-key" },
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
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://a.test", apiKey: "sk-very-secret" }]);
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
			engine.onDidSync = () => {
				fired += 1;
			};
			await engine.syncNow();

			assert.strictEqual(fired, 1);
		});

		test("requestSync debounces bursts into one pass", async () => {
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://a.test" }]);
			const engine = new ServerSyncEngine(recorded.env, 5);
			let passes = 0;
			engine.onDidSync = () => {
				passes += 1;
			};
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
			// buildGroupArgs is the writer of the provider-group configuration and
			// parseGroupConfiguration the reader; both iterate
			// OPTIONAL_ENTRY_FIELDS, so a descriptor field can only ship if it
			// round-trips here.
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
					// JSON.parse so __proto__ is an own key (an object literal would
					// set the prototype instead of a property).
					modelParameters: JSON.parse(
						'{"gpt-4": {"temperature": 0.2, "stop": ["END"]}, "claude": "not a record", "__proto__": {"polluted": true}}'
					) as unknown,
				},
				{ label: "Junk", baseUrl: "http://junk.test", modelParameters: "junk" },
				{ label: "Empty", baseUrl: "http://empty.test", modelParameters: {} },
				{ label: "Bare", baseUrl: "http://bare.test" },
			]);

			assert.deepStrictEqual(problems, [], "a malformed modelParameters shape never rejects the entry");
			assert.deepStrictEqual(entries[0]?.modelParameters, { "gpt-4": { temperature: 0.2, stop: ["END"] } });
			for (const entry of entries.slice(1)) {
				assert.ok(!("modelParameters" in entry), `"${entry.label}" must read as carrying no entry parameters`);
			}
		});

		test("acceptedEntry resolves the entry with its modelParameters, for the request path's read", () => {
			const raw = [{ label: "Prod", baseUrl: "http://prod.test", modelParameters: { "gpt-4": { top_p: 0.9 } } }];
			assert.deepStrictEqual(acceptedEntry(raw, "Prod")?.entry.modelParameters, { "gpt-4": { top_p: 0.9 } });
		});

		test("entryModelParametersFor resolves only when the label and the normalized base URL agree", () => {
			const raw = [
				{ label: "Prod", baseUrl: "http://prod.test/", modelParameters: { "gpt-4": { top_p: 0.9 } } },
				{ label: "Stage", baseUrl: "http://stage.test", modelParameters: { "gpt-4": { top_p: 0.2 } } },
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
				{ label: "A", baseUrl: "http://a.test", modelParameters: { "gpt-4": { temperature: 0.2 } } },
			]);
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();
			assert.strictEqual(recorded.upserts.length, 1);
			assert.ok(!("modelParameters" in (recorded.upserts[0] ?? {})), "params stay out of the host configuration");
			const printed = recorded.fingerprints.A;
			assert.ok(printed !== undefined);
			assert.deepStrictEqual(engine.getDeclared()[0]?.modelParameters, { "gpt-4": { temperature: 0.2 } });

			recorded.setting = [{ label: "A", baseUrl: "http://a.test", modelParameters: { "gpt-4": { temperature: 0.9 } } }];
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
			// The dormancy rule everywhere ("a stored secret stays dormant behind
			// an inline value") is this agreement: for every secret field, the
			// argument sent to the host is the inline value when
			// inlineSecretValues holds the field, the stored one otherwise.
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
			// One fixture through both paths: the engine's declared views carry
			// the locations the dashboard state pushes, and readInlineSecretValues
			// answers the edit form's prefill request. Both derive from
			// inlineSecretValues, and this pins the agreement end to end.
			const setting = [
				{
					label: "Mixed",
					baseUrl: "http://mixed.test",
					apiKey: "sk-inline",
					virtualKeyHeader: "x-vk",
					virtualKeyValue: "vk-inline",
					oauthTokenUrl: "https://idp.test/token",
					oauthClientId: "client-1",
				},
				{ label: "Secure", baseUrl: "http://secure.test" },
			];
			const recorded = makeSyncEnv(setting, { Secure: { apiKey: "sk-stored" } });
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();

			for (const view of engine.getDeclared()) {
				const prefill = readInlineSecretValues(setting, view.label);
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
					{ servers: [{ label: "Dormancy Probe", baseUrl: "http://dormant.test", apiKey: "sk-inline" }] },
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

	test("a session-only salt never touches the stored map", async () => {
		// Session-only renderings match nothing next session; persisting them
		// would overwrite the durable records (or upgrade a legacy record into
		// an unmatchable one) that let a healthy group read as in-sync once
		// the real salt is back. The engine's in-memory map still carries the
		// session's state, so within the session nothing changes.
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
		// The key is engine-owned and only ever written with strings, so a
		// non-string value (storage corruption, an external write) must not
		// reach the session map behind an unchecked cast - and a value that is
		// not a map at all reads as empty.
		const { env, storage } = makeEnv("durable");
		storage.mementoStore.set(SERVER_SYNC_FINGERPRINTS_KEY, { A: "ok", B: 42 });
		assert.deepStrictEqual(env.getFingerprints(), { A: "ok" });

		storage.mementoStore.set(SERVER_SYNC_FINGERPRINTS_KEY, "not-a-map");
		assert.deepStrictEqual(env.getFingerprints(), {});
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
