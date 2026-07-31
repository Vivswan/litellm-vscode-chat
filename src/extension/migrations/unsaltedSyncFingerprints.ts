import * as vscode from "vscode";
import { CONFIG_SECTION } from "../../shared/config/settingSpec";
import { SERVERS_SETTING_KEY } from "../../shared/config/settings";
import { SERVER_SYNC_FINGERPRINTS_KEY } from "../../shared/config/storageKeys";
import type { Logger } from "../../shared/logger";
import type { SecretStore } from "../servers/serverSync";
import {
	buildGroupArgs,
	groupArgsFingerprint,
	legacyGroupArgsFingerprints,
	parseServersSetting,
	readServerSecrets,
} from "../servers/serverSync";
import type { ExtensionMigration, MigrationContext, MigrationOutcome } from "./index";

/** The stored map's expected shape; anything else is left alone as not this migration's state. */
function isStringRecord(value: unknown): value is Record<string, string> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.values(value).every((member) => typeof member === "string")
	);
}

/**
 * Rewrite the sync engine's stored fingerprint map from the unsalted
 * renderings pre-salt versions persisted to the salted form, so the unsalted
 * hashes of credential material leave globalState instead of waiting for
 * each entry's next confirmed host round trip. Only records that provably
 * describe the entry's CURRENT content are rewritten: a record matching
 * neither rendering describes a configuration that changed while the
 * extension was off, and the engine's conflict handling owns it (its
 * legacy-rendering acceptance upgrades such a record the moment the entry is
 * reverted). Deliberate residual: such a record keeps its unsalted rendering
 * - still an offline verifier for the OLD configuration's key - until the
 * entry is reverted, successfully re-synced, or removed; dropping it instead
 * would turn a later revert into a permanent name-conflict error, and the
 * no-wedge contract outranks eager scrubbing. Records whose label has no
 * declared entry are left for the engine's removal pass, and entries whose
 * stored secrets cannot be read are skipped for the pass, exactly like the
 * engine skips them.
 *
 * Deferred entirely while the fingerprint salt is session-only: rewriting
 * under a salt that will not survive the session would destroy the only
 * records that let healthy groups read as in-sync later.
 */
export async function rewriteUnsaltedSyncFingerprints(
	readSetting: () => unknown,
	secrets: SecretStore,
	ctx: Pick<MigrationContext, "globalState" | "fingerprintSalt"> & { logger: Logger }
): Promise<MigrationOutcome> {
	const stored = ctx.globalState.get<unknown>(SERVER_SYNC_FINGERPRINTS_KEY);
	if (!isStringRecord(stored) || Object.keys(stored).length === 0) {
		return "nothing-to-do";
	}
	// Confirmed at decision time, not activation time: another window's
	// first-activation salt store can supersede this session's salt after
	// load, and a rewrite under a superseded salt would destroy the records.
	if ((await ctx.fingerprintSalt.confirmDurable()) !== "durable") {
		ctx.logger.log("Deferring the sync-fingerprint rewrite: the fingerprint salt is session-only");
		return "in-progress";
	}
	const { entries } = parseServersSetting(readSetting());
	const next: Record<string, string> = { ...stored };
	let rewritten = 0;
	let skipped = 0;
	for (const entry of entries) {
		const record = stored[entry.label];
		if (record === undefined) {
			continue;
		}
		let blob: Awaited<ReturnType<typeof readServerSecrets>>;
		try {
			blob = await readServerSecrets(secrets, entry.label);
		} catch {
			// Without the real secrets neither rendering is computable; the entry
			// keeps its record and the next activation retries, like the engine's
			// own secretsUnreadable pass.
			skipped += 1;
			continue;
		}
		const args = buildGroupArgs(entry, blob);
		if (legacyGroupArgsFingerprints(args).includes(record)) {
			next[entry.label] = groupArgsFingerprint(args);
			rewritten += 1;
		}
	}
	if (rewritten > 0) {
		// Re-confirmed immediately before the write: a salt mutation detected
		// after the entry gate must not rewrite the records it was meant to
		// protect.
		if ((await ctx.fingerprintSalt.confirmDurable()) !== "durable") {
			ctx.logger.log("Deferring the sync-fingerprint rewrite: the fingerprint salt is session-only");
			return "in-progress";
		}
		await ctx.globalState.update(SERVER_SYNC_FINGERPRINTS_KEY, next);
		return "migrated";
	}
	return skipped > 0 ? "in-progress" : "nothing-to-do";
}

/**
 * Migrates away from: the unsalted server-sync fingerprints of v0.3.1 and
 * earlier (fingerprint() gained its per-install salt in the first release
 * after v0.3.1). Deletable once installs still carrying unsalted records are
 * judged extinct; the engine's legacy-rendering acceptance has to survive as
 * long as records this migration could not rewrite (changed-while-off
 * entries, unreadable secrets) may still exist.
 *
 * Pre-registration on purpose: it must finish before the sync engine's first
 * pass seeds its in-memory map from the store.
 */
export const unsaltedSyncFingerprintsMigration: ExtensionMigration = {
	state: "unsalted-sync-fingerprints",
	description: "Re-keyed the stored server-sync fingerprints with the per-install salt",
	sourceRelease: "0.3.1",
	phase: "pre-registration",
	run(ctx: MigrationContext): Promise<MigrationOutcome> {
		return rewriteUnsaltedSyncFingerprints(
			() => vscode.workspace.getConfiguration(CONFIG_SECTION).get(SERVERS_SETTING_KEY),
			ctx.secrets,
			ctx
		);
	},
};
