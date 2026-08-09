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
	return new RequestError(`status ${status}`, status === 401 || status === 403 ? "auth" : "http", { status });
}

interface Harness {
	poller: UsagePoller;
	timer: FakeTimer;
	client: FakeClient;
	events: UsageChangeEvent[];
	logs: string[];
	setServers(servers: unknown): void;
	setIntervalMs(ms: number): void;
	setThresholds(thresholds: readonly number[]): void;
}

function makeHarness(
	options: { intervalMs?: number; servers?: unknown; readSecrets?: UsagePollerEnv["readSecrets"] } = {}
): Harness {
	const timer = new FakeTimer();
	const client = new FakeClient();
	const logs: string[] = [];
	let servers: unknown = options.servers ?? [{ label: "alpha", baseUrl: "http://one.test", apiKey: "sk-1" }];
	let intervalMs = options.intervalMs ?? 300_000;
	let thresholds: readonly number[] = [0.8, 0.95];
	const clock: Clock = { now: () => 1_750_000_000_000 };
	const env: UsagePollerEnv = {
		readServersSetting: () => servers,
		readSecrets: options.readSecrets ?? (() => Promise.resolve({})),
		client,
		pollIntervalMs: () => intervalMs,
		alertThresholds: () => thresholds,
		log: (message) => {
			logs.push(message);
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
		setServers: (next) => {
			servers = next;
		},
		setIntervalMs: (ms) => {
			intervalMs = ms;
		},
		setThresholds: (next) => {
			thresholds = next;
		},
	};
}

/** Let the in-flight pass and its follow-ups settle (fake client promises resolve in microtasks). */
function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
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
		h.client.dailyResult = new RequestError("timed out", "timeout");

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
		h.client.keyInfoResult = new RequestError("net down", "network");
		h.client.dailyResult = new RequestError("net down", "network");
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
});
