import type * as vscode from "vscode";
import type { Logger } from "../../shared/logger";
import type { FingerprintSaltSession } from "../fingerprintSalt";
import type { ServerRegistry } from "../servers/serverRegistry";
import { legacySingleServerMigration } from "./legacySingleServer";
import { registryToProviderGroupsMigration } from "./registryToProviderGroups";
import { settingsRedesignMigration } from "./settingsRedesign/apply";

export interface MigrationContext {
	globalState: vscode.Memento;
	secrets: vscode.SecretStorage;
	registry: ServerRegistry;
	logger: Logger;
	/**
	 * The session's fingerprint-salt view (see extension/fingerprintSalt.ts).
	 * A migration that persists fingerprints - seeding provider groups - must
	 * call confirmDurable() at decision time and defer unless it reports
	 * "durable": records written under a salt later sessions will not see
	 * would match nothing, which is exactly the permanent wedge those
	 * migrations exist to prevent.
	 */
	fingerprintSalt: FingerprintSaltSession;
}

/**
 * "migrated": legacy state was found and moved forward (the runner logs the
 * migration's description). "nothing-to-do": the legacy state is absent, the
 * common case on every activation, so it stays silent. "in-progress": some
 * state moved but more remains for a later activation; the migration logs its
 * own progress lines.
 */
export type MigrationOutcome = "migrated" | "nothing-to-do" | "in-progress";

/**
 * One legacy-state migration. There is no update hook and no reliable
 * last-run-version, so selection is state detection: every migration's run
 * executes on every activation and must detect its own legacy state, which
 * also makes reruns across many activations (draining deferred host
 * submissions, retrying secret deletions) the normal mode of operation.
 */
export interface ExtensionMigration {
	/** Stable slug for the legacy state this migrates away from; logs and tests key on it. */
	state: string;
	/** One line logged when the migration does work. */
	description: string;
	/** The last release whose state this migrates away from; MIGRATIONS stays ordered by it. */
	readonly sourceRelease: string;
	/**
	 * "pre-registration" runs are awaited before registerLanguageModelChatProvider;
	 * "post-registration" runs fire-and-forget after it and may hit the host or the network.
	 */
	phase: "pre-registration" | "post-registration";
	/** IDEMPOTENT: detects the legacy state and no-ops when it is absent. */
	run(ctx: MigrationContext): Promise<MigrationOutcome>;
}

/**
 * Chronological by sourceRelease, ties keeping registration order (a test
 * pins this); the per-file headers carry each migration's full story.
 * Registration order is execution order within each phase. The v0.3.1
 * label-scoped modelParameters rewrite is folded into the settings-redesign
 * pipeline (see labelScopedModelParameters.ts), whose label-map union
 * already covers registry servers the group migration has not seeded.
 */
export const MIGRATIONS: readonly ExtensionMigration[] = [
	legacySingleServerMigration,
	registryToProviderGroupsMigration,
	settingsRedesignMigration,
];

/** Best-effort: a failing migration logs once and the rest still run; never rejects. */
export async function runMigrations(
	phase: ExtensionMigration["phase"],
	ctx: MigrationContext,
	migrations: readonly ExtensionMigration[] = MIGRATIONS
): Promise<void> {
	for (const migration of migrations) {
		if (migration.phase !== phase) {
			continue;
		}
		try {
			if ((await migration.run(ctx)) === "migrated") {
				ctx.logger.log(`${migration.description} (away from v${migration.sourceRelease} state)`);
			}
		} catch (error) {
			ctx.logger.error(`Migration "${migration.state}" failed`, error);
		}
	}
}
