/**
 * The pre-import snapshot behind "Undo Last Settings Import": before an
 * import applies anything, every litellm-vscode-chat.* user-scope value
 * (key-absent recorded as absent) and the previous SecretStorage blob of
 * every label the import will touch are recorded, and undo is a wholesale
 * restore of that record. One slot, replaced per import, cleared on undo.
 * Persistence is the host's concern (the settings part in a globalStorage
 * JSON file, the blobs under a SecretStorage backup key - secrets never in a
 * plaintext file - with both keys declared in shared/config/storageKeys.ts
 * when the flows land); these builders only shape what is stored and what a
 * restore writes.
 *
 * Pure and vscode-free, like the rest of src/extension/settingsTransfer/.
 */

import type { StoredServerSecrets } from "../servers/serverSync/secrets";

/**
 * One recorded pre-import value: present with the exact value, or recorded
 * absent (a restore then removes the key or deletes the blob). JSON-safe by
 * construction, so the settings part can persist as a plain file.
 */
export type SnapshotEntry<V> = { readonly present: true; readonly value: V } | { readonly present: false };

/** Everything undo needs to put the world back exactly as it was before the import. */
export interface PreImportSnapshot {
	/** Every litellm-vscode-chat.* key's user-scope value at snapshot time, keyed without the section prefix. */
	readonly settings: Readonly<Record<string, SnapshotEntry<unknown>>>;
	/** The previous blob of every label the import touches (overwritten, renamed-to, appended). */
	readonly blobs: Readonly<Record<string, SnapshotEntry<StoredServerSecrets>>>;
	/** Snapshot time, ISO 8601; the undo summary states it. */
	readonly at: string;
}

/**
 * Record the pre-import state: every ALL_SETTING_KEYS user-scope value (an
 * undefined read records as absent; settings values are JSON, never
 * undefined) plus the touched labels' current blobs.
 */
export function buildPreImportSnapshot(
	_readGlobalSetting: (key: string) => unknown,
	_readServerSecrets: (label: string) => Promise<StoredServerSecrets>,
	_touchedLabels: readonly string[]
): Promise<PreImportSnapshot> {
	throw new Error("unimplemented");
}

/** The write and remove lists the undo command applies, in restore order (settings, then blobs). */
export interface SnapshotRestore {
	/** Keys to write back to the user scope with their recorded values. */
	readonly settingWrites: readonly { readonly key: string; readonly value: unknown }[];
	/** Keys recorded absent, to remove from the user scope. */
	readonly settingRemovals: readonly string[];
	/** Labels whose recorded blob is written back whole. */
	readonly blobWrites: readonly { readonly label: string; readonly secrets: StoredServerSecrets }[];
	/** Labels recorded blob-less, whose current blob is deleted (an appended label's import-written secrets leave with it). */
	readonly blobRemovals: readonly string[];
}

/** Turn a snapshot into the exact writes and removals that restore it. */
export function planSnapshotRestore(_snapshot: PreImportSnapshot): SnapshotRestore {
	throw new Error("unimplemented");
}
