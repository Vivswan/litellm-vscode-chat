/**
 * The pure data boundary of the settings-redesign migration: an old-world
 * configuration snapshot in, an ordered write plan out. Nothing in the
 * transform touches vscode - the applier (apply.ts) reads the snapshot
 * through the configuration API and executes the plan, while the unit and
 * property suites drive the transform directly with plain objects.
 */

import type { MigrationOutcome } from "../index";

/** The per-scope values inspect() reports for one setting id. */
export interface SettingLayers {
	readonly globalValue?: unknown;
	readonly workspaceValue?: unknown;
	readonly workspaceFolderValue?: unknown;
}

/**
 * Everything the transform reads: setting id (under the config section) to
 * its configured layers. An absent id is an untouched setting.
 */
export type SettingsSnapshot = Readonly<Record<string, SettingLayers>>;

/**
 * One ordered plan step: set `section` to `value` at the User (Global) scope,
 * or delete it there when `value` is undefined. The plan never names any
 * other scope - workspace-layer legacy values are counted in the log lines
 * and left in place.
 */
export interface SettingWrite {
	readonly section: string;
	readonly value: unknown;
}

export interface RedesignPlan {
	/**
	 * Ordered: every value write precedes every deletion, so a crash between
	 * the two loses nothing - the rerun finds both the old and the new value
	 * and the sync-race rule (keep the new, drop the old) completes the move.
	 */
	readonly writes: readonly SettingWrite[];
	/** English, counts only: the log lines feed the public issue-report buffer. */
	readonly logLines: readonly string[];
	readonly outcome: MigrationOutcome;
	/**
	 * The global headers value the plan's deletion consumes, when it really
	 * carried headers: the applier parks it once in globalState (the old
	 * setting also reached servers without a declared entry, which the new
	 * world cannot express), so the dashboard can hint and the adopt flow can
	 * restore it. Absent when nothing is deleted or the value carried nothing.
	 */
	readonly parkedHeaders?: Readonly<Record<string, unknown>>;
}
