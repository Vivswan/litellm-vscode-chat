import * as assert from "node:assert";
import type { SecretStore, ServerSyncEnv, StoredServerSecrets } from "../../extension/serverSync";
import {
	buildGroupArgs,
	copyServerSecrets,
	deleteServerSecrets,
	GROUP_UPDATE_UNAVAILABLE_MESSAGE,
	GROUP_UPSERT_FAILED_MESSAGE,
	parseServersSetting,
	readServerSecrets,
	SECRETS_READ_FAILED_MESSAGE,
	ServerSyncEngine,
	updateServerSecret,
} from "../../extension/serverSync";
import { groupClientId } from "../../provider/groupModels";
import { serverSecretsKey } from "../../shared/storageKeys";

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
	removedNotices: string[][];
	logged: [string, unknown][];
	loggedErrors: [string, unknown][];
	env: ServerSyncEnv;
	setting: unknown;
	secrets: Record<string, StoredServerSecrets>;
	/** When set, addProviderGroup rejects for these labels. */
	failLabels: Set<string>;
	/** When set, addProviderGroup rejects these labels the way an add-only host refuses an existing name. */
	duplicateLabels: Set<string>;
}

function makeSyncEnv(setting: unknown = [], secrets: Record<string, StoredServerSecrets> = {}): Recorded {
	const recorded: Recorded = {
		upserts: [],
		fingerprints: {},
		removedNotices: [],
		logged: [],
		loggedErrors: [],
		setting,
		secrets,
		failLabels: new Set(),
		duplicateLabels: new Set(),
		env: {
			readServersSetting: () => recorded.setting,
			readSecrets: async (label) => recorded.secrets[label] ?? {},
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
				recorded.fingerprints = { ...map };
			},
			notifyRemoved: (labels) => {
				recorded.removedNotices.push([...labels]);
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

suite("extension/serverSync", () => {
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
				apiKey: "sk-inline",
				oauthTokenUrl: "https://idp.test/token",
				virtualKeyValue: "vk-stored",
			});
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

			recorded.setting = [{ label: "A", baseUrl: "http://a.test" }];
			await engine.syncNow();

			assert.deepStrictEqual(recorded.removedNotices, [["B"]]);
			assert.deepStrictEqual(Object.keys(recorded.fingerprints), ["A"]);

			await engine.syncNow();
			assert.strictEqual(recorded.removedNotices.length, 1, "no repeat notification");
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

			recorded.failLabels.clear();
			await engine.syncNow();
			assert.strictEqual(recorded.upserts.length, 1, "the retry lands");
			assert.strictEqual(engine.getDeclared()[0]?.syncError, undefined, "the error clears on success");
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
				groupClientId({ baseUrl: "http://x.test", apiKey: "sk-a" }),
				"the same identity the provider stamps on its status snapshots"
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
					baseUrl: "http://oauth.test",
					apiKey: "",
					oauth: { tokenUrl: "https://idp.test/token", clientId: "client", clientSecret: "cs-1", scopes: "read write" },
				}),
				"the OAuth block, secure-side client secret included, fingerprints like the provider's"
			);
			assert.strictEqual(
				virtualKey?.expectedClientId,
				groupClientId({
					baseUrl: "http://vk.test",
					apiKey: "",
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
});
