import * as assert from "node:assert";
import { canonicalizeUrlSpellingsFor } from "../../../extension/migrations/canonicalUrlSpellings";
import { buildGroupArgs, groupArgsFingerprint, ServerSyncEngine } from "../../../extension/servers/serverSync/engine";
import { readServerSecretsRecord, updateServerSecret } from "../../../extension/servers/serverSync/secrets";
import { parseServersSetting } from "../../../extension/servers/serverSync/setting";
import type { ServersSettingStore } from "../../../extension/settingsWriteTurn";
import { settingValueOf } from "../../../extension/settingsWriteTurn";
import { VENDOR_ID } from "../../../shared/config/commandIds";
import { SERVER_SYNC_FINGERPRINTS_KEY } from "../../../shared/config/storageKeys";
import { Logger } from "../../../shared/logger";
import { makeSecretStore, makeSyncEnv } from "../servers/serverSyncHelpers";

const quietLogger = () => new Logger({ info: () => {}, error: () => {} });

/** The "i1:" record the engine persists for an entry spelled as `setting` spells it. */
function identityPrint(setting: unknown, label: string): string {
	const entry = parseServersSetting(setting).entries.find((candidate) => candidate.label === label);
	assert.ok(entry, `entry ${label} must parse`);
	return groupArgsFingerprint(buildGroupArgs(entry, {}));
}

/** The record the previous engine persisted: the identity args over the user's own spelling, handed through untouched. */
function legacySpellingPrint(label: string, baseUrl: string): string {
	return groupArgsFingerprint({ name: label, vendor: VENDOR_ID, baseUrl, label });
}

interface FakeMemento {
	writes: number;
	/** Runs inside every update, before the write lands: the hook a concurrent edit rides in on. */
	onUpdate?: (() => void) | undefined;
	get(key: string): unknown;
	update(key: string, value: unknown): Promise<void>;
}

function makeMemento(initial: Record<string, unknown>): FakeMemento {
	const map = new Map<string, unknown>(Object.entries(initial));
	const memento: FakeMemento = {
		writes: 0,
		get: (key) => map.get(key),
		update: async (key, value) => {
			memento.onUpdate?.();
			map.set(key, value);
			memento.writes += 1;
		},
	};
	return memento;
}

interface FakeSettings extends ServersSettingStore {
	value: unknown;
	writes: number;
}

function makeSettings(value: unknown): FakeSettings {
	const settings: FakeSettings = {
		value,
		writes: 0,
		readServersSetting: () => settings.value,
		writeServersSetting: async (write) => {
			settings.writes += 1;
			settings.value = settingValueOf(write);
		},
	};
	return settings;
}

