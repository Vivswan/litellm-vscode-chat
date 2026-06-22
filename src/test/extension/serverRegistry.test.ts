import * as assert from "assert";
import * as vscode from "vscode";
import { ServerRegistry } from "../../extension/serverRegistry";
import type { ServerAuthInput } from "../../extension/serverRegistry";

function createMemento(): vscode.Memento {
	const store = new Map<string, unknown>();
	return {
		get<T>(key: string, defaultValue?: T): T {
			return (store.has(key) ? store.get(key) : defaultValue) as T;
		},
		update(key: string, value: unknown): Thenable<void> {
			if (value === undefined) {
				store.delete(key);
			} else {
				store.set(key, value);
			}
			return Promise.resolve();
		},
		keys(): readonly string[] {
			return Array.from(store.keys());
		},
	} as vscode.Memento;
}

function createSecretStorage(): vscode.SecretStorage & { dump: () => Map<string, string> } {
	const store = new Map<string, string>();
	const emitter = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();
	return {
		get(key: string): Thenable<string | undefined> {
			return Promise.resolve(store.get(key));
		},
		store(key: string, value: string): Thenable<void> {
			store.set(key, value);
			return Promise.resolve();
		},
		delete(key: string): Thenable<void> {
			store.delete(key);
			return Promise.resolve();
		},
		keys(): Thenable<string[]> {
			return Promise.resolve(Array.from(store.keys()));
		},
		onDidChange: emitter.event,
		dump: () => store,
	};
}

suite("extension/serverRegistry", () => {
	test("addServer with no auth input defaults to apiKey", async () => {
		const memento = createMemento();
		const secrets = createSecretStorage();
		const registry = new ServerRegistry(memento, secrets);

		const server = await registry.addServer("Default", "https://x/", "key-1");
		assert.strictEqual(server.authMethod, "apiKey");
		assert.strictEqual(server.baseUrl, "https://x", "trailing slash should be stripped");
		assert.strictEqual(await registry.getApiKey(server.id), "key-1");
	});

	test("stored config has no secrets in globalState", async () => {
		const memento = createMemento();
		const secrets = createSecretStorage();
		const registry = new ServerRegistry(memento, secrets);

		const oauth: ServerAuthInput = {
			authMethod: "oauth2",
			oauth: {
				tokenUrl: "https://idp/token",
				clientId: "cid",
				clientSecret: "csecret",
				virtualKey: "vkey",
				virtualKeyHeader: "X-Custom",
			},
		};
		const server = await registry.addServer("OAuth", "https://x", "", oauth);

		const persisted = registry.getServers().find((s) => s.id === server.id);
		assert.ok(persisted);
		assert.strictEqual(persisted!.authMethod, "oauth2");
		assert.strictEqual(persisted!.oauthTokenUrl, "https://idp/token");
		assert.strictEqual(persisted!.oauthClientId, "cid");
		assert.strictEqual(persisted!.oauthVirtualKeyHeader, "X-Custom");
		assert.ok(
			!("oauthClientSecret" in (persisted as unknown as Record<string, unknown>)),
			"secret must not be in globalState"
		);
		assert.ok(
			!("oauthVirtualKey" in (persisted as unknown as Record<string, unknown>)),
			"virtual key must not be in globalState"
		);
	});

	test("getServersWithKeys round-trips OAuth secrets", async () => {
		const memento = createMemento();
		const secrets = createSecretStorage();
		const registry = new ServerRegistry(memento, secrets);

		await registry.addServer("OAuth", "https://x", "", {
			authMethod: "oauth2",
			oauth: {
				tokenUrl: "https://idp/token",
				clientId: "cid",
				clientSecret: "csecret",
				virtualKey: "vkey",
			},
		});

		const withKeys = await registry.getServersWithKeys();
		assert.strictEqual(withKeys.length, 1);
		const s = withKeys[0];
		assert.strictEqual(s.authMethod, "oauth2");
		assert.strictEqual(s.oauthClientSecret, "csecret");
		assert.strictEqual(s.oauthVirtualKey, "vkey");
		assert.strictEqual(s.apiKey, "", "OAuth server should have empty apiKey");
	});

	test("missing authMethod reads back as apiKey via getServersWithKeys", async () => {
		const memento = createMemento();
		const secrets = createSecretStorage();
		// Simulate a legacy stored server without authMethod.
		await memento.update("litellm.serverRegistry", [{ id: "legacy1", label: "Legacy", baseUrl: "https://x" }]);
		await secrets.store("litellm.apiKey.legacy1", "legacy-key");
		const registry = new ServerRegistry(memento, secrets);

		const withKeys = await registry.getServersWithKeys();
		assert.strictEqual(withKeys[0].authMethod, undefined);
		assert.strictEqual(withKeys[0].apiKey, "legacy-key");
		assert.strictEqual(withKeys[0].oauthClientSecret, undefined, "non-oauth server should not load oauth secret");
	});

	test("switching from oauth2 to apiKey clears oauth secrets", async () => {
		const memento = createMemento();
		const secrets = createSecretStorage();
		const registry = new ServerRegistry(memento, secrets);

		const server = await registry.addServer("S", "https://x", "", {
			authMethod: "oauth2",
			oauth: { tokenUrl: "https://idp/token", clientId: "cid", clientSecret: "csecret", virtualKey: "vkey" },
		});

		await registry.updateServer(server.id, "S", "https://x", "new-api-key", {
			authMethod: "apiKey",
			apiKey: "new-api-key",
		});

		assert.strictEqual(await registry.getApiKey(server.id), "new-api-key");
		assert.strictEqual(await registry.getOAuthClientSecret(server.id), "", "oauth secret should be cleared");
		assert.strictEqual(await registry.getOAuthVirtualKey(server.id), "", "virtual key should be cleared");
		const persisted = registry.getServers().find((s) => s.id === server.id);
		assert.strictEqual(persisted!.authMethod, "apiKey");
		assert.strictEqual(persisted!.oauthTokenUrl, undefined);
	});

	test("switching from apiKey to oauth2 clears the api key secret", async () => {
		const memento = createMemento();
		const secrets = createSecretStorage();
		const registry = new ServerRegistry(memento, secrets);

		const server = await registry.addServer("S", "https://x", "api-key");
		assert.strictEqual(await registry.getApiKey(server.id), "api-key");

		await registry.updateServer(server.id, "S", "https://x", undefined, {
			authMethod: "oauth2",
			oauth: { tokenUrl: "https://idp/token", clientId: "cid", clientSecret: "csecret" },
		});

		assert.strictEqual(await registry.getApiKey(server.id), "", "api key secret should be cleared");
		assert.strictEqual(await registry.getOAuthClientSecret(server.id), "csecret");
	});

	test("removeServer deletes all secret types", async () => {
		const memento = createMemento();
		const secrets = createSecretStorage();
		const registry = new ServerRegistry(memento, secrets);

		const server = await registry.addServer("S", "https://x", "", {
			authMethod: "oauth2",
			oauth: { tokenUrl: "https://idp/token", clientId: "cid", clientSecret: "csecret", virtualKey: "vkey" },
		});

		await registry.removeServer(server.id);

		assert.strictEqual(registry.getServers().length, 0);
		const dump = secrets.dump();
		assert.strictEqual(dump.size, 0, "all secrets should be deleted");
	});
});
