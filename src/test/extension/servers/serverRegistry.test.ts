import * as assert from "node:assert";
import { ServerRegistry } from "../../../extension/servers/serverRegistry";
import { apiKeySecret, SERVER_REGISTRY_KEY } from "../../../shared/config/storageKeys";
import { failingStorage, makeExtensionStorage } from "../../testUtils";

interface Fakes {
	registry: ServerRegistry;
	mementoStore: Map<string, unknown>;
	secretStore: Map<string, string>;
}

function createRegistry(initialRegistryValue?: unknown): Fakes {
	const storage = makeExtensionStorage(
		initialRegistryValue === undefined ? undefined : { [SERVER_REGISTRY_KEY]: initialRegistryValue }
	);
	return {
		registry: new ServerRegistry(storage.memento, storage.secrets),
		mementoStore: storage.mementoStore,
		secretStore: storage.secretStore,
	};
}

suite("extension/servers/serverRegistry", () => {
	suite("server CRUD", () => {
		test("addServer strips trailing slashes and stores the api key", async () => {
			const { registry, secretStore } = createRegistry();

			const server = await registry.addServer("My Server", "http://host:4000///", "my-key");

			assert.strictEqual(server.baseUrl, "http://host:4000");
			assert.strictEqual(registry.getServers().length, 1);
			assert.deepStrictEqual(registry.getServers()[0], server);
			assert.strictEqual(secretStore.get(apiKeySecret(server.id)), "my-key");
			assert.strictEqual(await registry.getApiKey(server.id), "my-key");
		});

		test("addServer with empty api key stores no secret", async () => {
			const { registry, secretStore } = createRegistry();

			const server = await registry.addServer("No Key", "http://host:4000", "");

			assert.strictEqual(secretStore.has(apiKeySecret(server.id)), false);
			assert.strictEqual(await registry.getApiKey(server.id), "");
		});

		test("updateServer rewrites label/baseUrl and empty-string api key deletes the secret", async () => {
			const { registry, secretStore } = createRegistry();
			const server = await registry.addServer("Original", "http://host:4000", "original-key");

			await registry.updateServer(server.id, "Renamed", "http://other:5000/", "");

			const servers = registry.getServers();
			assert.strictEqual(servers.length, 1);
			assert.deepStrictEqual(servers[0], { id: server.id, label: "Renamed", baseUrl: "http://other:5000" });
			assert.strictEqual(secretStore.has(apiKeySecret(server.id)), false);
		});

		test("updateServer with undefined api key leaves the stored secret untouched", async () => {
			const { registry, secretStore } = createRegistry();
			const server = await registry.addServer("Original", "http://host:4000", "original-key");

			await registry.updateServer(server.id, "Renamed", "http://host:4000", undefined);

			assert.strictEqual(secretStore.get(apiKeySecret(server.id)), "original-key");
		});

		test("updateServer for an unknown id is a no-op", async () => {
			const { registry } = createRegistry();
			const server = await registry.addServer("Original", "http://host:4000", "key");

			await registry.updateServer("missing1", "Ghost", "http://ghost:4000", "ghost-key");

			assert.deepStrictEqual(registry.getServers(), [server]);
		});

		test("removeServer drops the entry and its secret", async () => {
			const { registry, secretStore } = createRegistry();
			const kept = await registry.addServer("Kept", "http://kept:4000", "kept-key");
			const removed = await registry.addServer("Removed", "http://removed:4000", "removed-key");

			await registry.removeServer(removed.id);

			assert.deepStrictEqual(registry.getServers(), [kept]);
			assert.strictEqual(secretStore.has(apiKeySecret(removed.id)), false);
			assert.strictEqual(secretStore.get(apiKeySecret(kept.id)), "kept-key");
		});

		test("getServersWithKeys pairs each server with its stored key", async () => {
			const { registry } = createRegistry();
			const withKey = await registry.addServer("WithKey", "http://a:4000", "key-a");
			const withoutKey = await registry.addServer("WithoutKey", "http://b:4000", "");

			const servers = await registry.getServersWithKeys();

			assert.deepStrictEqual(servers, [
				{ ...withKey, apiKey: "key-a" },
				{ ...withoutKey, apiKey: "" },
			]);
		});

		test("addServer rolls back the stored secret when the registry write fails", async () => {
			const storage = failingStorage(makeExtensionStorage(), {
				failOn: { mementoUpdate: () => new Error("registry write failed") },
			});
			const registry = new ServerRegistry(storage.memento, storage.secrets);

			await assert.rejects(registry.addServer("Broken", "http://host:4000", "the-key"), /registry write failed/);

			assert.deepStrictEqual(
				storage.ops,
				["store", "update", "delete"],
				"The secret must be stored before the registry write and rolled back after it fails"
			);
			assert.strictEqual(registry.getServers().length, 0);
			assert.strictEqual(storage.secretStore.size, 0, "The stored secret must be rolled back");
		});

		test("updateServer stores the key first: a failing key write leaves the entry at its old host", async () => {
			// The reverse order (entry persist, then key write) left a re-pointed
			// entry paired with the OLD host's key when the key write failed - the
			// legacy request path then sent that key to the new host.
			let failStore = false;
			const storage = failingStorage(makeExtensionStorage(), {
				failOn: { secretStore: () => (failStore ? new Error("keychain locked") : undefined) },
			});
			const registry = new ServerRegistry(storage.memento, storage.secrets);
			const server = await registry.addServer("Original", "http://old:4000", "old-key");
			failStore = true;

			await assert.rejects(
				registry.updateServer(server.id, "Renamed", "http://new:5000", "new-key"),
				/keychain locked/
			);

			assert.deepStrictEqual(registry.getServers(), [server], "the entry must not re-point without its new key");
			assert.strictEqual(storage.secretStore.get(apiKeySecret(server.id)), "old-key");
		});

		test("updateServer rolls the staged key back when the entry persist fails", async () => {
			let failPersist = false;
			const storage = failingStorage(makeExtensionStorage(), {
				failOn: { mementoUpdate: () => (failPersist ? new Error("registry write failed") : undefined) },
			});
			const registry = new ServerRegistry(storage.memento, storage.secrets);
			const server = await registry.addServer("Original", "http://old:4000", "old-key");
			failPersist = true;

			await assert.rejects(
				registry.updateServer(server.id, "Renamed", "http://new:5000", "new-key"),
				/registry write failed/
			);

			assert.deepStrictEqual(registry.getServers(), [server]);
			assert.strictEqual(
				storage.secretStore.get(apiKeySecret(server.id)),
				"old-key",
				"the staged key is rolled back with the entry"
			);
		});

		test("updateServer deletes the key when even the rollback restore fails: missing beats mismatched", async () => {
			// Persist fails AND restoring the old key fails: leaving the staged NEW
			// key under the entry (still at its old host) would serve a credential
			// that belongs elsewhere, so the key is deleted instead - requests 401
			// and the user re-enters, but no host ever sees another host's key.
			let failPersist = false;
			let storesAfterArm = 0;
			const storage = failingStorage(makeExtensionStorage(), {
				failOn: {
					mementoUpdate: () => (failPersist ? new Error("registry write failed") : undefined),
					// The first armed store is the staged new key (succeeds); the
					// second is the rollback restore (fails).
					secretStore: () => {
						if (!failPersist) {
							return undefined;
						}
						storesAfterArm += 1;
						return storesAfterArm >= 2 ? new Error("keychain locked") : undefined;
					},
				},
			});
			const registry = new ServerRegistry(storage.memento, storage.secrets);
			const server = await registry.addServer("Original", "http://old:4000", "old-key");
			failPersist = true;

			await assert.rejects(
				registry.updateServer(server.id, "Renamed", "http://new:5000", "new-key"),
				/registry write failed/
			);

			assert.deepStrictEqual(registry.getServers(), [server], "the entry stays at its old host");
			assert.strictEqual(
				storage.secretStore.has(apiKeySecret(server.id)),
				false,
				"no key at all beats the new host's key under the old host's entry"
			);
		});
	});

	suite("getServers validation", () => {
		test("non-array registry content yields an empty list", () => {
			const { registry } = createRegistry({ not: "an array" });

			assert.deepStrictEqual(registry.getServers(), []);
		});

		test("malformed entries are filtered out", () => {
			const valid = { id: "srv1", label: "Valid", baseUrl: "http://valid:4000" };
			const { registry } = createRegistry([
				valid,
				null,
				"nonsense",
				{ id: "srv2", label: "No baseUrl" },
				{ id: 42, label: "Bad id type", baseUrl: "http://bad:4000" },
			]);

			assert.deepStrictEqual(registry.getServers(), [valid]);
		});

		test("a stale globalState broadcast cannot revert an in-flight registration", async () => {
			const existing = { id: "srv1", label: "Existing", baseUrl: "http://existing:4000" };
			const { registry, mementoStore } = createRegistry({ version: 3, servers: [existing] });

			// Simulate VS Code delivering a stale storage blob after construction,
			// the way a concurrent status-bar persist can revert the Memento cache.
			mementoStore.set(SERVER_REGISTRY_KEY, { version: 2, servers: [] });

			const added = await registry.addServer("New", "http://new:4000", "");

			assert.deepStrictEqual(registry.getServers(), [existing, added]);
			assert.deepStrictEqual(
				mementoStore.get(SERVER_REGISTRY_KEY),
				{ version: 4, servers: [existing, added] },
				"The persisted blob must contain both servers"
			);
		});

		test("a newer snapshot from another window is adopted before mutating", async () => {
			const mine = { id: "srv1", label: "Mine", baseUrl: "http://mine:4000" };
			const { registry, mementoStore } = createRegistry({ version: 1, servers: [mine] });

			// Another window added a server and persisted a strictly newer version.
			const theirs = { id: "srv2", label: "Theirs", baseUrl: "http://theirs:4000" };
			mementoStore.set(SERVER_REGISTRY_KEY, { version: 5, servers: [mine, theirs] });

			const added = await registry.addServer("New", "http://new:4000", "");

			assert.deepStrictEqual(registry.getServers(), [mine, theirs, added]);
			assert.deepStrictEqual(mementoStore.get(SERVER_REGISTRY_KEY), {
				version: 6,
				servers: [mine, theirs, added],
			});
		});

		test("a pre-versioning bare-array registry is readable and upgraded on write", async () => {
			const legacyShaped = { id: "srv1", label: "Old", baseUrl: "http://old:4000" };
			const { registry, mementoStore } = createRegistry([legacyShaped]);

			assert.deepStrictEqual(registry.getServers(), [legacyShaped]);

			const added = await registry.addServer("New", "http://new:4000", "");
			assert.deepStrictEqual(mementoStore.get(SERVER_REGISTRY_KEY), {
				version: 1,
				servers: [legacyShaped, added],
			});
		});

		test("a broken persisted version re-enters versioning at 0 instead of freezing adoption", async () => {
			// A hand-edited 1e999 survives JSON.parse as Infinity, and a huge finite
			// value like 1e20 is just as poisonous (version + 1 rounds back), so no
			// local write could persist a strictly newer version and adoption freezes.
			const existing = { id: "srv1", label: "Existing", baseUrl: "http://existing:4000" };
			for (const broken of [Number.POSITIVE_INFINITY, Number.NaN, 1e20, -1, 1.5]) {
				const { registry, mementoStore } = createRegistry({ version: broken, servers: [existing] });

				// The servers survive the broken version...
				assert.deepStrictEqual(registry.getServers(), [existing], `servers survive version ${broken}`);

				// ...and the next persist writes a version other windows can exceed.
				const added = await registry.addServer("New", "http://new:4000", "");
				assert.deepStrictEqual(
					mementoStore.get(SERVER_REGISTRY_KEY),
					{ version: 1, servers: [existing, added] },
					`version ${broken} re-enters at 0`
				);
			}
		});

		test("a failed persist's optimistic cache residue is not re-adopted after rollback", async () => {
			// VS Code's Memento caches an update before the async write settles, so a
			// failed persist can leave the rejected snapshot readable in the cache.
			let failNextUpdate = false;
			const storage = failingStorage(makeExtensionStorage(), {
				failOn: {
					mementoUpdate: () => {
						if (!failNextUpdate) {
							return undefined;
						}
						failNextUpdate = false;
						return new Error("persist failed");
					},
				},
			});
			const registry = new ServerRegistry(storage.memento, storage.secrets);
			const first = await registry.addServer("First", "http://first:4000", "");

			failNextUpdate = true;
			await assert.rejects(registry.addServer("Broken", "http://broken:4000", ""), /persist failed/);

			assert.deepStrictEqual(registry.getServers(), [first], "The rejected snapshot must not be re-adopted");

			const again = await registry.addServer("Again", "http://again:4000", "");
			assert.deepStrictEqual(registry.getServers(), [first, again]);
			assert.deepStrictEqual(storage.mementoStore.get(SERVER_REGISTRY_KEY), { version: 2, servers: [first, again] });
		});
	});

	suite("hasLabel", () => {
		test("matches existing labels and honors excludeId", async () => {
			const { registry } = createRegistry();
			const server = await registry.addServer("Prod", "http://prod:4000", "");
			await registry.addServer("Staging", "http://staging:4000", "");

			assert.strictEqual(registry.hasLabel("Prod"), true);
			assert.strictEqual(registry.hasLabel("Missing"), false);
			assert.strictEqual(registry.hasLabel("Prod", server.id), false);
			assert.strictEqual(registry.hasLabel("Prod", "some-other-id"), true);
		});
	});
});
