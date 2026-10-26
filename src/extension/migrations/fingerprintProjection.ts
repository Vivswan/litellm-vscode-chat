/**
 * Retires the fingerprints hashed over the full group args; the engine compares only the "i1:" identity rendering, and
 * the legacy rendering lives here alone. Only a confirmed sync or an unambiguous host observation writes the ledger, so
 * a ledger URL equal to the entry's current normalized URL proves identity whatever the old hash covered, which heals a
 * key rotated before the upgrade (#277).
 *
 *   ownership-refused secret, no ledger match         -> left alone
 *   the engine shows secretsMismatched anyway         -> left alone
 *   undeclared label                                  -> left alone
 *   removal detection needs its record                -> left alone
 *   projection lost to globalState's last-write-wins  -> redone next activation; vscodeEnv.ts never lets a legacy
 *                                                        record overwrite an "i1:" one
 *   old-version window writing full-args records back -> healed the same way
 *   both versions compare only by equality            -> healed the same way
 *   record matching neither proof                     -> left for the engine, which re-adds and reads a duplicate
 *                                                        refusal as blocked, as before
 *
 * Migrations precede provider registration and wireServers, so the projection lands before the engine's first pass.
 * LEGACY_ARGS_KEY_ORDER is the pre-projection engine's rendering key by key; a field added later never enters it,
 * since the old engine never wrote it.
 */

import { SERVER_SYNC_FINGERPRINTS_KEY, SYNCED_ENTRY_BASE_URLS_KEY } from "../../shared/config/storageKeys";
import type { Logger } from "../../shared/logger";
import type { OptionalEntryFieldId } from "../../shared/serverEntry";
import { normalizeBaseUrl } from "../../shared/util/baseUrl";
import { errorLabel } from "../../shared/util/errorLabel";
import { fingerprint } from "../../shared/util/fingerprint";
import { validatedStringRecord } from "../../shared/util/json";
import { buildGroupArgs, groupArgsFingerprint } from "../servers/serverSync/engine";
import type { StoredSecretsRecord } from "../servers/serverSync/secrets";
import { readServerSecretsRecord, resolveOwnedSecrets } from "../servers/serverSync/secrets";
import type { DeclaredServer } from "../servers/serverSync/setting";
import { parseServersSetting } from "../servers/serverSync/setting";
import { canonicalEntryBaseUrls, readRawServersSetting } from "../servers/serverSync/vscodeEnv";
import type { ExtensionMigration, MigrationContext, MigrationOutcome } from "./index";

/** The old engine's serialization order; buildGroupArgs' insertion order means nothing here. */
const LEGACY_ARGS_KEY_ORDER = [
	"name",
	"vendor",
	"baseUrl",
	"label",
	"apiKey",
	"oauthTokenUrl",
	"oauthClientId",
	"oauthClientSecret",
	"oauthScopes",
	"virtualKeyHeader",
	"virtualKeyValue",
] as const satisfies readonly ("name" | "vendor" | "baseUrl" | "label" | OptionalEntryFieldId)[];

/** The pre-projection rendering, verbatim from the old engine: salted hash over the full args JSON, no prefix. */
function legacyGroupArgsFingerprint(args: Readonly<Record<string, string>>): string {
	return fingerprint(JSON.stringify(args, [...LEGACY_ARGS_KEY_ORDER]));
}

export interface FingerprintMemento {
	get(key: string): unknown;
	update(key: string, value: unknown): Thenable<void>;
}

/** What one candidate's projection reads: the pass-start records, the ledger, and the blob read. */
interface ProjectionReads {
	readonly stored: Readonly<Record<string, string>>;
	readonly ledger: Readonly<Record<string, string>>;
	readonly readSecrets: (label: string) => Promise<StoredSecretsRecord>;
	readonly logger: Logger;
}

/** One candidate's projection: the print it earns, none when neither proof holds, or a blob read that threw. */
type Projection = { readonly kind: "print"; readonly print: string } | { readonly kind: "none" | "failed" };

/**
 * The identity print one candidate earns; a failed blob read is logged and the next activation retries it. Proof 1 is
 * the ledger: it already proved a live group holds this label at this host, which is the whole identity, so the
 * record's credential content is irrelevant and no secrets are read. Proof 2 is the record being the legacy rendering
 * of the current args.
 */
async function projectedPrint(entry: DeclaredServer, reads: ProjectionReads): Promise<Projection> {
	if (reads.ledger[entry.label] === normalizeBaseUrl(entry.baseUrl)) {
		return { kind: "print", print: groupArgsFingerprint(buildGroupArgs(entry, {})) };
	}
	let record: StoredSecretsRecord;
	try {
		record = await reads.readSecrets(entry.label);
	} catch (error) {
		// Classification only: log lines feed the public issue-report buffer.
		reads.logger.log("Reading a blob to project a sync fingerprint failed; retrying on next activation", {
			error: errorLabel(error),
		});
		return { kind: "failed" };
	}
	const owned = resolveOwnedSecrets(entry, record);
	if (owned.refused.length > 0) {
		return { kind: "none" };
	}
	const args = buildGroupArgs(entry, owned.values);
	if (reads.stored[entry.label] === legacyGroupArgsFingerprint(args)) {
		return { kind: "print", print: groupArgsFingerprint(args) };
	}
	return { kind: "none" };
}

