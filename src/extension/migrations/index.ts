import type * as vscode from "vscode";
import type { Logger } from "../../shared/logger";
import type { FingerprintSaltSession } from "../fingerprintSalt";
import { legacyRegistryCleanupMigration } from "./legacyRegistryCleanup";
import { settingsRedesignMigration } from "./settingsRedesign/apply";
import { stampSecretOwnersMigration } from "./stampSecretOwners";

export interface MigrationContext {
	globalState: vscode.Memento;
	secrets: vscode.SecretStorage;
	logger: Logger;
	/**
	 * The session's fingerprint-salt view. A migration that persists
	 * fingerprints must call confirmDurable() at decision time and defer unless
	 * it reports "durable": records written under a salt later sessions will
	 * not see would match nothing.
	 */
	fingerprintSalt: FingerprintSaltSession;
}

/**
 * "migrated": legacy state was found and moved forward (the runner logs the
 * description). "nothing-to-do": the legacy state is absent, the common case,
 * so it stays silent. "in-progress": some state moved but more remains for a
 * later activation; the migration logs its own progress lines.
 */
export type MigrationOutcome = "migrated" | "nothing-to-do" | "in-progress";

/**
 * One legacy-state migration. There is no update hook and no reliable
 * last-run-version, so selection is state detection: every migration's run
 * executes on every activation and must detect its own legacy state, which
 * also makes reruns across many activations the normal mode of operation.
 * Every run is awaited before registerLanguageModelChatProvider, so a
 * migration must not hit the host command surface or the network.
 */
export interface ExtensionMigration {
	/** Stable slug for the legacy state this migrates away from; logs, tests, and MIGRATION_EXPIRIES key on it. */
	state: string;
	/** One line logged when the migration does work. */
	description: string;
	/** The last release whose state this migrates away from; MIGRATIONS stays ordered by it. */
	readonly sourceRelease: string;
	/** IDEMPOTENT: detects the legacy state and no-ops when it is absent. */
	run(ctx: MigrationContext): Promise<MigrationOutcome>;
}

/**
 * Chronological by sourceRelease, ties keeping registration order (a test pins
 * this). Registration order is execution order.
 */
export const MIGRATIONS: readonly ExtensionMigration[] = [
	legacyRegistryCleanupMigration,
	settingsRedesignMigration,
	stampSecretOwnersMigration,
];

/**
 * The dead-man switch that keeps migrations from accumulating: every member of
 * MIGRATIONS (plus any out-of-runner migration module, today the bareArrayBlobs
 * read-time view) declares the date its legacy state stops being worth
 * carrying - its introduction date plus three months - and a fail-closed test
 * turns the build red once today is past it. The dates are deliberate expiry
 * decisions, free to push out - what is not free is silence.
 */
export interface MigrationExpiry {
	/** The migration's `state` slug, or the registered slug of an out-of-runner module. */
	readonly state: string;
	/** The module to delete when the entry expires, relative to src/extension/migrations/. */
	readonly file: string;
	/** ISO date (yyyy-mm-dd) the module landed on main (`git log --follow --diff-filter=A`). */
	readonly introduced: string;
	/** Introduction date + 3 months; the build fails once today is later. */
	readonly expires: string;
}

export const MIGRATION_EXPIRIES: readonly MigrationExpiry[] = [
	{ state: "settings-redesign", file: "settingsRedesign/apply.ts", introduced: "2026-08-08", expires: "2026-11-08" },
	{ state: "unstamped-server-secrets", file: "stampSecretOwners.ts", introduced: "2026-08-19", expires: "2026-11-19" },
	{ state: "bare-array-blobs", file: "bareArrayBlobs.ts", introduced: "2026-08-23", expires: "2026-11-23" },
	{ state: "legacy-registry-state", file: "legacyRegistryCleanup.ts", introduced: "2026-08-24", expires: "2026-11-24" },
];

/** Best-effort: a failing migration logs once and the rest still run; never rejects. */
export async function runMigrations(
	ctx: MigrationContext,
	migrations: readonly ExtensionMigration[] = MIGRATIONS
): Promise<void> {
	for (const migration of migrations) {
		try {
			if ((await migration.run(ctx)) === "migrated") {
				ctx.logger.log(`${migration.description} (away from v${migration.sourceRelease} state)`);
			}
		} catch (error) {
			ctx.logger.error(`Migration "${migration.state}" failed`, error);
		}
	}
}
