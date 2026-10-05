/**
 * The removed-group bookkeeping VS Code cannot do for us: the host's provider group command is add-only, so removing a
 * declared entry (or an external row in the dashboard) leaves the group alive host-side. Everything persisted is
 * validated on read: the keys are extension-owned, but storage can hand back stale or corrupt shapes and those must
 * not ride behind a cast.
 *
 *   Tombstones -> identities of groups the user EXPLICITLY removed (TombstoneIdentity)
 *   Provenance: identity -> origin classification for groups a removal or rename orphaned
 *
 *   a tombstoned group                           -> an empty model list
 *   the provider layer cannot import this module -> injected as a predicate at activation
 */

import { ORPHANED_GROUP_PROVENANCE_KEY, REMOVED_GROUP_TOMBSTONES_KEY } from "../../shared/config/storageKeys";
import { normalizeBaseUrl } from "../../shared/util/baseUrl";
import { isRecord } from "../../shared/util/json";
import type { DeclaredGroupIdentity } from "./serverSync/engine";

/** One group identity as the provenance bookkeeping stores it; baseUrl is kept normalized. */
export interface GroupIdentity {
	readonly label: string;
	readonly baseUrl: string;
}

/**
 * What a tombstone hides a group by: the identity the group ownership (dashboard/declaredJoin.ts) names the group
 * with, never a looser key. `label` and `baseUrl` are what the hidden-groups line shows and what Unhide echoes.
 *
 *   group  -> a live group the user hid: its client ID
 *   entry  -> a removed entry's leftover: the entry label the group's configuration is stamped with, at the URL
 *   status -> a record persisted before the keyed kinds: the status label and URL it carried; nothing writes it anew
 */
export type TombstoneIdentity =
	| { readonly by: "group"; readonly groupId: string; readonly label: string; readonly baseUrl: string }
	| { readonly by: "entry"; readonly label: string; readonly baseUrl: string }
	| { readonly by: "status"; readonly label: string; readonly baseUrl: string };

export interface GroupKey {
	readonly groupId: string;
	/** The status label: the configuration stamp, else the URL host (groupDiscovery.ts). */
	readonly label: string;
	readonly entryLabel: string | undefined;
	readonly baseUrl: string;
}

export function tombstoneHides(record: TombstoneIdentity, group: GroupKey): boolean {
	switch (record.by) {
		case "group":
			return record.groupId === group.groupId;
		case "entry":
			return (
				group.entryLabel !== undefined &&
				record.label === group.entryLabel &&
				record.baseUrl === normalizeBaseUrl(group.baseUrl)
			);
		case "status":
			return record.label === group.label && record.baseUrl === normalizeBaseUrl(group.baseUrl);
	}
}

/**
 * Why an external group exists, when a removal or rename explains it.
 *
 *   The same shape -> crosses into DashboardState
 */
export type OrphanedGroupOrigin =
	| { readonly kind: "removed-entry-leftover"; readonly removedLabel: string }
	| { readonly kind: "rename-leftover"; readonly oldLabel: string; readonly newLabel: string };

export interface OrphanedGroupRecord extends GroupIdentity {
	readonly origin: OrphanedGroupOrigin;
}

/** The Memento slice the store uses; vscode.Memento satisfies it. */
export interface RemovalMemento {
	get(key: string): unknown;
	update(key: string, value: unknown): Thenable<void>;
}

function parseIdentity(value: unknown): GroupIdentity | undefined {
	if (!isRecord(value) || typeof value.label !== "string" || typeof value.baseUrl !== "string") {
		return undefined;
	}
	return { label: value.label, baseUrl: normalizeBaseUrl(value.baseUrl) };
}

function parseOrigin(value: unknown): OrphanedGroupOrigin | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	if (value.kind === "removed-entry-leftover" && typeof value.removedLabel === "string") {
		return { kind: "removed-entry-leftover", removedLabel: value.removedLabel };
	}
	if (value.kind === "rename-leftover" && typeof value.oldLabel === "string" && typeof value.newLabel === "string") {
		return { kind: "rename-leftover", oldLabel: value.oldLabel, newLabel: value.newLabel };
	}
	return undefined;
}

