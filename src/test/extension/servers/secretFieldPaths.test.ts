import * as assert from "node:assert";
import { inlineSecretValues } from "../../../extension/servers/serverSync/secrets";
import { parseServersSetting } from "../../../extension/servers/serverSync/setting";
import { Logger } from "../../../shared/logger";
import { SECRET_FIELD_IDS, SECRET_FIELD_NESTED_PATHS } from "../../../shared/serverEntry";
import { collectableEntries, collectKnownSecretValues, KnownSecrets } from "../../../shared/util/knownSecrets";

/** A raw entry that is a valid form around `path`, with `value` placed at the path's end. */
function entryWithSecretAt(path: readonly string[], value: string): Record<string, unknown> {
	const entry: Record<string, unknown> = { label: "T", baseUrl: "http://one.test" };
	let node = entry;
	for (const segment of path.slice(0, -1)) {
		const child: Record<string, unknown> = {};
		// The forms' required companions, so the parser accepts the position.
		if (segment === "oauth") {
			Object.assign(child, { tokenUrl: "http://idp.test/token", clientId: "client" });
		}
		if (segment === "virtualKey") {
			Object.assign(child, { header: "X-Virtual" });
		}
		node[segment] = child;
		node = child;
	}
	node[path[path.length - 1] as string] = value;
	return entry;
}

suite("shared/serverEntry SECRET_FIELD_NESTED_PATHS", () => {
	test("every nested position in the table is a position the settings parser reads as that secret field", () => {
		// The parser assigns secret values through the table and the collector receives the parsed fields; a position
		// the parser read outside the table would be a secret field this test never saw assigned.
		const seen: Record<string, string | undefined> = {};
		for (const field of SECRET_FIELD_IDS) {
			for (const path of SECRET_FIELD_NESTED_PATHS[field]) {
				const marker = `marker-${path.join("-")}-Q7`;
				const parsed = parseServersSetting([entryWithSecretAt(path, marker)]);
				assert.deepStrictEqual(parsed.problems, [], path.join("."));
				const entry = parsed.entries[0];
				assert.ok(entry !== undefined, path.join("."));
				seen[path.join(".")] = inlineSecretValues(entry)[field];
			}
		}
		assert.deepStrictEqual(seen, {
			"auth.apiKey": "marker-auth-apiKey-Q7",
			"auth.oauth.apiKey": "marker-auth-oauth-apiKey-Q7",
			"auth.oauth.clientSecret": "marker-auth-oauth-clientSecret-Q7",
			"auth.virtualKey.value": "marker-auth-virtualKey-value-Q7",
			"auth.oauth.virtualKey.value": "marker-auth-oauth-virtualKey-value-Q7",
		});
	});

	test("every raw record is read through the parser's readers: trimmed names, nested values, every URL", () => {
		// A raw ' X-Tenant ' reads as the carrier 'X-Tenant' the transport sends, and the value under a padded
		// custom-header key is the value under its normalized name.
		const entries = collectableEntries([
			{
				label: "T",
				baseUrl: "http://user:base-Q7@one.test",
				mcp: { url: "http://u:mcp-Q7@one.test/mcp" },
				auth: {
					oauth: {
						tokenUrl: "http://u:token-Q7@idp.test",
						clientId: "c",
						virtualKey: { header: " X-Tenant ", value: "Bearer vk-Q7" },
					},
				},
				headers: { " X-Gateway-Token ": "gateway-Q7", "X-Tenant": "tenant-Q7", "Content-Type": "application/json" },
			},
		]);
		assert.deepStrictEqual(collectKnownSecretValues(entries, ["stored-Q7"]), [
			"Bearer vk-Q7",
			"user",
			"base-Q7",
			"user:base-Q7",
			"u",
			"token-Q7",
			"u:token-Q7",
			"mcp-Q7",
			"u:mcp-Q7",
			"gateway-Q7",
			"tenant-Q7",
			"stored-Q7",
		]);
	});

	test("every string at every secret position is a value: position losers and discarded headers included", () => {
		// The parser keeps one apiKey (the nested one wins) and one header per normalized name; the flat key is still in
		// the setting, quoted here as the baseUrl, and a header the normalizer discards still rode in the setting.
		const raw = [
			{
				label: "Broken",
				baseUrl: "plain-key-Q7",
				auth: { apiKey: "plain-key-Q7", oauth: { apiKey: "nested-key-Q7" } },
				headers: {
					Authorization: "Bearer first-Q7",
					authorization: "Bearer second-Q7",
					"X Token Spaced": "spaced-Q7",
					"X-Token": "crlf\r\n-Q7",
					"Content-Type": "application/json",
				},
			},
		];
		assert.deepStrictEqual(collectKnownSecretValues(collectableEntries(raw), []), [
			"plain-key-Q7",
			"nested-key-Q7",
			"Bearer first-Q7",
			"Bearer second-Q7",
			"spaced-Q7",
			"crlf\r\n-Q7",
		]);
		const secrets = new KnownSecrets();
		secrets.set(collectKnownSecretValues(collectableEntries(raw), []));
		assert.strictEqual(
			secrets.redact("configured baseUrl plain-key-Q7 beside nested-key-Q7, second-Q7 and spaced-Q7"),
			"configured baseUrl [redacted] beside [redacted], [redacted] and [redacted]"
		);
	});

	test("a header named __proto__ is an own entry of the inventory, never the inherited setter's victim", () => {
		// JSON.parse yields an own "__proto__" property; a plain accumulator would hand its value to the setter.
		const raw: unknown = JSON.parse(
			'[{"label":"Broken","baseUrl":"plain-proto-key-Q8","virtualKeyHeader":"__proto__",' +
				'"headers":{"__proto__":"plain-proto-key-Q8"}}]'
		);
		const values = collectKnownSecretValues(collectableEntries(raw), []);
		const secrets = new KnownSecrets();
		secrets.set(values);
		assert.deepStrictEqual(
			{ values, rendered: secrets.redact("baseUrl: plain-proto-key-Q8") },
			{ values: ["plain-proto-key-Q8"], rendered: "baseUrl: [redacted]" }
		);
	});

	test("a rejected entry's credentials are known: the parser refuses it, its readers still read the values", () => {
		// An apiKey beside auth.oauth is an auth conflict the parser rejects; the key is in the setting all the same,
		// and the first line that quotes it must not show it.
		const rejected = [{ label: "Prod", baseUrl: "plain-key-Q7", auth: { apiKey: "plain-key-Q7", oauth: {} } }];
		assert.deepStrictEqual(parseServersSetting(rejected).entries, []);
		const secrets = new KnownSecrets();
		secrets.set(collectKnownSecretValues(collectableEntries(rejected), []));
		const lines: string[] = [];
		const error = new Error("boom");
		error.stack = "Error: boom\n    at real (x.ts:1:1)";
		new Logger({ info: (m) => lines.push(m), error: (m) => lines.push(m) }, undefined, secrets).error(
			"rejected plain-key-Q7",
			error
		);
		assert.deepStrictEqual(lines, ["rejected [redacted]: boom", "Stack trace: Error: boom\n    at real (x.ts:1:1)"]);
	});
});
