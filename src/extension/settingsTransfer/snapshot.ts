/**
 * Persistence is the host's concern, under one rule: the recorded `servers` value can carry inline secret text, so the
 * WHOLE snapshot - settings half included - is secret-capable and persists only under the SecretStorage backup key,
 * never in a plaintext file (globalStorage included).
 *
 *   One slot -> replaced per import
 */

import { ALL_SETTING_KEYS, SERVERS_SETTING_KEY } from "../../shared/config/settingSpec";
import { isUnsafeRecordKey } from "../../shared/util/json";
import type { StoredSecretOwners, StoredSecretsRecord, StoredServerSecrets } from "../servers/serverSync/secrets";

/**
 * One recorded pre-import value: present with the exact value, or recorded absent (a restore then removes the key or
 * deletes the blob). JSON-safe by construction, so the whole snapshot serializes for the SecretStorage key.
 */
export type SnapshotEntry<V> = { readonly present: true; readonly value: V } | { readonly present: false };

/**
 * One label's recorded blob: the values plus their ownership stamps. The undo writes them back through the current
 * stamp rule (settingsTransferCommands.ts restoredOwners), so under a recorded entry a token URL string stamp or no
 * stamp still resolves only for the destination that entry names.
 */
export type SnapshotBlobEntry =
	| { readonly present: true; readonly value: StoredServerSecrets; readonly owners?: StoredSecretOwners }
	| { readonly present: false };

/** Everything undo needs to put the world back exactly as it was before the import. */
export interface PreImportSnapshot {
	/** Every litellm-vscode-chat.* key's user-scope value at snapshot time, keyed without the section prefix. */
	readonly settings: Readonly<Record<string, SnapshotEntry<unknown>>>;
	/** The previous blob of every label the import touches (overwritten, renamed-to, appended). */
	readonly blobs: Readonly<Record<string, SnapshotBlobEntry>>;
	/**
	 *   Snapshot time -> the undo summary states it
	 */
	readonly at: string;
}

/**
 * Record the pre-import state: every ALL_SETTING_KEYS user-scope value (an undefined read records as absent) plus the
 * touched labels' current blobs.
 */
export async function buildPreImportSnapshot(
	readGlobalSetting: (key: string) => unknown,
	readServerSecrets: (label: string) => Promise<StoredSecretsRecord>,
	touchedLabels: readonly string[]
): Promise<PreImportSnapshot> {
	const settings: Record<string, SnapshotEntry<unknown>> = {};
	for (const key of ALL_SETTING_KEYS) {
		const value = readGlobalSetting(key);
		settings[key] = value === undefined ? { present: false } : { present: true, value };
	}
	const blobs: Record<string, SnapshotBlobEntry> = {};
	for (const label of touchedLabels) {
		// Reserved names can never be real labels, and bracket assignment under one would corrupt the record.
		if (isUnsafeRecordKey(label) || Object.hasOwn(blobs, label)) {
			continue;
		}
		const record = await readServerSecrets(label);
		// An empty blob and a missing SecretStorage key are the same state to the record read, so both record as absent
		// (the restore deletes).
		blobs[label] =
			Object.keys(record.values).length > 0
				? {
						present: true,
						value: record.values,
						...(Object.keys(record.owners).length > 0 ? { owners: record.owners } : {}),
					}
				: { present: false };
	}
	return { settings, blobs, at: new Date().toISOString() };
}

export interface SnapshotRestore {
	/**
	 * The recorded servers setting (undefined: recorded absent), set apart because the undo writes it before any blob.
	 */
	readonly serversValue: unknown;
	/** The other keys to write back to the user scope with their recorded values. */
	readonly settingWrites: readonly { readonly key: string; readonly value: unknown }[];
	/** The other keys recorded absent, to remove from the user scope. */
	readonly settingRemovals: readonly string[];
	/** Labels whose recorded blob is written back whole, ownership stamps included. */
	readonly blobWrites: readonly {
		readonly label: string;
		readonly secrets: StoredServerSecrets;
		readonly owners: StoredSecretOwners;
	}[];
	/**
	 * Labels recorded blob-less, whose current blob is deleted (an appended label's import-written secrets leave with
	 * it).
	 */
	readonly blobRemovals: readonly string[];
}

/** Turn a snapshot into the exact writes and removals that restore it. */
export function planSnapshotRestore(snapshot: PreImportSnapshot): SnapshotRestore {
	const serversEntry = snapshot.settings[SERVERS_SETTING_KEY];
	const serversValue = serversEntry?.present === true ? serversEntry.value : undefined;
	const settingWrites: { key: string; value: unknown }[] = [];
	const settingRemovals: string[] = [];
	for (const [key, entry] of Object.entries(snapshot.settings)) {
		if (key === SERVERS_SETTING_KEY) {
			continue;
		}
		if (entry.present) {
			settingWrites.push({ key, value: entry.value });
		} else {
			settingRemovals.push(key);
		}
	}
	const blobWrites: { label: string; secrets: StoredServerSecrets; owners: StoredSecretOwners }[] = [];
	const blobRemovals: string[] = [];
	for (const [label, entry] of Object.entries(snapshot.blobs)) {
		if (entry.present) {
			blobWrites.push({ label, secrets: entry.value, owners: entry.owners ?? {} });
		} else {
			blobRemovals.push(label);
		}
	}
	return { serversValue, settingWrites, settingRemovals, blobWrites, blobRemovals };
}