function parseTombstone(value: unknown): TombstoneIdentity | undefined {
	const identity = parseIdentity(value);
	if (identity === undefined) {
		return undefined;
	}
	if (!isRecord(value) || value.by === undefined) {
		return { by: "status", ...identity };
	}
	if (value.by === "entry" || value.by === "status") {
		return { by: value.by, ...identity };
	}
	return value.by === "group" && typeof value.groupId === "string"
		? { by: "group", groupId: value.groupId, ...identity }
		: undefined;
}

function parseTombstoneList(raw: unknown): TombstoneIdentity[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw.map(parseTombstone).filter((record): record is TombstoneIdentity => record !== undefined);
}

function parseProvenanceList(raw: unknown): OrphanedGroupRecord[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const records: OrphanedGroupRecord[] = [];
	for (const item of raw) {
		const identity = parseIdentity(item);
		const origin = isRecord(item) ? parseOrigin(item.origin) : undefined;
		if (identity !== undefined && origin !== undefined) {
			records.push({ ...identity, origin });
		}
	}
	return records;
}

function sameIdentity(a: GroupIdentity, label: string, baseUrl: string): boolean {
	return a.label === label && a.baseUrl === normalizeBaseUrl(baseUrl);
}

function sameTombstone(a: TombstoneIdentity, b: TombstoneIdentity): boolean {
	return a.by === "group" || b.by === "group"
		? a.by === "group" && b.by === "group" && a.groupId === b.groupId
		: sameIdentity(a, b.label, b.baseUrl);
}

/** One persisted blob: the region's records plus the adoption counter (a decimal string on the wire). */
interface VersionedRecords {
	readonly version: bigint;
	readonly records: unknown[];
}

/**
 * Versions persist as decimal strings of any length and compare as BigInt, so every accepted version's successor is
 * itself accepted - no overflow boundary a hand-edited high value could park the protocol at. Nonnegative safe integers
 * are also accepted; anything else re-enters versioning at 0, keeping the records.
 */
function parseVersion(raw: unknown): bigint {
	if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) {
		return BigInt(raw);
	}
	if (typeof raw === "string" && /^\d+$/.test(raw)) {
		return BigInt(raw);
	}
	return 0n;
}

/**
 * Blobs written before versioning were bare record arrays; those read as this shape through the wrapping view the store
 * is constructed over (migrations/bareArrayBlobs.ts). Anything else corrupt re-enters the protocol at version 0 with no
 * records.
 */
function parseVersionedRecords(raw: unknown): VersionedRecords {
	if (isRecord(raw) && Array.isArray(raw.records)) {
		return { version: parseVersion(raw.version), records: raw.records };
	}
	return { version: 0n, records: [] };
}

/**
 * Closes the #220 globalState hazard, an awaited update reverting moments later to a stale value. A persist failure is
 * reported, never thrown, since a throwing persist would make callers report the opposite of the effective state; with
 * no later successful persist the loss lands on the NEXT session, never this one.
 *
 *   stale revert of our own write     -> older-or-equal version, ignored
 *   another window's genuine mutation -> it synced before mutating
 *   it synced before mutating         -> strictly newer and adopted
 *   two windows mutating at once      -> last-write-wins
 */
class VersionedRegion<T> {
	private records: readonly T[];
	private version: bigint;
	private persisting = false;
	private lastWrittenBlob: unknown;
	/**
	 * Commit/persist generations, compared to decide whether memory is ahead of storage: a write persists the records
	 * as of the generation it read, and serialized writes read the latest records, so an earlier success can cover a
	 * later failure's content.
	 */
	private commitGeneration = 0;
	private persistedGeneration = 0;

