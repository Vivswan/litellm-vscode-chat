/**
 * The rolling status window: each server's latest discovery outcome and the
 * models it registered, accumulated across the host's per-group refresh
 * calls. The host fetches each provider group in its own call, so no single
 * call sees the whole picture; the provider records every outcome here and
 * reports the merged view.
 */

import type { ServerStatus } from "../../shared/servers";
import type { GroupServer, PreAttachModelInfo } from "./groupModels";

/**
 * The floor of the eviction window: rolling status entries and their cached
 * clients are evicted when not refreshed within evictionTtlMs(). The
 * configured stale-serve window bounds stale serving exactly (see
 * staleServableModels) but only GROWS eviction beyond this floor, never
 * shrinks it below: eviction anchors to the last report of any kind, and a
 * short window would evict mid-sweep entries the one-cycle grace exists to
 * keep visible (statusWindow.test.ts pins both directions).
 */
const EVICTION_TTL_FLOOR_MS = 10 * 60 * 1000;

/**
 * One server's slice of the status window, for read-only consumers (the
 * dashboard). `models` are the infos as built by registration, before any
 * group server is attached - PreAttachModelInfo by type, so a snapshot that
 * carries credentials does not compile.
 */
export interface ServerModelsSnapshot {
	readonly status: ServerStatus;
	readonly models: readonly PreAttachModelInfo[];
	/**
	 * The raw model IDs discovery last returned for this server, carried
	 * forward across failure reports like lastSuccess. declared-ID inertness
	 * is judged against this set, never against `models`: registration may
	 * emit only synthetic variants (`foo:cheapest`) for a discovered `foo`.
	 */
	readonly discoveredRawIds: readonly string[];
	/**
	 * The model_info keys the last successful /model/info listing reported
	 * (see FetchModelsResult.observedModelInfoKeys), carried forward across
	 * failure reports exactly like discoveredRawIds so a mid-outage refresh
	 * cannot blank the set. Absent when the last success came from the /models
	 * fallback (or the server never reported keys).
	 */
	readonly observedModelInfoKeys?: readonly string[] | undefined;
}

type StatusWindowEntry = {
	cycle: number;
	at: number;
	/**
	 * The last successful discovery: when it happened and what it served,
	 * carried forward across failure reports (undefined = never succeeded).
	 * `at` refreshes on every report, success or not, so it cannot age
	 * anything; this is the anchor and the source set for stale serving. Kept
	 * apart from `models` (what the LATEST report served, the dashboard's
	 * view): a failure report past the stale window records an empty `models`,
	 * but must not destroy this bundle - a discovery.staleServeWindow raised
	 * mid-outage serves from it again.
	 */
	lastSuccess: { at: number; models: readonly PreAttachModelInfo[] } | undefined;
	status: ServerStatus;
	models: readonly PreAttachModelInfo[];
	discoveredRawIds: readonly string[];
	observedModelInfoKeys: readonly string[] | undefined;
	/**
	 * The group's resolved connection (the extension layer's one path to a
	 * group's credentials); every entry is a VS Code provider group.
	 */
	groupServer: GroupServer;
};

/**
 * What one successful discovery observed, recorded beside its status report.
 * A named bundle (not positional parameters) because both members are string
 * arrays: transposing them at a call site would type-check.
 */
export interface DiscoveryObservations {
	/** The raw IDs discovery returned; see ServerModelsSnapshot.discoveredRawIds. */
	readonly discoveredRawIds?: readonly string[] | undefined;
	/** The observed model_info keys, when the listing reported them; see ServerModelsSnapshot.observedModelInfoKeys. */
	readonly observedModelInfoKeys?: readonly string[] | undefined;
}

/**
 * Statuses accumulate keyed by server ID; the group-agnostic call (normally
 * the first of a refresh cycle) advances the cycle counter. An entry survives
 * the cycle after its last report and is evicted at the second cycle
 * boundary; that one-cycle grace is load-bearing: it keeps servers not yet
 * re-fetched in the current sweep visible, so the merged view never flickers
 * mid-sweep. Two fallbacks cover hosts that skip the group-agnostic call:
 * re-seeing a group within one unmarked cycle also starts a new cycle
 * (beginCycleOnReSight), and entries untouched for evictionTtlMs() go
 * regardless.
 */
export class StatusWindow {
	private cycle = 0;
	/**
	 * Whether the current cycle was started by the group-agnostic call. A
	 * marked cycle is host-driven, and a host that makes the group-agnostic
	 * call makes one per sweep - so inside a marked cycle, a group reporting
	 * under an identity already seen this cycle is two host groups resolving
	 * to one identity (created before entry labels flowed into group
	 * configurations), not a new sweep, and restarting the cycle on it would
	 * evict entries the sweep has not re-reached yet. The re-see fallback
	 * therefore only runs in unmarked cycles (hosts that skip the
	 * group-agnostic call entirely).
	 */
	private cycleMarked = false;
	private readonly entries = new Map<string, StatusWindowEntry>();

