import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { OpenRouterCatalogStatus, OpenRouterCatalogStore } from "../../extension/openRouterCatalog";
import { createOpenRouterCatalogStore } from "../../extension/openRouterCatalog";
import { OPENROUTER_CATALOG_METADATA_KEY } from "../../shared/config/storageKeys";
import { Logger } from "../../shared/logger";
import type { Clock, Timer } from "../../shared/util/timer";
import { makeExtensionStorage, withFetch } from "../testUtils";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_DELAY_MS = 60_000;

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const fixtureText = fs.readFileSync(path.join(repoRoot, "src", "test", "fixtures", "openrouter-models.json"), "utf8");

/**
 * A payload distinguishable from the fixture, in the live endpoint's shape,
 * over the runtime model-count floor. The live endpoint carries a pricing
 * block; the store's slimmed cache must never keep it (LiteLLM is the only
 * pricing source).
 */
const refreshedPayload = {
	data: Array.from({ length: 250 }, (_, index) => ({
		id: `refreshed/model-${index}`,
		name: `Refreshed Model ${index}`,
		context_length: 200000,
		architecture: { input_modalities: ["text", "image"] },
		top_provider: { max_completion_tokens: 32000 },
		pricing: { prompt: "0.000001", completion: "0.000002" },
		supported_parameters: ["tools", "reasoning"],
	})),
};

interface ScheduledCall {
	readonly ms: number;
	readonly cb: () => void;
	canceled: boolean;
	fired: boolean;
}

/**
 * A recording timer: long delays (the weekly/daily schedule, all >=
 * MIN_SCHEDULE_DELAY_MS) are captured for the test to fire; short delays (the
 * retry backoff sleeps inside one refresh) run on a microtask so awaited
 * refreshes complete without real time.
 */
function makeTimer(): { timer: Timer; scheduled: ScheduledCall[] } {
	const scheduled: ScheduledCall[] = [];
	const timer: Timer = {
		set: (cb, ms) => {
			if (ms < MIN_DELAY_MS) {
				queueMicrotask(cb);
				return () => {};
			}
			const call: ScheduledCall = {
				ms,
				cb: () => {
					call.fired = true;
					cb();
				},
				canceled: false,
				fired: false,
			};
			scheduled.push(call);
			return () => {
				call.canceled = true;
			};
		},
	};
	return { timer, scheduled };
}

function pendingSchedules(scheduled: ScheduledCall[]): ScheduledCall[] {
	return scheduled.filter((call) => !call.canceled && !call.fired);
}

interface Harness {
	store: OpenRouterCatalogStore;
	scheduled: ScheduledCall[];
	mementoStore: Map<string, unknown>;
	storageDir: string;
	cachePath: string;
	logLines: string[];
	updates: number;
	fetchCalls: number;
}

interface HarnessOptions {
	bundled?: string | undefined;
	cached?: string | undefined;
	metadata?: Record<string, unknown> | undefined;
	enabled?: (() => boolean) | undefined;
	fetchCatalog?: ((signal: AbortSignal) => Promise<unknown>) | undefined;
	now?: number | undefined;
	/** Plant a FILE at the globalStorage path so every cache write fails. */
	unwritableStorage?: boolean | undefined;
	/** Exercise the store's real fetch path (pair with withFetch) instead of injecting one. */
	useDefaultFetch?: boolean | undefined;
}

