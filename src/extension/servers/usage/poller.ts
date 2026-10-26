/**
 * The usage polling engine: keeps the UsageStore in step with the declared servers, headless (alerts must fire without
 * the dashboard open). Log discipline: one info-level English classification per endpoint state transition (labels,
 * endpoint ids, reasons, error names - never response-derived text, which for usage payloads includes hashed keys).
 *
 *   0 disables polling entirely -> no background requests
 *   refreshNow                  -> still works
 */

import { isDeepStrictEqual } from "node:util";
import * as l10n from "@vscode/l10n";
import type { UsageEndpointId } from "../../../dashboard/usageEndpoints";
import { USAGE_ENDPOINT_PATHS } from "../../../dashboard/usageEndpoints";
import { RequestError } from "../../../provider/transport/transportErrors";
import { NUMBER_SETTING_SPECS } from "../../../shared/config/settingSpec";
import { rejectedCredentialKinds } from "../../../shared/failureCause";
import type { RejectedCredentialField } from "../../../shared/serverEntry";
import { normalizeBaseUrl } from "../../../shared/util/baseUrl";
import { errorLabel } from "../../../shared/util/errorLabel";
import type { Clock, Timer } from "../../../shared/util/timer";
import { PendingCall, REAL_TIMER, SYSTEM_CLOCK } from "../../../shared/util/timer";
import { buildGroupArgs } from "../serverSync/engine";
import type { StoredSecretsRecord, StoredServerSecrets } from "../serverSync/secrets";
import { resolveOwnedSecrets } from "../serverSync/secrets";
import type { DeclaredServer } from "../serverSync/setting";
import { acceptedEntry, parseServersSetting, stillDeclaredIn } from "../serverSync/setting";
import type { BudgetStatus } from "./budget";
import { newlyCrossedThresholds, resolveBudget } from "./budget";
import type {
	ActivityWindow,
	DailyUsage,
	KeyUsage,
	UsageConnection,
	UsageConnectionResolution,
	UserUsage,
} from "./spendClient";
import { activityWindow, usageConnectionFor, usageUnavailabilityOf } from "./spendClient";
import type {
	ServerUsageState,
	UsageAvailability,
	UsageEndpointState,
	UsageEndpointStates,
	UsageFailureClassification,
} from "./store";
import { UNPROBED_ENDPOINTS, UsageStore, usageAvailabilityOf } from "./store";

/** How many calendar days the daily-activity window reaches back (today included). */
export const USAGE_ACTIVITY_WINDOW_DAYS = 30;

/** Caps the error backoff at 2^4 = 16x the poll interval (80 minutes at the default 5-minute cadence). */
const BACKOFF_MAX_EXPONENT = 4;

function backoffMultiplierOf(failures: number): number {
	return failures <= 1 ? 1 : 2 ** Math.min(failures - 1, BACKOFF_MAX_EXPONENT);
}

interface EndpointFailureStreak {
	readonly failures: number;
	readonly lastAttemptAt: number;
}

export interface UsageFetchClient {
	fetchKeyInfo(connection: UsageConnection, signal?: AbortSignal): Promise<KeyUsage>;
	fetchDailyActivity(connection: UsageConnection, window: ActivityWindow, signal?: AbortSignal): Promise<DailyUsage>;
	fetchUserInfo(connection: UsageConnection, signal?: AbortSignal): Promise<UserUsage>;
}

/** Everything the poller touches, injected; createUsagePollerEnv builds the real one. */
export interface UsagePollerEnv {
	readServersSetting(): unknown;

	readSecrets(label: string): Promise<StoredSecretsRecord>;

	readonly client: UsageFetchClient;

	/** Read at decision time so a setting edit needs no rebuild; 0 means polling is off. */
	pollIntervalMs(): number;

	/** The delay from start() to the first pass (usage.initialRefreshDelay): soon, but never on the activation path. */
	initialRefreshDelayMs?(): number;

	/**
	 * The refresh delay after a servers-setting change (usage.serversChangeRefreshDelay): long enough to coalesce
	 * settings.json keystroke bursts, short enough that a just-added server shows usage promptly.
	 */
	serversChangeRefreshDelayMs?(): number;

	alertThresholds(): readonly number[];

	log(message: string, data?: unknown): void;

	readonly timer?: Timer;

	readonly clock?: Clock;
}

/**
 * One endpoint attempt that failed during an explicit refresh pass, as classification data only - never message text.
 * Feeds the refresh command's failure toast; never written to the log.
 */
