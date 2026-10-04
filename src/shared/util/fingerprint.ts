import { pbkdf2Sync } from "node:crypto";
import { z } from "zod";

/**
 * A compile-time guard only: it keeps raw secret material out of fingerprint-typed fields, while persisted strings
 * re-enter shape-checked exactly as loosely as before.
 */
const fingerprintSchema = z.string().brand<"Fingerprint">();

export type Fingerprint = z.infer<typeof fingerprintSchema>;

/** Set exactly once per process. Never logged and never readable back out of this module. */
let activeSalt: string | undefined;

/**
 * Set-once: a second call with the same value is a no-op, a different value throws, because re-keying mid process
 * would churn every credential identity at once (cached clients, group client IDs, the sync engine's fingerprint map)
 * with no path back.
 */
export function initFingerprintSalt(salt: string): void {
	if (salt.length === 0) {
		throw new Error("The fingerprint salt must not be empty");
	}
	if (activeSalt !== undefined) {
		if (activeSalt === salt) {
			return;
		}
		throw new Error("The fingerprint salt is already initialized with a different value");
	}
	activeSalt = salt;
}

function requireSalt(): string {
	if (activeSalt === undefined) {
		throw new Error("fingerprint() was called before initFingerprintSalt()");
	}
	return activeSalt;
}

/**
 * A colliding pair of keys would share a cached client and put the wrong credentials on the wire.
 *
 *   iterations 1 -> a keyed identity on hot paths (client cache lookups, group resolution), not password verification
 *   PBKDF2       -> the right keyed construction here, and a recognized password-hashing algorithm
 */
export function fingerprint(text: string): Fingerprint {
	return fingerprintSchema.parse(pbkdf2Sync(text, requireSalt(), 1, 32, "sha256").toString("hex").slice(0, 32));
}
