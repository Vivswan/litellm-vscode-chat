/**
 * The pure data boundary of the settings-redesign migration: an old-world configuration snapshot in, an ordered write
 * plan out. Nothing in the transform touches vscode - the applier (apply.ts) reads the snapshot through the
 * configuration API and executes the plan, while the unit and property suites drive the transform directly with plain
 * objects.
 */

import type { MigrationOutcome } from "../index";

/** The per-scope values inspect() reports for one setting id. */
export interface SettingLayers {
	readonly globalValue?: unknown;
	readonly workspaceValue?: unknown;
	readonly workspaceFolderValue?: unknown;
}

/** Everything the transform reads: setting id (under the config section) to its configured layers. */
export type SettingsSnapshot = Readonly<Record<string, SettingLayers>>;

/**
 * One ordered plan step: set `section` to `value` at the User (Global) scope, or delete it there when `value` is
 * undefined. The plan never names any other scope - workspace-layer legacy values are counted in the log lines and left
 * in place.
 */
export interface SettingWrite {
	readonly section: string;
	readonly value: unknown;
}

/**
 * What applySettingsRedesign writes and logs. `writes` is ordered: every value write precedes every deletion, so a
 * crash between the two loses nothing, since the rerun finds both the old and the new value and the sync-race rule
 * (keep the new, drop the old) completes the move.
 */
export interface RedesignPlan {
	/** The steps, in execution order. */
	readonly writes: readonly SettingWrite[];

	/** English, counts only: the log lines feed the public issue-report buffer. */
	readonly logLines: readonly string[];

	/** What the runner reports: "migrated" when any write is planned, else "nothing-to-do". */
	readonly outcome: MigrationOutcome;
}
