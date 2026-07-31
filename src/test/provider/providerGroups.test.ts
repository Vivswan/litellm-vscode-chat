import * as assert from "node:assert";
import { HttpResponse, http } from "msw";
import * as vscode from "vscode";
import { RequestError } from "../../provider/errorMapping";
import { REASONING_EFFORT_SCHEMA } from "../../provider/modelConfiguration";
import type { AggregatedStatus } from "../../shared/servers";
import {
	CHAT_COMPLETIONS_URL,
	discoveryHandlers,
	emptyErrorResponse,
	MODEL_INFO_URL,
	MODELS_URL,
	mswServer,
	sseTextResponse,
	TEST_BASE_URL,
	useMsw,
} from "../mocks/handlers";
import {
	DEFAULT_DISCOVERY_PAYLOAD,
	expectDefined,
	makeProvider,
	systemMessage,
	toHeaderMap,
	userMessage,
	withConfig,
} from "../testUtils";

/** The host passes the group configuration structurally; stable typings only declare `silent`. */
function groupOptions(configuration: unknown, silent = true): { silent: boolean } {
	return { silent, configuration } as { silent: boolean };
}

const cancellation = () => new vscode.CancellationTokenSource().token;

suite("provider groups", () => {
	useMsw();

	test("a group refresh fetches models from the configured server without ID or name prefixing", async () => {
		const provider = makeProvider();
		mswServer.use(...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD));

		const infos = await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: TEST_BASE_URL, apiKey: "group-key" }),
			cancellation()
		);

		assert.strictEqual(infos.length, 1);
		const info = expectDefined(infos[0]);
		assert.strictEqual(info.id, "test-model");
		assert.strictEqual(info.name, "test-model");
		assert.strictEqual(info.detail, undefined, "detail stays unset so the host fills in the group name");
		assert.strictEqual(info.family, "litellm", "no litellm_provider in the payload, so the generic family");
		assert.strictEqual(info.isBYOK, true, "group models run on the user's own credentials");
		assert.strictEqual(info.isUserSelectable, true);
		assert.ok(!("metadata" in info), "the retired metadata duplicate must not survive the group path");
	});

	test("group models carry pricing metadata through to the host", async () => {
		const provider = makeProvider();
		mswServer.use(
			...discoveryHandlers({
				data: [
					{
						model_name: "test-model",
						model_info: {
							id: "test-model",
							supports_function_calling: true,
							input_cost_per_token: 0.000003,
							output_cost_per_token: 0.000015,
							input_cost_per_token_above_200k_tokens: 0.000006,
						},
					},
				],
			})
		);

		const infos = await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: TEST_BASE_URL, apiKey: "group-key" }),
			cancellation()
		);

		const info = expectDefined(infos[0]);
		assert.strictEqual(info.inputCost, 3, "attachGroupServer must not drop the pricing fields");
		assert.strictEqual(info.outputCost, 15);
		assert.strictEqual(info.priceCategory, "medium", "the derived cost badge survives the group path end to end");
		assert.strictEqual(info.pricing, "$3 in / $15 out per 1M tokens", "the display label rides beside the numbers");
		assert.strictEqual(info.longContextInputCost, 6, "the tiered cost survives the group path end to end");
		assert.ok(!("longContextOutputCost" in info), "tier costs the server never reported stay absent");
		assert.ok(!("cacheCost" in info), "costs the server never reported stay absent");
		assert.ok(!("cacheWriteCost" in info), "costs the server never reported stay absent");
	});

	test("group models carry the resolved server and chat requests reach it without the route map", async () => {
		const provider = makeProvider();
		let captured: { url: string; body: Record<string, unknown>; headers: Record<string, string> } | undefined;
		mswServer.use(
			...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD),
			http.post(CHAT_COMPLETIONS_URL, async ({ request }) => {
				captured = {
					url: request.url,
					body: (await request.json()) as Record<string, unknown>,
					headers: toHeaderMap(request.headers),
				};
				return sseTextResponse("ok");
			})
		);

		const infos = await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: `${TEST_BASE_URL}/`, apiKey: "group-key" }),
			cancellation()
		);
		const model = expectDefined(infos[0]);

		await provider.provideLanguageModelChatResponse(
			model,
			[userMessage("hi")],
			{ toolMode: vscode.LanguageModelChatToolMode.Auto } as vscode.ProvideLanguageModelChatResponseOptions,
			{ report: () => {} },
			cancellation()
		);

		const request = expectDefined(captured, "no chat request reached the mock server");
		assert.strictEqual(request.url, `${TEST_BASE_URL}/v1/chat/completions`);
		assert.strictEqual(request.body.model, "test-model");
		assert.strictEqual(request.headers["x-api-key"], "group-key");
	});

	test("classified chat failures surface as stable LanguageModelError codes for vscode.lm consumers", async () => {
		const provider = makeProvider();
		mswServer.use(...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD));
		const infos = await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: TEST_BASE_URL, apiKey: "k" }),
			cancellation()
		);
		const model = expectDefined(infos[0]);
		const send = () =>
			provider.provideLanguageModelChatResponse(
				model,
				[userMessage("hi")],
				{} as vscode.ProvideLanguageModelChatResponseOptions,
				{ report: () => {} },
				cancellation()
			);

		const cases: Array<[number, string]> = [
			[401, "NoPermissions"],
			[404, "NotFound"],
			[429, "Blocked"],
		];
		for (const [status, code] of cases) {
			mswServer.use(
				http.post(CHAT_COMPLETIONS_URL, () => HttpResponse.json({ error: { message: "nope" } }, { status }))
			);
			await assert.rejects(send, (e: unknown) => {
				assert.ok(
					e instanceof vscode.LanguageModelError,
					`expected a LanguageModelError for ${status}, got ${String(e)}`
				);
				assert.strictEqual(e.code, code, `status ${status} maps to the ${code} code`);
				assert.ok(e.cause instanceof RequestError, "the classified original rides as the cause");
				return true;
			});
		}

		// A status outside the documented codes stays the classified
		// RequestError; inventing a code would misinform consumer backoff logic.
		mswServer.use(
			http.post(CHAT_COMPLETIONS_URL, () => HttpResponse.json({ error: { message: "boom" } }, { status: 500 }))
		);
		await assert.rejects(send, (e: unknown) => e instanceof RequestError && e.status === 500);
	});

	test("a keyless group configuration sends no auth header", async () => {
		const provider = makeProvider();
		let headers: Record<string, string> | undefined;
		mswServer.use(
			...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD),
			http.post(CHAT_COMPLETIONS_URL, ({ request }) => {
				headers = toHeaderMap(request.headers);
				return sseTextResponse("ok");
			})
		);

		const infos = await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: TEST_BASE_URL }),
			cancellation()
		);
		await provider.provideLanguageModelChatResponse(
			expectDefined(infos[0]),
			[userMessage("hi")],
			{ toolMode: vscode.LanguageModelChatToolMode.Auto } as vscode.ProvideLanguageModelChatResponseOptions,
			{ report: () => {} },
			cancellation()
		);

		const sent = expectDefined(headers);
		assert.strictEqual(sent.authorization, undefined);
		assert.strictEqual(sent["x-api-key"], undefined);
	});

	test("group models honor per-model prompt caching support", async () => {
		const provider = makeProvider();
		let body: Record<string, unknown> | undefined;
		mswServer.use(
			...discoveryHandlers({
				data: [
					{
						model_name: "test-model",
						model_info: {
							id: "test-model",
							supports_function_calling: true,
							supports_prompt_caching: true,
							max_input_tokens: 100000,
							max_output_tokens: 8000,
						},
					},
				],
			}),
			http.post(CHAT_COMPLETIONS_URL, async ({ request }) => {
				body = (await request.json()) as Record<string, unknown>;
				return sseTextResponse("ok");
			})
		);

		const infos = await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: TEST_BASE_URL }),
			cancellation()
		);
		await withConfig({ "promptCaching.enabled": true }, () =>
			provider.provideLanguageModelChatResponse(
				expectDefined(infos[0]),
				[systemMessage("You are helpful."), userMessage("hi")],
				{ toolMode: vscode.LanguageModelChatToolMode.Auto } as vscode.ProvideLanguageModelChatResponseOptions,
				{ report: () => {} },
				cancellation()
			)
		);

		const messages = expectDefined(body).messages as Array<{ role: string; content: unknown }>;
		const system = expectDefined(messages.find((m) => m.role === "system"));
		assert.deepStrictEqual(system.content, [
			{ type: "text", text: "You are helpful.", cache_control: { type: "ephemeral" } },
		]);
		const user = expectDefined(messages.find((m) => m.role === "user"));
		assert.deepStrictEqual(
			user.content,
			[{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
			"the breakpoint pass runs on the group path too: the sole user turn is both anchors, marked once"
		);
	});

	test("a group model's server-declared output limit is sent uncapped", async () => {
		const provider = makeProvider();
		let body: Record<string, unknown> | undefined;
		mswServer.use(
			...discoveryHandlers({
				data: [
					{
						model_name: "test-model",
						model_info: {
							id: "test-model",
							supports_function_calling: true,
							max_input_tokens: 100000,
							max_output_tokens: 32000,
						},
					},
				],
			}),
			http.post(CHAT_COMPLETIONS_URL, async ({ request }) => {
				body = (await request.json()) as Record<string, unknown>;
				return sseTextResponse("ok");
			})
		);

		const infos = await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: TEST_BASE_URL }),
			cancellation()
		);
		await withConfig({ modelParameters: {} }, () =>
			provider.provideLanguageModelChatResponse(
				expectDefined(infos[0]),
				[userMessage("hi")],
				{ toolMode: vscode.LanguageModelChatToolMode.Auto } as vscode.ProvideLanguageModelChatResponseOptions,
				{ report: () => {} },
				cancellation()
			)
		);

		assert.strictEqual(
			expectDefined(body).max_tokens,
			32000,
			"the declared limit must survive attachGroupServer's metadata rebuild"
		);
	});

	test("a declared output limit survives a discovery-cache hit", async () => {
		const provider = makeProvider();
		let discoveryHits = 0;
		let body: Record<string, unknown> | undefined;
		const declaredPayload = {
			data: [
				{
					model_name: "test-model",
					model_info: {
						id: "test-model",
						supports_function_calling: true,
						max_input_tokens: 100000,
						max_output_tokens: 32000,
					},
				},
			],
		};
		mswServer.use(
			http.get(MODEL_INFO_URL, () => {
				discoveryHits += 1;
				return HttpResponse.json(declaredPayload);
			}),
			http.get(MODELS_URL, () => HttpResponse.json(declaredPayload)),
			http.post(CHAT_COMPLETIONS_URL, async ({ request }) => {
				body = (await request.json()) as Record<string, unknown>;
				return sseTextResponse("ok");
			})
		);

		await provider.provideLanguageModelChatInformation(groupOptions({ baseUrl: TEST_BASE_URL }), cancellation());
		const secondSweep = await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: TEST_BASE_URL }),
			cancellation()
		);
		assert.strictEqual(discoveryHits, 1, "the second sweep must be served from the discovery cache");

		await withConfig({ modelParameters: {} }, () =>
			provider.provideLanguageModelChatResponse(
				expectDefined(secondSweep[0]),
				[userMessage("hi")],
				{ toolMode: vscode.LanguageModelChatToolMode.Auto } as vscode.ProvideLanguageModelChatResponseOptions,
				{ report: () => {} },
				cancellation()
			)
		);

		assert.strictEqual(
			expectDefined(body).max_tokens,
			32000,
			"the cache's attach-at-read rebuild must preserve outputLimitSource"
		);
	});

	test("the reasoning-effort schema survives the group path, a cache hit, and the chat round trip", async () => {
		const provider = makeProvider();
		let discoveryHits = 0;
		let body: Record<string, unknown> | undefined;
		const reasoningPayload = {
			data: [
				{
					model_name: "test-model",
					model_info: {
						id: "test-model",
						supports_function_calling: true,
						supports_reasoning: true,
						max_input_tokens: 100000,
						max_output_tokens: 8000,
					},
				},
			],
		};
		mswServer.use(
			http.get(MODEL_INFO_URL, () => {
				discoveryHits += 1;
				return HttpResponse.json(reasoningPayload);
			}),
			http.get(MODELS_URL, () => HttpResponse.json(reasoningPayload)),
			http.post(CHAT_COMPLETIONS_URL, async ({ request }) => {
				body = (await request.json()) as Record<string, unknown>;
				return sseTextResponse("ok");
			})
		);

		const first = await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: TEST_BASE_URL }),
			cancellation()
		);
		assert.deepStrictEqual(expectDefined(first[0]).configurationSchema, REASONING_EFFORT_SCHEMA);

		const second = await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: TEST_BASE_URL }),
			cancellation()
		);
		assert.strictEqual(discoveryHits, 1, "the second sweep must be served from the discovery cache");
		assert.deepStrictEqual(
			expectDefined(second[0]).configurationSchema,
			REASONING_EFFORT_SCHEMA,
			"attachGroupServer's rebuild on a cached read must keep the schema"
		);

		await provider.provideLanguageModelChatResponse(
			expectDefined(second[0]),
			[userMessage("hi")],
			{
				toolMode: vscode.LanguageModelChatToolMode.Auto,
				modelConfiguration: { reasoningEffort: "high" },
			} as unknown as vscode.ProvideLanguageModelChatResponseOptions,
			{ report: () => {} },
			cancellation()
		);
		assert.strictEqual(expectDefined(body).reasoning_effort, "high", "the picker choice must route with the group");
	});

	test("a group model's defaults-derived output limit stays capped at 4096", async () => {
		const provider = makeProvider();
		let body: Record<string, unknown> | undefined;
		mswServer.use(
			...discoveryHandlers({
				data: [
					{
						model_name: "test-model",
						model_info: { id: "test-model", supports_function_calling: true, max_input_tokens: 100000 },
					},
				],
			}),
			http.post(CHAT_COMPLETIONS_URL, async ({ request }) => {
				body = (await request.json()) as Record<string, unknown>;
				return sseTextResponse("ok");
			})
		);

		const infos = await withConfig({ defaultMaxOutputTokens: 16000 }, () =>
			provider.provideLanguageModelChatInformation(groupOptions({ baseUrl: TEST_BASE_URL }), cancellation())
		);
		await withConfig({ modelParameters: {} }, () =>
			provider.provideLanguageModelChatResponse(
				expectDefined(infos[0]),
				[userMessage("hi")],
				{ toolMode: vscode.LanguageModelChatToolMode.Auto } as vscode.ProvideLanguageModelChatResponseOptions,
				{ report: () => {} },
				cancellation()
			)
		);

		assert.strictEqual(expectDefined(body).max_tokens, 4096);
	});

	test("modelParameters scoped to the group's base URL apply to group models", async () => {
		const provider = makeProvider();
		let body: Record<string, unknown> | undefined;
		mswServer.use(
			...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD),
			http.post(CHAT_COMPLETIONS_URL, async ({ request }) => {
				body = (await request.json()) as Record<string, unknown>;
				return sseTextResponse("ok");
			})
		);

		const infos = await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: TEST_BASE_URL }),
			cancellation()
		);
		await withConfig({ modelParameters: { [`${TEST_BASE_URL}/test-model`]: { temperature: 0.9 } } }, () =>
			provider.provideLanguageModelChatResponse(
				expectDefined(infos[0]),
				[userMessage("hi")],
				{ toolMode: vscode.LanguageModelChatToolMode.Auto } as vscode.ProvideLanguageModelChatResponseOptions,
				{ report: () => {} },
				cancellation()
			)
		);

		assert.strictEqual(expectDefined(body).temperature, 0.9);
	});

	test("label-scoped modelParameters resolve through the migrated label map", async () => {
		const provider = makeProvider(undefined, "test-key", undefined, {
			getMigratedServerLabels: () => ({ [TEST_BASE_URL]: ["Production"] }),
		});
		let body: Record<string, unknown> | undefined;
		mswServer.use(
			...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD),
			http.post(CHAT_COMPLETIONS_URL, async ({ request }) => {
				body = (await request.json()) as Record<string, unknown>;
				return sseTextResponse("ok");
			})
		);

		const infos = await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: TEST_BASE_URL }),
			cancellation()
		);
		await withConfig({ modelParameters: { "Production/test-model": { top_p: 0.5 } } }, () =>
			provider.provideLanguageModelChatResponse(
				expectDefined(infos[0]),
				[userMessage("hi")],
				{ toolMode: vscode.LanguageModelChatToolMode.Auto } as vscode.ProvideLanguageModelChatResponseOptions,
				{ report: () => {} },
				cancellation()
			)
		);

		assert.strictEqual(expectDefined(body).top_p, 0.5);
	});

	test("label scoping is skipped and logged once when several labels shared the base URL", async () => {
		const lines: string[] = [];
		const channel = {
			info: (line: string) => lines.push(line),
			error: (line: string) => lines.push(`ERROR: ${line}`),
		} as unknown as vscode.LogOutputChannel;
		const provider = makeProvider(undefined, "test-key", channel, {
			getMigratedServerLabels: () => ({ [TEST_BASE_URL]: ["Production", "Staging"] }),
		});
		let body: Record<string, unknown> | undefined;
		mswServer.use(
			...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD),
			http.post(CHAT_COMPLETIONS_URL, async ({ request }) => {
				body = (await request.json()) as Record<string, unknown>;
				return sseTextResponse("ok");
			})
		);

		const infos = await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: TEST_BASE_URL }),
			cancellation()
		);
		const chat = () =>
			withConfig({ modelParameters: { "Production/test-model": { top_p: 0.5 } } }, () =>
				provider.provideLanguageModelChatResponse(
					expectDefined(infos[0]),
					[userMessage("hi")],
					{ toolMode: vscode.LanguageModelChatToolMode.Auto } as vscode.ProvideLanguageModelChatResponseOptions,
					{ report: () => {} },
					cancellation()
				)
			);
		await chat();
		await chat();

		assert.strictEqual(
			expectDefined(body).top_p,
			undefined,
			"ambiguous label scopes must not apply to any group at that URL"
		);
		const warnings = lines.filter((l) => l.includes("Skipping label-scoped modelParameters"));
		assert.strictEqual(warnings.length, 1, `The ambiguity warning must be logged once. Lines: ${lines.join(" | ")}`);
	});

	test("malformed configuration yields no models and a log line", async () => {
		const lines: string[] = [];
		const channel = {
			info: (line: string) => lines.push(line),
			error: (line: string) => lines.push(`ERROR: ${line}`),
		} as unknown as vscode.LogOutputChannel;
		const provider = makeProvider(undefined, "test-key", channel);

		const infos = await provider.provideLanguageModelChatInformation(groupOptions({ apiKey: "k" }), cancellation());

		assert.deepStrictEqual(infos, []);
		assert.ok(
			lines.some((l) => l.includes("malformed configuration")),
			`Expected a malformed-configuration log line. Lines: ${lines.join(" | ")}`
		);
	});

	test("a silent group refresh returns no models when the server is unreachable and reports the URL host", async () => {
		const provider = makeProvider();
		const statuses: AggregatedStatus[] = [];
		provider.setStatusCallback((status) => statuses.push(status));
		mswServer.use(
			http.get("http://litellm.test:8080/v1/model/info", () => emptyErrorResponse(500)),
			http.get("http://litellm.test:8080/v1/models", () => emptyErrorResponse(500))
		);

		const infos = await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: "http://litellm.test:8080" }),
			cancellation()
		);

		assert.deepStrictEqual(infos, []);
		const status = expectDefined(statuses[0]);
		const serverStatus = expectDefined(status.serverStatuses[0]);
		assert.strictEqual(serverStatus.state, "error");
		assert.strictEqual(serverStatus.label, "litellm.test:8080");
	});

	test("a failing silent refresh serves the last known models flagged stale; a healthy sweep clears the flag", async () => {
		const provider = makeProvider();
		let fail = false;
		mswServer.use(
			http.get(MODEL_INFO_URL, () => (fail ? emptyErrorResponse(500) : HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD))),
			http.get(MODELS_URL, () => (fail ? emptyErrorResponse(500) : HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD)))
		);

		await withConfig({ discoveryCacheTtl: 0 }, async () => {
			const healthy = await provider.provideLanguageModelChatInformation(
				groupOptions({ baseUrl: TEST_BASE_URL }),
				cancellation()
			);
			assert.strictEqual(healthy.length, 1);
			assert.ok(!("statusIcon" in expectDefined(healthy[0])), "a healthy sweep carries no decoration");

			fail = true;
			const stale = await provider.provideLanguageModelChatInformation(
				groupOptions({ baseUrl: TEST_BASE_URL }),
				cancellation()
			);
			assert.strictEqual(stale.length, 1, "the last known models must not vanish on a silent failure");
			const decorated = expectDefined(stale[0]);
			assert.strictEqual(decorated.id, "test-model");
			assert.strictEqual(expectDefined(decorated.statusIcon).id, "warning");
			assert.ok(
				expectDefined(decorated.warningText).connectivity?.includes("showing the last models it reported"),
				"the hover banner explains the stale serving"
			);

			// The window records the retained set ALONGSIDE the error status, and
			// the snapshot the dashboard reads stays undecorated pre-attach data.
			const snapshot = expectDefined(provider.getServerSnapshots().find((s) => s.status.state === "error"));
			assert.strictEqual(snapshot.models.length, 1, "the retained models ride with the error status");
			assert.ok(!("statusIcon" in expectDefined(snapshot.models[0])), "snapshots stay undecorated");

			fail = false;
			const recovered = await provider.provideLanguageModelChatInformation(
				groupOptions({ baseUrl: TEST_BASE_URL }),
				cancellation()
			);
			assert.strictEqual(recovered.length, 1);
			assert.ok(!("statusIcon" in expectDefined(recovered[0])), "recovery clears the decoration by construction");
			assert.ok(!("warningText" in expectDefined(recovered[0])), "recovery clears the banner by construction");
		});
	});

	test("a non-silent group failure still throws even when a last known model set exists", async () => {
		const provider = makeProvider();
		let fail = false;
		mswServer.use(
			http.get(MODEL_INFO_URL, () => (fail ? emptyErrorResponse(500) : HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD))),
			http.get(MODELS_URL, () => (fail ? emptyErrorResponse(500) : HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD)))
		);

		await withConfig({ discoveryCacheTtl: 0 }, async () => {
			await provider.provideLanguageModelChatInformation(groupOptions({ baseUrl: TEST_BASE_URL }), cancellation());
			fail = true;
			await assert.rejects(
				provider.provideLanguageModelChatInformation(groupOptions({ baseUrl: TEST_BASE_URL }, false), cancellation()),
				(e: unknown) => e instanceof Error,
				"Test Connection must surface the failure, stale set or not"
			);
		});
	});

	test("the group-agnostic refresh returns no models once the registry gate closes", async () => {
		const provider = makeProvider(TEST_BASE_URL, "test-key", undefined, { grouplessRegistryEnabled: () => false });

		const infos = await provider.provideLanguageModelChatInformation({ silent: true }, cancellation());

		assert.deepStrictEqual(infos, []);
	});

	test("the group-agnostic refresh keeps serving the registry while the gate allows it", async () => {
		const provider = makeProvider(TEST_BASE_URL, "test-key", undefined, { grouplessRegistryEnabled: () => true });
		mswServer.use(...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD));

		const infos = await provider.provideLanguageModelChatInformation({ silent: true }, cancellation());

		assert.strictEqual(infos.length, 1);
		assert.strictEqual(expectDefined(infos[0]).id, "test-model");
	});

	test("one failing group degrades the merged status instead of masking the healthy one", async () => {
		const provider = makeProvider(undefined, "test-key", undefined, { grouplessRegistryEnabled: () => false });
		const statuses: AggregatedStatus[] = [];
		provider.setStatusCallback((status) => statuses.push(status));
		mswServer.use(
			...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD),
			http.get("http://litellm.test:8080/v1/model/info", () => emptyErrorResponse(500)),
			http.get("http://litellm.test:8080/v1/models", () => emptyErrorResponse(500))
		);

		// The host starts every refresh cycle with the group-agnostic call, then
		// fetches each group.
		await provider.provideLanguageModelChatInformation({ silent: true }, cancellation());
		await provider.provideLanguageModelChatInformation(groupOptions({ baseUrl: TEST_BASE_URL }), cancellation());
		await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: "http://litellm.test:8080" }),
			cancellation()
		);

		const last = expectDefined(statuses.at(-1));
		assert.strictEqual(last.serverStatuses.length, 2, "both groups must appear in the merged status");
		assert.strictEqual(last.serverStatuses.filter((s) => s.state === "ok").length, 1);
		assert.strictEqual(last.serverStatuses.filter((s) => s.state === "error").length, 1);
		assert.strictEqual(last.totalModels, 1, "the healthy group's models must survive the other group's failure");
	});

	test("a group refresh leaves the registry route map untouched", async () => {
		const provider = makeProvider(TEST_BASE_URL);
		mswServer.use(...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD));
		await provider.provideLanguageModelChatInformation({ silent: true }, cancellation());

		const internals = provider as unknown as { _client: { _modelRoutes: Map<string, unknown> } };
		const routesBefore = [...internals._client._modelRoutes.keys()];
		assert.ok(routesBefore.length > 0, "the registry refresh must have registered routes");

		mswServer.use(
			...discoveryHandlers({
				data: [{ model_name: "other-model", model_info: { id: "other-model", supports_function_calling: true } }],
			})
		);
		await provider.provideLanguageModelChatInformation(groupOptions({ baseUrl: TEST_BASE_URL }), cancellation());

		assert.deepStrictEqual(
			[...internals._client._modelRoutes.keys()],
			routesBefore,
			"a group refresh must not register or clear routes"
		);
	});

	test("the group API key never reaches the log channel", async () => {
		const apiKey = "super-secret-group-key";
		const lines: string[] = [];
		const channel = {
			info: (line: string) => lines.push(line),
			error: (line: string) => lines.push(`ERROR: ${line}`),
		} as unknown as vscode.LogOutputChannel;
		const provider = makeProvider(undefined, "unused", channel);
		mswServer.use(
			...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD),
			http.post(CHAT_COMPLETIONS_URL, () => sseTextResponse("ok"))
		);

		const infos = await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: TEST_BASE_URL, apiKey }),
			cancellation()
		);
		await provider.provideLanguageModelChatResponse(
			expectDefined(infos[0]),
			[userMessage("hi")],
			{ toolMode: vscode.LanguageModelChatToolMode.Auto } as vscode.ProvideLanguageModelChatResponseOptions,
			{ report: () => {} },
			cancellation()
		);

		assert.ok(lines.length > 0, "the round trip must have produced log lines");
		assert.ok(
			lines.every((l) => !l.includes(apiKey)),
			`The API key leaked into the log channel: ${lines.filter((l) => l.includes(apiKey)).join(" | ")}`
		);
	});

	test("two groups sharing a base URL with different keys get distinct statuses", async () => {
		const provider = makeProvider();
		const statuses: AggregatedStatus[] = [];
		provider.setStatusCallback((status) => statuses.push(status));
		const byKey = ({ request }: { request: Request }) =>
			request.headers.get("x-api-key") === "good-key"
				? HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD)
				: emptyErrorResponse(500);
		mswServer.use(http.get(MODEL_INFO_URL, byKey), http.get(MODELS_URL, byKey));

		await provider.provideLanguageModelChatInformation({ silent: true }, cancellation());
		await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: TEST_BASE_URL, apiKey: "good-key" }),
			cancellation()
		);
		await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: TEST_BASE_URL, apiKey: "bad-key" }),
			cancellation()
		);

		const last = expectDefined(statuses.at(-1));
		assert.strictEqual(last.serverStatuses.length, 2, "each key must have its own status entry");
		assert.strictEqual(last.serverStatuses.filter((s) => s.state === "ok").length, 1);
		assert.strictEqual(last.serverStatuses.filter((s) => s.state === "error").length, 1);
	});

	test("a group that stops reporting survives one groupless-marked cycle and disappears at the next", async () => {
		const provider = makeProvider(undefined, "test-key", undefined, { grouplessRegistryEnabled: () => false });
		const statuses: AggregatedStatus[] = [];
		provider.setStatusCallback((status) => statuses.push(status));
		mswServer.use(
			...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD),
			http.get("http://litellm.test:8080/v1/model/info", () => HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD)),
			http.get("http://litellm.test:8080/v1/models", () => HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD))
		);
		const groupless = () => provider.provideLanguageModelChatInformation({ silent: true }, cancellation());
		const fetchGroup = (baseUrl: string) =>
			provider.provideLanguageModelChatInformation(groupOptions({ baseUrl }), cancellation());

		await groupless();
		await fetchGroup(TEST_BASE_URL);
		await fetchGroup("http://litellm.test:8080");

		await groupless();
		await fetchGroup(TEST_BASE_URL);
		assert.strictEqual(
			expectDefined(statuses.at(-1)).serverStatuses.length,
			2,
			"the group must survive the cycle after its last report"
		);

		await groupless();
		await fetchGroup(TEST_BASE_URL);
		assert.strictEqual(
			expectDefined(statuses.at(-1)).serverStatuses.length,
			1,
			"the group must be evicted at the second cycle boundary after its last report"
		);
	});

	test("re-seeing a group within one cycle starts a new cycle, so stale groups age out", async () => {
		const provider = makeProvider();
		const statuses: AggregatedStatus[] = [];
		provider.setStatusCallback((status) => statuses.push(status));
		mswServer.use(
			...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD),
			http.get("http://litellm.test:8080/v1/model/info", () => HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD)),
			http.get("http://litellm.test:8080/v1/models", () => HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD))
		);

		const fetchGroup = (baseUrl: string) =>
			provider.provideLanguageModelChatInformation(groupOptions({ baseUrl }), cancellation());

		// One sweep sees both groups; the next two sweeps (with no group-agnostic
		// call in between) only see the first, so the second must age out.
		await fetchGroup(TEST_BASE_URL);
		await fetchGroup("http://litellm.test:8080");
		await fetchGroup(TEST_BASE_URL);
		assert.strictEqual(expectDefined(statuses.at(-1)).serverStatuses.length, 2, "one stale cycle is retained");
		await fetchGroup(TEST_BASE_URL);

		assert.strictEqual(
			expectDefined(statuses.at(-1)).serverStatuses.length,
			1,
			"a group unseen for two sweeps must age out without any group-agnostic call"
		);
	});

	test("statuses not refreshed within the TTL are evicted on the next cycle", async () => {
		const provider = makeProvider();
		const statuses: AggregatedStatus[] = [];
		provider.setStatusCallback((status) => statuses.push(status));
		mswServer.use(
			...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD),
			http.get("http://litellm.test:8080/v1/model/info", () => HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD)),
			http.get("http://litellm.test:8080/v1/models", () => HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD))
		);

		await provider.provideLanguageModelChatInformation(groupOptions({ baseUrl: TEST_BASE_URL }), cancellation());
		await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: "http://litellm.test:8080" }),
			cancellation()
		);

		const realNow = Date.now;
		Date.now = () => realNow() + 11 * 60 * 1000;
		try {
			// The repeat fetch starts a new cycle; the TTL evicts the other group
			// immediately instead of after the usual one-cycle grace.
			await provider.provideLanguageModelChatInformation(groupOptions({ baseUrl: TEST_BASE_URL }), cancellation());
		} finally {
			Date.now = realNow;
		}

		const last = expectDefined(statuses.at(-1));
		assert.strictEqual(last.serverStatuses.length, 1, "entries older than the TTL must be evicted");
		assert.strictEqual(expectDefined(last.serverStatuses[0]).baseUrl, TEST_BASE_URL);
	});

	test("testKnownGroupConnections re-fetches every observed group server over the network", async () => {
		const provider = makeProvider();
		let discoveryHits = 0;
		mswServer.use(
			http.get(MODEL_INFO_URL, () => {
				discoveryHits += 1;
				return HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD);
			}),
			http.get(MODELS_URL, () => HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD))
		);

		await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: TEST_BASE_URL, apiKey: "group-key" }),
			cancellation()
		);
		const hitsBefore = discoveryHits;

		const statuses: AggregatedStatus[] = [];
		provider.setStatusCallback((status) => statuses.push(status));
		await provider.testKnownGroupConnections();

		assert.strictEqual(discoveryHits, hitsBefore + 1, "the connection test must hit the group server for real");
		const last = expectDefined(statuses.at(-1));
		assert.strictEqual(expectDefined(last.serverStatuses[0]).state, "ok");
	});

	test("refreshViaHost falls back to direct group probes when the host does not react", async () => {
		const provider = makeProvider();
		let discoveryHits = 0;
		mswServer.use(
			http.get(MODEL_INFO_URL, () => {
				discoveryHits += 1;
				return HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD);
			}),
			http.get(MODELS_URL, () => HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD))
		);
		await provider.provideLanguageModelChatInformation(groupOptions({ baseUrl: TEST_BASE_URL }), cancellation());
		const before = discoveryHits;

		// This provider instance is not registered with the host, so the change
		// event goes nowhere and the bounded wait must fall back.
		await provider.refreshViaHost(300, 50);

		assert.strictEqual(discoveryHits, before + 1, "the fallback must probe the observed group server");
	});

	test("refreshViaHost falls back when the host only makes the group-agnostic call", async () => {
		const provider = makeProvider(undefined, "test-key", undefined, { grouplessRegistryEnabled: () => false });
		let discoveryHits = 0;
		mswServer.use(
			http.get(MODEL_INFO_URL, () => {
				discoveryHits += 1;
				return HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD);
			}),
			http.get(MODELS_URL, () => HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD))
		);
		await provider.provideLanguageModelChatInformation(groupOptions({ baseUrl: TEST_BASE_URL }), cancellation());
		const before = discoveryHits;

		// A host that reacts with only the group-agnostic call produces zero
		// per-group reports; the groupless report must not arm the settle wait.
		provider.onDidChangeLanguageModelChatInformation(() => {
			void provider.provideLanguageModelChatInformation({ silent: true }, cancellation());
		});

		await provider.refreshViaHost(400, 50);

		assert.strictEqual(discoveryHits, before + 1, "zero group reports by the deadline must trigger the fallback");
	});

	test("refreshViaHost resolves once host-driven reports settle, without a fallback probe", async () => {
		const provider = makeProvider(undefined, "test-key", undefined, { grouplessRegistryEnabled: () => false });
		let discoveryHits = 0;
		mswServer.use(
			http.get(MODEL_INFO_URL, () => {
				discoveryHits += 1;
				return HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD);
			}),
			http.get(MODELS_URL, () => HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD))
		);
		await provider.provideLanguageModelChatInformation(groupOptions({ baseUrl: TEST_BASE_URL }), cancellation());
		const before = discoveryHits;

		// Simulates the host reacting to the change event with a full refresh
		// cycle: the group-agnostic call, then one call per group.
		provider.onDidChangeLanguageModelChatInformation(() => {
			void (async () => {
				await provider.provideLanguageModelChatInformation({ silent: true }, cancellation());
				await provider.provideLanguageModelChatInformation(groupOptions({ baseUrl: TEST_BASE_URL }), cancellation());
			})();
		});

		await provider.refreshViaHost(5000, 100);

		assert.strictEqual(discoveryHits, before + 1, "the settled wait must not add a fallback probe");
	});
});
