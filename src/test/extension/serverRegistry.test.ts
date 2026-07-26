import * as assert from "node:assert";
import type * as vscode from "vscode";
import { ServerRegistry } from "../../extension/serverRegistry";
import {
	apiKeySecret,
	LEGACY_API_KEY_SECRET,
	LEGACY_BASE_URL_SECRET,
	SERVER_REGISTRY_KEY,
} from "../../shared/storageKeys";
import { expectDefined } from "../testUtils";

interface Fakes {
	registry: ServerRegistry;
	mementoStore: Map<string, unknown>;
	secretStore: Map<string, string>;
}

function createRegistry(initialRegistryValue?: unknown): Fakes {
	const mementoStore = new Map<string, unknown>();
	if (initialRegistryValue !== undefined) {
		mementoStore.set(SERVER_REGISTRY_KEY, initialRegistryValue);
	}
	const memento = {
		get: (key: string, defaultValue?: unknown) => (mementoStore.has(key) ? mementoStore.get(key) : defaultValue),
		update: async (key: string, value: unknown) => {
			mementoStore.set(key, value);
		},
	} as unknown as vscode.Memento;

	const secretStore = new Map<string, string>();
	const secrets = {
		get: async (key: string) => secretStore.get(key),
		store: async (key: string, value: string) => {
			secretStore.set(key, value);
		},
		delete: async (key: string) => {
			secretStore.delete(key);
		},
		onDidChange: (_listener: unknown) => ({ dispose() {} }),
	} as unknown as vscode.SecretStorage;

	return { registry: new ServerRegistry(memento, secrets), mementoStore, secretStore };
}