export interface UsageEndpointFailure {
	readonly endpoint: UsageEndpointId;
	readonly classification?: UsageFailureClassification | undefined;
	readonly status?: number | undefined;
	readonly reason?: "unsupported" | "forbidden" | undefined;
}

/**
 * One server's share of a refresh pass, for the refresh command's toast. Each optional flag means the pass never
 * reached the network: `secretsUnreadable` when the entry's stored secrets could not be read, `secretsMismatched`
 * when a stored secret is stamped for a different destination (resolveOwnedSecrets), and `credentialsRefused` when a
 * configured key cannot ride its header (usageConnectionFor), naming the fields for the toast and never a value.
 */
export interface UsageServerRefreshOutcome {
	readonly label: string;
	readonly failures: readonly UsageEndpointFailure[];
	readonly succeededAny: boolean;
	readonly secretsUnreadable?: true | undefined;
	readonly secretsMismatched?: true | undefined;
	readonly credentialsRefused?: readonly [RejectedCredentialField, ...RejectedCredentialField[]] | undefined;
}

export interface UsageRefreshOutcome {
	readonly servers: readonly UsageServerRefreshOutcome[];
}

/**
 * The closed failure vocabulary for a transient endpoint error, judged from the thrown error's own classification
 * (never its message): undefined for anything that is not a classified transport error. Exhaustive over the transport
 * kinds so a new kind is a compile error here, not a silent "http".
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
		// "auth" and "http" mean the server answered; the status says how. "aborted" is not a network signal either, so
		// it keeps the same arm.
		case "auth":
		case "http":
		case "aborted":
			return "http";
	}
}

/** The standing of a transient failure: the closed classification when the error carries one, the status when known. */
function errorStanding(error: unknown, status: number | undefined): UsageEndpointState {
	const classification = failureClassificationOf(error);
	return {
		kind: "error",
		...(classification === undefined ? {} : { classification }),
		...(status === undefined ? {} : { status }),
	};
}

/** The word for how an endpoint failed: its HTTP status when it answered, else the classification's word. */
function failureWord(failure: UsageEndpointFailure): string {
	if (failure.status !== undefined) {
		return String(failure.status);
	}
	if (failure.classification === "timeout") {
		return l10n.t("timeout");
	}
	if (failure.classification === "network") {
		return l10n.t("network error");
	}
	return l10n.t("failed");
}

/** "unsupported" never reaches the toast (actionableFailureText filters it), so only "forbidden" has a word. */
function describeEndpointFailure(failure: UsageEndpointFailure): string {
	const how = failureWord(failure);
	const reason = failure.reason === "forbidden" ? ` ${l10n.t("forbidden")}` : "";
	return `${USAGE_ENDPOINT_PATHS[failure.endpoint]} ${how}${reason}`;
}

/**
 * "unsupported" is a documented normal shape (a DB-less proxy answers 400/404 forever), so a server whose only failures
 * are unsupported endpoints must never trip the toast; an unreadable secrets blob means the refresh never reached the
 * network at all.
 */
function actionableFailureText(server: UsageServerRefreshOutcome): string | undefined {
	if (server.secretsUnreadable === true) {
		return l10n.t("{0}: stored secrets unreadable", server.label);
	}
	if (server.secretsMismatched === true) {
		return l10n.t("{0}: a stored secret belongs to a different server address", server.label);
	}
	if (server.credentialsRefused !== undefined) {
		return l10n.t(
			"{0}: the stored {1} cannot be sent as an HTTP header",
			server.label,
			rejectedCredentialKinds(server.credentialsRefused).display
		);
	}
	const failures = server.failures.filter((failure) => failure.reason !== "unsupported");
	if (failures.length === 0) {
		return undefined;
	}
	return l10n.t("{0}: {1}", server.label, failures.map(describeEndpointFailure).join(", "));
}

/**
 * Template-only by construction: labels, endpoint paths, status numbers, and fixed vocabulary, every word of it
 * localized (the text is a user toast, vscodeEnv.ts).
 *
 *   partial failures and all-unsupported servers -> stay toast-free
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

/** One server's refresh in progress: what it carries from the stored state and what the probes have settled so far. */
interface ServerRefresh {
	readonly entry: DeclaredServer;
	readonly endpoints: Record<UsageEndpointId, UsageEndpointState>;
	readonly logBaseline: UsageEndpointStates;
	readonly failures: UsageEndpointFailure[];
	succeededAny: boolean;
	lastUpdatedAt: number | undefined;
}

