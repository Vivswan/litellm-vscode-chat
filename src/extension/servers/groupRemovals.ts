/**
 * The removed-group bookkeeping VS Code cannot do for us: the host's provider
 * group command is add-only, so removing a declared entry (or an external row
 * in the dashboard) leaves the group alive host-side. This module owns the
 * two Memento regions that make removal visibly work anyway:
 *
 * - Tombstones: identities of groups the user EXPLICITLY removed. The
 *   provider answers a tombstoned group with an empty model list (injected as
 *   a predicate at activation; the provider layer cannot import this module),
 *   and the dashboard folds the row into its "hidden groups" line. Never
 *   written for a group the user did not remove; cleared when a declared entry
 *   matching the identity (re)appears or the user unhides the group.
 * - Provenance: identity -> origin classification for groups a removal or
 *   rename orphaned, so external rows can say where they came from.
 *   Classifications and labels only, never free text.
 *
 * Group identity here is the sync engine's own: the group's label (the status
 * label the provider reports) plus the normalized base URL. Host-side group
 * names are unique per vendor, so the one accepted collision is two UNLABELED
 * groups on one host (both report the URL-host status label), where removing
 * one hides both - visibly, in the hidden-groups line, and reversibly through
 * Unhide. Everything persisted is validated on read: the keys are
 * extension-owned, but storage can hand back stale or corrupt shapes and those
 * must not ride behind a cast.
 */

import { ORPHANED_GROUP_PROVENANCE_KEY, REMOVED_GROUP_TOMBSTONES_KEY } from "../../shared/config/storageKeys";
import { normalizeBaseUrl } from "../../shared/util/baseUrl";
import { isRecord } from "../../shared/util/json";

/** One group identity as the removal bookkeeping stores it; baseUrl is kept normalized. */
export interface GroupIdentity {
	readonly label: string;
	readonly baseUrl: string;
}

/**
 * Why an external group exists, when a removal or rename explains it. The same
 * shape crosses into DashboardState (protocol.ts re-declares it as
 * ExternalServerProvenance): classification plus labels, no free text.
 */
export type OrphanedGroupOrigin =
	| { readonly kind: "removed-entry-leftover"; readonly removedLabel: string }
	| { readonly kind: "rename-leftover"; readonly oldLabel: string; readonly newLabel: string };

/** One persisted provenance record: the orphaned group's identity and its origin. */
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

