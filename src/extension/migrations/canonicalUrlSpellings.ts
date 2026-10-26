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
 *
 * The write turn the migration takes is module state, alive from the moment the module loads, and the migration is
 * awaited before the import commands and the dashboard register, so no other writer exists yet.
 */

import { SERVER_SYNC_FINGERPRINTS_KEY } from "../../shared/config/storageKeys";
import type { Logger } from "../../shared/logger";
import { errorLabel } from "../../shared/util/errorLabel";
import { isRecord, validatedStringRecord } from "../../shared/util/json";
import { buildGroupArgs, groupArgsFingerprint } from "../servers/serverSync/engine";
import type { DeclaredServer } from "../servers/serverSync/setting";
import { acceptedEntries, respellEntryUrls } from "../servers/serverSync/setting";
import { createSettingsAccess } from "../settingsAccess";
import type { ServersSettingStore } from "../settingsWriteTurn";
import { replaceServersSetting } from "../settingsWriteTurn";
import { type FingerprintMemento, persistFingerprintRewrites } from "./fingerprintProjection";
import type { ExtensionMigration, MigrationContext, MigrationOutcome } from "./index";

/** One raw entry after respellEntryUrls: the record to write, whether it changed, and the base URL it had before. */
type RespelledEntry = { record: unknown; changed: boolean; oldBaseUrl?: string };

/**
 * The fingerprint rewrites the respelling earns: for each carrier whose base URL changed and whose stored record equals
 * the OLD spelling's print, the canonical spelling's print, keyed by label.
 */
function fingerprintRewrites(
	carriers: ReadonlyMap<number, DeclaredServer>,
	respelled: readonly RespelledEntry[],
	stored: Readonly<Record<string, string>>
): Record<string, string> {
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
	return printRewrites;
}

/**
 * Writes the respelled records over the setting: true when written, false when the write failed or the setting changed
 * under the pass (both logged; the next activation retries). The write turn checks in the same tick that the setting
 * still reads as this pass read it, so an edit landing during the awaits before it (another window, the user) is never
 * overwritten by the pass-start snapshot.
 */
async function rewriteSetting(
	settings: ServersSettingStore,
	value: unknown,
	records: readonly unknown[],
	logger: Logger
): Promise<boolean> {
	let written: boolean;
	try {
		written = await replaceServersSetting(settings, value, records);
	} catch (error) {
		logger.log("Rewriting the servers setting to the canonical URL spelling failed; retrying on next activation", {
			error: errorLabel(error),
		});
		return false;
	}
	if (!written) {
		logger.log("The servers setting changed during the canonical URL spelling rewrite; retrying on next activation");
		return false;
	}
	return true;
}

export async function canonicalizeUrlSpellingsFor(
	settings: ServersSettingStore,
	globalState: FingerprintMemento,
	logger: Logger
): Promise<MigrationOutcome> {
	const value = settings.readServersSetting();
	const raw: readonly unknown[] = Array.isArray(value) ? value : [];
	// The accepted carrier of each label, by raw index: the only entries whose spelling and record move.
	const carriers = new Map<number, DeclaredServer>(acceptedEntries(raw).map(({ index, entry }) => [index, entry]));
	const respelled: readonly RespelledEntry[] = raw.map((item, index) =>
		carriers.has(index) && isRecord(item) ? respellEntryUrls(item) : { record: item, changed: false }
	);

	let rewrites = 0;
	const stored = validatedStringRecord(globalState.get(SERVER_SYNC_FINGERPRINTS_KEY));
	const printRewrites = fingerprintRewrites(carriers, respelled, stored);
	if (Object.keys(printRewrites).length > 0) {
		try {
			rewrites += await persistFingerprintRewrites(globalState, stored, printRewrites);
		} catch (error) {
			// Classification only: log lines feed the public issue-report buffer.
			logger.log("Persisting sync fingerprints for the canonical URL spelling failed; retrying on next activation", {
				error: errorLabel(error),
			});
			return "in-progress";
		}
	}

	if (respelled.some((item) => item.changed)) {
		const written = await rewriteSetting(
			settings,
			value,
			respelled.map((item) => item.record),
			logger
		);
		if (!written) {
			return "in-progress";
		}
		rewrites += 1;
	}
	return rewrites > 0 ? "migrated" : "nothing-to-do";
}

/** Runs before the sync engine's first pass, so a respelled entry reads as in-sync instead of being re-added. */
export const canonicalUrlSpellingsMigration: ExtensionMigration<"uncanonical-url-spellings"> = {
	state: "uncanonical-url-spellings",
	description: "Rewrote server URLs to their canonical spelling and carried their group identities across",
	sourceRelease: "0.6.7",
	run(ctx: MigrationContext): Promise<MigrationOutcome> {
		return canonicalizeUrlSpellingsFor(createSettingsAccess(), ctx.globalState, ctx.logger);
	},
};
