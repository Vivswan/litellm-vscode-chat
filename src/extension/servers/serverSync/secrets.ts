/**
 * A label's secret fields live in the SecretStorage blob or inline in the setting, and inline wins. The blob
 * also stamps each field's OWNERSHIP under `_owner`, because removals keep blobs on purpose and a rejected
 * delete can leave one behind, so an unstamped leftover could silently authenticate against the wrong host.
 *
 *   dashboard save, palette command, import, adoption -> write the stamp
 *   resolveOwnedSecrets                               -> the one check that admits a stored value into a pairing
 *   field stored before stamping existed              -> no stamp, resolves as before
 *   migrations/stampSecretOwners.ts                   -> back-fills declared entries
 *   two windows writing one label at once             -> last-write-wins (no compare-and-swap)
 *   a misplaced value                                 -> is still refused where it lands
 */

import { serverSecretsKey } from "../../../shared/config/storageKeys";
import type { SecretDestinationEntry, SecretFieldId, SecretLocation, SecretOwner } from "../../../shared/serverEntry";
import {
	entryUsesSecretField,
	parseSecretOwner,
	SECRET_FIELD_IDS,
	sameSecretDestination,
	secretDestination,
} from "../../../shared/serverEntry";
import type { DeclaredServer } from "./setting";

/** The secure-side secrets of one label, as the SecretStorage blob holds them. */
export type StoredServerSecrets = Partial<Readonly<Record<SecretFieldId, string>>>;

