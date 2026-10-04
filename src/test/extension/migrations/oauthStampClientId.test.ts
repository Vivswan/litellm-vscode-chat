import * as assert from "node:assert";
import { stampOauthClientIdsFor } from "../../../extension/migrations/oauthStampClientId";
import type { SecretStore } from "../../../extension/servers/serverSync/secrets";
import { readServerSecretsRecord, updateServerSecret } from "../../../extension/servers/serverSync/secrets";
import { Logger } from "../../../shared/logger";
import type { SecretOwner } from "../../../shared/serverEntry";

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
const CURRENT_STAMP = { tokenUrl: TOKEN_URL, clientId: "cid" };

suite("extension/migrations/oauthStampClientId", () => {
	test("every string stamp on a declared entry's client secret becomes structured; values and structured stamps stay", async () => {
		const rows: {
			label: string;
			owner: SecretOwner | undefined;
			declaresOauth: boolean;
			expected: SecretOwner | undefined;
		}[] = [
			{ label: "legacy", owner: TOKEN_URL, declaresOauth: true, expected: CURRENT_STAMP },
			{ label: "current", owner: CURRENT_STAMP, declaresOauth: true, expected: CURRENT_STAMP },
			{
				label: "foreign",
				owner: "https://other-idp.test/token",
				declaresOauth: true,
				expected: { tokenUrl: "https://other-idp.test/token" },
			},
			{
				label: "collision",
				owner: JSON.stringify([TOKEN_URL, "cid"]),
				declaresOauth: true,
				expected: { tokenUrl: JSON.stringify([TOKEN_URL, "cid"]) },
			},
			{ label: "empty", owner: "", declaresOauth: true, expected: {} },
			{ label: "unstamped", owner: undefined, declaresOauth: true, expected: undefined },
			{ label: "no-oauth", owner: TOKEN_URL, declaresOauth: false, expected: { tokenUrl: TOKEN_URL } },
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