/**
 * How a persist of the projected prints ended: how many landed, deferred on an unconfirmed salt, or failed
 * (logged).
 */
type ProjectionPersist =
	| { readonly kind: "applied"; readonly count: number }
	| { readonly kind: "deferred" | "failed" };

/**
 * Persists the projected prints. Re-gated on the salt at write time like the engine's own persists: a store mutation
 * since the pass-start check must not persist unrecognizable records over the durable ones. Merged over a FRESH read,
 * never the pass-start snapshot, and a rewrite applies only where the fresh value STILL equals the record this pass
 * judged: another window may have added labels (a whole-key write of the stale snapshot would destroy them, #220's
 * failure class) or re-synced a candidate label itself (its newer record must win over this pass's now-stale
 * projection). Nothing is written when no rewrite still applies.
 */
async function persistProjection(
	globalState: FingerprintMemento,
	stored: Readonly<Record<string, string>>,
	rewrites: Readonly<Record<string, string>>,
	confirmSaltDurable: () => Promise<boolean>,
	logger: Logger
): Promise<ProjectionPersist> {
	try {
		if (!(await confirmSaltDurable())) {
			return { kind: "deferred" };
		}
		const fresh = validatedStringRecord(globalState.get(SERVER_SYNC_FINGERPRINTS_KEY));
		const next = { ...fresh };
		let applied = 0;
		for (const [label, print] of Object.entries(rewrites)) {
			if (fresh[label] === stored[label]) {
				next[label] = print;
				applied += 1;
			}
		}
		if (applied > 0) {
			await globalState.update(SERVER_SYNC_FINGERPRINTS_KEY, next);
		}
		return { kind: "applied", count: applied };
	} catch (error) {
		logger.log("Persisting projected sync fingerprints failed; retrying on next activation", {
			error: errorLabel(error),
		});
		return { kind: "failed" };
	}
}

/** Every candidate's projected print by label, and how many blob reads failed on the way. */
async function projectCandidates(
	candidates: readonly DeclaredServer[],
	reads: ProjectionReads
): Promise<{ rewrites: Record<string, string>; failures: number }> {
	let failures = 0;
	const rewrites: Record<string, string> = {};
	for (const entry of candidates) {
		const projection = await projectedPrint(entry, reads);
		if (projection.kind === "failed") {
			failures += 1;
			continue;
		}
		if (projection.kind === "print") {
			rewrites[entry.label] = projection.print;
		}
	}
	return { rewrites, failures };
}

export async function projectSyncFingerprintsFor(
	readServersSetting: () => unknown,
	readSecrets: (label: string) => Promise<StoredSecretsRecord>,
	globalState: FingerprintMemento,
	confirmSaltDurable: () => Promise<boolean>,
	logger: Logger
): Promise<MigrationOutcome> {
	const stored = validatedStringRecord(globalState.get(SERVER_SYNC_FINGERPRINTS_KEY));
	const ledger = canonicalEntryBaseUrls(globalState.get(SYNCED_ENTRY_BASE_URLS_KEY));
	const { entries } = parseServersSetting(readServersSetting());
	const candidates = entries.filter((entry) => {
		const record = stored[entry.label];
		return record !== undefined && !record.startsWith("i1:");
	});
	if (candidates.length === 0) {
		return "nothing-to-do";
	}
	// Deferred, not failed: prints computed under an unconfirmed salt would match nothing, and the write gate below
	// must never run under one either.
	if (!(await confirmSaltDurable())) {
		return "in-progress";
	}
	const { rewrites, failures } = await projectCandidates(candidates, { stored, ledger, readSecrets, logger });
	if (Object.keys(rewrites).length > 0) {
		const persisted = await persistProjection(globalState, stored, rewrites, confirmSaltDurable, logger);
		if (persisted.kind !== "applied") {
			return "in-progress";
		}
		if (persisted.count === 0) {
			return failures > 0 ? "in-progress" : "nothing-to-do";
		}
	}
	if (failures > 0) {
		return "in-progress";
	}
	return Object.keys(rewrites).length > 0 ? "migrated" : "nothing-to-do";
}

/** Runs before the sync engine's first pass, so a healthy entry reads as in-sync instead of being re-added. */
export const fingerprintProjectionMigration: ExtensionMigration<"full-args-sync-fingerprints"> = {
	state: "full-args-sync-fingerprints",
	description: "Projected server-sync fingerprints onto the group-identity rendering",
	sourceRelease: "0.6.0",
	run(ctx: MigrationContext): Promise<MigrationOutcome> {
		return projectSyncFingerprintsFor(
			readRawServersSetting,
			(label) => readServerSecretsRecord(ctx.secrets, label),
			ctx.globalState,
			async () => (await ctx.fingerprintSalt.confirmDurable()) === "durable",
			ctx.logger
		);
	},
};
