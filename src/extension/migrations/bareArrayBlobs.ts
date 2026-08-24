import type * as vscode from "vscode";
import { ORPHANED_GROUP_PROVENANCE_KEY, REMOVED_GROUP_TOMBSTONES_KEY } from "../../shared/config/storageKeys";

/**
 * Migrates away from: the pre-versioning bare-array blobs of the two
 * group-removal Memento regions. Blobs written before those protocols gained
 * versions were bare record arrays; the versioned shape is { version: decimal
 * string, records } (see groupRemovals.ts), and the readers' bare-array
 * acceptance branches were deleted in favor of this one read-boundary
 * normalization.
 *
 * Deliberately a READ-TIME view with no writer of its own: an activation-time
 * rewrite would be the one write in the system that does not bump above what
 * it read, so it could clobber a concurrent window's already-promoted,
 * already-mutated blob (Memento has no compare-and-swap). Instead the region's
 * FIRST GENUINE PERSIST promotes the format durably - every store write goes
 * out versioned and outranks the bare array - and until then the view hands
 * the wrapped shape to reads, losslessly (the raw array rides in unfiltered;
 * the region's own read-time sanitization keeps judging corrupt members).
 *
 * Not in MIGRATIONS: the normalization must be in place before the
 * GroupRemovalStore constructor first parses these keys (it adopts stored
 * snapshots only when STRICTLY newer, so a wrap appearing after construction
 * would never be read). wireStorage constructs the store over this view.
 * State-detecting and idempotent like every migration here: a versioned blob
 * passes through by identity. Registered in MIGRATION_EXPIRIES under
 * "bare-array-blobs".
 */
export function bareArrayWrappingMemento(memento: vscode.Memento): vscode.Memento {
	const get = <T>(key: string, defaultValue?: T): T | undefined => {
		const raw = defaultValue === undefined ? memento.get<unknown>(key) : memento.get<unknown>(key, defaultValue);
		return wrapIfBareArray(key, raw) as T | undefined;
	};
	return {
		keys: () => memento.keys(),
		get: get as vscode.Memento["get"],
		update: (key, value) => memento.update(key, value),
	};
}

/** The regions that wrap; both share the removal protocol's versioned shape at its floor (version 0). */
const BARE_ARRAY_REGIONS: ReadonlySet<string> = new Set([REMOVED_GROUP_TOMBSTONES_KEY, ORPHANED_GROUP_PROVENANCE_KEY]);

function wrapIfBareArray(key: string, value: unknown): unknown {
	return BARE_ARRAY_REGIONS.has(key) && Array.isArray(value) ? { version: "0", records: value } : value;
}
