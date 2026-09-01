import * as assert from "node:assert";
import { projectSyncFingerprintsFor } from "../../../extension/migrations/fingerprintProjection";
import { buildGroupArgs, groupArgsFingerprint } from "../../../extension/servers/serverSync/engine";
import type { SecretStore, StoredServerSecrets } from "../../../extension/servers/serverSync/secrets";
import { readServerSecretsRecord, updateServerSecret } from "../../../extension/servers/serverSync/secrets";
import { parseServersSetting } from "../../../extension/servers/serverSync/setting";
import { SERVER_SYNC_FINGERPRINTS_KEY, SYNCED_ENTRY_BASE_URLS_KEY } from "../../../shared/config/storageKeys";
import { Logger } from "../../../shared/logger";
import { fingerprint } from "../../../shared/util/fingerprint";

function makeSecretStore(): SecretStore & { failReads: boolean } {
	const values = new Map<string, string>();
	const store = {
		failReads: false,
		get: async (key: string) => {
			if (store.failReads) {
				throw new Error("secret storage unavailable");
			}
			return values.get(key);
		},
		store: async (key: string, value: string) => {
			values.set(key, value);
		},
		delete: async (key: string) => {
			values.delete(key);
		},
	};
	return store;
}

function makeMemento(initial: Record<string, unknown> = {}) {
	const map = new Map<string, unknown>(Object.entries(initial));
	return {
		writes: 0,
		get(key: string): unknown {
			return map.get(key);
		},
		async update(key: string, value: unknown): Promise<void> {
			this.writes += 1;
			map.set(key, value);
		},
	};
}

const quietLogger = () => new Logger({ info: () => {}, error: () => {} });

/** The legacy rendering exactly as the pre-projection engine persisted it. */
function legacyPrint(setting: unknown, label: string, stored: StoredServerSecrets = {}): string {
	const entry = parseServersSetting(setting).entries.find((candidate) => candidate.label === label);
	assert.ok(entry, `entry ${label} must parse`);
	return fingerprint(JSON.stringify(buildGroupArgs(entry, stored)));
}

/** The identity rendering the engine compares against today. */
function identityPrint(setting: unknown, label: string, stored: StoredServerSecrets = {}): string {
	const entry = parseServersSetting(setting).entries.find((candidate) => candidate.label === label);
	assert.ok(entry, `entry ${label} must parse`);
	return groupArgsFingerprint(buildGroupArgs(entry, stored));
}

