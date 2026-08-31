/**
 * Rewrites persisted server-sync fingerprints from the legacy full-args
 * rendering (a salted hash over the whole buildGroupArgs object, credentials
 * included) to the identity-only rendering the engine compares against today
 * (groupArgsFingerprint's "i1:"-prefixed projection). State-detecting and
 * idempotent: the legacy state is a declared entry whose stored record lacks
 * the "i1:" prefix.
 *
 * A record is rewritten on either of two proofs, checked in order:
 *
 * 1. The identity ledger (SYNCED_ENTRY_BASE_URLS_KEY) names the entry's
 *    current normalized base URL for the label. A ledger record is written
 *    only when a pass proved the live group held exactly the entry's
 *    configuration, so a match proves the group's IDENTITY regardless of what
 *    the legacy record's credentials were - this is what heals the #277 state
 *    itself, where the key was rotated before the upgrade and the legacy
 *    rendering can never be recomputed.
 * 2. The record equals the legacy rendering of the entry's current args (the
 *    fallback for labels the ledger predates). The legacy rendering below is
 *    quarantined here on purpose; the engine knows only the current one.
 *
 * Anything else (a record for a re-pointed entry, a blocked entry's carried
 * last-known-good) is left for the engine to classify exactly as before.
 * Undeclared labels' records are left untouched (removal detection needs
 * them). An entry whose stored secret is ownership-refused waits on the
 * legacy path (the engine shows secretsMismatched for it anyway); the ledger
 * path does not read secrets at all.
 *
 * Multi-window note: the write merges the rewrites over a FRESH read of the
 * store, applying each only where the fresh value still equals the record
 * this pass judged, so records another window added or re-synced while this
 * pass ran survive. What remains is globalState's documented last-write-wins
 * hazard: two windows activating at once can interleave whole-key writes and
 * one window's projections can be lost. Three layers bound the damage: the
 * migration reruns on EVERY activation (state-detecting) and the ledger proof
 * needs no secrets, so a lost projection is redone on the next activation;
 * the real env's setFingerprints never overwrites a current-format store
 * record with a carried legacy-format one, so an engine pass in the losing
 * window cannot un-project a label another window already projected; and in
 * the theoretical residue (stale storage reads defeating both, a pre-ledger
 * label, a rotation before any healthy activation) the label degrades to the
 * blocked classification with its documented manual fix - exactly the
 * pre-migration behavior for every rotation, never anything worse.
 * Cross-process atomicity would take the versioned-blob protocol
 * (groupRemovals.ts), the engine's own persistence design, not a migration's.
 * A concurrent OLD-version window writing full-args records back is healed
 * the same way - both versions compare records only by equality, so the churn
 * is non-destructive in both directions.
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
