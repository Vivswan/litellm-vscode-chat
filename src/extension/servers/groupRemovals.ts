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

import { Mutex } from "async-mutex";
import { ORPHANED_GROUP_PROVENANCE_KEY, REMOVED_GROUP_TOMBSTONES_KEY } from "../../shared/config/storageKeys";
import { canonicalBaseUrl, canonicalStoredBaseUrl, normalizeBaseUrl } from "../../shared/util/baseUrl";
import { isRecord } from "../../shared/util/json";
import type { FingerprintSaltSession } from "../fingerprintSalt";

/**
 * One group identity as the provenance bookkeeping stores it; baseUrl is read in its one spelling (a stored record
 * through canonicalStoredBaseUrl, a comparison through canonicalBaseUrl), so a record an older version stored as the
 * user typed it still matches the group the provider now reports canonically. A stored URL with no canonical spelling
 * identifies no group (groupModels.ts parseGroupConfiguration serves none) and is dropped.
 */
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

/** One identity's recording inside an addTombstones batch, under the identity object the caller passed. */
export interface TombstoneRecorded extends TombstoneRecording {
	readonly identity: TombstoneIdentity;
}

export interface DeclaredGroupClaim {
	readonly label: string;
	readonly baseUrl: string;
	readonly group: GroupKey | undefined;
}

/**
 * One live group by its ids. `label` is the status label: the configuration stamp, else the URL host
 * (groupDiscovery.ts).
 */
export interface GroupKey {
	readonly groupId: string;
	readonly label: string;
	readonly entryLabel: string | undefined;
	readonly baseUrl: string;
}

