import * as assert from "node:assert";
import type { SecretStore, ServerSyncEnv, StoredServerSecrets } from "../../extension/serverSync";
import {
	buildGroupArgs,
	copyServerSecrets,
	deleteServerSecrets,
	GROUP_UPSERT_FAILED_MESSAGE,
	parseServersSetting,
	readServerSecrets,
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
		env: {
			readServersSetting: () => recorded.setting,
			readSecrets: async (label) => recorded.secrets[label] ?? {},
			addProviderGroup: async (args) => {
				if (recorded.failLabels.has(args.name ?? "")) {
					throw new Error("host refused the group");
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
