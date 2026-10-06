/**
 * Every credential VALUE the extension knows, for the output door (Logger.redact): response-derived text (a 403 body
 * quoting the key) has no shape to mask by, so the configured values themselves are the handle. Collected
 * over-inclusively from every raw record by the parser's own readers (serverSync/setting.ts collectableEntries):
 * every string at every secret position, the one the parser selects and the ones it passes over, in an entry accepted
 * or rejected.
 *   inline secret values     -> every flat secret field and every nested position of SECRET_FIELD_NESTED_PATHS
 *   credential header values -> every raw header isCredentialHeader names, the entry's carrier among them
 *   SecretStorage blobs      -> every stored value under every declared label
 * A configured URL's userinfo is no value here: the door masks userinfo by its shape wherever a URL carries it, and a
 * user name registered as a value would blank it everywhere else ("/Users/alice/x").
 */

import { isCredentialHeader } from "../serverEntry";
import { MIN_SECRET_LENGTH } from "./secretMask";

/** What the collector reads of one raw record: every string at its secret, header, and carrier positions. */
export interface CollectableEntry {
	readonly secrets: readonly string[];
	readonly headers: Readonly<Record<string, string>>;
	readonly carriers: readonly string[];
}

/** The known values of the parsed entries plus the stored values read for them; short ones out, deduplicated. */
export function collectKnownSecretValues(
	entries: readonly CollectableEntry[],
	stored: Iterable<string | undefined>
): readonly string[] {
	const values = new Set<string>();
	const add = (value: string | undefined): void => {
		if (value !== undefined && value.length >= MIN_SECRET_LENGTH) {
			values.add(value);
		}
	};
	for (const entry of entries) {
		for (const secret of entry.secrets) {
			add(secret);
		}
		for (const [name, value] of Object.entries(entry.headers)) {
			if (isCredentialHeader(name, entry.carriers)) {
				add(value);
			}
		}
	}
	for (const value of stored) {
		add(value);
	}
	return [...values];
}
