/**
 * A label's secret fields live in the SecretStorage blob or inline in the setting, and inline wins.
 *
 * The blob also records OWNERSHIP.
 * A `_owner` map stamps each field with the destination it was stored for.
 * Every deliberate pairing action writes the stamp.
 * Those actions are a dashboard save, the palette command, an import, and an adoption.
 * resolveOwnedSecrets is the one check that admits a stored value into a pairing with an entry.
 * A stamp naming a different destination refuses the field.
 * A mismatched stamped field therefore never enters a pairing that gates on this check.
 * The one-shot feature sends use the raw stored values and let the server's own 401 report it.
 * Removals keep blobs, and a rejected SecretStorage delete can leave one behind.
 * The one wire rule, entryUsesSecretField, scopes refusal.
 * A stale stamp on a value the entry cannot send is inert, not a mismatch.
 * The value stays stored under its old stamp.
 * It re-enters the check if the entry ever declares the shape that would send it.
 * Fields stored before stamping existed carry no stamp and resolve as before.
 * The stampSecretOwners migration back-fills stamps for declared entries.
 *
 * Writes are read-modify-write over the whole blob, so one window serializes them per label.
 * Two interleaved writes could otherwise resurrect a cleared field.
 * SecretStorage has no compare-and-swap across windows, so concurrent writes stay last-write-wins.
 * The stamp bounds that hazard.
 * A lost update can misplace a value, but the stamp still refuses it anywhere it does not belong.
 */

import { serverSecretsKey } from "../../../shared/config/storageKeys";
import type { SecretFieldId, SecretLocation } from "../../../shared/serverEntry";
import { entryUsesSecretField, SECRET_FIELD_IDS, secretDestination } from "../../../shared/serverEntry";
import type { DeclaredServer } from "./setting";

/** The secure-side secrets of one label, as the SecretStorage blob holds them. */
export type StoredServerSecrets = Partial<Readonly<Record<SecretFieldId, string>>>;

/** Per-field ownership stamps: the destination each stored value was stored for ("" = stored with none). */
export type StoredSecretOwners = Partial<Readonly<Record<SecretFieldId, string>>>;

/** One label's whole blob: the values and their ownership stamps. */
export interface StoredSecretsRecord {
	readonly values: StoredServerSecrets;
	readonly owners: StoredSecretOwners;
}

/** The slice of vscode.SecretStorage the sync path uses; injectable for tests. */
export interface SecretStore {
	get(key: string): Thenable<string | undefined>;
	store(key: string, value: string): Thenable<void>;
	delete(key: string): Thenable<void>;
}

/** The blob key the `_owner` map rides under; never a secret field id, so old readers ignore it. */
const OWNER_KEY = "_owner";

function parseRecord(raw: string | undefined): StoredSecretsRecord {
	if (raw === undefined) {
		return { values: {}, owners: {} };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { values: {}, owners: {} };
	}
	if (typeof parsed !== "object" || parsed === null) {
		return { values: {}, owners: {} };
	}
	const values: { -readonly [K in SecretFieldId]?: string } = {};
	for (const field of SECRET_FIELD_IDS) {
		const value = (parsed as Record<string, unknown>)[field];
		if (typeof value === "string" && value.length > 0) {
			values[field] = value;
		}
	}
	const owners: { -readonly [K in SecretFieldId]?: string } = {};
	const rawOwners = (parsed as Record<string, unknown>)[OWNER_KEY];
	if (typeof rawOwners === "object" && rawOwners !== null) {
		for (const field of SECRET_FIELD_IDS) {
			const owner = (rawOwners as Record<string, unknown>)[field];
			// A stamp is meaningful only beside its value; "" is a real stamp
			// (stored with no destination), so only non-strings drop.
			if (typeof owner === "string" && values[field] !== undefined) {
				owners[field] = owner;
			}
		}
	}
	return { values, owners };
}

function serializeRecord(record: StoredSecretsRecord): string {
	const blob: Record<string, unknown> = {};
	for (const field of SECRET_FIELD_IDS) {
		const value = record.values[field];
		if (value !== undefined && value.length > 0) {
			blob[field] = value;
		}
	}
	const owners: Record<string, string> = {};
	for (const field of SECRET_FIELD_IDS) {
		const owner = record.owners[field];
		if (owner !== undefined && blob[field] !== undefined) {
			owners[field] = owner;
		}
	}
	if (Object.keys(owners).length > 0) {
		blob[OWNER_KEY] = owners;
	}
	return JSON.stringify(blob);
}

/** A label's blob with its ownership stamps; the empty record when the key is absent or unreadable. */
export async function readServerSecretsRecord(secrets: SecretStore, label: string): Promise<StoredSecretsRecord> {
	return parseRecord(await secrets.get(serverSecretsKey(label)));
}

/**
 * Per-label write serialization. Every blob write is a read-modify-write of
 * the whole SecretStorage value, and two interleaved writes in one window can
 * resurrect a field the other one cleared, so writes to one label queue behind
 * each other. Keyed by label alone: distinct stores sharing a label (tests)
 * merely serialize, which is harmless. Cross-window writes cannot be
 * serialized here (SecretStorage has no compare-and-swap); see the module
 * comment for why the ownership stamp bounds that residual.
 */
const labelWriteQueues = new Map<string, Promise<unknown>>();

function serializedWrite<T>(label: string, task: () => Promise<T>): Promise<T> {
	const tail = labelWriteQueues.get(label) ?? Promise.resolve();
	const run = tail.then(task, task);
	const settled = run.then(
		() => undefined,
		() => undefined
	);
	labelWriteQueues.set(label, settled);
	void settled.then(() => {
		if (labelWriteQueues.get(label) === settled) {
			labelWriteQueues.delete(label);
		}
	});
	return run;
}

