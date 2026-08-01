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
 * The store over the two Memento regions. Writes go through update() and are
 * awaited by callers; `onDidChange` fires after any tombstone change (never
 * for provenance alone) so the wiring can make the host re-resolve groups -
 * that is what makes a hidden group's models leave the picker, and an
 * unhidden group's models return.
 */
export class GroupRemovalStore {
	/** Fired after every tombstone mutation; assigned by the activation wiring. */
	onDidChange: (() => void) | undefined;

	constructor(private readonly memento: RemovalMemento) {}

	tombstones(): readonly GroupIdentity[] {
		return parseIdentityList(this.memento.get(REMOVED_GROUP_TOMBSTONES_KEY));
	}

	/** Whether the user explicitly removed this group; the provider-side suppression predicate. */
	isTombstoned(label: string, baseUrl: string): boolean {
		return this.tombstones().some((identity) => sameIdentity(identity, label, baseUrl));
	}

	/** Record one explicit removal. Idempotent; the identity is stored normalized. */
	async addTombstone(identity: GroupIdentity): Promise<void> {
		const current = this.tombstones();
		if (current.some((existing) => sameIdentity(existing, identity.label, identity.baseUrl))) {
			return;
		}
		await this.memento.update(REMOVED_GROUP_TOMBSTONES_KEY, [
			...current,
			{ label: identity.label, baseUrl: normalizeBaseUrl(identity.baseUrl) },
		]);
		this.onDidChange?.();
	}

	/** The explicit un-hide. Resolves true when a tombstone matched and was removed. */
	async removeTombstone(identity: GroupIdentity): Promise<boolean> {
		const current = this.tombstones();
		const kept = current.filter((existing) => !sameIdentity(existing, identity.label, identity.baseUrl));
		if (kept.length === current.length) {
			return false;
		}
		await this.memento.update(REMOVED_GROUP_TOMBSTONES_KEY, kept);
		this.onDidChange?.();
		return true;
	}

	/**
	 * The automatic clear: a declared entry matching a tombstoned identity
	 * (re)appeared, so the group is wanted again and must never stay
	 * suppressed. Called by the sync engine's pass with every current declared
	 * identity.
	 */
	async clearTombstonesFor(declared: readonly GroupIdentity[]): Promise<boolean> {
		const current = this.tombstones();
		const kept = current.filter(
			(existing) => !declared.some((identity) => sameIdentity(existing, identity.label, identity.baseUrl))
		);
		if (kept.length === current.length) {
			return false;
		}
		await this.memento.update(REMOVED_GROUP_TOMBSTONES_KEY, kept);
		this.onDidChange?.();
		return true;
	}

	provenance(): readonly OrphanedGroupRecord[] {
		return parseProvenanceList(this.memento.get(ORPHANED_GROUP_PROVENANCE_KEY));
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
		const kept = this.provenance().filter((existing) => !sameIdentity(existing, record.label, record.baseUrl));
		await this.memento.update(ORPHANED_GROUP_PROVENANCE_KEY, [
			...kept,
			{ label: record.label, baseUrl: normalizeBaseUrl(record.baseUrl), origin: record.origin },
		]);
	}
}
