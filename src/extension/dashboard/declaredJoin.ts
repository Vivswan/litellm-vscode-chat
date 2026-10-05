/**
 * Who owns each live provider group: the declared entry it belongs to, the declared label it is a leftover of, or
 * nobody (external). One function, read by the dashboard state builder, the hidden-groups line, the sync failure
 * overlay, and the adopt and hide intents' live resolution, so every surface draws and acts on the same verdict;
 * kept vscode-free so pure consumers stay testable without a host.
 */

import type { GroupServer } from "../../provider/catalog/groupModels";
import type { ServerModelsSnapshot } from "../../provider/catalog/statusWindow";
import { SECRET_FIELD_IDS } from "../../shared/serverEntry";
import { normalizeBaseUrl } from "../../shared/util/baseUrl";
import type { DeclaredGroupIdentity } from "../servers/serverSync";
import type { StoredSecretsRecord } from "../servers/serverSync/secrets";

/**
 * Snapshots joined with the display label their server renders under. Labels
 * are not unique (two provider groups can point at one host with different
 * credentials), so colliding labels get a positional suffix; the opaque server
 * IDs stay out of the state because they embed a credential fingerprint.
 */
export interface LabeledSnapshot {
	readonly snapshot: ServerModelsSnapshot;
	readonly label: string;
}

export function labeledSnapshots(snapshots: readonly ServerModelsSnapshot[]): LabeledSnapshot[] {
	// The serverId tiebreak keeps the sort total: the status window re-inserts
	// refreshed entries at the end, so without it two groups on one host would
	// swap ordinals whenever their insertion order churned.
	const sorted = [...snapshots].sort(
		(a, b) =>
			a.status.label.localeCompare(b.status.label) ||
			a.status.baseUrl.localeCompare(b.status.baseUrl) ||
			a.status.serverId.localeCompare(b.status.serverId)
	);
	const labelCounts = new Map<string, number>();
	for (const { status } of sorted) {
		labelCounts.set(status.label, (labelCounts.get(status.label) ?? 0) + 1);
	}
	const seen = new Map<string, number>();
	return sorted.map((snapshot) => {
		const { label } = snapshot.status;
		if ((labelCounts.get(label) ?? 0) < 2) {
			return { snapshot, label };
		}
		const ordinal = (seen.get(label) ?? 0) + 1;
		seen.set(label, ordinal);
		return { snapshot, label: `${label} (${ordinal})` };
	});
}

/**
 * Which pairing pass joined a declared entry to its snapshot. Only the
 * identity pass proves the serving group carries the entry's label, which is
 * what buildServers flags entries on: any other pass means the entry's own
 * modelParameters may not apply.
 */
type JoinPass = "identity" | "connection" | "label-url";

export interface GroupOwnershipInputs {
	readonly labeled: readonly LabeledSnapshot[];
	/** The accepted entries, with the join keys their configuration produces. */
	readonly declared: readonly DeclaredGroupIdentity[];
	/** The labels the setting carries outside an accepted entry (rejectedCarrierLabels); join-only readers omit it. */
	readonly carriers?: readonly string[];
	/** The declared label whose stored secret value a group carries, by server ID (storedSecretHolders). */
	readonly secretHolders?: ReadonlyMap<string, readonly string[]>;
}

/** A live group a declared label left behind: not external, never a credential source. */
export interface LegacySnapshot {
	readonly labeled: LabeledSnapshot;
	/** The declared label the group belongs to. */
	readonly entryLabel: string;
}

export interface GroupOwnership {
	/** The labeled snapshot each declared entry matched, with the pass that matched it, by declared index. */
	readonly matchedByDeclared: ReadonlyMap<number, { readonly entry: LabeledSnapshot; readonly pass: JoinPass }>;
	/** Labeled snapshots no declared label owns: the external rows. */
	readonly external: readonly LabeledSnapshot[];
	readonly legacy: readonly LegacySnapshot[];
}

/**
 * A group belongs to a declared entry by its client ID (credential-fingerprinted, so same-URL entries join exactly),
 * else by the label-agnostic connection ID shared non-exclusively (pre-label groups report under one identity every
 * entry mirroring that connection describes), else by label and URL; never by URL alone, so a user's own group
 * beside a declared one is nobody's. What no entry claims is external unless the setting still names it:
 *
 *   configuration stamped with a declared label    -> legacy of that label; a moved or rotated entry's leftover
 *   carrying a declared label's stored secret value -> legacy of that label; a pre-stamp group of a moved entry
 *
 * The group ownership is not the provider's suppression (wiring/provider.ts isGroupSuppressed): a legacy group
 * keeps serving its models until the user deletes it, unless it is tombstoned or the stamped leftover of an entry
 * that now declares another URL, which both hide.
 */
