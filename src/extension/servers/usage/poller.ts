/**
 * The usage polling engine: keeps the UsageStore in step with the declared
 * servers on a user-configured cadence, headless (alerts must fire without
 * the dashboard open). Effects arrive through the injected env, so the whole
 * engine is unit-testable without vscode or real time (the timer/clock seams
 * follow openRouterCatalog.ts).
 *
 * Cadence rules: the poll interval is milliseconds (usage.pollInterval), 0
 * disables polling entirely (no background requests; refreshNow still works
 * for the palette command and the dashboard's sync button). Endpoints a probe
 * classified permanently unavailable are skipped on scheduled polls -
 * availability is re-probed only on an explicit refresh (refreshNow) or a
 * servers-setting change - so a DB-less proxy is asked at most once per
 * configuration, never hammered.
 *
 * Log discipline: one info-level English classification per endpoint state
 * transition (labels, endpoint ids, reasons, error names - never
 * response-derived text, which for usage payloads includes hashed keys).
 */

import { RequestError } from "../../../provider/transport/errorMapping";
import { normalizeBaseUrl } from "../../../shared/util/baseUrl";
import type { StoredServerSecrets } from "../serverSync/secrets";
import type { DeclaredServer } from "../serverSync/setting";
import { parseServersSetting } from "../serverSync/setting";
import { newlyCrossedThresholds, resolveBudget } from "./budget";
import type { ActivityWindow, DailyUsage, KeyUsage, UsageConnection, UserUsage } from "./spendClient";
import { activityWindow, usageConnectionFor, usageUnavailabilityOf } from "./spendClient";
import type { UsageEndpointId, UsageEndpointState, UsageEndpointStates } from "./store";
import { UNPROBED_ENDPOINTS, UsageStore, usageAvailabilityOf } from "./store";

/** How many calendar days the daily-activity window reaches back (today included). */
export const USAGE_ACTIVITY_WINDOW_DAYS = 30;

/** The first refresh after start(): soon, but never on the activation path. */
const INITIAL_REFRESH_DELAY_MS = 5_000;

/**
 * The refresh delay after a servers-setting change: long enough to coalesce
 * settings.json keystroke bursts, short enough that a just-added server shows
 * usage promptly.
 */
const SERVERS_CHANGE_REFRESH_DELAY_MS = 2_000;

/** One-shot timer effects, injectable so the poll cadence is testable without real time. */
export interface UsageTimer {
	/** Schedule `callback` after `ms`; the returned closure cancels the pending call. */
	set(callback: () => void, ms: number): () => void;
}

export interface UsageClock {
	now(): number;
}

/** The spend client's fetch surface, as the poller consumes it; UsageClient satisfies it. */
export interface UsageFetchClient {
	fetchKeyInfo(connection: UsageConnection, signal?: AbortSignal): Promise<KeyUsage>;
	fetchDailyActivity(connection: UsageConnection, window: ActivityWindow, signal?: AbortSignal): Promise<DailyUsage>;
	fetchUserInfo(connection: UsageConnection, signal?: AbortSignal): Promise<UserUsage>;
}

/** Everything the poller touches, injected; createUsagePollerEnv builds the real one. */
export interface UsagePollerEnv {
	/** The effective litellm-vscode-chat.servers value: which servers exist and their entry budgets. */
	readServersSetting(): unknown;
	readSecrets(label: string): Promise<StoredServerSecrets>;
	readonly client: UsageFetchClient;
	/** Read at decision time so a setting edit needs no rebuild; 0 means polling is off. */
	pollIntervalMs(): number;
	alertThresholds(): readonly number[];
	log(message: string, data?: unknown): void;
	readonly timer?: UsageTimer;
	readonly clock?: UsageClock;
}

const REAL_TIMER: UsageTimer = {
	set: (callback, ms) => {
		const handle = setTimeout(callback, ms);
		return () => clearTimeout(handle);
	},
};

export class UsagePoller {
	/** The consumer surface: the dashboard, status bar, and notifier read and subscribe here. */
	readonly store: UsageStore;

	private readonly refreshListeners = new Set<() => void>();
	private readonly timer: UsageTimer;
	private readonly clock: UsageClock;
	private readonly abort = new AbortController();
	private cancelScheduled: (() => void) | undefined;
	private running: Promise<void> | undefined;
	private queued: { force: boolean; promise: Promise<void>; resolve: () => void } | undefined;
	/** A pending availability re-probe (servers changed) the next scheduled pass consumes. */
	private probePending = false;
	private disposed = false;

