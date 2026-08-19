/**
 * The usage polling engine: keeps the UsageStore in step with the declared
 * servers, headless (alerts must fire without the dashboard open). Effects
 * arrive through the injected env, so the engine is unit-testable without
 * vscode or real time (the shared timer/clock seams).
 *
 * Cadence rules: usage.pollInterval is milliseconds, 0 disables polling
 * entirely (no background requests; refreshNow still works). Permanently
 * unavailable endpoints are skipped on scheduled polls - re-probed only on an
 * explicit refresh or a servers-setting change - so a DB-less proxy is asked
 * at most once per configuration. Transient failures retry normally after one
 * failure, then back off exponentially (2x, 4x, 8x, 16x the interval); a
 * success, an explicit refresh, or a servers-setting change resets it.
 *
 * Log discipline: one info-level English classification per endpoint state
 * transition (labels, endpoint ids, reasons, error names - never
 * response-derived text, which for usage payloads includes hashed keys).
 */

import type { UsageEndpointId } from "../../../dashboard/usageEndpoints";
import { USAGE_ENDPOINT_PATHS } from "../../../dashboard/usageEndpoints";
import { RequestError } from "../../../provider/transport/errorMapping";
import { NUMBER_SETTING_SPECS } from "../../../shared/config/settingSpec";
import { normalizeBaseUrl } from "../../../shared/util/baseUrl";
import type { Clock, Timer } from "../../../shared/util/timer";
import { PendingCall, REAL_TIMER, SYSTEM_CLOCK } from "../../../shared/util/timer";
import type { StoredServerSecrets } from "../serverSync/secrets";
import type { DeclaredServer } from "../serverSync/setting";
import { acceptedEntry, parseServersSetting, stillDeclaredIn } from "../serverSync/setting";
import { newlyCrossedThresholds, resolveBudget } from "./budget";
import type { ActivityWindow, DailyUsage, KeyUsage, UsageConnection, UserUsage } from "./spendClient";
import { activityWindow, usageConnectionFor, usageUnavailabilityOf } from "./spendClient";
import type { UsageEndpointState, UsageEndpointStates, UsageFailureClassification } from "./store";
import { UNPROBED_ENDPOINTS, UsageStore, usageAvailabilityOf } from "./store";

/** How many calendar days the daily-activity window reaches back (today included). */
export const USAGE_ACTIVITY_WINDOW_DAYS = 30;

/** Caps the error backoff at 2^4 = 16x the poll interval (80 minutes at the default 5-minute cadence). */
const BACKOFF_MAX_EXPONENT = 4;

/**
 * The scheduled-attempt spacing after `failures` consecutive transient
 * failures, as a multiple of the poll interval: 1 after a single failure, then
 * doubling to the cap.
 */
function backoffMultiplierOf(failures: number): number {
	return failures <= 1 ? 1 : 2 ** Math.min(failures - 1, BACKOFF_MAX_EXPONENT);
}

/** One endpoint's consecutive transient-failure streak: how many, and when the last attempt was made. */
interface EndpointFailureStreak {
	readonly failures: number;
	readonly lastAttemptAt: number;
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
	/**
	 * The delay from start() to the first pass (usage.initialRefreshDelay):
	 * soon, but never on the activation path. Optional; the spec default applies.
	 */
	initialRefreshDelayMs?(): number;
	/**
	 * The refresh delay after a servers-setting change
	 * (usage.serversChangeRefreshDelay): long enough to coalesce settings.json
	 * keystroke bursts, short enough that a just-added server shows usage
	 * promptly. Optional; the spec default applies.
	 */
	serversChangeRefreshDelayMs?(): number;
	alertThresholds(): readonly number[];
	log(message: string, data?: unknown): void;
	readonly timer?: Timer;
	readonly clock?: Clock;
}

/**
 * One endpoint attempt that failed during an explicit refresh pass, as
 * classification data only - never message text. Feeds the refresh command's
 * failure toast; never written to the log.
 */
