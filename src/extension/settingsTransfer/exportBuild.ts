/**
 * Building the export: walk ALL_SETTING_KEYS, take only keys with an explicit
 * user-scope (global) value, and wrap them in the versioned envelope. Secrets
 * are included only on the caller's explicit choice: included means each
 * labeled entry's SecretStorage blob is materialized inline (secretSurgery),
 * excluded means inline secret values are stripped and discarded, with no
 * placeholders left behind.
 *
 * Pure and vscode-free, like the rest of src/extension/settingsTransfer/;
 * the host command injects the reads.
 */

import type { StoredServerSecrets } from "../servers/serverSync/secrets";
import type { SettingsExportEnvelope } from "./envelope";

/** The reads and choices buildSettingsExport needs; the host command supplies the real ones. */
export interface SettingsExportEnv {
	/** One key's user-scope (global) value; undefined reads as key-absent and stays out of the file. */
	readonly readGlobalSetting: (key: string) => unknown;
	/** The label's SecretStorage blob; consulted only when includeSecrets is true. */
	readonly readServerSecrets: (label: string) => Promise<StoredServerSecrets>;
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
}

/** Build the export envelope; see the module comment for the walk and the secret handling. */
export function buildSettingsExport(_env: SettingsExportEnv): Promise<SettingsExportResult> {
	throw new Error("unimplemented");
}