	constructor(private readonly env: UsagePollerEnv) {
		this.store = new UsageStore(env.log);
		this.timer = env.timer ?? REAL_TIMER;
		this.clock = env.clock ?? { now: () => Date.now() };
	}

	/** Schedule the first pass; a no-op while polling is off (interval 0). */
	start(): void {
		this.schedule(INITIAL_REFRESH_DELAY_MS);
	}

	/**
	 * Notified after every completed refresh pass, per-listener isolated; the
	 * dashboard refreshes on it. Multiple consumers subscribe independently
	 * (the store's per-server events carry the finer-grained changes).
	 */
	onDidRefresh(listener: () => void): { dispose(): void } {
		this.refreshListeners.add(listener);
		return { dispose: () => this.refreshListeners.delete(listener) };
	}

	/**
	 * Re-read the poll interval and thresholds after a configuration change:
	 * rewires the pending tick (interval 0 cancels it outright) and recomputes
	 * the crossing state of every tracked server from the data already in the
	 * store - a threshold edit must not wait a full poll cycle to take effect,
	 * and costs no network.
	 */
	applyConfiguration(): void {
		this.recomputeBudgets();
		this.cancelScheduled?.();
		this.cancelScheduled = undefined;
		this.schedule(this.nextTickDelayMs());
	}

	/**
	 * React to a servers-setting change: drop servers that left the setting,
	 * and re-probe availability for the rest (an edited entry may point at a
	 * different proxy or carry new credentials). The refresh itself runs only
	 * while polling is on - with the interval at 0 the pending probe waits for
	 * the next explicit refresh, keeping the documented "no background
	 * requests" promise.
	 */
	applyServersChange(): void {
		const { entries } = parseServersSetting(this.env.readServersSetting());
		this.store.prune(new Set(entries.map((entry) => entry.label)));
		this.probePending = true;
		if (this.env.pollIntervalMs() > 0) {
			this.schedule(SERVERS_CHANGE_REFRESH_DELAY_MS);
		}
	}

	/**
	 * One immediate refresh, availability re-probed, working whether or not
	 * polling is on: the palette command and the dashboard's sync button.
	 * Serialized with any pass in flight (a call during one queues exactly one
	 * follow-up and resolves after it). Never rejects.
	 */
	refreshNow(): Promise<void> {
		return this.refresh(true);
	}

	dispose(): void {
		this.disposed = true;
		this.cancelScheduled?.();
		this.cancelScheduled = undefined;
		this.abort.abort();
		// A queued follow-up will never run; its waiters must still settle.
		this.queued?.resolve();
		this.queued = undefined;
	}

	/** Schedule the next tick unless disposed or polling is off; replaces any pending tick. */
	private schedule(ms: number): void {
		this.cancelScheduled?.();
		this.cancelScheduled = undefined;
		if (this.disposed || this.env.pollIntervalMs() <= 0) {
			return;
		}
		this.cancelScheduled = this.timer.set(() => {
			this.cancelScheduled = undefined;
			const probe = this.probePending;
			this.probePending = false;
			void this.refresh(probe);
		}, ms);
	}

	private async refresh(force: boolean): Promise<void> {
		if (this.running !== undefined) {
			if (this.queued === undefined) {
				let resolve!: () => void;
				const promise = new Promise<void>((resolvePromise) => {
					resolve = resolvePromise;
				});
				this.queued = { force, promise, resolve };
			}
			this.queued.force ||= force;
			return this.queued.promise;
		}
		this.running = this.runOnce(force);
		try {
			await this.running;
		} finally {
			this.running = undefined;
			const queued = this.queued;
			this.queued = undefined;
			if (queued !== undefined) {
				void this.refresh(queued.force).then(queued.resolve, queued.resolve);
			}
		}
	}

	private async runOnce(force: boolean): Promise<void> {
		if (force) {
			// A forced pass re-probes every endpoint, so it satisfies any pending
			// servers-change probe; without this a refreshNow right after a
			// servers edit would be followed by a redundant prompt pass.
			this.probePending = false;
		}
		try {
			await this.runPass(force);
		} catch (error) {
			// Per-server failures are handled inside the pass; this catches the
			// stores themselves misbehaving. Never rethrown: refreshes run from
			// timers and commands.
			this.env.log("Usage refresh pass failed", { error: error instanceof Error ? error.name : typeof error });
		}
		for (const listener of this.refreshListeners) {
			try {
				listener();
			} catch (error) {
				this.env.log("Usage refresh listener failed", { error: error instanceof Error ? error.name : typeof error });
			}
		}
		// Rescheduled at every exit so the cadence survives pass failures; a
		// mid-pass interval edit is honored here. A probe that became pending
		// while this pass ran must not be postponed to the full interval, so
		// the delay honors it (see nextTickDelayMs).
		this.schedule(this.nextTickDelayMs());
	}

