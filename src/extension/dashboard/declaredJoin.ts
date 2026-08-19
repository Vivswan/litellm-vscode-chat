/**
 * The declared-entry join: pairing the servers setting's entries with the live
 * snapshots the provider's status window saw. Shared by the dashboard state
 * builder, the adopt intent's source resolution, and the status surfaces' sync
 * failure overlay, which must all agree on which snapshot a declared entry
 * describes; kept vscode-free so pure consumers stay testable without a host.
 */

import type { ServerModelsSnapshot } from "../../provider/catalog/statusWindow";
import { normalizeBaseUrl } from "../../shared/util/baseUrl";
import type { DeclaredServerView } from "../servers/serverSync";

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
export type JoinPass = "identity" | "connection" | "label-url" | "url";

/**
 * Pair declared entries with live snapshots, in four passes: the group client
 * ID (credential-fingerprinted, so entries sharing a base URL with different
 * credentials join exactly), then the label-agnostic connection ID
 * non-exclusively (groups created before entry labels flowed into their
 * configurations report under one shared identity, and every entry mirroring
 * that connection is honestly described by it), then label plus base URL, then
 * base URL alone. Shared by the state builder and the adopt intent's source
 * resolution, which must agree on which snapshots are external.
 */
export function joinDeclared(
	labeled: readonly LabeledSnapshot[],
	declared: readonly DeclaredServerView[]
): {
	/** The labeled snapshot each declared entry matched, with the pass that matched it, by declared index. */
	matchedByDeclared: Map<number, { entry: LabeledSnapshot; pass: JoinPass }>;
	/** Labeled snapshots no declared entry claimed: the external rows. */
	unmatched: Set<LabeledSnapshot>;
} {
	const unmatched = new Set<LabeledSnapshot>(labeled);
	const matchedByDeclared = new Map<number, { entry: LabeledSnapshot; pass: JoinPass }>();
	const passes: readonly {
		pass: JoinPass;
		match: (snapshot: ServerModelsSnapshot, view: DeclaredServerView) => boolean;
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
		{
			pass: "url",
			match: (snapshot, view) => normalizeBaseUrl(snapshot.status.baseUrl) === normalizeBaseUrl(view.baseUrl),
		},
	];
	for (const pass of passes) {
		// Snapshots this pass already handed out, still claimable when shared.
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
	return { matchedByDeclared, unmatched };
}
