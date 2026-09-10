/**
 * The ServerSyncEngine's passes: adds, blocked identity changes, removals and
 * renames, and the fingerprint persistence createServerSyncEnv gives it.
 */
import * as assert from "node:assert";
import type * as vscode from "vscode";
import { GroupRemovalStore } from "../../../extension/servers/groupRemovals";
import {
	buildGroupArgs,
	createServerSyncEnv,
	GROUP_UPDATE_UNAVAILABLE_MESSAGE,
	GROUP_UPSERT_FAILED_MESSAGE,
	parseServersSetting,
	SALT_UNAVAILABLE_MESSAGE,
	SECRETS_READ_FAILED_MESSAGE,
	ServerSyncEngine,
} from "../../../extension/servers/serverSync";
import { groupArgsFingerprint } from "../../../extension/servers/serverSync/engine";
import { groupClientId } from "../../../provider/catalog/groupModels";
import { SERVER_SYNC_FINGERPRINTS_KEY, SYNCED_ENTRY_BASE_URLS_KEY } from "../../../shared/config/storageKeys";
import { Logger } from "../../../shared/logger";
import { normalizeBaseUrl } from "../../../shared/util/baseUrl";
import { expectDefined } from "../../pureHelpers";
import { fakeFingerprintSaltSession, makeExtensionStorage } from "../../testUtils";
import { makeSyncEnv, recordedEvents } from "./serverSyncHelpers";

