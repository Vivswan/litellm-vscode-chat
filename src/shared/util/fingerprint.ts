import { createHash } from "node:crypto";
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
 * SHA-256 over a string, hex, truncated to 32 characters. Used as a
 * non-secret identity for values (like API keys) that must never be stored or
 * compared in the clear. Collision resistance matters: a colliding pair of
 * keys would share a cached client and put the wrong credentials on the wire.
 */
export function fingerprint(text: string): Fingerprint {
	// The suppression must ride the hashing line itself: CodeQL comments cover only their own line.
	const digest = createHash("sha256").update(text).digest("hex"); // codeql[js/insufficient-password-hash] -- identity fingerprint, never password storage
	return fingerprintSchema.parse(digest.slice(0, 32));
}