export interface UsageEndpointFailure {
	readonly endpoint: UsageEndpointId;
	readonly classification?: UsageFailureClassification | undefined;
	readonly status?: number | undefined;
	readonly reason?: "unsupported" | "forbidden" | undefined;
}

/** One server's endpoint attempts in one refresh pass: what failed, and whether anything answered. */
export interface UsageServerRefreshOutcome {
	readonly label: string;
	readonly failures: readonly UsageEndpointFailure[];
	readonly succeededAny: boolean;
	/** The pass never reached the network: the entry's stored secrets could not be read. */
	readonly secretsUnreadable?: true | undefined;
}

/** A completed refresh pass's per-server outcomes; refreshNow resolves with it (undefined when disposed mid-pass). */
export interface UsageRefreshOutcome {
	readonly servers: readonly UsageServerRefreshOutcome[];
}

/**
 * Whether two resolved connections are identical, field for field. JSON over
 * usageConnectionFor's fixed construction order; the rendering carries secret
 * values, so it stays in memory and is never logged.
 */
function sameConnection(a: UsageConnection, b: UsageConnection): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function describeEndpointFailure(failure: UsageEndpointFailure): string {
	const how =
		failure.status !== undefined
			? String(failure.status)
			: failure.classification === "timeout"
				? "timeout"
				: failure.classification === "network"
					? "network error"
					: "failed";
	return `${USAGE_ENDPOINT_PATHS[failure.endpoint]} ${how}${failure.reason !== undefined ? ` ${failure.reason}` : ""}`;
}

/**
 * The failures worth an explicit-refresh acknowledgment. "unsupported" is a
 * documented normal shape (a DB-less proxy answers 400/404 forever), so a
 * server whose only failures are unsupported endpoints must never trip the
 * toast; an unreadable secrets blob means the refresh never reached the
 * network at all.
 */
function actionableFailureText(server: UsageServerRefreshOutcome): string | undefined {
	if (server.secretsUnreadable === true) {
		return `${server.label}: stored secrets unreadable`;
	}
	const failures = server.failures.filter((failure) => failure.reason !== "unsupported");
	if (failures.length === 0) {
		return undefined;
	}
	return `${server.label}: ${failures.map(describeEndpointFailure).join(", ")}`;
}

/**
 * The compact per-server detail for an explicit refresh in which NO server
 * returned any usage data. Undefined when any endpoint succeeded, when nothing
 * was probed, or when nothing actionable failed, so partial failures and
 * all-unsupported servers stay toast-free. Template-only by construction:
 * labels, endpoint paths, status numbers, and fixed vocabulary.
 */
export function usageRefreshFailureSummary(outcome: UsageRefreshOutcome): string | undefined {
	if (outcome.servers.some((server) => server.succeededAny)) {
		return undefined;
	}
	const failed = outcome.servers.map(actionableFailureText).filter((text): text is string => text !== undefined);
	if (failed.length === 0) {
		return undefined;
	}
	return failed.join("; ");
}

export class UsagePoller {
	/** The consumer surface: the dashboard, status bar, and notifier read and subscribe here. */
	readonly store: UsageStore;

	private readonly refreshListeners = new Set<() => void>();
	private readonly startListeners = new Set<() => void>();
	private readonly scheduled: PendingCall;
	private readonly clock: Clock;
	private readonly abort = new AbortController();
	private running: Promise<UsageRefreshOutcome | undefined> | undefined;
	/** Whether the running pass was explicitly requested; isRefreshingExplicitly reads it. */
	private runningExplicit = false;
	private queued:
		| {
				force: boolean;
				explicit: boolean;
				promise: Promise<UsageRefreshOutcome | undefined>;
				resolve: (outcome: UsageRefreshOutcome | undefined) => void;
		  }
		| undefined;
	/** When the last pass ran to completion (epoch ms); refreshIfStale's staleness reads it. */
	private lastCompletedPassAt: number | undefined;
	/** A pending availability re-probe (servers changed) the next scheduled pass consumes. */
	private probePending = false;
	/**
	 * Consecutive error-kind failure streaks per server label and endpoint,
	 * driving the exponential backoff on scheduled polls. Deliberately NOT in
	 * the store: no carried store state can then replay a stale backoff.
	 */
	private readonly errorStreaks = new Map<string, Map<UsageEndpointId, EndpointFailureStreak>>();
	private disposed = false;