suite("extension/servers/serverSync: ServerSyncEngine", () => {
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

		test("a removal the identity ledger predates resolves its base URL from the host's own serving of the label, or not at all", async () => {
			// A fingerprint record from an older version, with no ledger entry to
			// resolve its host. The provider's observation of which base URLs the
			// host served the label's group at is the second source: exactly one
			// distinct URL is evidence, none or several leave the event untracked
			// (the env must not tombstone a guess).
			const cases: { observed: readonly string[]; expected: string | undefined }[] = [
				{ observed: [], expected: undefined },
				{ observed: ["http://ghost.test/"], expected: "http://ghost.test" },
				{ observed: ["http://ghost.test", "http://ghost.test/"], expected: "http://ghost.test" },
				{ observed: ["http://ghost.test", "http://other.test"], expected: undefined },
			];
			for (const { observed, expected } of cases) {
				const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://a.test" }]);
				recorded.fingerprints = { Ghost: "stale-record" };
				recorded.observedGroups = { Ghost: observed };
				const engine = new ServerSyncEngine(recorded.env);
				await engine.syncNow();

				assert.deepStrictEqual(
					recordedEvents(recorded),
					[{ kind: "removed", label: "Ghost", baseUrl: expected }],
					`observed ${JSON.stringify(observed)}`
				);
			}
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

		test("a blocked URL change with no prior ledger record never guesses: the ledger takes the host's serving, or nothing", async () => {
			// The URL changed before the first pass and the add was refused, so the
			// declared URL was never proven and must not enter the ledger. What may:
			// the OLD URL the host is serving the label's group at, which the live
			// group still holds. A later removal then resolves the group's identity
			// from that record, or degrades to the untracked notice when nothing was
			// observed. A fingerprint record is not required: the observed group is
			// itself the evidence a group exists for the label.
			const cases: { record: boolean; observed: readonly string[] }[] = [
				{ record: true, observed: [] },
				{ record: true, observed: ["http://old.test"] },
				{ record: false, observed: [] },
				{ record: false, observed: ["http://old.test"] },
			];
			for (const { record, observed } of cases) {
				const name = `record=${record} observed=${JSON.stringify(observed)}`;
				const recorded = makeSyncEnv([{ label: "Prod", baseUrl: "http://new.test" }]);
				if (record) {
					recorded.fingerprints = { Prod: "pre-ledger-record" };
				}
				recorded.duplicateLabels.add("Prod");
				recorded.observedGroups = { Prod: observed };
				const engine = new ServerSyncEngine(recorded.env);
				await engine.syncNow();
				assert.deepStrictEqual(
					recorded.entryBaseUrls,
					observed.length === 1 ? { Prod: "http://old.test" } : {},
					`${name}: the ledger records the served identity, never the unproven declared URL`
				);

				recorded.setting = [];
				await engine.syncNow();
				assert.deepStrictEqual(
					recordedEvents(recorded),
					record || observed.length === 1 ? [{ kind: "removed", label: "Prod", baseUrl: observed[0] }] : [],
					`${name}: a label with neither record nor observation raises nothing`
				);
			}
		});

		test("a group observed only after the blocked pass still enters the ledger on the next pass, so its removal is tracked", async () => {
			// The host's file is out of reach, so the served identity is the only
			// evidence, and at cold start the pass runs before the host has reported
			// the blocked entry's group: nothing is recorded. The wiring re-runs a
			// pass when the group enters the window; that pass records the served
			// identity, and the later removal names it.
			const recorded = makeSyncEnv([{ label: "Prod", baseUrl: "http://new.test" }]);
			recorded.duplicateLabels.add("Prod");
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();
			assert.deepStrictEqual(recorded.entryBaseUrls, {});

			recorded.observedGroups = { Prod: ["http://old.test"] };
			await engine.syncNow();
			assert.deepStrictEqual(recorded.entryBaseUrls, { Prod: "http://old.test" });

			recorded.setting = [];
			await engine.syncNow();
			assert.deepStrictEqual(recordedEvents(recorded), [
				{ kind: "removed", label: "Prod", baseUrl: "http://old.test" },
			]);
		});

		test("an untracked removal is carried until an observation names the group, then tombstones once", async () => {
			// Cold start: a pre-ledger fingerprint, no ledger, no observation. The
			// first pass reports the removal untracked, once, and KEEPS the fingerprint
			// record - the only durable evidence - so a session ending before the host
			// reports the group leaves the next session a candidate. When the host
			// later serves Ghost's labeled group (the wiring re-runs a pass on that),
			// the carried removal resolves to the observed identity and fires once
			// more, this time with the URL the tombstone needs, and the record goes;
			// later passes stay quiet. Declaring Ghost again meanwhile drops the carry
			// without an event.
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://a.test" }]);
			recorded.fingerprints = { Ghost: "pre-ledger-record" };
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();
			await engine.syncNow();
			assert.deepStrictEqual(recordedEvents(recorded), [{ kind: "removed", label: "Ghost", baseUrl: undefined }]);
			assert.deepStrictEqual(
				Object.keys(recorded.fingerprints).sort(),
				["A", "Ghost"],
				"the unresolved removal's record survives the pass-end write"
			);

			// The next session seeds from that store and detects the removal again
			// (untracked once more), then resolves it once the group is observed.
			const nextSession = new ServerSyncEngine(recorded.env);
			await nextSession.syncNow();
			recorded.observedGroups = { Ghost: ["http://ghost.test"] };
			await nextSession.syncNow();
			await nextSession.syncNow();
			assert.deepStrictEqual(recordedEvents(recorded), [
				{ kind: "removed", label: "Ghost", baseUrl: undefined },
				{ kind: "removed", label: "Ghost", baseUrl: undefined },
				{ kind: "removed", label: "Ghost", baseUrl: "http://ghost.test" },
			]);
			assert.deepStrictEqual(Object.keys(recorded.fingerprints), ["A"], "the resolved removal's record is pruned");
			// The aggregate log follows the emitted events, never the carried
			// candidate (the log buffer feeds issue reports).
			assert.strictEqual(
				recorded.logged.filter(([message]) => message.includes("provider groups remain")).length,
				3,
				"one log line per emitted removal event"
			);

			const redeclared = makeSyncEnv([{ label: "A", baseUrl: "http://a.test" }]);
			redeclared.fingerprints = { Ghost: "pre-ledger-record" };
			const engine2 = new ServerSyncEngine(redeclared.env);
			await engine2.syncNow();
			redeclared.setting = [
				{ label: "A", baseUrl: "http://a.test" },
				{ label: "Ghost", baseUrl: "http://ghost.test" },
			];
			redeclared.observedGroups = { Ghost: ["http://ghost.test"] };
			await engine2.syncNow();
			assert.deepStrictEqual(recordedEvents(redeclared), [{ kind: "removed", label: "Ghost", baseUrl: undefined }]);
		});

		test("a carried removal survives malformed-container passes and keeps its own detecting pass's rename delta", async () => {
			// Ghost (pre-ledger fingerprint) is removed before any observation. A
			// malformed container in between proves nothing and must not end the
			// carry; when the observation lands, the carry resolves to a tombstone.
			// An entry ADDED later at that URL is not the rename's other half - the
			// declaration delta that counts is the detecting pass's - while a real
			// rename (New declared in the same pass Old left) still reads as one
			// even though Old's observation came later.
			const recorded = makeSyncEnv([]);
			recorded.fingerprints = { Ghost: "pre-ledger-record" };
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();
			recorded.setting = null;
			await engine.syncNow();
			recorded.setting = [{ label: "Later", baseUrl: "http://ghost.test" }];
			recorded.observedGroups = { Ghost: ["http://ghost.test"] };
			await engine.syncNow();
			assert.deepStrictEqual(recordedEvents(recorded), [
				{ kind: "removed", label: "Ghost", baseUrl: undefined },
				{ kind: "removed", label: "Ghost", baseUrl: "http://ghost.test" },
			]);

			const renamed = makeSyncEnv([{ label: "New", baseUrl: "http://host.test" }]);
			renamed.fingerprints = { Old: "pre-ledger-record" };
			const engine2 = new ServerSyncEngine(renamed.env);
			await engine2.syncNow();
			renamed.observedGroups = { Old: ["http://host.test"] };
			await engine2.syncNow();
			assert.deepStrictEqual(recordedEvents(renamed), [
				{ kind: "removed", label: "Old", baseUrl: undefined },
				{ kind: "renamed", oldLabel: "Old", newLabel: "New", baseUrl: "http://host.test" },
			]);

			// The delta is the labels WITH the URLs they declared then: a new entry
			// re-pointed to the removed label's URL before the observation arrives
			// is not the rename's other half.
			const repointed = makeSyncEnv([{ label: "New", baseUrl: "http://elsewhere.test" }]);
			repointed.fingerprints = { Old: "pre-ledger-record" };
			const engine3 = new ServerSyncEngine(repointed.env);
			await engine3.syncNow();
			repointed.setting = [{ label: "New", baseUrl: "http://host.test" }];
			repointed.observedGroups = { Old: ["http://host.test"] };
			await engine3.syncNow();
			assert.deepStrictEqual(recordedEvents(repointed).at(-1), {
				kind: "removed",
				label: "Old",
				baseUrl: "http://host.test",
			});
		});

		test("a stale store read through a malformed-container pass cannot replay a settled removal, from either record kind", async () => {
			// A removal settles on the valid empty setting. A malformed container
			// next, with the store still returning the label's old record, must not
			// carry it back into the session maps, or the following valid pass would
			// remove the label again (undoing an Unhide and repeating the notice).
			// Both candidate sources - the ledger and the fingerprint map - are
			// covered, the latter through an untracked removal an observation
			// resolved.
			const ledgerOnly = makeSyncEnv([]);
			ledgerOnly.entryBaseUrls = { Ghost: "http://ghost.test" };
			const engine = new ServerSyncEngine(ledgerOnly.env);
			await engine.syncNow();
			assert.deepStrictEqual(recordedEvents(ledgerOnly), [
				{ kind: "removed", label: "Ghost", baseUrl: "http://ghost.test" },
			]);
			ledgerOnly.env.getEntryBaseUrls = () => ({ Ghost: "http://ghost.test" });
			ledgerOnly.setting = null;
			await engine.syncNow();
			ledgerOnly.setting = [];
			await engine.syncNow();
			assert.strictEqual(recordedEvents(ledgerOnly).length, 1, "the ledger-sourced removal does not replay");

			const fingerprintOnly = makeSyncEnv([]);
			fingerprintOnly.fingerprints = { Ghost: "pre-ledger-record" };
			const engine2 = new ServerSyncEngine(fingerprintOnly.env);
			await engine2.syncNow();
			fingerprintOnly.observedGroups = { Ghost: ["http://ghost.test"] };
			await engine2.syncNow();
			assert.strictEqual(recordedEvents(fingerprintOnly).length, 2, "untracked, then resolved");
			fingerprintOnly.env.getFingerprints = () => ({ Ghost: "pre-ledger-record" });
			fingerprintOnly.setting = null;
			await engine2.syncNow();
			fingerprintOnly.setting = [];
			await engine2.syncNow();
			assert.strictEqual(recordedEvents(fingerprintOnly).length, 2, "the fingerprint-sourced removal does not replay");
		});

		test("a removal beside a blocked twin the ledger already knows is a removal, not a rename", async () => {
			// Both entries were refused by the add-only host (no fingerprints) and
			// both labeled groups are observed, so both identities sit in the
			// session ledger. Removing Old must not read Twin - already known to the
			// ledger - as the rename's new half: that would leave Old's group
			// visible with rename provenance instead of hidden by a tombstone.
			const recorded = makeSyncEnv([
				{ label: "Old", baseUrl: "http://host.test" },
				{ label: "Twin", baseUrl: "http://host.test" },
			]);
			recorded.duplicateLabels.add("Old");
			recorded.duplicateLabels.add("Twin");
			recorded.observedGroups = { Old: ["http://host.test"], Twin: ["http://host.test"] };
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();
			assert.deepStrictEqual(recorded.entryBaseUrls, { Old: "http://host.test", Twin: "http://host.test" });

			recorded.setting = [{ label: "Twin", baseUrl: "http://host.test" }];
			await engine.syncNow();
			assert.deepStrictEqual(recordedEvents(recorded), [
				{ kind: "removed", label: "Old", baseUrl: "http://host.test" },
			]);
		});

		test("a ledger record from an earlier session detects a removal made while VS Code was closed, once", async () => {
			// The stored ledger names Ghost (proven or observed last session) and no
			// fingerprint exists (its add never landed). The first pass raises the
			// removal; a stale store read that re-surfaces Ghost afterwards must not
			// raise it again - detection keys on the session ledger.
			const recorded = makeSyncEnv([{ label: "A", baseUrl: "http://a.test" }]);
			recorded.entryBaseUrls = { Ghost: "http://ghost.test" };
			const engine = new ServerSyncEngine(recorded.env);
			await engine.syncNow();
			assert.deepStrictEqual(recordedEvents(recorded), [
				{ kind: "removed", label: "Ghost", baseUrl: "http://ghost.test" },
			]);
			assert.deepStrictEqual(recorded.entryBaseUrls, { A: "http://a.test" }, "the removed label leaves the ledger");

			recorded.env.getEntryBaseUrls = () => ({ A: "http://a.test", Ghost: "http://ghost.test" });
			await engine.syncNow();
			await engine.syncNow();
			assert.strictEqual(recordedEvents(recorded).length, 1, "a stale store cannot re-raise the removal");
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
				new GroupRemovalStore(storage.memento),
				() => []
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
			new GroupRemovalStore(storage.memento),
			() => []
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
