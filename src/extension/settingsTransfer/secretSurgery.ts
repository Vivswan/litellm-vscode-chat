/**
 * Secret surgery on one raw servers-setting entry, over the five nested secret
 * positions the auth grammar admits (per parseAuth): `auth.apiKey`,
 * `auth.oauth.apiKey`, `auth.oauth.clientSecret`, `auth.virtualKey.value`, and
 * `auth.oauth.virtualKey.value`. Export-without-secrets strips them out; import
 * moves them from the file into SecretStorage; export-with-secrets materializes
 * stored blobs back into the entry.
 *
 * Strip trims what it takes (the inline settings grammar trims, so the trimmed
 * text IS the value the file carries); materialize places stored values
 * verbatim (buildGroupArgs sends stored strings untouched). So a stored value
 * with whitespace padding round-trips to its trimmed form.
 *
 * Pure and vscode-free.
 */

import type { SecretFieldId } from "../../shared/serverEntry";
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
	 * Two positions collide onto one field only in an auth shape parseAuth would
	 * reject; positions are walked in the module-comment order and a later one
	 * overwrites an earlier one.
	 */
	readonly secrets: StoredServerSecrets;
	/**
	 * True when the stripped entry's auth subtree still carries text (or a
	 * container that could hold text) anywhere but the grammar's known
	 * non-secret text positions (`oauth.tokenUrl`, `oauth.clientId`,
	 * `oauth.scopes`, a virtualKey's `header`). The `auth` object exists to hold
	 * credentials, so leftover text at an unknown or malformed position is
	 * presumed to be one and a no-secrets export must omit the entry rather than
	 * trust it. Textless scalars are mere misconfiguration and stay sanitizable.
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
	return { entry, secrets, unsanitizable: !certifyStrippedAuth(entry.auth) };
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
