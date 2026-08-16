/**
 * A label's secret fields on the secure side (the SecretStorage blob) and
 * inline in the setting, with the precedence rule between them.
 */

import { serverSecretsKey } from "../../../shared/config/storageKeys";
import type { SecretFieldId } from "../../../shared/serverEntry";
import { SECRET_FIELD_IDS } from "../../../shared/serverEntry";
import type { DeclaredServer } from "./setting";

/** The secure-side secrets of one label, as the SecretStorage blob holds them. */
export type StoredServerSecrets = Partial<Readonly<Record<SecretFieldId, string>>>;

/** The slice of vscode.SecretStorage the sync path uses; injectable for tests. */
export interface SecretStore {
	get(key: string): Thenable<string | undefined>;
	store(key: string, value: string): Thenable<void>;
	delete(key: string): Thenable<void>;
}

export async function readServerSecrets(secrets: SecretStore, label: string): Promise<StoredServerSecrets> {
	const raw = await secrets.get(serverSecretsKey(label));
	if (raw === undefined) {
		return {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	if (typeof parsed !== "object" || parsed === null) {
		return {};
	}
	const blob: { -readonly [K in SecretFieldId]?: string } = {};
	for (const field of SECRET_FIELD_IDS) {
		const value = (parsed as Record<string, unknown>)[field];
		if (typeof value === "string" && value.length > 0) {
			blob[field] = value;
		}
	}
	return blob;
}

/** Write one secret field of a label's blob; undefined deletes the field, an empty blob deletes the key. */
export async function updateServerSecret(
	secrets: SecretStore,
	label: string,
	field: SecretFieldId,
	value: string | undefined
): Promise<void> {
	const blob = { ...(await readServerSecrets(secrets, label)) };
	if (value === undefined) {
		delete blob[field];
	} else {
		blob[field] = value;
	}
	if (Object.keys(blob).length === 0) {
		await secrets.delete(serverSecretsKey(label));
		return;
	}
	await secrets.store(serverSecretsKey(label), JSON.stringify(blob));
}

/**
 * Copy a label's whole blob to another label (the additive half of a rename);
 * a no-op when the source holds nothing. The caller deletes the source only
 * after the settings write that depends on the copy has landed.
 */
export async function copyServerSecrets(secrets: SecretStore, fromLabel: string, toLabel: string): Promise<void> {
	if (fromLabel === toLabel) {
		return;
	}
	const blob = await readServerSecrets(secrets, fromLabel);
	if (Object.keys(blob).length === 0) {
		return;
	}
	await secrets.store(serverSecretsKey(toLabel), JSON.stringify(blob));
}

/** Delete a label's whole blob. */
export async function deleteServerSecrets(secrets: SecretStore, label: string): Promise<void> {
	await secrets.delete(serverSecretsKey(label));
}

/**
 * The inline (in-settings) secret values of a parsed entry: THE rule for "this
 * field is stored inline in the servers setting", and inline values outrank the
 * label's SecretStorage blob. One home, several consumers, so they cannot
 * drift: buildGroupArgs resolves each secret through it, secretLocations
 * reports "settings" exactly for its keys, the dashboard's edit-form prefill
 * returns exactly it, and the Set Server Secret palette warns about a dormant
 * stored value exactly when it holds the field. Values are secrets: never log
 * or push them.
 */
export function inlineSecretValues(entry: DeclaredServer): Readonly<Partial<Record<SecretFieldId, string>>> {
	const values: { -readonly [K in SecretFieldId]?: string } = {};
	for (const field of SECRET_FIELD_IDS) {
		const value = entry[field];
		if (value !== undefined) {
			values[field] = value;
		}
	}
	return values;
}