suite("extension/migrations/canonicalUrlSpellings", () => {
	const typed = [
		{ label: "Prod", baseUrl: "HTTP://Host:4000/", mcp: { url: "HTTPS://GW.example/mcp" } },
		{
			label: "IdP",
			baseUrl: "http://idp-host.test",
			auth: { oauth: { tokenUrl: "HTTPS://IdP.test/token", clientId: "cid" } },
		},
		{ label: "Fine", baseUrl: "http://fine.test", auth: { apiKey: "sk" } },
		{ label: "Stale", baseUrl: "HTTP://Stale.test" },
		{ label: "Broken", baseUrl: "localhost:4000" },
		// Rejected (an oauth unit missing its clientId) and shadowed (a second "Fine"): their fingerprints can only be
		// carried once they are accepted, so their typed spelling must survive until then.
		{ label: "Partial", baseUrl: "HTTP://Partial.test", auth: { oauth: { tokenUrl: "https://idp.test/token" } } },
		{ label: "Fine", baseUrl: "HTTP://Shadow.test" },
	];
	const canonical = [
		{ label: "Prod", baseUrl: "http://host:4000", mcp: { url: "https://gw.example/mcp" } },
		{
			label: "IdP",
			baseUrl: "http://idp-host.test",
			auth: { oauth: { tokenUrl: "https://idp.test/token", clientId: "cid" } },
		},
		{ label: "Fine", baseUrl: "http://fine.test", auth: { apiKey: "sk" } },
		{ label: "Stale", baseUrl: "http://stale.test" },
		{ label: "Broken", baseUrl: "localhost:4000" },
		{ label: "Partial", baseUrl: "HTTP://Partial.test", auth: { oauth: { tokenUrl: "https://idp.test/token" } } },
		{ label: "Fine", baseUrl: "HTTP://Shadow.test" },
	];

	test("an accepted entry's spelling is rewritten once and its fingerprint follows; the first pass then reads it as in-sync", async () => {
		const memento = makeMemento({
			[SERVER_SYNC_FINGERPRINTS_KEY]: {
				Prod: legacySpellingPrint("Prod", "HTTP://Host:4000/"),
				IdP: legacySpellingPrint("IdP", "http://idp-host.test"),
				Fine: identityPrint(typed, "Fine"),
				Stale: "i1:written-for-some-other-configuration",
			},
		});
		const settings = makeSettings(typed);

		assert.strictEqual(await canonicalizeUrlSpellingsFor(settings, memento, quietLogger()), "migrated");

		assert.deepStrictEqual(settings.value, canonical, "accepted entries are respelled; nothing else moves");
		assert.deepStrictEqual(memento.get(SERVER_SYNC_FINGERPRINTS_KEY), {
			Prod: identityPrint(canonical, "Prod"),
			IdP: identityPrint(canonical, "IdP"),
			Fine: identityPrint(canonical, "Fine"),
			Stale: "i1:written-for-some-other-configuration",
		});

		const writesAfterFirstRun = memento.writes;
		assert.strictEqual(await canonicalizeUrlSpellingsFor(settings, memento, quietLogger()), "nothing-to-do");
		assert.strictEqual(memento.writes, writesAfterFirstRun, "the second run writes nothing");
		assert.strictEqual(settings.writes, 1, "the second run rewrites nothing");

		// Secrets stamped under the typed spellings pair without any carry, the rejected entry's included once it is
		// fixed in the same session; only the never-synced entry and the record matching neither spelling reach the
		// host, and the engine's own pass rewrites the identity ledger canonically.
		const secrets = makeSecretStore();
		await updateServerSecret(secrets, "Prod", "apiKey", "sk-prod", "HTTP://Host:4000");
		await updateServerSecret(secrets, "IdP", "oauthClientSecret", "cs-idp", {
			tokenUrl: "HTTPS://IdP.test/token",
			clientId: "cid",
		});
		await updateServerSecret(secrets, "Partial", "apiKey", "sk-partial", "HTTP://Partial.test");
		const fixed = canonical.map((entry) =>
			entry.label === "Partial"
				? { ...entry, auth: { oauth: { tokenUrl: "https://idp.test/token", clientId: "cid" } } }
				: entry
		);
		const recorded = makeSyncEnv(fixed);
		recorded.fingerprints = memento.get(SERVER_SYNC_FINGERPRINTS_KEY) as Record<string, string>;
		recorded.entryBaseUrls = { Prod: "HTTP://Host:4000", Fine: "http://fine.test" };
		for (const label of ["Prod", "IdP", "Partial"]) {
			const record = await readServerSecretsRecord(secrets, label);
			recorded.secrets[label] = record.values;
			recorded.secretOwners[label] = record.owners;
		}
		const engine = new ServerSyncEngine(recorded.env);
		await engine.syncNow();
		assert.deepStrictEqual(recorded.upserts.map((args) => args.name).sort(), ["Partial", "Stale"]);
		const views = Object.fromEntries(engine.getDeclared().map((view) => [view.label, view]));
		assert.strictEqual(views.Prod?.syncFailure, undefined);
		assert.strictEqual(views.Prod?.secrets.apiKey, "secure");
		assert.strictEqual(views.IdP?.secrets.oauthClientSecret, "secure");
		assert.strictEqual(views.Partial?.secrets.apiKey, "secure");
		assert.strictEqual(views.Broken, undefined, "a URL with no canonical spelling stays a parser reject");
		assert.strictEqual(recorded.entryBaseUrls.Prod, "http://host:4000");
	});

	test("the fingerprint is carried before the setting is written, and a setting edited meanwhile is left for the next activation", async () => {
		const memento = makeMemento({
			[SERVER_SYNC_FINGERPRINTS_KEY]: { Prod: legacySpellingPrint("Prod", "HTTP://Host:4000/") },
		});
		const settings = makeSettings([typed[0]]);
		const edited = [
			{ ...typed[0], discovery: { declared: ["gpt-4"] } },
			{ label: "B", baseUrl: "http://b.test" },
		];
		memento.onUpdate = () => {
			settings.value = edited;
		};

		assert.strictEqual(await canonicalizeUrlSpellingsFor(settings, memento, quietLogger()), "in-progress");
		assert.deepStrictEqual(settings.value, edited, "the concurrent edit is not overwritten");
		assert.deepStrictEqual(memento.get(SERVER_SYNC_FINGERPRINTS_KEY), { Prod: identityPrint(canonical, "Prod") });

		memento.onUpdate = undefined;
		assert.strictEqual(await canonicalizeUrlSpellingsFor(settings, memento, quietLogger()), "migrated");
		assert.deepStrictEqual(settings.value, [
			{ ...canonical[0], discovery: { declared: ["gpt-4"] } },
			{ label: "B", baseUrl: "http://b.test" },
		]);
	});
});
