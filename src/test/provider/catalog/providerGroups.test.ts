import * as assert from "node:assert";
import { HttpResponse, http } from "msw";
import * as vscode from "vscode";
import type { DiscoveredGroupModels } from "../../../provider";
import { DiscoveryCache } from "../../../provider/catalog/discoveryCache";
import { REASONING_EFFORT_SCHEMA } from "../../../provider/catalog/modelConfiguration";
import { RequestError } from "../../../provider/transport/errorMapping";
import { publicErrorText } from "../../../shared/logger";
import { MirroredError } from "../../../shared/mirroredError";
import type { AggregatedStatus } from "../../../shared/servers";
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
} from "../../mocks/handlers";
import {
	DEFAULT_DISCOVERY_PAYLOAD,
	expectDefined,
	makeProvider,
	systemMessage,
	toHeaderMap,
	userMessage,
	withConfig,
} from "../../testUtils";

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

	test("classified chat failures are thrown as LanguageModelError with the documented codes", async () => {
		// Direct provider invocation: what a vscode.lm consumer receives after
		// the host round trip is the reconstructed LanguageModelError with its
		// code and message - the cause below is an in-process detail the host
		// serialization drops, so only code and message are contract.
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
				assert.ok(e.message.length > 0, "the user-facing message is preserved on the wrapped error");
				assert.ok(e.cause instanceof RequestError, "in-process, the classified original rides as the cause");
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
		await withConfig({ "chat.promptCaching": true }, () =>
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
		await withConfig({ "models.parameters": {} }, () =>
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

		await withConfig({ "models.parameters": {} }, () =>
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

		const infos = await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: TEST_BASE_URL }),
			cancellation()
		);
		await withConfig({ "models.parameters": {} }, () =>
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

	test("a pre-migration URL-scoped modelParameters key is inert; the plain matcher applies to group models", async () => {
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
		await withConfig(
			{
				"models.parameters": {
					"test-model": { temperature: 0.9 },
					[`${TEST_BASE_URL}/test-model`]: { temperature: 0.1 },
				},
			},
			() =>
				provider.provideLanguageModelChatResponse(
					expectDefined(infos[0]),
					[userMessage("hi")],
					{ toolMode: vscode.LanguageModelChatToolMode.Auto } as vscode.ProvideLanguageModelChatResponseOptions,
					{ report: () => {} },
					cancellation()
				)
		);

		assert.strictEqual(expectDefined(body).temperature, 0.9, "server scoping is gone from the global record");
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

	test("a suppressed group answers empty without a network call and reports a zero-model status", async () => {
		// The extension injects the removal-tombstone predicate; the provider
		// consults it with the group's status label and normalized base URL.
		const seen: [string, string][] = [];
		let suppressed = true;
		const provider = makeProvider(undefined, "test-key", undefined, {
			isGroupSuppressed: (label, baseUrl) => {
				seen.push([label, baseUrl]);
				return suppressed;
			},
		});
		const statuses: AggregatedStatus[] = [];
		provider.setStatusCallback((status) => statuses.push(status));
		let fetches = 0;
		mswServer.use(
			http.get(MODEL_INFO_URL, () => {
				fetches += 1;
				return HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD);
			}),
			http.get(MODELS_URL, () => {
				fetches += 1;
				return HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD);
			})
		);

		const infos = await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: `${TEST_BASE_URL}/`, apiKey: "k", label: "Prod" }),
			cancellation()
		);

		assert.deepStrictEqual(infos, [], "the suppressed group serves nothing");
		assert.strictEqual(fetches, 0, "suppression never touches the network");
		assert.deepStrictEqual(seen, [["Prod", TEST_BASE_URL]], "judged by status label and normalized base URL");
		const serverStatus = expectDefined(expectDefined(statuses[0]).serverStatuses[0]);
		assert.strictEqual(serverStatus.state, "ok", "a suppressed group is not an error");
		assert.strictEqual(serverStatus.state === "ok" && serverStatus.modelCount, 0);
		assert.strictEqual(
			serverStatus.state === "ok" && serverStatus.hiddenByRemoval,
			true,
			"the status carries the cause so the presentation layers can name the removal"
		);

		// Unhidden (the predicate answers false again): the next re-resolution
		// serves the models like any healthy group.
		suppressed = false;
		const restored = await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: `${TEST_BASE_URL}/`, apiKey: "k", label: "Prod" }),
			cancellation()
		);
		assert.strictEqual(restored.length, 1, "the unhidden group serves again");
		assert.ok(fetches > 0, "the unhidden refresh reaches the network");
		const restoredStatus = expectDefined(expectDefined(statuses.at(-1)).serverStatuses[0]);
		assert.ok(
			restoredStatus.state === "ok" && restoredStatus.hiddenByRemoval !== true,
			"an unhidden group's status must not keep the flag"
		);
	});

	test("an unlabeled group is judged by its URL-host status label", async () => {
		const seen: [string, string][] = [];
		const provider = makeProvider(undefined, "test-key", undefined, {
			isGroupSuppressed: (label, baseUrl) => {
				seen.push([label, baseUrl]);
				return false;
			},
		});
		mswServer.use(...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD));

		await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: TEST_BASE_URL, apiKey: "k" }),
			cancellation()
		);

		assert.deepStrictEqual(seen, [["litellm.test", TEST_BASE_URL]]);
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

		await withConfig({ "discovery.cacheTtl": 0 }, async () => {
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
				expectDefined(decorated.warningText).connectivity?.includes("last successful sync"),
				"the hover banner is anchored to the last successful sync, not the failure time"
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

	test("stale serving is bounded by the last successful discovery, not by the failure reports", async () => {
		// Clock-injected like the discovery-cache tests: each failed refresh
		// re-records the entry (refreshing its report timestamp), so only the
		// success anchor can age the stale window out.
		let nowMs = 1_000_000;
		const provider = makeProvider(undefined, "test-key", undefined, { now: () => nowMs });
		let fail = false;
		mswServer.use(
			http.get(MODEL_INFO_URL, () => (fail ? emptyErrorResponse(500) : HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD))),
			http.get(MODELS_URL, () => (fail ? emptyErrorResponse(500) : HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD)))
		);

		await withConfig({ "discovery.cacheTtl": 0 }, async () => {
			await provider.provideLanguageModelChatInformation(groupOptions({ baseUrl: TEST_BASE_URL }), cancellation());

			fail = true;
			nowMs += 5 * 60_000;
			const withinWindow = await provider.provideLanguageModelChatInformation(
				groupOptions({ baseUrl: TEST_BASE_URL }),
				cancellation()
			);
			assert.strictEqual(withinWindow.length, 1, "five minutes after the last success the stale set still serves");

			nowMs += 6 * 60_000;
			const pastWindow = await provider.provideLanguageModelChatInformation(
				groupOptions({ baseUrl: TEST_BASE_URL }),
				cancellation()
			);
			assert.deepStrictEqual(
				pastWindow,
				[],
				"eleven minutes without a success stops stale serving despite the fresh failure reports"
			);

			nowMs += 60_000;
			const stillGone = await provider.provideLanguageModelChatInformation(
				groupOptions({ baseUrl: TEST_BASE_URL }),
				cancellation()
			);
			assert.deepStrictEqual(stillGone, [], "the emptied window cannot resurrect the stale set");
		});
	});

	test("a non-silent group failure still throws even when a last known model set exists", async () => {
		const provider = makeProvider();
		let fail = false;
		mswServer.use(
			http.get(MODEL_INFO_URL, () => (fail ? emptyErrorResponse(500) : HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD))),
			http.get(MODELS_URL, () => (fail ? emptyErrorResponse(500) : HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD)))
		);

		await withConfig({ "discovery.cacheTtl": 0 }, async () => {
			await provider.provideLanguageModelChatInformation(groupOptions({ baseUrl: TEST_BASE_URL }), cancellation());
			fail = true;
			await assert.rejects(
				provider.provideLanguageModelChatInformation(groupOptions({ baseUrl: TEST_BASE_URL }, false), cancellation()),
				(e: unknown) => e instanceof Error,
				"Test Connection must surface the failure, stale set or not"
			);
		});
	});

	test("a non-Error group failure is rebuilt with the log-safe rendering as its English mirror", async () => {
		// Rejected from inside the group serve's try without ever being an
		// Error: the rebuild must keep the display rendering for the UI and the
		// log-safe rendering for every public log surface.
		const hostile = {
			toString: () => "display text with RESPONSE-BODY-MARKER",
			logClassification: "InjectedFailure(non-Error)",
		};
		const failingCache = new DiscoveryCache<DiscoveredGroupModels>();
		failingCache.fetch = () => Promise.reject(hostile);
		const provider = makeProvider(undefined, "test-key", undefined, { discoveryCache: failingCache });

		await assert.rejects(
			provider.provideLanguageModelChatInformation(groupOptions({ baseUrl: TEST_BASE_URL }, false), cancellation()),
			(error: unknown) => {
				assert.ok(error instanceof MirroredError, `expected a MirroredError rebuild, got ${String(error)}`);
				assert.ok(error.message.includes("RESPONSE-BODY-MARKER"), "the display rendering keeps the text");
				assert.strictEqual(
					publicErrorText(error),
					"InjectedFailure(non-Error)",
					"the display text must never become the public log rendering"
				);
				return true;
			}
		);
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

	test("two labeled groups sharing a base URL AND key get their own statuses under their labels", async () => {
		// The reported user scenario: two declared entries mirroring one server
		// with one key. Their groups' configurations differ only in the label
		// the sync engine stamped, and that label must be enough for each to
		// keep its own status-window entry and render under its own name.
		const provider = makeProvider();
		const statuses: AggregatedStatus[] = [];
		provider.setStatusCallback((status) => statuses.push(status));
		mswServer.use(...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD));

		await provider.provideLanguageModelChatInformation({ silent: true }, cancellation());
		await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: TEST_BASE_URL, apiKey: "shared-key", label: "Prod" }),
			cancellation()
		);
		await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: TEST_BASE_URL, apiKey: "shared-key", label: "Staging" }),
			cancellation()
		);

		const last = expectDefined(statuses.at(-1));
		assert.strictEqual(last.serverStatuses.length, 2, "one status entry per declared entry, not one shared");
		assert.deepStrictEqual(
			last.serverStatuses.map((s) => s.label).sort(),
			["Prod", "Staging"],
			"each group's status renders under its configured label"
		);
		assert.ok(
			last.serverStatuses.every((s) => s.state === "ok"),
			"both entries report their own real outcome"
		);
		const ids = new Set(last.serverStatuses.map((s) => s.serverId));
		assert.strictEqual(ids.size, 2, "the labels mint distinct identities");
	});

	test("identical sibling groups inside a groupless-marked sweep do not restart the status cycle", async () => {
		// Two pre-label host groups can resolve to ONE identity (same URL, same
		// key, no label). Within a host-driven sweep - one that begins with the
		// group-agnostic call - the second sibling's report used to look like
		// "re-seen within one cycle" and restarted the cycle mid-sweep, evicting
		// entries the sweep had not re-reached yet; the other group's status
		// would flicker out of the merged report until its own refresh landed.
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

		// Each sweep: the group-agnostic call, both identical siblings, then the
		// other group. In the buggy ordering the second sibling of sweep two
		// restarted the cycle before the other group re-reported, evicting it.
		await groupless();
		await fetchGroup(TEST_BASE_URL);
		await fetchGroup(TEST_BASE_URL);
		await fetchGroup("http://litellm.test:8080");

		await groupless();
		await fetchGroup(TEST_BASE_URL);
		await fetchGroup(TEST_BASE_URL);

		// The other group reported last sweep: the one-cycle grace must hold it
		// through this sweep, sibling duplicates notwithstanding.
		const last = expectDefined(statuses.at(-1));
		assert.strictEqual(
			last.serverStatuses.length,
			2,
			"a sibling re-report inside a marked cycle must not evict the not-yet-refreshed group"
		);
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

suite("provider groups: capability overrides and declared models", () => {
	useMsw();

	test("a modelCapabilities edit reaches the next serve through the discovery cache, no refetch", async () => {
		const provider = makeProvider();
		let discoveryHits = 0;
		mswServer.use(
			http.get(MODEL_INFO_URL, () => {
				discoveryHits += 1;
				return HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD);
			}),
			http.get(MODELS_URL, () => HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD))
		);
		const plain = await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: TEST_BASE_URL }),
			cancellation()
		);
		assert.strictEqual(expectDefined(plain[0]).maxOutputTokens, 8000);

		await withConfig(
			{ "models.capabilities": { "test-model": { max_output_tokens: 2048, supports_vision: true } } },
			async () => {
				const overridden = await provider.provideLanguageModelChatInformation(
					groupOptions({ baseUrl: TEST_BASE_URL }),
					cancellation()
				);
				const info = expectDefined(overridden[0]);
				assert.strictEqual(info.maxOutputTokens, 2048);
				assert.strictEqual(info.capabilities?.imageInput, true);
				assert.strictEqual(info.litellm.outputLimitSource, "user", "an overridden limit is user-set");
			}
		);

		const restored = await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: TEST_BASE_URL }),
			cancellation()
		);
		assert.strictEqual(expectDefined(restored[0]).maxOutputTokens, 8000, "removing the override restores the server");
		assert.strictEqual(discoveryHits, 1, "overrides apply outside the cache: one network fetch serves all three");
	});

	test("an entry's declared model serves beside discovery and joins the count", async () => {
		const provider = makeProvider(undefined, "test-key", undefined, {
			getEntryModelCapabilities: (label, baseUrl) =>
				label === "Gateway" && baseUrl === TEST_BASE_URL ? { "declared-model": { context_length: 32000 } } : undefined,
			getEntryDeclaredModels: (label, baseUrl) =>
				label === "Gateway" && baseUrl === TEST_BASE_URL ? ["declared-model"] : undefined,
		});
		const statuses: AggregatedStatus[] = [];
		provider.setStatusCallback((status) => statuses.push(status));
		mswServer.use(...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD));

		await withConfig({}, async () => {
			const infos = await provider.provideLanguageModelChatInformation(
				groupOptions({ baseUrl: TEST_BASE_URL, label: "Gateway" }),
				cancellation()
			);
			assert.deepStrictEqual(
				infos.map((info) => info.id),
				["test-model", "declared-model"]
			);
			const status = expectDefined(expectDefined(statuses.at(-1)).serverStatuses[0]);
			assert.strictEqual(status.state, "ok");
			assert.strictEqual(status.modelCount, 2, "the declared model joins the picker count");
			assert.strictEqual(expectDefined(statuses.at(-1)).totalModels, 2);
		});
	});

	test("a URL-scoped global _declare directive no longer creates models", async () => {
		const provider = makeProvider();
		mswServer.use(...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD));
		await withConfig(
			{ "models.capabilities": { [`${TEST_BASE_URL}/declared-model`]: { _declare: true, context_length: 32000 } } },
			async () => {
				const infos = await provider.provideLanguageModelChatInformation(
					groupOptions({ baseUrl: TEST_BASE_URL }),
					cancellation()
				);
				assert.deepStrictEqual(
					infos.map((info) => info.id),
					["test-model"],
					"declaration is per-server: it lives on the entry, never in the global record"
				);
			}
		);
	});

	test("a declared ID discovery lists stays inert", async () => {
		const provider = makeProvider(undefined, "test-key", undefined, {
			getEntryDeclaredModels: () => ["test-model"],
		});
		mswServer.use(...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD));
		await withConfig({}, async () => {
			const infos = await provider.provideLanguageModelChatInformation(
				groupOptions({ baseUrl: TEST_BASE_URL, label: "Gateway" }),
				cancellation()
			);
			assert.deepStrictEqual(
				infos.map((info) => info.id),
				["test-model"],
				"never two models with one ID"
			);
		});
	});

	test("an expected discovery failure serves the entry's declared models under a truthful error status", async () => {
		const provider = makeProvider(undefined, "test-key", undefined, {
			getExpectedFailures: (label, baseUrl) =>
				label === "Gateway" && baseUrl === TEST_BASE_URL ? ["modelInfo", "modelListing"] : undefined,
			getEntryDeclaredModels: (label, baseUrl) =>
				label === "Gateway" && baseUrl === TEST_BASE_URL ? ["gw-model"] : undefined,
		});
		const statuses: AggregatedStatus[] = [];
		provider.setStatusCallback((status) => statuses.push(status));
		mswServer.use(
			http.get(MODEL_INFO_URL, () => emptyErrorResponse(500)),
			http.get(MODELS_URL, () => emptyErrorResponse(500))
		);

		const infos = await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: TEST_BASE_URL, label: "Gateway" }),
			cancellation()
		);
		assert.deepStrictEqual(
			infos.map((info) => info.id),
			["gw-model"],
			"declared models serve despite the failure"
		);
		assert.ok(!("statusIcon" in expectDefined(infos[0])), "declared models are never stale-decorated");
		const status = expectDefined(expectDefined(statuses.at(-1)).serverStatuses[0]);
		assert.strictEqual(status.state, "error", "the outcome stays a truthful error (the stale anchor depends on it)");
		assert.strictEqual(status.state === "error" && status.expected, true);
		assert.strictEqual(status.state === "error" && status.declaredModelCount, 1);
		assert.strictEqual(expectDefined(statuses.at(-1)).totalModels, 1, "declared models join the aggregate totals");
	});

	test("a non-silent expected failure returns the declared set instead of throwing; unexpected still throws", async () => {
		const expectIt = { value: true };
		const provider = makeProvider(undefined, "test-key", undefined, {
			getExpectedFailures: () => (expectIt.value ? ["modelInfo", "modelListing"] : undefined),
			getEntryDeclaredModels: () => ["gw-model"],
		});
		mswServer.use(
			http.get(MODEL_INFO_URL, () => emptyErrorResponse(500)),
			http.get(MODELS_URL, () => emptyErrorResponse(500))
		);

		const served = await provider.provideLanguageModelChatInformation(
			groupOptions({ baseUrl: TEST_BASE_URL, label: "Gateway" }, false),
			cancellation()
		);
		assert.deepStrictEqual(
			served.map((info) => info.id),
			["gw-model"],
			"Test Connection on an expected failure serves the declared set"
		);

		expectIt.value = false;
		await assert.rejects(
			provider.provideLanguageModelChatInformation(
				groupOptions({ baseUrl: TEST_BASE_URL, label: "Gateway" }, false),
				cancellation()
			),
			(e: unknown) => e instanceof Error,
			"an unexpected non-silent failure still throws"
		);
	});

	test("a failing refresh merges declared models un-staled with the stale-decorated last known set", async () => {
		// The declaration is entry-level and mutable, so the tail of the test
		// can remove it and pin the immediate mid-outage disappearance.
		let declared: readonly string[] | undefined = ["declared-model"];
		const provider = makeProvider(undefined, "test-key", undefined, {
			getEntryDeclaredModels: () => declared,
		});
		let fail = false;
		mswServer.use(
			http.get(MODEL_INFO_URL, () => (fail ? emptyErrorResponse(500) : HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD))),
			http.get(MODELS_URL, () => (fail ? emptyErrorResponse(500) : HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD)))
		);
		const group = groupOptions({ baseUrl: TEST_BASE_URL, label: "Gateway" });

		await withConfig({ "discovery.cacheTtl": 0 }, async () => {
			await provider.provideLanguageModelChatInformation(group, cancellation());
			fail = true;
			const served = await provider.provideLanguageModelChatInformation(group, cancellation());
			assert.deepStrictEqual(
				served.map((info) => info.id),
				["test-model", "declared-model"]
			);
			const stale = expectDefined(served.find((info) => info.id === "test-model"));
			assert.strictEqual(expectDefined(stale.statusIcon).id, "warning", "the discovered set is stale-decorated");
			const declaredInfo = expectDefined(served.find((info) => info.id === "declared-model"));
			assert.ok(!("statusIcon" in declaredInfo), "declared models never carry the stale decoration");

			// The window keeps discovered models only: a removed declared ID
			// disappears immediately even mid-outage, and the projection is
			// what the dashboard merges instead.
			const snapshot = expectDefined(provider.getServerSnapshots().find((s) => s.status.state === "error"));
			assert.deepStrictEqual(
				snapshot.models.map((info) => info.id),
				["test-model"]
			);
			assert.deepStrictEqual(
				provider.declaredModelsForSnapshot(snapshot).map((info) => info.id),
				["declared-model"]
			);

			// With the declaration gone the next failing serve drops it
			// mid-outage: no resurrection from stale snapshots.
			declared = undefined;
			const withoutDeclared = await provider.provideLanguageModelChatInformation(group, cancellation());
			assert.deepStrictEqual(
				withoutDeclared.map((info) => info.id),
				["test-model"],
				"a removed declared ID takes effect immediately even mid-outage"
			);
		});
	});
});
