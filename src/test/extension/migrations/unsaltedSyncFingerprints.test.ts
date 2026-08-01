import * as assert from "node:assert";
import { createHash } from "node:crypto";
import { legacyUnsaltedFingerprint } from "../../../extension/migrations/legacyFingerprint";
import {
	legacyGroupArgsFingerprints,
	rewriteUnsaltedSyncFingerprints,
} from "../../../extension/migrations/unsaltedSyncFingerprints";
import type { ServerSyncEnv } from "../../../extension/servers/serverSync";
import {
	buildGroupArgs,
	GROUP_UPDATE_UNAVAILABLE_MESSAGE,
	groupArgsFingerprint,
	parseServersSetting,
	ServerSyncEngine,
} from "../../../extension/servers/serverSync";
import { SERVER_SYNC_FINGERPRINTS_KEY, serverSecretsKey } from "../../../shared/config/storageKeys";
import { Logger } from "../../../shared/logger";
import { fingerprint } from "../../../shared/util/fingerprint";
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

/**
 * A sync-engine environment sharing the migration's storage, for the
 * failed-migration-window pins: an add-only host whose group already holds
 * every entry's content (each add comes back as the duplicate rejection), a
 * fingerprint map read from and written through the same memento the
 * migration rewrites. `declared` is read live, so a test can mutate the
 * array between passes the way another window edits the setting.
 */
function makeEngineEnv(declared: unknown, storage: FakeExtensionStorage) {
	const hostCalls: string[] = [];
	const env: ServerSyncEnv = {
		readServersSetting: () => declared,
		readSecrets: async () => ({}),
		confirmFingerprintsDurable: async () => true,
		addProviderGroup: async (args) => {
			hostCalls.push(args.name ?? "");
			throw new Error(`Language model group with name ${args.name} already exists for vendor litellm`);
		},
		getFingerprints: () => (storage.mementoStore.get(SERVER_SYNC_FINGERPRINTS_KEY) ?? {}) as Record<string, string>,
		setFingerprints: async (map) => {
			storage.mementoStore.set(SERVER_SYNC_FINGERPRINTS_KEY, { ...map });
		},
		getEntryBaseUrls: () => ({}),
		setEntryBaseUrls: async () => {},
		reconcileEntryIdentities: async () => {},
		log: () => {},
		logError: () => {},
	};
	return { env, hostCalls };
}

