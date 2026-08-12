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
import { DEFAULT_DISCOVERY_PAYLOAD, expectDefined, makeProvider, withConfig, withFetch } from "../testUtils";

/** The host passes the group configuration structurally; stable typings only declare `silent`. */
function groupOptions(configuration: unknown, silent = true): { silent: boolean } {
	return { silent, configuration } as { silent: boolean };
}

const cancellation = () => new vscode.CancellationTokenSource().token;

suite("provider server snapshots", () => {
	useMsw();

	test("a registry sweep records each server's status together with its built models", async () => {
		const provider = makeProvider(TEST_BASE_URL);
		mswServer.use(...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD));

		await provider.provideLanguageModelChatInformation({ silent: true }, cancellation());

		const snapshots = provider.getServerSnapshots();
		assert.strictEqual(snapshots.length, 1);
		const snapshot = expectDefined(snapshots[0]);
		assert.strictEqual(snapshot.status.state, "ok");
		assert.strictEqual(snapshot.status.modelCount, 1);
		assert.strictEqual(snapshot.models.length, 1);
		assert.strictEqual(expectDefined(snapshot.models[0]).id, "test-model");
	});

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

	// msw cannot fabricate undici's ECONNREFUSED cause chain (the precedent is
	// discovery.test.ts), so this stays on withFetch; the swap also keeps the
	// request away from msw's unhandled-request guard.
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
		// The cache key (group client ID) deliberately excludes apiVersion, so
		// the stored entry's apiRoot is what keeps an edit from serving stale
		// models for the rest of the TTL.
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
		// Single-flight is keyed by group ID alone: without the post-await root
		// check, a refresh arriving while the old root's discovery is still in
		// flight would join it and serve the old root's models once. Two
		// concurrent joiners pin the dropStored subtlety: the second corrector
		// must join the first's fresh reload without stripping its right to
		// cache, so the follow-up serve hits the cache instead of the network.
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
		// Carry-forward is a failure-report rule only: a SUCCESSFUL refresh
		// replaces the observations wholesale, so a server that degrades from
		// /model/info to the /models fallback stops claiming keys its current
		// listing no longer reports.
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

	test("the declared projection composes exactly like the registry sweep: same IDs, names, and entry layer", async () => {
		// A multi-server sweep, so exposed IDs are namespaced and names carry
		// the server prefix: a projection reverting to serverCount 1 would mint
		// raw IDs and bare names, and one resolving the entry layer from the
		// snapshot's display label instead of the sweep's recorded identity
		// would drop the entry-level declaration. Both must fail here.
		const SECOND_BASE_URL = "http://second.test";
		const servers = [
			{ id: "srv1", label: "Gateway", baseUrl: TEST_BASE_URL, apiKey: "k1" },
			{ id: "srv2", label: "Other", baseUrl: SECOND_BASE_URL, apiKey: "k2" },
		];
		const provider = makeProvider(undefined, "test-key", undefined, {
			getServers: () => Promise.resolve(servers),
			// Declarations are entry-level (the entry's discovery.declared list);
			// both declared models ride the Gateway entry, one with a capability
			// record beside it.
			getEntryDeclaredModels: (label, baseUrl) =>
				label === "Gateway" && baseUrl === TEST_BASE_URL ? ["entry-model", "declared-model"] : undefined,
			getEntryModelCapabilities: (label, baseUrl) =>
				label === "Gateway" && baseUrl === TEST_BASE_URL ? { "declared-model": { context_length: 32000 } } : undefined,
		});
		mswServer.use(
			...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD),
			http.get(`${SECOND_BASE_URL}/v1/model/info`, () => HttpResponse.json({ data: [] })),
			http.get(`${SECOND_BASE_URL}/v1/models`, () => HttpResponse.json({ data: [] }))
		);
		const idAndName = (infos: readonly { id: string; name: string }[]) =>
			infos.map(({ id, name }) => ({ id, name })).sort((a, b) => a.id.localeCompare(b.id));

		await withConfig({}, async () => {
			const infos = await provider.provideLanguageModelChatInformation({ silent: true }, cancellation());
			const served = idAndName(infos.filter((info) => info.litellm.declared === true && info.id.startsWith("srv1/")));
			assert.deepStrictEqual(served, [
				{ id: "srv1/declared-model", name: "[Gateway] declared-model" },
				{ id: "srv1/entry-model", name: "[Gateway] entry-model" },
			]);

			const snapshot = expectDefined(
				provider.getServerSnapshots().find((candidate) => candidate.status.serverId === "srv1")
			);
			assert.deepStrictEqual(
				idAndName(provider.declaredModelsForSnapshot(snapshot)),
				served,
				"the dashboard's projection must mint exactly what the sweep served"
			);

			// The snapshot's status label is display-facing; identity comes from
			// the sweep's record, so a display fallback in the status can drop
			// neither the name prefix nor the entry-level declaration.
			const relabeled = { ...snapshot, status: { ...snapshot.status, label: "Gateway (display)" } };
			assert.deepStrictEqual(
				idAndName(provider.declaredModelsForSnapshot(relabeled)),
				served,
				"the projection must resolve identity from the sweep record, never the snapshot's display label"
			);
		});
	});
});
