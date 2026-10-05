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
		includeSecrets: false,
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
		assert.strictEqual(result.secretFieldCount, 0);
		assert.strictEqual(result.unmaterializedSecretCount, 0);
		assert.strictEqual(result.omittedUnsanitizableCount, 0);
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
					return Promise.resolve({ values: { apiKey: "from-storage" }, owners: {} });
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
		assert.strictEqual(result.omittedUnsanitizableCount, 1, "the dropped non-record element is reported, not silent");
		const rendered = JSON.stringify(result.envelope);
		for (const sentinel of ["sk-inline", "sk-unlabeled", "sk-nested"]) {
			assert.ok(!rendered.includes(sentinel), `${sentinel} leaked into a no-secrets export`);
		}
	});

	// A custom Authorization header is settings text to the dashboard and has no SecretStorage slot, so the strip
	// drops it from a no-secrets file; the entry's own virtualKey header names a second credential-bearing header.
	// A headers shape the strip cannot walk is omitted whole, like an uncertifiable auth shape.
	test("excluding secrets strips credential-bearing custom header values; including them counts them", async () => {
		const servers = [
			{
				label: "A",
				baseUrl: "http://a.test",
				auth: { virtualKey: { header: "x-litellm-key", value: "vk-inline" } },
				headers: { Authorization: "Bearer sk-header", "X-LiteLLM-Key": "vk-header", "X-Team": "platform" },
			},
			{ label: "B", baseUrl: "http://b.test", headers: [{ Authorization: "sk-in-an-array" }] },
		];
		const readGlobalSetting = readerFor({ [SERVERS_SETTING_KEY]: servers });
		const excluded = await buildSettingsExport(env({ readGlobalSetting }));
		assert.deepStrictEqual(excluded, {
			envelope: {
				[CONFIG_SECTION]: 1,
				exportedBy: "0.4.5",
				settings: {
					[SERVERS_SETTING_KEY]: [
						{
							label: "A",
							baseUrl: "http://a.test",
							auth: { virtualKey: { header: "x-litellm-key" } },
							headers: { "X-Team": "platform" },
						},
					],
				},
			},
			settingCount: 1,
			serverCount: 1,
			secretFieldCount: 0,
			unmaterializedSecretCount: 0,
			mismatchedSecretCount: 0,
			omittedUnsanitizableCount: 1,
		});
		const included = await buildSettingsExport(env({ includeSecrets: true, readGlobalSetting }));
		assert.deepStrictEqual(included, {
			envelope: { [CONFIG_SECTION]: 1, exportedBy: "0.4.5", settings: { [SERVERS_SETTING_KEY]: servers } },
			settingCount: 1,
			serverCount: 2,
			secretFieldCount: 3,
			unmaterializedSecretCount: 0,
			mismatchedSecretCount: 0,
			omittedUnsanitizableCount: 0,
		});
	});

	// A base URL or token URL written with user:password@ is a credential in a URL field: the no-secrets file
	// carries the URL without it, and the with-secrets file counts it among the values riding out.
	test("excluding secrets strips URL userinfo from every URL field; including them counts each", async () => {
		const servers = [
			{
				label: "A",
				baseUrl: "http://u:export-password@a.test",
				oauthTokenUrl: "http://u:flat-password@idp.test",
				auth: { oauth: { tokenUrl: "http://u:oauth-password@idp.test", clientId: "c" } },
				mcp: { url: "http://u:mcp-password@a.test/mcp" },
			},
		];
		const readGlobalSetting = readerFor({ [SERVERS_SETTING_KEY]: servers });
		const excluded = await buildSettingsExport(env({ readGlobalSetting }));
		assert.deepStrictEqual(excluded, {
			envelope: {
				[CONFIG_SECTION]: 1,
				exportedBy: "0.4.5",
				settings: {
					[SERVERS_SETTING_KEY]: [
						{
							label: "A",
							baseUrl: "http://a.test",
							oauthTokenUrl: "http://idp.test",
							auth: { oauth: { tokenUrl: "http://idp.test", clientId: "c" } },
							mcp: { url: "http://a.test/mcp" },
						},
					],
				},
			},
			settingCount: 1,
			serverCount: 1,
			secretFieldCount: 0,
			unmaterializedSecretCount: 0,
			mismatchedSecretCount: 0,
			omittedUnsanitizableCount: 0,
		});
		const included = await buildSettingsExport(env({ includeSecrets: true, readGlobalSetting }));
		assert.deepStrictEqual(included, {
			envelope: { [CONFIG_SECTION]: 1, exportedBy: "0.4.5", settings: { [SERVERS_SETTING_KEY]: servers } },
			settingCount: 1,
			serverCount: 1,
			secretFieldCount: 4,
			unmaterializedSecretCount: 0,
			mismatchedSecretCount: 0,
			omittedUnsanitizableCount: 0,
		});
		// A container where a URL string belongs could hold a credentialed URL the walk cannot see: omitted, counted.
		const container = await buildSettingsExport(
			env({
				readGlobalSetting: readerFor({
					[SERVERS_SETTING_KEY]: [
						{ label: "B", baseUrl: "http://b.test", mcp: { url: ["http://u:container-password@b.test/mcp"] } },
					],
				}),
			})
		);
		assert.deepStrictEqual(container, {
			envelope: { [CONFIG_SECTION]: 1, exportedBy: "0.4.5", settings: { [SERVERS_SETTING_KEY]: [] } },
			settingCount: 1,
			serverCount: 0,
			secretFieldCount: 0,
			unmaterializedSecretCount: 0,
			mismatchedSecretCount: 0,
			omittedUnsanitizableCount: 1,
		});
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
					return Promise.resolve({ values: blobs[label] ?? {}, owners: {} });
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

	test("a stored value stamped for another destination never materializes into the file", async () => {
		// Materializing it inline would hand the retired credential to the entry's current host on any import: inline
		// values bypass the ownership check, so the export must apply it here instead.
		const servers = [{ label: "A", baseUrl: "http://a.test" }];
		const result = await buildSettingsExport(
			env({
				includeSecrets: true,
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

	test("a non-array servers value rides only into a with-secrets export; a no-secrets one omits it", async () => {
		const corrupted = { auth: { apiKey: "sk-corrupt" } };
		const withSecrets = await buildSettingsExport(
			env({ includeSecrets: true, readGlobalSetting: readerFor({ [SERVERS_SETTING_KEY]: corrupted }) })
		);
		assert.strictEqual(withSecrets.envelope.settings[SERVERS_SETTING_KEY], corrupted);
		assert.strictEqual(withSecrets.serverCount, 0);
		assert.strictEqual(withSecrets.settingCount, 1);
		assert.strictEqual(withSecrets.omittedUnsanitizableCount, 0);

		const withoutSecrets = await buildSettingsExport(
			env({ readGlobalSetting: readerFor({ [SERVERS_SETTING_KEY]: corrupted }) })
		);
		assert.ok(!(SERVERS_SETTING_KEY in withoutSecrets.envelope.settings));
		assert.strictEqual(withoutSecrets.settingCount, 0);
		assert.strictEqual(withoutSecrets.omittedUnsanitizableCount, 1);
		assert.ok(!JSON.stringify(withoutSecrets.envelope).includes("sk-corrupt"));
	});

	test("an entry whose auth shape cannot be certified secret-free is omitted from a no-secrets export", async () => {
		const servers = [
			{ label: "A", baseUrl: "http://a.test", auth: { apiKey: "sk-a" } },
			// A malformed auth container the strip cannot walk; the secret inside it must not ride out of an
			// exclude-secrets export.
			{ label: "B", baseUrl: "http://b.test", auth: [{ apiKey: "sk-hidden" }] },
		];
		const withoutSecrets = await buildSettingsExport(
			env({ readGlobalSetting: readerFor({ [SERVERS_SETTING_KEY]: servers }) })
		);
		assert.deepStrictEqual(withoutSecrets.envelope.settings[SERVERS_SETTING_KEY], [
			{ label: "A", baseUrl: "http://a.test" },
		]);
		assert.strictEqual(withoutSecrets.serverCount, 1);
		assert.strictEqual(withoutSecrets.omittedUnsanitizableCount, 1, "the omitted entry is reported, not silent");
		assert.ok(!JSON.stringify(withoutSecrets.envelope).includes("sk-hidden"));

		const withSecrets = await buildSettingsExport(
			env({ includeSecrets: true, readGlobalSetting: readerFor({ [SERVERS_SETTING_KEY]: servers }) })
		);
		assert.strictEqual(withSecrets.serverCount, 2);
		assert.strictEqual(withSecrets.omittedUnsanitizableCount, 0);
		assert.ok(JSON.stringify(withSecrets.envelope).includes("sk-hidden"));
	});

	test("an entry carrying the pre-redesign flat credential shape exports with the secret stripped", async () => {
		// A flat top-level apiKey maps 1:1 onto the blob's field id, so the no-secrets export keeps the entry and
		// removes the value - the same lossless take the import relies on for old-format files.
		const servers = [
			{ label: "A", baseUrl: "http://a.test", auth: { apiKey: "sk-a" } },
			{ label: "B", baseUrl: "http://b.test", apiKey: "sk-test-flat" },
		];
		const withoutSecrets = await buildSettingsExport(
			env({ readGlobalSetting: readerFor({ [SERVERS_SETTING_KEY]: servers }) })
		);
		assert.deepStrictEqual(withoutSecrets.envelope.settings[SERVERS_SETTING_KEY], [
			{ label: "A", baseUrl: "http://a.test" },
			{ label: "B", baseUrl: "http://b.test" },
		]);
		assert.strictEqual(withoutSecrets.omittedUnsanitizableCount, 0);
		assert.ok(!JSON.stringify(withoutSecrets.envelope).includes("sk-test-flat"));
	});
});