suite("extension/migrations/unsaltedSyncFingerprints", () => {
	const setting = [{ label: "A", baseUrl: "http://a.test", apiKey: "sk-1" }];

	test("legacyUnsaltedFingerprint is the pre-salt rendering, byte for byte, and never the salted one", () => {
		// Comparison-only compatibility surface: records persisted by pre-salt
		// versions hold exactly this rendering, so it must never drift - and it
		// must never coincide with the salted identity fingerprint() computes.
		assert.strictEqual(
			legacyUnsaltedFingerprint("some-key"),
			createHash("sha256").update("some-key").digest("hex").slice(0, 32)
		);
		assert.notStrictEqual(fingerprint("some-key"), legacyUnsaltedFingerprint("some-key"));
	});

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

	test("leaves a record that matches neither rendering: a later run owns the reverted entry", async () => {
		// A record for a configuration that changed while the extension was
		// off is not recomputable; rewriting it to anything would destroy the
		// only proof that lets a later run recognize the entry once reverted.
		// Until then the engine surfaces the changed entry's name conflict.
		// Both stale shapes behave alike: the labeled and the pre-label
		// rendering of the OLD configuration.
		const changed = [{ label: "A", baseUrl: "http://a.test", apiKey: "sk-2" }];
		const { legacy } = renderings(setting);
		for (const stale of [expectDefined(legacy[0]), expectDefined(legacy[1])]) {
			const storage = makeExtensionStorage({ [SERVER_SYNC_FINGERPRINTS_KEY]: { A: stale } });

			assert.strictEqual(await run(changed, storage).outcome, "nothing-to-do");
			assert.deepStrictEqual(storage.mementoStore.get(SERVER_SYNC_FINGERPRINTS_KEY), { A: stale });

			// The revert: the entry's content matches the record again, and the
			// next run rewrites it to the salted form.
			assert.strictEqual(await run(setting, storage).outcome, "migrated");
			assert.deepStrictEqual(storage.mementoStore.get(SERVER_SYNC_FINGERPRINTS_KEY), {
				A: renderings(setting).salted,
			});
		}
	});

	test("a salted pre-label rendering is never recognized: no version ever persisted it", async () => {
		// The legacy set is exactly the two renderings pre-salt versions
		// wrote: unsalted with the label and unsalted without it. Pre-label
		// versions were also pre-salt, so a salted label-less record can only
		// be corruption or forgery and must not be rewritten into a record
		// that would confirm the entry as in-sync.
		const { args } = renderings(setting);
		const { label: _label, ...legacyArgs } = args;
		const forged = fingerprint(JSON.stringify(legacyArgs));
		const storage = makeExtensionStorage({ [SERVER_SYNC_FINGERPRINTS_KEY]: { A: forged } });

		assert.strictEqual(await run(setting, storage).outcome, "nothing-to-do");
		assert.deepStrictEqual(storage.mementoStore.get(SERVER_SYNC_FINGERPRINTS_KEY), { A: forged });
	});

	test("a record this migration has not rewritten degrades visibly in the engine, then heals", async () => {
		// The failed-migration window: the engine never recognizes legacy
		// renderings itself, so while a stored pre-salt record awaits its
		// rewrite (a deferred or failed run), the entry classifies as the
		// visible name conflict - and the record is carried, never overwritten,
		// so nothing is destroyed. The next successful migration run rewrites
		// it, and the following engine pass reads as in-sync with no user
		// action.
		const { legacy, salted } = renderings(setting);
		const labeled = expectDefined(legacy[0]);
		const storage = makeExtensionStorage({ [SERVER_SYNC_FINGERPRINTS_KEY]: { A: labeled } });

		const engine = new ServerSyncEngine(makeEngineEnv(setting, storage).env);
		// Unforced and forced passes degrade alike; neither wedges silently.
		await engine.syncNow();
		assert.strictEqual(engine.getDeclared()[0]?.syncError, GROUP_UPDATE_UNAVAILABLE_MESSAGE);
		await engine.syncNow(true);
		assert.strictEqual(engine.getDeclared()[0]?.syncError, GROUP_UPDATE_UNAVAILABLE_MESSAGE);
		assert.deepStrictEqual(
			storage.mementoStore.get(SERVER_SYNC_FINGERPRINTS_KEY),
			{ A: labeled },
			"the unrewritten record is carried as last-known-good, never overwritten"
		);

		assert.strictEqual(await run(setting, storage).outcome, "migrated");
		assert.deepStrictEqual(storage.mementoStore.get(SERVER_SYNC_FINGERPRINTS_KEY), { A: salted });

		// The next activation's engine seeds from the rewritten store: the
		// unforced pass is silent without a host call, and the forced re-add
		// reads the duplicate rejection as the steady state.
		const healed = makeEngineEnv(setting, storage);
		const healedEngine = new ServerSyncEngine(healed.env);
		await healedEngine.syncNow();
		assert.strictEqual(healedEngine.getDeclared()[0]?.syncError, undefined, "the pass after the rewrite heals");
		assert.strictEqual(healed.hostCalls.length, 0, "the rewritten record reads as in-sync without a host call");
		await healedEngine.syncNow(true);
		assert.strictEqual(
			healedEngine.getDeclared()[0]?.syncError,
			undefined,
			"the forced re-add confirms as steady state"
		);
	});

	test("a legacy record another window persisted after the seed survives the blocked pass", async () => {
		// The destructive variant of the failed-migration window: this
		// window's session map has no record for the label (it seeded before
		// another window - or a pre-update session - persisted the legacy
		// record), the host refuses the add as a duplicate, and the record
		// cannot confirm it. The store's record must survive the pass: it is
		// the only migratable proof the next activation's rewrite needs, and
		// dropping it would make the visible error permanent.
		const declared: unknown[] = [];
		const storage = makeExtensionStorage();
		const engine = new ServerSyncEngine(makeEngineEnv(declared, storage).env);
		// Seeds the session map while the store is empty.
		await engine.syncNow();

		const { legacy, salted } = renderings(setting);
		const labeled = expectDefined(legacy[0]);
		storage.mementoStore.set(SERVER_SYNC_FINGERPRINTS_KEY, { A: labeled });
		declared.push(...setting);
		await engine.syncNow();

		assert.strictEqual(engine.getDeclared()[0]?.syncError, GROUP_UPDATE_UNAVAILABLE_MESSAGE);
		assert.deepStrictEqual(
			storage.mementoStore.get(SERVER_SYNC_FINGERPRINTS_KEY),
			{ A: labeled },
			"the foreign legacy record survives the pass-end write"
		);

		assert.strictEqual(await run(setting, storage).outcome, "migrated");
		assert.deepStrictEqual(storage.mementoStore.get(SERVER_SYNC_FINGERPRINTS_KEY), { A: salted });
	});

	test("a malformed sibling value never blocks another label's rewrite", async () => {
		// The engine's acceptance was per-label, so the rewrite must be too:
		// wholesale rejection of the map would strand a valid legacy record
		// behind a sibling this migration does not own. The sibling itself is
		// preserved as-is, like any other foreign shape.
		const { legacy, salted } = renderings(setting);
		const labeled = expectDefined(legacy[0]);
		const storage = makeExtensionStorage({ [SERVER_SYNC_FINGERPRINTS_KEY]: { A: labeled, B: 42 } });

		assert.strictEqual(await run(setting, storage).outcome, "migrated");
		assert.deepStrictEqual(storage.mementoStore.get(SERVER_SYNC_FINGERPRINTS_KEY), { A: salted, B: 42 });
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
