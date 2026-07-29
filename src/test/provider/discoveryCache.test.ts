import * as assert from "node:assert";
import { HttpResponse, http } from "msw";
import * as vscode from "vscode";
import { LiteLLMChatModelProvider } from "../../provider";
import { DiscoveryCache } from "../../provider/discoveryCache";
import { groupClientId, type PreAttachModelInfo } from "../../provider/groupModels";
import { normalizeBaseUrl } from "../../shared/baseUrl";
import type { AggregatedStatus } from "../../shared/servers";
import { emptyErrorResponse, MODEL_INFO_URL, MODELS_URL, mswServer, TEST_BASE_URL, useMsw } from "../mocks/handlers";
import { DEFAULT_DISCOVERY_PAYLOAD, expectDefined, makeProvider, withConfig } from "../testUtils";

/** A manually advanced clock: the cache's one injectable time seam. */
function makeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
	let time = start;
	return {
		now: () => time,
		advance: (ms) => {
			time += ms;
		},
	};
}

suite("provider/discoveryCache", () => {
	test("concurrent fetches for one key share a single load", async () => {
		const cache = new DiscoveryCache<string>(makeClock().now);
		let loads = 0;
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const load = async () => {
			loads += 1;
			await gate;
			return "value";
		};

		const results = Promise.all([cache.fetch("k", load), cache.fetch("k", load), cache.fetch("k", load)]);
		expectDefined(release)();

		assert.deepStrictEqual(await results, ["value", "value", "value"]);
		assert.strictEqual(loads, 1, "all concurrent callers must share one load");
	});

	test("a stored result is served by lookup until the TTL elapses", async () => {
		const clock = makeClock();
		const cache = new DiscoveryCache<string>(clock.now);
		await cache.fetch("k", async () => "value");

		clock.advance(999);
		assert.strictEqual(cache.lookup("k", 1000), "value");
		clock.advance(1);
		assert.strictEqual(cache.lookup("k", 1000), undefined, "an entry exactly TTL old must not be served");
	});

	test("a TTL of 0 never serves from the store", async () => {
		const cache = new DiscoveryCache<string>(makeClock().now);
		await cache.fetch("k", async () => "value");
		assert.strictEqual(cache.lookup("k", 0), undefined);
	});

	test("a lowered TTL applies to results stored before the change", async () => {
		const clock = makeClock();
		const cache = new DiscoveryCache<string>(clock.now);
		await cache.fetch("k", async () => "value");
		clock.advance(5000);
		assert.strictEqual(cache.lookup("k", 10000), "value");
		assert.strictEqual(cache.lookup("k", 1000), undefined);
	});

	test("an entry found expired is dropped, not just skipped", async () => {
		const clock = makeClock();
		const cache = new DiscoveryCache<string>(clock.now);
		await cache.fetch("k", async () => "value");
		clock.advance(2000);

		assert.strictEqual(cache.lookup("k", 1000), undefined, "the entry is expired under this TTL");
		assert.strictEqual(cache.lookup("k", 10000), undefined, "the expired lookup must have deleted the entry");
	});

	test("a failed load is not stored and every joiner sees the rejection", async () => {
		const cache = new DiscoveryCache<string>(makeClock().now);
		let loads = 0;
		const failing = async (): Promise<string> => {
			loads += 1;
			throw new Error("boom");
		};

		const first = cache.fetch("k", failing);
		const second = cache.fetch("k", failing);
		await assert.rejects(first, /boom/);
		await assert.rejects(second, /boom/);
		assert.strictEqual(loads, 1, "the concurrent calls must have shared the failing load");
		assert.strictEqual(cache.lookup("k", Number.MAX_SAFE_INTEGER), undefined, "failures must not be stored");

		assert.strictEqual(
			await cache.fetch("k", async () => "recovered"),
			"recovered",
			"the call after a failure must load again"
		);
	});

	test("a load started before clear() does not store its result", async () => {
		const cache = new DiscoveryCache<string>(makeClock().now);
		let loads = 0;
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});

		const inFlight = cache.fetch("k", async () => {
			loads += 1;
			await gate;
			return "pre-clear";
		});
		cache.clear();
		expectDefined(release)();

		assert.strictEqual(await inFlight, "pre-clear", "the caller of the old load still gets its value");
		assert.strictEqual(
			cache.lookup("k", Number.MAX_SAFE_INTEGER),
			undefined,
			"a result loaded before the clear must not be stored after it"
		);
		assert.strictEqual(await cache.fetch("k", async () => "post-clear"), "post-clear");
		assert.strictEqual(loads, 1, "the next fetch after the clear must load again");
	});

	test("keys are independent and invalidate/clear drop stored results", async () => {
		const cache = new DiscoveryCache<string>(makeClock().now);
		await cache.fetch("a", async () => "A");
		await cache.fetch("b", async () => "B");
		assert.strictEqual(cache.lookup("a", 1000), "A");
		assert.strictEqual(cache.lookup("b", 1000), "B");

		cache.invalidate("a");
		assert.strictEqual(cache.lookup("a", 1000), undefined);
		assert.strictEqual(cache.lookup("b", 1000), "B", "invalidating one key must not touch the others");

		cache.clear();
		assert.strictEqual(cache.lookup("b", 1000), undefined);
	});

	test("prune drops every entry whose key is not kept", async () => {
		const cache = new DiscoveryCache<string>(makeClock().now);
		await cache.fetch("keep-me", async () => "kept");
		await cache.fetch("drop-me", async () => "dropped");

		cache.prune(["keep-me", "never-stored"]);

		assert.strictEqual(cache.lookup("keep-me", 1000), "kept");
		assert.strictEqual(cache.lookup("drop-me", 1000), undefined, "unkept entries must be dropped");
	});
});

