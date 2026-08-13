import * as assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { SaltCreationTimings } from "../../extension/fingerprintSalt";
import { loadFingerprintSalt } from "../../extension/fingerprintSalt";
import { FINGERPRINT_SALT_SECRET } from "../../shared/config/storageKeys";
import { makeLogger } from "../pureHelpers";
import { failingStorage, makeExtensionStorage } from "../testUtils";

/** Captures what would be installed process-wide; the real installer latches global state. */
function capture(): { install: (salt: string) => void; installed: string[] } {
	const installed: string[] = [];
	return { install: (salt) => installed.push(salt), installed };
}

/** Every tmpdir this file creates, removed in one teardown: mkdtemp cleans up nothing on its own, and these once accumulated in $TMPDIR indefinitely. */
const createdTmpDirs: string[] = [];

function makeTmpDir(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "lvt-salt-"));
	createdTmpDirs.push(dir);
	return dir;
}

/** A fresh globalStorage stand-in per test; the creation lock lives inside it. */
function tmpStorage(): { uri: vscode.Uri; lockPath: string } {
	const dir = makeTmpDir();
	return { uri: vscode.Uri.file(dir), lockPath: path.join(dir, "fingerprint-salt.lock") };
}

const FAST: Partial<SaltCreationTimings> = { pollIntervalMs: 10, pollTimeoutMs: 400 };

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

