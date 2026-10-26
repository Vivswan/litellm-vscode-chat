import { randomBytes } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type * as vscode from "vscode";
import { FINGERPRINT_SALT_SECRET } from "../shared/config/storageKeys";
import type { Logger } from "../shared/logger";
import { initFingerprintSalt } from "../shared/util/fingerprint";

/**
 * Whether the salt fingerprint() is keyed by is the stored per-install one ("durable") or a stand-in later sessions
 * will not see ("session-only"). While it is session-only, nothing may act on fingerprints in a way a LATER session
 * must recognize - persisting them, or creating a provider group whose only proof of content is one - because those
 * records would match nothing once the real salt is back.
 */
export type FingerprintSaltState = "durable" | "session-only";

/**
 * confirmDurable() covers what the creation lock cannot - the stored salt mutating later from outside that
 * serialization - by re-reading at the moment of decision.
 * The state only ever moves durable -> session-only.
 */
export interface FingerprintSaltSession {
	/** The current state without touching the keychain; downgrade-only over time. */
	state(): FingerprintSaltState;

	/**
	 * Call immediately before EACH act a later session must recognize, not once per pass: a mutation detected mid-batch
	 * must stop the remaining writes. Never throws; an unreadable or mismatched store downgrades to session-only.
	 */
	confirmDurable(): Promise<FingerprintSaltState>;
}

export interface SaltCreationTimings {
	/** How often a session that lost the creation lock re-reads the store for the winner's salt. */
	pollIntervalMs: number;

	/** How long that session polls before giving up and degrading to session-only. */
	pollTimeoutMs: number;

	/** Past this a lock is stale: the finder still degrades, never guessing a salt, but clears it for the next one. */
	staleLockMs: number;
}

/** Production timings; tests pass shorter ones. */
const DEFAULT_TIMINGS: SaltCreationTimings = { pollIntervalMs: 150, pollTimeoutMs: 5000, staleLockMs: 60_000 };

/** The first-writer lock, an empty marker: mkdir without `recursive` is atomic where globalStorage lives. */
const LOCK_DIR_NAME = "fingerprint-salt.lock";

/** readStoredSalt's answer when the store threw, as opposed to holding nothing. */
const UNREADABLE = Symbol("unreadable");

/**
 * The one SecretStorage read, so no catch here binds the error: a hostile failure could echo the salt through a
 * property getter into the public issue-report buffer, and every log line a caller writes for it is a fixed string
 * for the same reason.
 */
async function readStoredSalt(secrets: vscode.SecretStorage): Promise<string | undefined | typeof UNREADABLE> {
	let value: string | undefined;
	try {
		value = await secrets.get(FINGERPRINT_SALT_SECRET);
	} catch {
		return UNREADABLE;
	}
	return value !== undefined && value.length > 0 ? value : undefined;
}

/** What a session is built from: the store it re-reads, the salt installer, and the fixed-string log. */
interface SaltSessionDeps {
	readonly secrets: vscode.SecretStorage;
	readonly logger: Logger;
	readonly install: (salt: string) => void;
}

/**
 * A session over one salt: install it, then answer state() and confirmDurable() from it. A conflicting earlier init
 * keeps its salt; this call could not verify it against the store, so nothing may persist fingerprints.
 */
function createSaltSession(salt: string, initial: FingerprintSaltState, deps: SaltSessionDeps): FingerprintSaltSession {
	let state = initial;
	try {
		deps.install(salt);
	} catch {
		deps.logger.log("Installing the fingerprint salt failed; treating the session's salt as session-only");
		state = "session-only";
	}
	return {
		state: () => state,
		confirmDurable: async () => {
			if (state !== "durable") {
				return state;
			}
			const current = await readStoredSalt(deps.secrets);
			if (current === UNREADABLE) {
				deps.logger.log("Re-reading the fingerprint salt failed; downgrading the session to session-only");
				state = "session-only";
			} else if (current !== salt) {
				// The store mutated outside the creation lock; its value governs every later session, so nothing
				// may be persisted under this one.
				deps.logger.log("The stored fingerprint salt changed under this session; downgrading to session-only");
				state = "session-only";
			}
			return state;
		},
	};
}

/** A fresh salt no later session will see. */
function sessionOnlySalt(deps: SaltSessionDeps): FingerprintSaltSession {
	return createSaltSession(randomBytes(32).toString("hex"), "session-only", deps);
}

/**
 * Take the first-writer lock. EEXIST is the one failure that means another window holds it ("held"); everything else
 * means nobody can hold it ("failed"), and polling would stall activation for a salt nobody is writing. The error is a
 * node fs one, not a foreign SecretStorage one, so reading its code is safe.
 */
async function acquireSaltLock(
	globalStorageUri: vscode.Uri,
	lockPath: string
): Promise<"acquired" | "held" | "failed"> {
	try {
		await mkdir(globalStorageUri.fsPath, { recursive: true });
		await mkdir(lockPath);
		return "acquired";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EEXIST" ? "held" : "failed";
	}
}

