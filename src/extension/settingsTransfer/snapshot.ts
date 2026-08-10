/**
 * The pre-import snapshot behind "Undo Last Settings Import": before an
 * import applies anything, every litellm-vscode-chat.* user-scope value
 * (key-absent recorded as absent) and the previous SecretStorage blob of
 * every label the import will touch are recorded, and undo is a wholesale
 * restore of that record. One slot, replaced per import, cleared on undo.
 * Persistence is the host's concern, with one caveat it must honor: the
 * recorded `servers` value can carry inline secret text (inline storage is
 * legal in that setting), so the settings half is secret-capable too - it
 * may only land somewhere already acceptable for settings.json plaintext,
 * or ride with the blobs under the SecretStorage backup key; the blobs half
 * is always secrets and never touches a plaintext file. The storage keys
 * belong in shared/config/storageKeys.ts when the flows land. These
 * builders only shape what is stored and what a restore writes.
 *
 * Pure and vscode-free, like envelope.ts and secretSurgery.ts.
 */

import { ALL_SETTING_KEYS } from "../../shared/config/settingSpec";
import { isUnsafeRecordKey } from "../../shared/util/json";
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
export async function buildPreImportSnapshot(
	readGlobalSetting: (key: string) => unknown,
	readServerSecrets: (label: string) => Promise<StoredServerSecrets>,
	touchedLabels: readonly string[]
): Promise<PreImportSnapshot> {
	const settings: Record<string, SnapshotEntry<unknown>> = {};
	for (const key of ALL_SETTING_KEYS) {
		const value = readGlobalSetting(key);
		settings[key] = value === undefined ? { present: false } : { present: true, value };
	}
	const blobs: Record<string, SnapshotEntry<StoredServerSecrets>> = {};
	for (const label of touchedLabels) {
		// Reserved names can never be real labels (rawDeclaredLabels excludes
		// them), and bracket assignment under one would corrupt the record.
		if (isUnsafeRecordKey(label) || Object.hasOwn(blobs, label)) {
			continue;
		}
		const blob = await readServerSecrets(label);
		// An empty blob and a missing SecretStorage key are the same state to
		// readServerSecrets, so both record as absent (the restore deletes).
		blobs[label] = Object.keys(blob).length > 0 ? { present: true, value: blob } : { present: false };
	}
	return { settings, blobs, at: new Date().toISOString() };
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
export function planSnapshotRestore(snapshot: PreImportSnapshot): SnapshotRestore {
	const settingWrites: { key: string; value: unknown }[] = [];
	const settingRemovals: string[] = [];
	for (const [key, entry] of Object.entries(snapshot.settings)) {
		if (entry.present) {
			settingWrites.push({ key, value: entry.value });
		} else {
			settingRemovals.push(key);
		}
	}
	const blobWrites: { label: string; secrets: StoredServerSecrets }[] = [];
	const blobRemovals: string[] = [];
	for (const [label, entry] of Object.entries(snapshot.blobs)) {
		if (entry.present) {
			blobWrites.push({ label, secrets: entry.value });
		} else {
			blobRemovals.push(label);
		}
	}
	return { settingWrites, settingRemovals, blobWrites, blobRemovals };
}