suite("extension/serverRegistry", () => {
	suite("migrateLegacy", () => {
		test("migrates legacy secrets into a Default server and deletes them", async () => {
			const { registry, secretStore } = createRegistry();
			secretStore.set(LEGACY_BASE_URL_SECRET, "http://legacy:4000");
			secretStore.set(LEGACY_API_KEY_SECRET, "legacy-key");

			const migrated = await registry.migrateLegacy();

			assert.strictEqual(migrated, true);
			const servers = registry.getServers();
			assert.strictEqual(servers.length, 1);
			const server = expectDefined(servers[0]);
			assert.strictEqual(server.label, "Default");
			assert.strictEqual(server.baseUrl, "http://legacy:4000");
			assert.strictEqual(secretStore.get(apiKeySecret(server.id)), "legacy-key");
			assert.strictEqual(secretStore.has(LEGACY_BASE_URL_SECRET), false);
			assert.strictEqual(secretStore.has(LEGACY_API_KEY_SECRET), false);
		});

		test("is a no-op when the registry already has a server", async () => {
			const { registry, secretStore } = createRegistry();
			await registry.addServer("Existing", "http://existing:4000", "existing-key");
			secretStore.set(LEGACY_BASE_URL_SECRET, "http://legacy:4000");
			secretStore.set(LEGACY_API_KEY_SECRET, "legacy-key");

			const migrated = await registry.migrateLegacy();

			assert.strictEqual(migrated, false);
			assert.strictEqual(registry.getServers().length, 1);
			assert.strictEqual(expectDefined(registry.getServers()[0]).label, "Existing");
			assert.strictEqual(secretStore.get(LEGACY_BASE_URL_SECRET), "http://legacy:4000");
			assert.strictEqual(secretStore.get(LEGACY_API_KEY_SECRET), "legacy-key");
		});

		test("is a no-op when no legacy baseUrl secret exists", async () => {
			const { registry, secretStore } = createRegistry();
			secretStore.set(LEGACY_API_KEY_SECRET, "orphan-key");

			const migrated = await registry.migrateLegacy();

			assert.strictEqual(migrated, false);
			assert.strictEqual(registry.getServers().length, 0);
			assert.strictEqual(secretStore.get(LEGACY_API_KEY_SECRET), "orphan-key");
		});
	});

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
			const operations: string[] = [];
			const mementoStore = new Map<string, unknown>();
			const memento = {
				get: (key: string, defaultValue?: unknown) => (mementoStore.has(key) ? mementoStore.get(key) : defaultValue),
				update: async () => {
					operations.push("update");
					throw new Error("registry write failed");
				},
			} as unknown as vscode.Memento;
			const secretStore = new Map<string, string>();
			const secrets = {
				get: async (key: string) => secretStore.get(key),
				store: async (key: string, value: string) => {
					operations.push("store");
					secretStore.set(key, value);
				},
				delete: async (key: string) => {
					operations.push("delete");
					secretStore.delete(key);
				},
				onDidChange: (_listener: unknown) => ({ dispose() {} }),
			} as unknown as vscode.SecretStorage;
			const registry = new ServerRegistry(memento, secrets);

			await assert.rejects(registry.addServer("Broken", "http://host:4000", "the-key"), /registry write failed/);

			assert.deepStrictEqual(
				operations,
				["store", "update", "delete"],
				"The secret must be stored before the registry write and rolled back after it fails"
			);
			assert.strictEqual(registry.getServers().length, 0);
			assert.strictEqual(secretStore.size, 0, "The stored secret must be rolled back");
		});

		test("addServer failure during migration keeps legacy secrets for a retry", async () => {
			const { registry, secretStore } = createRegistry();
			secretStore.set(LEGACY_BASE_URL_SECRET, "http://legacy:4000");
			secretStore.set(LEGACY_API_KEY_SECRET, "legacy-key");
			const failingSecrets = {
				get: async (key: string) => secretStore.get(key),
				store: async () => {
					throw new Error("secret store failed");
				},
				delete: async (key: string) => {
					secretStore.delete(key);
				},
				onDidChange: (_listener: unknown) => ({ dispose() {} }),
			} as unknown as vscode.SecretStorage;
			const mementoStore = new Map<string, unknown>();
			const memento = {
				get: (key: string, defaultValue?: unknown) => (mementoStore.has(key) ? mementoStore.get(key) : defaultValue),
				update: async (key: string, value: unknown) => {
					mementoStore.set(key, value);
				},
			} as unknown as vscode.Memento;
			const failingRegistry = new ServerRegistry(memento, failingSecrets);

			await assert.rejects(failingRegistry.migrateLegacy(), /secret store failed/);

			assert.strictEqual(failingRegistry.getServers().length, 0, "No half-migrated registry entry may remain");
			assert.strictEqual(secretStore.get(LEGACY_BASE_URL_SECRET), "http://legacy:4000");
			assert.strictEqual(secretStore.get(LEGACY_API_KEY_SECRET), "legacy-key");

			const retried = await registry.migrateLegacy();
			assert.strictEqual(retried, true, "Migration must succeed on retry once secret storage works");
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

		test("a failed persist's optimistic cache residue is not re-adopted after rollback", async () => {
			// VS Code's Memento caches an update before the async write settles, so a
			// failed persist can leave the rejected snapshot readable in the cache.
			const mementoStore = new Map<string, unknown>();
			let failNextUpdate = false;
			const memento = {
				get: (key: string, defaultValue?: unknown) => (mementoStore.has(key) ? mementoStore.get(key) : defaultValue),
				update: async (key: string, value: unknown) => {
					mementoStore.set(key, value);
					if (failNextUpdate) {
						failNextUpdate = false;
						throw new Error("persist failed");
					}
				},
			} as unknown as vscode.Memento;
			const secretStore = new Map<string, string>();
			const secrets = {
				get: async (key: string) => secretStore.get(key),
				store: async (key: string, value: string) => {
					secretStore.set(key, value);
				},
				delete: async (key: string) => {
					secretStore.delete(key);
				},
				onDidChange: (_listener: unknown) => ({ dispose() {} }),
			} as unknown as vscode.SecretStorage;
			const registry = new ServerRegistry(memento, secrets);
			const first = await registry.addServer("First", "http://first:4000", "");

			failNextUpdate = true;
			await assert.rejects(registry.addServer("Broken", "http://broken:4000", ""), /persist failed/);

			assert.deepStrictEqual(registry.getServers(), [first], "The rejected snapshot must not be re-adopted");

			const again = await registry.addServer("Again", "http://again:4000", "");
			assert.deepStrictEqual(registry.getServers(), [first, again]);
			assert.deepStrictEqual(mementoStore.get(SERVER_REGISTRY_KEY), { version: 2, servers: [first, again] });
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
