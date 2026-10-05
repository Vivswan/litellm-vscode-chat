/**
 * Secret surgery on one raw servers-setting entry, over the five nested secret positions the auth grammar admits (per
 * parseAuth): `auth.apiKey`, `auth.oauth.apiKey`, `auth.oauth.clientSecret`, `auth.virtualKey.value`, and
 * `auth.oauth.virtualKey.value` - plus the pre-redesign flat shape's top-level secret fields, which map 1:1 onto the
 * blob's ids when no record-shaped auth object outranks them (see StrippedEntry.secrets). So a stored value with
 * whitespace padding round-trips to its trimmed form.
 *
 *   the inline settings grammar trims, so the trimmed text IS the value the file carries -> Strip trims what it takes
 *   buildGroupArgs sends stored strings untouched -> materialize places stored values verbatim
 *
 * Two credential positions have no blob slot, so the surgery treats them by position alone.
 *   credential-bearing custom header (isCredentialHeader)  -> no-secrets export drops it; the import lands it in
 *                                                             settings
 *   user:password@ in a URL field                           -> no-secrets export rebuilds the URL; the import keeps it
 */

import type { SecretFieldId } from "../../shared/serverEntry";
import {
	isCredentialHeader,
	OPTIONAL_ENTRY_FIELDS,
	SECRET_FIELD_IDS,
	virtualKeyHeaderNames,
} from "../../shared/serverEntry";
import { configuredUserinfo, displayUrl } from "../../shared/util/displayUrl";
import { trimHttpWhitespace, usableHttpText } from "../../shared/util/headers";
import { isRecord, isUnsafeRecordKey } from "../../shared/util/json";
import type { StoredServerSecrets } from "../servers/serverSync/secrets";

type MutableSecrets = { -readonly [K in SecretFieldId]?: string };

function cloneJson(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(cloneJson);
	}
	if (isRecord(value)) {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item)]));
	}
	return value;
}

export interface StrippedEntry {
	readonly entry: Readonly<Record<string, unknown>>;
	/**
	 * Flat-vs-nested collisions resolve by the settings-redesign migration's OWN rule, so a transfer can never
	 * change which credentials an entry sends. A record-shaped `auth` wins WHOLESALE and flat secret text beside
	 * it is DISCARDED, never moved into the blob, exactly as the activation migration discards it.
	 */
	readonly secrets: StoredServerSecrets;
	/**
	 * Textless scalars are mere misconfiguration and stay sanitizable.
	 *
	 *   A no-secrets export -> omits such an entry rather than trust it
	 *   the import          -> skips it rather than land unmovable credential text
	 */
	readonly unsanitizable: boolean;
}

function takeSecret(
	container: Record<string, unknown>,
	key: string,
	field: SecretFieldId,
	blob: MutableSecrets
): boolean {
	const value = usableHttpText(container[key]);
	if (value === undefined) {
		return false;
	}
	blob[field] = value;
	delete container[key];
	return true;
}

function textless(value: unknown): boolean {
	return (
		value === undefined ||
		value === null ||
		typeof value === "number" ||
		typeof value === "boolean" ||
		(typeof value === "string" && trimHttpWhitespace(value).length === 0)
	);
}

/**
 * Certify one already-stripped auth container against a key whitelist: `text`
 * keys may hold strings, `walk` keys recurse, and every other occupant must be
 * textless. Anything else could be a credential the strip did not reach.
 *
 *   auth: { toString: "sk" }     -> a plain index into the table reaches Object.prototype.toString and certifies
 *   auth: { "__proto__": "sk" }  -> the same read throws
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
		if (isUnsafeRecordKey(key)) {
			return false;
		}
		if (text.includes(key)) {
			return typeof occupant === "string" || textless(occupant);
		}
		const into = Object.hasOwn(walk, key) ? walk[key] : undefined;
		return into !== undefined ? into(occupant) : textless(occupant);
	});
}

function certifyStrippedAuth(auth: unknown): boolean {
	const virtualKey = (value: unknown) => certifyContainer(value, ["header"], {});
	const oauth = (value: unknown) => certifyContainer(value, ["tokenUrl", "clientId", "scopes"], { virtualKey });
	return certifyContainer(auth, [], { oauth, virtualKey });
}

export function stripEntrySecrets(rawEntry: Readonly<Record<string, unknown>>): StrippedEntry {
	const entry = cloneJson(rawEntry) as Record<string, unknown>;
	const secrets: MutableSecrets = {};
	// Beside a record-shaped auth object they DISCARD instead (the migration's nested-wins-wholesale rule; see
	// StrippedEntry.secrets); without one they move 1:1. A container left at one of these keys could still hide text;
	// that flags the entry rather than being guessed at.
	const nestedAuthWins = isRecord(rawEntry.auth);
	let flatResidue = false;
	for (const field of SECRET_FIELD_IDS) {
		if (nestedAuthWins) {
			if (usableHttpText(entry[field]) !== undefined) {
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
		// Only an auth object the strip itself emptied is deleted; a pre-existing empty auth is the user's
		// misconfiguration and rides through unchanged.
		if (removed && Object.keys(auth).length === 0) {
			delete entry.auth;
		}
	}
	return { entry, secrets, unsanitizable: !certifyStrippedAuth(entry.auth) || flatResidue };
}

/**
 * stripCredentialHeaders' outcome. A headers field the strip cannot walk (text or a container where the grammar
 * wants a record of scalars) has no sanitized entry at all: like an uncertifiable auth shape, its text is presumed
 * to be a misplaced credential, and a no-secrets export omits the entry.
 */
