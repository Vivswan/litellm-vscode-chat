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
import type { FingerprintSaltSession } from "../fingerprintSalt";

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

/**
 * Whether a recorded tombstone outlives this session. A group-keyed record is minted from a salt-keyed client ID
 * (shared/util/fingerprint.ts); under a session-only salt no later session could match it, so it is kept in memory
 * only and the notice says the hide ends with the session. Label-keyed records are salt-independent.
 */
export type TombstonePersistence = "durable" | "session-only";

/** What one addTombstone call did: whether it inserted the record (an identical one may already stand) and its reach. */
export interface TombstoneRecording {
	readonly persistence: TombstonePersistence;
	readonly added: boolean;
}

export interface DeclaredGroupClaim {
	readonly label: string;
	readonly baseUrl: string;
	readonly group: GroupKey | undefined;
}

export interface GroupKey {
	readonly groupId: string;
	/** The status label: the configuration stamp, else the URL host (groupDiscovery.ts). */
	readonly label: string;
	readonly entryLabel: string | undefined;
	readonly baseUrl: string;
}

export function sameGroupIdentity(a: GroupIdentity, b: GroupIdentity): boolean {
	return a.label === b.label && normalizeBaseUrl(a.baseUrl) === normalizeBaseUrl(b.baseUrl);
}

function sameTombstoneIdentity(a: TombstoneIdentity, b: TombstoneIdentity): boolean {
	switch (a.by) {
		case "group":
			return b.by === "group" && a.groupId === b.groupId;
		case "entry":
		case "status":
			return a.by === b.by && sameGroupIdentity(a, b);
	}
}

function groupIdentities(group: GroupKey): TombstoneIdentity[] {
	return [
		{ by: "group", groupId: group.groupId, label: group.label, baseUrl: group.baseUrl },
		...(group.entryLabel === undefined
			? []
			: [{ by: "entry" as const, label: group.entryLabel, baseUrl: group.baseUrl }]),
		{ by: "status", label: group.label, baseUrl: group.baseUrl },
	];
}