	constructor(private readonly env: UsagePollerEnv) {
		this.store = new UsageStore(env.log);
		this.scheduled = new PendingCall(env.timer ?? REAL_TIMER);
		this.clock = env.clock ?? SYSTEM_CLOCK;
	}

	/** Schedule the first pass; a no-op while polling is off (interval 0). */
	start(): void {
		this.schedule(this.initialRefreshDelayMs());
	}

	/** The env's configured delays, spec-defaulted when the env leaves them out. */
	private initialRefreshDelayMs(): number {
		return this.env.initialRefreshDelayMs?.() ?? NUMBER_SETTING_SPECS["usage.initialRefreshDelay"].default;
	}

	private serversChangeRefreshDelayMs(): number {
		return this.env.serversChangeRefreshDelayMs?.() ?? NUMBER_SETTING_SPECS["usage.serversChangeRefreshDelay"].default;
	}

	/** Whether a refresh pass is in flight; the dashboard's Refresh now button disables on it (one serialized engine). */
	isRefreshing(): boolean {
		return this.running !== undefined;
	}

	/**
	 * Whether the pass in flight (or queued behind one) was explicitly
	 * requested - the palette command or a dashboard Refresh now. Scheduled
	 * polls, backoff retries, servers-change probes, and open-triggered
	 * staleness passes all stay false, so the Refresh-now button wears its busy
	 * label only for work that button was asked to do.
	 */
	isRefreshingExplicitly(): boolean {
		return (this.running !== undefined && this.runningExplicit) || this.queued?.explicit === true;
	}

	/** Notified after every completed refresh pass, per-listener isolated; the dashboard refreshes on it. */
	onDidRefresh(listener: () => void): { dispose(): void } {
		this.refreshListeners.add(listener);
		return { dispose: () => this.refreshListeners.delete(listener) };
	}

	/**
	 * Notified when a refresh pass STARTS, per-listener isolated; the dashboard
	 * re-pushes on it so an open panel's Refresh now disables the moment ANY
	 * pass begins, scheduled polls included.
	 */
	onDidStartRefresh(listener: () => void): { dispose(): void } {
		this.startListeners.add(listener);
		return { dispose: () => this.startListeners.delete(listener) };
	}

	/**
	 * Re-read the poll interval after a configuration change: rewires the
	 * pending tick (interval 0 cancels it outright). Deliberately NO crossing
	 * recomputation - alerts evaluate on fetches only, so a threshold edit must
	 * not toast from cached data; the stored crossings re-baseline on the next
	 * fetch, and the live-reading surfaces update without any store write.
	 */
	applyConfiguration(): void {
		this.schedule(this.nextTickDelayMs());
	}

	/**
	 * React to a servers-setting change: drop servers whose label left the
	 * setting, and re-probe availability for the rest (an edited entry may point
	 * at a different proxy or carry new credentials). Removal is presence, not
	 * acceptance (the sync engine's rule, via stillDeclaredIn): a mid-edit
	 * malformed entry keeps its state, standings, and crossings, so repairing
	 * it cannot re-fire already-shown alerts. With the interval at 0 the
	 * pending probe waits for the next explicit refresh, keeping the
	 * documented "no background requests" promise.
	 */
	applyServersChange(): void {
		this.prune(stillDeclaredIn(this.env.readServersSetting()));
		this.probePending = true;
		if (this.env.pollIntervalMs() > 0) {
			this.schedule(this.serversChangeRefreshDelayMs());
		}
	}

