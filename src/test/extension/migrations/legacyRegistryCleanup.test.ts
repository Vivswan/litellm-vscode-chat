import * as assert from "node:assert";
import { legacyRegistryCleanupMigration } from "../../../extension/migrations/legacyRegistryCleanup";
import {
	apiKeySecret,
	GROUP_MIGRATION_COMPLETE_KEY,
	LEGACY_API_KEY_SECRET,
	LEGACY_BASE_URL_SECRET,
	LEGACY_CLEANUP_PENDING_KEY,
	MIGRATED_ENTRY_PARAMETER_COPIES_KEY,
	MIGRATED_SERVER_IDS_KEY,
	MIGRATED_SERVER_LABELS_KEY,
	PENDING_GROUP_SUBMISSION_KEY,
	PENDING_SECRET_DELETIONS_KEY,
	SEEDED_PROVIDER_GROUPS_KEY,
	SERVER_REGISTRY_KEY,
	SKIPPED_MIGRATION_SERVERS_KEY,
} from "../../../shared/config/storageKeys";
import { makeExtensionStorage, makeMigrationContext } from "../../testUtils";

suite("extension/migrations/legacyRegistryCleanup", () => {
	test("deletes every legacy key and every per-server secret the blobs reference", async () => {
		const storage = makeExtensionStorage({
			[SERVER_REGISTRY_KEY]: {
				version: 3,
				servers: [{ id: "srv1", label: "Prod", baseUrl: "http://prod.test" }],
			},
			[GROUP_MIGRATION_COMPLETE_KEY]: true,
			[SEEDED_PROVIDER_GROUPS_KEY]: [{ id: "srv2", name: "Staging", label: "Staging", baseUrl: "http://s.test" }],
			[SKIPPED_MIGRATION_SERVERS_KEY]: ["srv3"],
			[PENDING_GROUP_SUBMISSION_KEY]: { id: "srv4", name: "X", baseUrl: "http://x.test" },
			[PENDING_SECRET_DELETIONS_KEY]: ["srv5"],
			[MIGRATED_SERVER_IDS_KEY]: ["srv1", "srv2"],
			[LEGACY_CLEANUP_PENDING_KEY]: { orphanedSecretIds: ["srv6"] },
		});
		for (const id of ["srv1", "srv2", "srv3", "srv4", "srv5", "srv6"]) {
			storage.secretStore.set(apiKeySecret(id), `sk-${id}`);
		}
		storage.secretStore.set(LEGACY_BASE_URL_SECRET, "http://single.test");
		storage.secretStore.set(LEGACY_API_KEY_SECRET, "sk-single");

		const outcome = await legacyRegistryCleanupMigration.run(makeMigrationContext(storage));

		assert.strictEqual(outcome, "migrated");
		assert.deepStrictEqual(
			[...storage.mementoStore.entries()].filter(([, value]) => value !== undefined),
			[]
		);
		assert.deepStrictEqual([...storage.secretStore.keys()], [], "every legacy credential must leave the keychain");
	});

	test("a second run is a silent no-op", async () => {
		const storage = makeExtensionStorage({ [SERVER_REGISTRY_KEY]: { version: 1, servers: [] } });

		assert.strictEqual(await legacyRegistryCleanupMigration.run(makeMigrationContext(storage)), "migrated");
		assert.strictEqual(
			await legacyRegistryCleanupMigration.run(makeMigrationContext(storage)),
			"nothing-to-do",
			"the runner logs only on 'migrated', so nothing-to-do keeps the rerun silent"
		);
	});

	test("an unparseable registry blob still gets its keys deleted without throwing", async () => {
		const storage = makeExtensionStorage({
			[SERVER_REGISTRY_KEY]: "not a registry",
			[SEEDED_PROVIDER_GROUPS_KEY]: { nope: true },
			[LEGACY_CLEANUP_PENDING_KEY]: true,
		});

		const outcome = await legacyRegistryCleanupMigration.run(makeMigrationContext(storage));

		assert.strictEqual(outcome, "migrated");
		assert.strictEqual(storage.mementoStore.get(SERVER_REGISTRY_KEY), undefined);
		assert.strictEqual(storage.mementoStore.get(SEEDED_PROVIDER_GROUPS_KEY), undefined);
		assert.strictEqual(storage.mementoStore.get(LEGACY_CLEANUP_PENDING_KEY), undefined);
	});

	test("a pre-versioning bare-array registry blob still yields its secret ids", async () => {
		// The bare-array wrapping view no longer covers this key, so the cleanup
		// must read the oldest persisted shape itself.
		const storage = makeExtensionStorage({
			[SERVER_REGISTRY_KEY]: [{ id: "old1", label: "Old", baseUrl: "http://old.test" }],
		});
		storage.secretStore.set(apiKeySecret("old1"), "sk-old");

		await legacyRegistryCleanupMigration.run(makeMigrationContext(storage));

		assert.deepStrictEqual([...storage.secretStore.keys()], []);
	});

	test("the pre-registry single-server secret pair alone triggers a cleanup", async () => {
		const storage = makeExtensionStorage();
		storage.secretStore.set(LEGACY_BASE_URL_SECRET, "http://single.test");
		storage.secretStore.set(LEGACY_API_KEY_SECRET, "sk-single");

		const outcome = await legacyRegistryCleanupMigration.run(makeMigrationContext(storage));

		assert.strictEqual(outcome, "migrated");
		assert.deepStrictEqual([...storage.secretStore.keys()], []);
	});

	test("a corrupt registry blob orphans no credential another blob still references", async () => {
		// Every id-bearing source contributes independently: with the registry
		// blob unreadable, the skip markers, migrated-ids ledger, and in-flight
		// submission marker are what still name the stored secrets.
		const storage = makeExtensionStorage({
			[SERVER_REGISTRY_KEY]: "corrupt",
			[SKIPPED_MIGRATION_SERVERS_KEY]: ["skp1"],
			[MIGRATED_SERVER_IDS_KEY]: ["mig1"],
			[PENDING_GROUP_SUBMISSION_KEY]: { id: "sub1", name: "X", baseUrl: "http://x.test" },
		});
		for (const id of ["skp1", "mig1", "sub1"]) {
			storage.secretStore.set(apiKeySecret(id), `sk-${id}`);
		}

		await legacyRegistryCleanupMigration.run(makeMigrationContext(storage));

		assert.deepStrictEqual([...storage.secretStore.keys()], []);
	});

	test("the retired label expansion's label map and entry-copy ledger are purged", async () => {
		// The inverse of the retired survival pin: MIGRATED_SERVER_LABELS_KEY and
		// MIGRATED_ENTRY_PARAMETER_COPIES_KEY once outlived this cleanup because
		// the settings-redesign pipeline's label-scoped expansion read them. That
		// expansion is deleted, nothing reads either key, and either can be the
		// sole survivor of an interrupted pass, so each alone must trigger a
		// purge.
		const seeds: [string, unknown][] = [
			[MIGRATED_SERVER_LABELS_KEY, { "http://prod.test": ["Prod"] }],
			[MIGRATED_ENTRY_PARAMETER_COPIES_KEY, ['["Prod","gpt-4"]']],
		];
		for (const [key, value] of seeds) {
			const storage = makeExtensionStorage({ [key]: value });

			const outcome = await legacyRegistryCleanupMigration.run(makeMigrationContext(storage));

			assert.strictEqual(outcome, "migrated", `${key} alone must trigger a cleanup`);
			assert.strictEqual(storage.mementoStore.get(key), undefined, `${key} must be purged`);
		}
	});
});
