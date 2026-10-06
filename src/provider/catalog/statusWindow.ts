/**
 * The rolling status window: each server's latest discovery outcome and the models it registered, accumulated across
 * the host's per-group refresh calls.
 */

import type { SkippedModeCounts } from "../../shared/serverEntry";
import type { ServerStatus } from "../../shared/servers";
import { displayUrl } from "../../shared/util/displayUrl";
import type { GroupServer, PreAttachModelInfo } from "./groupModels";

/**
 * The identity a credential rotation leaves intact; the serve-generation claim (groupDiscovery.ts) and an entry-owned
 * group's window entry key on it. Undefined for an unlabeled group. A JSON array, so it can never collide with a
 * `group:` client ID. The URL is the credential-free spelling: everything derived from an identity (window keys, the
 * model objects the host receives) must be free of userinfo.
 */
export function logicalGroupId(groupServer: Pick<GroupServer, "label" | "baseUrl">): string | undefined {
	return groupServer.label !== undefined
		? JSON.stringify([groupServer.label, displayUrl(groupServer.baseUrl)])
		: undefined;
}

/**
 * The window's key, and the identity a served model carries (groupModels.ts attachGroup) for the request path to
 * resolve its live connection by.
 *   owned by a declared entry -> label plus URL: the setting is truth, so a rotation keeps the identity
 *   no declared owner         -> the client ID: nothing could make one labeled external twin stand in for another
 */
export function groupIdentity(
	groupServer: Pick<GroupServer, "label" | "baseUrl" | "entryOwned">,
	clientId: string
): string {
	return groupServer.entryOwned === true ? (logicalGroupId(groupServer) ?? clientId) : clientId;
}

/**
 * The configured stale-serve window only GROWS eviction beyond this floor, never shrinks it: eviction anchors to the
 * last report of any kind, and a short window would evict mid-sweep entries the one-cycle grace exists to keep visible.
 */
const EVICTION_TTL_FLOOR_MS = 10 * 60 * 1000;

/**
 * One server's slice of the status window, for read-only consumers (the dashboard). `models` are registration's infos
 * before the serve stamps a group identity - PreAttachModelInfo by type, so a served copy, which may carry the stale
 * decoration, does not compile into a snapshot.
 */
export interface ServerModelsSnapshot {
	readonly status: ServerStatus;
	/** The full set the latest serve handed out: discovered infos plus declared ones (flagged `litellm.declared`). */
	readonly models: readonly PreAttachModelInfo[];
	/**
	 * The model_info keys the last successful listing reported, carried forward across failure reports so a mid-outage
	 * refresh cannot blank the set.
	 */
	readonly observedModelInfoKeys?: readonly string[] | undefined;
	/** The per-mode skip counts of the last successful listing, carried forward like observedModelInfoKeys. */
	readonly skippedModeCounts?: SkippedModeCounts | undefined;
	/** The dashboard's supersession rule keys on this, never on the display label. */
	readonly entryLabel?: string | undefined;
}

type StatusWindowEntry = {
	cycle: number;
	at: number;
	/**
	 * Holds the DISCOVERED set only: declared models are config-rebuilt on every serve, so staling one would resurrect
	 * a removed declaration and collide with the fresh synthesis.
	 */
	lastSuccess: { at: number; models: readonly PreAttachModelInfo[] } | undefined;
	status: ServerStatus;
	models: readonly PreAttachModelInfo[];
	/**
	 * The raw model IDs discovery last returned, carried forward across failure reports like lastSuccess:
	 * staleServableModels hands them out beside the stale bundle, where declared-ID inertness is judged against this
	 * set, never against `models` - registration may emit only synthetic variants (`foo:cheapest`) for a discovered
	 * `foo`.
	 */
	discoveredRawIds: readonly string[];
	observedModelInfoKeys: readonly string[] | undefined;
	skippedModeCounts: SkippedModeCounts | undefined;
	/** The group's resolved connection; every entry is a VS Code provider group. */
	groupServer: GroupServer;
};

/**
 * A named bundle because both members are info arrays: transposing positional parameters would type-check. The window
 * serves snapshots from the union but anchors stale serving to `discovered` alone.
 */
export interface ServedModelSets {
	/** Discovered infos with capability overrides applied; the stale-serve source set. */
	readonly discovered: readonly PreAttachModelInfo[];
	/**
	 * Disjoint from `discovered` by construction (a declared ID discovery listed is inert, a colliding exposed ID is
	 * suppressed) and never staled: the config rebuilds them on every serve, so a removed declaration dies mid-outage
	 * too.
	 */
	readonly declared: readonly PreAttachModelInfo[];
}

