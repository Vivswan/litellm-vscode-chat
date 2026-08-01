/**
 * The removed-group bookkeeping VS Code cannot do for us: the host's provider
 * group command is add-only, so removing a declared entry (or an external row
 * in the dashboard) leaves the group alive host-side. This module owns the
 * two Memento regions that make removal visibly work anyway:
 *
 * - Tombstones: identities of groups the user EXPLICITLY removed. The
 *   provider answers a tombstoned group with an empty model list (injected as
 *   a predicate at activation; the provider layer cannot import this module),
 *   and the dashboard folds the row into its "hidden groups" line. A
 *   tombstone is never written for a group the user did not remove, and it
 *   clears when a declared entry matching the identity (re)appears or the
 *   user unhides the group.
 * - Provenance: identity -> origin classification for groups a removal or
 *   rename orphaned, so external rows can say where they came from.
 *   Classifications and labels only, never free text.
 *
 * Group identity here is the sync engine's own: the group's label (the
 * status label the provider reports, which is the entry label for synced
 * groups) plus the normalized base URL. Host-side group names are unique per
 * vendor, so labeled groups cannot collide; the one accepted collision is
 * two UNLABELED groups on one host (both report the URL-host status label),
 * where removing one hides both - visibly, in the hidden-groups line, and
 * reversibly through Unhide. Credential-fingerprinted IDs would distinguish
 * them but churn on key rotation and salt loss, which would strand
 * tombstones. Everything persisted is validated on read: the keys are
 * extension-owned, but storage can hand back stale or corrupt shapes and
 * those must not ride behind a cast.
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
 * Why an external group exists, when a removal or rename explains it. The
 * same shape crosses into DashboardState (protocol.ts re-declares it as
 * ExternalServerProvenance): classification plus the labels involved, no
 * free text.
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

/**
 * The store over the two Memento regions. Reads and mutations answer from the
 * session journal (see below) with persistence best-effort underneath;
 * `onDidChange` fires after any effective tombstone change (never for
 * provenance alone) so the wiring can make the host re-resolve groups - that
 * is what makes a hidden group's models leave the picker, and an unhidden
 * group's models return.
 */
export class GroupRemovalStore {
	/** Fired after every tombstone mutation; assigned by the activation wiring. */
	onDidChange: (() => void) | undefined;
	/** Reports a failed best-effort persist (log-only); assigned by the activation wiring. */
	onPersistError: ((error: unknown) => void) | undefined;

	/**
	 * The session's own mutations, journaled over the stored lists, guarding
	 * against the same observed hazard as the sync engine's fingerprint
	 * session map: an awaited globalState update can be reverted moments later
	 * by a stale value from the storage layer. The nightly monkey fuzzer
	 * caught removals losing their suppression exactly that way (#220): a
	 * stale re-read inside a read-modify-write dropped an earlier tombstone,
	 * and the provider's isTombstoned read missed a just-written one, so a
	 * removed group's models never left the host list. Every read applies the
	 * journal over a fresh store read - this session's adds and removes always
	 * win (so a reverted store can neither un-hide a removed group nor
	 * resurrect a cleared tombstone), while another window's records still
	 * ride through underneath. Every persist writes the journaled view, so a
	 * failed or reverted write self-heals on the next mutation (and, like
	 * every log-only persist in this codebase, a failure with no later
	 * mutation costs the NEXT session the record - never this one). Known
	 * residual, same as every whole-key Memento write in this codebase: two
	 * windows mutating concurrently can overwrite each other's latest write,
	 * and a sticky journal op keeps this window's answer until its next
	 * persist - per-window session state stays correct, and each window
	 * re-persists its own ops.
	 */
	private tombstoneOps = new Map<string, { op: "add" | "remove"; identity: GroupIdentity }>();
	private provenanceOps = new Map<string, OrphanedGroupRecord>();

	constructor(private readonly memento: RemovalMemento) {}

	private static opKey(label: string, baseUrl: string): string {
		return `${label}\n${normalizeBaseUrl(baseUrl)}`;
	}

	/**
	 * Best-effort persistence: the journal is the session truth and every
	 * persist rewrites the whole journaled view, so a failure costs nothing a
	 * later mutation cannot restore - it is reported, never thrown, keeping
	 * callers' user-facing outcomes aligned with the effective (journal)
	 * state.
	 */
	private async persist(key: string, value: unknown): Promise<void> {
		try {
			await this.memento.update(key, value);
		} catch (error) {
			this.onPersistError?.(error);
		}
	}

