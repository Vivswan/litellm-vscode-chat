import * as assert from "node:assert";
import { HttpResponse, http } from "msw";
import * as vscode from "vscode";
import {
	discoveryHandlers,
	emptyErrorResponse,
	MODEL_INFO_URL,
	MODELS_URL,
	mswServer,
	TEST_BASE_URL,
	useMsw,
} from "../mocks/handlers";
import { DEFAULT_DISCOVERY_PAYLOAD, expectDefined, withFetch } from "../pureHelpers";
import { makeProvider, withConfig } from "../testUtils";

/** The host passes the group configuration structurally; stable typings only declare `silent`. */
function groupOptions(configuration: unknown, silent = true): { silent: boolean } {
	return { silent, configuration } as { silent: boolean };
}

const cancellation = () => new vscode.CancellationTokenSource().token;

suite("provider server snapshots", () => {
	useMsw();

	test("a group refresh records the group's models without attaching the server credentials", async () => {
		const provider = makeProvider();
		mswServer.use(...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD));

		await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: TEST_BASE_URL, apiKey: "group-secret" }),
			cancellation()
		);

		const snapshots = provider.getServerSnapshots();
		assert.strictEqual(snapshots.length, 1);
		const snapshot = expectDefined(snapshots[0]);
		assert.strictEqual(snapshot.status.state, "ok");
		const model = expectDefined(snapshot.models[0]);
		assert.strictEqual(model.id, "test-model");
		assert.strictEqual(model.litellm.server, undefined, "snapshot models must stay credential-free");
		assert.ok(!JSON.stringify(snapshots).includes("group-secret"), "no credential may leak into the snapshot");
	});

	test("a failing group refresh records an error status with no models", async () => {
		const provider = makeProvider();
		mswServer.use(
			http.get(MODEL_INFO_URL, () => emptyErrorResponse(404)),
			http.get(MODELS_URL, () => emptyErrorResponse(404))
		);

		await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: TEST_BASE_URL, apiKey: "k" }),
			cancellation()
		);

		const snapshots = provider.getServerSnapshots();
		const snapshot = expectDefined(snapshots[0]);
		assert.strictEqual(snapshot.status.state, "error");
		assert.deepStrictEqual(snapshot.models, []);
	});

	test("a discovery 404 stamps the base-URL classification on the error status", async () => {
		// The classification rides statusErrorTexts onto the ServerStatusError,
		// so the extension's status surfaces can render the setup hint.
		const provider = makeProvider();
		mswServer.use(
			http.get(MODEL_INFO_URL, () => emptyErrorResponse(404)),
			http.get(MODELS_URL, () => emptyErrorResponse(404))
		);

		await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: TEST_BASE_URL, apiKey: "k" }),
			cancellation()
		);

		const status = expectDefined(provider.getServerSnapshots()[0]).status;
		assert.ok(status.state === "error", "expected an error status");
		assert.deepStrictEqual(status.classification, { kind: "http", status: 404, setupHint: "check-base-url" });
	});

	// msw cannot fabricate undici's ECONNREFUSED cause chain, so this stays on
	// withFetch; the swap also keeps the request away from msw's
	// unhandled-request guard.
	test("a refused connection stamps the proxy-not-running classification on the error status", async () => {
		const provider = makeProvider(TEST_BASE_URL);

		await withFetch(
			async () => {
				throw Object.assign(new TypeError("fetch failed"), {
					cause: new Error("connect ECONNREFUSED 127.0.0.1:4000"),
				});
			},
			async () => {
				await provider.provideLanguageModelChatInformation({ silent: true }, cancellation());
			}
		);

		const status = expectDefined(provider.getServerSnapshots()[0]).status;
		assert.ok(status.state === "error", "expected an error status");
		assert.deepStrictEqual(status.classification, { kind: "connection", setupHint: "proxy-not-running" });
	});

	test("a cached group refresh still records the models", async () => {
		const provider = makeProvider();
		mswServer.use(...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD));
		const configuration = groupOptions({ baseUrl: TEST_BASE_URL, apiKey: "k" });

		await provider.provideLanguageModelChatInformation(configuration, cancellation());
		// Second refresh in the same cycle is served from the discovery cache.
		await provider.provideLanguageModelChatInformation(configuration, cancellation());

		const snapshot = expectDefined(provider.getServerSnapshots()[0]);
		assert.strictEqual(snapshot.models.length, 1);
	});

	test("an apiVersion edit misses the discovery cache instead of serving the old root's models", async () => {
		// The cache key (group client ID) deliberately excludes apiVersion, so the
		// stored entry's apiRoot is what keeps an edit from serving stale models.
		let apiVersion: string | undefined;
		const provider = makeProvider(undefined, "test-key", undefined, {
			getEntryApiVersion: () => apiVersion,
		});
		let versionedHits = 0;
		let rootHits = 0;
		mswServer.use(
			http.get(MODEL_INFO_URL, () => {
				versionedHits += 1;
				return HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD);
			}),
			http.get(`${TEST_BASE_URL}/model/info`, () => {
				rootHits += 1;
				return HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD);
			})
		);
		const configuration = groupOptions({ baseUrl: TEST_BASE_URL, apiKey: "k", label: "prod" });

		await provider.provideLanguageModelChatInformation(configuration, cancellation());
		await provider.provideLanguageModelChatInformation(configuration, cancellation());
		assert.strictEqual(versionedHits, 1, "the second same-root refresh must serve from the cache");
		assert.strictEqual(rootHits, 0);

		apiVersion = "";
		await provider.provideLanguageModelChatInformation(configuration, cancellation());
		assert.strictEqual(rootHits, 1, "the new root must be fetched, not the old root's cache served");
		const snapshot = expectDefined(provider.getServerSnapshots()[0]);
		assert.strictEqual(snapshot.status.state, "ok");
		assert.strictEqual(snapshot.models.length, 1);
	});

	test("a serve that joins an in-flight old-root discovery refetches at the new root", async () => {
		// Single-flight is keyed by group ID alone: without the post-await root check, a
		// refresh arriving mid-flight would join the old root's discovery and serve its
		// models once. Two concurrent joiners pin the dropStored subtlety: the second
		// corrector must join the first's fresh reload without stripping its right to cache.
		let apiVersion: string | undefined;
		const provider = makeProvider(undefined, "test-key", undefined, {
			getEntryApiVersion: () => apiVersion,
		});
		let releaseFirst = (): void => {};
		const gate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let rootHits = 0;
		mswServer.use(
			http.get(MODEL_INFO_URL, async () => {
				await gate;
				return HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD);
			}),
			http.get(`${TEST_BASE_URL}/model/info`, () => {
				rootHits += 1;
				return HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD);
			})
		);
		const configuration = groupOptions({ baseUrl: TEST_BASE_URL, apiKey: "k", label: "prod" });

		const first = provider.provideLanguageModelChatInformation(configuration, cancellation());
		await new Promise((resolve) => setTimeout(resolve, 25));
		apiVersion = "";
		const joinerA = provider.provideLanguageModelChatInformation(configuration, cancellation());
		const joinerB = provider.provideLanguageModelChatInformation(configuration, cancellation());
		await new Promise((resolve) => setTimeout(resolve, 25));
		releaseFirst();
		await Promise.all([first, joinerA, joinerB]);
		assert.strictEqual(rootHits, 1, "the joiners must share one corrected fetch at the new root");

		await provider.provideLanguageModelChatInformation(configuration, cancellation());
		assert.strictEqual(rootHits, 1, "the corrected result must have been cached for the follow-up serve");
	});

	test("snapshots carry the discovered raw IDs, carried forward across failure reports", async () => {
		// The set behind declared-ID inertness (and the dashboard's declared
		// projection): what discovery RETURNED, not what registration emitted -
		// synthetic variants may be the only registered forms of a discovered ID.
		const provider = makeProvider();
		let fail = false;
		const payload = {
			data: [
				{
					id: "multi-model",
					providers: [
						{ provider: "groq", status: "active", supports_tools: true },
						{ provider: "together", status: "active", supports_tools: true },
					],
				},
			],
		};
		mswServer.use(
			http.get(MODEL_INFO_URL, () => (fail ? emptyErrorResponse(500) : HttpResponse.json(payload))),
			http.get(MODELS_URL, () => (fail ? emptyErrorResponse(500) : HttpResponse.json(payload)))
		);

		await withConfig({ "discovery.cacheTtl": 0 }, async () => {
			await provider.provideLanguageModelChatInformation(groupOptions({ baseUrl: TEST_BASE_URL }), cancellation());
			const healthy = expectDefined(provider.getServerSnapshots()[0]);
			assert.deepStrictEqual(healthy.discoveredRawIds, ["multi-model"]);
			assert.ok(
				healthy.models.every((model) => model.id !== "multi-model"),
				"only synthetic variants registered, which is why the raw-ID set must ride separately"
			);

			fail = true;
			await provider.provideLanguageModelChatInformation(groupOptions({ baseUrl: TEST_BASE_URL }), cancellation());
			const failed = expectDefined(provider.getServerSnapshots()[0]);
			assert.strictEqual(failed.status.state, "error");
			assert.deepStrictEqual(failed.discoveredRawIds, ["multi-model"], "failure reports carry the set forward");
		});
	});

	test("snapshots carry the observed model_info keys, carried forward across failure reports", async () => {
		const provider = makeProvider();
		let fail = false;
		mswServer.use(
			http.get(MODEL_INFO_URL, () => (fail ? emptyErrorResponse(500) : HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD))),
			http.get(MODELS_URL, () => (fail ? emptyErrorResponse(500) : HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD)))
		);

		await withConfig({ "discovery.cacheTtl": 0 }, async () => {
			await provider.provideLanguageModelChatInformation(groupOptions({ baseUrl: TEST_BASE_URL }), cancellation());
			const healthy = expectDefined(provider.getServerSnapshots()[0]);
			assert.deepStrictEqual(
				healthy.observedModelInfoKeys,
				["id", "max_input_tokens", "max_output_tokens", "supports_function_calling"],
				"a successful /model/info listing records its observed keys, sorted"
			);

			fail = true;
			await provider.provideLanguageModelChatInformation(groupOptions({ baseUrl: TEST_BASE_URL }), cancellation());
			const failed = expectDefined(provider.getServerSnapshots()[0]);
			assert.strictEqual(failed.status.state, "error");
			assert.deepStrictEqual(
				failed.observedModelInfoKeys,
				["id", "max_input_tokens", "max_output_tokens", "supports_function_calling"],
				"a mid-outage refresh must not blank the observed-key set"
			);
		});
	});

	test("a group discovered through the /v1/models fallback records no observed model_info keys", async () => {
		const provider = makeProvider();
		mswServer.use(
			http.get(MODEL_INFO_URL, () => emptyErrorResponse(404)),
			http.get(MODELS_URL, () => HttpResponse.json({ object: "list", data: [{ id: "fallback-model" }] }))
		);

		await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: TEST_BASE_URL, apiKey: "k" }),
			cancellation()
		);

		const snapshot = expectDefined(provider.getServerSnapshots()[0]);
		assert.strictEqual(snapshot.status.state, "ok");
		assert.strictEqual(
			snapshot.observedModelInfoKeys,
			undefined,
			"the fallback listing observes no model_info, so the snapshot must not claim an empty set"
		);
	});

	test("a later fallback-only success replaces the observed keys with absence, like discoveredRawIds", async () => {
		// Carry-forward is a failure-report rule only: a SUCCESSFUL refresh replaces
		// the observations wholesale, so a server that degrades to the /models
		// fallback stops claiming keys its current listing no longer reports.
		const provider = makeProvider();
		let fallbackOnly = false;
		mswServer.use(
			http.get(MODEL_INFO_URL, () =>
				fallbackOnly ? emptyErrorResponse(404) : HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD)
			),
			http.get(MODELS_URL, () => HttpResponse.json({ object: "list", data: [{ id: "test-model" }] }))
		);

		await withConfig({ "discovery.cacheTtl": 0 }, async () => {
			await provider.provideLanguageModelChatInformation(groupOptions({ baseUrl: TEST_BASE_URL }), cancellation());
			assert.notStrictEqual(expectDefined(provider.getServerSnapshots()[0]).observedModelInfoKeys, undefined);

			fallbackOnly = true;
			await provider.provideLanguageModelChatInformation(groupOptions({ baseUrl: TEST_BASE_URL }), cancellation());
			const degraded = expectDefined(provider.getServerSnapshots()[0]);
			assert.strictEqual(degraded.status.state, "ok");
			assert.strictEqual(degraded.observedModelInfoKeys, undefined);
		});
	});

	test("hasSeenGroupConfiguration latches when the host hands a group, before any snapshot exists", async () => {
		const provider = makeProvider();
		// A failing discovery, so the group produces no snapshot rows even though
		// the host handed a group configuration: the latch must not depend on a
		// successful fetch.
		mswServer.use(
			http.get(MODEL_INFO_URL, () => emptyErrorResponse(404)),
			http.get(MODELS_URL, () => emptyErrorResponse(404))
		);

		// Cold start: no group configuration seen, no snapshots.
		assert.strictEqual(provider.hasSeenGroupConfiguration(), false);
		assert.strictEqual(provider.getServerSnapshots().length, 0);

		// The host performs the groupless refresh first; it reports an empty
		// window and must not flip the latch.
		await provider.provideLanguageModelChatInformation({ silent: true }, cancellation());
		assert.strictEqual(
			provider.hasSeenGroupConfiguration(),
			false,
			"the groupless refresh proves nothing about groups"
		);

		// Then a per-group refresh arrives: the latch flips the moment the host
		// hands the configuration, independent of the fetch outcome.
		await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: TEST_BASE_URL, apiKey: "k" }),
			cancellation()
		);
		assert.strictEqual(provider.hasSeenGroupConfiguration(), true);
	});

	test("a malformed group configuration still latches: the host offered a group", async () => {
		const provider = makeProvider();

		await provider.provideLanguageModelChatInformation(groupOptions({ baseUrl: 42 }), cancellation());

		assert.strictEqual(provider.hasSeenGroupConfiguration(), true);
		assert.strictEqual(provider.getServerSnapshots().length, 0, "a malformed group yields no snapshot");
	});

	test("the recorded snapshot carries the declared models exactly as the serve handed them out", async () => {
		// Declarations are entry-level: both declared models ride the Gateway entry.
		// The window records the served set itself (no dashboard-side projection),
		// so identity, names, and the entry layer cannot diverge from the serve.
		const provider = makeProvider(undefined, "test-key", undefined, {
			getEntryDeclaredModels: (label, baseUrl) =>
				label === "Gateway" && baseUrl === TEST_BASE_URL ? ["entry-model", "declared-model"] : undefined,
			getEntryModelCapabilities: (label, baseUrl) =>
				label === "Gateway" && baseUrl === TEST_BASE_URL ? { "declared-model": { context_length: 32000 } } : undefined,
		});
		mswServer.use(...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD));
		const idAndName = (infos: readonly { id: string; name: string }[]) =>
			infos.map(({ id, name }) => ({ id, name })).sort((a, b) => a.id.localeCompare(b.id));
		const declaredIds = new Set(["entry-model", "declared-model"]);

		await withConfig({}, async () => {
			const infos = await provider.provideLanguageModelChatInformation(
				groupOptions({ baseUrl: TEST_BASE_URL, apiKey: "k", label: "Gateway" }),
				cancellation()
			);
			const served = idAndName(infos.filter((info) => declaredIds.has(info.id)));
			assert.deepStrictEqual(served, [
				{ id: "declared-model", name: "declared-model" },
				{ id: "entry-model", name: "entry-model" },
			]);

			const snapshot = expectDefined(provider.getServerSnapshots()[0]);
			assert.deepStrictEqual(
				idAndName(snapshot.models.filter((info) => declaredIds.has(info.id))),
				served,
				"the window must record exactly the declared models the serve handed out"
			);
			assert.deepStrictEqual(
				snapshot.models.filter((info) => declaredIds.has(info.id)).map((info) => info.litellm.declared),
				[true, true],
				"recorded declared models carry the declared marker the dashboard badges on"
			);
			assert.strictEqual(
				snapshot.models.length,
				snapshot.status.servedModelCount,
				"the recorded list and the recorded count describe the same set"
			);
		});
	});
});