	constructor(
		private readonly now: () => number,
		/**
		 * The discovery.staleServeWindow setting, read at consumption time so a
		 * settings change reaches the next refresh without event plumbing. The
		 * provider facade wires the settings read; tests inject constants.
		 */
		private readonly staleServeWindowMs: () => number
	) {}

	/**
	 * How long an entry untouched by any report survives: the configured
	 * stale-serve window, floored at EVICTION_TTL_FLOOR_MS. The window must
	 * reach eviction because the stale-serve anchor (lastSuccess) lives on
	 * the entry: a host that made no refresh for longer than the floor (a
	 * suspended laptop) would otherwise evict the entry at the next cycle
	 * boundary and lose the anchor a longer configured window promises to
	 * serve from.
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
	 * The re-see fallback for hosts that skip the group-agnostic call: a group
	 * reporting again within one unmarked cycle means a new sweep started, so
	 * a fresh (unmarked) cycle begins and true is reported so the caller can
	 * prune alongside. Inside a marked cycle this never fires; see cycleMarked.
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
	 * `models` are the pre-attach infos (registration output) by type, never
	 * the group-attached copies: snapshots() hands them to the dashboard, and
	 * attached copies embed the server's credentials, so AttachedModelInfo
	 * does not compile here.
	 */
	record(
		status: ServerStatus,
		models: readonly PreAttachModelInfo[],
		groupServer: GroupServer,
		/** What the discovery observed when it succeeded; failure reports carry the previous observations forward. */
		observations: DiscoveryObservations = {}
	): void {
		const previous = this.entries.get(status.serverId);
		this.entries.set(status.serverId, {
			cycle: this.cycle,
			at: this.now(),
			lastSuccess: status.state === "ok" ? { at: this.now(), models } : previous?.lastSuccess,
			status,
			models,
			discoveredRawIds:
				status.state === "ok" ? (observations.discoveredRawIds ?? []) : (previous?.discoveredRawIds ?? []),
			observedModelInfoKeys:
				status.state === "ok" ? observations.observedModelInfoKeys : previous?.observedModelInfoKeys,
			groupServer,
		});
	}

	/** The window's current view for read-only consumers; see ServerModelsSnapshot. */
	snapshots(): ServerModelsSnapshot[] {
		return [...this.entries.values()].map((entry) => ({
			status: entry.status,
			models: entry.models,
			discoveredRawIds: entry.discoveredRawIds,
			...(entry.observedModelInfoKeys !== undefined ? { observedModelInfoKeys: entry.observedModelInfoKeys } : {}),
		}));
	}

	/**
	 * The resolved connection of a live provider group, looked up by the server
	 * ID its status snapshot carries. This is the extension layer's one path to
	 * a group's credentials (the dashboard's adopt action copies them into the
	 * servers setting; the group keeps its own); the value is handed to the
	 * caller only and must never be logged or pushed into webview state.
	 * Aged-out groups resolve to undefined.
	 */
	getGroupServer(serverId: string): GroupServer | undefined {
		return this.entries.get(serverId)?.groupServer;
	}

	/** Every group client ID currently in the window. */
	serverIds(): string[] {
		return [...this.entries.keys()];
	}

	/** The resolved connections of every group in the window; same handling rules as getGroupServer. */
	groupServers(): GroupServer[] {
		return [...this.entries.values()].map((entry) => entry.groupServer);
	}

	/**
	 * The last known models a failed group refresh may still serve, with the
	 * last successful discovery they came from. Retention is anchored to that
	 * SUCCESS, not the last report - failure reports refresh the entry's
	 * timestamp, so without the anchor a permanently-down server would stay
	 * selectable forever - and served from the success bundle, not from
	 * `models`, so an out-of-window failure report (which records the empty
	 * list) cannot destroy what a raised discovery.staleServeWindow would
	 * still serve. Undefined once the anchor ages past the configured window
	 * (or the server never succeeded, or the window is 0 = stale serving
	 * disabled), at which point the failure serves the empty list, as it
	 * always did.
	 */
	staleServableModels(
		serverId: string
	): { models: readonly PreAttachModelInfo[]; discoveredRawIds: readonly string[]; lastSuccessAt: number } | undefined {
		const entry = this.entries.get(serverId);
		const lastSuccess = entry?.lastSuccess;
		const windowMs = this.staleServeWindowMs();
		if (entry === undefined || lastSuccess === undefined || windowMs <= 0 || this.now() - lastSuccess.at > windowMs) {
			return undefined;
		}
		return { models: lastSuccess.models, discoveredRawIds: entry.discoveredRawIds, lastSuccessAt: lastSuccess.at };
	}
}
