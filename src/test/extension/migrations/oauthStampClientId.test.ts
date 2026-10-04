import * as assert from "node:assert";
import { stampOauthClientIdsFor } from "../../../extension/migrations/oauthStampClientId";
import type { SecretStore } from "../../../extension/servers/serverSync/secrets";
import { readServerSecretsRecord, updateServerSecret } from "../../../extension/servers/serverSync/secrets";
import { Logger } from "../../../shared/logger";

function makeStore(): SecretStore {
	const values = new Map<string, string>();
	return {
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

const TOKEN_URL = "https://idp.test/token";
const CURRENT_STAMP = JSON.stringify([TOKEN_URL, "cid"]);

suite("extension/migrations/oauthStampClientId", () => {
	test("only the token-URL-only stamp of a declared OAuth entry moves; values and every other state stay", async () => {
		const rows = [
			{ label: "legacy", owner: TOKEN_URL, declaresOauth: true, expected: CURRENT_STAMP },
			{ label: "current", owner: CURRENT_STAMP, declaresOauth: true, expected: CURRENT_STAMP },
			{
				label: "foreign",
				owner: "https://other-idp.test/token",
				declaresOauth: true,
				expected: "https://other-idp.test/token",
			},
			{ label: "unstamped", owner: undefined, declaresOauth: true, expected: undefined },
			{ label: "no-oauth", owner: TOKEN_URL, declaresOauth: false, expected: TOKEN_URL },
		];
		const store = makeStore();
		for (const row of rows) {
			await updateServerSecret(store, row.label, "oauthClientSecret", `cs-${row.label}`, row.owner);
		}
		const setting = rows.map((row) => ({
			label: row.label,
			baseUrl: `http://${row.label}.test`,
			...(row.declaresOauth ? { auth: { oauth: { tokenUrl: TOKEN_URL, clientId: "cid" } } } : {}),
		}));

		assert.strictEqual(await stampOauthClientIdsFor(() => setting, store, quietLogger()), "migrated");
		for (const row of rows) {
			assert.deepStrictEqual(
				await readServerSecretsRecord(store, row.label),
				{
					values: { oauthClientSecret: `cs-${row.label}` },
					owners: row.expected === undefined ? {} : { oauthClientSecret: row.expected },
				},
				row.label
			);
		}
		assert.strictEqual(await stampOauthClientIdsFor(() => setting, store, quietLogger()), "nothing-to-do");
	});
});
