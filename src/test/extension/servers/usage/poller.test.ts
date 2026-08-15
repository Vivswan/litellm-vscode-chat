import * as assert from "node:assert";
import type {
	ActivityWindow,
	DailyUsage,
	KeyUsage,
	ServerUsageState,
	UsageAvailability,
	UsageChangeEvent,
	UsageConnection,
	UsageFetchClient,
	UsagePollerEnv,
	UsageTotals,
	UserUsage,
} from "../../../../extension/servers/usage";
import {
	activityWindow,
	USAGE_ACTIVITY_WINDOW_DAYS,
	UsagePoller,
	usageRefreshFailureSummary,
} from "../../../../extension/servers/usage";
import { RequestError } from "../../../../provider/transport/errorMapping";
import type { Clock, Timer } from "../../../../shared/util/timer";

/** A recording timer: nothing fires until the test fires it. */
class FakeTimer implements Timer {
	readonly scheduled: { callback: () => void; ms: number; cancelled: boolean }[] = [];

	set(callback: () => void, ms: number): () => void {
		const entry = { callback, ms, cancelled: false };
		this.scheduled.push(entry);
		return () => {
			entry.cancelled = true;
		};
	}

	pending(): { callback: () => void; ms: number; cancelled: boolean }[] {
		return this.scheduled.filter((entry) => !entry.cancelled);
	}

	/** Fire every currently pending tick (ticks scheduled by the firing are left pending). */
	firePending(): void {
		const now = this.pending();
		for (const entry of now) {
			entry.cancelled = true;
			entry.callback();
		}
	}
}

const EMPTY_TOTALS: UsageTotals = {
	spend: 0,
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	apiRequests: 0,
	successfulRequests: 0,
	failedRequests: 0,
	cacheReadInputTokens: 0,
	cacheCreationInputTokens: 0,
};

const EMPTY_DAILY: DailyUsage = { days: [], totals: EMPTY_TOTALS };

const KEY_OK: KeyUsage = {
	spend: 10,
	maxBudget: 100,
	softBudget: undefined,
	budgetResetAt: undefined,
	hasUser: false,
};

type EndpointResult<T> = T | RequestError;

/** A programmable client: per-endpoint results, call counts, the last window seen. */
class FakeClient implements UsageFetchClient {
	keyInfoResult: EndpointResult<KeyUsage> = KEY_OK;
	dailyResult: EndpointResult<DailyUsage> = EMPTY_DAILY;
	userResult: EndpointResult<UserUsage> = { spend: undefined, maxBudget: undefined, budgetResetAt: undefined };
	calls = { keyInfo: 0, dailyActivity: 0, userInfo: 0 };
	lastWindow: ActivityWindow | undefined;

	private answer<T>(result: EndpointResult<T>): Promise<T> {
		return result instanceof RequestError ? Promise.reject(result) : Promise.resolve(result);
	}

	fetchKeyInfo(_connection: UsageConnection): Promise<KeyUsage> {
		this.calls.keyInfo += 1;
		return this.answer(this.keyInfoResult);
	}

	fetchDailyActivity(_connection: UsageConnection, window: ActivityWindow): Promise<DailyUsage> {
		this.calls.dailyActivity += 1;
		this.lastWindow = window;
		return this.answer(this.dailyResult);
	}

	fetchUserInfo(_connection: UsageConnection): Promise<UserUsage> {
		this.calls.userInfo += 1;
		return this.answer(this.userResult);
	}
}

function unavailableError(status: number): RequestError {
	return new RequestError(`status ${status}`, status === 401 || status === 403 ? "auth" : "http", {
		status,
		englishMessage: `status ${status}`,
	});
}

interface Harness {
	poller: UsagePoller;
	timer: FakeTimer;
	client: FakeClient;
	events: UsageChangeEvent[];
	logs: string[];
	logEntries: { message: string; data?: unknown }[];
	setServers(servers: unknown): void;
	setIntervalMs(ms: number): void;
	setThresholds(thresholds: readonly number[]): void;
	advanceClock(ms: number): void;
}

function makeHarness(
	options: {
		intervalMs?: number;
		servers?: unknown;
		readSecrets?: UsagePollerEnv["readSecrets"];
		initialRefreshDelayMs?: number;
		serversChangeRefreshDelayMs?: number;
	} = {}
): Harness {
	const timer = new FakeTimer();
	const client = new FakeClient();
	const logs: string[] = [];
	const logEntries: { message: string; data?: unknown }[] = [];
	let servers: unknown = options.servers ?? [{ label: "alpha", baseUrl: "http://one.test", apiKey: "sk-1" }];
	let intervalMs = options.intervalMs ?? 300_000;
	let thresholds: readonly number[] = [0.8, 0.95];
	let nowMs = 1_750_000_000_000;
	const clock: Clock = { now: () => nowMs };
	const env: UsagePollerEnv = {
		readServersSetting: () => servers,
		readSecrets: options.readSecrets ?? (() => Promise.resolve({})),
		client,
		pollIntervalMs: () => intervalMs,
		...(options.initialRefreshDelayMs !== undefined
			? { initialRefreshDelayMs: () => options.initialRefreshDelayMs as number }
			: {}),
		...(options.serversChangeRefreshDelayMs !== undefined
			? { serversChangeRefreshDelayMs: () => options.serversChangeRefreshDelayMs as number }
			: {}),
		alertThresholds: () => thresholds,
		log: (message, data) => {
			logs.push(message);
			logEntries.push(data !== undefined ? { message, data } : { message });
		},
		timer,
		clock,
	};
	const poller = new UsagePoller(env);
	const events: UsageChangeEvent[] = [];
	poller.store.onDidChange((event) => events.push(event));
	return {
		poller,
		timer,
		client,
		events,
		logs,
		logEntries,
		setServers: (next) => {
			servers = next;
		},
		setIntervalMs: (ms) => {
			intervalMs = ms;
		},
		setThresholds: (next) => {
			thresholds = next;
		},
		advanceClock: (ms) => {
			nowMs += ms;
		},
	};
}

