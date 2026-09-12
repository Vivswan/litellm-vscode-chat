import { pbkdf2Sync } from "node:crypto";
import { z } from "zod";

/**
 * The branded output of fingerprint(). A compile-time guard only: it keeps raw
 * secret material out of fingerprint-typed fields, while persisted strings
 * re-enter shape-checked exactly as loosely as before. The brand asserts
 * provenance in the type system, not a runtime format.
 */
const fingerprintSchema = z.string().brand<"Fingerprint">();

export type Fingerprint = z.infer<typeof fingerprintSchema>;

/**
 * The salt every fingerprint() call is keyed by. Set exactly once per process:
 * activation loads it from SecretStorage before anything computes a
 * fingerprint. Never logged and never readable back out of this module.
 */
let activeSalt: string | undefined;

/**
 * Install the process-wide fingerprint salt. Set-once: a second call with the
 * same value is a no-op, a different value throws, because re-keying mid
 * process would churn every credential identity at once (cached clients,
 * group client IDs, the sync engine's fingerprint map) with no path back.
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
 * A colliding pair of keys would share a cached client and put the wrong credentials on the wire. The secret random salt is the
 * entire defense, since without the keychain nothing verifies a guess at any work factor, so a low-entropy key (LiteLLM's docs
 * use "sk-1234") reveals nothing through a fingerprint read from globalState.
 *
 *   iterations 1 -> a keyed identity on hot paths (client cache lookups, group resolution), not password verification
 *   PBKDF2       -> the right keyed construction here, and a recognized password-hashing algorithm
 */
export function fingerprint(text: string): Fingerprint {
	return fingerprintSchema.parse(pbkdf2Sync(text, requireSalt(), 1, 32, "sha256").toString("hex").slice(0, 32));
}