/** What one endpoint probe left behind: the value this probe fetched, or the carried one when it did not fetch. */
type ProbedValue<T> =
	| { readonly fetched: true; readonly value: T }
	| { readonly fetched: false; readonly value: T | undefined };

/**
 * The data a server's refresh holds: the key probe's result, the daily and user readings, and the spend numbers'
 * age.
 */
interface ProbedData {
	readonly key: ProbedValue<KeyUsage>;
	readonly daily: DailyUsage | undefined;
	readonly user: UserUsage | undefined;
	readonly spendUpdatedAt: number | undefined;
}

/** The stored secrets a refresh may probe with, or why it may not: the blob was unreadable or stamped for another destination. */
type ProbeSecrets =
	| { readonly kind: "stored"; readonly stored: StoredServerSecrets }
	| { readonly kind: "unreadable" | "mismatched" };

/**
 * The budget to store and the thresholds newly crossed. Alerts evaluate on fetches only (docs/usage.md), the contract
 * applyConfiguration keeps by leaving stored crossings alone, so a threshold edit toasts on the next fetch and never
 * from cached data.
 *
 *   key fetched       -> diff against the stored crossings
 *   key carried       -> crossings kept, nothing newly crossed (unreadable secrets, backoff, a failed call)
 *   re-pointed entry  -> clean slate: the old crossings belong to another server
 */
function budgetAfterProbe(
	entry: DeclaredServer,
	carriedFrom: ServerUsageState | undefined,
	key: ProbedValue<KeyUsage>,
	thresholds: readonly number[]
): { budget: BudgetStatus; newly: readonly number[] } {
	const resolved = resolveBudget({
		entryBudget: entry.budget,
		keyBudget: key.value?.maxBudget,
		spend: key.value?.spend,
		budgetResetAt: key.value?.budgetResetAt,
		thresholds,
	});
	const budget =
		key.fetched || carriedFrom === undefined
			? resolved
			: { ...resolved, crossedThresholds: carriedFrom.budget.crossedThresholds };
	const crossedBefore = carriedFrom === undefined ? [] : carriedFrom.budget.crossedThresholds;
	const newly = key.fetched ? newlyCrossedThresholds(crossedBefore, budget.crossedThresholds) : [];
	return { budget, newly };
}

/**
 * The card-visibility verdict to store. Reset or all-failed standings can compute "unknown", which would silently drop
 * a card the user was looking at: once this server proved availability, only a permanent both-endpoints-unavailable
 * verdict may hide it again.
 */
function availabilityAfterProbe(
	endpoints: UsageEndpointStates,
	carriedFrom: ServerUsageState | undefined
): UsageAvailability {
	const computed = usageAvailabilityOf(endpoints);
	if (computed === "unknown" && carriedFrom?.availability === "available") {
		return "available";
	}
	return computed;
}

/**
 * The refresh frame for one server and the data it starts from: the carried standings and readings, or fresh ones for
 * a new, re-pointed, or forced probe. The log-transition baseline is the server's real previous standings, NOT the
 * force-reset probe states, so an explicit re-probe of a still-broken server does not re-log its classification.
 */
function startRefresh(
	entry: DeclaredServer,
	force: boolean,
	carriedFrom: ServerUsageState | undefined
): { refresh: ServerRefresh; data: ProbedData } {
	const carriedEndpoints = force || carriedFrom === undefined ? UNPROBED_ENDPOINTS : carriedFrom.endpoints;
	const refresh: ServerRefresh = {
		entry,
		endpoints: { ...carriedEndpoints },
		logBaseline: carriedFrom?.endpoints ?? UNPROBED_ENDPOINTS,
		failures: [],
		succeededAny: false,
		lastUpdatedAt: carriedFrom?.lastUpdatedAt,
	};
	const data: ProbedData = {
		key: { value: carriedFrom?.key, fetched: false },
		daily: carriedFrom?.daily,
		user: carriedFrom?.user,
		spendUpdatedAt: carriedFrom?.spendUpdatedAt,
	};
	return { refresh, data };
}