/** Let the in-flight pass and its follow-ups settle (fake client promises resolve in microtasks). */
function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/** One scheduled poll `ms` later: advance the fake clock, fire the pending tick, let the pass settle. */
async function tick(h: Harness, ms: number): Promise<void> {
	h.advanceClock(ms);
	h.timer.firePending();
	await settle();
}

/** The tracked state for a label, asserted present. */
function stateOf(h: Harness, label: string): ServerUsageState {
	const state = h.poller.store.get(label);
	assert.ok(state !== undefined, `no usage state tracked for ${label}`);
	return state;
}

/** The server-level availability verdict the UI keys on. */
function availabilityOf(h: Harness, label: string): UsageAvailability {
	return stateOf(h, label).availability;
}

suite("extension/servers/usage poller", () => {
	test("interval 0 disables polling: start() schedules nothing and no request goes out", async () => {
		const h = makeHarness({ intervalMs: 0 });

		h.poller.start();
		await settle();

		assert.deepStrictEqual(h.timer.pending(), []);
		assert.strictEqual(h.client.calls.keyInfo, 0);
	});

	test("refreshNow works with polling off and populates the store", async () => {
		const h = makeHarness({ intervalMs: 0 });

		await h.poller.refreshNow();

		assert.strictEqual(h.client.calls.keyInfo, 1);
		const state = stateOf(h, "alpha");
		assert.strictEqual(state.availability, "available");
		assert.strictEqual(state.key?.spend, 10);
		assert.strictEqual(state.lastUpdatedAt, 1_750_000_000_000);
		assert.deepStrictEqual(
			h.client.lastWindow,
			activityWindow(1_750_000_000_000, USAGE_ACTIVITY_WINDOW_DAYS),
			"the daily-activity request carries the documented window"
		);
		assert.deepStrictEqual(h.timer.pending(), [], "refreshNow with polling off must not start a cadence");
	});

	test("start() schedules an initial pass, and each pass reschedules at the interval", async () => {
		const h = makeHarness({ intervalMs: 300_000 });

		h.poller.start();
		assert.strictEqual(h.timer.pending().length, 1);

		h.timer.firePending();
		await settle();

		assert.strictEqual(h.client.calls.keyInfo, 1);
		const pending = h.timer.pending();
		assert.strictEqual(pending.length, 1, "the completed pass schedules the next tick");
		assert.strictEqual(pending[0]?.ms, 300_000);
	});

	test("the env's configured delays drive the initial tick and the servers-change tick", async () => {
		const h = makeHarness({ intervalMs: 300_000, initialRefreshDelayMs: 100, serversChangeRefreshDelayMs: 50 });

		h.poller.start();
		assert.strictEqual(h.timer.pending()[0]?.ms, 100, "start() reads usage.initialRefreshDelay through the env");

		h.timer.firePending();
		await settle();

		h.poller.applyServersChange();
		assert.strictEqual(
			h.timer.pending()[0]?.ms,
			50,
			"a servers change reads usage.serversChangeRefreshDelay through the env"
		);
	});

	test("an env without the optional delay readers falls back to the spec defaults", async () => {
		const h = makeHarness({ intervalMs: 300_000 });

		h.poller.start();
		assert.strictEqual(h.timer.pending()[0]?.ms, 5_000);

		h.timer.firePending();
		await settle();

		h.poller.applyServersChange();
		assert.strictEqual(h.timer.pending()[0]?.ms, 2_000);
	});

	test("applyConfiguration rewires the cadence: to 0 cancels, back to a positive interval re-schedules", () => {
		const h = makeHarness({ intervalMs: 300_000 });
		h.poller.start();
		assert.strictEqual(h.timer.pending().length, 1);

		h.setIntervalMs(0);
		h.poller.applyConfiguration();
		assert.deepStrictEqual(h.timer.pending(), []);

		h.setIntervalMs(600_000);
		h.poller.applyConfiguration();
		const pending = h.timer.pending();
		assert.strictEqual(pending.length, 1);
		assert.strictEqual(pending[0]?.ms, 600_000);
	});

	test("a permanently unavailable endpoint is skipped by scheduled polls and re-probed by refreshNow", async () => {
		const h = makeHarness({ intervalMs: 300_000 });
		h.client.keyInfoResult = unavailableError(404);
		h.poller.start();

		h.timer.firePending();
		await settle();
		assert.strictEqual(h.client.calls.keyInfo, 1);
		const state = h.poller.store.get("alpha");
		assert.deepStrictEqual(state?.endpoints.keyInfo, { kind: "unavailable", reason: "unsupported", status: 404 });
		assert.strictEqual(state?.availability, "available", "daily activity still answers");

		// The next scheduled poll must not hammer the classified endpoint.
		h.timer.firePending();
		await settle();
		assert.strictEqual(h.client.calls.keyInfo, 1);
		assert.strictEqual(h.client.calls.dailyActivity, 2, "available endpoints keep polling");

		// An explicit refresh re-probes.
		h.client.keyInfoResult = KEY_OK;
		await h.poller.refreshNow();
		assert.strictEqual(h.client.calls.keyInfo, 2);
		assert.deepStrictEqual(h.poller.store.get("alpha")?.endpoints.keyInfo, { kind: "ok" });
	});

	test("a server is usage-unavailable when both data endpoints are, with one log line per transition", async () => {
		const h = makeHarness({ intervalMs: 0 });
		h.client.keyInfoResult = unavailableError(400);
		h.client.dailyResult = unavailableError(400);

		await h.poller.refreshNow();
		assert.strictEqual(availabilityOf(h, "alpha"), "unavailable");
		const unavailableLines = h.logs.filter((line) => line.includes("Usage endpoint unavailable"));
		assert.strictEqual(unavailableLines.length, 2, "one classification line per endpoint transition");

		// Re-probing an unchanged server logs nothing new.
		await h.poller.refreshNow();
		assert.strictEqual(h.logs.filter((line) => line.includes("Usage endpoint unavailable")).length, 2);
	});

	test("an activity success never advances the spend age: spendUpdatedAt follows /key/info only", async () => {
		// Codex-found regression class: with /key/info failing and the activity
		// endpoint answering, the shared last-updated stamp advanced and old
		// spend rendered as "updated just now (stale)". The spend age is its
		// own field, moved only by a key-info success.
		const h = makeHarness({ intervalMs: 0 });
		h.client.keyInfoResult = unavailableError(500);
		await h.poller.refreshNow();
		const state = h.poller.store.get("alpha");
		assert.ok(state !== undefined);
		assert.notStrictEqual(state.lastUpdatedAt, undefined, "the activity success stamps the overall freshness");
		assert.strictEqual(state.spendUpdatedAt, undefined, "no key-info success, no spend age");

		h.client.keyInfoResult = KEY_OK;
		await h.poller.refreshNow();
		assert.notStrictEqual(h.poller.store.get("alpha")?.spendUpdatedAt, undefined);
	});

	test("transient failures keep availability and retry on the next poll", async () => {
		const h = makeHarness({ intervalMs: 300_000 });
		h.client.keyInfoResult = unavailableError(500);
		h.poller.start();

		h.timer.firePending();
		await settle();
		assert.deepStrictEqual(h.poller.store.get("alpha")?.endpoints.keyInfo, {
			kind: "error",
			classification: "http",
			status: 500,
		});

		h.timer.firePending();
		await settle();
		assert.strictEqual(h.client.calls.keyInfo, 2, "transient failures retry on the next poll");
	});

	test("the user rollup is fetched only when the key carries a user", async () => {
		const h = makeHarness({ intervalMs: 0 });

		await h.poller.refreshNow();
		assert.strictEqual(h.client.calls.userInfo, 0);

		h.client.keyInfoResult = { ...KEY_OK, hasUser: true };
		await h.poller.refreshNow();
		assert.strictEqual(h.client.calls.userInfo, 1);
	});

	test("a key that stops carrying a user clears the carried rollup", async () => {
		const h = makeHarness({ intervalMs: 0 });
		h.client.keyInfoResult = { ...KEY_OK, hasUser: true };
		h.client.userResult = { spend: 5, maxBudget: 50, budgetResetAt: undefined };
		await h.poller.refreshNow();
		assert.strictEqual(stateOf(h, "alpha").user?.spend, 5);

		// A rotated key without a user must not keep another account's rollup.
		h.client.keyInfoResult = { ...KEY_OK, hasUser: false };
		await h.poller.refreshNow();
		assert.strictEqual(stateOf(h, "alpha").user, undefined);
	});

	test("a pending servers-change probe survives an in-flight pass's end-of-pass reschedule", async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const h = makeHarness({
			intervalMs: 300_000,
			readSecrets: async () => {
				await gate;
				return {};
			},
		});
		h.poller.start();
		h.timer.firePending();
		await settle();
		// The pass is in flight (held on the secrets read); a servers change now
		// must not see its prompt re-probe stomped by the pass-end reschedule.
		h.poller.applyServersChange();
		release();
		await settle();

		const pending = h.timer.pending();
		assert.strictEqual(pending.length, 1);
		assert.ok(
			(pending[0]?.ms ?? Number.POSITIVE_INFINITY) < 60_000,
			"the pass-end reschedule must honor the pending probe's prompt delay"
		);

		// The prompt tick consumes the probe; the next reschedule returns to the cadence.
		h.timer.firePending();
		await settle();
		assert.strictEqual(h.timer.pending()[0]?.ms, 300_000);
	});

	test("budget resolution: the entry budget wins, the key-reported one is retained", async () => {
		const h = makeHarness({
			intervalMs: 0,
			servers: [{ label: "alpha", baseUrl: "http://one.test", apiKey: "sk-1", budget: 20 }],
		});
		h.client.keyInfoResult = { ...KEY_OK, spend: 18, maxBudget: 100 };

		await h.poller.refreshNow();

		const budget = h.poller.store.get("alpha")?.budget;
		assert.strictEqual(budget?.effectiveBudget, 20);
		assert.strictEqual(budget?.budgetSource, "entry");
		assert.strictEqual(budget?.keyBudget, 100);
		assert.strictEqual(budget?.spentFraction, 0.9);
		assert.deepStrictEqual(budget?.crossedThresholds, [0.8]);
	});

	test("newly crossed thresholds fire once, stay quiet on steady state, and re-arm after a drop", async () => {
		const h = makeHarness({ intervalMs: 0 });

		h.client.keyInfoResult = { ...KEY_OK, spend: 85, maxBudget: 100 };
		await h.poller.refreshNow();
		h.client.keyInfoResult = { ...KEY_OK, spend: 90, maxBudget: 100 };
		await h.poller.refreshNow();
		h.client.keyInfoResult = { ...KEY_OK, spend: 10, maxBudget: 100 };
		await h.poller.refreshNow();
		h.client.keyInfoResult = { ...KEY_OK, spend: 96, maxBudget: 100 };
		await h.poller.refreshNow();

		const crossings = h.events
			.filter((event) => event.kind === "updated")
			.map((event) => (event.kind === "updated" ? [...event.newlyCrossedThresholds] : []));
		assert.deepStrictEqual(crossings, [[0.8], [], [], [0.8, 0.95]]);
	});

	test("re-pointing an entry resets its crossing state: an also-over-budget new server still alerts", async () => {
		const h = makeHarness({ intervalMs: 0 });
		h.client.keyInfoResult = { ...KEY_OK, spend: 90, maxBudget: 100 };
		await h.poller.refreshNow();
		assert.deepStrictEqual(stateOf(h, "alpha").budget.crossedThresholds, [0.8]);

		h.setServers([{ label: "alpha", baseUrl: "http://two.test", apiKey: "sk-1" }]);
		await h.poller.refreshNow();

		const last = h.events.at(-1);
		assert.ok(last?.kind === "updated");
		assert.deepStrictEqual(
			[...last.newlyCrossedThresholds],
			[0.8],
			"the old server's crossings must not mute the new server's alert"
		);
	});

	test("each completed pass notifies every onDidRefresh subscriber; disposal stops it", async () => {
		const h = makeHarness({ intervalMs: 0 });
		let first = 0;
		let second = 0;
		const subscription = h.poller.onDidRefresh(() => {
			first += 1;
			throw new Error("listener failure must not starve the others");
		});
		h.poller.onDidRefresh(() => {
			second += 1;
		});

		await h.poller.refreshNow();
		assert.strictEqual(first, 1);
		assert.strictEqual(second, 1);

		subscription.dispose();
		await h.poller.refreshNow();
		assert.strictEqual(first, 1, "a disposed subscription stops firing");
		assert.strictEqual(second, 2);
	});

	test("a server pruned mid-pass is not resurrected by the pass's own upsert", async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let secretReads = 0;
		const h = makeHarness({
			intervalMs: 0,
			readSecrets: async () => {
				secretReads += 1;
				if (secretReads > 1) {
					await gate;
				}
				return {};
			},
		});
		await h.poller.refreshNow();
		assert.ok(h.poller.store.get("alpha") !== undefined);

		const pass = h.poller.refreshNow();
		await Promise.resolve();
		// The second pass is in flight, holding on the secrets read; the server
		// leaves the setting and is pruned before the pass writes its state back.
		h.setServers([]);
		h.poller.applyServersChange();
		release();
		await pass;

		assert.strictEqual(h.poller.store.get("alpha"), undefined, "the completed pass must not resurrect the server");
		assert.deepStrictEqual(
			h.events.map((event) => event.kind),
			["updated", "removed"],
			"no update may follow the removal"
		);
	});

	test("applyConfiguration never alerts from cached data: crossings re-baseline on the next fetch", async () => {
		// Alerts evaluate on fetches only (docs/usage.md): a threshold edit -
		// especially with polling OFF - must not toast from data already in the
		// store, so applyConfiguration leaves the stored crossings untouched
		// and the next fetch diffs against them.
		const h = makeHarness({ intervalMs: 0 });
		h.client.keyInfoResult = { ...KEY_OK, spend: 70, maxBudget: 100 };
		await h.poller.refreshNow();
		assert.deepStrictEqual(h.poller.store.get("alpha")?.budget.crossedThresholds, []);
		const fetchesBefore = h.client.calls.keyInfo;
		const eventsBefore = h.events.length;

		h.setThresholds([0.5]);
		h.poller.applyConfiguration();

		assert.strictEqual(h.client.calls.keyInfo, fetchesBefore, "a threshold edit costs no network");
		assert.strictEqual(h.events.length, eventsBefore, "no store event, so no toast, without a fetch");
		assert.deepStrictEqual(h.poller.store.get("alpha")?.budget.crossedThresholds, []);

		// The next fetch evaluates against the new list: the standing 70%
		// position crosses the new 0.5 threshold exactly once.
		await h.poller.refreshNow();
		assert.deepStrictEqual(h.poller.store.get("alpha")?.budget.crossedThresholds, [0.5]);
		const last = h.events.at(-1);
		assert.ok(last?.kind === "updated" && last.newlyCrossedThresholds.includes(0.5));
	});

	test("applyServersChange prunes removed servers and re-probes the rest when polling is on", async () => {
		const h = makeHarness({
			intervalMs: 300_000,
			servers: [
				{ label: "alpha", baseUrl: "http://one.test", apiKey: "sk-1" },
				{ label: "beta", baseUrl: "http://two.test", apiKey: "sk-2" },
			],
		});
		h.client.keyInfoResult = unavailableError(404);
		h.poller.start();
		h.timer.firePending();
		await settle();
		assert.strictEqual(h.poller.store.getStates().length, 2);
		assert.strictEqual(h.client.calls.keyInfo, 2);

		h.client.keyInfoResult = KEY_OK;
		h.setServers([{ label: "alpha", baseUrl: "http://one.test", apiKey: "sk-1" }]);
		h.poller.applyServersChange();

		assert.ok(h.events.some((event) => event.kind === "removed" && event.label === "beta"));
		assert.strictEqual(h.poller.store.get("beta"), undefined);
		const pending = h.timer.pending();
		assert.strictEqual(pending.length, 1, "a servers change schedules a prompt refresh");
		assert.ok((pending[0]?.ms ?? 0) < 60_000);

		h.timer.firePending();
		await settle();
		// The change-triggered pass re-probes the endpoint a probe had classified.
		assert.strictEqual(h.client.calls.keyInfo, 3);
		assert.deepStrictEqual(h.poller.store.get("alpha")?.endpoints.keyInfo, { kind: "ok" });
	});

	test("applyServersChange with polling off prunes but issues no background requests", async () => {
		const h = makeHarness({ intervalMs: 0 });
		await h.poller.refreshNow();
		assert.strictEqual(h.client.calls.keyInfo, 1);

		h.setServers([]);
		h.poller.applyServersChange();
		await settle();

		assert.strictEqual(h.poller.store.getStates().length, 0);
		assert.deepStrictEqual(h.timer.pending(), []);
		assert.strictEqual(h.client.calls.keyInfo, 1);
	});

	test("an unreadable secrets blob skips the server's fetches for the pass and logs a classification", async () => {
		const h = makeHarness({ intervalMs: 0, readSecrets: () => Promise.reject(new Error("store broken")) });

		await h.poller.refreshNow();

		assert.strictEqual(h.client.calls.keyInfo, 0);
		assert.strictEqual(availabilityOf(h, "alpha"), "unknown");
		assert.ok(h.logs.some((line) => line.includes("stored secrets failed")));
	});

	test("dispose cancels the pending tick", () => {
		const h = makeHarness({ intervalMs: 300_000 });
		h.poller.start();
		assert.strictEqual(h.timer.pending().length, 1);

		h.poller.dispose();

		assert.deepStrictEqual(h.timer.pending(), []);
	});

	test("refreshNow resolves with per-server outcomes: what failed, and whether anything answered", async () => {
		const h = makeHarness({ intervalMs: 0 });
		h.client.keyInfoResult = unavailableError(401);

		const outcome = await h.poller.refreshNow();

		assert.ok(outcome !== undefined);
		assert.strictEqual(outcome.servers.length, 1);
		const server = outcome.servers[0];
		assert.strictEqual(server?.label, "alpha");
		assert.strictEqual(server?.succeededAny, true, "daily activity still answered");
		assert.deepStrictEqual(server?.failures, [
			{ endpoint: "keyInfo", classification: "http", status: 401, reason: "forbidden" },
		]);
		assert.strictEqual(
			usageRefreshFailureSummary(outcome),
			undefined,
			"a partial failure never produces the total-failure summary"
		);
	});

	test("an all-unsupported refresh stays silent: a DB-less proxy is a documented normal shape", async () => {
		const h = makeHarness({ intervalMs: 0 });
		h.client.keyInfoResult = unavailableError(404);
		h.client.dailyResult = unavailableError(400);

		const outcome = await h.poller.refreshNow();

		assert.ok(outcome !== undefined);
		assert.strictEqual(outcome.servers[0]?.succeededAny, false);
		assert.strictEqual(outcome.servers[0]?.failures.length, 2);
		assert.strictEqual(usageRefreshFailureSummary(outcome), undefined, "unsupported endpoints never trip the toast");
	});

	test("an unreadable secrets blob still acknowledges an explicit refresh, without the error itself", async () => {
		const h = makeHarness({ intervalMs: 0, readSecrets: () => Promise.reject(new Error("store broken")) });

		const outcome = await h.poller.refreshNow();

		assert.ok(outcome !== undefined);
		assert.strictEqual(outcome.servers[0]?.secretsUnreadable, true);
		assert.strictEqual(usageRefreshFailureSummary(outcome), "alpha: stored secrets unreadable");
	});

	test("a totally failed explicit refresh summarizes per server: label, endpoint, status, reason", async () => {
		const h = makeHarness({
			intervalMs: 0,
			servers: [
				{ label: "alpha", baseUrl: "http://one.test", apiKey: "sk-1" },
				{ label: "beta", baseUrl: "http://two.test", apiKey: "sk-2" },
			],
		});
		h.client.keyInfoResult = unavailableError(401);
		h.client.dailyResult = new RequestError("timed out", "timeout", { englishMessage: "timed out" });

		const outcome = await h.poller.refreshNow();

		assert.ok(outcome !== undefined);
		assert.strictEqual(
			usageRefreshFailureSummary(outcome),
			"alpha: /key/info 401 forbidden, /user/daily/activity timeout; beta: /key/info 401 forbidden, /user/daily/activity timeout"
		);
	});

	test("a refresh interrupted by disposal resolves without an outcome: cancellation stays silent", async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const h = makeHarness({
			intervalMs: 0,
			readSecrets: async () => {
				await gate;
				return {};
			},
		});

		const pass = h.poller.refreshNow();
		await Promise.resolve();
		h.poller.dispose();
		release();

		assert.strictEqual(await pass, undefined, "an interrupted pass proves nothing and must not toast");
	});

	test("a once-available server stays visible through a transient outage on a forced re-probe", async () => {
		const h = makeHarness({ intervalMs: 0 });
		await h.poller.refreshNow();
		assert.strictEqual(availabilityOf(h, "alpha"), "available");

		// The whole server goes dark transiently: the forced pass resets the
		// carried standings, but the card the user is looking at must not vanish.
		h.client.keyInfoResult = new RequestError("net down", "network", { englishMessage: "net down" });
		h.client.dailyResult = new RequestError("net down", "network", { englishMessage: "net down" });
		await h.poller.refreshNow();

		const state = stateOf(h, "alpha");
		assert.strictEqual(state.availability, "available", "retained data keeps rendering with its failure state");
		assert.strictEqual(state.key?.spend, 10, "the last-known numbers stay");
		assert.deepStrictEqual(state.endpoints.keyInfo, { kind: "error", classification: "network" });

		// A permanent both-endpoints verdict still hides the server.
		h.client.keyInfoResult = unavailableError(400);
		h.client.dailyResult = unavailableError(400);
		await h.poller.refreshNow();
		assert.strictEqual(availabilityOf(h, "alpha"), "unavailable");
	});

	test("consecutive statusless failures back off scheduled attempts, doubling to a 16x cap", async () => {
		// The dead-address shape: timeouts with no HTTP status classify as
		// error-kind, and before the backoff they re-burned the full discovery
		// timeout on every poll forever.
		const interval = 100_000;
		const h = makeHarness({ intervalMs: interval });
		h.client.keyInfoResult = new RequestError("timed out", "timeout", { englishMessage: "timed out" });
		h.client.dailyResult = new RequestError("timed out", "timeout", { englishMessage: "timed out" });
		h.poller.start();
		h.timer.firePending();
		await settle();
		assert.strictEqual(h.client.calls.keyInfo, 1);

		// One failure = normal retry on the next poll.
		await tick(h, interval);
		assert.strictEqual(h.client.calls.keyInfo, 2);

		// Two failures = 2x spacing: the next tick skips, the one after attempts.
		await tick(h, interval);
		assert.strictEqual(h.client.calls.keyInfo, 2, "one interval into a 2x backoff, the attempt is skipped");
		assert.strictEqual(h.timer.pending().length, 1, "the cadence itself keeps ticking through a skip");
		await tick(h, interval);
		assert.strictEqual(h.client.calls.keyInfo, 3);

		// Three failures = 4x spacing.
		await tick(h, 3 * interval);
		assert.strictEqual(h.client.calls.keyInfo, 3);
		await tick(h, interval);
		assert.strictEqual(h.client.calls.keyInfo, 4);

		// Four failures = 8x, five = 16x.
		await tick(h, 8 * interval);
		assert.strictEqual(h.client.calls.keyInfo, 5);
		await tick(h, 15 * interval);
		assert.strictEqual(h.client.calls.keyInfo, 5, "the 16x window is still open");
		await tick(h, interval);
		assert.strictEqual(h.client.calls.keyInfo, 6);

		// The cap holds: the sixth failure does not widen the window past 16x.
		await tick(h, 15 * interval);
		assert.strictEqual(h.client.calls.keyInfo, 6);
		await tick(h, interval);
		assert.strictEqual(h.client.calls.keyInfo, 7);

		// Transitions only: one escalation line per multiplier per endpoint
		// (2x, 4x, 8x, 16x for keyInfo and dailyActivity) plus the two initial
		// error transitions - and NOTHING else, so a skipped attempt provably
		// logs nothing at all.
		const escalations = h.logEntries.filter((entry) => entry.message.includes("backing off"));
		assert.deepStrictEqual(
			escalations
				.filter((entry) => (entry.data as { endpoint?: string }).endpoint === "keyInfo")
				.map((entry) => (entry.data as { multiplier?: number }).multiplier),
			[2, 4, 8, 16]
		);
		assert.strictEqual(escalations.length, 8);
		assert.strictEqual(h.logs.filter((line) => line.includes("retrying on the next poll")).length, 2);
		assert.strictEqual(h.logs.length, 10, "no other line may appear: skips are silent");
	});

	test("backoff is per endpoint: a healthy endpoint keeps the full cadence beside a backed-off one", async () => {
		const interval = 100_000;
		const h = makeHarness({ intervalMs: interval });
		h.client.keyInfoResult = new RequestError("timed out", "timeout", { englishMessage: "timed out" });
		h.poller.start();
		h.timer.firePending();
		await settle();
		await tick(h, interval);
		assert.strictEqual(h.client.calls.keyInfo, 2);
		assert.strictEqual(h.client.calls.dailyActivity, 2);

		// keyInfo sits out its 2x window; dailyActivity polls anyway.
		await tick(h, interval);
		assert.strictEqual(h.client.calls.keyInfo, 2);
		assert.strictEqual(h.client.calls.dailyActivity, 3);
		await tick(h, interval);
		assert.strictEqual(h.client.calls.keyInfo, 3);
		assert.strictEqual(h.client.calls.dailyActivity, 4);
	});

	test("a success resets the backoff: the next failure is a fresh streak with a normal first retry", async () => {
		const interval = 100_000;
		const h = makeHarness({ intervalMs: interval });
		h.client.keyInfoResult = unavailableError(500);
		h.poller.start();
		h.timer.firePending();
		await settle();
		await tick(h, interval);
		await tick(h, interval);
		assert.strictEqual(h.client.calls.keyInfo, 2, "the 5xx streak backs off like any error-kind failure");

		h.client.keyInfoResult = KEY_OK;
		await tick(h, interval);
		assert.strictEqual(h.client.calls.keyInfo, 3, "the reopened window attempts and succeeds");
		assert.strictEqual(h.logs.filter((line) => line.includes("recovered; backoff cleared")).length, 1);

		// A fresh failure starts over: attempt, then a normal next-poll retry.
		h.client.keyInfoResult = unavailableError(500);
		await tick(h, interval);
		assert.strictEqual(h.client.calls.keyInfo, 4);
		await tick(h, interval);
		assert.strictEqual(h.client.calls.keyInfo, 5, "one failure after a success retries at the normal cadence");
	});

	test("refreshNow resets the backoff and attempts immediately", async () => {
		const interval = 100_000;
		const h = makeHarness({ intervalMs: interval });
		h.client.keyInfoResult = new RequestError("timed out", "timeout", { englishMessage: "timed out" });
		h.client.dailyResult = new RequestError("timed out", "timeout", { englishMessage: "timed out" });
		h.poller.start();
		h.timer.firePending();
		await settle();
		await tick(h, interval);
		await tick(h, interval);
		assert.strictEqual(h.client.calls.keyInfo, 2, "the streak is in its 2x window");

		// The manual command must not wait out the window - and it restarts the count.
		await h.poller.refreshNow();
		assert.strictEqual(h.client.calls.keyInfo, 3);
		await tick(h, interval);
		assert.strictEqual(h.client.calls.keyInfo, 4, "after the reset, one failure means a normal next-poll retry");
	});

	test("a servers-setting change resets the backoff and re-attempts promptly", async () => {
		const interval = 100_000;
		const h = makeHarness({ intervalMs: interval });
		h.client.keyInfoResult = new RequestError("timed out", "timeout", { englishMessage: "timed out" });
		h.client.dailyResult = new RequestError("timed out", "timeout", { englishMessage: "timed out" });
		h.poller.start();
		h.timer.firePending();
		await settle();
		await tick(h, interval);
		await tick(h, interval);
		assert.strictEqual(h.client.calls.keyInfo, 2, "the streak is in its 2x window");

		// An entry edit re-probes without waiting: the prompt forced pass attempts.
		h.poller.applyServersChange();
		h.timer.firePending();
		await settle();
		assert.strictEqual(h.client.calls.keyInfo, 3);

		// The forced pass attempting proves nothing about the reset (a forced
		// pass always attempts); the NEXT scheduled poll does: a surviving
		// streak (now 3 failures deep) would sit in a 4x window and skip it.
		await tick(h, interval);
		assert.strictEqual(h.client.calls.keyInfo, 4, "the change restarted the count: one failure, normal retry");
	});

	test("an unavailable verdict ends the streak and stays sticky: no backoff re-probes it", async () => {
		const interval = 100_000;
		const h = makeHarness({ intervalMs: interval });
		h.client.keyInfoResult = new RequestError("timed out", "timeout", { englishMessage: "timed out" });
		h.poller.start();
		h.timer.firePending();
		await settle();
		await tick(h, interval);
		assert.strictEqual(h.client.calls.keyInfo, 2);

		// The server starts answering 404: the reopened attempt classifies the
		// endpoint permanently unavailable, which outranks any backoff window.
		h.client.keyInfoResult = unavailableError(404);
		await tick(h, 2 * interval);
		assert.strictEqual(h.client.calls.keyInfo, 3);
		assert.deepStrictEqual(stateOf(h, "alpha").endpoints.keyInfo, {
			kind: "unavailable",
			reason: "unsupported",
			status: 404,
		});

		// However much time passes, scheduled polls never re-probe it...
		await tick(h, 32 * interval);
		assert.strictEqual(h.client.calls.keyInfo, 3);

		// ...and an explicit refresh still does.
		h.client.keyInfoResult = KEY_OK;
		await h.poller.refreshNow();
		assert.strictEqual(h.client.calls.keyInfo, 4);
		assert.deepStrictEqual(stateOf(h, "alpha").endpoints.keyInfo, { kind: "ok" });
	});

	test("a clock that jumped backwards fails open: the backed-off attempt goes out", async () => {
		const interval = 100_000;
		const h = makeHarness({ intervalMs: interval });
		h.client.keyInfoResult = new RequestError("timed out", "timeout", { englishMessage: "timed out" });
		h.poller.start();
		h.timer.firePending();
		await settle();
		await tick(h, interval);
		assert.strictEqual(h.client.calls.keyInfo, 2, "the streak is in its 2x window");

		// A system clock adjustment must not wedge the endpoint until the new
		// time catches the old timestamps up.
		await tick(h, -10 * interval);
		assert.strictEqual(h.client.calls.keyInfo, 3);
	});

	test("the backoff window follows a mid-streak interval edit: shrinking the interval shrinks the wait", async () => {
		const interval = 100_000;
		const h = makeHarness({ intervalMs: interval });
		h.client.keyInfoResult = new RequestError("timed out", "timeout", { englishMessage: "timed out" });
		h.poller.start();
		h.timer.firePending();
		await settle();
		await tick(h, interval);
		await tick(h, interval);
		assert.strictEqual(h.client.calls.keyInfo, 2, "one interval into the 2x window is a skip");

		// Halving the interval halves the window: the same one-interval-old
		// attempt now sits exactly at 2 x the new interval.
		h.setIntervalMs(interval / 2);
		h.poller.applyConfiguration();
		h.timer.firePending();
		await settle();
		assert.strictEqual(h.client.calls.keyInfo, 3);
	});

	test("a silently re-pointed entry starts a fresh streak: the old host's backoff does not carry", async () => {
		const interval = 100_000;
		const h = makeHarness({ intervalMs: interval });
		h.client.keyInfoResult = new RequestError("timed out", "timeout", { englishMessage: "timed out" });
		h.client.dailyResult = new RequestError("timed out", "timeout", { englishMessage: "timed out" });
		h.poller.start();
		h.timer.firePending();
		await settle();
		await tick(h, interval);
		await tick(h, interval);
		assert.strictEqual(h.client.calls.keyInfo, 2, "the streak is in its 2x window");

		// The setting changes under a scheduled pass (no applyServersChange, so
		// no forced probe): the different base URL alone must reset the streak.
		h.setServers([{ label: "alpha", baseUrl: "http://two.test", apiKey: "sk-1" }]);
		h.timer.firePending();
		await settle();
		assert.strictEqual(h.client.calls.keyInfo, 3);

		// The re-point pass itself always attempts (its carried standing is
		// unprobed); only the NEXT poll proves the reset - an inherited streak,
		// now 3 failures deep, would sit in a 4x window and skip it.
		await tick(h, interval);
		assert.strictEqual(h.client.calls.keyInfo, 4, "the new host starts its own count: one failure, normal retry");
	});

	test("a success racing disposal never logs a recovery: cancellation stays silent", async () => {
		const interval = 100_000;
		const h = makeHarness({ intervalMs: interval });
		h.client.keyInfoResult = new RequestError("timed out", "timeout", { englishMessage: "timed out" });
		h.poller.start();
		h.timer.firePending();
		await settle();
		await tick(h, interval);
		assert.strictEqual(h.client.calls.keyInfo, 2, "the streak has engaged its backoff");

		// The next attempt succeeds, but only after dispose() lands mid-flight.
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		h.client.fetchKeyInfo = async () => {
			await gate;
			return KEY_OK;
		};
		h.advanceClock(2 * interval);
		h.timer.firePending();
		await settle();
		h.poller.dispose();
		release();
		await settle();

		assert.strictEqual(
			h.logs.filter((line) => line.includes("recovered")).length,
			0,
			"a discarded pass must not log a recovery"
		);
	});

	test("refreshIfStale runs a pass when nothing completed yet, and none while the last pass is younger than the interval", async () => {
		const h = makeHarness();

		// No completed pass this session: stale by definition.
		const first = h.poller.refreshIfStale();
		assert.ok(first !== undefined, "the first open must fetch");
		await settle();
		assert.strictEqual(h.client.calls.keyInfo, 1);

		// Re-opening a minute later: the numbers are younger than the interval,
		// so the open serves them as they are.
		h.advanceClock(60_000);
		assert.strictEqual(h.poller.refreshIfStale(), undefined, "a fresh open must not re-probe the fleet");
		await settle();
		assert.strictEqual(h.client.calls.keyInfo, 1);

		// Past the interval the same open fetches again.
		h.advanceClock(300_000);
		assert.ok(h.poller.refreshIfStale() !== undefined, "a stale open must fetch");
		await settle();
		assert.strictEqual(h.client.calls.keyInfo, 2);
	});

	test("with polling off, refreshIfStale uses the interval's spec default as its staleness floor", async () => {
		const h = makeHarness({ intervalMs: 0 });

		assert.ok(h.poller.refreshIfStale() !== undefined, "no pass yet: the open fetches, polling off or not");
		await settle();
		assert.strictEqual(h.client.calls.keyInfo, 1);

		// Inside the default five-minute interval: fresh enough.
		h.advanceClock(200_000);
		assert.strictEqual(h.poller.refreshIfStale(), undefined);
		await settle();
		assert.strictEqual(h.client.calls.keyInfo, 1);

		// Past it: stale, even though no poll will ever run on its own.
		h.advanceClock(200_000);
		assert.ok(h.poller.refreshIfStale() !== undefined);
		await settle();
		assert.strictEqual(h.client.calls.keyInfo, 2);
	});

	test("refreshIfStale starts nothing while a pass is in flight or queued", async () => {
		const h = makeHarness();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		h.client.fetchKeyInfo = async () => {
			h.client.calls.keyInfo += 1;
			await gate;
			return KEY_OK;
		};

		const running = h.poller.refreshNow();
		assert.strictEqual(h.poller.refreshIfStale(), undefined, "an in-flight pass is about-to-be-fresh");
		const queued = h.poller.refreshNow();
		assert.strictEqual(h.poller.refreshIfStale(), undefined, "a queued follow-up already covers the open");
		release();
		await running;
		await queued;
		await settle();
		assert.strictEqual(h.client.calls.keyInfo, 2, "exactly the running pass and its one queued follow-up");
	});

	test("a pending servers-change probe overrides the staleness gate outright", async () => {
		// With polling OFF the pending probe waits for the next explicit
		// refresh - and an open counts: the stored numbers may describe a
		// server or credentials that no longer exist, so a fresh timestamp
		// must not talk the open out of the probe.
		const h = makeHarness({ intervalMs: 0 });
		await h.poller.refreshNow();
		assert.strictEqual(h.client.calls.keyInfo, 1);

		h.advanceClock(10_000);
		assert.strictEqual(h.poller.refreshIfStale(), undefined, "fresh and unchanged: no pass");

		h.setServers([{ label: "alpha", baseUrl: "http://two.test", apiKey: "sk-2" }]);
		h.poller.applyServersChange();
		const probe = h.poller.refreshIfStale();
		assert.ok(probe !== undefined, "a pending probe must run on open, however fresh the timestamp");
		await probe;
		assert.strictEqual(h.client.calls.keyInfo, 2);
	});

	test("onDidStartRefresh fires when any pass begins, scheduled ones included", async () => {
		const h = makeHarness({ initialRefreshDelayMs: 5_000 });
		let starts = 0;
		let refreshingAtStart: boolean | undefined;
		h.poller.onDidStartRefresh(() => {
			starts += 1;
			refreshingAtStart = h.poller.isRefreshing();
		});

		h.poller.start();
		h.timer.firePending();
		assert.strictEqual(starts, 1, "a scheduled pass announces its start");
		assert.strictEqual(refreshingAtStart, true, "the listener observes the engine already busy");
		await settle();

		await h.poller.refreshNow();
		assert.strictEqual(starts, 2, "an explicit pass announces its start too");
	});

	test("only explicit passes read as refreshing explicitly; scheduled and open-triggered ones stay quiet", async () => {
		const h = makeHarness({ initialRefreshDelayMs: 5_000 });
		// Every keyInfo call blocks until released, one release per call, so the
		// test can observe each pass mid-flight (a shared gate would unblock a
		// queued pass it never meant to).
		const releases: (() => void)[] = [];
		h.client.fetchKeyInfo = async () => {
			h.client.calls.keyInfo += 1;
			await new Promise<void>((resolve) => releases.push(resolve));
			return KEY_OK;
		};
		const release = async () => {
			// Settle FIRST: the pass reaches the gate a few microtasks after it
			// starts, and a release fired before the resolver exists would leave
			// the gate closed forever (the shift is a no-op on an empty queue).
			await settle();
			releases.shift()?.();
			await settle();
		};

		// A scheduled poll: in flight, but not explicit.
		h.poller.start();
		h.timer.firePending();
		await Promise.resolve();
		assert.strictEqual(h.poller.isRefreshing(), true);
		assert.strictEqual(h.poller.isRefreshingExplicitly(), false, "a scheduled poll must not wear the busy label");
		// An explicit refresh queued behind it flips the explicit reading at once.
		const explicit = h.poller.refreshNow();
		assert.strictEqual(h.poller.isRefreshingExplicitly(), true, "a queued explicit refresh is asked-for work");
		await release();
		assert.strictEqual(h.poller.isRefreshingExplicitly(), true, "the queued explicit pass is now the running one");
		await release();
		await explicit;
		await settle();
		assert.strictEqual(h.poller.isRefreshing(), false);
		assert.strictEqual(h.poller.isRefreshingExplicitly(), false);

		// An open-triggered staleness pass: in flight, never explicit.
		h.advanceClock(600_000);
		const stale = h.poller.refreshIfStale();
		assert.ok(stale !== undefined);
		assert.strictEqual(h.poller.isRefreshing(), true);
		assert.strictEqual(h.poller.isRefreshingExplicitly(), false, "an open-triggered pass is background work");
		await release();
		await stale;
	});
});