/**
 * The loser's wait: poll the store for the winner's salt until the timeout. No salt arriving means the lock holder is
 * slow or dead; never a second salt on a guess, but a provably stale marker is cleared for the next session.
 */
async function awaitWinnersSalt(
	lockPath: string,
	timings: SaltCreationTimings,
	deps: SaltSessionDeps
): Promise<FingerprintSaltSession> {
	const deadline = Date.now() + timings.pollTimeoutMs;
	while (Date.now() < deadline) {
		await sleep(timings.pollIntervalMs);
		const current = await readStoredSalt(deps.secrets);
		if (current === UNREADABLE) {
			deps.logger.log("Reading the fingerprint salt from secret storage failed; using a session-only salt");
			return sessionOnlySalt(deps);
		}
		if (current !== undefined) {
			return createSaltSession(current, "durable", deps);
		}
	}

	try {
		const marker = await stat(lockPath);
		if (Date.now() - marker.mtimeMs > timings.staleLockMs) {
			await rm(lockPath, { recursive: true, force: true });
		}
	} catch {
		// The marker vanished or is unreadable; nothing to clean.
	}
	deps.logger.log("Waiting for another window's fingerprint salt timed out; using a session-only salt");
	return sessionOnlySalt(deps);
}

/**
 * The winner's path: generate, store, read back, release. One more read comes immediately before the store, because a
 * winner whose keychain hangs past the staleness bound can have its marker reclaimed and a second creator installed
 * meanwhile, and its own late store would then overwrite that salt.
 */
async function createDurableSalt(lockPath: string, deps: SaltSessionDeps): Promise<FingerprintSaltSession> {
	const releaseLock = async () => {
		try {
			await rm(lockPath, { recursive: true, force: true });
		} catch {
			// A leftover marker only matters while no salt is stored; the staleness bound reclaims it.
		}
	};
	const generated = randomBytes(32).toString("hex");
	const appeared = await readStoredSalt(deps.secrets);
	if (appeared === UNREADABLE) {
		deps.logger.log("Re-reading the fingerprint salt before storing failed; using a session-only salt");
		await releaseLock();
		return sessionOnlySalt(deps);
	}
	if (appeared !== undefined) {
		await releaseLock();
		return createSaltSession(appeared, "durable", deps);
	}

	try {
		await deps.secrets.store(FINGERPRINT_SALT_SECRET, generated);
	} catch {
		deps.logger.log("Storing the fingerprint salt failed; identities re-key on the next activation");
		await releaseLock();
		return sessionOnlySalt(deps);
	}
	const readBack = await readStoredSalt(deps.secrets);
	if (readBack === UNREADABLE) {
		deps.logger.log("Confirming the stored fingerprint salt failed; using a session-only salt");
		await releaseLock();
		return sessionOnlySalt(deps);
	}
	await releaseLock();
	if (readBack === undefined) {
		// Stored but not readable back: nothing proves what later sessions will see, so this session must not persist
		// fingerprints.
		deps.logger.log("The stored fingerprint salt did not read back; using a session-only salt");
		return sessionOnlySalt(deps);
	}

	return createSaltSession(readBack, "durable", deps);
}

/**
 * Runs before anything calls fingerprint(), which shared/util/fingerprint.ts makes throw until a salt is installed.
 *
 *   a read fails    -> session-only and no write: a failed read cannot tell "no salt yet" from "keychain unavailable"
 *   nothing stored  -> the lock winner generates and the losers wait; a wiped keychain lands here too
 */
export async function loadFingerprintSalt(
	secrets: vscode.SecretStorage,
	globalStorageUri: vscode.Uri,
	logger: Logger,
	install: (salt: string) => void = initFingerprintSalt,
	timings: Partial<SaltCreationTimings> = {}
): Promise<FingerprintSaltSession> {
	const resolvedTimings: SaltCreationTimings = { ...DEFAULT_TIMINGS, ...timings };
	const lockPath = path.join(globalStorageUri.fsPath, LOCK_DIR_NAME);
	const deps: SaltSessionDeps = { secrets, logger, install };

	const stored = await readStoredSalt(secrets);
	if (stored === UNREADABLE) {
		logger.log("Reading the fingerprint salt from secret storage failed; using a session-only salt");
		return sessionOnlySalt(deps);
	}
	if (stored !== undefined) {
		return createSaltSession(stored, "durable", deps);
	}

	const lock = await acquireSaltLock(globalStorageUri, lockPath);
	if (lock === "failed") {
		logger.log("Creating the fingerprint-salt lock failed; using a session-only salt");
		return sessionOnlySalt(deps);
	}
	if (lock === "held") {
		return awaitWinnersSalt(lockPath, resolvedTimings, deps);
	}

	return createDurableSalt(lockPath, deps);
}
