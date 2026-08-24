import type * as vscode from "vscode";
import {
	ORPHANED_GROUP_PROVENANCE_KEY,
	REMOVED_GROUP_TOMBSTONES_KEY,
	SERVER_REGISTRY_KEY,
} from "../../shared/config/storageKeys";

/**
 * Migrates away from: the pre-versioning bare-array blobs of the three
 * versioned Memento regions (the server registry and the two group-removal
 * regions). Blobs written before those protocols gained versions were bare
 * record arrays; each region's versioned shape is its own - the registry
 * persists { version: number, servers }, the removal regions { version:
 * decimal string, records } (see serverRegistry.ts / groupRemovals.ts) - and
 * the readers' bare-array acceptance branches were deleted in favor of this
 * one read-boundary normalization.
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
 * ServerRegistry and GroupRemovalStore constructors first parse these keys
 * (both adopt stored snapshots only when STRICTLY newer, so a wrap appearing
 * after construction would never be read), and MigrationContext itself
 * carries the constructed registry. wireStorage constructs the stores over
 * this view. State-detecting and idempotent like every migration here: a
 * versioned blob passes through by identity.
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

/** Each region's versioned wrap of a bare record array, at the protocol's floor (version 0). */
const BARE_ARRAY_WRAPS: ReadonlyMap<string, (records: readonly unknown[]) => unknown> = new Map<
	string,
	(records: readonly unknown[]) => unknown
>([
	[SERVER_REGISTRY_KEY, (records) => ({ version: 0, servers: records })],
	[REMOVED_GROUP_TOMBSTONES_KEY, (records) => ({ version: "0", records })],
	[ORPHANED_GROUP_PROVENANCE_KEY, (records) => ({ version: "0", records })],
]);

function wrapIfBareArray(key: string, value: unknown): unknown {
	const wrap = BARE_ARRAY_WRAPS.get(key);
	return wrap !== undefined && Array.isArray(value) ? wrap(value) : value;
}