export function resolveGroupOwnership(inputs: GroupOwnershipInputs): GroupOwnership {
	const { labeled, declared, carriers = [], secretHolders = new Map<string, readonly string[]>() } = inputs;
	const unmatched = new Set<LabeledSnapshot>(labeled);
	const matchedByDeclared = new Map<number, { entry: LabeledSnapshot; pass: JoinPass }>();
	const passes: readonly {
		pass: JoinPass;
		match: (snapshot: ServerModelsSnapshot, view: DeclaredGroupIdentity) => boolean;
		/** A shared pass lets several entries claim one snapshot; only equal join keys can collide (see the doc above). */
		shared?: boolean;
	}[] = [
		{
			pass: "identity",
			match: (snapshot, view) =>
				view.expectedClientId !== undefined && snapshot.status.serverId === view.expectedClientId,
		},
		{
			pass: "connection",
			match: (snapshot, view) =>
				view.expectedConnectionId !== undefined && snapshot.status.serverId === view.expectedConnectionId,
			shared: true,
		},
		{
			pass: "label-url",
			match: (snapshot, view) =>
				snapshot.status.label === view.label &&
				normalizeBaseUrl(snapshot.status.baseUrl) === normalizeBaseUrl(view.baseUrl),
		},
	];
	for (const pass of passes) {
		const claimed = new Set<LabeledSnapshot>();
		declared.forEach((view, declaredIndex) => {
			if (matchedByDeclared.has(declaredIndex)) {
				return;
			}
			const pool = pass.shared === true ? [...unmatched, ...claimed] : [...unmatched];
			const found = pool.find((entry) => pass.match(entry.snapshot, view));
			if (found !== undefined) {
				matchedByDeclared.set(declaredIndex, { entry: found, pass: pass.pass });
				claimed.add(found);
				unmatched.delete(found);
			}
		});
	}
	const declaredLabels = new Set([...declared.map((identity) => identity.label), ...carriers]);
	// A holder label from an earlier pass that the setting no longer carries names nothing: the group is the user's.
	const legacyLabelOf = (snapshot: ServerModelsSnapshot): string | undefined => {
		const stamp = snapshot.entryLabel;
		if (stamp !== undefined && declaredLabels.has(stamp)) {
			return stamp;
		}
		return secretHolders.get(snapshot.status.serverId)?.find((label) => declaredLabels.has(label));
	};
	const external: LabeledSnapshot[] = [];
	const legacy: LegacySnapshot[] = [];
	for (const labeledSnapshot of unmatched) {
		const entryLabel = legacyLabelOf(labeledSnapshot.snapshot);
		if (entryLabel === undefined) {
			external.push(labeledSnapshot);
		} else {
			legacy.push({ labeled: labeledSnapshot, entryLabel });
		}
	}
	return { matchedByDeclared, external, legacy };
}

/**
 * The declared labels whose stored secret value a live group carries, by server ID: the evidence that a group nothing
 * else names is a declared entry's leftover. The value alone decides, whatever destination its ownership stamp names
 * and whichever credential field holds it on either side, because copying it out would hand a declared secret to a
 * new entry; values compare extension-side only and never leave.
 */
export function storedSecretHolders(
	snapshots: readonly ServerModelsSnapshot[],
	getGroupServer: (serverId: string) => GroupServer | undefined,
	storedSecrets: ReadonlyMap<string, StoredSecretsRecord>
): ReadonlyMap<string, readonly string[]> {
	const holders = new Map<string, readonly string[]>();
	const carries = (server: GroupServer, record: StoredSecretsRecord): boolean => {
		const live = new Set(
			[server.apiKey, server.oauth?.clientSecret, server.virtualKey?.value].filter((value) => value !== undefined)
		);
		return SECRET_FIELD_IDS.some((field) => {
			const stored = record.values[field];
			return stored !== undefined && stored.length > 0 && live.has(stored);
		});
	};
	for (const { status } of snapshots) {
		const server = getGroupServer(status.serverId);
		if (server === undefined) {
			continue;
		}
		const labels = [...storedSecrets].flatMap(([label, record]) => (carries(server, record) ? [label] : []));
		if (labels.length > 0) {
			holders.set(status.serverId, labels);
		}
	}
	return holders;
}
