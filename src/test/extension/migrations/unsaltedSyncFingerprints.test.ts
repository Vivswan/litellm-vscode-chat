import * as assert from "node:assert";
import { rewriteUnsaltedSyncFingerprints } from "../../../extension/migrations/unsaltedSyncFingerprints";
import {
	buildGroupArgs,
	groupArgsFingerprint,
	legacyGroupArgsFingerprints,
	parseServersSetting,
} from "../../../extension/servers/serverSync";
import { SERVER_SYNC_FINGERPRINTS_KEY, serverSecretsKey } from "../../../shared/config/storageKeys";
import { Logger } from "../../../shared/logger";
import type { FakeExtensionStorage } from "../../testUtils";
import { expectDefined, fakeFingerprintSaltSession, makeExtensionStorage } from "../../testUtils";

function makeLogger(): { logger: Logger; lines: string[] } {
	const lines: string[] = [];
	const logger = new Logger({
		info: (message: string) => lines.push(message),
		error: (message: string) => lines.push(`ERROR: ${message}`),
	});
	return { logger, lines };
}

function run(setting: unknown, storage: FakeExtensionStorage, options: { salt?: "durable" | "session-only" } = {}) {
	const { logger } = makeLogger();
	return {
		outcome: rewriteUnsaltedSyncFingerprints(() => setting, storage.secrets, {
			globalState: storage.memento,
			fingerprintSalt: fakeFingerprintSaltSession(options.salt ?? "durable"),
			logger,
		}),
	};
}

/** The unsalted renderings for one parsed entry, [labeled, pre-label]. */
function renderings(setting: unknown, index = 0, blob: Record<string, string> = {}) {
	const entry = expectDefined(parseServersSetting(setting).entries[index]);
	const args = buildGroupArgs(entry, blob);
	return { args, legacy: legacyGroupArgsFingerprints(args), salted: groupArgsFingerprint(args) };
}

