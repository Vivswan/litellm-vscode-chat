import * as assert from "node:assert";
import { entryGroupCredentialsFor } from "../../../extension/servers/serverSync/entryCredentials";
import type { SecretStore } from "../../../extension/servers/serverSync/secrets";
import { readServerSecretsRecord, updateServerSecret } from "../../../extension/servers/serverSync/secrets";
import type { GroupCredentials, GroupCredentialsResolution } from "../../../provider/catalog/groupModels";

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

const resolved = (credentials: GroupCredentials): GroupCredentialsResolution => ({ kind: "resolved", credentials });

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

		assert.deepStrictEqual(await resolve("Stored", "http://a.test"), resolved({ apiKey: "sk-stored" }));
		// Inline settings values outrank the label's SecretStorage blob, the
		// same precedence buildGroupArgs bakes into a fresh group.
		assert.deepStrictEqual(await resolve("Inline", "http://b.test"), resolved({ apiKey: "sk-inline" }));
	});

	test("narrows OAuth and virtual-key units exactly like the group-configuration parse", async () => {
		const secrets = makeSecretStore();
		await updateServerSecret(secrets, "OAuth", "oauthClientSecret", "cs-1", {
			tokenUrl: "https://idp.test/token",
			clientId: "cid",
		});
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

		assert.deepStrictEqual(
			await resolver(setting, secrets)("OAuth", "http://a.test"),
			resolved({
				apiKey: "",
				oauth: { tokenUrl: "https://idp.test/token", clientId: "cid", clientSecret: "cs-1" },
				virtualKey: { header: "x-vk", value: "vk-1" },
			})
		);
	});

	test("matches by label AND normalized base URL: a group at another host gets nothing", async () => {
		const secrets = makeSecretStore();
		const setting = [{ label: "A", baseUrl: "http://a.test/", auth: { apiKey: "sk-a" } }];
		const resolve = resolver(setting, secrets);

		// Normalization equivalence still matches (trailing slash).
		assert.deepStrictEqual(await resolve("A", "http://a.test"), resolved({ apiKey: "sk-a" }));
		// A leftover group at the entry's OLD host must never receive the
		// entry's credentials.
		assert.deepStrictEqual(await resolve("A", "http://old.test"), { kind: "external" });
		assert.deepStrictEqual(await resolve("Unknown", "http://a.test"), { kind: "external" });
	});

	test("fails closed on refused secret ownership and on a failed secrets read, each as its own unavailable reason", async () => {
		const secrets = makeSecretStore();
		// Stamped for a different destination: the entry would use the field, so
		// the pairing is refused - nothing paired with this host may be sent,
		// and the baked copy is not a fallback either (see GroupCredentialsResolution).
		await updateServerSecret(secrets, "A", "apiKey", "sk-elsewhere", "http://other.test");
		const setting = [{ label: "A", baseUrl: "http://a.test" }];
		const resolve = resolver(setting, secrets);
		assert.deepStrictEqual(await resolve("A", "http://a.test"), { kind: "unavailable", reason: "secretsMismatched" });

		secrets.failReads = true;
		assert.deepStrictEqual(await resolve("A", "http://a.test"), { kind: "unavailable", reason: "secretsUnreadable" });
	});
});
