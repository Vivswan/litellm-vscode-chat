/**
 * Import planning in two pure steps: planSettingsImport reduces a parsed
 * envelope plus the current servers setting to an ImportPlan (what would be
 * written, what collides, what gets skipped and why), and resolveImportPlan
 * folds the user's collision decisions into an ImportApplication (the exact
 * writes the host flow applies). Nothing here writes; the split keeps every
 * prompt between the two steps fakeable.
 *
 * Pure and vscode-free, like the rest of src/extension/settingsTransfer/.
 */

import type { StoredServerSecrets } from "../servers/serverSync/secrets";
import type { ServerEntryReport } from "../servers/serverSync/setting";

/** One non-servers key the plan writes to the user scope. */
export interface SettingWrite {
	readonly key: string;
	readonly value: unknown;
}

/** One non-servers key the plan refuses, and why. */
export interface SkippedKey {
	readonly key: string;
	/**
	 * The light scalar type gate: a spec'd number/boolean key or the
	 * enum-string usage.statusBar whose incoming value has the wrong type.
	 * The other structured keys pass through to their readers' existing
	 * leniency instead and never land here.
	 */
	readonly reason: "wrong-type";
}

/** One entry of the file's servers array, with its acceptance verdict for the preview. */
export interface IncomingServer {
	/** The raw entry exactly as the file carries it (secrets still inline when exported with them). */
	readonly raw: unknown;
	/** The entry's verdict, from the same serverSettingReports pass the dashboard diagnostics run. */
	readonly report: ServerEntryReport;
	/**
	 * True when the entry cannot import at all: no usable label, or a reserved
	 * one (no SecretStorage key is possible for either). Skipped entries count
	 * into the summary and never reach the collision or apply steps.
	 */
	readonly skipped: boolean;
}

/** One label collision between the file and the current setting's raw labels. */
export interface ServerCollision {
	readonly label: string;
	/**
	 * True when the incoming entry changes connection-level fields (baseUrl or
	 * auth shape) against the current entry, so an overwrite follows the sync
	 * engine's group-update-unavailable path; the preview says so upfront.
	 */
	readonly connectionChanged: boolean;
}

/** Everything the import preview states and the collision prompts iterate; resolveImportPlan consumes it whole. */
export interface ImportPlan {
	/** Non-servers keys to write, in ALL_SETTING_KEYS order; the servers key travels through incomingServers instead. */
	readonly settingsWrites: readonly SettingWrite[];
	readonly skippedKeys: readonly SkippedKey[];
	/** The file's servers array, one verdict per entry; empty when the file carries no servers key. */
	readonly incomingServers: readonly IncomingServer[];
	/** Importable incoming labels already present in the current setting (vs rawDeclaredLabels), in file order. */
	readonly collisions: readonly ServerCollision[];
	/** Inline secret values across the importable entries: the to-secure-storage count the preview states. */
	readonly secretFieldCount: number;
	/** The current servers setting's raw user-scope value, carried verbatim for resolveImportPlan's merge. */
	readonly currentServersRaw: unknown;
}

/** Reduce the parsed envelope's settings plus the current raw servers value to an ImportPlan. */
export function planSettingsImport(
	_envelopeSettings: Readonly<Record<string, unknown>>,
	_currentServersRaw: unknown
): ImportPlan {
	throw new Error("unimplemented");
}

/** The user's answer to one collision prompt. */
export type CollisionDecision =
	| { readonly action: "overwrite" }
	| { readonly action: "skip" }
	| { readonly action: "rename"; readonly newLabel: string };

/**
 * Decisions keyed by colliding label. Every ImportPlan collision label must
 * carry one: the flow aborts the whole import on any dismissed prompt, so a
 * partial decision set never reaches resolveImportPlan.
 */
export type CollisionDecisions = Readonly<Record<string, CollisionDecision>>;

/** One label's SecretStorage writes, stripped out of its incoming entry. */
export interface SecretWrite {
	readonly label: string;
	/** The fields to store; blob fields the label already holds but this record omits are cleared as stale. */
	readonly secrets: StoredServerSecrets;
}

/** The exact writes the host flow applies (settings first, the servers array last). */
export interface ImportApplication {
	/** The plan's settingsWrites, passed through for the apply loop. */
	readonly settingsWrites: readonly SettingWrite[];
	/**
	 * The full servers array to write LAST, or undefined when the import
	 * touches no servers. Overwrites replace their entry IN PLACE (same array
	 * position, same label, so the sync engine's removal detector sees an
	 * edit, never a removal); new and renamed entries append; existing
	 * non-colliding entries are never mutated or reordered. Secrets are
	 * stripped out of every written entry into secretWrites.
	 */
	readonly serversValue: readonly unknown[] | undefined;
	/** Per-label SecretStorage writes, applied entry by entry before the servers write. */
	readonly secretWrites: readonly SecretWrite[];
	/** Every label the import writes (overwritten, renamed-to, appended); the pre-import snapshot records their previous blobs. */
	readonly touchedLabels: readonly string[];
	/** The summary notification's counts. */
	readonly counts: {
		/** New entries appended under their own label. */
		readonly imported: number;
		readonly overwritten: number;
		readonly renamed: number;
		/** Skip decisions plus the plan's unimportable entries. */
		readonly skipped: number;
	};
}

/** Fold the collision decisions into the plan; see ImportApplication for the merge invariants. */
export function resolveImportPlan(_plan: ImportPlan, _decisions: CollisionDecisions): ImportApplication {
	throw new Error("unimplemented");
}

/**
 * The prefill for the rename input box: a variant of `label` that collides
 * with nothing in `takenLabels` (current, reserved, and this-import labels;
 * the caller assembles the set).
 */
export function suggestRenamedLabel(_label: string, _takenLabels: ReadonlySet<string>): string {
	throw new Error("unimplemented");
}