/**
 * A named bundle (not positional parameters) because both members are string arrays: transposing them at a call site
 * would type-check.
 */
export interface DiscoveryObservations {
	/** The raw IDs discovery returned; see StatusWindowEntry.discoveredRawIds. */
	readonly discoveredRawIds?: readonly string[] | undefined;
	/** The observed model_info keys, when the listing reported them; see ServerModelsSnapshot.observedModelInfoKeys. */
	readonly observedModelInfoKeys?: readonly string[] | undefined;
	/** The per-mode skip counts, when the listing reported them; see ServerModelsSnapshot.skippedModeCounts. */
	readonly skippedModeCounts?: SkippedModeCounts | undefined;
}

/**
 * Two fallbacks cover hosts that skip the group-agnostic call: beginCycleOnReSight, and eviction of entries
 * untouched for evictionTtlMs().
 *   the group-agnostic call (normally the first of a refresh cycle) -> advances the cycle counter
 */
export class StatusWindow {
	private cycle = 0;
	/**
	 * Whether the current cycle was started by the group-agnostic call. Such a host makes one of those calls per sweep.
	 *   inside a marked cycle a group reporting under an already-seen identity -> restarting the cycle on it would
	 *                                                                            evict entries the sweep has not
	 *                                                                            re-reached
	 */
	private cycleMarked = false;
	private readonly entries = new Map<string, StatusWindowEntry>();

	constructor(
		private readonly now: () => number,
		/**
		 * The discovery.staleServeWindow setting, read at consumption time so a settings change reaches the next
		 * refresh without event plumbing.
		 */
		private readonly staleServeWindowMs: () => number,
		/**
		 * Unlabeled groups fire too: the sync engine joins them to a declared entry by client ID, and that join must run
		 * in the pass this entry schedules.
		 */
		private readonly onGroupEntered: () => void = () => {}
	) {}

	/**
	 * The window must reach eviction because the stale-serve anchor lives on the entry - a host idle longer than the
	 * floor (a suspended laptop) would otherwise lose the anchor a longer configured window promises to serve from.
	 */
	private evictionTtlMs(): number {
		return Math.max(this.staleServeWindowMs(), EVICTION_TTL_FLOOR_MS);
	}

	/** The group-agnostic call's cycle boundary; marks the cycle as host-driven. */
	beginCycle(): void {
		this.advanceCycle();
		this.cycleMarked = true;
	}

	/**
	 * The re-see fallback for hosts that skip the group-agnostic call. Never fires inside a marked cycle; see
	 * cycleMarked.
	 *   a group reporting again within one unmarked cycle -> a fresh cycle begins and true is reported so the caller
	 *                                                        can prune alongside
	 *   a rotated client ID                                -> not a re-sight: advancing on it evicted a live group's
	 *                                                        stale anchor before that group was re-reached
	 */
	beginCycleOnReSight(clientId: string, groupServer: Pick<GroupServer, "label" | "baseUrl" | "entryOwned">): boolean {
		const entry = this.entries.get(groupIdentity(groupServer, clientId));
		if (this.cycleMarked || entry === undefined || entry.status.serverId !== clientId || entry.cycle !== this.cycle) {
			return false;
		}
		this.advanceCycle();
		return true;
	}

	private advanceCycle(): void {
		this.cycle += 1;
		this.cycleMarked = false;
		const now = this.now();
		const ttl = this.evictionTtlMs();
		for (const [identity, entry] of this.entries) {
			if (entry.cycle < this.cycle - 1 || now - entry.at > ttl) {
				this.entries.delete(identity);
			}
		}
	}