async function writeRecord(secrets: SecretStore, label: string, record: StoredSecretsRecord): Promise<void> {
	if (Object.keys(record.values).length === 0) {
		await secrets.delete(serverSecretsKey(label));
		return;
	}
	await secrets.store(serverSecretsKey(label), serializeRecord(record));
}

/**
 * Write one secret field of a label's blob; undefined deletes the field (and
 * its stamp), an empty blob deletes the key. `owner` is the ownership stamp
 * for the written value: the destination the caller is pairing it with
 * (secretDestination), or undefined to write it unstamped - only restore
 * paths putting back a recorded pre-write state may do that.
 */
export async function updateServerSecret(
	secrets: SecretStore,
	label: string,
	field: SecretFieldId,
	value: string | undefined,
	owner: string | undefined
): Promise<void> {
	await serializedWrite(label, async () => {
		const record = await readServerSecretsRecord(secrets, label);
		const values = { ...record.values };
		const owners = { ...record.owners };
		if (value === undefined) {
			delete values[field];
			delete owners[field];
		} else {
			values[field] = value;
			if (owner === undefined) {
				delete owners[field];
			} else {
				owners[field] = owner;
			}
		}
		await writeRecord(secrets, label, { values, owners });
	});
}

/**
 * Stamp one already-stored field's ownership without touching its value; a
 * no-op when the field has no value or already carries a stamp. The
 * stampSecretOwners migration's write: back-filling stamps must never
 * overwrite one a deliberate pairing action wrote.
 */
export async function stampServerSecretOwner(
	secrets: SecretStore,
	label: string,
	field: SecretFieldId,
	owner: string
): Promise<void> {
	await serializedWrite(label, async () => {
		const record = await readServerSecretsRecord(secrets, label);
		if (record.values[field] === undefined || record.owners[field] !== undefined) {
			return;
		}
		await writeRecord(secrets, label, { values: record.values, owners: { ...record.owners, [field]: owner } });
	});
}

/** Delete a label's whole blob. */
export async function deleteServerSecrets(secrets: SecretStore, label: string): Promise<void> {
	await serializedWrite(label, () => Promise.resolve(secrets.delete(serverSecretsKey(label))));
}

/**
 * The destination one secret field's value is sent to when paired with an
 * entry: the ONE rule, now defined in shared/serverEntry.ts (the dashboard's
 * stale-key detection reads it too) and re-exported here where the stamping
 * machinery's consumers import it. This is what ownership stamps record at
 * store time and what resolveOwnedSecrets compares at use time.
 */
export { secretDestination };

/** resolveOwnedSecrets' outcome; see there. */
export interface OwnedSecretsResolution {
	/** The stored values this entry may resolve: stamp matches the entry's destination, or predates stamping. */
	readonly values: StoredServerSecrets;
	/**
	 * Stored fields the ownership check refused AND the entry would actually
	 * have sent: the entry's shape uses the field (entryUsesSecretField, the
	 * one wire rule) and no inline value shadows it. A refused field means the
	 * pairing must not proceed; a shadowed or unsent one is dormant and merely
	 * drops.
	 */
	readonly refused: readonly SecretFieldId[];
	/**
	 * Every stored field the stamp mismatch dropped with nothing standing in
	 * (no inline value): `refused` plus the inert fields the entry cannot
	 * send. The with-secrets export reads this superset for its accounting,
	 * so a value left out of the file is never a silent omission; the pairing
	 * gates (the sync engine, MCP) read `refused`.
	 */
	readonly mismatched: readonly SecretFieldId[];
}

/**
 * Every consumer that pairs a blob with an entry uses this ownership check.
 * The check drops a field whose stamp names another destination.
 * If the entry would SEND that field, the check also refuses it.
 * The caller can then refuse the whole pairing rather than proceed without the credential.
 * An add-only host would make a credential-less group permanent.
 * The check drops a stale-stamped value the entry cannot send but does NOT refuse it.
 * Such a value, say a virtualKeyValue with no declared header, reaches no wire and blocks no sync.
 * It stays stored under its old stamp, so the refusal fires once the entry could send it.
 */
export function resolveOwnedSecrets(entry: DeclaredServer, record: StoredSecretsRecord): OwnedSecretsResolution {
	const values: { -readonly [K in SecretFieldId]?: string } = {};
	const refused: SecretFieldId[] = [];
	const mismatched: SecretFieldId[] = [];
	const inline = inlineSecretValues(entry);
	for (const field of SECRET_FIELD_IDS) {
		const value = record.values[field];
		if (value === undefined) {
			continue;
		}
		const owner = record.owners[field];
		if (owner === undefined || owner === secretDestination(entry, field)) {
			values[field] = value;
		} else if (inline[field] === undefined) {
			mismatched.push(field);
			if (entryUsesSecretField(entry, field)) {
				refused.push(field);
			}
		}
	}
	return { values, refused, mismatched };
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

/**
 * Where each of an entry's secret fields lives, under the inline-wins rule:
 * "settings" for inlineSecretValues' keys, "secure" for the label's blob
 * fields behind them, "none" otherwise. `stored` is the ownership-resolved
 * view (resolveOwnedSecrets) wherever an entry is in hand, so a refused field
 * reads "none" - the sync engine's views and the save path's displayed-entry
 * identity check read the same derivation.
 */
export function secretLocations(
	entry: DeclaredServer,
	stored: StoredServerSecrets
): Record<SecretFieldId, SecretLocation> {
	const inline = inlineSecretValues(entry);
	const locations = {} as Record<SecretFieldId, SecretLocation>;
	for (const field of SECRET_FIELD_IDS) {
		locations[field] = inline[field] !== undefined ? "settings" : stored[field] !== undefined ? "secure" : "none";
	}
	return locations;
}
