/**
 * Secret surgery on one raw servers-setting entry, over the five nested secret
 * positions the auth grammar admits (per parseAuth): `auth.apiKey`,
 * `auth.oauth.apiKey`, `auth.oauth.clientSecret`, `auth.virtualKey.value`, and
 * `auth.oauth.virtualKey.value` - plus the pre-redesign flat shape's top-level
 * secret fields, which map 1:1 onto the blob's ids when no record-shaped auth
 * object outranks them (see StrippedEntry.secrets). Export-without-secrets
 * strips them out; import moves them from the file into SecretStorage;
 * export-with-secrets materializes stored blobs back into the nested
 * positions.
 *
 * Strip trims what it takes (the inline settings grammar trims, so the trimmed
 * text IS the value the file carries); materialize places stored values
 * verbatim (buildGroupArgs sends stored strings untouched). So a stored value
 * with whitespace padding round-trips to its trimmed form.
 *
 * Pure and vscode-free.
 */

import type { SecretFieldId } from "../../shared/serverEntry";
import { SECRET_FIELD_IDS } from "../../shared/serverEntry";
import { isRecord } from "../../shared/util/json";
import type { StoredServerSecrets } from "../servers/serverSync/secrets";

type MutableSecrets = { -readonly [K in SecretFieldId]?: string };

/**
 * parseAuth's usable-text rule: a position holds a value only when it carries
 * non-whitespace text, and the effective value is the trimmed one.
 */
function usableText(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** A structural copy deep enough for the surgery; non-container leaves pass through by reference. */
function cloneJson(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(cloneJson);
	}
	if (isRecord(value)) {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item)]));
	}
	return value;
}

/** stripEntrySecrets' outcome: the sanitized entry plus what was removed. */
export interface StrippedEntry {
	/**
	 * The entry with every inline secret value removed. A container the removal
	 * left formless is deleted too, so the stripped entry still parses.
	 */
	readonly entry: Readonly<Record<string, unknown>>;
	/**
	 * The removed values by flat secret field, ready for SecretStorage writes.
	 * Flat-vs-nested collisions resolve by the settings-redesign migration's
	 * OWN rule, so a transfer can never change which credentials an entry
	 * sends: a record-shaped `auth` object wins WHOLESALE - flat secret text
	 * beside it is removed and DISCARDED, never moved into the blob, exactly
	 * as the activation migration discards it - and only an entry without a
	 * record auth maps its flat fields 1:1 onto the blob's ids (the pre-
	 * redesign shape). Within the auth subtree, positions are walked in the
	 * module-comment order and a later one overwrites an earlier one (two
	 * nested positions collide onto one field only in an auth shape parseAuth
	 * would reject).
	 */
	readonly secrets: StoredServerSecrets;
	/**
	 * True when the stripped entry still carries text the strip cannot vouch
	 * for: anywhere in the auth subtree but the grammar's known non-secret text
	 * positions (`oauth.tokenUrl`, `oauth.clientId`, `oauth.scopes`, a
	 * virtualKey's `header`), or a container left at a top-level secret-named
	 * field. A no-secrets export omits such an entry rather than trust it, and
	 * the import skips it rather than land unmovable credential text. Textless
	 * scalars are mere misconfiguration and stay sanitizable.
	 */
	readonly unsanitizable: boolean;
}

/** Move one position's usable value into the blob; non-string and non-usable occupants stay put. */
function takeSecret(
	container: Record<string, unknown>,
	key: string,
	field: SecretFieldId,
	blob: MutableSecrets
): boolean {
	const value = usableText(container[key]);
	if (value === undefined) {
		return false;
	}
	blob[field] = value;
	delete container[key];
	return true;
}

/** A leftover that cannot carry secret text: absent, null, number, boolean, or a textless string. */
function textless(value: unknown): boolean {
	return (
		value === undefined ||
		value === null ||
		typeof value === "number" ||
		typeof value === "boolean" ||
		(typeof value === "string" && value.trim().length === 0)
	);
}

/**
 * Certify one already-stripped auth container against a key whitelist: `text`
 * keys may hold strings, `walk` keys recurse, and every other occupant must be
 * textless. Anything else could be a credential the strip did not reach.
 */
function certifyContainer(
	value: unknown,
	text: readonly string[],
	walk: Readonly<Record<string, (value: unknown) => boolean>>
): boolean {
	if (!isRecord(value)) {
		return textless(value);
	}
	return Object.entries(value).every(([key, occupant]) => {
		if (text.includes(key)) {
			return typeof occupant === "string" || textless(occupant);
		}
		const into = walk[key];
		return into !== undefined ? into(occupant) : textless(occupant);
	});
}

/** Whether a STRIPPED entry's auth subtree is certifiably free of secret text; see StrippedEntry.unsanitizable. */
function certifyStrippedAuth(auth: unknown): boolean {
	const virtualKey = (value: unknown) => certifyContainer(value, ["header"], {});
	const oauth = (value: unknown) => certifyContainer(value, ["tokenUrl", "clientId", "scopes"], { virtualKey });
	return certifyContainer(auth, [], { oauth, virtualKey });
}