	/**
	 * `served` holds the pre-attach infos by type, never the served copies: snapshots() hands them to the dashboard,
	 * and a served copy may carry the stale decoration, which a healthy sweep must not inherit.
	 *
	 * Only an ok report may carry observations, and one omitting them blanks the carried sets; a failure report
	 * structurally cannot carry any, so an outage only ever carries the previous serve's observations forward.
	 */
	record(
		status: Extract<ServerStatus, { state: "ok" }>,
		served: ServedModelSets,
		groupServer: GroupServer,
		observations?: DiscoveryObservations
	): void;
	record(status: Extract<ServerStatus, { state: "error" }>, served: ServedModelSets, groupServer: GroupServer): void;
	record(
		status: ServerStatus,
		served: ServedModelSets,
		groupServer: GroupServer,
		observations: DiscoveryObservations = {}
	): void {
		const identity = groupIdentity(groupServer, status.serverId);
		const previous = this.entries.get(identity);
		this.entries.set(identity, {
			cycle: this.cycle,
			at: this.now(),
			lastSuccess: status.state === "ok" ? { at: this.now(), models: served.discovered } : previous?.lastSuccess,
			status,
			models: served.declared.length > 0 ? [...served.discovered, ...served.declared] : served.discovered,
			discoveredRawIds:
				status.state === "ok" ? (observations.discoveredRawIds ?? []) : (previous?.discoveredRawIds ?? []),
			observedModelInfoKeys:
				status.state === "ok" ? observations.observedModelInfoKeys : previous?.observedModelInfoKeys,
			skippedModeCounts: status.state === "ok" ? observations.skippedModeCounts : previous?.skippedModeCounts,
			groupServer,
		});
		if (previous === undefined) {
			this.onGroupEntered();
		}
	}

	snapshots(): ServerModelsSnapshot[] {
		return [...this.entries.values()].map((entry) => ({
			status: entry.status,
			models: entry.models,
			...(entry.observedModelInfoKeys !== undefined ? { observedModelInfoKeys: entry.observedModelInfoKeys } : {}),
			...(entry.skippedModeCounts !== undefined ? { skippedModeCounts: entry.skippedModeCounts } : {}),
			...(entry.groupServer.label !== undefined ? { entryLabel: entry.groupServer.label } : {}),
		}));
	}

	/**
	 * This is the extension layer's one path to a group's credentials; the value is handed to the caller only and must
	 * never be logged or pushed into webview state. The dashboard's handle is a snapshot's `status.serverId`.
	 */
	getGroupServer(clientId: string): GroupServer | undefined {
		for (const entry of this.entries.values()) {
			if (entry.status.serverId === clientId) {
				return entry.groupServer;
			}
		}
		return undefined;
	}

	/** The request path's lookup, by the identity a served model carries; same handling rules as getGroupServer. */
	getGroupServerByIdentity(identity: string): GroupServer | undefined {
		return this.entries.get(identity)?.groupServer;
	}

	/**
	 * The distinct base URLs of the LABELED groups currently in the window under `label`: the sync engine's live
	 * ownership evidence (see ServerSyncEnv.observedGroupBaseUrls).
	 *   an unlabeled group's URL-host status label is a display fallback, not an entry's identity
	 *     -> Labeled groups only
	 *   history must not authorize touching whatever took its name
	 *     -> live only
	 */
	observedGroupBaseUrls(label: string): readonly string[] {
		const urls = new Set<string>();
		for (const entry of this.entries.values()) {
			if (entry.groupServer.label === label) {
				urls.add(entry.groupServer.baseUrl);
			}
		}
		return [...urls];
	}

	/** The current client ID of every entry; the facade's prune keep-set. */
	serverIds(): string[] {
		return [...this.entries.values()].map((entry) => entry.status.serverId);
	}

	/** The resolved connections of every group in the window; same handling rules as getGroupServer. */
	groupServers(): GroupServer[] {
		return [...this.entries.values()].map((entry) => entry.groupServer);
	}

	/**
	 * Retention anchors to the last SUCCESS, not the last report - failure reports refresh the entry's timestamp, so a
	 * permanently-down server would otherwise stay selectable forever - and serves from the success bundle, not
	 * `models`, so an out-of-window failure report cannot destroy what a raised staleServeWindow would still serve.
	 * Undefined once the anchor ages past the window (or the server never succeeded, or the window is 0 = stale serving
	 * disabled).
	 */
	staleServableModels(
		clientId: string,
		groupServer: Pick<GroupServer, "label" | "baseUrl" | "entryOwned">
	): { models: readonly PreAttachModelInfo[]; discoveredRawIds: readonly string[]; lastSuccessAt: number } | undefined {
		const entry = this.entries.get(groupIdentity(groupServer, clientId));
		const lastSuccess = entry?.lastSuccess;
		const windowMs = this.staleServeWindowMs();
		if (entry === undefined || lastSuccess === undefined || windowMs <= 0 || this.now() - lastSuccess.at > windowMs) {
			return undefined;
		}
		return { models: lastSuccess.models, discoveredRawIds: entry.discoveredRawIds, lastSuccessAt: lastSuccess.at };
	}
}
