import { createHash } from "node:crypto";

/**
 * SHA-256 over a string, hex, truncated to 32 characters. Used as a
 * non-secret identity for values (like API keys) that must never be stored or
 * compared in the clear. Collision resistance matters: a colliding pair of
 * keys would share a cached client and put the wrong credentials on the wire.
 */
export function fingerprint(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 32);
}
