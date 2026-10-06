/**
 * Rewrites stored servers entries to the one URL spelling (shared/util/baseUrl.ts canonicalUrl) and carries each
 * entry's sync fingerprint across, so the group the host created under the user's spelling stays that entry's group.
 * `servers` is machine scope, so the user-scope value is the only one read or written.
 *
 *   baseUrl, auth.oauth.tokenUrl, mcp.url of an ACCEPTED entry -> the canonical spelling; every other byte stays
 *   a rejected or label-shadowed entry                          -> left as typed until it is accepted; its fingerprint
 *                                                                 can only be carried then, and the old spelling is
 *                                                                 the key
 *   fingerprint record equal to the old spelling's print        -> the canonical spelling's print
 *   a record matching neither spelling                          -> left for the engine, as before this migration
 *   a URL with no canonical spelling                            -> left as typed; the parser reports it by field
 *   secret stamps and the identity ledger                       -> no carry: stamps decode canonically wherever they
 *                                                                 are read (shared/serverEntry.ts parseSecretOwner),
 *                                                                 and the engine rewrites the ledger on the first
 *                                                                 in-sync pass
 *
 * Fingerprints first, the setting last: the old spelling is the only key to the old record, so a failed carry keeps
 * it for the next activation, while a deferred setting write costs nothing (the parser reads the canonical form
 * either way). The carry needs no salt gate: a record equals the old spelling's print only under the salt that wrote
 * it, and the new print is computed under that same salt.
 */

import { SERVER_SYNC_FINGERPRINTS_KEY } from "../../shared/config/storageKeys";
import type { Logger } from "../../shared/logger";
import { errorLabel } from "../../shared/util/errorLabel";
import { isRecord, validatedStringRecord } from "../../shared/util/json";
import { buildGroupArgs, groupArgsFingerprint } from "../servers/serverSync/engine";
import type { DeclaredServer } from "../servers/serverSync/setting";
import { acceptedEntries, respellEntryUrls } from "../servers/serverSync/setting";
import type { ServersSettingStore } from "../servers/serversSettingWrite";
import { replaceServersSetting } from "../servers/serversSettingWrite";
import { createSettingsAccess } from "../settingsAccess";
import type { FingerprintMemento } from "./fingerprintProjection";
import type { ExtensionMigration, MigrationContext, MigrationOutcome } from "./index";

export async function canonicalizeUrlSpellingsFor(
	settings: ServersSettingStore,
	globalState: FingerprintMemento,
	logger: Logger
): Promise<MigrationOutcome> {
	const value = settings.readServersSetting();
	const raw: readonly unknown[] = Array.isArray(value) ? value : [];
	// The accepted carrier of each label, by raw index: the only entries whose spelling and record move.
	const carriers = new Map<number, DeclaredServer>(acceptedEntries(raw).map(({ index, entry }) => [index, entry]));
	const respelled: readonly { record: unknown; changed: boolean; oldBaseUrl?: string }[] = raw.map((item, index) =>
		carriers.has(index) && isRecord(item) ? respellEntryUrls(item) : { record: item, changed: false }
	);

	let rewrites = 0;
	const stored = validatedStringRecord(globalState.get(SERVER_SYNC_FINGERPRINTS_KEY));
	const printRewrites: Record<string, string> = {};
	for (const [index, entry] of carriers) {
		const oldBaseUrl = respelled[index]?.oldBaseUrl;
		if (oldBaseUrl === undefined || oldBaseUrl === entry.baseUrl) {
			continue;
		}
		if (stored[entry.label] === groupArgsFingerprint(buildGroupArgs({ ...entry, baseUrl: oldBaseUrl }, {}))) {
			printRewrites[entry.label] = groupArgsFingerprint(buildGroupArgs(entry, {}));
		}
	}
	if (Object.keys(printRewrites).length > 0) {
		try {
			// Merged over a FRESH read and applied only where the value still equals the record this pass judged, so
			// another window's newer records survive (the whole-key write hazard of #220).
			const fresh = validatedStringRecord(globalState.get(SERVER_SYNC_FINGERPRINTS_KEY));
			const merged = { ...fresh };
			for (const [label, print] of Object.entries(printRewrites)) {
				if (fresh[label] === stored[label]) {
					merged[label] = print;
					rewrites += 1;
				}
			}
			if (rewrites > 0) {
				await globalState.update(SERVER_SYNC_FINGERPRINTS_KEY, merged);
			}
		} catch (error) {
			// Classification only: log lines feed the public issue-report buffer.
			logger.log("Persisting sync fingerprints for the canonical URL spelling failed; retrying on next activation", {
				error: errorLabel(error),
			});
			return "in-progress";
		}
	}

	if (respelled.some((item) => item.changed)) {
		// Written only while the setting still reads as this pass read it (the write turn checks in the same tick): an
		// edit landing during the awaits above (another window, the user) must not be overwritten by the pass-start
		// snapshot.
		let written: boolean;
		try {
			written = await replaceServersSetting(
				settings,
				value,
				respelled.map((item) => item.record)
			);
		} catch (error) {
			logger.log("Rewriting the servers setting to the canonical URL spelling failed; retrying on next activation", {
				error: errorLabel(error),
			});
			return "in-progress";
		}
		if (!written) {
			logger.log("The servers setting changed during the canonical URL spelling rewrite; retrying on next activation");
			return "in-progress";
		}
		rewrites += 1;
	}
	return rewrites > 0 ? "migrated" : "nothing-to-do";
}

/**
 * Runs before the sync engine's first pass, so an entry whose spelling changed reads as in-sync on that pass instead
 * of degrading to a re-add. The write turn it takes is module state, alive from the moment the module loads, and the
 * migration is awaited before the import commands and the dashboard register, so no other writer exists yet.
 */
export const canonicalUrlSpellingsMigration: ExtensionMigration<"uncanonical-url-spellings"> = {
	state: "uncanonical-url-spellings",
	description: "Rewrote server URLs to their canonical spelling and carried their group identities across",
	sourceRelease: "0.6.7",
	run(ctx: MigrationContext): Promise<MigrationOutcome> {
		return canonicalizeUrlSpellingsFor(createSettingsAccess(), ctx.globalState, ctx.logger);
	},
};
