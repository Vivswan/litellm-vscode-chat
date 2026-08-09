import { pbkdf2Sync } from "node:crypto";
import { z } from "zod";

/**
 * The branded output of fingerprint(). A compile-time guard only: it keeps
 * raw secret material out of fingerprint-typed fields (a plain apiKey string
 * cannot be assigned where a Fingerprint is required), while persisted
 * strings re-enter through this schema shape-checked exactly as loosely as
 * they always were - the brand asserts provenance in the type system, not a
 * runtime format.
 */
export const fingerprintSchema = z.string().brand<"Fingerprint">();

export type Fingerprint = z.infer<typeof fingerprintSchema>;

/**
 * The salt every fingerprint() call is keyed by. Set exactly once per
 * process: activation loads it from SecretStorage before anything computes a
 * fingerprint (see extension/fingerprintSalt.ts for the lifecycle, including
 * the never-regenerate rule and the session-only fallback). Never logged and
 * never readable back out of this module.
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
 * PBKDF2-SHA256 over a string, keyed by the per-install secret salt, hex,
 * truncated to 32 characters. Used as a non-secret identity for values (like
 * API keys) that must never be stored or compared in the clear. Collision
 * resistance matters: a colliding pair of keys would share a cached client
 * and put the wrong credentials on the wire.
 *
 * The secret random salt is the entire defense: without the keychain there is
 * nothing to verify guesses against, at any work factor, so a low-entropy key
 * (LiteLLM's docs use "sk-1234") reveals nothing through a fingerprint read
 * out of globalState. Iterations stay at 1 because this is a keyed identity
 * computed on hot paths (client cache lookups, group resolution), not stored
 * password verification. PBKDF2 is the primitive because it is the right
 * keyed construction here and a recognized password-hashing algorithm.
 */
export function fingerprint(text: string): Fingerprint {
	return fingerprintSchema.parse(pbkdf2Sync(text, requireSalt(), 1, 32, "sha256").toString("hex").slice(0, 32));
}