export type StrippedHeaders =
	| {
			readonly unsanitizable: false;
			/** The entry without its credential-bearing custom header values. */
			readonly entry: Readonly<Record<string, unknown>>;
			/** The names removed; a with-secrets export counts them as inline secret values. */
			readonly removed: readonly string[];
	  }
	| { readonly unsanitizable: true; readonly removed: readonly string[] };

export function stripCredentialHeaders(rawEntry: Readonly<Record<string, unknown>>): StrippedHeaders {
	const raw = rawEntry.headers;
	if (!isRecord(raw)) {
		return textless(raw)
			? { unsanitizable: false, entry: rawEntry, removed: [] }
			: { unsanitizable: true, removed: [] };
	}
	const carriers = virtualKeyHeaderNames(rawEntry);
	const removed = Object.keys(raw).filter((name) => isCredentialHeader(name, carriers));
	const kept = Object.entries(raw).filter(([name]) => !removed.includes(name));
	if (kept.some(([, value]) => typeof value === "object" && value !== null)) {
		return { unsanitizable: true, removed };
	}
	const entry = removed.length === 0 ? rawEntry : { ...rawEntry, headers: Object.fromEntries(kept) };
	return { unsanitizable: false, entry, removed };
}

/**
 * stripUrlUserinfo's outcome. A container at a URL position (an array where a string belongs) could hold a
 * credentialed URL the walk cannot see, so like an unwalkable headers shape it has no sanitized entry and a
 * no-secrets export omits the entry.
 */
export type StrippedUrls =
	| {
			readonly unsanitizable: false;
			/** The entry with each URL field rebuilt without userinfo. */
			readonly entry: Readonly<Record<string, unknown>>;
			/** How many URL fields carried userinfo; a with-secrets export counts them as inline secret values. */
			readonly removed: number;
	  }
	| { readonly unsanitizable: true; readonly removed: number };

/**
 * The entry grammar's URL positions, from the shared field table: the "uri" fields flat beside baseUrl, their nested
 * keys under auth.oauth, and McpOptIn's url. By container, because the same spelling elsewhere (mcp.tokenUrl) is a key
 * the parser ignores, not a URL.
 */
type UriEntryField = Extract<(typeof OPTIONAL_ENTRY_FIELDS)[number], { readonly format: "uri" }>;
const URI_ENTRY_FIELDS = OPTIONAL_ENTRY_FIELDS.filter(
	(field): field is UriEntryField => "format" in field && field.format === "uri"
);
const FLAT_URL_KEYS: readonly string[] = ["baseUrl", ...URI_ENTRY_FIELDS.map((field) => field.id)];
const OAUTH_URL_KEYS: readonly string[] = URI_ENTRY_FIELDS.map((field) => field.nestedKey);
const MCP_URL_KEYS: readonly string[] = ["url"];

/**
 * Every URL position of the raw entry, rebuilt through displayUrl when the shared finder reads a credential in it: a
 * `user:password@` written into a URL is one the no-secrets export must not carry, and one the with-secrets export
 * counts. A URL without one rides as written, tabs and all.
 */
export function stripUrlUserinfo(rawEntry: Readonly<Record<string, unknown>>): StrippedUrls {
	let removed = 0;
	let unsanitizable = false;
	const rebuilt = (container: Readonly<Record<string, unknown>>, keys: readonly string[]): Record<string, unknown> =>
		Object.fromEntries(
			Object.entries(container).map(([key, value]) => {
				if (!keys.includes(key)) {
					return [key, value];
				}
				if (typeof value !== "string") {
					unsanitizable ||= typeof value === "object" && value !== null;
					return [key, value];
				}
				if (configuredUserinfo(value).length === 0) {
					return [key, value];
				}
				removed += 1;
				return [key, displayUrl(value)];
			})
		);
	const entry = rebuilt(rawEntry, FLAT_URL_KEYS);
	if (isRecord(rawEntry.auth) && isRecord(rawEntry.auth.oauth)) {
		entry.auth = { ...rawEntry.auth, oauth: rebuilt(rawEntry.auth.oauth, OAUTH_URL_KEYS) };
	}
	if (isRecord(rawEntry.mcp)) {
		entry.mcp = rebuilt(rawEntry.mcp, MCP_URL_KEYS);
	} else if (!textless(rawEntry.mcp)) {
		unsanitizable = true;
	}
	if (unsanitizable) {
		return { unsanitizable, removed };
	}
	return { unsanitizable, entry: removed === 0 ? rawEntry : entry, removed };
}

/** materializeEntrySecrets' outcome: the entry with blob values inlined where legal. */
export interface MaterializedEntry {
	/**
	 *   The entry with each blob value placed at its inline position -> only where the entry's auth shape already
	 *       gives the field a legal home
	 */
	readonly entry: Readonly<Record<string, unknown>>;
	/**
	 * Blob fields with no legal inline position in this entry's auth shape; counted and reported, never guessed into
	 * the file.
	 */
	readonly unmaterialized: number;
}

/**
 * Place one blob value at its position, mirroring buildGroupArgs: a usable inline occupant wins, an undefined or
 * non-usable-string occupant is replaced, and a non-string occupant reads as no legal home.
 */
function placeSecret(container: Record<string, unknown>, key: string, value: string): { placed: boolean } {
	const existing = container[key];
	if (usableHttpText(existing) !== undefined) {
		return { placed: true };
	}
	if (existing !== undefined && typeof existing !== "string") {
		return { placed: false };
	}
	container[key] = value;
	return { placed: true };
}

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
	// Blob values ride verbatim: readServerSecrets and buildGroupArgs use the stored string untransformed, so the file
	// must too. Only the empty string reads as no value.
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
		// The oauth-nested position outranks the sibling one, matching the strip walk's later-position-wins order.
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
