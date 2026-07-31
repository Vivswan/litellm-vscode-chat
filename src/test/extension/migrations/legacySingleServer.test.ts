import * as assert from "node:assert";
import type * as vscode from "vscode";
import type { MigrationContext } from "../../../extension/migrations";
import { hasLegacyConfig, legacySingleServerMigration } from "../../../extension/migrations/legacySingleServer";
import { ServerRegistry } from "../../../extension/servers/serverRegistry";
import {
	apiKeySecret,
	LEGACY_API_KEY_SECRET,
	LEGACY_BASE_URL_SECRET,
	LEGACY_CLEANUP_PENDING_KEY,
	SERVER_REGISTRY_KEY,
} from "../../../shared/config/storageKeys";
import { Logger } from "../../../shared/logger";
import type { FakeExtensionStorage } from "../../testUtils";
import { expectDefined, makeExtensionStorage } from "../../testUtils";

function makeContext(storage: FakeExtensionStorage = makeExtensionStorage()): {
	ctx: MigrationContext;
	storage: FakeExtensionStorage;
} {
	const logger = new Logger({ info: () => {}, error: () => {} });
	return {
		ctx: {
			globalState: storage.memento,
			secrets: storage.secrets,
			registry: new ServerRegistry(storage.memento, storage.secrets),
			logger,
		},
		storage,
	};
}

