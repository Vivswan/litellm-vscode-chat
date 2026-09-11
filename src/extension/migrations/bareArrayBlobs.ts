import type * as vscode from "vscode";
import { ORPHANED_GROUP_PROVENANCE_KEY, REMOVED_GROUP_TOMBSTONES_KEY } from "../../shared/config/storageKeys";

/**
 * This view retires the pre-versioning bare-array blobs of the two group-removal regions.
 * An activation-time rewrite would be the one write that does not bump above what it read.
 * It could clobber a concurrent window's promoted blob, since Memento has no compare-and-swap.
 * The region's first genuine persist promotes the format durably instead.
 * GroupRemovalStore adopts stored snapshots only when strictly newer.
 * So the wrap must precede its constructor, which rules out a MIGRATIONS entry.
 * wireStorage constructs the store over this view.
 * MIGRATION_EXPIRIES registers it under "bare-array-blobs".
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