	/**
	 * The delay to the next scheduled tick: the prompt servers-change delay
	 * while a re-probe is pending (any reschedule would otherwise cancel the
	 * two-second timer applyServersChange set and postpone the probe by a full
	 * interval), the configured interval otherwise.
	 */
	private nextTickDelayMs(): number {
		return this.probePending ? SERVERS_CHANGE_REFRESH_DELAY_MS : this.env.pollIntervalMs();
	}

	private async runPass(force: boolean): Promise<void> {
		const { entries } = parseServersSetting(this.env.readServersSetting());
		this.store.prune(new Set(entries.map((entry) => entry.label)));
		const thresholds = this.env.alertThresholds();
		for (const entry of entries) {
			if (this.disposed) {
				return;
			}
			await this.refreshServer(entry, thresholds, force);
		}
	}

	private async refreshServer(entry: DeclaredServer, thresholds: readonly number[], force: boolean): Promise<void> {
		const previous = this.store.get(entry.label);
		// A re-pointed entry is a different server: carried standings and data
		// would describe the old host, so both reset with the URL.
		const sameServer = previous !== undefined && normalizeBaseUrl(previous.baseUrl) === normalizeBaseUrl(entry.baseUrl);
		const carried: UsageEndpointStates = !force && sameServer ? previous.endpoints : UNPROBED_ENDPOINTS;
		const endpoints: Record<UsageEndpointId, UsageEndpointState> = { ...carried };
		// Log-transition baseline: the server's real previous standings, NOT the
		// force-reset probe states, so an explicit re-probe of a still-broken
		// server does not re-log its classification.
		const logBaseline: UsageEndpointStates = sameServer ? previous.endpoints : UNPROBED_ENDPOINTS;
		let key: KeyUsage | undefined = sameServer ? previous.key : undefined;
		let daily: DailyUsage | undefined = sameServer ? previous.daily : undefined;
		let user: UserUsage | undefined = sameServer ? previous.user : undefined;
		let lastUpdatedAt = sameServer ? previous.lastUpdatedAt : undefined;
		const attemptAt = this.clock.now();

		let stored: StoredServerSecrets | undefined;
		try {
			stored = await this.env.readSecrets(entry.label);
		} catch (error) {
			// Skipped for this pass, like the sync engine's unreadable-secrets
			// branch: the next pass reads again, and the carried state keeps
			// rendering.
			this.env.log("Reading a server entry's stored secrets failed; usage refresh skipped", {
				label: entry.label,
				error: error instanceof Error ? error.name : typeof error,
			});
		}
		if (stored !== undefined) {
			const connection = usageConnectionFor(entry, stored);

			if (endpoints.keyInfo.kind !== "unavailable") {
				try {
					key = await this.env.client.fetchKeyInfo(connection, this.abort.signal);
					endpoints.keyInfo = { kind: "ok" };
					lastUpdatedAt = this.clock.now();
				} catch (error) {
					endpoints.keyInfo = this.classifyFailure(entry.label, "keyInfo", logBaseline.keyInfo, error);
					if (endpoints.keyInfo.kind === "unavailable") {
						key = undefined;
					}
				}
			}

			if (this.disposed) {
				return;
			}
			if (endpoints.dailyActivity.kind !== "unavailable") {
				try {
					daily = await this.env.client.fetchDailyActivity(
						connection,
						activityWindow(this.clock.now(), USAGE_ACTIVITY_WINDOW_DAYS),
						this.abort.signal
					);
					endpoints.dailyActivity = { kind: "ok" };
					lastUpdatedAt = this.clock.now();
				} catch (error) {
					endpoints.dailyActivity = this.classifyFailure(
						entry.label,
						"dailyActivity",
						logBaseline.dailyActivity,
						error
					);
					if (endpoints.dailyActivity.kind === "unavailable") {
						daily = undefined;
					}
				}
			}

			if (this.disposed) {
				return;
			}
			// The rollup exists only for keys that carry a user. A key that
			// answered WITHOUT one also clears any carried rollup: after a
			// credential change the old rollup would describe another account.
			if (key !== undefined && !key.hasUser) {
				user = undefined;
			}
			if (endpoints.keyInfo.kind === "unavailable") {
				// No key answer means no proof the carried rollup still belongs to
				// this key; the same DB serves both endpoints anyway.
				user = undefined;
			}
			if (key?.hasUser === true && endpoints.userInfo.kind !== "unavailable") {
				try {
					user = await this.env.client.fetchUserInfo(connection, this.abort.signal);
					endpoints.userInfo = { kind: "ok" };
					lastUpdatedAt = this.clock.now();
				} catch (error) {
					endpoints.userInfo = this.classifyFailure(entry.label, "userInfo", logBaseline.userInfo, error);
					if (endpoints.userInfo.kind === "unavailable") {
						user = undefined;
					}
				}
			}
		}

		if (this.disposed) {
			return;
		}
		// The pass snapshots the entries at its start, so a concurrent
		// applyServersChange may have pruned this label mid-fetch; writing the
		// state back would resurrect a server the "removed" event already
		// announced. Re-read presence at the last moment instead.
		const stillDeclared = parseServersSetting(this.env.readServersSetting()).entries.some(
			(declared) => declared.label === entry.label
		);
		if (!stillDeclared) {
			return;
		}
		const budget = resolveBudget({
			entryBudget: entry.budget,
			keyBudget: key?.maxBudget,
			spend: key?.spend,
			budgetResetAt: key?.budgetResetAt,
			thresholds,
		});
		// A re-pointed entry compares against a clean slate: its previous
		// crossings belong to another server, and an also-over-budget new
		// server must still alert.
		const crossedBefore = sameServer && previous !== undefined ? previous.budget.crossedThresholds : [];
		const newly = newlyCrossedThresholds(crossedBefore, budget.crossedThresholds);
		this.store.upsert(
			{
				label: entry.label,
				baseUrl: entry.baseUrl,
				endpoints,
				availability: usageAvailabilityOf(endpoints),
				lastUpdatedAt,
				lastAttemptAt: attemptAt,
				key,
				daily,
				user,
				budget,
			},
			newly
		);
	}