	constructor(
		private readonly memento: RemovalMemento,
		private readonly key: string,
		private readonly parseRecords: (records: unknown[]) => T[],
		private readonly reportPersistError: (error: unknown) => void
	) {
		const stored = parseVersionedRecords(memento.get(key));
		this.records = parseRecords(stored.records);
		this.version = stored.version;
	}

	private unpersisted(): boolean {
		return this.persistedGeneration < this.commitGeneration;
	}

	private syncFromStorage(): void {
		// No adoption while our own write is in flight or failed (memory is ahead of storage), and never from the blob
		// we wrote ourselves: Memento caches updates optimistically, so a failed persist can leave our rejected
		// snapshot in the cache.
		if (this.persisting || this.unpersisted()) {
			return;
		}
		const raw = this.memento.get(this.key);
		if (raw === this.lastWrittenBlob) {
			return;
		}
		const stored = parseVersionedRecords(raw);
		if (stored.version > this.version) {
			this.records = this.parseRecords(stored.records);
			this.version = stored.version;
		}
	}

	list(): readonly T[] {
		this.syncFromStorage();
		return this.records;
	}

	/** Replace the in-memory list synchronously; callers observe the new state before any event or persist. */
	commit(records: readonly T[]): void {
		this.records = records;
		this.commitGeneration += 1;
	}

	/** Persists run serialized: an out-of-order write would mark a newer failure's records as persisted. */
	private persistQueue: Promise<void> = Promise.resolve();

	persistCommitted(): Promise<void> {
		// Two-handler then: a rejection (a throwing onPersistError listener) must not strand every later write.
		const write = () => this.writeCommitted();
		const run = this.persistQueue.then(write, write);
		this.persistQueue = run;
		return run;
	}

	private async writeCommitted(): Promise<void> {
		// The max guards the suspended-adoption case: storage may hold a newer foreign version this window skipped, and
		// the healing write must outrank it (last-write-wins).
		const generation = this.commitGeneration;
		const stored = parseVersionedRecords(this.memento.get(this.key));
		const next = (stored.version > this.version ? stored.version : this.version) + 1n;
		const blob = { version: next.toString(), records: [...this.records] };
		this.lastWrittenBlob = blob;
		this.persisting = true;
		try {
			await this.memento.update(this.key, blob);
			this.version = next;
			this.persistedGeneration = Math.max(this.persistedGeneration, generation);
		} catch (error) {
			this.reportPersistError(error);
		} finally {
			this.persisting = false;
		}
	}
}

export class GroupRemovalStore {
	private didChangeListener: (() => void) | undefined;
	private persistErrorListener: ((error: unknown) => void) | undefined;

	/**
	 * A single set-once slot rather than a listener set: the store has no logger, so it could not isolate multiple
	 * listeners' failures the way the activation wiring (the one consumer) already does. The setter throws on a second
	 * assignment because a silent replacement would detach the host re-resolve wiring - hidden groups' models would
	 * never leave the picker.
	 *
	 *   Fired after every effective tombstone mutation -> synchronously between commit and persist
	 */
	set onDidChange(listener: () => void) {
		if (this.didChangeListener !== undefined) {
			throw new Error("GroupRemovalStore.onDidChange is already assigned");
		}
		this.didChangeListener = listener;
	}

	/**
	 * Reports a failed best-effort persist (log-only). Set-once like onDidChange: a silent replacement would swallow
	 * the only signal that storage is behind memory.
	 */
	set onPersistError(listener: (error: unknown) => void) {
		if (this.persistErrorListener !== undefined) {
			throw new Error("GroupRemovalStore.onPersistError is already assigned");
		}
		this.persistErrorListener = listener;
	}

	private readonly tombstoneRegion: VersionedRegion<TombstoneIdentity>;
	private readonly provenanceRegion: VersionedRegion<OrphanedGroupRecord>;

	constructor(memento: RemovalMemento) {
		const report = (error: unknown) => this.persistErrorListener?.(error);
		this.tombstoneRegion = new VersionedRegion(memento, REMOVED_GROUP_TOMBSTONES_KEY, parseTombstoneList, report);
		this.provenanceRegion = new VersionedRegion(memento, ORPHANED_GROUP_PROVENANCE_KEY, parseProvenanceList, report);
	}

