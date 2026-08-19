import * as assert from "node:assert";
import { stampSecretOwnersFor } from "../../../extension/migrations/stampSecretOwners";
import type { SecretStore } from "../../../extension/servers/serverSync/secrets";
import { readServerSecretsRecord, updateServerSecret } from "../../../extension/servers/serverSync/secrets";
import { serverSecretsKey } from "../../../shared/config/storageKeys";
import { Logger } from "../../../shared/logger";

function makeStore(initial: Record<string, string> = {}): SecretStore & { values: Map<string, string> } {
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

const quietLogger = () => new Logger({ info: () => {}, error: () => {} });

suite("extension/migrations/stampSecretOwners", () => {
	test("stamps unstamped fields of declared entries with their destinations, then no-ops", async () => {
		const store = makeStore({
			[serverSecretsKey("A")]: JSON.stringify({ apiKey: "sk-a" }),
			[serverSecretsKey("OAuth")]: JSON.stringify({ oauthClientSecret: "cs-1", virtualKeyValue: "vk-1" }),
		});
		const setting = [
			{ label: "A", baseUrl: "http://a.test/" },
			{
				label: "OAuth",
				baseUrl: "http://oauth.test",
				auth: {
					oauth: { tokenUrl: "https://idp.test/token", clientId: "cid", virtualKey: { header: "x-vk" } },
				},
			},
		];

		assert.strictEqual(await stampSecretOwnersFor(() => setting, store, quietLogger()), "migrated");
		assert.deepStrictEqual((await readServerSecretsRecord(store, "A")).owners, { apiKey: "http://a.test" });
		assert.deepStrictEqual((await readServerSecretsRecord(store, "OAuth")).owners, {
			oauthClientSecret: "https://idp.test/token",
			virtualKeyValue: "http://oauth.test",
		});

		assert.strictEqual(await stampSecretOwnersFor(() => setting, store, quietLogger()), "nothing-to-do");
	});

	test("never overwrites an existing stamp and never touches undeclared labels", async () => {
		const store = makeStore({ [serverSecretsKey("Leftover")]: JSON.stringify({ apiKey: "sk-left" }) });
		await updateServerSecret(store, "A", "apiKey", "sk-a", "http://deliberate.test");
		const setting = [{ label: "A", baseUrl: "http://a.test" }];

		assert.strictEqual(await stampSecretOwnersFor(() => setting, store, quietLogger()), "nothing-to-do");
		assert.deepStrictEqual((await readServerSecretsRecord(store, "A")).owners, { apiKey: "http://deliberate.test" });
		// A leftover blob with no declared entry has no derivable destination: it
		// stays unstamped (and keeps resolving for a future re-add, as before).
		assert.deepStrictEqual((await readServerSecretsRecord(store, "Leftover")).owners, {});
	});

	test("an OAuth client secret on an entry without a token URL waits instead of stamping an empty destination", async () => {
		const store = makeStore({ [serverSecretsKey("A")]: JSON.stringify({ oauthClientSecret: "cs-1" }) });
		const setting = [{ label: "A", baseUrl: "http://a.test" }];

		assert.strictEqual(await stampSecretOwnersFor(() => setting, store, quietLogger()), "nothing-to-do");
		assert.deepStrictEqual((await readServerSecretsRecord(store, "A")).owners, {});

		// Once the entry declares its token URL, the pairing is derivable and the
		// next activation stamps it.
		const withOAuth = [
			{ label: "A", baseUrl: "http://a.test", auth: { oauth: { tokenUrl: "https://idp.test/token", clientId: "c" } } },
		];
		assert.strictEqual(await stampSecretOwnersFor(() => withOAuth, store, quietLogger()), "migrated");
		assert.deepStrictEqual((await readServerSecretsRecord(store, "A")).owners, {
			oauthClientSecret: "https://idp.test/token",
		});
	});

	test("a failing blob read leaves the migration in progress for the next activation", async () => {
		const store = makeStore();
		store.get = async () => {
			throw new Error("keychain locked");
		};
		const setting = [{ label: "A", baseUrl: "http://a.test" }];
		assert.strictEqual(await stampSecretOwnersFor(() => setting, store, quietLogger()), "in-progress");
	});
});
