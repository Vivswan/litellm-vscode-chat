import * as assert from "node:assert";
import type { StoredServerSecrets } from "../../../extension/servers/serverSync/secrets";
import type { SettingsExportEnv } from "../../../extension/settingsTransfer/exportBuild";
import { buildSettingsExport } from "../../../extension/settingsTransfer/exportBuild";
import { CONFIG_SECTION, SERVERS_SETTING_KEY } from "../../../shared/config/settingSpec";

function env(overrides: Partial<SettingsExportEnv>): SettingsExportEnv {
	return {
		readGlobalSetting: () => undefined,
		readServerSecrets: () => Promise.resolve({ values: {}, owners: {} }),
		extensionVersion: "0.4.5",
		...overrides,
	};
}

function readerFor(values: Readonly<Record<string, unknown>>): (key: string) => unknown {
	return (key) => values[key];
}

suite("extension/settingsTransfer/exportBuild", () => {
	test("only keys with an explicit globalValue enter the file, and the counts state it", async () => {
		const values = {
			"chat.timeout": 60000,
			"chat.promptCaching": false,
			"models.parameters": { "*": { temperature: 0 } },
		};
		const result = await buildSettingsExport(env({ readGlobalSetting: readerFor(values) }));
		assert.deepStrictEqual(result.envelope.settings, values);
		assert.strictEqual(result.envelope[CONFIG_SECTION], 1);
		assert.strictEqual(result.envelope.exportedBy, "0.4.5");
		assert.strictEqual(result.settingCount, 3);
		assert.strictEqual(result.serverCount, 0);
		assert.strictEqual(result.unmaterializedSecretCount, 0);
	});

	test("an entirely unset configuration exports an empty settings record", async () => {
		const result = await buildSettingsExport(env({}));
		assert.deepStrictEqual(result.envelope.settings, {});
		assert.strictEqual(result.settingCount, 0);
	});

	test("the file is the stored configuration: blobs land at their fields, URLs and inline values ride unchanged", async () => {
		const servers = [
			{ label: "A", baseUrl: "http://user:pass@a.test" },
			{ label: "B", baseUrl: "http://b.test", auth: { apiKey: "sk-b-inline" } },
			{ baseUrl: "http://c.test", auth: { apiKey: "sk-c-inline" } },
			// Not a record: nothing to place, so it rides as stored.
			["junk-element", { auth: { apiKey: "sk-nested" } }],
		];
		const blobs: Record<string, StoredServerSecrets> = {
			A: { apiKey: "sk-a-stored", oauthClientSecret: "cs-a-stored" },
			B: { apiKey: "sk-b-stored" },
		};
		const readLabels: string[] = [];
		const result = await buildSettingsExport(
			env({
				readGlobalSetting: readerFor({ [SERVERS_SETTING_KEY]: servers }),
				readServerSecrets: (label) => {
					readLabels.push(label);
					return Promise.resolve({ values: blobs[label] ?? {}, owners: {} });
				},
			})
		);
		assert.deepStrictEqual(readLabels, ["A", "B"], "only labeled entries have a SecretStorage key to read");
		assert.deepStrictEqual(result.envelope.settings[SERVERS_SETTING_KEY], [
			// A's stored apiKey materializes beside its credentialed URL; its clientSecret has no oauth home.
			{ label: "A", baseUrl: "http://user:pass@a.test", auth: { apiKey: "sk-a-stored" } },
			// B's inline value wins over its stored one.
			{ label: "B", baseUrl: "http://b.test", auth: { apiKey: "sk-b-inline" } },
			{ baseUrl: "http://c.test", auth: { apiKey: "sk-c-inline" } },
			["junk-element", { auth: { apiKey: "sk-nested" } }],
		]);
		assert.strictEqual(result.unmaterializedSecretCount, 1);
		assert.strictEqual(result.serverCount, 4);
		assert.strictEqual(result.settingCount, 1);
	});

	test("a stored value stamped for another destination never materializes into the file", async () => {
		// Materializing it inline would hand the retired credential to the entry's current host on any import: inline
		// values bypass the ownership check, so the export must apply it here instead.
		const servers = [{ label: "A", baseUrl: "http://a.test" }];
		const result = await buildSettingsExport(
			env({
				readGlobalSetting: readerFor({ [SERVERS_SETTING_KEY]: servers }),
				readServerSecrets: () =>
					Promise.resolve({
						values: { apiKey: "sk-retired", virtualKeyValue: "vk-current", oauthClientSecret: "cs-old" },
						owners: {
							apiKey: "http://retired.test",
							virtualKeyValue: "http://a.test",
							oauthClientSecret: "https://old-idp.test/token",
						},
					}),
			})
		);
		assert.deepStrictEqual(result.envelope.settings[SERVERS_SETTING_KEY], [
			// The matching-stamp virtualKeyValue has no header home in this entry, so it counts unmaterialized; the
			// mismatched apiKey is refused.
			{ label: "A", baseUrl: "http://a.test" },
		]);
		// Both stale-stamped fields count mismatched, the inert one included: the oauthClientSecret has no active OAuth
		// unit here, so it refuses nothing (the one wire rule), but its omission from the file must not be silent - the
		// export reads the mismatched superset, not refused.
		assert.strictEqual(result.mismatchedSecretCount, 2);
		assert.strictEqual(result.unmaterializedSecretCount, 1);
		assert.ok(!JSON.stringify(result.envelope).includes("sk-retired"));
		assert.ok(!JSON.stringify(result.envelope).includes("cs-old"), "an inert stale value never rides either");
	});

	test("a non-array servers value rides as stored and counts as a setting, not a server", async () => {
		const corrupted = { auth: { apiKey: "sk-corrupt" } };
		const result = await buildSettingsExport(
			env({ readGlobalSetting: readerFor({ [SERVERS_SETTING_KEY]: corrupted }) })
		);
		assert.strictEqual(result.envelope.settings[SERVERS_SETTING_KEY], corrupted);
		assert.strictEqual(result.serverCount, 0);
		assert.strictEqual(result.settingCount, 1);
	});
});