suite("extension/migrations/fingerprintProjection", () => {
	const durable = async () => true;

	test("rewrites a legacy record matching the entry's current rendering, then no-ops", async () => {
		const setting = [{ label: "A", baseUrl: "http://a.test", auth: { apiKey: "sk-a" } }];
		const memento = makeMemento({
			[SERVER_SYNC_FINGERPRINTS_KEY]: { A: legacyPrint(setting, "A") },
		});
		const secrets = makeSecretStore();
		const readSecrets = (label: string) => readServerSecretsRecord(secrets, label);

		assert.strictEqual(
			await projectSyncFingerprintsFor(() => setting, readSecrets, memento, durable, quietLogger()),
			"migrated"
		);
		assert.deepStrictEqual(memento.get(SERVER_SYNC_FINGERPRINTS_KEY), { A: identityPrint(setting, "A") });

		assert.strictEqual(
			await projectSyncFingerprintsFor(() => setting, readSecrets, memento, durable, quietLogger()),
			"nothing-to-do"
		);
		assert.strictEqual(memento.writes, 1);
	});

	test("resolves stored secrets exactly as the old engine did (the legacy print covers them)", async () => {
		const setting = [{ label: "A", baseUrl: "http://a.test" }];
		const secrets = makeSecretStore();
		await updateServerSecret(secrets, "A", "apiKey", "sk-stored", "http://a.test");
		const readSecrets = (label: string) => readServerSecretsRecord(secrets, label);
		const memento = makeMemento({
			[SERVER_SYNC_FINGERPRINTS_KEY]: { A: legacyPrint(setting, "A", { apiKey: "sk-stored" }) },
		});

		assert.strictEqual(
			await projectSyncFingerprintsFor(() => setting, readSecrets, memento, durable, quietLogger()),
			"migrated"
		);
		assert.deepStrictEqual(memento.get(SERVER_SYNC_FINGERPRINTS_KEY), {
			A: identityPrint(setting, "A", { apiKey: "sk-stored" }),
		});
	});

	test("leaves foreign records, undeclared labels, and already-projected records untouched", async () => {
		const setting = [
			{ label: "A", baseUrl: "http://a.test", auth: { apiKey: "sk-now" } },
			{ label: "B", baseUrl: "http://b.test" },
		];
		// A's record was written for a DIFFERENT configuration (an old inline
		// key), the ledger names ANOTHER host for it (so no identity proof), and
		// the record must stay for the engine's own blocked classification. B is
		// already projected. "Gone" has no entry.
		const foreign = legacyPrint([{ label: "A", baseUrl: "http://a.test", auth: { apiKey: "sk-old" } }], "A");
		const stored = {
			A: foreign,
			B: identityPrint(setting, "B"),
			Gone: "0123456789abcdef0123456789abcdef",
		};
		const memento = makeMemento({
			[SERVER_SYNC_FINGERPRINTS_KEY]: stored,
			[SYNCED_ENTRY_BASE_URLS_KEY]: { A: "http://elsewhere.test" },
		});
		const secrets = makeSecretStore();

		assert.strictEqual(
			await projectSyncFingerprintsFor(
				() => setting,
				(label) => readServerSecretsRecord(secrets, label),
				memento,
				durable,
				quietLogger()
			),
			"nothing-to-do"
		);
		assert.deepStrictEqual(memento.get(SERVER_SYNC_FINGERPRINTS_KEY), stored);
		assert.strictEqual(memento.writes, 0);
	});

	test("the #277 state heals: a pre-upgrade rotation rewrites via the ledger's identity proof", async () => {
		// The v0.6 record was computed with the OLD key, the user rotated the
		// stored secret before upgrading, and the legacy rendering can never be
		// recomputed - but the ledger proves the live group holds this label at
		// this host, which is the whole identity the new print covers.
		const setting = [{ label: "A", baseUrl: "http://a.test/" }];
		const secrets = makeSecretStore();
		await updateServerSecret(secrets, "A", "apiKey", "sk-rotated-new", "http://a.test");
		const staleRecord = legacyPrint(setting, "A", { apiKey: "sk-before-rotation" });
		const memento = makeMemento({
			[SERVER_SYNC_FINGERPRINTS_KEY]: { A: staleRecord },
			[SYNCED_ENTRY_BASE_URLS_KEY]: { A: "http://a.test" },
		});

		assert.strictEqual(
			await projectSyncFingerprintsFor(
				() => setting,
				(label) => readServerSecretsRecord(secrets, label),
				memento,
				durable,
				quietLogger()
			),
			"migrated"
		);
		assert.deepStrictEqual(memento.get(SERVER_SYNC_FINGERPRINTS_KEY), {
			A: identityPrint(setting, "A", { apiKey: "sk-rotated-new" }),
		});
	});

	test("the write merges over a fresh read: another window's record written mid-pass survives", async () => {
		const setting = [{ label: "A", baseUrl: "http://a.test", auth: { apiKey: "sk-a" } }];
		const memento = makeMemento({
			[SERVER_SYNC_FINGERPRINTS_KEY]: { A: legacyPrint(setting, "A") },
		});
		// The second read of the fingerprints key (the merge base at write time)
		// sees a record another window's engine persisted while this pass ran; a
		// whole-key write of the pass-start snapshot would destroy it (#220's
		// failure class).
		let fingerprintReads = 0;
		const originalGet = memento.get.bind(memento);
		memento.get = (key: string) => {
			const value = originalGet(key);
			if (key === SERVER_SYNC_FINGERPRINTS_KEY) {
				fingerprintReads += 1;
				if (fingerprintReads === 2) {
					return { ...(value as Record<string, string>), OtherWindow: "i1:written-by-another-window" };
				}
			}
			return value;
		};
		const secrets = makeSecretStore();

		assert.strictEqual(
			await projectSyncFingerprintsFor(
				() => setting,
				(label) => readServerSecretsRecord(secrets, label),
				memento,
				durable,
				quietLogger()
			),
			"migrated"
		);
		assert.deepStrictEqual(memento.get(SERVER_SYNC_FINGERPRINTS_KEY), {
			A: identityPrint(setting, "A"),
			OtherWindow: "i1:written-by-another-window",
		});
	});

	test("a candidate label another window re-synced mid-pass keeps that window's newer record", async () => {
		const setting = [{ label: "A", baseUrl: "http://a.test", auth: { apiKey: "sk-a" } }];
		const memento = makeMemento({
			[SERVER_SYNC_FINGERPRINTS_KEY]: { A: legacyPrint(setting, "A") },
		});
		// The merge base (the second read) shows A already re-synced by another
		// window - its record must win over this pass's now-stale projection.
		let fingerprintReads = 0;
		const originalGet = memento.get.bind(memento);
		memento.get = (key: string) => {
			const value = originalGet(key);
			if (key === SERVER_SYNC_FINGERPRINTS_KEY) {
				fingerprintReads += 1;
				if (fingerprintReads === 2) {
					return { A: "i1:resynced-by-another-window" };
				}
			}
			return value;
		};
		const secrets = makeSecretStore();

		assert.strictEqual(
			await projectSyncFingerprintsFor(
				() => setting,
				(label) => readServerSecretsRecord(secrets, label),
				memento,
				durable,
				quietLogger()
			),
			"nothing-to-do"
		);
		assert.strictEqual(memento.writes, 0, "a fully superseded rewrite set writes nothing");
	});

	test("defers without writing when the salt is not durable", async () => {
		const setting = [{ label: "A", baseUrl: "http://a.test", auth: { apiKey: "sk-a" } }];
		const memento = makeMemento({ [SERVER_SYNC_FINGERPRINTS_KEY]: { A: legacyPrint(setting, "A") } });
		const secrets = makeSecretStore();

		assert.strictEqual(
			await projectSyncFingerprintsFor(
				() => setting,
				(label) => readServerSecretsRecord(secrets, label),
				memento,
				async () => false,
				quietLogger()
			),
			"in-progress"
		);
		assert.strictEqual(memento.writes, 0);
	});

	test("an unreadable blob defers that entry and reports in-progress; the rest still project", async () => {
		const setting = [{ label: "A", baseUrl: "http://a.test", auth: { apiKey: "sk-a" } }];
		const memento = makeMemento({ [SERVER_SYNC_FINGERPRINTS_KEY]: { A: legacyPrint(setting, "A") } });
		const secrets = makeSecretStore();
		secrets.failReads = true;

		assert.strictEqual(
			await projectSyncFingerprintsFor(
				() => setting,
				(label) => readServerSecretsRecord(secrets, label),
				memento,
				durable,
				quietLogger()
			),
			"in-progress"
		);
		assert.deepStrictEqual(memento.get(SERVER_SYNC_FINGERPRINTS_KEY), { A: legacyPrint(setting, "A") });
	});

	test("an ownership-refused secret leaves its record for the engine's own classification", async () => {
		// The stored key is stamped for another host, so the entry's legacy
		// rendering cannot be recomputed; the record waits for re-pairing.
		const setting = [{ label: "A", baseUrl: "http://a.test" }];
		const secrets = makeSecretStore();
		await updateServerSecret(secrets, "A", "apiKey", "sk-elsewhere", "http://other.test");
		const stored = { A: legacyPrint(setting, "A", { apiKey: "sk-elsewhere" }) };
		const memento = makeMemento({ [SERVER_SYNC_FINGERPRINTS_KEY]: stored });

		assert.strictEqual(
			await projectSyncFingerprintsFor(
				() => setting,
				(label) => readServerSecretsRecord(secrets, label),
				memento,
				durable,
				quietLogger()
			),
			"nothing-to-do"
		);
		assert.deepStrictEqual(memento.get(SERVER_SYNC_FINGERPRINTS_KEY), stored);
	});
});