const disposables: OpenRouterCatalogStore[] = [];
const tempDirs: string[] = [];
teardown(() => {
	for (const store of disposables.splice(0)) {
		store.dispose();
	}
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function makeHarness(options: HarnessOptions = {}): Harness {
	const extensionDir = fs.mkdtempSync(path.join(os.tmpdir(), "orc-ext-"));
	const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orc-store-"));
	tempDirs.push(extensionDir, storageRoot);
	const storageDir = path.join(storageRoot, "global-storage");
	if (options.bundled !== undefined) {
		fs.mkdirSync(path.join(extensionDir, "dist"), { recursive: true });
		fs.writeFileSync(path.join(extensionDir, "dist", "openrouter-models.json"), options.bundled);
	}
	if (options.cached !== undefined) {
		fs.mkdirSync(storageDir, { recursive: true });
		fs.writeFileSync(path.join(storageDir, "openrouter-models.json"), options.cached);
	}
	if (options.unwritableStorage) {
		fs.writeFileSync(storageDir, "a file where the storage directory should be");
	}
	const { memento, mementoStore } = makeExtensionStorage(
		options.metadata !== undefined ? { [OPENROUTER_CATALOG_METADATA_KEY]: options.metadata } : {}
	);
	const { timer, scheduled } = makeTimer();
	const clock: Clock = { now: () => options.now ?? 1_000_000_000_000 };
	const logLines: string[] = [];
	const harness: Harness = {
		store: undefined as unknown as OpenRouterCatalogStore,
		scheduled,
		mementoStore,
		storageDir,
		cachePath: path.join(storageDir, "openrouter-models.json"),
		logLines,
		updates: 0,
		fetchCalls: 0,
	};
	const store = createOpenRouterCatalogStore({
		extensionUri: vscode.Uri.file(extensionDir),
		globalStorageUri: vscode.Uri.file(storageDir),
		globalState: memento,
		logger: new Logger({ info: (message) => logLines.push(message), error: (message) => logLines.push(message) }),
		isEnabled: options.enabled ?? (() => true),
		...(options.useDefaultFetch
			? {}
			: {
					fetchCatalog: async (signal: AbortSignal) => {
						harness.fetchCalls += 1;
						const fetchCatalog = options.fetchCatalog ?? (async () => refreshedPayload);
						return fetchCatalog(signal);
					},
				}),
		timer,
		clock,
	});
	store.onDidUpdate(() => {
		harness.updates += 1;
	});
	disposables.push(store);
	harness.store = store;
	return harness;
}

suite("extension openRouterCatalog store", () => {
	test("serves the bundled snapshot when no cache file exists", async () => {
		const harness = makeHarness({ bundled: fixtureText });
		await harness.store.initialize();
		assert.strictEqual(harness.store.lookup.byExactId("anthropic/claude-sonnet-4.5").kind, "found");
		assert.strictEqual(harness.store.snapshot().models.length, 6);
	});

	test("tolerates both files missing: empty catalog, no throw, refresh still scheduled", async () => {
		const harness = makeHarness();
		await harness.store.initialize();
		assert.deepStrictEqual(harness.store.lookup.byExactId("anything"), { kind: "not-found" });
		assert.deepStrictEqual(harness.store.lookup.byRawModelId("anything"), { kind: "not-found" });
		assert.strictEqual(pendingSchedules(harness.scheduled).length, 1);
	});

	test("a malformed cache file falls back to the bundled snapshot with a classification log", async () => {
		const harness = makeHarness({ bundled: fixtureText, cached: '{"data": [{"torn...' });
		await harness.store.initialize();
		assert.strictEqual(harness.store.lookup.byExactId("openai/gpt-4o-mini").kind, "found");
		assert.ok(harness.logLines.some((line) => line.includes("cache unreadable")));
		assert.ok(!harness.logLines.some((line) => line.includes("torn")), "response/file text leaked into the log");
	});

	test("a valid cache file beats the bundled snapshot", async () => {
		const cached = JSON.stringify({ data: [{ id: "cached/model", context_length: 1234 }] });
		const harness = makeHarness({ bundled: fixtureText, cached });
		await harness.store.initialize();
		assert.strictEqual(harness.store.lookup.byExactId("cached/model").kind, "found");
		assert.strictEqual(harness.store.lookup.byExactId("openai/gpt-4o-mini").kind, "not-found");
	});

	test("a fresh last-success schedules the next refresh a week out; a missing one schedules soon", async () => {
		const now = 1_000_000_000_000;
		const fresh = makeHarness({ bundled: fixtureText, metadata: { lastSuccessAt: now - DAY_MS }, now });
		await fresh.store.initialize();
		assert.deepStrictEqual(
			pendingSchedules(fresh.scheduled).map((call) => call.ms),
			[WEEK_MS - DAY_MS]
		);

		// Advisory metadata lost (globalState reverted): the file still serves
		// and the only cost is an early refresh.
		const reverted = makeHarness({ cached: fixtureText, now });
		await reverted.store.initialize();
		assert.strictEqual(reverted.store.lookup.byExactId("gemma-7b").kind, "found");
		assert.deepStrictEqual(
			pendingSchedules(reverted.scheduled).map((call) => call.ms),
			[MIN_DELAY_MS]
		);

		// A garbage future timestamp cannot push the refresh past a week.
		const skewed = makeHarness({ bundled: fixtureText, metadata: { lastSuccessAt: now + 100 * WEEK_MS }, now });
		await skewed.store.initialize();
		assert.deepStrictEqual(
			pendingSchedules(skewed.scheduled).map((call) => call.ms),
			[WEEK_MS]
		);
	});

	test("a successful refresh swaps the snapshot, persists the slimmed file, and fires onDidUpdate", async () => {
		const harness = makeHarness({ bundled: fixtureText });
		await harness.store.initialize();
		const [initial] = pendingSchedules(harness.scheduled);
		assert.ok(initial !== undefined);
		initial.cb();
		// Concurrent callers share the in-flight refresh: one fetch, one update.
		const first = harness.store.refreshNow();
		assert.strictEqual(harness.store.refreshNow(), first);
		await first;
		assert.strictEqual(harness.fetchCalls, 1);

		assert.strictEqual(harness.updates, 1);
		assert.strictEqual(harness.store.lookup.byExactId("refreshed/model-1").kind, "found");
		assert.strictEqual(harness.store.lookup.byExactId("anthropic/claude-sonnet-4.5").kind, "not-found");

		// The cache file is the slimmed artifact, parseable and complete, and
		// the live payload's pricing blocks did not survive slimming.
		const writtenText = fs.readFileSync(harness.cachePath, "utf8");
		const written = JSON.parse(writtenText) as { data: unknown[] };
		assert.strictEqual(written.data.length, 250);
		assert.ok(!writtenText.includes("pricing"), "pricing keys reached the persisted catalog cache");
		// Temp-then-rename left no temp file behind.
		assert.deepStrictEqual(
			fs.readdirSync(harness.storageDir).filter((name) => name.includes(".tmp")),
			[]
		);
		assert.deepStrictEqual(harness.mementoStore.get(OPENROUTER_CATALOG_METADATA_KEY), {
			lastSuccessAt: 1_000_000_000_000,
		});
		// The next weekly refresh is armed.
		assert.deepStrictEqual(
			pendingSchedules(harness.scheduled).map((call) => call.ms),
			[WEEK_MS]
		);
	});

	test("a failing refresh retries like a discovery GET, keeps the snapshot, and logs a classification", async () => {
		const harness = makeHarness({
			bundled: fixtureText,
			fetchCatalog: async () => {
				throw new Error("ECONNREFUSED 10.0.0.1:443 secret-response-text");
			},
		});
		await harness.store.initialize();
		await harness.store.refreshNow();

		assert.strictEqual(harness.fetchCalls, 3, "one attempt plus the discovery retry budget");
		assert.strictEqual(harness.updates, 0);
		assert.strictEqual(harness.store.lookup.byExactId("anthropic/claude-sonnet-4.5").kind, "found");
		assert.ok(!fs.existsSync(harness.cachePath));
		assert.ok(harness.logLines.some((line) => line === "OpenRouter catalog refresh failed (network error)"));
		assert.ok(
			!harness.logLines.some((line) => line.includes("secret-response-text")),
			"error text leaked into the log"
		);
		// The retry is armed at the failure cadence, not the weekly one.
		assert.deepStrictEqual(
			pendingSchedules(harness.scheduled).map((call) => call.ms),
			[DAY_MS]
		);
		// The dashboard row's status carries the standing failure - the fixed
		// classification vocabulary, never response text - beside the snapshot
		// facts. It stands until the next success clears it.
		const status: OpenRouterCatalogStatus = harness.store.status();
		assert.strictEqual(status.modelCount, 6);
		assert.strictEqual(status.lastSuccessAt, undefined);
		assert.strictEqual(status.refreshing, false);
		assert.strictEqual(status.lastFailure?.classification, "network error");
	});

	test("a payload below the model-count floor counts as failure, never as a truncated catalog", async () => {
		// One valid model is still far under the floor: a truncated live
		// response must not replace the full snapshot.
		const partial = { data: [{ id: "partial/model", context_length: 1000 }] };
		const harness = makeHarness({ bundled: fixtureText, fetchCatalog: async () => partial });
		await harness.store.initialize();
		await harness.store.refreshNow();
		assert.strictEqual(harness.updates, 0);
		assert.strictEqual(harness.store.snapshot().models.length, 6);
		assert.ok(!fs.existsSync(harness.cachePath));
		assert.ok(harness.logLines.some((line) => line.includes("below the 200-model floor")));
		assert.deepStrictEqual(
			pendingSchedules(harness.scheduled).map((call) => call.ms),
			[DAY_MS]
		);
	});

	test("a failed cache write serves from memory but keeps the retry cadence and metadata untouched", async () => {
		const harness = makeHarness({ bundled: fixtureText, unwritableStorage: true });
		await harness.store.initialize();
		await harness.store.refreshNow();

		// The refreshed data serves this session...
		assert.strictEqual(harness.updates, 1);
		assert.strictEqual(harness.store.lookup.byExactId("refreshed/model-1").kind, "found");
		assert.ok(harness.logLines.some((line) => line.includes("cache write failed")));
		// ...but nothing claims durable success: a restart would fall back to
		// the bundled snapshot, so the next attempt comes at the retry cadence.
		assert.strictEqual(harness.mementoStore.get(OPENROUTER_CATALOG_METADATA_KEY), undefined);
		assert.deepStrictEqual(
			pendingSchedules(harness.scheduled).map((call) => call.ms),
			[DAY_MS]
		);
	});

	test("opting out mid-refresh stops the remaining retry attempts silently", async () => {
		let enabled = true;
		const harness = makeHarness({
			bundled: fixtureText,
			enabled: () => enabled,
			fetchCatalog: async () => {
				enabled = false;
				throw new Error("first attempt fails after the user opts out");
			},
		});
		await harness.store.initialize();
		await harness.store.refreshNow();
		assert.strictEqual(harness.fetchCalls, 1, "no retry after the opt-out");
		assert.ok(!harness.logLines.some((line) => line.includes("refresh failed")));
		// The config-change listener reacts to the same toggle by calling
		// applyEnabledSetting, which drops the still-armed schedule.
		harness.store.applyEnabledSetting();
		assert.deepStrictEqual(pendingSchedules(harness.scheduled), []);
	});

	test("opt-out stops scheduling and the implicit lookup while byExactId keeps serving", async () => {
		let enabled = false;
		const harness = makeHarness({ bundled: fixtureText, enabled: () => enabled });
		await harness.store.initialize();
		assert.deepStrictEqual(pendingSchedules(harness.scheduled), []);
		assert.deepStrictEqual(harness.store.lookup.byRawModelId("gemma-7b"), { kind: "not-found" });
		assert.strictEqual(harness.store.lookup.byExactId("gemma-7b").kind, "found");
		// refreshNow under opt-out is a no-op: no network.
		await harness.store.refreshNow();
		assert.strictEqual(harness.fetchCalls, 0);

		// Re-enabling schedules a refresh and reopens the implicit lookup.
		enabled = true;
		harness.store.applyEnabledSetting();
		assert.strictEqual(pendingSchedules(harness.scheduled).length, 1);
		assert.strictEqual(harness.store.lookup.byRawModelId("gemma-7b").kind, "found");

		// Disabling again cancels the pending refresh.
		enabled = false;
		harness.store.applyEnabledSetting();
		assert.deepStrictEqual(pendingSchedules(harness.scheduled), []);
	});

	test("re-enabling while a bailed refresh is still settling leaves the next refresh armed", async () => {
		let enabled = true;
		const harness = makeHarness({ bundled: fixtureText, enabled: () => enabled });
		await harness.store.initialize();
		const [initial] = pendingSchedules(harness.scheduled);
		assert.ok(initial !== undefined);
		// The user disables, but the armed timer fires before the config
		// listener runs: the refresh starts and bails on the disabled check,
		// with its in-flight promise not yet settled.
		enabled = false;
		initial.cb();
		harness.store.applyEnabledSetting();
		// The user re-enables while that refresh is still settling. This must
		// leave a timer pending or a refresh outstanding - previously the
		// in-flight guard skipped scheduling and the bailed refresh armed no
		// follow-up, killing the weekly cadence for the session.
		enabled = true;
		harness.store.applyEnabledSetting();
		// Deliberately the same in-flight promise (nothing has yielded since
		// cb()): this drains the settling refresh, never starts a new one.
		await harness.store.refreshNow();
		assert.strictEqual(harness.fetchCalls, 0, "the disabled refresh reached the network");
		assert.deepStrictEqual(
			pendingSchedules(harness.scheduled).map((call) => call.ms),
			[MIN_DELAY_MS]
		);
	});

	test("a refresh aborted mid-retry by opt-out re-arms on the next enable", async () => {
		let enabled = true;
		const harness = makeHarness({
			bundled: fixtureText,
			enabled: () => enabled,
			fetchCatalog: async () => {
				if (harness.fetchCalls === 2) {
					enabled = false;
				}
				throw new Error("transient failure");
			},
		});
		await harness.store.initialize();
		const [initial] = pendingSchedules(harness.scheduled);
		assert.ok(initial !== undefined);
		initial.cb();
		await harness.store.refreshNow();
		assert.strictEqual(harness.fetchCalls, 2, "retries continued after the opt-out");
		assert.ok(!harness.logLines.some((line) => line.includes("refresh failed")));
		assert.deepStrictEqual(pendingSchedules(harness.scheduled), []);

		enabled = true;
		harness.store.applyEnabledSetting();
		assert.deepStrictEqual(
			pendingSchedules(harness.scheduled).map((call) => call.ms),
			[MIN_DELAY_MS]
		);
	});

	test("dispose cancels the pending refresh", async () => {
		const harness = makeHarness({ bundled: fixtureText });
		await harness.store.initialize();
		harness.store.dispose();
		assert.deepStrictEqual(pendingSchedules(harness.scheduled), []);
	});

	test("dispose during an in-flight refresh settles it silently", async () => {
		const harness = makeHarness({
			bundled: fixtureText,
			fetchCatalog: (signal) =>
				new Promise((_, reject) => {
					signal.addEventListener("abort", () => reject(new Error("aborted mid-flight")));
				}),
		});
		await harness.store.initialize();
		const refresh = harness.store.refreshNow();
		harness.store.dispose();
		await refresh;
		assert.ok(!harness.logLines.some((line) => line.includes("refresh failed")));
		assert.strictEqual(harness.updates, 0);
		assert.deepStrictEqual(pendingSchedules(harness.scheduled), []);
	});

	test("the real fetch classifies an HTTP failure by status only, leaking no response text", async () => {
		const harness = makeHarness({ bundled: fixtureText, useDefaultFetch: true });
		await harness.store.initialize();
		await withFetch(
			async () => new Response("upstream-secret-body", { status: 503 }),
			() => harness.store.refreshNow()
		);
		assert.ok(harness.logLines.some((line) => line === "OpenRouter catalog refresh failed (HTTP 503)"));
		assert.ok(!harness.logLines.some((line) => line.includes("upstream-secret-body")), "response body reached the log");
		assert.strictEqual(harness.store.snapshot().models.length, 6);
	});

	test("the real fetch classifies a non-JSON body as unparseable, leaking no response text", async () => {
		const harness = makeHarness({ bundled: fixtureText, useDefaultFetch: true });
		await harness.store.initialize();
		await withFetch(
			async () => new Response("<html>interstitial-page</html>", { status: 200 }),
			() => harness.store.refreshNow()
		);
		assert.ok(harness.logLines.some((line) => line === "OpenRouter catalog refresh failed (unparseable response)"));
		assert.ok(!harness.logLines.some((line) => line.includes("interstitial-page")), "response body reached the log");
	});
});
