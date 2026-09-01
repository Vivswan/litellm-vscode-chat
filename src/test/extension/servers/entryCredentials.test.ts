import * as assert from "node:assert";
import { entryGroupCredentialsFor } from "../../../extension/servers/serverSync/entryCredentials";
import type { SecretStore } from "../../../extension/servers/serverSync/secrets";
import { readServerSecretsRecord, updateServerSecret } from "../../../extension/servers/serverSync/secrets";

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

function resolver(setting: unknown, secrets: SecretStore) {
	return (label: string, baseUrl: string) =>
		entryGroupCredentialsFor(
			() => setting,
			(entryLabel) => readServerSecretsRecord(secrets, entryLabel),
			label,
			baseUrl
		);
}

suite("extension/servers/serverSync/entryCredentials", () => {
	test("resolves the entry's credentials with inline outranking the stored blob", async () => {
		const secrets = makeSecretStore();
		await updateServerSecret(secrets, "Stored", "apiKey", "sk-stored", "http://a.test");
		await updateServerSecret(secrets, "Inline", "apiKey", "sk-dormant", "http://b.test");
		const setting = [
			{ label: "Stored", baseUrl: "http://a.test" },
			{ label: "Inline", baseUrl: "http://b.test", auth: { apiKey: "sk-inline" } },
		];
		const resolve = resolver(setting, secrets);

		assert.deepStrictEqual(await resolve("Stored", "http://a.test"), { apiKey: "sk-stored" });
		// Inline settings values outrank the label's SecretStorage blob, the
		// same precedence buildGroupArgs bakes into a fresh group.
		assert.deepStrictEqual(await resolve("Inline", "http://b.test"), { apiKey: "sk-inline" });
	});

	test("narrows OAuth and virtual-key units exactly like the group-configuration parse", async () => {
		const secrets = makeSecretStore();
		await updateServerSecret(secrets, "OAuth", "oauthClientSecret", "cs-1", "https://idp.test/token");
		const setting = [
			{
				label: "OAuth",
				baseUrl: "http://a.test",
				auth: {
					oauth: {
						tokenUrl: "https://idp.test/token",
						clientId: "cid",
						virtualKey: { header: "x-vk", value: "vk-1" },
					},
				},
			},
		];

		assert.deepStrictEqual(await resolver(setting, secrets)("OAuth", "http://a.test"), {
			apiKey: "",
			oauth: { tokenUrl: "https://idp.test/token", clientId: "cid", clientSecret: "cs-1" },
			virtualKey: { header: "x-vk", value: "vk-1" },
		});
	});

	test("matches by label AND normalized base URL: a group at another host gets nothing", async () => {
		const secrets = makeSecretStore();
		const setting = [{ label: "A", baseUrl: "http://a.test/", auth: { apiKey: "sk-a" } }];
		const resolve = resolver(setting, secrets);

		// Normalization equivalence still matches (trailing slash).
		assert.deepStrictEqual(await resolve("A", "http://a.test"), { apiKey: "sk-a" });
		// A leftover group at the entry's OLD host must never receive the
		// entry's credentials.
		assert.strictEqual(await resolve("A", "http://old.test"), undefined);
		assert.strictEqual(await resolve("Unknown", "http://a.test"), undefined);
	});

	test("fails closed on refused secret ownership and on a failed secrets read", async () => {
		const secrets = makeSecretStore();
		// Stamped for a different destination: the entry would use the field, so
		// the pairing is refused - the overlay must keep the baked credentials
		// rather than send a value nothing paired with this host.
		await updateServerSecret(secrets, "A", "apiKey", "sk-elsewhere", "http://other.test");
		const setting = [{ label: "A", baseUrl: "http://a.test" }];
		const resolve = resolver(setting, secrets);
		assert.strictEqual(await resolve("A", "http://a.test"), undefined);

		secrets.failReads = true;
		assert.strictEqual(await resolve("A", "http://a.test"), undefined);
	});
});
