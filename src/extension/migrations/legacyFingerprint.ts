import { createHash } from "node:crypto";

/**
 * The unsalted SHA-256 rendering pre-salt extension versions persisted.
 * Comparison-only: it exists so records those versions stored (the sync
 * engine's fingerprint map, the group migration's seeded records) can still
 * be recognized against current material and upgraded to the salted form.
 * Its output is deliberately not a Fingerprint and must never be persisted.
 * Quarantined with the rest of the legacy-state logic: nothing outside
 * src/extension/migrations/ may compute a legacy rendering.
 */
export function legacyUnsaltedFingerprint(text: string): string {
	// codeql[js/insufficient-password-hash] -- comparison-only legacy rendering: recognizes records persisted by pre-salt versions; never stored
	return createHash("sha256").update(text).digest("hex").slice(0, 32);
}
