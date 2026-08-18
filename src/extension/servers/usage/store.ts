/**
 * The usage store: the typed, subscribable state the later surfaces consume -
 * the dashboard's usage section, the status bar, and the notifier (both
 * subscribe to onDidChange and read the newly crossed thresholds off each
 * event).
 *
 * Contents are numbers, epoch timestamps, day keys, user-configured identity
 * (label, base URL), and closed classification enums ONLY: everything
 * response-derived was narrowed away in the spend client, so a state object is
 * always safe to push to the webview. The poller is the sole writer.
 * Deliberately vscode-free so the unit suites drive it directly.
 */

import type { UsageEndpointId } from "../../../dashboard/usageEndpoints";
import type { BudgetStatus } from "./budget";
import type { DailyUsage, KeyUsage, UsageUnavailableReason, UserUsage } from "./spendClient";

/**
 * How a transient endpoint failure failed, as a closed vocabulary (never
 * message text): "http" answered with a status, "network" never reached the
 * server, "timeout" hit the whole-call discovery.timeout bound.
 */
export type UsageFailureClassification = "http" | "network" | "timeout";

/**
 * One endpoint's standing on one server. "unknown" means never probed (or
 * awaiting a re-probe after a config change), "unavailable" is a permanent
 * classification scheduled polls never retry (only an explicit refresh or a
 * server config change re-probes it), and "error" is a transient failure
 * scheduled polls keep retrying with backoff. Both extras are classification
 * data, never response text.
 */
export type UsageEndpointState =
	| { readonly kind: "unknown" }
	| { readonly kind: "ok" }
	| { readonly kind: "unavailable"; readonly reason: UsageUnavailableReason; readonly status?: number | undefined }
	| {
			readonly kind: "error";
			readonly classification?: UsageFailureClassification | undefined;
			readonly status?: number | undefined;
	  };

/** The per-endpoint standings of one server. */
export type UsageEndpointStates = Readonly<Record<UsageEndpointId, UsageEndpointState>>;

export const UNPROBED_ENDPOINTS: UsageEndpointStates = {
	keyInfo: { kind: "unknown" },
	dailyActivity: { kind: "unknown" },
	userInfo: { kind: "unknown" },
};

/**
 * The server-level availability verdict the UI hides or shows the usage surface
 * on: "unavailable" only when BOTH non-admin-safe data sources are permanently
 * unavailable, "available" as soon as either has answered, "unknown" while
 * nothing has been probed.
 */
export type UsageAvailability = "unknown" | "available" | "unavailable";

export function usageAvailabilityOf(endpoints: UsageEndpointStates): UsageAvailability {
	if (endpoints.keyInfo.kind === "ok" || endpoints.dailyActivity.kind === "ok") {
		return "available";
	}
	if (endpoints.keyInfo.kind === "unavailable" && endpoints.dailyActivity.kind === "unavailable") {
		return "unavailable";
	}
	return "unknown";
}

/** Everything the usage surfaces know about one declared server. */
export interface ServerUsageState {
	/** The declared entry's label: the store key and the join key back to the server rows. */
	readonly label: string;
	readonly baseUrl: string;
	readonly endpoints: UsageEndpointStates;
	/**
	 * The card-visibility verdict. Usually usageAvailabilityOf(endpoints), but
	 * sticky: the poller keeps a once-available server "available" through
	 * transient failures, and only a both-endpoints-unavailable verdict hides it.
	 */
	readonly availability: UsageAvailability;
	/** When any endpoint last answered successfully (epoch ms). */
	readonly lastUpdatedAt: number | undefined;
	/**
	 * When /key/info last answered successfully (epoch ms): the age of the SPEND
	 * numbers specifically. The freshness rule and the "last updated" labels read
	 * this one - an activity-endpoint success must not relabel old spend as
	 * current.
	 */
	readonly spendUpdatedAt: number | undefined;
	/** When the poller last tried this server (epoch ms), success or not. */
	readonly lastAttemptAt: number | undefined;
	/** Own-key budget and spend, when /key/info answers. */
	readonly key: KeyUsage | undefined;
	/** The recent-days window, when /user/daily/activity answers. */
	readonly daily: DailyUsage | undefined;
	/** The user rollup, when the key carries a user and /user/info answers. */
	readonly user: UserUsage | undefined;
	/** The resolved budget position, crossings included. */
	readonly budget: BudgetStatus;
}

/** One store change: an updated server state, or a server leaving the setting. */
export type UsageChangeEvent =
	| {
			readonly kind: "updated";
			readonly label: string;
			readonly state: ServerUsageState;
			/**
			 * Alert thresholds this update crossed for the first time since they
			 * were last below (the once-per-crossing dedup the notifier keys on).
			 */
			readonly newlyCrossedThresholds: readonly number[];
	  }
	| { readonly kind: "removed"; readonly label: string };

export class UsageStore {
	private readonly states = new Map<string, ServerUsageState>();
	private readonly listeners = new Set<(event: UsageChangeEvent) => void>();

	constructor(private readonly log?: (message: string, data?: unknown) => void) {}

	/** Every tracked server's state, label-sorted for stable rendering. */
	getStates(): readonly ServerUsageState[] {
		return [...this.states.values()].sort((a, b) => a.label.localeCompare(b.label));
	}

	get(label: string): ServerUsageState | undefined {
		return this.states.get(label);
	}

	onDidChange(listener: (event: UsageChangeEvent) => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	/** Poller-only: install one server's refreshed state and notify. */
	upsert(state: ServerUsageState, newlyCrossedThresholds: readonly number[]): void {
		this.states.set(state.label, state);
		this.emit({ kind: "updated", label: state.label, state, newlyCrossedThresholds });
	}

	/** Poller-only: drop servers no longer declared; each removal notifies. */
	prune(stillDeclared: (label: string) => boolean): void {
		for (const label of [...this.states.keys()]) {
			if (!stillDeclared(label)) {
				this.states.delete(label);
				this.emit({ kind: "removed", label });
			}
		}
	}

	private emit(event: UsageChangeEvent): void {
		for (const listener of this.listeners) {
			// Isolated: one consumer throwing must not starve the others or read
			// back into the poller as a failed refresh.
			try {
				listener(event);
			} catch (error) {
				this.log?.("Usage store listener failed", { error: error instanceof Error ? error.name : typeof error });
			}
		}
	}
}
