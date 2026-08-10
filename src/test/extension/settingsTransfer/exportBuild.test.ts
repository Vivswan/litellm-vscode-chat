import * as assert from "node:assert";
import type { StoredServerSecrets } from "../../../extension/servers/serverSync/secrets";
import type { SettingsExportEnv, SettingsExportResult } from "../../../extension/settingsTransfer/exportBuild";
import { buildSettingsExport, declaredEntryLabel } from "../../../extension/settingsTransfer/exportBuild";
import { ALL_SETTING_KEYS, CONFIG_SECTION, SERVERS_SETTING_KEY } from "../../../shared/config/settingSpec";

function env(overrides: Partial<SettingsExportEnv>): SettingsExportEnv {
	return {
		readGlobalSetting: () => undefined,
		readServerSecrets: () => Promise.resolve({}),
		extensionVersion: "0.4.5",
		includeSecrets: false,
		...overrides,
	};
}

function readerFor(values: Readonly<Record<string, unknown>>): (key: string) => unknown {
	return (key) => values[key];
}

suite("extension/settingsTransfer/exportBuild", () => {
	test("the frozen signature", () => {
		const build: (env: SettingsExportEnv) => Promise<SettingsExportResult> = buildSettingsExport;
		assert.strictEqual(typeof build, "function");
	});

	test("declaredEntryLabel mirrors rawDeclaredLabels' per-entry rule", () => {
		assert.strictEqual(declaredEntryLabel({ label: " alpha " }), "alpha");
		assert.strictEqual(declaredEntryLabel({ label: "" }), undefined);
		assert.strictEqual(declaredEntryLabel({ label: "__proto__" }), undefined);
		assert.strictEqual(declaredEntryLabel({ label: 42 }), undefined);
		assert.strictEqual(declaredEntryLabel("not-an-object"), undefined);
	});

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
		assert.strictEqual(result.secretFieldCount, 0);
		assert.strictEqual(result.unmaterializedSecretCount, 0);
	});

	test("an entirely unset configuration exports an empty settings record", async () => {
		const result = await buildSettingsExport(env({}));
		assert.deepStrictEqual(result.envelope.settings, {});
		assert.strictEqual(result.settingCount, 0);
	});

	test("excluding secrets strips every object entry, unlabeled ones included, with no placeholders", async () => {
		const servers = [
			{ label: "A", baseUrl: "http://a.test", auth: { apiKey: "sk-inline" } },
			// No usable label, but its inline secret must still never leak.
			{ baseUrl: "http://b.test", auth: { apiKey: "sk-unlabeled" } },
			// Not a record: no sanitizer for its shape, so it must not ride out.
			["junk-element", { auth: { apiKey: "sk-nested" } }],
		];
		let secretReads = 0;
		const result = await buildSettingsExport(
			env({
				readGlobalSetting: readerFor({ [SERVERS_SETTING_KEY]: servers }),
				readServerSecrets: () => {
					secretReads += 1;
					return Promise.resolve({ apiKey: "from-storage" });
				},
			})
		);
		assert.deepStrictEqual(result.envelope.settings[SERVERS_SETTING_KEY], [
			{ label: "A", baseUrl: "http://a.test" },
			{ baseUrl: "http://b.test" },
		]);
		assert.strictEqual(secretReads, 0, "an exclude-secrets export must never consult SecretStorage");
		assert.strictEqual(result.serverCount, 2);
		assert.strictEqual(result.secretFieldCount, 0);
		const rendered = JSON.stringify(result.envelope);
		for (const sentinel of ["sk-inline", "sk-unlabeled", "sk-nested"]) {
			assert.ok(!rendered.includes(sentinel), `${sentinel} leaked into a no-secrets export`);
		}
	});

	test("including secrets materializes each labeled entry's blob and counts every value in the file", async () => {
		const servers = [
			{ label: "A", baseUrl: "http://a.test" },
			{ label: "B", baseUrl: "http://b.test", auth: { apiKey: "sk-b-inline" } },
			{ baseUrl: "http://c.test", auth: { apiKey: "sk-c-inline" } },
		];
		const blobs: Record<string, StoredServerSecrets> = {
			A: { apiKey: "sk-a-stored", oauthClientSecret: "cs-a-stored" },
			B: { apiKey: "sk-b-stored" },
		};
		const readLabels: string[] = [];
		const result = await buildSettingsExport(
			env({
				includeSecrets: true,
				readGlobalSetting: readerFor({ [SERVERS_SETTING_KEY]: servers }),
				readServerSecrets: (label) => {
					readLabels.push(label);
					return Promise.resolve(blobs[label] ?? {});
				},
			})
		);
		assert.deepStrictEqual(readLabels, ["A", "B"], "only labeled entries have a SecretStorage key to read");
		assert.deepStrictEqual(result.envelope.settings[SERVERS_SETTING_KEY], [
			// A's stored apiKey materializes; its clientSecret has no oauth home.
			{ label: "A", baseUrl: "http://a.test", auth: { apiKey: "sk-a-stored" } },
			// B's inline value wins over its stored one.
			{ label: "B", baseUrl: "http://b.test", auth: { apiKey: "sk-b-inline" } },
			// The unlabeled entry rides as-is; its inline value counts as kept.
			{ baseUrl: "http://c.test", auth: { apiKey: "sk-c-inline" } },
		]);
		assert.strictEqual(result.secretFieldCount, 3);
		assert.strictEqual(result.unmaterializedSecretCount, 1);
		assert.strictEqual(result.serverCount, 3);
	});

	test("a non-array servers value rides only into a with-secrets export; a no-secrets one omits it", async () => {
		const corrupted = { auth: { apiKey: "sk-corrupt" } };
		const withSecrets = await buildSettingsExport(
			env({ includeSecrets: true, readGlobalSetting: readerFor({ [SERVERS_SETTING_KEY]: corrupted }) })
		);
		assert.strictEqual(withSecrets.envelope.settings[SERVERS_SETTING_KEY], corrupted);
		assert.strictEqual(withSecrets.serverCount, 0);
		assert.strictEqual(withSecrets.settingCount, 1);

		const withoutSecrets = await buildSettingsExport(
			env({ readGlobalSetting: readerFor({ [SERVERS_SETTING_KEY]: corrupted }) })
		);
		assert.ok(!(SERVERS_SETTING_KEY in withoutSecrets.envelope.settings));
		assert.strictEqual(withoutSecrets.settingCount, 0);
		assert.ok(!JSON.stringify(withoutSecrets.envelope).includes("sk-corrupt"));
	});

	test("the walk covers exactly ALL_SETTING_KEYS", async () => {
		const seen: string[] = [];
		await buildSettingsExport(
			env({
				readGlobalSetting: (key) => {
					seen.push(key);
					return undefined;
				},
			})
		);
		assert.deepStrictEqual(seen, [...ALL_SETTING_KEYS]);
	});
});