export function tombstoneHides(record: TombstoneIdentity, group: GroupKey): boolean {
	return groupIdentities(group).some((identity) => sameTombstoneIdentity(record, identity));
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

/** One parser per kind, so a kind added to TombstoneIdentity without a parser fails the build, not the read. */
const TOMBSTONE_PARSERS: {
	[K in TombstoneIdentity["by"]]: (
		value: Record<string, unknown>,
		identity: GroupIdentity
	) => Extract<TombstoneIdentity, { by: K }> | undefined;
} = {
	group: (value, identity) =>
		typeof value.groupId === "string" ? { by: "group", groupId: value.groupId, ...identity } : undefined,
	entry: (_value, identity) => ({ by: "entry", ...identity }),
	status: (_value, identity) => ({ by: "status", ...identity }),
};

function parseTombstone(value: unknown): TombstoneIdentity | undefined {
	const identity = parseIdentity(value);
	if (identity === undefined || !isRecord(value)) {
		return undefined;
	}
	// A record from before the keyed kinds has no `by`: the status label and URL it carried.
	const by = value.by === undefined ? "status" : value.by;
	return typeof by === "string" && Object.hasOwn(TOMBSTONE_PARSERS, by)
		? TOMBSTONE_PARSERS[by as TombstoneIdentity["by"]](value, identity)
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
	/** Records that live in memory only: listed and matched like the rest, never written, kept across adoption. */
	private transient = new Set<T>();
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
			this.records = [...this.parseRecords(stored.records), ...this.transient];
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
		this.transient = new Set(records.filter((record) => this.transient.has(record)));
		this.commitGeneration += 1;
	}

	/** Append a record this session alone can match: no persist generation, because nothing of it is written. */
	commitTransient(record: T): void {
		this.records = [...this.records, record];
		this.transient.add(record);
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
		const blob = {
			version: next.toString(),
			records: this.records.filter((record) => !this.transient.has(record)),
		};
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

	constructor(
		memento: RemovalMemento,
		private readonly salt: Pick<FingerprintSaltSession, "confirmDurable">
	) {
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
		return this.tombstoneRegion.list().some((record) => sameGroupIdentity(record, { label, baseUrl }));
	}

	/**
	 * Record one tombstone; it hides from the commit on. The result says whether this call inserted it (a caller
	 * compensating its own hide must not take back an earlier request's record) and whether a later session will still
	 * hold it: confirmed at the write, like the sync engine's fingerprints, because the salt can downgrade mid-session.
	 */
	async addTombstone(identity: TombstoneIdentity): Promise<TombstoneRecording> {
		const normalized: TombstoneIdentity = { ...identity, baseUrl: normalizeBaseUrl(identity.baseUrl) };
		const persistence: TombstonePersistence =
			normalized.by === "group" && (await this.salt.confirmDurable()) !== "durable" ? "session-only" : "durable";
		const current = this.tombstoneRegion.list();
		const changed = !current.some((existing) => sameTombstoneIdentity(existing, normalized));
		if (!changed) {
			// The re-persist heals an earlier failed write; a session-only record has nothing of its own to write.
			if (persistence === "durable") {
				await this.tombstoneRegion.persistCommitted();
			}
			return { persistence, added: false };
		}
		if (persistence === "session-only") {
			this.tombstoneRegion.commitTransient(normalized);
			this.didChangeListener?.();
			return { persistence, added: true };
		}
		this.tombstoneRegion.commit([...current, normalized]);
		try {
			this.didChangeListener?.();
		} finally {
			// A throwing listener must not skip the persist: the committed state is the effective one and has to reach
			// storage.
			await this.tombstoneRegion.persistCommitted();
		}
		return { persistence, added: true };
	}

	/** Clear every tombstone shown under the identity (the line's row), whatever key each hides by. */
	async removeTombstone(identity: GroupIdentity): Promise<boolean> {
		const current = this.tombstoneRegion.list();
		const next = current.filter((existing) => !sameGroupIdentity(existing, identity));
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

	/** Take back exactly one record (the one a compensated hide added); the identity's other tombstones stand. */
	async retractTombstone(identity: TombstoneIdentity): Promise<boolean> {
		const normalized: TombstoneIdentity = { ...identity, baseUrl: normalizeBaseUrl(identity.baseUrl) };
		const current = this.tombstoneRegion.list();
		const next = current.filter((existing) => !sameTombstoneIdentity(existing, normalized));
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
	 * and must never stay suppressed. The sync engine's pass calls this with every current declared entry and the live
	 * group the ownership joins it to; a record clears when it equals one of that group's identities or the entry's
	 * own stamp identity, the equality the suppression reads.
	 */
	async clearTombstonesFor(claims: readonly DeclaredGroupClaim[]): Promise<boolean> {
		const wanted = claims.flatMap((claim): TombstoneIdentity[] => [
			...(claim.group === undefined ? [] : groupIdentities(claim.group)),
			{ by: "entry", label: claim.label, baseUrl: claim.baseUrl },
		]);
		const current = this.tombstoneRegion.list();
		const next = current.filter((existing) => !wanted.some((identity) => sameTombstoneIdentity(existing, identity)));
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
		return this.provenanceRegion.list().find((record) => sameGroupIdentity(record, { label, baseUrl }))?.origin;
	}

	/** One record per identity: a newer event replaces an older one, since keeping both would make the badge lie. */
	async recordOrigin(record: OrphanedGroupRecord): Promise<void> {
		const normalized: OrphanedGroupRecord = {
			label: record.label,
			baseUrl: normalizeBaseUrl(record.baseUrl),
			origin: record.origin,
		};
		const rest = this.provenanceRegion.list().filter((existing) => !sameGroupIdentity(existing, normalized));
		this.provenanceRegion.commit([...rest, normalized]);
		await this.provenanceRegion.persistCommitted();
	}
}