/** The pass's outcome for one server: what failed, whether anything answered, and why a probe was skipped. */
function refreshOutcome(
	refresh: ServerRefresh,
	secrets: ProbeSecrets,
	credentialsRefused: UsageServerRefreshOutcome["credentialsRefused"]
): UsageServerRefreshOutcome {
	const outcome: { -readonly [K in keyof UsageServerRefreshOutcome]: UsageServerRefreshOutcome[K] } = {
		label: refresh.entry.label,
		failures: refresh.failures,
		succeededAny: refresh.succeededAny,
	};
	if (secrets.kind === "unreadable") {
		outcome.secretsUnreadable = true;
	}
	if (secrets.kind === "mismatched") {
		outcome.secretsMismatched = true;
	}
	if (credentialsRefused !== undefined) {
		outcome.credentialsRefused = credentialsRefused;
	}
	return outcome;
}

/**
 * Polls each declared server's usage endpoints and publishes the results through `store`. The per-endpoint failure
 * streaks and the token-retry grants live here rather than in the store, deliberately: no carried store state can
 * then replay a stale backoff. A usage 401 on an OAuth connection earns exactly one fresh-token retry, since a bearer
 * the server has revoked is rejected exactly like a key never allowed to read usage, and the client drops the rejected
 * token on that answer (authOverlay.ts), so the next attempt exchanges afresh.
 *
 *   usage 401, retry not yet granted   -> transient standing; granted
 *   usage 401, retry already granted   -> forbidden: the fresh token was rejected too
 *   the endpoint succeeds              -> the grant is forgotten
 *   OAuth beside a virtual key owning Authorization (no token sent) -> one extra poll before the same verdict
 */
export class UsagePoller {
	readonly store: UsageStore;

	private readonly refreshListeners = new Set<() => void>();

	private readonly startListeners = new Set<() => void>();

	private readonly scheduled: PendingCall;

	private readonly clock: Clock;

	private readonly abort = new AbortController();

	private running: Promise<UsageRefreshOutcome | undefined> | undefined;

	private runningExplicit = false;

	private queued:
		| {
				force: boolean;
				explicit: boolean;
				promise: Promise<UsageRefreshOutcome | undefined>;
				resolve: (outcome: UsageRefreshOutcome | undefined) => void;
		  }
		| undefined;

	private lastCompletedPassAt: number | undefined;

	private probePending = false;

	private readonly errorStreaks = new Map<string, Map<UsageEndpointId, EndpointFailureStreak>>();

	private readonly tokenRetryGranted = new Map<string, Set<UsageEndpointId>>();

	private disposed = false;

	constructor(private readonly env: UsagePollerEnv) {
		this.store = new UsageStore(env.log);
		this.scheduled = new PendingCall(env.timer ?? REAL_TIMER);
		this.clock = env.clock ?? SYSTEM_CLOCK;
	}

	start(): void {
		this.schedule(this.initialRefreshDelayMs());
	}

	private initialRefreshDelayMs(): number {
		return this.env.initialRefreshDelayMs?.() ?? NUMBER_SETTING_SPECS["usage.initialRefreshDelay"].default;
	}

	private serversChangeRefreshDelayMs(): number {
		return this.env.serversChangeRefreshDelayMs?.() ?? NUMBER_SETTING_SPECS["usage.serversChangeRefreshDelay"].default;
	}

	isRefreshing(): boolean {
		return this.running !== undefined;
	}

	/**
	 * Whether the pass in flight (or queued behind one) was explicitly requested - the palette command or a dashboard
	 * Refresh now. Scheduled polls, backoff retries, servers-change probes, and open-triggered staleness passes all
	 * stay false, so the Refresh-now button wears its busy label only for work that button was asked to do.
	 */
	isRefreshingExplicitly(): boolean {
		return (this.running !== undefined && this.runningExplicit) || this.queued?.explicit === true;
	}

	onDidRefresh(listener: () => void): { dispose(): void } {
		this.refreshListeners.add(listener);
		return { dispose: () => this.refreshListeners.delete(listener) };
	}

	/**
	 * Notified when a refresh pass STARTS, per-listener isolated; the dashboard re-pushes on it so an open panel's
	 * Refresh now disables the moment ANY pass begins, scheduled polls included.
	 */
	onDidStartRefresh(listener: () => void): { dispose(): void } {
		this.startListeners.add(listener);
		return { dispose: () => this.startListeners.delete(listener) };
	}

	/**
	 * Re-read the poll interval after a configuration change: rewires the pending tick (interval 0 cancels it
	 * outright).
	 */
	applyConfiguration(): void {
		this.schedule(this.nextTickDelayMs());
	}

