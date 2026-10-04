/**
 * The rolling status window: each server's latest discovery outcome and the models it registered, accumulated across
 * the host's per-group refresh calls.
 */

import type { SkippedModeCounts } from "../../shared/serverEntry";
import type { ServerStatus } from "../../shared/servers";
import type { GroupServer, PreAttachModelInfo } from "./groupModels";

/**
 * The configured stale-serve window only GROWS eviction beyond this floor, never shrinks it: eviction anchors to the
 * last report of any kind, and a short window would evict mid-sweep entries the one-cycle grace exists to keep visible.
 */
const EVICTION_TTL_FLOOR_MS = 10 * 60 * 1000;

/**
 * One server's slice of the status window, for read-only consumers (the dashboard). `models` are registration's infos
 * before any group server is attached - PreAttachModelInfo by type, so a snapshot carrying credentials does not
 * compile.
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
		/** Never fired for re-reports of an identity already in the window. */
		private readonly onLabeledGroupEntered: () => void = () => {}
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
	 */
	beginCycleOnReSight(serverId: string): boolean {
		if (this.cycleMarked || this.entries.get(serverId)?.cycle !== this.cycle) {
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
		for (const [serverId, entry] of this.entries) {
			if (entry.cycle < this.cycle - 1 || now - entry.at > ttl) {
				this.entries.delete(serverId);
			}
		}
	}

	/**
	 * `served` holds the pre-attach infos by type, never the group-attached copies: snapshots() hands them to the
	 * dashboard, and attached copies embed the server's credentials.
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
		// A credential rotation mints a new client ID for the same logical group. The retired identity is evicted at
		// once rather than left to age out: a lingering twin double-counts the merged status and renders as a ghost
		// external row whose Hide would tombstone the label the REAL group serves under.
		//   Its last success -> carries into the successor as the stale-serve anchor
		const twin = this.labeledTwin(status.serverId, groupServer);
		if (twin !== undefined) {
			this.entries.delete(twin[0]);
		}
		const previous = this.entries.get(status.serverId) ?? twin?.[1];
		// A twin's successor is the same logical group: not an entry.
		const entered = groupServer.label !== undefined && previous === undefined;
		this.entries.set(status.serverId, {
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
		if (entered) {
			this.onLabeledGroupEntered();
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
	 * never be logged or pushed into webview state.
	 */
	getGroupServer(serverId: string): GroupServer | undefined {
		return this.entries.get(serverId)?.groupServer;
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

	serverIds(): string[] {
		return [...this.entries.keys()];
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
		serverId: string,
		groupServer?: Pick<GroupServer, "label" | "baseUrl">
	): { models: readonly PreAttachModelInfo[]; discoveredRawIds: readonly string[]; lastSuccessAt: number } | undefined {
		// A rotated identity has no record until its first report lands, but its labeled twin's last success is the
		// same logical group's models.
		const entry = this.entries.get(serverId) ?? this.labeledTwin(serverId, groupServer)?.[1];
		const lastSuccess = entry?.lastSuccess;
		const windowMs = this.staleServeWindowMs();
		if (entry === undefined || lastSuccess === undefined || windowMs <= 0 || this.now() - lastSuccess.at > windowMs) {
			return undefined;
		}
		return { models: lastSuccess.models, discoveredRawIds: entry.discoveredRawIds, lastSuccessAt: lastSuccess.at };
	}

	/**
	 * The labeled twin of a server ID: an entry for the SAME logical group (same label, same base URL) recorded under
	 * a different, usually retired, identity.
	 *
	 * Both base URLs are NormalizedBaseUrl by construction.
	 */
	private labeledTwin(
		serverId: string,
		groupServer: Pick<GroupServer, "label" | "baseUrl"> | undefined
	): [string, StatusWindowEntry] | undefined {
		if (groupServer?.label === undefined) {
			return undefined;
		}
		for (const [id, entry] of this.entries) {
			if (
				id !== serverId &&
				entry.groupServer.label === groupServer.label &&
				entry.groupServer.baseUrl === groupServer.baseUrl
			) {
				return [id, entry];
			}
		}
		return undefined;
	}
}