/** Per-field ownership stamps: the destination each stored value was stored for (shared/serverEntry.ts SecretOwner). */
export type StoredSecretOwners = Partial<Readonly<Record<SecretFieldId, SecretOwner>>>;

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
	const owners: { -readonly [K in SecretFieldId]?: SecretOwner } = {};
	const rawOwners = (parsed as Record<string, unknown>)[OWNER_KEY];
	if (typeof rawOwners === "object" && rawOwners !== null) {
		for (const field of SECRET_FIELD_IDS) {
			const owner = parseSecretOwner((rawOwners as Record<string, unknown>)[field], field);
			// A stamp is meaningful only beside its value.
			if (owner !== undefined && values[field] !== undefined) {
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
	const owners: Record<string, SecretOwner> = {};
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
 * Every blob write is a read-modify-write of the whole SecretStorage value, and two interleaved writes in one window
 * can resurrect a field the other one cleared, so writes to one label queue behind each other. Cross-window writes
 * cannot be serialized here (SecretStorage has no compare-and-swap); see the module comment for why the ownership
 * stamp bounds that residual.
 *
 *   Keyed by label alone -> distinct stores sharing a label (tests) merely serialize, which is harmless
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

type WrittenListener = (values: readonly string[], landed: Promise<void>) => void;

const writtenListeners = new Set<WrittenListener>();

/**
 * Hear every value this window writes into a blob, before the write lands, with the promise of its landing.
 * SecretStorage's own change event carries no value and the blob read behind it is asynchronous, so the Logger's
 * known values would otherwise learn a freshly saved secret only after a line could already have quoted it; and a
 * read that began before the landing may not hold the value yet, so a listener retires it only after `landed`.
 */
export function onServerSecretWritten(listener: WrittenListener): { dispose(): void } {
	writtenListeners.add(listener);
	return { dispose: () => writtenListeners.delete(listener) };
}

async function writeRecord(secrets: SecretStore, label: string, record: StoredSecretsRecord): Promise<void> {
	const values = Object.values(record.values);
	const write =
		values.length === 0
			? secrets.delete(serverSecretsKey(label))
			: secrets.store(serverSecretsKey(label), serializeRecord(record));
	const landed = Promise.resolve(write).then(
		() => undefined,
		() => undefined
	);
	for (const listener of writtenListeners) {
		listener(values, landed);
	}
	await write;
}

/**
 * Write one secret field of a label's blob; undefined deletes the field (and its stamp), an empty blob deletes the key.
 * `owner` is the ownership stamp for the written value: the destination the caller is pairing it with
 * (secretDestination), or undefined to write it unstamped - only restore paths putting back a recorded pre-write state
 * may do that.
 */
export async function updateServerSecret(
	secrets: SecretStore,
	label: string,
	field: SecretFieldId,
	value: string | undefined,
	owner: SecretOwner | undefined
): Promise<void> {
	await serializedWrite(label, async () => {
		const record = await readServerSecretsRecord(secrets, label);
		const values = { ...record.values };
		const owners: { -readonly [K in SecretFieldId]?: SecretOwner } = { ...record.owners };
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
 * Stamp one already-stored field's ownership without touching its value; a no-op when the field has no value or already
 * carries a stamp.
 */
export async function stampServerSecretOwner(
	secrets: SecretStore,
	label: string,
	field: SecretFieldId,
	owner: SecretOwner
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
 * Replace one stored field's stamp only while it still reads `from`; the migration that moves stamps between rules
 * (migrations/oauthStampClientId.ts) writes through here, so a pairing action landing first is never undone.
 */
export async function restampServerSecretOwner(
	secrets: SecretStore,
	label: string,
	field: SecretFieldId,
	from: SecretOwner,
	to: SecretOwner
): Promise<void> {
	await serializedWrite(label, async () => {
		const record = await readServerSecretsRecord(secrets, label);
		const current = record.owners[field];
		if (record.values[field] === undefined || current === undefined || !sameSecretDestination(current, from)) {
			return;
		}
		await writeRecord(secrets, label, { values: record.values, owners: { ...record.owners, [field]: to } });
	});
}

/**
 * The destination one secret field's value is sent to when paired with an
 * entry: the ONE rule, now defined in shared/serverEntry.ts (the dashboard's
 * stale-key detection reads it too) and re-exported here where the stamping
 * machinery's consumers import it. This is what ownership stamps record at
 * store time and what resolveOwnedSecrets compares at use time.
 */
export { secretDestination };

/**
 * The one reader of a token URL string stamp (0.6.7 and earlier stamped the OAuth client secret with the token URL
 * alone): resolveOwnedSecrets judges through it, so a legacy stamp pairs the moment its entry is accepted, without
 * waiting for migrations/oauthStampClientId.ts to rewrite the blob; the undo of a settings import restores a
 * snapshot's stamps through it too.
 *
 *   string equal to the entry's token URL -> the entry's destination (both read in the one spelling)
 *   any other string                       -> { tokenUrl: <the string> } ("" -> {}), a mismatch under both rules
 *   already structured, or no stamp        -> untouched
 */
export function upgradedStamp(entry: SecretDestinationEntry, field: SecretFieldId, owner: SecretOwner): SecretOwner {
	if (field !== "oauthClientSecret" || typeof owner !== "string") {
		return owner;
	}
	if (owner === (entry.oauthTokenUrl ?? "")) {
		return secretDestination(entry, field);
	}
	return owner === "" ? {} : { tokenUrl: owner };
}

/** resolveOwnedSecrets' outcome; see there. */
export interface OwnedSecretsResolution {
	/** The stored values this entry may resolve: stamp matches the entry's destination, or predates stamping. */
	readonly values: StoredServerSecrets;
	/**
	 *   Stored fields the ownership check refused -> the entry's shape uses the field (entryUsesSecretField, the one
	 *                                                wire rule) and no inline value shadows it
	 */
	readonly refused: readonly SecretFieldId[];
	/**
	 * Every stored field the stamp mismatch dropped with nothing standing in (no inline value): `refused` plus the
	 * inert fields the entry cannot send. The with-secrets export reads this superset for its accounting, so a value
	 * left out of the file is never a silent omission; the pairing gates (the sync engine, the usage poller,
	 * entryConnection.ts) read `refused`.
	 */
	readonly mismatched: readonly SecretFieldId[];
}

/**
 *   THE ownership check -> for every consumer that pairs a blob with an entry
 *   `refused` -> the verdict a pairing gate (the sync pass, the usage poller, entryConnection.ts) stops on instead of
 *                proceeding without the credential; the with-secrets export only accounts for it
 *   stamp mismatch, entry would send it, no inline winner -> refused
 *   stamp mismatch, entry cannot send it                  -> dropped but kept under its old stamp
 *   kept under its old stamp                              -> refusal waits until the entry could send it
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
		if (
			owner === undefined ||
			sameSecretDestination(upgradedStamp(entry, field, owner), secretDestination(entry, field))
		) {
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
 * The inline (in-settings) secret values of a parsed entry: THE rule for "this field is stored inline in the servers
 * setting", and inline values outrank the label's SecretStorage blob. Values are secrets: never log or push them.
 *
 *   One home, several consumers       -> they cannot drift
 *   buildGroupArgs                    -> resolves each secret through it
 *   secretLocations                   -> reports "settings" exactly for its keys
 *   the dashboard's edit-form prefill -> returns exactly it
 *   the Set Server Secret palette     -> warns about a dormant stored value exactly when it holds the field
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
 * Where each of an entry's secret fields lives, under the inline-wins rule: "settings" for inlineSecretValues' keys,
 * "secure" for the label's blob fields behind them, "none" otherwise. `stored` is the ownership-resolved view
 * (resolveOwnedSecrets) wherever an entry is in hand, so a refused field reads "none" - the sync engine's views and the
 * save path's displayed-entry identity check read the same derivation.
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
