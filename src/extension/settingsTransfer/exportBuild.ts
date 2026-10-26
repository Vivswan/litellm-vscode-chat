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

/**
 * What the export command writes and reports. `unmaterializedSecretCount` counts blob secret fields with no legal
 * inline position in their entry, reported in the success note when nonzero.
 *
 * `mismatchedSecretCount` counts blob secret fields whose ownership stamp names a different destination than their
 * entry (resolveOwnedSecrets' `mismatched`, the stale-stamped fields the entry cannot send included, not just the
 * refused ones), left out of the file. Materializing one inline would hand a retired credential to the entry's
 * current host on any import, since inline values bypass the ownership check. The count is reported so the omission
 * is never silent.
 */
export interface SettingsExportResult {
	readonly envelope: SettingsExportEnvelope;
	readonly settingCount: number;
	readonly serverCount: number;
	readonly unmaterializedSecretCount: number;
	readonly mismatchedSecretCount: number;
}

/** The secret values the file may carry for one entry, and how many stamped fields stayed out of it. */
interface UsableSecrets {
	readonly values: StoredServerSecrets;
	readonly mismatched: number;
}

/**
 * The usable secrets of an entry the parser rejects: it has no destinations to compare, so its stamped fields all
 * refuse (fail closed) and unstamped ones ride as before.
 */
function unparsedEntrySecrets(record: StoredSecretsRecord): UsableSecrets {
	const values: { -readonly [K in SecretFieldId]?: string } = {};
	let mismatched = 0;
	for (const field of SECRET_FIELD_IDS) {
		const value = record.values[field];
		if (value === undefined) {
			continue;
		}
		if (record.owners[field] === undefined) {
			values[field] = value;
		} else {
			mismatched += 1;
		}
	}
	return { values, mismatched };
}

/**
 * Only values the ownership check would let this entry use may materialize into the file (see mismatchedSecretCount).
 * The mismatch count is the superset on purpose: an inert stale-stamped field (one the entry cannot send, so it does
 * not refuse the pairing) still drops out of the file here, and the summary must say so.
 */
function usableEntrySecrets(
	rawEntry: Readonly<Record<string, unknown>>,
	label: string,
	record: StoredSecretsRecord
): UsableSecrets {
	const parsed = acceptedEntry([rawEntry], label)?.entry;
	if (parsed === undefined) {
		return unparsedEntrySecrets(record);
	}
	const owned = resolveOwnedSecrets(parsed, record);
	return { values: owned.values, mismatched: owned.mismatched.length };
}

/** The servers array as the file carries it, every usable secret placed inline, with the two omission counts. */
interface ExportedServers {
	readonly entries: readonly unknown[];
	readonly unmaterialized: number;
	readonly mismatched: number;
}

/** The servers array walked once: each labelled entry gets its usable blob secrets placed inline, the rest ride verbatim. */
async function exportServers(value: readonly unknown[], env: SettingsExportEnv): Promise<ExportedServers> {
	const entries: unknown[] = [];
	let unmaterialized = 0;
	let mismatched = 0;
	for (const rawEntry of value) {
		const label = isRecord(rawEntry) ? declaredEntryLabel(rawEntry) : undefined;
		if (!isRecord(rawEntry) || label === undefined) {
			// No label means no SecretStorage key, so there is nothing to place.
			entries.push(rawEntry);
			continue;
		}
		const record = await env.readServerSecrets(label);
		const usable = usableEntrySecrets(rawEntry, label, record);
		const materialized = materializeEntrySecrets(rawEntry, usable.values);
		mismatched += usable.mismatched;
		unmaterialized += materialized.unmaterialized;
		entries.push(materialized.entry);
	}
	return { entries, unmaterialized, mismatched };
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
		const exported = await exportServers(value, env);
		serverCount = exported.entries.length;
		unmaterializedSecretCount += exported.unmaterialized;
		mismatchedSecretCount += exported.mismatched;
		settings[key] = exported.entries;
	}

	return {
		envelope: buildEnvelope(settings, env.extensionVersion),
		settingCount,
		serverCount,
		unmaterializedSecretCount,
		mismatchedSecretCount,
	};
}