/** Remove the entry's inline secret values; see StrippedEntry. */
export function stripEntrySecrets(rawEntry: Readonly<Record<string, unknown>>): StrippedEntry {
	const entry = cloneJson(rawEntry) as Record<string, unknown>;
	const secrets: MutableSecrets = {};
	// The pre-redesign flat shape parked secrets at the entry's top level under
	// the blob's own field ids. Beside a record-shaped auth object they DISCARD
	// instead (the migration's nested-wins-wholesale rule; see
	// StrippedEntry.secrets); without one they move 1:1. A container left at
	// one of these keys could still hide text; that flags the entry rather
	// than being guessed at.
	const nestedAuthWins = isRecord(rawEntry.auth);
	let flatResidue = false;
	for (const field of SECRET_FIELD_IDS) {
		if (nestedAuthWins) {
			if (usableText(entry[field]) !== undefined) {
				delete entry[field];
			}
		} else {
			takeSecret(entry, field, field, secrets);
		}
		if (!textless(entry[field])) {
			flatResidue = true;
		}
	}
	const auth = entry.auth;
	let removed = false;
	if (isRecord(auth)) {
		removed = takeSecret(auth, "apiKey", "apiKey", secrets);
		const oauth = auth.oauth;
		if (isRecord(oauth)) {
			removed = takeSecret(oauth, "apiKey", "apiKey", secrets) || removed;
			removed = takeSecret(oauth, "clientSecret", "oauthClientSecret", secrets) || removed;
		}
		const virtualKey = auth.virtualKey;
		if (isRecord(virtualKey)) {
			removed = takeSecret(virtualKey, "value", "virtualKeyValue", secrets) || removed;
		}
		if (isRecord(oauth) && isRecord(oauth.virtualKey)) {
			removed = takeSecret(oauth.virtualKey, "value", "virtualKeyValue", secrets) || removed;
		}
		// Only an auth object the strip itself emptied is deleted; a pre-existing
		// empty auth is the user's misconfiguration and rides through unchanged.
		if (removed && Object.keys(auth).length === 0) {
			delete entry.auth;
		}
	}
	return { entry, secrets, unsanitizable: !certifyStrippedAuth(entry.auth) || flatResidue };
}

/** materializeEntrySecrets' outcome: the entry with blob values inlined where legal. */
export interface MaterializedEntry {
	/**
	 * The entry with each blob value placed at its inline position, but only
	 * where the entry's auth shape already gives the field a legal home; an
	 * existing inline value stays (inline wins over the blob).
	 */
	readonly entry: Readonly<Record<string, unknown>>;
	/** Blob fields with no legal inline position in this entry's auth shape; counted and reported, never guessed into the file. */
	readonly unmaterialized: number;
}

/**
 * Place one blob value at its position, mirroring buildGroupArgs: a usable
 * inline occupant wins, an undefined or non-usable-string occupant is replaced,
 * and a non-string occupant reads as no legal home.
 */
function placeSecret(container: Record<string, unknown>, key: string, value: string): { placed: boolean } {
	const existing = container[key];
	if (usableText(existing) !== undefined) {
		return { placed: true };
	}
	if (existing !== undefined && typeof existing !== "string") {
		return { placed: false };
	}
	container[key] = value;
	return { placed: true };
}

/** Inline the label's stored blob into the entry; see MaterializedEntry. */
export function materializeEntrySecrets(
	rawEntry: Readonly<Record<string, unknown>>,
	blob: StoredServerSecrets
): MaterializedEntry {
	const entry = cloneJson(rawEntry) as Record<string, unknown>;
	let unmaterialized = 0;
	const place = (container: Record<string, unknown> | undefined, key: string, value: string) => {
		if (container === undefined || !placeSecret(container, key, value).placed) {
			unmaterialized += 1;
		}
	};
	// Blob values ride verbatim: readServerSecrets and buildGroupArgs use the
	// stored string untransformed, so the file must too. Only the empty string
	// reads as no value.
	const blobValue = (value: string | undefined): string | undefined =>
		value !== undefined && value.length > 0 ? value : undefined;

	const apiKey = blobValue(blob.apiKey);
	if (apiKey !== undefined) {
		const auth = entry.auth;
		if (auth === undefined) {
			entry.auth = { apiKey };
		} else if (!isRecord(auth)) {
			unmaterialized += 1;
		} else {
			place(isRecord(auth.oauth) ? auth.oauth : auth, "apiKey", apiKey);
		}
	}

	const clientSecret = blobValue(blob.oauthClientSecret);
	if (clientSecret !== undefined) {
		const auth = entry.auth;
		const oauth = isRecord(auth) && isRecord(auth.oauth) ? auth.oauth : undefined;
		place(oauth, "clientSecret", clientSecret);
	}

	const virtualKeyValue = blobValue(blob.virtualKeyValue);
	if (virtualKeyValue !== undefined) {
		const auth = entry.auth;
		const oauth = isRecord(auth) && isRecord(auth.oauth) ? auth.oauth : undefined;
		// The oauth-nested position outranks the sibling one, matching the strip
		// walk's later-position-wins order.
		const virtualKey =
			oauth !== undefined && isRecord(oauth.virtualKey)
				? oauth.virtualKey
				: isRecord(auth) && isRecord(auth.virtualKey)
					? auth.virtualKey
					: undefined;
		place(virtualKey, "value", virtualKeyValue);
	}

	return { entry, unmaterialized };
}