function parseIdentityList(raw: unknown): GroupIdentity[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw.map(parseIdentity).filter((identity): identity is GroupIdentity => identity !== undefined);
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

/** One persisted blob: the region's records plus the adoption counter (a decimal string on the wire). */
interface VersionedRecords {
	readonly version: bigint;
	readonly records: unknown[];
}

/**
 * Versions persist as decimal strings of any length and compare as BigInt, so
 * every accepted version's successor is itself accepted - no overflow boundary
 * a hand-edited high value could park the protocol at. Nonnegative safe
 * integers are also accepted; anything else re-enters versioning at 0, keeping
 * the records.
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
 * Blobs written before versioning were bare record arrays; those read as this
 * shape through the wrapping view the store is constructed over
 * (migrations/bareArrayBlobs.ts).
 * Anything else corrupt re-enters the protocol at version 0 with no records.
 */
function parseVersionedRecords(raw: unknown): VersionedRecords {
	if (isRecord(raw) && Array.isArray(raw.records)) {
		return { version: parseVersion(raw.version), records: raw.records };
	}
	return { version: 0n, records: [] };
}

/**
 * One Memento region under the same versioned-blob protocol as
 * ServerRegistry: the in-memory list is authoritative for this window, every
 * persist bumps the version, and stored snapshots are adopted only when
 * strictly newer. That closes the observed globalState hazard (#220: an
 * awaited update reverted moments later by a stale value - the nightly monkey
 * fuzzer caught removed groups' models never leaving the host list that way),
 * because the revert carries an older-or-equal version and is ignored, while
 * another window's genuine mutation - its dashboard Unhide included - synced
 * before mutating, so its blob is strictly newer and is adopted. Simultaneous
 * mutations from two windows remain last-write-wins.
 *
 * Persistence is best-effort: a failure is reported, never thrown (a thrown
 * persist would make callers report the opposite of the effective state), and
 * the version does not advance. While memory holds records a persist failed
 * to write, adoption is suspended (a foreign snapshot would silently drop
 * them); the next successful persist writes the whole view above every stored
 * version and resumes the shared protocol. A failed persist with no later
 * mutation costs the NEXT session the records, never this one.
 */
class VersionedRegion<T> {
	private records: readonly T[];
	private version: bigint;
	private persisting = false;
	private lastWrittenBlob: unknown;
	/**
	 * Commit/persist generations, compared to decide whether memory is ahead of
	 * storage: a write persists the records as of the generation it read, and
	 * serialized writes read the latest records, so an earlier success can cover
	 * a later failure's content.
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
		// No adoption while our own write is in flight or failed (memory is ahead
		// of storage), and never from the blob we wrote ourselves: Memento caches
		// updates optimistically, so a failed persist can leave our rejected
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
		// Two-handler then: a rejection (a throwing onPersistError listener) must
		// not strand every later write.
		const write = () => this.writeCommitted();
		const run = this.persistQueue.then(write, write);
		this.persistQueue = run;
		return run;
	}

	private async writeCommitted(): Promise<void> {
		// The max guards the suspended-adoption case: storage may hold a newer
		// foreign version this window skipped, and the healing write must outrank
		// it (last-write-wins).
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

/**
 * The store over the two Memento regions, each a VersionedRegion (see above for
 * the cross-window protocol). `onDidChange` fires after any effective tombstone
 * change (never for provenance alone) so the wiring can make the host re-resolve
 * groups - that is what makes a hidden group's models leave the picker, and an
 * unhidden group's models return.
 */
export class GroupRemovalStore {
	private didChangeListener: (() => void) | undefined;
	private persistErrorListener: ((error: unknown) => void) | undefined;

	/**
	 * Fired after every effective tombstone mutation, synchronously between
	 * commit and persist. A single set-once slot rather than a listener set: the
	 * store has no logger, so it could not isolate multiple listeners' failures
	 * the way the activation wiring (the one consumer) already does. The setter
	 * throws on a second assignment because a silent replacement would detach the
	 * host re-resolve wiring - hidden groups' models would never leave the picker.
	 */
	set onDidChange(listener: () => void) {
		if (this.didChangeListener !== undefined) {
			throw new Error("GroupRemovalStore.onDidChange is already assigned");
		}
		this.didChangeListener = listener;
	}

	/**
	 * Reports a failed best-effort persist (log-only). Set-once like onDidChange:
	 * a silent replacement would swallow the only signal that storage is behind
	 * memory.
	 */
	set onPersistError(listener: (error: unknown) => void) {
		if (this.persistErrorListener !== undefined) {
			throw new Error("GroupRemovalStore.onPersistError is already assigned");
		}
		this.persistErrorListener = listener;
	}

	private readonly tombstoneRegion: VersionedRegion<GroupIdentity>;
	private readonly provenanceRegion: VersionedRegion<OrphanedGroupRecord>;

	constructor(memento: RemovalMemento) {
		const report = (error: unknown) => this.persistErrorListener?.(error);
		this.tombstoneRegion = new VersionedRegion(memento, REMOVED_GROUP_TOMBSTONES_KEY, parseIdentityList, report);
		this.provenanceRegion = new VersionedRegion(memento, ORPHANED_GROUP_PROVENANCE_KEY, parseProvenanceList, report);
	}

	tombstones(): readonly GroupIdentity[] {
		return [...this.tombstoneRegion.list()];
	}

	/** Whether the user explicitly removed this group; the provider-side suppression predicate. */
	isTombstoned(label: string, baseUrl: string): boolean {
		return this.tombstoneRegion.list().some((identity) => sameIdentity(identity, label, baseUrl));
	}

	/** Record one explicit removal. Idempotent; the identity is stored normalized. */
	async addTombstone(identity: GroupIdentity): Promise<void> {
		const normalized: GroupIdentity = { label: identity.label, baseUrl: normalizeBaseUrl(identity.baseUrl) };
		const current = this.tombstoneRegion.list();
		const changed = !current.some((existing) => sameIdentity(existing, normalized.label, normalized.baseUrl));
		if (!changed) {
			await this.tombstoneRegion.persistCommitted();
			return;
		}
		this.tombstoneRegion.commit([...current, normalized]);
		try {
			this.didChangeListener?.();
		} finally {
			// A throwing listener must not skip the persist: the committed state
			// is the effective one and has to reach storage.
			await this.tombstoneRegion.persistCommitted();
		}
	}

	/** The explicit un-hide. Resolves true when a tombstone matched and was removed. */
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
	 * The automatic clear: a declared entry matching a tombstoned identity
	 * (re)appeared, so the group is wanted again and must never stay suppressed.
	 * The sync engine's pass calls this with every current declared identity.
	 */
	async clearTombstonesFor(declared: readonly GroupIdentity[]): Promise<boolean> {
		const current = this.tombstoneRegion.list();
		const next = current.filter(
			(existing) => !declared.some((identity) => sameIdentity(existing, identity.label, identity.baseUrl))
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

	/** The origin recorded for one group identity, if a removal or rename explains it. */
	originFor(label: string, baseUrl: string): OrphanedGroupOrigin | undefined {
		return this.provenanceRegion.list().find((record) => sameIdentity(record, label, baseUrl))?.origin;
	}

	/**
	 * Record why a group became orphaned. One record per identity: a newer event
	 * replaces an older one, since keeping both would make the badge lie.
	 */
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
