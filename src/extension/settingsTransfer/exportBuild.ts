/**
 * Building the export: walk ALL_SETTING_KEYS, take only keys with an explicit
 * user-scope (global) value, and wrap them in the versioned envelope. Secrets
 * ride only on the caller's explicit choice: included materializes each labeled
 * entry's SecretStorage blob inline, excluded strips inline secret values and
 * discards them, leaving no placeholders. Shapes the sanitizer does not
 * recognize (a non-array servers value, non-record elements, entries the strip
 * cannot certify secret-free) are omitted from a no-secrets export rather than
 * trusted.
 *
 * No direct vscode usage; the one impurity is the serverSync setting parser's
 * label rule. The host command injects the reads.
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
import { materializeEntrySecrets, stripEntrySecrets } from "./secretSurgery";

/** The reads and choices buildSettingsExport needs; the host command supplies the real ones. */
export interface SettingsExportEnv {
	/** One key's user-scope (global) value; undefined reads as key-absent and stays out of the file. */
	readonly readGlobalSetting: (key: string) => unknown;
	/** The label's SecretStorage blob with its ownership stamps; consulted only when includeSecrets is true. */
	readonly readServerSecrets: (label: string) => Promise<StoredSecretsRecord>;
	/** Stamped into the envelope's exportedBy field; informational only. */
	readonly extensionVersion: string;
	/** The user's explicit per-export choice; true writes secret values into the file in plaintext. */
	readonly includeSecrets: boolean;
}

/** What buildSettingsExport produced, with the counts the export flow's messages state. */
export interface SettingsExportResult {
	readonly envelope: SettingsExportEnvelope;
	/** Keys with an explicit globalValue (the envelope's settings entries, servers included). */
	readonly settingCount: number;
	/** Entries in the exported servers array; 0 when the setting is unset. */
	readonly serverCount: number;
	/** Secret values riding in the file: materialized blob fields plus inline ones kept (0 when includeSecrets is false). */
	readonly secretFieldCount: number;
	/** Blob secret fields with no legal inline position in their entry; reported in the success note when nonzero. */
	readonly unmaterializedSecretCount: number;
	/**
	 * Blob secret fields whose ownership stamp names a different destination
	 * than their entry (resolveOwnedSecrets' `mismatched` - the stale-stamped
	 * fields the entry cannot send included, not just the refused ones), left
	 * out of the file: materializing one inline would hand a retired credential
	 * to the entry's current host on any import, since inline values bypass the
	 * ownership check. Reported so the omission is never silent.
	 */
	readonly mismatchedSecretCount: number;
	/**
	 * Server shapes a no-secrets export omitted as unsanitizable: a non-array
	 * servers value, each non-record element, each entry the strip cannot
	 * certify secret-free. Always 0 when includeSecrets is true; reported so
	 * the omission is never silent.
	 */
	readonly omittedUnsanitizableCount: number;
}

/** Build the export envelope; see the module comment for the walk and the secret handling. */
export async function buildSettingsExport(env: SettingsExportEnv): Promise<SettingsExportResult> {
	const settings: Record<string, unknown> = {};
	let settingCount = 0;
	let serverCount = 0;
	let secretFieldCount = 0;
	let unmaterializedSecretCount = 0;
	let mismatchedSecretCount = 0;
	let omittedUnsanitizableCount = 0;

	for (const key of ALL_SETTING_KEYS) {
		const value = env.readGlobalSetting(key);
		if (value === undefined) {
			continue;
		}
		if (key !== SERVERS_SETTING_KEY) {
			settings[key] = value;
			settingCount += 1;
			continue;
		}
		if (!Array.isArray(value)) {
			// A non-array servers value cannot be sanitized entry-by-entry, so a
			// no-secrets export omits it rather than risk a secret riding out in an
			// unrecognized shape.
			if (env.includeSecrets) {
				settings[key] = value;
				settingCount += 1;
			} else {
				omittedUnsanitizableCount += 1;
			}
			continue;
		}
		settingCount += 1;
		const exported: unknown[] = [];
		for (const rawEntry of value) {
			if (!isRecord(rawEntry)) {
				// Same rule per element: only the record shape has a sanitizer.
				if (env.includeSecrets) {
					exported.push(rawEntry);
				} else {
					omittedUnsanitizableCount += 1;
				}
				continue;
			}
			if (!env.includeSecrets) {
				// Every object entry is stripped, labeled or not: an unlabeled entry
				// can still carry inline secret text. An entry the surgery cannot
				// certify secret-free is omitted whole.
				const stripped = stripEntrySecrets(rawEntry);
				if (stripped.unsanitizable) {
					omittedUnsanitizableCount += 1;
					continue;
				}
				exported.push(stripped.entry);
				continue;
			}
			const label = declaredEntryLabel(rawEntry);
			if (label === undefined) {
				// No label means no SecretStorage key: the entry rides as-is, its
				// inline values counted as kept.
				secretFieldCount += Object.keys(stripEntrySecrets(rawEntry).secrets).length;
				exported.push(rawEntry);
				continue;
			}
			const record = await env.readServerSecrets(label);
			// Only values the ownership check would let this entry use may
			// materialize into the file (see mismatchedSecretCount). An entry the
			// parser rejects has no destinations to compare, so its stamped
			// fields all refuse (fail closed) and unstamped ones ride as before.
			const parsed = acceptedEntry([rawEntry], label)?.entry;
			let usable: StoredServerSecrets;
			if (parsed !== undefined) {
				const owned = resolveOwnedSecrets(parsed, record);
				usable = owned.values;
				// The superset on purpose: an inert stale-stamped field (one the
				// entry cannot send, so it does not refuse the pairing) still drops
				// out of the file here, and the summary must say so.
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
			secretFieldCount += Object.keys(stripEntrySecrets(materialized.entry).secrets).length;
			exported.push(materialized.entry);
		}
		serverCount = exported.length;
		settings[key] = exported;
	}

	return {
		envelope: buildEnvelope(settings, env.extensionVersion),
		settingCount,
		serverCount,
		secretFieldCount,
		unmaterializedSecretCount,
		mismatchedSecretCount,
		omittedUnsanitizableCount,
	};
}
