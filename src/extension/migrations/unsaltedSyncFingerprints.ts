import * as vscode from "vscode";
import { CONFIG_SECTION } from "../../shared/config/settingSpec";
import { SERVERS_SETTING_KEY } from "../../shared/config/settings";
import { SERVER_SYNC_FINGERPRINTS_KEY } from "../../shared/config/storageKeys";
import type { Logger } from "../../shared/logger";
import type { SecretStore } from "../servers/serverSync";
import { buildGroupArgs, groupArgsFingerprint, parseServersSetting, readServerSecrets } from "../servers/serverSync";
import type { ExtensionMigration, MigrationContext, MigrationOutcome } from "./index";
import { legacyUnsaltedFingerprint } from "./legacyFingerprint";

/**
 * The stored map's expected container; anything else is left alone as not
 * this migration's state. Records are checked per label at use, so one
 * malformed sibling value cannot block every valid record's rewrite - the
 * engine's acceptance was per-label too, and a wholesale rejection here would
 * strand valid legacy records behind a sibling this migration does not own.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The renderings pre-salt extension versions persisted for one entry's group
 * args, newest first: unsalted with the label (v0.3.x), and unsalted without
 * it (versions before `label` joined buildGroupArgs - adding it changed every
 * fingerprint at once, and the host cannot update an existing group, so
 * without this recognition every healthy pre-label entry would wedge on a
 * permanent name-conflict error). buildGroupArgs keeps `label` right after
 * baseUrl exactly so removing it yields the pre-label key sequence byte for
 * byte. Comparison-only: nothing may persist these renderings, and nothing
 * outside src/extension/migrations/ may compute them.
 */
export function legacyGroupArgsFingerprints(args: Record<string, string>): readonly string[] {
	const { label: _label, ...legacyArgs } = args;
	return [legacyUnsaltedFingerprint(JSON.stringify(args)), legacyUnsaltedFingerprint(JSON.stringify(legacyArgs))];
}

/**
 * Rewrite the sync engine's stored fingerprint map from the unsalted
 * renderings pre-salt versions persisted to the salted form, so the unsalted
 * hashes of credential material leave globalState. This is the ONLY place
 * legacy renderings are recognized: the engine compares stored records
 * against the current salted rendering alone, so an entry whose record this
 * migration has not rewritten yet degrades to the engine's visible
 * name-conflict classification (the record itself is carried, never
 * overwritten) until a later run here rewrites it. Only records that provably
 * describe the entry's CURRENT content are rewritten: a record matching
 * neither rendering describes a configuration that changed while the
 * extension was off, and it stays put until a later activation finds the
 * entry reverted to the content it describes. Deliberate residual: such a
 * record keeps its unsalted rendering - still an offline verifier for the OLD
 * configuration's key - until that rewrite, or until the entry is
 * successfully re-synced or removed; dropping it instead would turn a later
 * revert into a permanent name-conflict error, and the no-wedge contract
 * outranks eager scrubbing. Records whose label has no declared entry are
 * left for the engine's removal pass, and entries whose stored secrets cannot
 * be read are skipped for the pass, exactly like the engine skips them.
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
	if (!isRecord(stored) || Object.keys(stored).length === 0) {
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
	const next: Record<string, unknown> = { ...stored };
	let rewritten = 0;
	let skipped = 0;
	for (const entry of entries) {
		const record = stored[entry.label];
		if (typeof record !== "string") {
			// Absent, or not a fingerprint at all: neither is this migration's
			// state, and a malformed value is preserved as-is like any other
			// foreign shape.
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
 * judged extinct - and this file is where the last legacy renderings die: a
 * record this migration has not rewritten yet surfaces through the engine as
 * the visible name-conflict error while the engine can run at all (a
 * changed-while-off entry, a failed run), whereas the conditions that defer
 * the rewrite itself (session-only salt, unreadable secrets) pause the
 * engine's pass for that entry too, under its own classified skip. Either
 * way the record is carried and a later run here rewrites it.
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
