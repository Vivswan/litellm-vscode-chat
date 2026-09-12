import type * as vscode from "vscode";
import { ORPHANED_GROUP_PROVENANCE_KEY, REMOVED_GROUP_TOMBSTONES_KEY } from "../../shared/config/storageKeys";

/**
 * A read-time view only; the region's first genuine persist promotes the format for real.
 *
 *   activation-time rewrite -> rejected; it would not bump above what it read, so without compare-and-swap it could clobber another window's blob
 *   MIGRATIONS entry        -> rejected; the wrap must stand before wiring/storage.ts builds GroupRemovalStore, which adopts only newer snapshots
 *   MIGRATION_EXPIRIES      -> still lists "bare-array-blobs"
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
