import { randomBytes } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import * as path from "node:path";
import type * as vscode from "vscode";
import { FINGERPRINT_SALT_SECRET } from "../shared/config/storageKeys";
import type { Logger } from "../shared/logger";
import { initFingerprintSalt } from "../shared/util/fingerprint";

/**
 * Whether the salt fingerprint() is keyed by this session is the stored
 * per-install one ("durable") or a stand-in later sessions will not see
 * ("session-only"). Nothing may act on fingerprints in a way a LATER session
 * must recognize - persisting them, or creating a provider group whose only
 * proof of content is one - while the salt is session-only: the records
 * would match nothing once the real salt is back, which is exactly the
 * permanent wedge the salting must not introduce.
 */
export type FingerprintSaltState = "durable" | "session-only";

/**
 * The session's live view of the salt state. First-run creation is
 * serialized through the atomic filesystem lock in loadFingerprintSalt, so
 * concurrent first activations converge on one salt; confirmDurable() covers
 * what the lock cannot - the stored salt mutating later, from outside that
 * serialization (an external write, a keychain restored mid-session) - by
 * re-reading it at the moment of decision. The state only ever moves
 * durable -> session-only: identities were computed under this session's
 * installed salt from the start, so a salt that was ever unconfirmable
 * stays untrusted for the rest of the session.
 */
export interface FingerprintSaltSession {
	/** The current state without touching the keychain; downgrade-only over time. */
	state(): FingerprintSaltState;
	/**
	 * Re-read the stored salt and report whether it still is this session's
	 * installed one. Call immediately before EACH act a later session must
	 * recognize - each fingerprint-map write, each provider-group seeding
	 * step, the stored-record rewrite - not once per pass: a mutation
	 * detected mid-batch must stop the remaining writes. Never throws: an
	 * unreadable or mismatched store downgrades to session-only, logged once
	 * as a fixed classification.
	 */
	confirmDurable(): Promise<FingerprintSaltState>;
}

/** Tunable only by tests (the waits are real time); production callers take the defaults. */
export interface SaltCreationTimings {
	/** How often a lock loser re-reads SecretStorage waiting for the winner's salt. */
	pollIntervalMs: number;
	/** How long a lock loser waits before degrading to session-only. */
	pollTimeoutMs: number;
	/**
	 * A lock marker older than this belongs to a winner that died before its
	 * store completed (a completed store would have been found by the
	 * pre-lock read). The finding session still degrades - never a second
	 * salt on a guess - but removes the marker so the NEXT session can
	 * create the salt cleanly.
	 */
	staleLockMs: number;
}

const DEFAULT_TIMINGS: SaltCreationTimings = { pollIntervalMs: 150, pollTimeoutMs: 5000, staleLockMs: 60_000 };

/**
 * The first-writer lock: mkdir without recursive is atomic on the local
 * filesystems globalStorage lives on, so exactly one window of a racing
 * first activation creates the salt while the others adopt it. The marker
 * holds no secret; its existence is the whole message.
 */
const LOCK_DIR_NAME = "fingerprint-salt.lock";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Load the per-install fingerprint salt from SecretStorage and install it,
 * before anything computes a fingerprint. The lifecycle rules:
 *
 * - An existing salt is NEVER regenerated: re-keying churns every stored
 *   credential identity at once. Any non-empty stored value is taken as-is.
 * - A salt is generated only when the read SUCCEEDED and found nothing, and
 *   only by the window that atomically acquired the creation lock under
 *   globalStorage; every other window waits for the winner's salt to appear
 *   and adopts it. A failed read must not write: it cannot tell "no salt
 *   yet" from "keychain unavailable", and storing over an existing salt
 *   would be the permanent churn the first rule exists to prevent.
 * - A lock left by a winner that died mid-creation degrades the finding
 *   session to session-only; a marker older than the staleness bound is
 *   removed so the NEXT session can create the salt. A pre-store crash
 *   therefore costs up to two degraded sessions - one that waits out the
 *   still-fresh marker, one that clears the stale one - before a later
 *   session creates the salt. No path guesses its way to a second salt,
 *   and the winner re-reads the store immediately before writing so even
 *   a reclaimed marker's second creator is adopted, never overwritten.
 * - When the read, the store, the confirming read-back, or the lock
 *   machinery fails, the session runs on a salt that is not verifiably the
 *   stored one, reported as session-only: fingerprints still work for the
 *   session (caches, group identities), while everything that would persist
 *   them defers, mirroring how the sync engine treats unreadable secrets -
 *   degrade for the session, retry next session.
 *
 * The salt value never reaches a log line, and neither does ANYTHING read
 * off a foreign error: a hostile SecretStorage failure could echo the
 * stored value even from a property getter, and log lines feed the public
 * issue-report buffer, so every message here is a fixed string and no
 * catch below binds its error.
 *
 * A salt lost outright (keychain wipe, profile reset) is regenerated by the
 * next session as if the install were fresh; every stored sync record then
 * matches nothing and each entry surfaces the actionable name-conflict text
 * until its group is removed natively - the same shape as losing globalState,
 * not a state this module can repair.
 *
 * `install` and `timings` exist for tests only (initFingerprintSalt latches
 * process-global state, and the lock waits are real time); production
 * callers never pass them.
 */