	tombstones(): readonly TombstoneIdentity[] {
		return [...this.tombstoneRegion.list()];
	}

	/** Whether the user explicitly removed this group; the provider-side suppression predicate. */
	isTombstoned(group: GroupKey): boolean {
		return this.tombstoneRegion.list().some((record) => tombstoneHides(record, group));
	}

	/** Whether a tombstone is shown under this identity: what the hidden-groups line's rows act on. */
	hasTombstone(label: string, baseUrl: string): boolean {
		return this.tombstoneRegion.list().some((record) => sameIdentity(record, label, baseUrl));
	}

	async addTombstone(identity: TombstoneIdentity): Promise<void> {
		const normalized: TombstoneIdentity = { ...identity, baseUrl: normalizeBaseUrl(identity.baseUrl) };
		const current = this.tombstoneRegion.list();
		const changed = !current.some((existing) => sameTombstone(existing, normalized));
		if (!changed) {
			await this.tombstoneRegion.persistCommitted();
			return;
		}
		this.tombstoneRegion.commit([...current, normalized]);
		try {
			this.didChangeListener?.();
		} finally {
			// A throwing listener must not skip the persist: the committed state is the effective one and has to reach
			// storage.
			await this.tombstoneRegion.persistCommitted();
		}
	}

	/** Clear every tombstone shown under the identity (the line's row), whatever key each hides by. */
	async removeTombstone(identity: GroupIdentity): Promise<boolean> {
		const current = this.tombstoneRegion.list();
		const next = current.filter((existing) => !sameIdentity(existing, identity.label, identity.baseUrl));
		if (next.length === current.length) {
			return false;
		}
		this.tombstoneRegion.commit(next);
		try {
			this.didChangeListener?.();
		} finally {
			await this.tombstoneRegion.persistCommitted();
		}
		return true;
	}

	/**
	 * The automatic clear: a declared entry whose group a tombstone hides (re)appeared, so the group is wanted again
	 * and must never stay suppressed; the sync engine's pass calls this with every current declared identity. A group
	 * record a declared entry would reach only by label and URL stays hidden and out of the join (state.ts), so the
	 * dashboard and the provider agree.
	 *
	 *   group record         -> the entry's join key (ServerSyncEngine.joinKeyOf) is the group's
	 *   entry, status record -> the entry's label and URL
	 */
	async clearTombstonesFor(declared: readonly DeclaredGroupIdentity[]): Promise<boolean> {
		const current = this.tombstoneRegion.list();
		const next = current.filter(
			(existing) =>
				!declared.some((identity) =>
					existing.by === "group"
						? existing.groupId === identity.expectedClientId
						: sameIdentity(existing, identity.label, identity.baseUrl)
				)
		);
		if (next.length === current.length) {
			return false;
		}
		this.tombstoneRegion.commit(next);
		try {
			this.didChangeListener?.();
		} finally {
			await this.tombstoneRegion.persistCommitted();
		}
		return true;
	}

	provenance(): readonly OrphanedGroupRecord[] {
		return [...this.provenanceRegion.list()];
	}

	originFor(label: string, baseUrl: string): OrphanedGroupOrigin | undefined {
		return this.provenanceRegion.list().find((record) => sameIdentity(record, label, baseUrl))?.origin;
	}

	/** One record per identity: a newer event replaces an older one, since keeping both would make the badge lie. */
	async recordOrigin(record: OrphanedGroupRecord): Promise<void> {
		const normalized: OrphanedGroupRecord = {
			label: record.label,
			baseUrl: normalizeBaseUrl(record.baseUrl),
			origin: record.origin,
		};
		const rest = this.provenanceRegion
			.list()
			.filter((existing) => !sameIdentity(existing, normalized.label, normalized.baseUrl));
		this.provenanceRegion.commit([...rest, normalized]);
		await this.provenanceRegion.persistCommitted();
	}
}
