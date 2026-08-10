/**
 * Secret surgery on one raw servers-setting entry, over the five nested
 * secret positions the auth grammar admits (per parseAuth): `auth.apiKey`,
 * `auth.oauth.apiKey`, `auth.oauth.clientSecret`, `auth.virtualKey.value`,
 * and `auth.oauth.virtualKey.value`. Export-without-secrets strips them out;
 * import moves them from the file into SecretStorage; export-with-secrets
 * materializes stored blobs back into the entry.
 *
 * Pure and vscode-free, like the rest of src/extension/settingsTransfer/.
 */

import type { StoredServerSecrets } from "../servers/serverSync/secrets";

/** stripEntrySecrets' outcome: the sanitized entry plus what was removed. */
export interface StrippedEntry {
	/**
	 * The entry with every inline secret value removed. A container left
	 * formless by the removal (an `auth` object that no longer configures
	 * anything) is deleted too, so the stripped entry still parses.
	 */
	readonly entry: Readonly<Record<string, unknown>>;
	/**
	 * The removed values by flat secret field, ready for SecretStorage
	 * writes. The five positions are removed from the entry independently,
	 * but the blob keys by flat field, so two positions can collide onto one
	 * field only in an entry whose auth shape parseAuth would reject (an
	 * oauth form beside another form); the positions are walked in the
	 * module-comment order and a later position's value overwrites an
	 * earlier one's in the blob.
	 */
	readonly secrets: StoredServerSecrets;
}

/** Remove the entry's inline secret values; see StrippedEntry. */
export function stripEntrySecrets(_rawEntry: Readonly<Record<string, unknown>>): StrippedEntry {
	throw new Error("unimplemented");
}

/** materializeEntrySecrets' outcome: the entry with blob values inlined where legal. */
export interface MaterializedEntry {
	/**
	 * The entry with each blob value placed at its inline position, but only
	 * where the entry's auth shape already gives the field a legal home; an
	 * existing inline value stays (inline wins over the blob, per the sync
	 * engine's precedence rule).
	 */
	readonly entry: Readonly<Record<string, unknown>>;
	/** Blob fields with no legal inline position in this entry's auth shape; counted and reported, never guessed into the file. */
	readonly unmaterialized: number;
}

/** Inline the label's stored blob into the entry; see MaterializedEntry. */
export function materializeEntrySecrets(
	_rawEntry: Readonly<Record<string, unknown>>,
	_blob: StoredServerSecrets
): MaterializedEntry {
	throw new Error("unimplemented");
}
