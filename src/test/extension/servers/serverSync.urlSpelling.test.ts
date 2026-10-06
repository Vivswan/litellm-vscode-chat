import * as assert from "node:assert";
import { parseServersSetting, serverSettingReports } from "../../../extension/servers/serverSync";
import {
	readServerSecretsRecord,
	resolveOwnedSecrets,
	updateServerSecret,
} from "../../../extension/servers/serverSync/secrets";
import { makeSecretStore } from "./serverSyncHelpers";

/**
 * The incident class behind PRs #448 and #450: every downstream surface had to scrub each spelling of a configured
 * URL separately. Here the parser settles it once: a spelling the WHATWG parser accepts is stored canonically, one it
 * refuses is a reject that keeps its label and typed text, which is what the dashboard needs to draw the misconfigured
 * row (dashboard/state.ts rejectsWithOwnRow) and what the removal detector needs to infer no removal.
 */
suite("servers setting: URL spellings", () => {
	test("a typed base URL is stored canonically or rejected by field, with the row's label and text kept", () => {
		const accepted: [string, string][] = [
			["HTTP://User:Pa ss@Host:4000/", "http://User:Pa%20ss@host:4000"],
			["http:user:pass@host", "http://user:pass@host"],
		];
		for (const [typed, canonical] of accepted) {
			const { entries, problems } = parseServersSetting([{ label: "A", baseUrl: typed }]);
			assert.deepStrictEqual(problems, [], typed);
			assert.strictEqual(entries[0]?.baseUrl, canonical, typed);
		}

		const refused = [{ label: "A", baseUrl: "http://user:pa/ss@host" }];
		const { entries, problems } = parseServersSetting(refused);
		assert.deepStrictEqual(entries, []);
		assert.deepStrictEqual(problems, [
			"entry 1 has a baseUrl that is not a URL with a host; the entry is not used until it is fixed",
		]);
		const [report] = serverSettingReports(refused);
		assert.deepStrictEqual(
			{ label: report?.label, baseUrl: report?.baseUrl, accepted: report?.accepted },
			{ label: "A", baseUrl: "http://user:pa/ss@host", accepted: false }
		);
	});

	test("a secret stamped under the typed spelling still pairs with the entry the parser now reads canonically", async () => {
		// The stamp decoder and the parser must agree on the spelling, or every pre-upgrade stamp (and every stamp a
		// settings-import undo restores) would refuse its own entry.
		const secrets = makeSecretStore();
		await updateServerSecret(secrets, "A", "apiKey", "sk-a", "HTTP://Host:4000");
		await updateServerSecret(secrets, "A", "oauthClientSecret", "cs-a", {
			tokenUrl: "HTTPS://IdP.test/token",
			clientId: "cid",
		});
		const [entry] = parseServersSetting([
			{
				label: "A",
				baseUrl: "HTTP://Host:4000/",
				auth: { oauth: { tokenUrl: "HTTPS://IdP.test/token", clientId: "cid" } },
			},
		]).entries;
		assert.ok(entry);
		const owned = resolveOwnedSecrets(entry, await readServerSecretsRecord(secrets, "A"));
		assert.deepStrictEqual(owned, {
			values: { apiKey: "sk-a", oauthClientSecret: "cs-a" },
			refused: [],
			mismatched: [],
		});

		// A pre-0.6.7 stamp (the token URL alone, as typed) pairs the moment the entry is accepted: no activation-time
		// migration stands between a fixed entry and its own client secret.
		await updateServerSecret(secrets, "L", "oauthClientSecret", "cs-l", "HTTPS://IdP.test/token");
		const [legacy] = parseServersSetting([
			{
				label: "L",
				baseUrl: "http://l.test",
				auth: { oauth: { tokenUrl: "HTTPS://IdP.test/token", clientId: "cid" } },
			},
		]).entries;
		assert.ok(legacy);
		assert.deepStrictEqual(resolveOwnedSecrets(legacy, await readServerSecretsRecord(secrets, "L")).values, {
			oauthClientSecret: "cs-l",
		});

		// A stamp the old identity rule left ending in a space (the slash after it was stripped) still names the path
		// with the space, not the path without it.
		await updateServerSecret(secrets, "S", "apiKey", "sk-s", "http://host.test/a ");
		const [spaced] = parseServersSetting([{ label: "S", baseUrl: "http://host.test/a /" }]).entries;
		const [plain] = parseServersSetting([{ label: "S", baseUrl: "http://host.test/a" }]).entries;
		assert.ok(spaced && plain);
		const record = await readServerSecretsRecord(secrets, "S");
		assert.deepStrictEqual(resolveOwnedSecrets(spaced, record).values, { apiKey: "sk-s" });
		assert.deepStrictEqual(resolveOwnedSecrets(plain, record).refused, ["apiKey"]);
	});
});