	/**
	 * One immediate refresh, availability re-probed, working whether or not
	 * polling is on. Serialized with any pass in flight (a call during one
	 * queues exactly one follow-up and resolves after it). Never rejects;
	 * resolves with the pass's per-server outcomes, or undefined when the poller
	 * was disposed before the pass completed (cancellation must stay silent).
	 */
	refreshNow(): Promise<UsageRefreshOutcome | undefined> {
		return this.refresh(true, true);
	}

	/**
	 * The dashboard-open refresh: one pass only when the stored numbers are
	 * stale - no completed pass yet this session, or the last one older than the
	 * effective poll interval (the interval's spec default is the staleness
	 * floor while polling is off). A pass in flight or queued counts as
	 * about-to-be-fresh and starts nothing. Forced like an explicit refresh but
	 * NOT explicit, so the Refresh-now button stays quiet.
	 */
	refreshIfStale(): Promise<UsageRefreshOutcome | undefined> | undefined {
		if (this.disposed) {
			return undefined;
		}
		// A pending availability probe (the servers setting changed) overrides
		// every freshness reading: the stored numbers may describe servers or
		// credentials that no longer exist, and with polling off nothing else
		// would ever run the probe.
		if (this.probePending) {
			return this.refresh(true, false);
		}
		if (this.running !== undefined || this.queued !== undefined) {
			return undefined;
		}
		if (this.lastCompletedPassAt !== undefined) {
			const interval = this.env.pollIntervalMs();
			const staleAfterMs = interval > 0 ? interval : NUMBER_SETTING_SPECS["usage.pollInterval"].default;
			const elapsedMs = this.clock.now() - this.lastCompletedPassAt;
			// A clock that jumped backwards fails open, like shouldAttempt's.
			if (elapsedMs >= 0 && elapsedMs < staleAfterMs) {
				return undefined;
			}
		}
		return this.refresh(true, false);
	}

	dispose(): void {
		this.disposed = true;
		this.scheduled.cancel();
		this.abort.abort();
		// A queued follow-up will never run; its waiters must still settle -
		// with no outcome, so no waiter mistakes disposal for a failed refresh.
		this.queued?.resolve(undefined);
		this.queued = undefined;
	}

	/** Schedule the next tick unless disposed or polling is off; replaces any pending tick. */
	private schedule(ms: number): void {
		this.scheduled.cancel();
		if (this.disposed || this.env.pollIntervalMs() <= 0) {
			return;
		}
		this.scheduled.arm(() => {
			const probe = this.probePending;
			this.probePending = false;
			void this.refresh(probe, false);
		}, ms);
	}

	private async refresh(force: boolean, explicit: boolean): Promise<UsageRefreshOutcome | undefined> {
		// Checked here, not only in the pass: the teardown detaches a queued
		// follow-up before the completion listeners run, so a listener that
		// disposes the poller leaves nothing for dispose() to settle, and this
		// guard is what stops that follow-up starting a pass after disposal.
		if (this.disposed) {
			return undefined;
		}
		if (this.running !== undefined) {
			if (this.queued === undefined) {
				let resolve!: (outcome: UsageRefreshOutcome | undefined) => void;
				const promise = new Promise<UsageRefreshOutcome | undefined>((resolvePromise) => {
					resolve = resolvePromise;
				});
				this.queued = { force, explicit, promise, resolve };
			}
			this.queued.force ||= force;
			this.queued.explicit ||= explicit;
			return this.queued.promise;
		}
		this.runningExplicit = explicit;
		this.running = this.runOnce(force);
		for (const listener of this.startListeners) {
			try {
				listener();
			} catch (error) {
				this.env.log("Usage refresh start listener failed", {
					error: error instanceof Error ? error.name : typeof error,
				});
			}
		}
		try {
			return await this.running;
		} finally {
			this.running = undefined;
			this.runningExplicit = false;
			// The queued follow-up detaches BEFORE the completion listeners run:
			// isRefreshingExplicitly reads the queue, and a listener firing with
			// one still attached would publish "idle but explicitly refreshing".
			const queued = this.queued;
			this.queued = undefined;
			// Completion is announced AFTER the engine reads idle, so a listener
			// that re-publishes engine state reports the button re-enabled instead
			// of freezing it on a stale "in flight".
			for (const listener of this.refreshListeners) {
				try {
					listener();
				} catch (error) {
					this.env.log("Usage refresh listener failed", { error: error instanceof Error ? error.name : typeof error });
				}
			}
			if (queued !== undefined) {
				void this.refresh(queued.force, queued.explicit).then(queued.resolve, () => queued.resolve(undefined));
			}
		}
	}