	/**
	 * React to a servers-setting change: drop servers whose label left the setting, and re-probe availability for the
	 * rest (an edited entry may point at a different proxy or carry new credentials). Removal is presence, not
	 * acceptance (the sync engine's rule, via stillDeclaredIn): a mid-edit malformed entry keeps its state, standings,
	 * and crossings, so repairing it cannot re-fire already-shown alerts.
	 */
	applyServersChange(): void {
		this.prune(stillDeclaredIn(this.env.readServersSetting()));
		this.probePending = true;
		if (this.env.pollIntervalMs() > 0) {
			this.schedule(this.serversChangeRefreshDelayMs());
		}
	}

	/**
	 * Serialized with any pass in flight (a call during one queues exactly one follow-up and resolves after it). Never
	 * rejects; resolves with the pass's per-server outcomes, or undefined when the poller was disposed before the pass
	 * completed (cancellation must stay silent).
	 */
	refreshNow(): Promise<UsageRefreshOutcome | undefined> {
		return this.refresh(true, true);
	}

	/**
	 * The dashboard-open refresh: one pass only when the stored numbers are stale - no completed pass yet this session,
	 * or the last one older than the effective poll interval (the interval's spec default is the staleness floor while
	 * polling is off).
	 *
	 * Forced like an explicit refresh but NOT explicit, so the Refresh-now button stays quiet.
	 */
	refreshIfStale(): Promise<UsageRefreshOutcome | undefined> | undefined {
		if (this.disposed) {
			return undefined;
		}
		//   the stored numbers may describe servers or credentials that no longer exist
		//     -> a pending availability probe (the servers setting changed) overrides every freshness reading
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
		// A queued follow-up will never run; its waiters must still settle - with no outcome, so no waiter mistakes
		// disposal for a failed refresh.
		this.queued?.resolve(undefined);
		this.queued = undefined;
	}

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
		// Checked here, not only in the pass: the teardown detaches a queued follow-up before the completion listeners
		// run, so a listener that disposes the poller leaves nothing for dispose() to settle, and this guard is what
		// stops that follow-up starting a pass after disposal.
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
					error: errorLabel(error),
				});
			}
		}
		try {
			return await this.running;
		} finally {
			this.running = undefined;
			this.runningExplicit = false;
			// The queued follow-up detaches BEFORE the completion listeners run: isRefreshingExplicitly reads the
			// queue, and a listener firing with one still attached would publish "idle but explicitly refreshing".
			const queued = this.queued;
			this.queued = undefined;
			// Completion is announced AFTER the engine reads idle, so a listener that re-publishes engine state reports
			// the button re-enabled instead of freezing it on a stale "in flight".
			for (const listener of this.refreshListeners) {
				try {
					listener();
				} catch (error) {
					this.env.log("Usage refresh listener failed", { error: errorLabel(error) });
				}
			}
			if (queued !== undefined) {
				void this.refresh(queued.force, queued.explicit).then(queued.resolve, () => queued.resolve(undefined));
			}
		}
	}

	private async runOnce(force: boolean): Promise<UsageRefreshOutcome | undefined> {
		if (force) {
			// A forced pass -> satisfies any pending servers-change probe
			this.probePending = false;
		}
		let outcome: UsageRefreshOutcome | undefined;
		try {
			outcome = await this.runPass(force);
		} catch (error) {
			// Never rethrown: refreshes run from timers and commands.
			this.env.log("Usage refresh pass failed", { error: errorLabel(error) });
		}
		if (outcome !== undefined) {
			// Only a pass that ran to completion counts for staleness; an interrupted one proved nothing. A pass whose
			// servers all FAILED still counts - the numbers are as fresh as the fleet allows.
			this.lastCompletedPassAt = this.clock.now();
		}
		// Rescheduled at every exit so the cadence survives pass failures; a mid-pass interval edit is honored here. A
		// probe that became pending while this pass ran must not be postponed to the full interval, so the delay honors
		// it (see nextTickDelayMs).
		this.schedule(this.nextTickDelayMs());
		return outcome;
	}

	/**
	 * The delay to the next scheduled tick: the prompt servers-change delay while a re-probe is pending (any reschedule
	 * would otherwise cancel the timer applyServersChange set and postpone the probe by a full interval), the
	 * configured interval otherwise.
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
	 * The stored state this refresh carries, or undefined for a new or re-pointed entry. A re-pointed entry is a
	 * different server: carried standings and data would describe the old host, so both reset with the URL, along with
	 * its failure streaks and token-retry grant. A forced pass also restarts the failure count.
	 */
	private carriedState(entry: DeclaredServer, force: boolean): ServerUsageState | undefined {
		const previous = this.store.get(entry.label);
		const sameServer = previous !== undefined && normalizeBaseUrl(previous.baseUrl) === normalizeBaseUrl(entry.baseUrl);
		if (force || !sameServer) {
			this.errorStreaks.delete(entry.label);
		}
		if (!sameServer) {
			this.tokenRetryGranted.delete(entry.label);
		}
		return sameServer ? previous : undefined;
	}

	/**
	 * Reads the entry's stored secrets for the probe, the same ownership check the sync engine applies at its read
	 * boundary: a stored value stamped for a different destination must never ride an authenticated probe to this
	 * entry's host. A refused or unreadable blob skips the probe for this pass (probing without the credential would
	 * only manufacture 401 noise; the next pass reads again), the carried state keeps rendering, and the sync engine's
	 * view carries the actionable text. The outcome flags let an explicit refresh acknowledge the skip while the error
	 * itself stays out of the toast.
	 */
	private async probeSecrets(entry: DeclaredServer): Promise<ProbeSecrets> {
		try {
			const owned = resolveOwnedSecrets(entry, await this.env.readSecrets(entry.label));
			if (owned.refused.length > 0) {
				this.env.log("A stored secret is stamped for a different destination; usage refresh skipped", {
					label: entry.label,
					fields: owned.refused,
				});
				return { kind: "mismatched" };
			}
			return { kind: "stored", stored: owned.values };
		} catch (error) {
			this.env.log("Reading a server entry's stored secrets failed; usage refresh skipped", {
				label: entry.label,
				error: errorLabel(error),
			});
			return { kind: "unreadable" };
		}
	}

	/**
	 * The connection the probe sends with, the refusal when a configured key cannot ride its header, or undefined when
	 * the entry changed mid-pass. The entries were snapshotted at the pass start and this entry's secrets read just now,
	 * so an edit landing in between would pair a stale entry with fresh credentials, or report a stale entry's refusal:
	 * the entry is re-read before anything is probed, written, or reported and compared by host AND by RESOLUTION (a
	 * refusal carries no host, and presence alone would still let a re-point send this credential to the old host); on
	 * any difference the server is skipped and the servers-change refresh probes the true pairing. A refused key is
	 * skipped like a mismatched stamp: a keyless probe would only manufacture a 401 to render, and the sync engine's
	 * view carries the actionable text.
	 */
	private probeConnection(entry: DeclaredServer, stored: StoredServerSecrets): UsageConnectionResolution | undefined {
		const resolution = usageConnectionFor(entry, buildGroupArgs(entry, stored));
		const fresh = acceptedEntry(this.env.readServersSetting(), entry.label);
		if (
			fresh === undefined ||
			fresh.entry.baseUrl !== entry.baseUrl ||
			!isDeepStrictEqual(usageConnectionFor(fresh.entry, buildGroupArgs(fresh.entry, stored)), resolution)
		) {
			return undefined;
		}
		if (resolution.kind !== "resolved") {
			this.env.log("A configured key cannot be sent as an HTTP header; usage refresh skipped", {
				label: entry.label,
				fields: resolution.fields,
			});
		}
		return resolution;
	}

	/**
	 * Probes one endpoint when its standing allows and records the outcome on the refresh: a success marks the endpoint
	 * ok and advances the update time, a failure is classified and tracked. Returns the value to hold afterwards: the
	 * fetched one, the carried one when the probe was skipped or failed transiently, or nothing once the endpoint stands
	 * unavailable. Disposal aborts in-flight fetches; the interrupted attempt proves nothing and must not read as a
	 * failed endpoint.
	 */
	private async probeValue<T>(
		refresh: ServerRefresh,
		connection: UsageConnection,
		endpoint: UsageEndpointId,
		carried: T | undefined,
		fetch: () => Promise<T>
	): Promise<ProbedValue<T>> {
		const label = refresh.entry.label;
		if (!this.shouldAttempt(label, endpoint, refresh.endpoints[endpoint])) {
			return { value: carried, fetched: false };
		}
		try {
			const value = await fetch();
			refresh.endpoints[endpoint] = { kind: "ok" };
			refresh.succeededAny = true;
			this.endpointSucceeded(label, endpoint);
			refresh.lastUpdatedAt = this.clock.now();
			return { value, fetched: true };
		} catch (error) {
			if (!this.disposed) {
				refresh.failures.push(this.failureOf(endpoint, error));
			}
			const standing = this.classifyFailure(label, endpoint, refresh.logBaseline[endpoint], error, connection);
			refresh.endpoints[endpoint] = standing;
			this.trackFailure(label, endpoint, standing);
			return { value: standing.kind === "unavailable" ? undefined : carried, fetched: false };
		}
	}

	/**
	 * Runs the three probes and returns the data to hold afterwards, or undefined when disposal interrupted them. The
	 * spend numbers' own age advances only on a /key/info success, so an activity success can never relabel old spend
	 * fresh. The user rollup exists only for keys that carry a user: a key that answered WITHOUT one clears any carried
	 * rollup (after a credential change the old rollup would describe another account), and no key answer means no
	 * proof the carried rollup still belongs to this key.
	 */
	private async probeEndpoints(
		refresh: ServerRefresh,
		connection: UsageConnection,
		carried: ProbedData
	): Promise<ProbedData | undefined> {
		const signal = this.abort.signal;
		const key = await this.probeValue(refresh, connection, "keyInfo", carried.key.value, () =>
			this.env.client.fetchKeyInfo(connection, signal)
		);
		const spendUpdatedAt = key.fetched ? refresh.lastUpdatedAt : carried.spendUpdatedAt;
		if (this.disposed) {
			return undefined;
		}
		const daily = await this.probeValue(refresh, connection, "dailyActivity", carried.daily, () =>
			this.env.client.fetchDailyActivity(
				connection,
				activityWindow(this.clock.now(), USAGE_ACTIVITY_WINDOW_DAYS),
				signal
			)
		);
		if (this.disposed) {
			return undefined;
		}
		let user = carried.user;
		if ((key.value !== undefined && !key.value.hasUser) || refresh.endpoints.keyInfo.kind === "unavailable") {
			user = undefined;
		}
		if (key.value?.hasUser === true) {
			const probed = await this.probeValue(refresh, connection, "userInfo", user, () =>
				this.env.client.fetchUserInfo(connection, signal)
			);
			user = probed.value;
		}
		return { key, daily: daily.value, user, spendUpdatedAt };
	}

	/**
	 * Returns the pass's outcome for this server (what failed, whether anything answered), or undefined when nothing
	 * can be said truthfully: disposal interrupted the fetches, or the entry left the setting mid-pass.
	 */
	private async refreshServer(
		entry: DeclaredServer,
		thresholds: readonly number[],
		force: boolean
	): Promise<UsageServerRefreshOutcome | undefined> {
		const carriedFrom = this.carriedState(entry, force);
		const { refresh, data: carried } = startRefresh(entry, force, carriedFrom);
		let data = carried;
		const attemptAt = this.clock.now();

		const secrets = await this.probeSecrets(entry);
		let credentialsRefused: UsageServerRefreshOutcome["credentialsRefused"];
		if (secrets.kind === "stored") {
			const resolution = this.probeConnection(entry, secrets.stored);
			if (resolution === undefined) {
				return undefined;
			}
			if (resolution.kind === "resolved") {
				const probed = await this.probeEndpoints(refresh, resolution.connection, data);
				if (probed === undefined) {
					return undefined;
				}
				data = probed;
			} else {
				credentialsRefused = resolution.fields;
			}
		}

		if (this.disposed) {
			return undefined;
		}
		// The pass snapshots the entries at its start, so a concurrent applyServersChange may have pruned this label
		// mid-fetch; writing the state back would resurrect a server the "removed" event already announced. Re-read
		// presence at the last moment instead - presence, not acceptance (stillDeclaredIn), so an entry the user is
		// mid-edit malforming keeps its refreshed state.
		if (!stillDeclaredIn(this.env.readServersSetting())(entry.label)) {
			return undefined;
		}
		const { budget, newly } = budgetAfterProbe(entry, carriedFrom, data.key, thresholds);
		this.store.upsert(
			{
				label: entry.label,
				baseUrl: entry.baseUrl,
				endpoints: refresh.endpoints,
				availability: availabilityAfterProbe(refresh.endpoints, carriedFrom),
				lastUpdatedAt: refresh.lastUpdatedAt,
				spendUpdatedAt: data.spendUpdatedAt,
				lastAttemptAt: attemptAt,
				key: data.key.value,
				daily: data.daily,
				user: data.user,
				budget,
			},
			newly
		);
		return refreshOutcome(refresh, secrets, credentialsRefused);
	}

	private failureOf(endpoint: UsageEndpointId, error: unknown): UsageEndpointFailure {
		const reason = usageUnavailabilityOf(error);
		const status = error instanceof RequestError ? error.status : undefined;
		const classification = failureClassificationOf(error);
		return {
			endpoint,
			...(classification === undefined ? {} : { classification }),
			...(status === undefined ? {} : { status }),
			...(reason === undefined ? {} : { reason }),
		};
	}

	private prune(stillDeclared: (label: string) => boolean): void {
		this.store.prune(stillDeclared);
		for (const memory of [this.errorStreaks, this.tokenRetryGranted]) {
			for (const label of [...memory.keys()]) {
				if (!stillDeclared(label)) {
					memory.delete(label);
				}
			}
		}
	}

	/** Records the grant; false while this endpoint's retry stands granted and no success has cleared it. */
	private grantTokenRetry(label: string, endpoint: UsageEndpointId): boolean {
		let granted = this.tokenRetryGranted.get(label);
		if (granted === undefined) {
			granted = new Set();
			this.tokenRetryGranted.set(label, granted);
		}
		if (granted.has(endpoint)) {
			return false;
		}
		granted.add(endpoint);
		return true;
	}

	/**
	 * Whether a scheduled pass attempts this endpoint: never while it stands permanently unavailable, and not while an
	 * error streak's backoff window is still open - `interval * 2^min(failures - 1, cap)` since the last attempt.
	 * Forced passes never reach the streak check (refreshServer resets the streaks first), and a clock that jumped
	 * backwards fails open.
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
	 * Record a failed endpoint attempt's effect on its backoff streak, logging exactly one line per multiplier
	 * escalation (skipped attempts never log). An unavailable verdict ends the streak: those endpoints are
	 * sticky-skipped, not backed off.
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

	/** A success ends the endpoint's backoff streak and restores its fresh-token retry. */
	private endpointSucceeded(label: string, endpoint: UsageEndpointId): void {
		if (this.disposed) {
			// A success racing disposal proves nothing the pass can keep, and a cancellation path must not log.
			return;
		}
		this.tokenRetryGranted.get(label)?.delete(endpoint);
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

	/** The sticky standing of an endpoint the server does not serve, logged once per transition into it. */
	private unavailableStanding(
		previous: UsageEndpointState,
		failure: {
			label: string;
			endpoint: UsageEndpointId;
			reason: "unsupported" | "forbidden";
			status: number | undefined;
		}
	): UsageEndpointState {
		const { label, endpoint, reason, status } = failure;
		if (previous.kind !== "unavailable") {
			this.env.log("Usage endpoint unavailable on this server; not retried until an explicit refresh", {
				label,
				endpoint,
				reason,
				...(status === undefined ? {} : { status }),
			});
		}
		return { kind: "unavailable", reason, ...(status === undefined ? {} : { status }) };
	}

	/**
	 * Classify one endpoint failure into its next standing, logging exactly one info-level line per state TRANSITION (a
	 * server answering 404 every probe must not write a line per poll).
	 *
	 * The returned standing carries the same status and closed vocabulary, so the dashboard card can say why its
	 * numbers are stuck.
	 */
	private classifyFailure(
		label: string,
		endpoint: UsageEndpointId,
		previous: UsageEndpointState,
		error: unknown,
		connection: UsageConnection
	): UsageEndpointState {
		if (this.disposed) {
			// Disposal aborts in-flight fetches; a cancellation is never logged or classified, and the standing it
			// interrupted stays put.
			return previous;
		}
		const reason = usageUnavailabilityOf(error);
		const status = error instanceof RequestError ? error.status : undefined;
		if (
			reason === "forbidden" &&
			status === 401 &&
			connection.oauth !== undefined &&
			this.grantTokenRetry(label, endpoint)
		) {
			this.env.log(
				"Usage endpoint answered 401 on an OAuth connection; one more attempt before it stands as forbidden",
				{
					label,
					endpoint,
				}
			);
			return { kind: "error", classification: failureClassificationOf(error), status };
		}
		if (reason !== undefined) {
			return this.unavailableStanding(previous, { label, endpoint, reason, status });
		}
		if (previous.kind !== "error") {
			this.env.log("Usage endpoint request failed; retrying on the next poll", {
				label,
				endpoint,
				error: errorLabel(error),
				...(status === undefined ? {} : { status }),
			});
		}
		return errorStanding(error, status);
	}
}