suite("extension/migrations/legacySingleServer", () => {
	test("migrates legacy secrets into a Default server and deletes them", async () => {
		const { ctx, storage } = makeContext();
		storage.secretStore.set(LEGACY_BASE_URL_SECRET, "http://legacy:4000");
		storage.secretStore.set(LEGACY_API_KEY_SECRET, "legacy-key");

		const outcome = await legacySingleServerMigration.run(ctx);

		assert.strictEqual(outcome, "migrated");
		const servers = ctx.registry.getServers();
		assert.strictEqual(servers.length, 1);
		const server = expectDefined(servers[0]);
		assert.strictEqual(server.label, "Default");
		assert.strictEqual(server.baseUrl, "http://legacy:4000");
		assert.strictEqual(storage.secretStore.get(apiKeySecret(server.id)), "legacy-key");
		assert.strictEqual(storage.secretStore.has(LEGACY_BASE_URL_SECRET), false);
		assert.strictEqual(storage.secretStore.has(LEGACY_API_KEY_SECRET), false);
	});

	test("is a no-op when the registry already has a server", async () => {
		const { ctx, storage } = makeContext();
		await ctx.registry.addServer("Existing", "http://existing:4000", "existing-key");
		storage.secretStore.set(LEGACY_BASE_URL_SECRET, "http://legacy:4000");
		storage.secretStore.set(LEGACY_API_KEY_SECRET, "legacy-key");

		const outcome = await legacySingleServerMigration.run(ctx);

		assert.strictEqual(outcome, "nothing-to-do");
		assert.strictEqual(ctx.registry.getServers().length, 1);
		assert.strictEqual(expectDefined(ctx.registry.getServers()[0]).label, "Existing");
		assert.strictEqual(storage.secretStore.get(LEGACY_BASE_URL_SECRET), "http://legacy:4000");
		assert.strictEqual(storage.secretStore.get(LEGACY_API_KEY_SECRET), "legacy-key");
	});

	test("is a no-op when no legacy baseUrl secret exists", async () => {
		const { ctx, storage } = makeContext();
		storage.secretStore.set(LEGACY_API_KEY_SECRET, "orphan-key");

		const outcome = await legacySingleServerMigration.run(ctx);

		assert.strictEqual(outcome, "nothing-to-do");
		assert.strictEqual(ctx.registry.getServers().length, 0);
		assert.strictEqual(storage.secretStore.get(LEGACY_API_KEY_SECRET), "orphan-key");
	});

	test("a second run after a successful migration is a no-op", async () => {
		const { ctx, storage } = makeContext();
		storage.secretStore.set(LEGACY_BASE_URL_SECRET, "http://legacy:4000");
		storage.secretStore.set(LEGACY_API_KEY_SECRET, "legacy-key");

		assert.strictEqual(await legacySingleServerMigration.run(ctx), "migrated");
		assert.strictEqual(await legacySingleServerMigration.run(ctx), "nothing-to-do");

		assert.strictEqual(ctx.registry.getServers().length, 1, "the second run must not duplicate the server");
	});

	test("addServer failure leaves the legacy secrets in place for a retry", async () => {
		const { storage } = makeContext();
		storage.secretStore.set(LEGACY_BASE_URL_SECRET, "http://legacy:4000");
		storage.secretStore.set(LEGACY_API_KEY_SECRET, "legacy-key");
		const failingSecrets = {
			get: async (key: string) => storage.secretStore.get(key),
			store: async () => {
				throw new Error("secret store failed");
			},
			delete: async (key: string) => {
				storage.secretStore.delete(key);
			},
			onDidChange: (_listener: unknown) => ({ dispose() {} }),
		} as unknown as vscode.SecretStorage;
		const failingCtx: MigrationContext = {
			globalState: storage.memento,
			secrets: failingSecrets,
			registry: new ServerRegistry(storage.memento, failingSecrets),
			logger: new Logger({ info: () => {}, error: () => {} }),
		};

		await assert.rejects(legacySingleServerMigration.run(failingCtx), /secret store failed/);

		assert.strictEqual(failingCtx.registry.getServers().length, 0, "No half-migrated registry entry may remain");
		assert.strictEqual(storage.secretStore.get(LEGACY_BASE_URL_SECRET), "http://legacy:4000");
		assert.strictEqual(storage.secretStore.get(LEGACY_API_KEY_SECRET), "legacy-key");

		const { ctx: retryCtx } = makeContext(storage);
		assert.strictEqual(
			await legacySingleServerMigration.run(retryCtx),
			"migrated",
			"Migration must succeed on retry once secret storage works"
		);
	});

	suite("partial-success recovery", () => {
		/** Makes secrets.delete fail for one key until healed; everything else passes through. */
		function breakDeletion(storage: FakeExtensionStorage, key: string): { heal: () => void } {
			const originalDelete = storage.secrets.delete.bind(storage.secrets);
			let broken = true;
			storage.secrets.delete = async (candidate: string) => {
				if (candidate === key && broken) {
					throw new Error("keychain unavailable");
				}
				await originalDelete(candidate);
			};
			return {
				heal: () => {
					broken = false;
				},
			};
		}

		function seedLegacySecrets(storage: FakeExtensionStorage): void {
			storage.secretStore.set(LEGACY_BASE_URL_SECRET, "http://legacy:4000");
			storage.secretStore.set(LEGACY_API_KEY_SECRET, "legacy-key");
		}

		test("a failed api-key deletion is retried on the next run without duplicating the server", async () => {
			const { ctx, storage } = makeContext();
			seedLegacySecrets(storage);
			const breaker = breakDeletion(storage, LEGACY_API_KEY_SECRET);

			await assert.rejects(legacySingleServerMigration.run(ctx), /keychain unavailable/);

			assert.strictEqual(ctx.registry.getServers().length, 1, "the migrated entry persisted before the failure");
			assert.strictEqual(storage.mementoStore.get(LEGACY_CLEANUP_PENDING_KEY), true);
			assert.strictEqual(storage.secretStore.get(LEGACY_BASE_URL_SECRET), "http://legacy:4000");

			breaker.heal();
			const { ctx: retryCtx } = makeContext(storage);
			assert.strictEqual(await legacySingleServerMigration.run(retryCtx), "migrated");

			assert.strictEqual(retryCtx.registry.getServers().length, 1, "the retry must not import a second server");
			assert.strictEqual(storage.secretStore.has(LEGACY_BASE_URL_SECRET), false);
			assert.strictEqual(storage.secretStore.has(LEGACY_API_KEY_SECRET), false);
			assert.strictEqual(storage.mementoStore.get(LEGACY_CLEANUP_PENDING_KEY), undefined);
		});

		test("a failed base-URL deletion is retried on the next run", async () => {
			const { ctx, storage } = makeContext();
			seedLegacySecrets(storage);
			const breaker = breakDeletion(storage, LEGACY_BASE_URL_SECRET);

			await assert.rejects(legacySingleServerMigration.run(ctx), /keychain unavailable/);

			assert.strictEqual(storage.secretStore.has(LEGACY_API_KEY_SECRET), false, "the api-key secret deleted first");
			assert.strictEqual(storage.mementoStore.get(LEGACY_CLEANUP_PENDING_KEY), true);

			breaker.heal();
			const { ctx: retryCtx } = makeContext(storage);
			assert.strictEqual(await legacySingleServerMigration.run(retryCtx), "migrated");

			assert.strictEqual(retryCtx.registry.getServers().length, 1);
			assert.strictEqual(storage.secretStore.has(LEGACY_BASE_URL_SECRET), false);
			assert.strictEqual(storage.mementoStore.get(LEGACY_CLEANUP_PENDING_KEY), undefined);
		});

		test("pending cleanup never re-imports after the group migration empties the registry", async () => {
			const { ctx, storage } = makeContext();
			seedLegacySecrets(storage);
			const breaker = breakDeletion(storage, LEGACY_BASE_URL_SECRET);
			await assert.rejects(legacySingleServerMigration.run(ctx), /keychain unavailable/);

			// The group migration moves the entry to a provider group and
			// empties the registry while the legacy secret still lingers.
			const server = expectDefined(ctx.registry.getServers()[0]);
			await ctx.registry.removeServer(server.id);
			breaker.heal();

			const { ctx: retryCtx } = makeContext(storage);
			assert.strictEqual(await legacySingleServerMigration.run(retryCtx), "migrated");

			assert.deepStrictEqual(retryCtx.registry.getServers(), [], "stale legacy config must not be re-imported");
			assert.strictEqual(storage.secretStore.has(LEGACY_BASE_URL_SECRET), false);
			assert.strictEqual(storage.mementoStore.get(LEGACY_CLEANUP_PENDING_KEY), undefined);
		});

		test("recovery after a failed marker write survives a rename of the imported server", async () => {
			// Detection is by base URL, never by label: the user may rename the
			// imported entry before the retry runs, and a label-keyed match
			// would re-import stale config on a later empty registry.
			const { storage } = makeContext();
			seedLegacySecrets(storage);
			const originalUpdate = storage.memento.update.bind(storage.memento);
			let broken = true;
			(storage.memento as { update(key: string, value: unknown): Thenable<void> }).update = async (key, value) => {
				if (key === LEGACY_CLEANUP_PENDING_KEY && broken) {
					throw new Error("memento write failed");
				}
				await originalUpdate(key, value);
			};
			const { ctx } = makeContext(storage);
			await assert.rejects(legacySingleServerMigration.run(ctx), /memento write failed/);
			broken = false;

			const imported = expectDefined(ctx.registry.getServers()[0]);
			await ctx.registry.updateServer(imported.id, "My proxy", "http://legacy:4000", undefined);

			const { ctx: retryCtx } = makeContext(storage);
			assert.strictEqual(await legacySingleServerMigration.run(retryCtx), "migrated");

			const servers = retryCtx.registry.getServers();
			assert.strictEqual(servers.length, 1, "the retry must not import a second server");
			assert.strictEqual(expectDefined(servers[0]).label, "My proxy", "the rename must survive the retry");
			assert.strictEqual(storage.secretStore.has(LEGACY_BASE_URL_SECRET), false);
			assert.strictEqual(storage.secretStore.has(LEGACY_API_KEY_SECRET), false);
		});

		test("a loser of the last-write-wins import race deletes its own orphaned secret", async () => {
			// The true residual: both windows pass the pre-write re-read and
			// both persist same-version registries. The overwrite is invisible
			// to the loser's own registry instance, so the loser must check
			// the persisted blob after its write and clean up its unreferenced
			// per-server secret.
			const shared = makeContext().storage;
			seedLegacySecrets(shared);

			// Window B holds a stale registry view (its Memento never sees A's
			// write), so it re-imports and overwrites A's same-version blob.
			const staleMemento = {
				get: (key: string, defaultValue?: unknown) =>
					key === SERVER_REGISTRY_KEY ? undefined : shared.memento.get(key, defaultValue),
				update: (key: string, value: unknown) => shared.memento.update(key, value),
			} as unknown as vscode.Memento;
			const bCtx: MigrationContext = {
				globalState: staleMemento,
				secrets: shared.secrets,
				registry: new ServerRegistry(staleMemento, shared.secrets),
				logger: new Logger({ info: () => {}, error: () => {} }),
			};

			// Window A's registry persist triggers B's whole run before A's
			// post-write check, so A observes the overwrite and loses.
			const originalUpdate = shared.memento.update.bind(shared.memento);
			let bRan = false;
			(shared.memento as { update(key: string, value: unknown): Thenable<void> }).update = async (key, value) => {
				await originalUpdate(key, value);
				if (key === SERVER_REGISTRY_KEY && !bRan) {
					bRan = true;
					assert.strictEqual(await legacySingleServerMigration.run(bCtx), "migrated");
				}
			};
			const { ctx: aCtx } = makeContext(shared);

			assert.strictEqual(await legacySingleServerMigration.run(aCtx), "migrated");
			assert.strictEqual(bRan, true, "the interleaving must really have happened");

			const persisted = new ServerRegistry(shared.memento, shared.secrets).getServers();
			assert.strictEqual(persisted.length, 1, "last-write-wins must leave exactly one entry");
			const winner = expectDefined(persisted[0]);
			assert.strictEqual(winner.baseUrl, "http://legacy:4000");
			const apiKeySecrets = [...shared.secretStore.keys()].filter((key) => key.startsWith("litellm.apiKey."));
			assert.deepStrictEqual(
				apiKeySecrets,
				[apiKeySecret(winner.id)],
				"the loser must delete its own orphaned secret; only the winner's remains"
			);
			assert.strictEqual(shared.secretStore.has(LEGACY_BASE_URL_SECRET), false);
			assert.strictEqual(shared.mementoStore.get(LEGACY_CLEANUP_PENDING_KEY), undefined);
		});

		test("two windows racing the import leave one entry and no orphaned secret", async () => {
			const shared = makeContext().storage;
			seedLegacySecrets(shared);

			// Window B reads the legacy base URL, then window A runs its whole
			// migration before B continues; B's later registry reads adopt A's
			// strictly newer persisted registry and must not import again.
			const { ctx: aCtx } = makeContext(shared);
			const bSecrets = {
				get: async (key: string) => {
					if (key === LEGACY_BASE_URL_SECRET) {
						const value = shared.secretStore.get(key) ?? "http://legacy:4000";
						await legacySingleServerMigration.run(aCtx);
						return value;
					}
					return shared.secretStore.get(key);
				},
				store: async (key: string, value: string) => {
					shared.secretStore.set(key, value);
				},
				delete: async (key: string) => {
					shared.secretStore.delete(key);
				},
				onDidChange: (_listener: unknown) => ({ dispose() {} }),
			} as unknown as vscode.SecretStorage;
			const bCtx: MigrationContext = {
				globalState: shared.memento,
				secrets: bSecrets,
				registry: new ServerRegistry(shared.memento, bSecrets),
				logger: new Logger({ info: () => {}, error: () => {} }),
			};

			assert.strictEqual(await legacySingleServerMigration.run(bCtx), "migrated");

			const servers = bCtx.registry.getServers();
			assert.strictEqual(servers.length, 1, "exactly one entry may survive the race");
			const survivor = expectDefined(servers[0]);
			assert.strictEqual(survivor.baseUrl, "http://legacy:4000");
			const apiKeySecrets = [...shared.secretStore.keys()].filter((key) => key.startsWith("litellm.apiKey."));
			assert.deepStrictEqual(apiKeySecrets, [apiKeySecret(survivor.id)], "no orphaned per-server secret may remain");
			assert.strictEqual(shared.secretStore.has(LEGACY_BASE_URL_SECRET), false);
			assert.strictEqual(shared.secretStore.has(LEGACY_API_KEY_SECRET), false);
		});

		test("a failed marker write is recovered by matching the already-migrated entry", async () => {
			const { storage } = makeContext();
			seedLegacySecrets(storage);
			const originalUpdate = storage.memento.update.bind(storage.memento);
			let broken = true;
			(storage.memento as { update(key: string, value: unknown): Thenable<void> }).update = async (key, value) => {
				if (key === LEGACY_CLEANUP_PENDING_KEY && broken) {
					throw new Error("memento write failed");
				}
				await originalUpdate(key, value);
			};
			const { ctx } = makeContext(storage);

			await assert.rejects(legacySingleServerMigration.run(ctx), /memento write failed/);
			assert.strictEqual(ctx.registry.getServers().length, 1);
			assert.strictEqual(storage.secretStore.get(LEGACY_BASE_URL_SECRET), "http://legacy:4000");

			broken = false;
			const { ctx: retryCtx } = makeContext(storage);
			assert.strictEqual(await legacySingleServerMigration.run(retryCtx), "migrated");

			assert.strictEqual(retryCtx.registry.getServers().length, 1, "the retry must not import a second server");
			assert.strictEqual(storage.secretStore.has(LEGACY_BASE_URL_SECRET), false);
			assert.strictEqual(storage.secretStore.has(LEGACY_API_KEY_SECRET), false);
		});
	});

	suite("hasLegacyConfig", () => {
		test("is true only while the legacy baseUrl secret is stored", async () => {
			const storage = makeExtensionStorage();
			assert.strictEqual(await hasLegacyConfig(storage.secrets), false);

			storage.secretStore.set(LEGACY_BASE_URL_SECRET, "http://legacy:4000");
			assert.strictEqual(await hasLegacyConfig(storage.secrets), true);

			storage.secretStore.delete(LEGACY_BASE_URL_SECRET);
			storage.secretStore.set(LEGACY_API_KEY_SECRET, "orphan-key");
			assert.strictEqual(await hasLegacyConfig(storage.secrets), false, "an orphaned key alone is not legacy config");
		});
	});
});
