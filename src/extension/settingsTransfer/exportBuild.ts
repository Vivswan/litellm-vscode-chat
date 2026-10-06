/**
 * The export writes the stored configuration as it is, every SecretStorage value placed at its inline field, so the
 * file is complete on its own. Only a value the entry could not use on the wire stays out of it (see
 * mismatchedSecretCount); the save flow tells the user the file carries the credentials.
 */

import { ALL_SETTING_KEYS, SERVERS_SETTING_KEY } from "../../shared/config/settingSpec";
import type { SecretFieldId } from "../../shared/serverEntry";
import { SECRET_FIELD_IDS } from "../../shared/serverEntry";
import { isRecord } from "../../shared/util/json";
import type { StoredSecretsRecord, StoredServerSecrets } from "../servers/serverSync/secrets";
import { resolveOwnedSecrets } from "../servers/serverSync/secrets";
import { acceptedEntry, declaredEntryLabel } from "../servers/serverSync/setting";
import type { SettingsExportEnvelope } from "./envelope";
import { buildEnvelope } from "./envelope";
import { materializeEntrySecrets } from "./secretSurgery";

export interface SettingsExportEnv {
	readonly readGlobalSetting: (key: string) => unknown;
	readonly readServerSecrets: (label: string) => Promise<StoredSecretsRecord>;
	readonly extensionVersion: string;
}

export interface SettingsExportResult {
	readonly envelope: SettingsExportEnvelope;
	readonly settingCount: number;
	readonly serverCount: number;
	/** Blob secret fields with no legal inline position in their entry; reported in the success note when nonzero. */
	readonly unmaterializedSecretCount: number;
	/**
	 * Blob secret fields whose ownership stamp names a different destination than their entry (resolveOwnedSecrets'
	 * `mismatched` - the stale-stamped fields the entry cannot send included, not just the refused ones), left out of
	 * the file: materializing one inline would hand a retired credential to the entry's current host on any import,
	 * since inline values bypass the ownership check. Reported so the omission is never silent.
	 */
	readonly mismatchedSecretCount: number;
}

export async function buildSettingsExport(env: SettingsExportEnv): Promise<SettingsExportResult> {
	const settings: Record<string, unknown> = {};
	let settingCount = 0;
	let serverCount = 0;
	let unmaterializedSecretCount = 0;
	let mismatchedSecretCount = 0;

	for (const key of ALL_SETTING_KEYS) {
		const value = env.readGlobalSetting(key);
		if (value === undefined) {
			continue;
		}
		settingCount += 1;
		if (key !== SERVERS_SETTING_KEY || !Array.isArray(value)) {
			settings[key] = value;
			continue;
		}
		const exported: unknown[] = [];
		for (const rawEntry of value) {
			const label = isRecord(rawEntry) ? declaredEntryLabel(rawEntry) : undefined;
			if (!isRecord(rawEntry) || label === undefined) {
				// No label means no SecretStorage key, so there is nothing to place.
				exported.push(rawEntry);
				continue;
			}
			const record = await env.readServerSecrets(label);
			// Only values the ownership check would let this entry use may materialize into the file (see
			// mismatchedSecretCount). An entry the parser rejects has no destinations to compare, so its stamped fields
			// all refuse (fail closed) and unstamped ones ride as before.
			const parsed = acceptedEntry([rawEntry], label)?.entry;
			let usable: StoredServerSecrets;
			if (parsed !== undefined) {
				const owned = resolveOwnedSecrets(parsed, record);
				usable = owned.values;
				// The superset on purpose: an inert stale-stamped field (one the entry cannot send, so it does not
				// refuse the pairing) still drops out of the file here, and the summary must say so.
				mismatchedSecretCount += owned.mismatched.length;
			} else {
				const values: { -readonly [K in SecretFieldId]?: string } = {};
				for (const field of SECRET_FIELD_IDS) {
					const value = record.values[field];
					if (value === undefined) {
						continue;
					}
					if (record.owners[field] === undefined) {
						values[field] = value;
					} else {
						mismatchedSecretCount += 1;
					}
				}
				usable = values;
			}
			const materialized = materializeEntrySecrets(rawEntry, usable);
			unmaterializedSecretCount += materialized.unmaterialized;
			exported.push(materialized.entry);
		}
		serverCount = exported.length;
		settings[key] = exported;
	}

	return {
		envelope: buildEnvelope(settings, env.extensionVersion),
		settingCount,
		serverCount,
		unmaterializedSecretCount,
		mismatchedSecretCount,
	};
}