export function sameGroupIdentity(a: GroupIdentity, b: GroupIdentity): boolean {
	const url = canonicalBaseUrl(a.baseUrl);
	return a.label === b.label && url !== undefined && url === canonicalBaseUrl(b.baseUrl);
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
	const baseUrl = canonicalStoredBaseUrl(value.baseUrl);
	return baseUrl === undefined ? undefined : { label: value.label, baseUrl };
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
	// A record from before the keyed kinds has no `by`: the status label and URL it carried. A group record whose
	// stored URL text is not canonical was keyed under a pre-canonical spelling and matches no id the canonical group
	// reports, so it hides by its label and URL too: the user hid that group.
	const by =
		value.by === undefined ||
		(value.by === "group" &&
			typeof value.baseUrl === "string" &&
			canonicalStoredBaseUrl(value.baseUrl) !== value.baseUrl)
			? "status"
			: value.by;
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
 * no later successful persist the loss lands on the NEXT session, never this one. A write persists the records as of
 * the generation it read, and serialized writes read the latest records, so an earlier success can cover a later
 * failure's content.
 *
 *   stale revert of our own write     -> older-or-equal version, ignored
 *   another window's genuine mutation -> it synced before mutating
 *   it synced before mutating         -> strictly newer and adopted
 *   two windows mutating at once      -> last-write-wins
 */
class VersionedRegion<T> {
	/** The region's content; memory is truth and storage trails it. */
	private records: readonly T[];

	/** Records that live in memory only: listed and matched like the rest, never written, kept across adoption. */
	private transient = new Set<T>();

	/** The version of the blob memory holds; a stored read is adopted only when strictly newer. */
	private version: bigint;

	/** True while a write is in flight; nothing is adopted from storage meanwhile. */
	private persisting = false;

	/** The blob we wrote last: Memento caches updates optimistically, so a failed persist can hand it back. */
	private lastWrittenBlob: unknown;

	/** Bumped per commit; ahead of persistedGeneration exactly while memory is ahead of storage. */
	private commitGeneration = 0;

	/** The commit generation the last successful persist covered. */
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

	/**
	 * A view computed from the records and recomputed only when the list was replaced. Every path that changes the
	 * records assigns a new array (the constructor, adoption, commit, commitTransient), never mutates one, so the
	 * array's identity is the view's freshness key.
	 */
	derived<D>(derive: (records: readonly T[]) => D): () => D {
		let cache: { readonly from: readonly T[]; readonly value: D } | undefined;
		return () => {
			const records = this.list();
			if (cache === undefined || cache.from !== records) {
				cache = { from: records, value: derive(records) };
			}
			return cache.value;
		};
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
	private readonly persistMutex = new Mutex();

	persistCommitted(): Promise<void> {
		return this.persistMutex.runExclusive(() => this.writeCommitted());
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

/** A label's canonical URLs; the shape both halves of a GroupIdentity match through (sameGroupIdentity). */
type IdentityIndex = Map<string, Set<string>>;

function indexIdentity(index: IdentityIndex, identity: GroupIdentity): void {
	const url = canonicalBaseUrl(identity.baseUrl);
	if (url === undefined) {
		return;
	}
	let urls = index.get(identity.label);
	if (urls === undefined) {
		urls = new Set();
		index.set(identity.label, urls);
	}
	urls.add(url);
}

function indexedIdentity(index: IdentityIndex, identity: GroupIdentity): boolean {
	const url = canonicalBaseUrl(identity.baseUrl);
	return url !== undefined && (index.get(identity.label)?.has(url) ?? false);
}

/**
 * The tombstone list keyed the way the suppression predicate asks: the host re-resolves every group it has ever been
 * handed on each model-change event, so a lookup that scanned the list cost groups times tombstones per event.
 * Answers exactly what tombstoneHides answers over the same records, by key instead of by scan.
 *
 *   group  record -> its client ID
 *   entry  record -> the group's entry label at the URL
 *   status record -> the group's status label at the URL
 */
class TombstoneIndex {
	private readonly groupIds = new Set<string>();

	private readonly entries: IdentityIndex = new Map();

	private readonly statuses: IdentityIndex = new Map();

	private readonly shown: IdentityIndex = new Map();

	constructor(records: readonly TombstoneIdentity[]) {
		for (const record of records) {
			indexIdentity(this.shown, record);
			switch (record.by) {
				case "group":
					this.groupIds.add(record.groupId);
					break;
				case "entry":
					indexIdentity(this.entries, record);
					break;
				case "status":
					indexIdentity(this.statuses, record);
					break;
			}
		}
	}

	hides(group: GroupKey): boolean {
		return (
			this.groupIds.has(group.groupId) ||
			(group.entryLabel !== undefined &&
				indexedIdentity(this.entries, { label: group.entryLabel, baseUrl: group.baseUrl })) ||
			indexedIdentity(this.statuses, { label: group.label, baseUrl: group.baseUrl })
		);
	}

	/** Whether any record, whatever it hides by, is shown under the identity. */
	shows(identity: GroupIdentity): boolean {
		return indexedIdentity(this.shown, identity);
	}
}

/**
 * The removal truth: the tombstones (what the host must hide) and the orphaned-group provenance (why a leftover
 * exists), each a VersionedRegion. The two listener slots are set-once rather than listener sets: the store has no
 * logger, so it could not isolate multiple listeners' failures the way the activation wiring (the one consumer)
 * already does, and a silent replacement would detach the host re-resolve wiring (hidden groups' models would never
 * leave the picker) or swallow the only signal that storage is behind memory.
 */
export class GroupRemovalStore {
	/** The one onDidChange listener, assigned once. */
	private didChangeListener: (() => void) | undefined;

	/** The one onPersistError listener, assigned once. */
	private persistErrorListener: ((error: unknown) => void) | undefined;

	/** Fired synchronously after every effective tombstone mutation, before the persist; a second assignment throws. */
	set onDidChange(listener: () => void) {
		if (this.didChangeListener !== undefined) {
			throw new Error("GroupRemovalStore.onDidChange is already assigned");
		}
		this.didChangeListener = listener;
	}

	/** Reports a failed best-effort persist (log-only); set-once like onDidChange, a second assignment throws. */
	set onPersistError(listener: (error: unknown) => void) {
		if (this.persistErrorListener !== undefined) {
			throw new Error("GroupRemovalStore.onPersistError is already assigned");
		}
		this.persistErrorListener = listener;
	}

	/** Every tombstoned identity, versioned against other windows' writes. */
	private readonly tombstoneRegion: VersionedRegion<TombstoneIdentity>;

	/** The tombstones indexed for matching, recomputed only when the region's list is replaced. */
	private readonly tombstoneIndex: () => TombstoneIndex;

	/** The origin recorded for each orphaned group, versioned like the tombstones. */
	private readonly provenanceRegion: VersionedRegion<OrphanedGroupRecord>;

	constructor(
		memento: RemovalMemento,
		private readonly salt: Pick<FingerprintSaltSession, "confirmDurable">
	) {
		const report = (error: unknown) => this.persistErrorListener?.(error);
		this.tombstoneRegion = new VersionedRegion(memento, REMOVED_GROUP_TOMBSTONES_KEY, parseTombstoneList, report);
		this.tombstoneIndex = this.tombstoneRegion.derived((records) => new TombstoneIndex(records));
		this.provenanceRegion = new VersionedRegion(memento, ORPHANED_GROUP_PROVENANCE_KEY, parseProvenanceList, report);
	}

	tombstones(): readonly TombstoneIdentity[] {
		return [...this.tombstoneRegion.list()];
	}

	/** Whether the user explicitly removed this group; the provider-side suppression predicate. */
	isTombstoned(group: GroupKey): boolean {
		return this.tombstoneIndex().hides(group);
	}

	/** Whether a tombstone is shown under this identity: what the hidden-groups line's rows act on. */
	hasTombstone(label: string, baseUrl: string): boolean {
		return this.tombstoneIndex().shows({ label, baseUrl });
	}

	/**
	 * Record one tombstone; it hides from the commit on. The result says whether this call inserted it (a caller
	 * compensating its own hide must not take back an earlier request's record) and whether a later session will still
	 * hold it: confirmed at the write, like the sync engine's fingerprints, because the salt can downgrade mid-session.
	 */
	async addTombstone(identity: TombstoneIdentity): Promise<TombstoneRecording> {
		const [recorded] = await this.addTombstones([identity]);
		return { persistence: recorded.persistence, added: recorded.added };
	}

	/**
	 * Record several tombstones as one mutation: one commit, one change event, one persist. A reconcile records two or
	 * three identities per removed entry, and every change event makes the host re-resolve every group it holds, so
	 * recording them one by one multiplied that re-resolve by the batch size. Each recording answers for one identity
	 * as addTombstone would have, in the order given.
	 */
	async addTombstones(
		identities: readonly [TombstoneIdentity, ...TombstoneIdentity[]]
	): Promise<readonly [TombstoneRecorded, ...TombstoneRecorded[]]> {
		const saltDurable = identities.some((identity) => identity.by === "group")
			? (await this.salt.confirmDurable()) === "durable"
			: true;
		const current = this.tombstoneRegion.list();
		const standing = [...current];
		const durableAdded: TombstoneIdentity[] = [];
		const transientAdded: TombstoneIdentity[] = [];
		const record = (identity: TombstoneIdentity): TombstoneRecorded => {
			const normalized: TombstoneIdentity = { ...identity, baseUrl: normalizeBaseUrl(identity.baseUrl) };
			const persistence: TombstonePersistence = normalized.by === "group" && !saltDurable ? "session-only" : "durable";
			if (standing.some((existing) => sameTombstoneIdentity(existing, normalized))) {
				return { identity, persistence, added: false };
			}
			standing.push(normalized);
			(persistence === "durable" ? durableAdded : transientAdded).push(normalized);
			return { identity, persistence, added: true };
		};
		const [first, ...rest] = identities;
		const recordings = [record(first), ...rest.map(record)] as const;
		// An existing durable record re-persists to heal an earlier failed write; a session-only record has nothing of
		// its own to write.
		const persist = recordings.some((recording) => recording.persistence === "durable");
		if (durableAdded.length === 0 && transientAdded.length === 0) {
			if (persist) {
				await this.tombstoneRegion.persistCommitted();
			}
			return recordings;
		}
		if (durableAdded.length > 0) {
			this.tombstoneRegion.commit([...current, ...durableAdded]);
		}
		for (const identity of transientAdded) {
			this.tombstoneRegion.commitTransient(identity);
		}
		try {
			this.didChangeListener?.();
		} finally {
			// A throwing listener must not skip the persist: the committed state is the effective one and has to reach
			// storage.
			if (persist) {
				await this.tombstoneRegion.persistCommitted();
			}
		}
		return recordings;
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