	private async runOnce(force: boolean): Promise<UsageRefreshOutcome | undefined> {
		if (force) {
			// A forced pass re-probes every endpoint, so it satisfies any pending
			// servers-change probe.
			this.probePending = false;
		}
		let outcome: UsageRefreshOutcome | undefined;
		try {
			outcome = await this.runPass(force);
		} catch (error) {
			// Per-server failures are handled inside the pass; this catches the
			// stores themselves misbehaving. Never rethrown: refreshes run from
			// timers and commands.
			this.env.log("Usage refresh pass failed", { error: error instanceof Error ? error.name : typeof error });
		}
		if (outcome !== undefined) {
			// Only a pass that ran to completion counts for staleness; an
			// interrupted one proved nothing. A pass whose servers all FAILED still
			// counts - the numbers are as fresh as the fleet allows.
			this.lastCompletedPassAt = this.clock.now();
		}
		// Rescheduled at every exit so the cadence survives pass failures; a
		// mid-pass interval edit is honored here. A probe that became pending
		// while this pass ran must not be postponed to the full interval, so the
		// delay honors it (see nextTickDelayMs).
		this.schedule(this.nextTickDelayMs());
		return outcome;
	}

	/**
	 * The delay to the next scheduled tick: the prompt servers-change delay
	 * while a re-probe is pending (any reschedule would otherwise cancel the
	 * timer applyServersChange set and postpone the probe by a full interval),
	 * the configured interval otherwise.
	 */
	private nextTickDelayMs(): number {
		return this.probePending ? this.serversChangeRefreshDelayMs() : this.env.pollIntervalMs();
	}

	private async runPass(force: boolean): Promise<UsageRefreshOutcome | undefined> {
		const rawSetting = this.env.readServersSetting();
		const { entries } = parseServersSetting(rawSetting);
		this.prune(stillDeclaredIn(rawSetting));
		const thresholds = this.env.alertThresholds();
		const servers: UsageServerRefreshOutcome[] = [];
		for (const entry of entries) {
			if (this.disposed) {
				// An interrupted pass proves nothing; no caller may toast on it.
				return undefined;
			}
			const server = await this.refreshServer(entry, thresholds, force);
			if (server !== undefined) {
				servers.push(server);
			}
		}
		return this.disposed ? undefined : { servers };
	}