suite("provider group discovery caching", () => {
	useMsw();

	/** The host passes the group configuration structurally; stable typings only declare `silent`. */
	function groupOptions(configuration: unknown, silent = true): { silent: boolean } {
		return { silent, configuration } as { silent: boolean };
	}

	const cancellation = () => new vscode.CancellationTokenSource().token;
	const GROUP = { baseUrl: TEST_BASE_URL, apiKey: "group-key" };

	/** Counting discovery handlers; one provider-side fetch is one /v1/model/info hit. */
	function countingHandlers(): { hits: () => number } {
		let hits = 0;
		mswServer.use(
			http.get(MODEL_INFO_URL, () => {
				hits += 1;
				return HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD);
			}),
			http.get(MODELS_URL, () => HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD))
		);
		return { hits: () => hits };
	}

	test("concurrent group refreshes share one discovery request and all callers get the models", async () => {
		const provider = makeProvider();
		const counter = countingHandlers();

		const results = await Promise.all(
			Array.from({ length: 5 }, () => provider.provideLanguageModelChatInformation(groupOptions(GROUP), cancellation()))
		);

		assert.strictEqual(counter.hits(), 1, "the burst must collapse into a single discovery request");
		for (const infos of results) {
			assert.strictEqual(infos.length, 1);
			const info = expectDefined(infos[0]);
			assert.strictEqual(info.id, "test-model");
			assert.strictEqual(info.litellm.server?.baseUrl, GROUP.baseUrl, "every caller must get the attached server");
		}
	});

	test("cancelling one joiner's token does not abort the shared load", async () => {
		const provider = makeProvider();
		const counter = countingHandlers();

		const source = new vscode.CancellationTokenSource();
		const kept = provider.provideLanguageModelChatInformation(groupOptions(GROUP), cancellation());
		const canceled = provider.provideLanguageModelChatInformation(groupOptions(GROUP), source.token);
		source.cancel();

		assert.strictEqual((await kept).length, 1, "the surviving caller must still get its models");
		assert.strictEqual((await canceled).length, 1);
		assert.strictEqual(counter.hits(), 1, "the shared load must have run to completion exactly once");
	});

	test("a refresh within the TTL is served from the cache and still reports the remembered status", async () => {
		const provider = makeProvider();
		const counter = countingHandlers();
		await provider.provideLanguageModelChatInformation(groupOptions(GROUP), cancellation());

		const statuses: AggregatedStatus[] = [];
		provider.setStatusCallback((status) => statuses.push(status));
		const infos = await provider.provideLanguageModelChatInformation(groupOptions(GROUP), cancellation());

		assert.strictEqual(counter.hits(), 1, "the second refresh must not reach the network");
		assert.strictEqual(expectDefined(infos[0]).litellm.server?.baseUrl, GROUP.baseUrl);
		const status = expectDefined(statuses.at(-1), "the cached hit must still report status");
		const serverStatus = expectDefined(status.serverStatuses[0]);
		assert.strictEqual(serverStatus.state, "ok");
		assert.strictEqual(serverStatus.modelCount, 1);
	});

	test("a cached hit reports with the caller's silent flag, not a remembered one", async () => {
		const provider = makeProvider();
		countingHandlers();
		await provider.provideLanguageModelChatInformation(groupOptions(GROUP, true), cancellation());

		const statuses: AggregatedStatus[] = [];
		provider.setStatusCallback((status) => statuses.push(status));
		await provider.provideLanguageModelChatInformation(groupOptions(GROUP, false), cancellation());
		assert.strictEqual(expectDefined(statuses.at(-1)).silent, false);
		await provider.provideLanguageModelChatInformation(groupOptions(GROUP, true), cancellation());
		assert.strictEqual(expectDefined(statuses.at(-1)).silent, true);
	});

	test("an expired entry is refetched", async () => {
		const clock = makeClock();
		const provider = new LiteLLMChatModelProvider(
			"GitHubCopilotChat/test VSCode/test",
			undefined,
			new DiscoveryCache<readonly PreAttachModelInfo[]>(clock.now)
		);
		const counter = countingHandlers();
		await provider.provideLanguageModelChatInformation(groupOptions(GROUP), cancellation());

		clock.advance(60 * 60 * 1000);
		const infos = await provider.provideLanguageModelChatInformation(groupOptions(GROUP), cancellation());

		assert.strictEqual(infos.length, 1);
		assert.strictEqual(counter.hits(), 2, "a refresh past the TTL must hit the network again");
	});

	test("a failed refresh is not cached; the next refresh reaches the server", async () => {
		const provider = makeProvider();
		mswServer.use(
			http.get(MODEL_INFO_URL, () => emptyErrorResponse(500)),
			http.get(MODELS_URL, () => emptyErrorResponse(500))
		);
		const failed = await provider.provideLanguageModelChatInformation(groupOptions(GROUP), cancellation());
		assert.deepStrictEqual(failed, []);

		mswServer.use(
			http.get(MODEL_INFO_URL, () => HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD)),
			http.get(MODELS_URL, () => HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD))
		);
		const infos = await provider.provideLanguageModelChatInformation(groupOptions(GROUP), cancellation());
		assert.strictEqual(infos.length, 1, "the refresh after a failure must fetch fresh models, not a cached failure");
	});

	test("discoveryCacheTtl 0 fetches every time but concurrent refreshes still coalesce", async () => {
		const provider = makeProvider();
		const counter = countingHandlers();

		await withConfig({ discoveryCacheTtl: 0 }, async () => {
			await provider.provideLanguageModelChatInformation(groupOptions(GROUP), cancellation());
			await provider.provideLanguageModelChatInformation(groupOptions(GROUP), cancellation());
			assert.strictEqual(counter.hits(), 2, "with TTL 0 every sequential refresh must reach the network");

			await Promise.all(
				Array.from({ length: 4 }, () =>
					provider.provideLanguageModelChatInformation(groupOptions(GROUP), cancellation())
				)
			);
			assert.strictEqual(counter.hits(), 3, "TTL 0 must not disable single-flight coalescing");
		});
	});

	test("refreshViaHost bypasses the cache and its probe repopulates it", async () => {
		const provider = makeProvider();
		const counter = countingHandlers();
		await provider.provideLanguageModelChatInformation(groupOptions(GROUP), cancellation());
		assert.strictEqual(counter.hits(), 1);

		// This provider is not registered with the host, so the change event goes
		// nowhere and refreshViaHost falls back to probing the observed group.
		await provider.refreshViaHost(300, 50);
		assert.strictEqual(counter.hits(), 2, "the explicit refresh must reach the network despite the cached entry");

		const infos = await provider.provideLanguageModelChatInformation(groupOptions(GROUP), cancellation());
		assert.strictEqual(infos.length, 1);
		assert.strictEqual(counter.hits(), 2, "the probe's fresh result must repopulate the cache");
	});

	test("a sweep served from the cache keeps every group in the merged status", async () => {
		const provider = makeProvider();
		provider.setGrouplessRegistryEnabled(() => false);
		const statuses: AggregatedStatus[] = [];
		provider.setStatusCallback((status) => statuses.push(status));
		const counter = countingHandlers();
		mswServer.use(
			http.get("http://litellm.test:8080/v1/model/info", () => HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD)),
			http.get("http://litellm.test:8080/v1/models", () => HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD))
		);
		const groupless = () => provider.provideLanguageModelChatInformation({ silent: true }, cancellation());
		const fetchGroup = (baseUrl: string) =>
			provider.provideLanguageModelChatInformation(groupOptions({ baseUrl }), cancellation());

		// Two full sweeps within the TTL: the second is answered from the cache.
		await groupless();
		await fetchGroup(TEST_BASE_URL);
		await fetchGroup("http://litellm.test:8080");
		await groupless();
		await fetchGroup(TEST_BASE_URL);
		await fetchGroup("http://litellm.test:8080");

		assert.strictEqual(counter.hits(), 1, "the second sweep must be served from the cache");
		const last = expectDefined(statuses.at(-1));
		assert.strictEqual(last.serverStatuses.length, 2, "cached sweeps must keep both groups in the merged status");
		assert.strictEqual(last.totalModels, 2);
	});

	test("a rotated group key evicts the old credentials' entry once its status ages out", async () => {
		const provider = makeProvider();
		provider.setGrouplessRegistryEnabled(() => false);
		countingHandlers();
		const oldGroup = { baseUrl: normalizeBaseUrl(TEST_BASE_URL), apiKey: "old-key" };
		const newGroup = { baseUrl: normalizeBaseUrl(TEST_BASE_URL), apiKey: "new-key" };
		const internals = provider as unknown as { _discoveryCache: DiscoveryCache<unknown> };
		const groupless = () => provider.provideLanguageModelChatInformation({ silent: true }, cancellation());

		await groupless();
		await provider.provideLanguageModelChatInformation(groupOptions(oldGroup), cancellation());
		assert.notStrictEqual(
			internals._discoveryCache.lookup(groupClientId(oldGroup), Number.MAX_SAFE_INTEGER),
			undefined
		);

		// The rotated key stops the old identity from reporting; after its
		// one-cycle grace the sweep's prune must take the cache entry with it.
		await groupless();
		await provider.provideLanguageModelChatInformation(groupOptions(newGroup), cancellation());
		await groupless();

		assert.strictEqual(
			internals._discoveryCache.lookup(groupClientId(oldGroup), Number.MAX_SAFE_INTEGER),
			undefined,
			"the old key's entry embeds rotated-away credentials and must be pruned"
		);
		assert.notStrictEqual(
			internals._discoveryCache.lookup(groupClientId(newGroup), Number.MAX_SAFE_INTEGER),
			undefined,
			"the live key's entry must survive the prune"
		);
	});
});