suite("extension/fingerprintSalt", () => {
	suiteTeardown(() => {
		for (const dir of createdTmpDirs) {
			// Cleanup must never read as a test failure: a transient EPERM/EBUSY
			// on removal loses to the run's verdict (same rule as .vscode-test.mjs).
			try {
				rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
			} catch {
				// A directory that will not delete is a leak, not a failure.
			}
		}
	});

	test("first run: generates a 256-bit hex salt, stores it, and reports durable", async () => {
		const storage = makeExtensionStorage();
		const { uri, lockPath } = tmpStorage();
		const { logger, lines } = makeLogger();
		const { install, installed } = capture();

		const session = await loadFingerprintSalt(storage.secrets, uri, logger, install, FAST);

		assert.strictEqual(session.state(), "durable");
		assert.strictEqual(installed.length, 1);
		const salt = installed[0] ?? "";
		assert.match(salt, /^[0-9a-f]{64}$/);
		assert.strictEqual(storage.secretStore.get(FINGERPRINT_SALT_SECRET), salt, "the installed salt is the stored one");
		assert.strictEqual(existsSync(lockPath), false, "the creation lock is released");
		assert.strictEqual(await session.confirmDurable(), "durable", "the unchanged store confirms");
		assert.ok(!lines.join("\n").includes(salt), "the salt value never reaches a log line");
	});

	test("an existing salt is installed as-is and NEVER regenerated or rewritten", async () => {
		const storage = makeExtensionStorage();
		storage.secretStore.set(FINGERPRINT_SALT_SECRET, "existing-salt");
		let stores = 0;
		const original = storage.secrets.store.bind(storage.secrets);
		(storage.secrets as { store: typeof original }).store = (key, value) => {
			stores += 1;
			return original(key, value);
		};
		const { install, installed } = capture();

		const session = await loadFingerprintSalt(storage.secrets, tmpStorage().uri, makeLogger().logger, install, FAST);

		assert.strictEqual(session.state(), "durable");
		assert.deepStrictEqual(installed, ["existing-salt"], "any non-empty stored value is taken as-is");
		assert.strictEqual(stores, 0, "a run that found a salt writes nothing");
		assert.strictEqual(storage.secretStore.get(FINGERPRINT_SALT_SECRET), "existing-salt");
	});

	test("two racing first activations converge on ONE salt: the loser adopts the winner's", async () => {
		// Both windows share the keychain and the globalStorage directory. The
		// winner acquires the lock and its store is held open until the loser
		// has started polling, so the interleaving the lock exists for really
		// happens: the loser finds no salt, finds the lock, waits, and adopts.
		const storage = makeExtensionStorage();
		const { uri } = tmpStorage();
		let releaseStore!: () => void;
		const storeGate = new Promise<void>((resolve) => {
			releaseStore = resolve;
		});
		const original = storage.secrets.store.bind(storage.secrets);
		const winnerSecrets = {
			...storage.secrets,
			get: storage.secrets.get.bind(storage.secrets),
			delete: storage.secrets.delete.bind(storage.secrets),
			store: async (key: string, value: string) => {
				await storeGate;
				await original(key, value);
			},
		} as unknown as vscode.SecretStorage;

		const winner = capture();
		const loser = capture();
		const winnerLoad = loadFingerprintSalt(winnerSecrets, uri, makeLogger().logger, winner.install, FAST);
		// The winner is now inside its gated store, holding the lock.
		await sleep(30);
		const loserLoad = loadFingerprintSalt(storage.secrets, uri, makeLogger().logger, loser.install, FAST);
		await sleep(30);
		releaseStore();

		const [winnerSession, loserSession] = await Promise.all([winnerLoad, loserLoad]);
		assert.strictEqual(winnerSession.state(), "durable");
		assert.strictEqual(loserSession.state(), "durable");
		assert.strictEqual(winner.installed.length, 1);
		assert.deepStrictEqual(loser.installed, winner.installed, "one salt, adopted by the loser");
		assert.strictEqual(storage.secretStore.get(FINGERPRINT_SALT_SECRET), winner.installed[0]);
	});

	test("an unwritable globalStorage degrades immediately instead of polling for a salt nobody writes", async () => {
		// EEXIST is the one mkdir failure worth waiting on (someone holds the
		// lock); anything else means nobody CAN hold it, and polling would
		// stall activation every session, forever.
		const storage = makeExtensionStorage();
		let reads = 0;
		const original = storage.secrets.get.bind(storage.secrets);
		(storage.secrets as { get: typeof original }).get = (key) => {
			reads += 1;
			return original(key);
		};
		const blocker = path.join(makeTmpDir(), "blocker");
		writeFileSync(blocker, "");
		const uri = vscode.Uri.file(path.join(blocker, "storage"));
		const { install, installed } = capture();

		const session = await loadFingerprintSalt(storage.secrets, uri, makeLogger().logger, install, {
			pollIntervalMs: 10,
			pollTimeoutMs: 10_000,
		});

		assert.strictEqual(session.state(), "session-only");
		assert.strictEqual(installed.length, 1);
		assert.strictEqual(reads, 1, "only the initial read; no polling for a salt nobody is writing");
		assert.strictEqual(storage.secretStore.get(FINGERPRINT_SALT_SECRET), undefined, "nothing is stored unserialized");
	});

	test("a salt appearing while the lock is held is adopted, never overwritten", async () => {
		// The winner re-reads immediately before storing: a winner whose
		// keychain hung past the staleness bound can have its marker reclaimed
		// and a second creator installed meanwhile, and storing now would
		// overwrite that salt - the one ordering that could break the "never
		// regenerated" rule.
		const storage = makeExtensionStorage();
		const { uri, lockPath } = tmpStorage();
		let reads = 0;
		(storage.secrets as { get: (key: string) => Thenable<string | undefined> }).get = async () => {
			reads += 1;
			return reads === 1 ? undefined : "second-creator-salt";
		};
		let stores = 0;
		(storage.secrets as { store: (key: string, value: string) => Thenable<void> }).store = async () => {
			stores += 1;
		};
		const { install, installed } = capture();

		const session = await loadFingerprintSalt(storage.secrets, uri, makeLogger().logger, install, FAST);

		assert.strictEqual(session.state(), "durable");
		assert.deepStrictEqual(installed, ["second-creator-salt"], "the existing salt is adopted");
		assert.strictEqual(stores, 0, "nothing may be stored over it");
		assert.strictEqual(existsSync(lockPath), false, "the lock is released");
	});

	test("a loser that times out degrades to session-only and leaves a fresh lock alone", async () => {
		const storage = makeExtensionStorage();
		const { uri, lockPath } = tmpStorage();
		mkdirSync(lockPath);
		const { install, installed } = capture();

		const session = await loadFingerprintSalt(storage.secrets, uri, makeLogger().logger, install, {
			pollIntervalMs: 10,
			pollTimeoutMs: 60,
		});

		assert.strictEqual(session.state(), "session-only");
		assert.strictEqual(installed.length, 1, "the session still gets a working salt");
		assert.strictEqual(storage.secretStore.get(FINGERPRINT_SALT_SECRET), undefined, "no second salt on a guess");
		assert.strictEqual(existsSync(lockPath), true, "a fresh marker may still belong to a live winner");
	});

	test("a stale marker degrades this session and is cleared so the NEXT session can create the salt", async () => {
		const storage = makeExtensionStorage();
		const { uri, lockPath } = tmpStorage();
		mkdirSync(lockPath);
		const past = new Date(Date.now() - 60_000);
		utimesSync(lockPath, past, past);
		const first = capture();

		const degraded = await loadFingerprintSalt(storage.secrets, uri, makeLogger().logger, first.install, {
			pollIntervalMs: 10,
			pollTimeoutMs: 60,
			staleLockMs: 1000,
		});

		assert.strictEqual(degraded.state(), "session-only", "never a second salt on a guess");
		assert.strictEqual(existsSync(lockPath), false, "the dead winner's marker is reclaimed");

		const second = capture();
		const recovered = await loadFingerprintSalt(storage.secrets, uri, makeLogger().logger, second.install, FAST);
		assert.strictEqual(recovered.state(), "durable", "the next session creates the salt cleanly");
		assert.strictEqual(storage.secretStore.get(FINGERPRINT_SALT_SECRET), second.installed[0]);
	});

	test("the value read back after the store is the one installed", async () => {
		// Inside the lock this covers external mutation between store and
		// read-back; the keychain's current value is what later sessions see,
		// so it is what this session must key by.
		const storage = makeExtensionStorage();
		const original = storage.secrets.store.bind(storage.secrets);
		(storage.secrets as { store: typeof original }).store = async (key, value) => {
			await original(key, value);
			storage.secretStore.set(FINGERPRINT_SALT_SECRET, "externally-written-salt");
		};
		const { install, installed } = capture();

		const session = await loadFingerprintSalt(storage.secrets, tmpStorage().uri, makeLogger().logger, install, FAST);

		assert.strictEqual(session.state(), "durable");
		assert.deepStrictEqual(installed, ["externally-written-salt"], "the read-back value wins over our candidate");
	});

	test("confirmDurable catches a store mutated AFTER load and downgrades for good", async () => {
		// What the creation lock cannot serialize: the stored salt changing
		// later (an external write, a keychain restored mid-session). The
		// downgrade happens at decision time - immediately before anything
		// would persist a fingerprint - and sticks, because identities were
		// computed under the superseded salt all session.
		const storage = makeExtensionStorage();
		const { logger, lines } = makeLogger();
		const { install, installed } = capture();
		const session = await loadFingerprintSalt(storage.secrets, tmpStorage().uri, logger, install, FAST);
		assert.strictEqual(session.state(), "durable");
		const ourSalt = installed[0] ?? "";

		storage.secretStore.set(FINGERPRINT_SALT_SECRET, "other-window-salt");
		assert.strictEqual(await session.confirmDurable(), "session-only");
		assert.strictEqual(session.state(), "session-only", "the downgrade sticks");

		// Even a store restored to this session's salt cannot re-enable
		// persistence: an ever-unconfirmable salt stays untrusted.
		storage.secretStore.set(FINGERPRINT_SALT_SECRET, ourSalt);
		assert.strictEqual(await session.confirmDurable(), "session-only");
		assert.ok(lines.some((line) => line.includes("changed under this session")));
		assert.ok(!lines.join("\n").includes(ourSalt), "the salt value never reaches a log line");
	});

	test("confirmDurable downgrades when the re-read fails, without reading the error", async () => {
		const storage = makeExtensionStorage();
		storage.secretStore.set(FINGERPRINT_SALT_SECRET, "existing-salt");
		const { logger, lines } = makeLogger();
		const session = await loadFingerprintSalt(storage.secrets, tmpStorage().uri, logger, capture().install, FAST);
		(storage.secrets as { get: (key: string) => Thenable<string | undefined> }).get = async () => {
			throw hostileError("keychain read failed: existing-salt");
		};

		assert.strictEqual(await session.confirmDurable(), "session-only");
		assert.ok(!lines.join("\n").includes("existing-salt"), "no part of the foreign error reaches a log line");
	});

	test("a failed read installs a session-only salt and must NOT store it", async () => {
		// A failed read cannot tell "no salt yet" from "keychain unavailable";
		// storing over a possibly existing salt would churn every identity
		// permanently, so the session runs degraded instead.
		const storage = failingStorage(makeExtensionStorage(), {
			failOn: { secretGet: () => new Error("keychain unavailable") },
		});
		const { logger, lines } = makeLogger();
		const { install, installed } = capture();

		const session = await loadFingerprintSalt(storage.secrets, tmpStorage().uri, logger, install, FAST);

		assert.strictEqual(session.state(), "session-only");
		assert.strictEqual(await session.confirmDurable(), "session-only", "session-only never upgrades");
		assert.strictEqual(installed.length, 1, "the session still gets a working salt");
		assert.deepStrictEqual(
			storage.ops.filter((op) => op === "store"),
			[],
			"nothing may be written over a possibly existing salt"
		);
		assert.ok(!lines.join("\n").includes(installed[0] ?? "!"), "the salt value never reaches a log line");
	});

	test("a hostile store error - value echoed in message and name, throwing name getter - never leaks or breaks", async () => {
		const storage = makeExtensionStorage();
		const { uri, lockPath } = tmpStorage();
		(storage.secrets as { store: (key: string, value: string) => Thenable<void> }).store = async (_key, value) => {
			// The worst SecretStorage: the error's message AND name carry the
			// stored value, and reading any OTHER property throws. The loader
			// must log fixed strings only and still land on the degraded path.
			const error = new Error(`keychain refused the value ${value}`);
			error.name = `Refused(${value})`;
			throw new Proxy(error, {
				get(target, prop, receiver) {
					if (prop === "message" || prop === "name") {
						return Reflect.get(target, prop, receiver);
					}
					throw new Error(`property read of ${String(prop)}`);
				},
			});
		};
		const { logger, lines } = makeLogger();
		const { install, installed } = capture();

		const session = await loadFingerprintSalt(storage.secrets, uri, logger, install, FAST);

		assert.strictEqual(session.state(), "session-only", "the degraded path survives a hostile error object");
		assert.strictEqual(installed.length, 1);
		assert.ok(!lines.join("\n").includes(installed[0] ?? "!"), "the salt value never reaches a log line");
		assert.ok(!lines.join("\n").includes("Refused("), "no foreign error property reaches a log line");
		assert.strictEqual(existsSync(lockPath), false, "the lock is released on the failure path");
	});

	test("a store whose read-back fails or comes back empty reports session-only", async () => {
		const failingReadBack = makeExtensionStorage();
		let reads = 0;
		(failingReadBack.secrets as { get: (key: string) => Thenable<string | undefined> }).get = async () => {
			reads += 1;
			if (reads === 1) {
				return undefined;
			}
			throw new Error("keychain read failed");
		};
		const first = capture();
		const failedSession = await loadFingerprintSalt(
			failingReadBack.secrets,
			tmpStorage().uri,
			makeLogger().logger,
			first.install,
			FAST
		);
		assert.strictEqual(failedSession.state(), "session-only");
		assert.strictEqual(first.installed.length, 1);

		const emptyReadBack = makeExtensionStorage();
		const originalStore = emptyReadBack.secrets.store.bind(emptyReadBack.secrets);
		(emptyReadBack.secrets as { store: typeof originalStore }).store = async (key, value) => {
			await originalStore(key, value);
			emptyReadBack.secretStore.delete(FINGERPRINT_SALT_SECRET);
		};
		const second = capture();
		const emptySession = await loadFingerprintSalt(
			emptyReadBack.secrets,
			tmpStorage().uri,
			makeLogger().logger,
			second.install,
			FAST
		);
		assert.strictEqual(emptySession.state(), "session-only");
	});

	test("a failing install degrades to session-only instead of failing activation", async () => {
		const storage = makeExtensionStorage();
		storage.secretStore.set(FINGERPRINT_SALT_SECRET, "existing-salt");
		const { logger, lines } = makeLogger();

		const session = await loadFingerprintSalt(
			storage.secrets,
			tmpStorage().uri,
			logger,
			() => {
				throw new Error("already initialized with a different value");
			},
			FAST
		);

		assert.strictEqual(session.state(), "session-only", "an unverifiable active salt must not enable persistence");
		assert.strictEqual(await session.confirmDurable(), "session-only");
		assert.ok(lines.some((line) => line.includes("Installing the fingerprint salt failed")));
	});
});

/** An Error whose message is readable but every other property access throws. */
function hostileError(message: string): Error {
	const error = new Error(message);
	return new Proxy(error, {
		get(target, prop, receiver) {
			if (prop === "message") {
				return Reflect.get(target, prop, receiver);
			}
			throw new Error(`property read of ${String(prop)}`);
		},
	});
}