	/**
	 * Classify one endpoint failure into its next standing, logging exactly one
	 * info-level line per state TRANSITION (a server answering 404 every probe
	 * must not write a line per poll). English classifications only: label,
	 * endpoint id, reason or error name, HTTP status - never message text.
	 */
	private classifyFailure(
		label: string,
		endpoint: UsageEndpointId,
		previous: UsageEndpointState,
		error: unknown
	): UsageEndpointState {
		if (this.disposed) {
			// Disposal aborts in-flight fetches; a cancellation is never logged
			// or classified, and the standing it interrupted stays put.
			return previous;
		}
		const reason = usageUnavailabilityOf(error);
		const status = error instanceof RequestError ? error.status : undefined;
		if (reason !== undefined) {
			if (previous.kind !== "unavailable") {
				this.env.log("Usage endpoint unavailable on this server; not retried until an explicit refresh", {
					label,
					endpoint,
					reason,
					...(status !== undefined ? { status } : {}),
				});
			}
			return { kind: "unavailable", reason };
		}
		if (previous.kind !== "error") {
			this.env.log("Usage endpoint request failed; retrying on the next poll", {
				label,
				endpoint,
				error: error instanceof Error ? error.name : typeof error,
				...(status !== undefined ? { status } : {}),
			});
		}
		return { kind: "error" };
	}

	/**
	 * Recompute every tracked server's budget position from data already in
	 * the store (a threshold edit, no network). Emits only for servers whose
	 * crossing state actually changed; crossings a new threshold list newly
	 * reaches count as newly crossed.
	 */
	private recomputeBudgets(): void {
		const thresholds = this.env.alertThresholds();
		for (const state of this.store.getStates()) {
			const budget = resolveBudget({
				entryBudget: state.budget.entryBudget,
				keyBudget: state.budget.keyBudget,
				spend: state.budget.spend,
				budgetResetAt: state.budget.budgetResetAt,
				thresholds,
			});
			const changed =
				budget.crossedThresholds.length !== state.budget.crossedThresholds.length ||
				budget.crossedThresholds.some((t, i) => t !== state.budget.crossedThresholds[i]);
			if (changed) {
				const newly = newlyCrossedThresholds(state.budget.crossedThresholds, budget.crossedThresholds);
				this.store.upsert({ ...state, budget }, newly);
			}
		}
	}
}