suite("extension/migrations/unsaltedSyncFingerprints", () => {
	const setting = [{ label: "A", baseUrl: "http://a.test", apiKey: "sk-1" }];

	test("rewrites an unsalted labeled record to the salted form, exactly once", async () => {
		const { legacy, salted } = renderings(setting);
		const labeled = expectDefined(legacy[0]);
		const storage = makeExtensionStorage({ [SERVER_SYNC_FINGERPRINTS_KEY]: { A: labeled } });

		assert.strictEqual(await run(setting, storage).outcome, "migrated");
		assert.deepStrictEqual(storage.mementoStore.get(SERVER_SYNC_FINGERPRINTS_KEY), { A: salted });

		// Idempotent rerun: the salted record matches no unsalted rendering, so
		// nothing is detected and nothing is written.
		assert.strictEqual(await run(setting, storage).outcome, "nothing-to-do");
		assert.deepStrictEqual(storage.mementoStore.get(SERVER_SYNC_FINGERPRINTS_KEY), { A: salted });
	});

	test("rewrites an unsalted pre-label record too", async () => {
		const { legacy, salted } = renderings(setting);
		const preLabel = expectDefined(legacy[1]);
		const storage = makeExtensionStorage({ [SERVER_SYNC_FINGERPRINTS_KEY]: { A: preLabel } });

		assert.strictEqual(await run(setting, storage).outcome, "migrated");
		assert.deepStrictEqual(storage.mementoStore.get(SERVER_SYNC_FINGERPRINTS_KEY), { A: salted });
	});

	test("resolves the entry's stored secrets before rendering, like the engine does", async () => {
		const storage = makeExtensionStorage();
		storage.secretStore.set(serverSecretsKey("A"), JSON.stringify({ apiKey: "sk-stored" }));
		const keyless = [{ label: "A", baseUrl: "http://a.test" }];
		const { legacy, salted } = renderings(keyless, 0, { apiKey: "sk-stored" });
		storage.mementoStore.set(SERVER_SYNC_FINGERPRINTS_KEY, { A: expectDefined(legacy[0]) });

		assert.strictEqual(await run(keyless, storage).outcome, "migrated");
		assert.deepStrictEqual(storage.mementoStore.get(SERVER_SYNC_FINGERPRINTS_KEY), { A: salted });
	});

	test("leaves a record that matches neither rendering: the engine's conflict handling owns it", async () => {
		// A record for a configuration that changed while the extension was
		// off is not recomputable; rewriting it to anything would destroy the
		// engine's ability to recognize a later revert.
		const changed = [{ label: "A", baseUrl: "http://a.test", apiKey: "sk-2" }];
		const { legacy } = renderings(setting);
		const stale = expectDefined(legacy[0]);
		const storage = makeExtensionStorage({ [SERVER_SYNC_FINGERPRINTS_KEY]: { A: stale } });

		assert.strictEqual(await run(changed, storage).outcome, "nothing-to-do");
		assert.deepStrictEqual(storage.mementoStore.get(SERVER_SYNC_FINGERPRINTS_KEY), { A: stale });
	});

	test("leaves records whose label has no declared entry: the engine's removal pass owns them", async () => {
		const { legacy } = renderings(setting);
		const orphan = expectDefined(legacy[0]);
		const storage = makeExtensionStorage({ [SERVER_SYNC_FINGERPRINTS_KEY]: { Gone: orphan } });

		assert.strictEqual(await run(setting, storage).outcome, "nothing-to-do");
		assert.deepStrictEqual(storage.mementoStore.get(SERVER_SYNC_FINGERPRINTS_KEY), { Gone: orphan });
	});

	test("a failed secret read skips the entry for the pass and reports in-progress", async () => {
		const { legacy } = renderings(setting);
		const labeled = expectDefined(legacy[0]);
		const storage = makeExtensionStorage({ [SERVER_SYNC_FINGERPRINTS_KEY]: { A: labeled } });
		const failingSecrets = {
			get: async () => {
				throw new Error("secret store failed");
			},
			store: async () => {},
			delete: async () => {},
		};

		const { logger } = makeLogger();
		const outcome = await rewriteUnsaltedSyncFingerprints(() => setting, failingSecrets, {
			globalState: storage.memento,
			fingerprintSalt: fakeFingerprintSaltSession(),
			logger,
		});
		assert.strictEqual(outcome, "in-progress");
		assert.deepStrictEqual(
			storage.mementoStore.get(SERVER_SYNC_FINGERPRINTS_KEY),
			{ A: labeled },
			"the unreadable entry's record stays for the next activation"
		);
	});

	test("defers entirely under a session-only salt: rewriting would persist unmatchable records", async () => {
		const { legacy } = renderings(setting);
		const labeled = expectDefined(legacy[0]);
		const storage = makeExtensionStorage({ [SERVER_SYNC_FINGERPRINTS_KEY]: { A: labeled } });

		assert.strictEqual(await run(setting, storage, { salt: "session-only" }).outcome, "in-progress");
		assert.deepStrictEqual(storage.mementoStore.get(SERVER_SYNC_FINGERPRINTS_KEY), { A: labeled });
	});

	test("a salt mutation detected between the entry gate and the write defers the rewrite", async () => {
		// The salt is re-confirmed immediately before the write: passing the
		// gate at the top of the run proves nothing about the store's state a
		// few reads later.
		const { legacy } = renderings(setting);
		const labeled = expectDefined(legacy[0]);
		const storage = makeExtensionStorage({ [SERVER_SYNC_FINGERPRINTS_KEY]: { A: labeled } });
		const answers: ("durable" | "session-only")[] = ["durable", "session-only"];
		const { logger } = makeLogger();

		const outcome = await rewriteUnsaltedSyncFingerprints(() => setting, storage.secrets, {
			globalState: storage.memento,
			fingerprintSalt: { state: () => "durable", confirmDurable: async () => answers.shift() ?? "session-only" },
			logger,
		});

		assert.strictEqual(outcome, "in-progress");
		assert.deepStrictEqual(
			storage.mementoStore.get(SERVER_SYNC_FINGERPRINTS_KEY),
			{ A: labeled },
			"the records the rewrite exists to protect stay untouched"
		);
	});

	test("no stored map, or a malformed one, is nothing-to-do", async () => {
		assert.strictEqual(await run(setting, makeExtensionStorage()).outcome, "nothing-to-do");
		assert.strictEqual(
			await run(setting, makeExtensionStorage({ [SERVER_SYNC_FINGERPRINTS_KEY]: {} })).outcome,
			"nothing-to-do"
		);
		const malformed = makeExtensionStorage({ [SERVER_SYNC_FINGERPRINTS_KEY]: ["not-a-map"] });
		assert.strictEqual(await run(setting, malformed).outcome, "nothing-to-do");
		assert.deepStrictEqual(malformed.mementoStore.get(SERVER_SYNC_FINGERPRINTS_KEY), ["not-a-map"]);
	});
});