	/**
	 * Refresh one server's endpoints and store the result. Returns the pass's
	 * outcome for this server (what failed, whether anything answered), or
	 * undefined when nothing can be said truthfully: disposal interrupted the
	 * fetches, or the entry left the setting mid-pass.
	 */
	private async refreshServer(
		entry: DeclaredServer,
		thresholds: readonly number[],
		force: boolean
	): Promise<UsageServerRefreshOutcome | undefined> {
		const previous = this.store.get(entry.label);
		const failures: UsageEndpointFailure[] = [];
		let succeededAny = false;
		// Disposal aborts in-flight fetches; the interrupted attempt proves
		// nothing and must not read as a failed endpoint.
		const recordFailure = (endpoint: UsageEndpointId, error: unknown) => {
			if (!this.disposed) {
				failures.push(this.failureOf(endpoint, error));
			}
		};
		// A re-pointed entry is a different server: carried standings and data
		// would describe the old host, so both reset with the URL.
		const sameServer = previous !== undefined && normalizeBaseUrl(previous.baseUrl) === normalizeBaseUrl(entry.baseUrl);
		// A forced pass attempts immediately and restarts the failure count; a
		// re-pointed entry's streaks describe the old host.
		if (force || !sameServer) {
			this.errorStreaks.delete(entry.label);
		}
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
		let spendUpdatedAt = sameServer ? previous.spendUpdatedAt : undefined;
		const attemptAt = this.clock.now();

		let stored: StoredServerSecrets | undefined;
		let secretsUnreadable = false;
		try {
			stored = await this.env.readSecrets(entry.label);
		} catch (error) {
			// Skipped for this pass, like the sync engine's unreadable-secrets
			// branch: the next pass reads again, and the carried state keeps
			// rendering. The outcome flag lets an explicit refresh acknowledge it;
			// the error itself stays out of the toast.
			secretsUnreadable = true;
			this.env.log("Reading a server entry's stored secrets failed; usage refresh skipped", {
				label: entry.label,
				error: error instanceof Error ? error.name : typeof error,
			});
		}
		if (stored !== undefined) {
			const connection = usageConnectionFor(entry, stored);
			// The entries were snapshotted at the pass start and this entry's
			// secrets read just now, so an edit landing in between would pair a
			// stale entry with fresh credentials. Re-read the entry immediately
			// before the authenticated calls and compare the RESOLVED connection
			// (presence alone would still let a re-point send this credential to
			// the old host); on any difference the server is skipped and the
			// servers-change refresh probes the true pairing.
			const fresh = acceptedEntry(this.env.readServersSetting(), entry.label);
			if (fresh === undefined || !sameConnection(usageConnectionFor(fresh.entry, stored), connection)) {
				return undefined;
			}

			if (this.shouldAttempt(entry.label, "keyInfo", endpoints.keyInfo)) {
				try {
					key = await this.env.client.fetchKeyInfo(connection, this.abort.signal);
					endpoints.keyInfo = { kind: "ok" };
					succeededAny = true;
					this.clearStreak(entry.label, "keyInfo");
					lastUpdatedAt = this.clock.now();
					// The spend numbers' own age: only a /key/info success advances
					// it, so an activity success can never relabel old spend fresh.
					spendUpdatedAt = lastUpdatedAt;
				} catch (error) {
					recordFailure("keyInfo", error);
					endpoints.keyInfo = this.classifyFailure(entry.label, "keyInfo", logBaseline.keyInfo, error);
					this.trackFailure(entry.label, "keyInfo", endpoints.keyInfo);
					if (endpoints.keyInfo.kind === "unavailable") {
						key = undefined;
					}
				}
			}

			if (this.disposed) {
				return undefined;
			}
			if (this.shouldAttempt(entry.label, "dailyActivity", endpoints.dailyActivity)) {
				try {
					daily = await this.env.client.fetchDailyActivity(
						connection,
						activityWindow(this.clock.now(), USAGE_ACTIVITY_WINDOW_DAYS),
						this.abort.signal
					);
					endpoints.dailyActivity = { kind: "ok" };
					succeededAny = true;
					this.clearStreak(entry.label, "dailyActivity");
					lastUpdatedAt = this.clock.now();
				} catch (error) {
					recordFailure("dailyActivity", error);
					endpoints.dailyActivity = this.classifyFailure(
						entry.label,
						"dailyActivity",
						logBaseline.dailyActivity,
						error
					);
					this.trackFailure(entry.label, "dailyActivity", endpoints.dailyActivity);
					if (endpoints.dailyActivity.kind === "unavailable") {
						daily = undefined;
					}
				}
			}

			if (this.disposed) {
				return undefined;
			}
			// The rollup exists only for keys that carry a user. A key that
			// answered WITHOUT one also clears any carried rollup: after a
			// credential change the old rollup would describe another account.
			if (key !== undefined && !key.hasUser) {
				user = undefined;
			}
			if (endpoints.keyInfo.kind === "unavailable") {
				// No key answer means no proof the carried rollup still belongs to
				// this key.
				user = undefined;
			}
			if (key?.hasUser === true && this.shouldAttempt(entry.label, "userInfo", endpoints.userInfo)) {
				try {
					user = await this.env.client.fetchUserInfo(connection, this.abort.signal);
					endpoints.userInfo = { kind: "ok" };
					succeededAny = true;
					this.clearStreak(entry.label, "userInfo");
					lastUpdatedAt = this.clock.now();
				} catch (error) {
					recordFailure("userInfo", error);
					endpoints.userInfo = this.classifyFailure(entry.label, "userInfo", logBaseline.userInfo, error);
					this.trackFailure(entry.label, "userInfo", endpoints.userInfo);
					if (endpoints.userInfo.kind === "unavailable") {
						user = undefined;
					}
				}
			}
		}

		if (this.disposed) {
			return undefined;
		}
		// The pass snapshots the entries at its start, so a concurrent
		// applyServersChange may have pruned this label mid-fetch; writing the
		// state back would resurrect a server the "removed" event already
		// announced. Re-read presence at the last moment instead - presence, not
		// acceptance (stillDeclaredIn), so an entry the user is mid-edit
		// malforming keeps its refreshed state.
		if (!stillDeclaredIn(this.env.readServersSetting())(entry.label)) {
			return undefined;
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
		// Reset or all-failed standings can compute "unknown", which would
		// silently drop a card the user was looking at. Once this server proved
		// availability, only a permanent both-endpoints-unavailable verdict may
		// hide it again.
		const computedAvailability = usageAvailabilityOf(endpoints);
		const availability =
			computedAvailability === "unknown" && sameServer && previous.availability === "available"
				? "available"
				: computedAvailability;
		this.store.upsert(
			{
				label: entry.label,
				baseUrl: entry.baseUrl,
				endpoints,
				availability,
				lastUpdatedAt,
				spendUpdatedAt,
				lastAttemptAt: attemptAt,
				key,
				daily,
				user,
				budget,
			},
			newly
		);
		return { label: entry.label, failures, succeededAny, ...(secretsUnreadable ? { secretsUnreadable: true } : {}) };
	}

	/**
	 * The outcome record for one failed endpoint attempt: the classification
	 * data classifyFailure derives, for the refresh command's feedback path.
	 */
	private failureOf(endpoint: UsageEndpointId, error: unknown): UsageEndpointFailure {
		const reason = usageUnavailabilityOf(error);
		const status = error instanceof RequestError ? error.status : undefined;
		const classification = failureClassificationOf(error);
		return {
			endpoint,
			...(classification !== undefined ? { classification } : {}),
			...(status !== undefined ? { status } : {}),
			...(reason !== undefined ? { reason } : {}),
		};
	}

	/** Drop servers no longer declared from the store AND the backoff bookkeeping. */
	private prune(stillDeclared: (label: string) => boolean): void {
		this.store.prune(stillDeclared);
		for (const label of [...this.errorStreaks.keys()]) {
			if (!stillDeclared(label)) {
				this.errorStreaks.delete(label);
			}
		}
	}

	/**
	 * Whether a scheduled pass attempts this endpoint: never while it stands
	 * permanently unavailable, and not while an error streak's backoff window is
	 * still open - `interval * 2^min(failures - 1, cap)` since the last attempt.
	 * Forced passes never reach the streak check (refreshServer resets the
	 * streaks first), and a clock that jumped backwards fails open.
	 */
	private shouldAttempt(label: string, endpoint: UsageEndpointId, state: UsageEndpointState): boolean {
		if (state.kind === "unavailable") {
			return false;
		}
		if (state.kind !== "error") {
			return true;
		}
		const streak = this.errorStreaks.get(label)?.get(endpoint);
		if (streak === undefined) {
			return true;
		}
		const multiplier = backoffMultiplierOf(streak.failures);
		const intervalMs = this.env.pollIntervalMs();
		if (multiplier <= 1 || intervalMs <= 0) {
			return true;
		}
		const elapsedMs = this.clock.now() - streak.lastAttemptAt;
		return elapsedMs < 0 || elapsedMs >= intervalMs * multiplier;
	}

	/**
	 * Record a failed endpoint attempt's effect on its backoff streak, logging
	 * exactly one line per multiplier escalation (skipped attempts never log).
	 * An unavailable verdict ends the streak: those endpoints are sticky-skipped,
	 * not backed off.
	 */
	private trackFailure(label: string, endpoint: UsageEndpointId, state: UsageEndpointState): void {
		if (this.disposed) {
			// An aborted attempt proves nothing; it must not lengthen the backoff.
			return;
		}
		if (state.kind !== "error") {
			this.errorStreaks.get(label)?.delete(endpoint);
			return;
		}
		let streaks = this.errorStreaks.get(label);
		if (streaks === undefined) {
			streaks = new Map();
			this.errorStreaks.set(label, streaks);
		}
		const failures = (streaks.get(endpoint)?.failures ?? 0) + 1;
		streaks.set(endpoint, { failures, lastAttemptAt: this.clock.now() });
		const multiplier = backoffMultiplierOf(failures);
		if (multiplier > backoffMultiplierOf(failures - 1)) {
			this.env.log("Usage endpoint failing repeatedly; scheduled attempts backing off", {
				label,
				endpoint,
				multiplier,
			});
		}
	}

	/** A success ends the endpoint's streak; leaving an engaged backoff logs one recovery line. */
	private clearStreak(label: string, endpoint: UsageEndpointId): void {
		if (this.disposed) {
			// A success racing disposal proves nothing the pass can keep, and a
			// cancellation path must not log.
			return;
		}
		const streaks = this.errorStreaks.get(label);
		const streak = streaks?.get(endpoint);
		if (streaks === undefined || streak === undefined) {
			return;
		}
		streaks.delete(endpoint);
		if (backoffMultiplierOf(streak.failures) > 1) {
			this.env.log("Usage endpoint recovered; backoff cleared", { label, endpoint });
		}
	}

	/**
	 * Classify one endpoint failure into its next standing, logging exactly one
	 * info-level line per state TRANSITION (a server answering 404 every probe
	 * must not write a line per poll). English classifications only - never
	 * message text. The returned standing carries the same status and closed
	 * vocabulary, so the dashboard card can say why its numbers are stuck.
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
			return { kind: "unavailable", reason, ...(status !== undefined ? { status } : {}) };
		}
		if (previous.kind !== "error") {
			this.env.log("Usage endpoint request failed; retrying on the next poll", {
				label,
				endpoint,
				error: error instanceof Error ? error.name : typeof error,
				...(status !== undefined ? { status } : {}),
			});
		}
		const classification = failureClassificationOf(error);
		return {
			kind: "error",
			...(classification !== undefined ? { classification } : {}),
			...(status !== undefined ? { status } : {}),
		};
	}
}

/**
 * The closed failure vocabulary for a transient endpoint error, judged from
 * the thrown error's own classification (never its message): undefined for
 * anything that is not a classified transport error. Exhaustive over the
 * transport kinds so a new kind is a compile error here, not a silent "http".
 */
function failureClassificationOf(error: unknown): UsageFailureClassification | undefined {
	if (!(error instanceof RequestError)) {
		return undefined;
	}
	switch (error.kind) {
		case "timeout":
			return "timeout";
		// The server never answered; the OAuth token exchange surfaces these too.
		case "network":
		case "connection":
		case "certificate":
			return "network";
		// "auth" and "http" mean the server answered; the status says how.
		// "aborted" is not a network signal either, so it keeps the same arm.
		case "auth":
		case "http":
		case "aborted":
			return "http";
	}
}