	tombstones(): readonly GroupIdentity[] {
		const stored = parseIdentityList(this.memento.get(REMOVED_GROUP_TOMBSTONES_KEY));
		const list = stored.filter(
			(identity) => this.tombstoneOps.get(GroupRemovalStore.opKey(identity.label, identity.baseUrl))?.op !== "remove"
		);
		for (const { op, identity } of this.tombstoneOps.values()) {
			if (op === "add" && !list.some((existing) => sameIdentity(existing, identity.label, identity.baseUrl))) {
				list.push(identity);
			}
		}
		return list;
	}

	/** Whether the user explicitly removed this group; the provider-side suppression predicate. */
	isTombstoned(label: string, baseUrl: string): boolean {
		return this.tombstones().some((identity) => sameIdentity(identity, label, baseUrl));
	}

	/** Record one explicit removal. Idempotent; the identity is journaled and stored normalized. */
	async addTombstone(identity: GroupIdentity): Promise<void> {
		const changed = !this.isTombstoned(identity.label, identity.baseUrl);
		this.tombstoneOps.set(GroupRemovalStore.opKey(identity.label, identity.baseUrl), {
			op: "add",
			identity: { label: identity.label, baseUrl: normalizeBaseUrl(identity.baseUrl) },
		});
		if (changed) {
			this.onDidChange?.();
		}
		await this.persist(REMOVED_GROUP_TOMBSTONES_KEY, this.tombstones());
	}

	/** The explicit un-hide. Resolves true when a tombstone matched and was removed. */
	async removeTombstone(identity: GroupIdentity): Promise<boolean> {
		if (!this.isTombstoned(identity.label, identity.baseUrl)) {
			return false;
		}
		this.tombstoneOps.set(GroupRemovalStore.opKey(identity.label, identity.baseUrl), {
			op: "remove",
			identity: { label: identity.label, baseUrl: normalizeBaseUrl(identity.baseUrl) },
		});
		this.onDidChange?.();
		await this.persist(REMOVED_GROUP_TOMBSTONES_KEY, this.tombstones());
		return true;
	}

	/**
	 * The automatic clear: a declared entry matching a tombstoned identity
	 * (re)appeared, so the group is wanted again and must never stay
	 * suppressed. Called by the sync engine's pass with every current declared
	 * identity.
	 */
	async clearTombstonesFor(declared: readonly GroupIdentity[]): Promise<boolean> {
		const matched = this.tombstones().filter((existing) =>
			declared.some((identity) => sameIdentity(existing, identity.label, identity.baseUrl))
		);
		if (matched.length === 0) {
			return false;
		}
		for (const identity of matched) {
			this.tombstoneOps.set(GroupRemovalStore.opKey(identity.label, identity.baseUrl), { op: "remove", identity });
		}
		this.onDidChange?.();
		await this.persist(REMOVED_GROUP_TOMBSTONES_KEY, this.tombstones());
		return true;
	}

	provenance(): readonly OrphanedGroupRecord[] {
		const stored = parseProvenanceList(this.memento.get(ORPHANED_GROUP_PROVENANCE_KEY));
		const list = stored.filter(
			(record) => !this.provenanceOps.has(GroupRemovalStore.opKey(record.label, record.baseUrl))
		);
		return [...list, ...this.provenanceOps.values()];
	}

	/** The origin recorded for one group identity, if a removal or rename explains it. */
	originFor(label: string, baseUrl: string): OrphanedGroupOrigin | undefined {
		return this.provenance().find((record) => sameIdentity(record, label, baseUrl))?.origin;
	}

	/**
	 * Record why a group became orphaned. One record per identity: a newer
	 * event replaces an older one (a rename after a re-add tells the current
	 * truth; keeping both would make the badge lie).
	 */
	async recordOrigin(record: OrphanedGroupRecord): Promise<void> {
		this.provenanceOps.set(GroupRemovalStore.opKey(record.label, record.baseUrl), {
			label: record.label,
			baseUrl: normalizeBaseUrl(record.baseUrl),
			origin: record.origin,
		});
		await this.persist(ORPHANED_GROUP_PROVENANCE_KEY, this.provenance());
	}
}