export async function loadFingerprintSalt(
	secrets: vscode.SecretStorage,
	globalStorageUri: vscode.Uri,
	logger: Logger,
	install: (salt: string) => void = initFingerprintSalt,
	timings: Partial<SaltCreationTimings> = {}
): Promise<FingerprintSaltSession> {
	const { pollIntervalMs, pollTimeoutMs, staleLockMs } = { ...DEFAULT_TIMINGS, ...timings };
	const lockPath = path.join(globalStorageUri.fsPath, LOCK_DIR_NAME);

	const makeSession = (salt: string, initial: FingerprintSaltState): FingerprintSaltSession => {
		let state = initial;
		try {
			install(salt);
		} catch {
			// A conflicting earlier init keeps its salt; whatever that salt is,
			// this call could not verify it against the store, so nothing may
			// persist fingerprints on its account.
			logger.log("Installing the fingerprint salt failed; treating the session's salt as session-only");
			state = "session-only";
		}
		return {
			state: () => state,
			confirmDurable: async () => {
				if (state !== "durable") {
					return state;
				}
				let current: string | undefined;
				try {
					current = await secrets.get(FINGERPRINT_SALT_SECRET);
				} catch {
					logger.log("Re-reading the fingerprint salt failed; downgrading the session to session-only");
					state = "session-only";
					return state;
				}
				if (current !== salt) {
					// The store mutated outside the creation lock (an external write,
					// a keychain restored mid-session); its value governs every later
					// session, so nothing may be persisted under this one.
					logger.log("The stored fingerprint salt changed under this session; downgrading to session-only");
					state = "session-only";
				}
				return state;
			},
		};
	};
	const sessionOnly = () => makeSession(randomBytes(32).toString("hex"), "session-only");

	let stored: string | undefined;
	try {
		stored = await secrets.get(FINGERPRINT_SALT_SECRET);
	} catch {
		logger.log("Reading the fingerprint salt from secret storage failed; using a session-only salt");
		return sessionOnly();
	}
	if (stored !== undefined && stored.length > 0) {
		return makeSession(stored, "durable");
	}

	// No salt yet: acquire the creation lock, wait out whoever holds it, or
	// degrade at once when the lock cannot exist at all.
	let acquired = false;
	let holderMayExist = false;
	try {
		await mkdir(globalStorageUri.fsPath, { recursive: true });
		await mkdir(lockPath);
		acquired = true;
	} catch (error) {
		// EEXIST is the one failure that means another window holds the lock;
		// it is worth waiting for. Everything else (an unwritable
		// globalStorage) means nobody can hold it: polling would stall
		// activation for a salt nobody is writing, and generating without the
		// lock would reopen the race, so the session degrades immediately.
		// A node fs error, not a foreign SecretStorage one, so reading its
		// code is safe.
		holderMayExist = (error as NodeJS.ErrnoException).code === "EEXIST";
	}
	if (!acquired && !holderMayExist) {
		logger.log("Creating the fingerprint-salt lock failed; using a session-only salt");
		return sessionOnly();
	}

	if (!acquired) {
		const deadline = Date.now() + pollTimeoutMs;
		while (Date.now() < deadline) {
			await sleep(pollIntervalMs);
			let current: string | undefined;
			try {
				current = await secrets.get(FINGERPRINT_SALT_SECRET);
			} catch {
				logger.log("Reading the fingerprint salt from secret storage failed; using a session-only salt");
				return sessionOnly();
			}
			if (current !== undefined && current.length > 0) {
				// The winner's salt; both windows converge on it.
				return makeSession(current, "durable");
			}
		}
		// No salt arrived: the lock holder is slow or dead. Never a second
		// salt on a guess; a provably stale marker is cleared so the NEXT
		// session can create the salt cleanly.
		try {
			const marker = await stat(lockPath);
			if (Date.now() - marker.mtimeMs > staleLockMs) {
				await rm(lockPath, { recursive: true, force: true });
			}
		} catch {
			// The marker vanished or is unreadable; nothing to clean.
		}
		logger.log("Waiting for another window's fingerprint salt timed out; using a session-only salt");
		return sessionOnly();
	}

	// Winner: generate, store, read back, release. The lock is released on
	// every exit; a crash between store and release is harmless because the
	// stored salt short-circuits every later session before the lock path.
	const releaseLock = async () => {
		try {
			await rm(lockPath, { recursive: true, force: true });
		} catch {
			// A leftover marker only matters while no salt is stored; the
			// staleness bound above reclaims it.
		}
	};
	const generated = randomBytes(32).toString("hex");
	// One more read immediately before the store: a winner whose keychain
	// hangs past the staleness bound can have its marker reclaimed and a
	// second creator installed meanwhile, and its own late store would then
	// overwrite that salt - the one ordering that could break the "never
	// regenerated" rule. A salt that appeared while the lock was held is the
	// stored truth, so it is adopted, not overwritten.
	let appeared: string | undefined;
	try {
		appeared = await secrets.get(FINGERPRINT_SALT_SECRET);
	} catch {
		logger.log("Re-reading the fingerprint salt before storing failed; using a session-only salt");
		await releaseLock();
		return sessionOnly();
	}
	if (appeared !== undefined && appeared.length > 0) {
		await releaseLock();
		return makeSession(appeared, "durable");
	}
	try {
		await secrets.store(FINGERPRINT_SALT_SECRET, generated);
	} catch {
		logger.log("Storing the fingerprint salt failed; identities re-key on the next activation");
		await releaseLock();
		return sessionOnly();
	}
	let readBack: string | undefined;
	try {
		readBack = await secrets.get(FINGERPRINT_SALT_SECRET);
	} catch {
		logger.log("Confirming the stored fingerprint salt failed; using a session-only salt");
		await releaseLock();
		return sessionOnly();
	}
	await releaseLock();
	if (readBack === undefined || readBack.length === 0) {
		// Stored but not readable back: nothing proves what later sessions will
		// see, so this session must not persist fingerprints.
		logger.log("The stored fingerprint salt did not read back; using a session-only salt");
		return sessionOnly();
	}
	return makeSession(readBack, "durable");
}
