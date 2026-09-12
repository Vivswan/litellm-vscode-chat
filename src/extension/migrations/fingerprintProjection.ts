/**
 * Retires the fingerprints hashed over the full group args; the engine compares only the "i1:" identity
 * rendering, and the legacy rendering lives here alone. Only a confirmed sync or an unambiguous host
 * observation writes the ledger, so a ledger URL equal to the entry's current normalized URL proves identity
 * whatever the old hash covered, which heals a key rotated before the upgrade (#277).
 *
 *   ownership-refused secret, no ledger match            -> left alone; the engine shows secretsMismatched anyway
 *   undeclared label                                     -> left alone; removal detection needs its record
 *   projection lost to globalState's last-write-wins     -> redone next activation; vscodeEnv.ts never lets a legacy record overwrite an "i1:" one
 *   old-version window writing full-args records back    -> healed the same way; both versions compare only by equality
 *   record matching neither proof                        -> left for the engine, which re-adds and reads a duplicate refusal as blocked, as before
 */

import * as vscode from "vscode";
import { CONFIG_SECTION, SERVERS_SETTING_KEY } from "../../shared/config/settingSpec";
import { SERVER_SYNC_FINGERPRINTS_KEY, SYNCED_ENTRY_BASE_URLS_KEY } from "../../shared/config/storageKeys";
import type { Logger } from "../../shared/logger";
import { normalizeBaseUrl } from "../../shared/util/baseUrl";
import { errorLabel } from "../../shared/util/errorLabel";
import { fingerprint } from "../../shared/util/fingerprint";
import { validatedStringRecord } from "../../shared/util/json";
import { buildGroupArgs, groupArgsFingerprint } from "../servers/serverSync/engine";
import type { StoredSecretsRecord } from "../servers/serverSync/secrets";
import { readServerSecretsRecord, resolveOwnedSecrets } from "../servers/serverSync/secrets";
import { parseServersSetting } from "../servers/serverSync/setting";
import type { ExtensionMigration, MigrationContext, MigrationOutcome } from "./index";

/** The pre-projection rendering, verbatim from the old engine: salted hash over the full args JSON, no prefix. */
function legacyGroupArgsFingerprint(args: Record<string, string>): string {
	return fingerprint(JSON.stringify(args));
}

/** The Memento slice the migration touches; vscode.Memento satisfies it. */
export interface FingerprintMemento {
	get(key: string): unknown;
	update(key: string, value: unknown): Thenable<void>;
}

/** The migration body over injectable reads; the wrapper below supplies the real ones. */
export async function projectSyncFingerprintsFor(
	readServersSetting: () => unknown,
	readSecrets: (label: string) => Promise<StoredSecretsRecord>,
	globalState: FingerprintMemento,
	confirmSaltDurable: () => Promise<boolean>,
	logger: Logger
): Promise<MigrationOutcome> {
	const stored = validatedStringRecord(globalState.get(SERVER_SYNC_FINGERPRINTS_KEY));
	const ledger = validatedStringRecord(globalState.get(SYNCED_ENTRY_BASE_URLS_KEY));
	const { entries } = parseServersSetting(readServersSetting());
	const candidates = entries.filter((entry) => {
		const record = stored[entry.label];
		return record !== undefined && !record.startsWith("i1:");
	});
	if (candidates.length === 0) {
		return "nothing-to-do";
	}
	// Deferred, not failed: prints computed under an unconfirmed salt would
	// match nothing, and the write gate below must never run under one either.
	if (!(await confirmSaltDurable())) {
		return "in-progress";
	}
	let failures = 0;
	const rewrites: Record<string, string> = {};
	for (const entry of candidates) {
		// Proof 1: the ledger already proved a live group holds this label at
		// this host, which is the whole identity - the record's credential
		// content is irrelevant, so no secrets read.
		if (ledger[entry.label] === normalizeBaseUrl(entry.baseUrl)) {
			rewrites[entry.label] = groupArgsFingerprint(buildGroupArgs(entry, {}));
			continue;
		}
		// Proof 2: the record IS the legacy rendering of the current args.
		let record: StoredSecretsRecord;
		try {
			record = await readSecrets(entry.label);
		} catch (error) {
			failures += 1;
			// Classification only: log lines feed the public issue-report buffer.
			logger.log("Reading a blob to project a sync fingerprint failed; retrying on next activation", {
				error: errorLabel(error),
			});
			continue;
		}
		const owned = resolveOwnedSecrets(entry, record);
		if (owned.refused.length > 0) {
			continue;
		}
		const args = buildGroupArgs(entry, owned.values);
		if (stored[entry.label] === legacyGroupArgsFingerprint(args)) {
			rewrites[entry.label] = groupArgsFingerprint(args);
		}
	}
	if (Object.keys(rewrites).length > 0) {
		try {
			// Re-gated at write time like the engine's own persists: a store
			// mutation since the check above must not persist unrecognizable
			// records over the durable ones.
			if (!(await confirmSaltDurable())) {
				return "in-progress";
			}
			// Merged over a FRESH read, never the pass-start snapshot, and a
			// rewrite applies only where the fresh value STILL equals the record
			// this pass judged: another window may have added labels (a whole-key
			// write of the stale snapshot would destroy them - #220's failure
			// class) or re-synced a candidate label itself (its newer record must
			// win over this pass's now-stale projection).
			const fresh = validatedStringRecord(globalState.get(SERVER_SYNC_FINGERPRINTS_KEY));
			const next = { ...fresh };
			let applied = 0;
			for (const [label, print] of Object.entries(rewrites)) {
				if (fresh[label] === stored[label]) {
					next[label] = print;
					applied += 1;
				}
			}
			if (applied === 0) {
				return failures > 0 ? "in-progress" : "nothing-to-do";
			}
			await globalState.update(SERVER_SYNC_FINGERPRINTS_KEY, next);
		} catch (error) {
			logger.log("Persisting projected sync fingerprints failed; retrying on next activation", {
				error: errorLabel(error),
			});
			return "in-progress";
		}
	}
	if (failures > 0) {
		return "in-progress";
	}
	return Object.keys(rewrites).length > 0 ? "migrated" : "nothing-to-do";
}

/**
 * Migrates away from: the full-args sync fingerprints of v0.6.0 and earlier.
 * Runs before the sync engine's first pass (migrations precede provider
 * registration and wireServers), so a healthy entry's record reads as in-sync
 * on the very first pass instead of degrading to a doomed re-add.
 */
export const fingerprintProjectionMigration: ExtensionMigration = {
	state: "full-args-sync-fingerprints",
	description: "Projected server-sync fingerprints onto the group-identity rendering",
	sourceRelease: "0.6.0",
	run(ctx: MigrationContext): Promise<MigrationOutcome> {
		return projectSyncFingerprintsFor(
			() => vscode.workspace.getConfiguration(CONFIG_SECTION).get(SERVERS_SETTING_KEY),
			(label) => readServerSecretsRecord(ctx.secrets, label),
			ctx.globalState,
			async () => (await ctx.fingerprintSalt.confirmDurable()) === "durable",
			ctx.logger
		);
	},
};
