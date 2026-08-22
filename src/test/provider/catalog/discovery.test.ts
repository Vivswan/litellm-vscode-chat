import * as assert from "node:assert";
import { delay, HttpResponse, http } from "msw";
import {
	fetchModels,
	isLiteLLMModelItem,
	type MappedModelInfo,
	mapModelInfoEntry,
	mergeModelDeployments,
	normalizeModelItem,
	parseModelInfoItem,
} from "../../../provider/catalog/discovery";
import { deriveTokenConstraints } from "../../../provider/catalog/modelCatalog";
import { DEFAULT_REASONING_EFFORT_LEVELS, reasoningEffortSchema } from "../../../provider/catalog/modelConfiguration";
import { buildModelInfos } from "../../../provider/catalog/registration";
import type { LiteLLMModelItem, ModelShape } from "../../../provider/catalog/schemas";
import { createServerClient } from "../../../provider/transport/clients";
import { RequestError } from "../../../provider/transport/errorMapping";
import { CAPABILITY_FLOOR } from "../../../shared/config/capabilityResolution";
import { publicErrorText } from "../../../shared/logger";
import {
	discoveryHandlers,
	emptyErrorResponse,
	MODEL_INFO_URL,
	MODELS_URL,
	mswServer,
	TEST_BASE_URL,
	useMsw,
} from "../../mocks/handlers";
import { expectDefined, withFetch } from "../../pureHelpers";

function request(log: (message: string, data?: unknown) => void = () => {}) {
	const client = createServerClient({
		serverId: "srv1",
		baseUrl: TEST_BASE_URL,
		apiKey: "test-key",
		userAgent: "test-agent",
		customHeaders: {},
	});
	return {
		client,
		baseUrl: TEST_BASE_URL,
		apiVersion: undefined,
		discoveryTimeout: 5000,
		log,
	};
}

/** Narrow a model to one shape kind and return that shape, failing the test otherwise. */
function expectShape<K extends ModelShape["kind"]>(model: LiteLLMModelItem, kind: K): Extract<ModelShape, { kind: K }> {
	assert.strictEqual(model.shape.kind, kind, `model ${model.id} took the wrong registration shape`);
	return model.shape as Extract<ModelShape, { kind: K }>;
}

suite("provider/catalog/discovery", () => {
	useMsw();

	suite("guards", () => {
		test("isLiteLLMModelItem accepts items with and without providers", () => {
			assert.ok(isLiteLLMModelItem({ id: "m1" }));
			assert.ok(isLiteLLMModelItem({ id: "m1", providers: [] }));
			assert.ok(!isLiteLLMModelItem({ id: 42 }));
			assert.ok(!isLiteLLMModelItem({ id: "m1", providers: "oops" }));
			assert.ok(!isLiteLLMModelItem(null));
			assert.ok(!isLiteLLMModelItem("m1"));
		});

		test("parseModelInfoItem requires one usable model identifier and resolves it by priority", () => {
			assert.strictEqual(expectDefined(parseModelInfoItem({ model_name: "gpt-4" })).modelId, "gpt-4");
			assert.strictEqual(
				expectDefined(parseModelInfoItem({ litellm_params: { model: "openai/gpt-4" } })).modelId,
				"openai/gpt-4"
			);
			assert.strictEqual(expectDefined(parseModelInfoItem({ model_info: { key: "gpt-4" } })).modelId, "gpt-4");
			assert.strictEqual(expectDefined(parseModelInfoItem({ model_info: { id: "abc" } })).modelId, "abc");
			assert.strictEqual(parseModelInfoItem({ model_name: "" }), undefined);
			assert.strictEqual(parseModelInfoItem({ model_name: 42 }), undefined);
			assert.strictEqual(parseModelInfoItem({}), undefined);
			assert.strictEqual(parseModelInfoItem(null), undefined);
		});

		test("a malformed model_info field degrades to undefined without dropping the entry", () => {
			const parsed = expectDefined(
				parseModelInfoItem({
					model_name: "lenient-model",
					model_info: {
						supports_vision: "yes",
						supports_function_calling: true,
						supported_openai_params: ["temperature", 42],
						max_output_tokens: "16000",
					},
				}),
				"one malformed field must never lose the model"
			);
			assert.strictEqual(parsed.model_info?.supports_vision, undefined, "a string flag is malformed, not truthy");
			assert.strictEqual(parsed.model_info?.supports_function_calling, true);
			assert.deepStrictEqual(
				parsed.model_info?.supported_openai_params,
				["temperature"],
				"a non-string params member drops alone; the usable members survive"
			);
			assert.strictEqual(parsed.model_info?.max_output_tokens, "16000", "numeric strings stay for normalization");
		});

		test("per-level reasoning-effort flags author the levels list on both discovery paths", () => {
			// model_info entries: mapModelInfoEntry authors the field from the flags.
			const mapped = mapModelInfoEntry(
				expectDefined(
					parseModelInfoItem({
						model_name: "flagged",
						model_info: {
							supports_reasoning: true,
							supports_max_reasoning_effort: true,
							supports_low_reasoning_effort: true,
							supports_minimal_reasoning_effort: false,
							supports_none_reasoning_effort: null,
						},
					})
				)
			);
			assert.deepStrictEqual(
				mapped.provider.reasoning_effort_levels,
				["low", "max"],
				"true flags collect in menu order; false and null read as unreported"
			);

			// providers-array entries: normalizeModelItem authors the field after
			// the pass-through spread, so a wire entry cannot forge the list.
			const routed = normalizeModelItem(
				{
					id: "routed",
					providers: [
						{
							provider: "openrouter",
							status: "ok",
							supports_high_reasoning_effort: true,
							reasoning_effort_levels: ["forged"],
						},
					],
				},
				() => {}
			);
			const [provider] = expectShape(routed, "group").providers;
			assert.deepStrictEqual(provider.reasoning_effort_levels, ["high"], "the flags are the wire truth");

			// No true flag anywhere is no signal at all, never an empty list.
			const unflagged = mapModelInfoEntry(
				expectDefined(
					parseModelInfoItem({
						model_name: "plain",
						model_info: { supports_reasoning: true, supports_low_reasoning_effort: false },
					})
				)
			);
			assert.strictEqual(unflagged.provider.reasoning_effort_levels, null);
		});
	});

	suite("fetchModels", () => {
		test("observedModelInfoKeys unions the model_info keys of a successful listing, sorted", async () => {
			mswServer.use(
				http.get(MODEL_INFO_URL, () =>
					HttpResponse.json({
						data: [
							{ model_name: "a", model_info: { id: "a", max_input_tokens: 1000, custom_field: 1 } },
							{ model_name: "b", model_info: { supports_vision: true, blocked: true } },
							{ model_name: "c" },
							// No usable model id, so the entry cannot register - but its
							// model_info keys were on the wire and must still count.
							{ bogus: true, model_info: { malformed_entry_key: 1 } },
							{ id: "listing-shaped", providers: [], model_info: { listing_shaped_key: 2 } },
							// A non-record model_info contributes nothing, and an oversized
							// key is dropped by the per-key length bound.
							{ model_name: "d", model_info: ["not", "a", "record"] },
							{ model_name: "e", model_info: "not a record" },
							{ model_name: "f", model_info: { ["k".repeat(129)]: 1 } },
						],
					})
				)
			);

			const result = await fetchModels(request());

			// Keys union across the RAW entries - blocked, malformed, and
			// listing-shaped ones included - and sort, so displays are deterministic.
			assert.deepStrictEqual(result.observedModelInfoKeys, [
				"blocked",
				"custom_field",
				"id",
				"listing_shaped_key",
				"malformed_entry_key",
				"max_input_tokens",
				"supports_vision",
			]);
		});

		test("a successful listing with zero entries reports an empty key set, present", async () => {
			// Presence is the "listing succeeded" signal, so the one success path
			// with nothing observed must report [] rather than absence.
			mswServer.use(http.get(MODEL_INFO_URL, () => HttpResponse.json({ data: [] })));
			const result = await fetchModels(request());
			assert.deepStrictEqual(result.models, []);
			assert.deepStrictEqual(result.observedModelInfoKeys, []);
		});

		test("observedModelInfoKeys is absent on the /v1/models fallback and capped against hostile payloads", async () => {
			mswServer.use(
				http.get(MODEL_INFO_URL, () => emptyErrorResponse(404)),
				http.get(MODELS_URL, () => HttpResponse.json({ object: "list", data: [{ id: "fallback-model" }] }))
			);
			const fallback = await fetchModels(request());
			assert.deepStrictEqual(
				fallback.models.map((m) => m.id),
				["fallback-model"]
			);
			assert.ok(
				!("observedModelInfoKeys" in fallback),
				"the fallback listing reports no model_info, so the field must be absent, not empty"
			);

			const hostile = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`k${String(i).padStart(4, "0")}`, 1]));
			mswServer.use(
				http.get(MODEL_INFO_URL, () => HttpResponse.json({ data: [{ model_name: "m", model_info: hostile }] }))
			);
			const capped = await fetchModels(request());
			assert.strictEqual(capped.observedModelInfoKeys?.length, 512, "the union truncates deterministically at 512");
			assert.strictEqual(capped.observedModelInfoKeys?.[0], "k0000", "truncation happens after the sort");
		});

		test("one malformed model/info element is skipped without aborting registration", async () => {
			let modelsEndpointCalled = false;
			mswServer.use(
				http.get(MODEL_INFO_URL, () =>
					HttpResponse.json({
						data: [
							{ model_name: "good-model", model_info: { supports_function_calling: true } },
							{ model_name: 42, bogus: true },
							{ id: "listing-shaped-model", providers: [] },
						],
					})
				),
				http.get(MODELS_URL, () => {
					modelsEndpointCalled = true;
					return HttpResponse.json({ object: "list", data: [] });
				})
			);

			const logs: string[] = [];
			const { models } = await fetchModels(request((m) => logs.push(m)));

			assert.deepStrictEqual(
				models.map((m) => m.id),
				["good-model", "listing-shaped-model"]
			);
			assert.strictEqual(modelsEndpointCalled, false, "Valid entries must not trigger the /v1/models fallback");
			assert.ok(
				logs.some((m) => m.includes("Skipping malformed model/info entry")),
				`Expected a skip log line, got: ${logs.join(" | ")}`
			);
		});

		test("nonempty model/info payload with zero valid items falls back to /v1/models", async () => {
			mswServer.use(
				http.get(MODEL_INFO_URL, () => HttpResponse.json({ data: [{ nothing: "usable" }, 17] })),
				http.get(MODELS_URL, () => HttpResponse.json({ object: "list", data: [{ id: "fallback-model" }] }))
			);

			const logged: { message: string; data?: unknown }[] = [];
			const { models } = await fetchModels(request((message, data) => logged.push({ message, data })));

			assert.deepStrictEqual(
				models.map((m) => m.id),
				["fallback-model"]
			);
			const fallbackLog = logged.find((l) => l.message.includes("no usable models"));
			assert.ok(fallbackLog, "Expected a fallback log line naming the raw payload");
			assert.ok(
				JSON.stringify(fallbackLog.data).includes("usable"),
				"Fallback log should include the first raw element"
			);
		});

		test("a failing model/info response never leaks its body into the fallback log", async () => {
			const echoedSecret = "sk-super-secret-key-echoed-by-gateway";
			// 401 and 400 both echo the body immediately; 5xx would be retried by
			// the SDK until the discovery timeout wins, which tests a different path.
			for (const status of [401, 400]) {
				mswServer.use(
					http.get(MODEL_INFO_URL, () =>
						HttpResponse.json({ error: `invalid bearer token ${echoedSecret}` }, { status })
					),
					http.get(MODELS_URL, () => HttpResponse.json({ object: "list", data: [{ id: "fallback-model" }] }))
				);

				const logged: { message: string; data?: unknown }[] = [];
				const { models } = await fetchModels(request((message, data) => logged.push({ message, data })));

				assert.deepStrictEqual(
					models.map((m) => m.id),
					["fallback-model"],
					`status ${status}`
				);
				const fallbackLog = logged.find((l) => l.message.includes(`falling back to ${MODELS_URL}`));
				assert.ok(fallbackLog, `Expected the classified fallback log line for status ${status}`);
				assert.strictEqual(
					(fallbackLog.data as { status?: number }).status,
					status,
					`The classification keeps the status for diagnosis; got ${JSON.stringify(fallbackLog.data)}`
				);
				for (const entry of logged) {
					const line = `${entry.message} ${JSON.stringify(entry.data) ?? ""}`;
					assert.ok(!line.includes(echoedSecret), `Log line leaked the ${status} response body: ${line}`);
				}
			}
		});

		test("a non-JSON models response throws classified: the payload snippet stays off public surfaces", async () => {
			// V8's SyntaxError quotes a snippet of the unparseable payload, so the
			// thrown message is response-derived; only the classification is public.
			const marker = "internal-gateway-host-MARKER upstream capacity exhausted";
			let modelsAttempts = 0;
			mswServer.use(
				http.get(MODEL_INFO_URL, () => HttpResponse.text(marker, { status: 200 })),
				http.get(MODELS_URL, () => {
					modelsAttempts += 1;
					return HttpResponse.text(marker, { status: 200 });
				})
			);

			const error = await fetchModels(request()).then(
				() => assert.fail("a non-JSON models body must fail discovery"),
				(e: unknown) => e
			);

			assert.strictEqual(modelsAttempts, 1, "a 200 with an unparseable body must not be retried");
			assert.ok(error instanceof RequestError, `expected a RequestError, got ${String(error)}`);
			assert.ok(error.message.startsWith("The server replied, but not with a model list"), error.message);
			assert.ok(error.message.includes(`Unparseable response from ${MODELS_URL}`), error.message);
			assert.strictEqual(error.message.split("\n").length, 2, `headline plus one detail line: ${error.message}`);
			assert.strictEqual(error.logClassification, "RequestError(http, unparseable models response body)");
			// The display message localizes; under the English fallback its full
			// English mirror (what the output channel renders) is identical.
			assert.strictEqual(error.englishMessage, error.message, "the English mirror must match the English display");
			assert.ok(!publicErrorText(error).includes("MARKER"), "the public rendering leaked the payload snippet");
		});

		test("a malformed application/json models body throws the same classification via the SDK's own parse", async () => {
			// The SDK parses JSON itself when the content type advertises it, so its
			// SyntaxError arrives at a different rethrow branch than coerceJsonPayload;
			// the two sites must stay indistinguishable on every rendering.
			const body = '{"data": [MARKER-not-json';
			let modelsAttempts = 0;
			mswServer.use(
				http.get(MODEL_INFO_URL, () => HttpResponse.text(body, { headers: { "Content-Type": "application/json" } })),
				http.get(MODELS_URL, () => {
					modelsAttempts += 1;
					return HttpResponse.text(body, { headers: { "Content-Type": "application/json" } });
				})
			);

			const error = await fetchModels(request()).then(
				() => assert.fail("a malformed application/json models body must fail discovery"),
				(e: unknown) => e
			);

			assert.strictEqual(modelsAttempts, 1, "a 200 with an unparseable body must not be retried");
			assert.ok(error instanceof RequestError, `expected a RequestError, got ${String(error)}`);
			assert.ok(error.message.startsWith("The server replied, but not with a model list"), error.message);
			assert.ok(error.message.includes(`Unparseable response from ${MODELS_URL}`), error.message);
			assert.strictEqual(error.message.split("\n").length, 2, `headline plus one detail line: ${error.message}`);
			assert.strictEqual(error.logClassification, "RequestError(http, unparseable models response body)");
			assert.strictEqual(error.englishMessage, error.message, "the English mirror must match the English display");
			assert.ok(!publicErrorText(error).includes("MARKER"), "the public rendering leaked the payload snippet");
		});

		test("model/info payload without a data array falls back to /v1/models", async () => {
			mswServer.use(
				http.get(MODEL_INFO_URL, () => HttpResponse.json({ data: { not: "an array" } })),
				http.get(MODELS_URL, () => HttpResponse.json({ object: "list", data: [{ id: "fallback-model" }] }))
			);

			const { models } = await fetchModels(request());
			assert.deepStrictEqual(
				models.map((m) => m.id),
				["fallback-model"]
			);
		});

		test("/v1/models items without providers are normalized to an empty providers array", async () => {
			mswServer.use(
				http.get(MODEL_INFO_URL, () => emptyErrorResponse(500)),
				http.get(MODELS_URL, () => HttpResponse.json({ object: "list", data: [{ id: "bare-model" }, { id: 42 }] }))
			);

			const logs: string[] = [];
			const { models } = await fetchModels(request((m) => logs.push(m)));

			assert.strictEqual(models.length, 1);
			const model = expectDefined(models[0]);
			assert.strictEqual(model.id, "bare-model");
			assert.deepStrictEqual(model.shape, { kind: "bare" });
			assert.ok(
				logs.some((m) => m.includes("Skipping malformed models entry")),
				"Malformed /v1/models entries should be skipped with a log line"
			);
		});

		test("/v1/models provider entries get long-context tier costs synthesized from their raw keys", async () => {
			mswServer.use(
				http.get(MODEL_INFO_URL, () => emptyErrorResponse(500)),
				http.get(MODELS_URL, () =>
					HttpResponse.json({
						object: "list",
						data: [
							{
								id: "tiered-model",
								providers: [
									{
										provider: "openai",
										input_cost_per_token: 0.000001,
										input_cost_per_token_above_128k_tokens: 0.000002,
										long_context_output_cost_per_token: 0.000005,
									},
								],
							},
						],
					})
				)
			);

			const { models } = await fetchModels(request());
			const provider = expectDefined(expectShape(expectDefined(models[0]), "group").providers[0]);
			assert.strictEqual(provider.long_context_input_cost_per_token, 0.000002);
			assert.strictEqual(
				provider.long_context_output_cost_per_token,
				undefined,
				"a raw look-alike of the synthesized key never smuggles a tier cost past selection"
			);
			assert.strictEqual(provider.input_cost_per_token, 0.000001, "base costs still pass through untouched");
		});

		test("wire provider entries cannot forge the internal discriminants or smuggle malformed costs", async () => {
			mswServer.use(
				http.get(MODEL_INFO_URL, () => emptyErrorResponse(500)),
				http.get(MODELS_URL, () =>
					HttpResponse.json({
						object: "list",
						data: [
							{
								id: "forged-model",
								providers: [
									{
										provider: "openai",
										status: "active",
										// A forged output_limit_source would demote the
										// genuinely declared limit below.
										output_limit_source: "defaults",
										max_output_tokens: 8000,
										input_cost_per_token: "0.000001",
									},
								],
							},
						],
					})
				)
			);

			const { models } = await fetchModels(request());
			const model = expectDefined(models[0]);
			const provider = expectDefined(expectShape(model, "group").providers[0], "the wire cannot mint a deployment");
			assert.strictEqual(
				provider.output_limit_source,
				undefined,
				"the merge's provenance marker is discovery-authored, never wire-supplied"
			);
			assert.strictEqual(
				deriveTokenConstraints(provider).outputLimitSource,
				"provider",
				"the declared 8000 output limit stays server-declared despite the forged demotion"
			);
			assert.strictEqual(provider.input_cost_per_token, undefined, "a string cost is re-narrowed to absent");
		});

		test("malformed nested provider entries are dropped without crashing registration", async () => {
			const payload = {
				data: [
					{
						id: "mixed-model",
						providers: [null, "bogus", { supports_tools: true }, { provider: "openai", supports_tools: true }],
					},
				],
			};
			mswServer.use(
				http.get(MODEL_INFO_URL, () => HttpResponse.json(payload)),
				http.get(MODELS_URL, () => HttpResponse.json(payload))
			);

			const logs: string[] = [];
			const { models } = await fetchModels(request((msg) => logs.push(msg)));
			assert.strictEqual(models.length, 1);
			const shape = expectShape(expectDefined(models[0]), "group");
			assert.strictEqual(shape.providers.length, 1, "Only the well-formed provider survives");
			assert.strictEqual(shape.providers[0].provider, "openai");
			assert.ok(
				logs.some((l) => l.includes("Skipping malformed provider entry")),
				"Dropped provider entries must be logged"
			);
		});

		test("conflicting model identifiers resolve by documented priority with valid strings only", async () => {
			const payload = {
				data: [
					{ model_name: 42, litellm_params: { model: "good-fallback" } },
					{ id: "listing-id", model_name: "preferred-name" },
				],
			};
			mswServer.use(
				http.get(MODEL_INFO_URL, () => HttpResponse.json(payload)),
				http.get(MODELS_URL, () => HttpResponse.json(payload))
			);

			const { models } = await fetchModels(request());
			assert.deepStrictEqual(
				models.map((m) => m.id),
				["good-fallback", "preferred-name"],
				"Non-string candidates are skipped and model_name wins over a listing id"
			);
		});

		test("blocked model/info entries are dropped while active models register", async () => {
			let modelsEndpointCalled = false;
			mswServer.use(
				http.get(MODEL_INFO_URL, () =>
					HttpResponse.json({
						data: [
							{ model_name: "paused-model", model_info: { blocked: true, supports_function_calling: true } },
							{ model_name: "active-model", model_info: { supports_function_calling: true } },
						],
					})
				),
				http.get(MODELS_URL, () => {
					modelsEndpointCalled = true;
					return HttpResponse.json({ object: "list", data: [{ id: "paused-model" }, { id: "active-model" }] });
				})
			);

			const logs: string[] = [];
			const { models } = await fetchModels(request((m) => logs.push(m)));

			assert.deepStrictEqual(
				models.map((m) => m.id),
				["active-model"]
			);
			assert.strictEqual(modelsEndpointCalled, false, "Active entries must not trigger the /v1/models fallback");
			assert.ok(
				logs.some((m) => m.includes("Skipping blocked model/info entry")),
				`Expected a blocked-skip log line, got: ${logs.join(" | ")}`
			);
		});

		test("provably non-chat model_info modes are dropped while chat and unknown modes register", async () => {
			let modelsEndpointCalled = false;
			mswServer.use(
				http.get(MODEL_INFO_URL, () =>
					HttpResponse.json({
						data: [
							{ model_name: "text-embedding-4", model_info: { mode: "embedding" } },
							{ model_name: "dall-e-5", model_info: { mode: "image_generation" } },
							{ model_name: "tts-2", model_info: { mode: "audio_speech" } },
							{ model_name: "whisper-3", model_info: { mode: "audio_transcription" } },
							{ model_name: "rerank-4", model_info: { mode: "rerank" } },
							{ model_name: "guard-2", model_info: { mode: "moderation" } },
							{ model_name: "fim-coder", model_info: { mode: "completion" } },
							{ model_name: "chat-model", model_info: { mode: "chat" } },
							{ model_name: "responses-model", model_info: { mode: "responses" } },
							{ model_name: "unlabeled-model", model_info: {} },
							{ model_name: "future-model", model_info: { mode: "holographic_chat" } },
						],
					})
				),
				http.get(MODELS_URL, () => {
					modelsEndpointCalled = true;
					return HttpResponse.json({ object: "list", data: [] });
				})
			);

			const logged: { message: string; data?: unknown }[] = [];
			const { models } = await fetchModels(request((message, data) => logged.push({ message, data })));

			assert.deepStrictEqual(
				models.map((m) => m.id),
				["chat-model", "responses-model", "unlabeled-model", "future-model"],
				"only the provably non-chat modes drop; absent and unrecognized modes must keep registering"
			);
			assert.strictEqual(modelsEndpointCalled, false, "surviving entries must not trigger the /v1/models fallback");
			const skips = logged.filter((l) => l.message.includes("Skipping non-chat model/info entry"));
			assert.deepStrictEqual(
				skips.map((l) => l.data),
				[
					"embedding",
					"image_generation",
					"audio_speech",
					"audio_transcription",
					"rerank",
					"moderation",
					"completion",
				].map((mode) => ({ mode })),
				"one skip line per dropped entry, carrying only the known mode constant"
			);
			for (const droppedId of ["text-embedding-4", "dall-e-5", "tts-2", "whisper-3", "rerank-4", "guard-2"]) {
				assert.ok(
					!JSON.stringify(logged).includes(droppedId),
					`the server-provided model id ${droppedId} must stay out of the log (it feeds the issue-report buffer)`
				);
			}
		});

		test("an all-non-chat model/info payload yields no models and never falls back to /v1/models", async () => {
			// Mirrors the all-blocked pin: a mode-skipped entry still counts as
			// usable, so the fallback (which would re-list the skipped models via
			// /v1/models) must not fire.
			let modelsEndpointCalled = false;
			mswServer.use(
				http.get(MODEL_INFO_URL, () =>
					HttpResponse.json({
						data: [
							{ model_name: "embed-a", model_info: { mode: "embedding" } },
							{ model_name: "embed-b", model_info: { mode: "embedding" } },
						],
					})
				),
				http.get(MODELS_URL, () => {
					modelsEndpointCalled = true;
					return HttpResponse.json({ object: "list", data: [{ id: "embed-a" }, { id: "embed-b" }] });
				})
			);

			const { models } = await fetchModels(request());

			assert.deepStrictEqual(models, []);
			assert.strictEqual(
				modelsEndpointCalled,
				false,
				"The /v1/models fallback would re-list the non-chat models; an all-non-chat payload must stay empty"
			);
		});

		test("a malformed mode value degrades to undefined and the entry registers", async () => {
			mswServer.use(
				http.get(MODEL_INFO_URL, () =>
					HttpResponse.json({
						data: [{ model_name: "odd-mode-model", model_info: { mode: 42 } }],
					})
				)
			);

			const { models } = await fetchModels(request());
			assert.deepStrictEqual(
				models.map((m) => m.id),
				["odd-mode-model"],
				"a non-string mode is lenient-parsed to undefined, which never drops the entry"
			);
		});

		test("supports_audio_input maps into the model's input modalities", async () => {
			mswServer.use(
				http.get(MODEL_INFO_URL, () =>
					HttpResponse.json({
						data: [
							{ model_name: "audio-model", model_info: { supports_audio_input: true } },
							{ model_name: "text-model", model_info: { supports_audio_input: false } },
						],
					})
				)
			);

			const { models } = await fetchModels(request());
			assert.deepStrictEqual(expectDefined(models[0]).architecture?.input_modalities, ["audio"]);
			assert.strictEqual(expectDefined(models[1]).architecture, undefined, "an explicit false adds no modality");
		});

		test("an all-blocked model/info payload yields no models and never falls back to /v1/models", async () => {
			let modelsEndpointCalled = false;
			mswServer.use(
				http.get(MODEL_INFO_URL, () =>
					HttpResponse.json({
						data: [
							{ model_name: "paused-a", model_info: { blocked: true } },
							{ model_name: "paused-b", model_info: { blocked: true } },
						],
					})
				),
				http.get(MODELS_URL, () => {
					modelsEndpointCalled = true;
					return HttpResponse.json({ object: "list", data: [{ id: "paused-a" }, { id: "paused-b" }] });
				})
			);

			const { models } = await fetchModels(request());

			assert.deepStrictEqual(models, []);
			assert.strictEqual(
				modelsEndpointCalled,
				false,
				"The /v1/models fallback would re-list the blocked models; an all-blocked payload must stay empty"
			);
		});

		test("garbage plus blocked entries fail closed: empty list, no /v1/models fallback (deliberate)", async () => {
			// A recognized-but-blocked entry counts as usable on purpose: falling back
			// to /v1/models here would re-list the blocked model.
			let modelsEndpointCalled = false;
			mswServer.use(
				http.get(MODEL_INFO_URL, () =>
					HttpResponse.json({
						data: [{ nothing: "usable" }, 17, { model_name: "paused-model", model_info: { blocked: true } }],
					})
				),
				http.get(MODELS_URL, () => {
					modelsEndpointCalled = true;
					return HttpResponse.json({ object: "list", data: [{ id: "paused-model" }] });
				})
			);

			const { models } = await fetchModels(request());

			assert.deepStrictEqual(models, []);
			assert.strictEqual(
				modelsEndpointCalled,
				false,
				"One blocked-but-recognized entry must keep the payload fail-closed instead of falling back"
			);
		});

		test("load-balanced duplicate model/info entries merge into one model with intersected capabilities", async () => {
			mswServer.use(
				...discoveryHandlers({
					data: [
						{
							model_name: "balanced-model",
							model_info: {
								supports_function_calling: true,
								supports_vision: true,
								supports_reasoning: true,
								supports_prompt_caching: true,
								max_input_tokens: 128000,
								max_output_tokens: 16000,
								supported_openai_params: ["temperature", "seed"],
								supports_low_reasoning_effort: true,
								supports_high_reasoning_effort: true,
								supports_max_reasoning_effort: true,
							},
						},
						{
							model_name: "balanced-model",
							model_info: {
								supports_function_calling: true,
								supports_vision: false,
								supports_reasoning: true,
								supports_prompt_caching: false,
								max_input_tokens: 64000,
								max_output_tokens: 8000,
								supported_openai_params: ["temperature"],
								supports_low_reasoning_effort: true,
								supports_xhigh_reasoning_effort: true,
								supports_max_reasoning_effort: true,
							},
						},
					],
				})
			);

			const { models } = await fetchModels(request());

			assert.strictEqual(models.length, 1, "One deployment entry per model_name must collapse to one model");
			const model = expectDefined(models[0]);
			assert.strictEqual(model.id, "balanced-model");
			const provider = expectShape(model, "deployment").provider;
			assert.strictEqual(provider.max_input_tokens, 64000);
			assert.strictEqual(provider.max_output_tokens, 8000);
			assert.strictEqual(provider.context_length, 64000);
			assert.strictEqual(provider.supports_tools, true);
			assert.strictEqual(provider.supports_reasoning, true);
			assert.strictEqual(provider.supports_prompt_caching, false);
			assert.deepStrictEqual(provider.supported_openai_params, ["temperature"]);
			assert.deepStrictEqual(
				provider.reasoning_effort_levels,
				["low", "max"],
				"the flag-derived level lists intersect like the supported params"
			);
			assert.strictEqual(model.architecture, undefined, "Vision holds only when every deployment advertises it");
		});

		test("a blocked deployment does not drag down the surviving deployment's limits", async () => {
			mswServer.use(
				...discoveryHandlers({
					data: [
						{
							model_name: "half-paused",
							model_info: {
								blocked: true,
								supports_function_calling: false,
								max_input_tokens: 1000,
								max_output_tokens: 100,
							},
						},
						{
							model_name: "half-paused",
							model_info: { supports_function_calling: true, max_input_tokens: 128000, max_output_tokens: 16000 },
						},
					],
				})
			);

			const { models } = await fetchModels(request());

			assert.strictEqual(models.length, 1);
			const provider = expectShape(expectDefined(models[0]), "deployment").provider;
			assert.strictEqual(provider.max_input_tokens, 128000);
			assert.strictEqual(provider.max_output_tokens, 16000);
			assert.strictEqual(provider.supports_tools, true, "The blocked deployment must not veto tool support");
		});

		test("a deployment without an output limit caps the merged model at the built-in floor", async () => {
			// One deployment has no output limit, so its floor fill bounds the merged
			// model regardless of what the other declares.
			mswServer.use(
				...discoveryHandlers({
					data: [
						{ model_name: "floor-model", model_info: { max_input_tokens: 128000, max_output_tokens: 32000 } },
						{ model_name: "floor-model", model_info: { max_input_tokens: 128000 } },
					],
				})
			);

			const { models } = await fetchModels(request());
			const server = { id: "srv1", label: "Default", baseUrl: TEST_BASE_URL, apiKey: "test-key" };
			const infos = buildModelInfos(models, server, 1, () => {}).infos;

			const info = expectDefined(infos.find((i) => i.id === "floor-model"));
			assert.strictEqual(
				info.maxOutputTokens,
				CAPABILITY_FLOOR.max_output_tokens,
				"the floor-filled deployment bounds the merged output limit"
			);
			assert.strictEqual(info.maxInputTokens, 128000, "the deployments' own input limit is unaffected");
		});

		test("401 from /v1/models surfaces as an authentication error, not a network error", async () => {
			mswServer.use(
				http.get(MODEL_INFO_URL, () => emptyErrorResponse(500)),
				http.get(MODELS_URL, () => HttpResponse.json({ error: "unauthorized" }, { status: 401 }))
			);

			await assert.rejects(fetchModels(request()), (err: Error) => {
				assert.match(err.message, /^Authentication failed/);
				assert.ok(!err.message.includes("Network Error"), `401 must not be re-wrapped: ${err.message}`);
				return true;
			});
		});

		// msw cannot fabricate undici's ECONNREFUSED cause chain, so this stays on withFetch.
		test("connection refusal is classified as a connection error", async () => {
			await withFetch(
				async () => {
					throw Object.assign(new TypeError("fetch failed"), {
						cause: new Error("connect ECONNREFUSED 127.0.0.1:4000"),
					});
				},
				async () => {
					await assert.rejects(fetchModels(request()), /Connection Error: Unable to connect to http:\/\/litellm\.test/);
				}
			);
		});

		test("transient 5xx discovery failures are retried and then succeed", async function () {
			this.timeout(15000);
			const attempts = { info: 0, models: 0 };
			mswServer.use(
				http.get(MODEL_INFO_URL, () => {
					attempts.info += 1;
					if (attempts.info < 3) {
						return emptyErrorResponse(500);
					}
					return HttpResponse.json({
						data: [{ model_name: "retried-model", model_info: { supports_function_calling: true } }],
					});
				}),
				http.get(MODELS_URL, () => {
					attempts.models += 1;
					return HttpResponse.json({ object: "list", data: [] });
				})
			);

			const { models } = await fetchModels(request());
			assert.deepStrictEqual(
				models.map((m) => m.id),
				["retried-model"],
				"The third attempt succeeds without falling back"
			);
			assert.strictEqual(attempts.info, 3, "Two retries after the initial attempt");
			assert.strictEqual(attempts.models, 0, "No fallback once a retry succeeds");
		});

		test("an expected model/info failure gets a single attempt and the fallback log carries the classification", async () => {
			const attempts = { info: 0, models: 0 };
			const logged: string[] = [];
			mswServer.use(
				http.get(MODEL_INFO_URL, () => {
					attempts.info += 1;
					return emptyErrorResponse(500);
				}),
				http.get(MODELS_URL, () => {
					attempts.models += 1;
					return HttpResponse.json({ object: "list", data: [{ id: "fallback-model" }] });
				})
			);

			const { models } = await fetchModels({
				...request((message) => logged.push(message)),
				expected: { modelInfo: true, modelListing: false },
			});
			assert.deepStrictEqual(
				models.map((m) => m.id),
				["fallback-model"],
				"the fallback chain is unchanged: an expected model/info failure still falls back"
			);
			assert.strictEqual(attempts.info, 1, "an expected endpoint gets exactly one attempt");
			assert.ok(
				logged.some((message) => message.includes("(expected: modelInfo)")),
				`the existing fallback line carries the expected classification, got: ${JSON.stringify(logged)}`
			);
			assert.ok(
				logged.every((message) => !message.includes("(expected: modelListing)")),
				"only the declared category is annotated"
			);
		});

		test("an expected models failure gets a single attempt and still throws the terminal error", async () => {
			const attempts = { info: 0, models: 0 };
			mswServer.use(
				http.get(MODEL_INFO_URL, () => {
					attempts.info += 1;
					return emptyErrorResponse(500);
				}),
				http.get(MODELS_URL, () => {
					attempts.models += 1;
					return emptyErrorResponse(500);
				})
			);

			await assert.rejects(
				fetchModels({ ...request(), expected: { modelInfo: true, modelListing: true } }),
				RequestError,
				"error ownership is unchanged: the terminal /models failure still throws"
			);
			assert.strictEqual(attempts.info, 1);
			assert.strictEqual(attempts.models, 1);
		});

		test("an expected models failure leaves the model/info retry budget alone", async function () {
			this.timeout(15000);
			const attempts = { info: 0, models: 0 };
			mswServer.use(
				http.get(MODEL_INFO_URL, () => {
					attempts.info += 1;
					return emptyErrorResponse(500);
				}),
				http.get(MODELS_URL, () => {
					attempts.models += 1;
					return emptyErrorResponse(500);
				})
			);

			await assert.rejects(fetchModels({ ...request(), expected: { modelInfo: false, modelListing: true } }));
			assert.strictEqual(attempts.info, 3, "the retry budget is per endpoint, not per call");
			assert.strictEqual(attempts.models, 1);
		});

		test("a large Retry-After cannot stall discovery past the timeout", async function () {
			this.timeout(15000);
			mswServer.use(
				// 404 is not retryable, so discovery falls straight through to /v1/models.
				http.get(MODEL_INFO_URL, () => new HttpResponse("not found", { status: 404 })),
				http.get(MODELS_URL, () => emptyErrorResponse(500, { "Retry-After": "60" }))
			);

			const started = Date.now();
			await assert.rejects(fetchModels({ ...request(), discoveryTimeout: 1000 }), /discovery\.timeout/);
			const elapsed = Date.now() - started;
			assert.ok(elapsed < 6000, `Timeout must bound the whole call including backoff sleeps, took ${elapsed}ms`);
		});

		suite("endpoint-unsupported classification", () => {
			const hangForever = async (): Promise<Response> => {
				await delay("infinite");
				return emptyErrorResponse(503);
			};
			const modelsListing = () => HttpResponse.json({ object: "list", data: [{ id: "fallback-model" }] });
			/** A model/info payload that answers (HTTP 200, parseable JSON) but still forces the fallback. */
			const unusableModelInfo = () => HttpResponse.json({ object: "no data array here" });

			test("model-info 404 beside a /models success marks the result modelInfoUnsupported: status", async () => {
				mswServer.use(
					http.get(MODEL_INFO_URL, () => emptyErrorResponse(404)),
					http.get(MODELS_URL, modelsListing)
				);
				const result = await fetchModels(request());
				assert.deepStrictEqual(
					result.models.map((m) => m.id),
					["fallback-model"]
				);
				assert.strictEqual(result.modelInfoUnsupported, "status");
			});

			test("model-info hanging to timeout beside a /models success marks the result modelInfoUnsupported: timeout", async function () {
				this.timeout(15000);
				mswServer.use(http.get(MODEL_INFO_URL, hangForever), http.get(MODELS_URL, modelsListing));
				const result = await fetchModels({ ...request(), discoveryTimeout: 500 });
				assert.strictEqual(result.modelInfoUnsupported, "timeout");
			});

			test("a model-info 500 proves nothing about endpoint support: no marker", async function () {
				this.timeout(15000);
				mswServer.use(
					http.get(MODEL_INFO_URL, () => emptyErrorResponse(500)),
					http.get(MODELS_URL, modelsListing)
				);
				const result = await fetchModels(request());
				assert.strictEqual(result.modelInfoUnsupported, undefined);
			});

			test("a declared-expected model-info failure gets no marker: the declaration already covers it", async () => {
				mswServer.use(
					http.get(MODEL_INFO_URL, () => emptyErrorResponse(404)),
					http.get(MODELS_URL, modelsListing)
				);
				const result = await fetchModels({ ...request(), expected: { modelInfo: true, modelListing: false } });
				assert.strictEqual(result.modelInfoUnsupported, undefined);
			});

			test("a listing 404 while model-info answered throws the declaration hint naming the entry", async () => {
				mswServer.use(
					http.get(MODEL_INFO_URL, unusableModelInfo),
					http.get(MODELS_URL, () => emptyErrorResponse(404))
				);
				await assert.rejects(fetchModels({ ...request(), entryLabel: "Ollama" }), (error: unknown) => {
					assert.ok(error instanceof RequestError);
					assert.strictEqual(error.kind, "http");
					assert.strictEqual(error.status, 404);
					assert.strictEqual(error.unsupportedEndpoint, "modelListing");
					assert.match(error.message, /"expectedFailures": \["modelListing"\]/);
					assert.match(error.message, /"Ollama" entry/);
					assert.match(error.message, /discovery\.declared/);
					assert.ok(error.englishMessage?.includes('"expectedFailures": ["modelListing"]'));
					assert.strictEqual(
						error.logClassification,
						"RequestError(http, status 404, discovery, models listing unserved)"
					);
					return true;
				});
			});

			test("the same hint without an entry label points at the servers setting instead", async () => {
				mswServer.use(
					http.get(MODEL_INFO_URL, unusableModelInfo),
					http.get(MODELS_URL, () => emptyErrorResponse(405))
				);
				await assert.rejects(fetchModels(request()), (error: unknown) => {
					assert.ok(error instanceof RequestError);
					assert.strictEqual(error.status, 405);
					assert.strictEqual(error.unsupportedEndpoint, "modelListing");
					assert.match(error.message, /"litellm-vscode-chat\.servers" setting/);
					return true;
				});
			});

			test("a listing that times out while model-info answered gets the timeout flavor of the hint", async function () {
				this.timeout(15000);
				mswServer.use(http.get(MODEL_INFO_URL, unusableModelInfo), http.get(MODELS_URL, hangForever));
				await assert.rejects(
					fetchModels({ ...request(), discoveryTimeout: 400, entryLabel: "Ollama" }),
					(error: unknown) => {
						assert.ok(error instanceof RequestError);
						assert.strictEqual(error.kind, "timeout");
						assert.strictEqual(error.unsupportedEndpoint, "modelListing");
						assert.match(error.message, /"expectedFailures": \["modelListing"\]/);
						assert.match(error.message, /timed out after 400ms/);
						assert.strictEqual(error.logClassification, "RequestError(timeout, discovery, models listing unserved)");
						return true;
					}
				);
			});

			test("a declared-expected model-info failure beside an unserved listing still earns the listing hint", async () => {
				mswServer.use(
					http.get(MODEL_INFO_URL, () => emptyErrorResponse(404)),
					http.get(MODELS_URL, () => emptyErrorResponse(405))
				);
				await assert.rejects(
					fetchModels({ ...request(), entryLabel: "Ollama", expected: { modelInfo: true, modelListing: false } }),
					(error: unknown) => {
						assert.ok(error instanceof RequestError);
						assert.strictEqual(error.unsupportedEndpoint, "modelListing");
						// The neutralized probe is named as such, never as an answer.
						assert.match(error.message, /model info is declared an expected failure/);
						return true;
					}
				);
			});

			test("a declared-expected listing failure keeps its mapped error: no hint for a declaration already made", async () => {
				mswServer.use(
					http.get(MODEL_INFO_URL, unusableModelInfo),
					http.get(MODELS_URL, () => emptyErrorResponse(404))
				);
				await assert.rejects(
					fetchModels({ ...request(), expected: { modelInfo: false, modelListing: true } }),
					(error: unknown) => {
						assert.ok(error instanceof RequestError);
						assert.strictEqual(error.unsupportedEndpoint, undefined);
						assert.match(error.message, /does not serve the LiteLLM API/);
						return true;
					}
				);
			});

			test("both endpoints timing out replaces the raise-the-timeout advice with the not-OpenAI-compatible verdict", async function () {
				this.timeout(15000);
				mswServer.use(http.get(MODEL_INFO_URL, hangForever), http.get(MODELS_URL, hangForever));
				await assert.rejects(fetchModels({ ...request(), discoveryTimeout: 400 }), (error: unknown) => {
					assert.ok(error instanceof RequestError);
					assert.strictEqual(error.kind, "timeout");
					assert.strictEqual(error.setupHint, "check-base-url");
					assert.strictEqual(error.unsupportedEndpoint, undefined, "both-unserved earns no declaration hint");
					assert.match(error.message, /does not look like a LiteLLM or OpenAI-compatible API/);
					assert.ok(
						!error.message.includes("discovery.timeout"),
						"the raise-the-timeout advice is exactly what this verdict replaces (#261)"
					);
					assert.ok(error.englishMessage?.includes("does not look like a LiteLLM or OpenAI-compatible API"));
					assert.strictEqual(error.logClassification, "RequestError(timeout, discovery, no endpoint served)");
					return true;
				});
			});

			test("both endpoints answering 405 says the server refuses them, never that neither answered", async () => {
				mswServer.use(
					http.get(MODEL_INFO_URL, () => emptyErrorResponse(405)),
					http.get(MODELS_URL, () => emptyErrorResponse(405))
				);
				await assert.rejects(fetchModels(request()), (error: unknown) => {
					assert.ok(error instanceof RequestError);
					assert.strictEqual(error.kind, "http");
					assert.strictEqual(error.status, 405);
					assert.strictEqual(error.setupHint, "check-base-url");
					assert.strictEqual(error.unsupportedEndpoint, undefined, "both-unserved earns no declaration hint");
					assert.match(error.message, /does not serve either discovery endpoint/);
					assert.match(error.message, /does not look like a LiteLLM or OpenAI-compatible API/);
					assert.ok(
						!error.message.includes("Neither discovery endpoint answered"),
						"both endpoints answered - the headline must not claim otherwise beside a detail line saying they did"
					);
					assert.match(error.message, /GET \/model\/info answered HTTP 405; GET \/models answered HTTP 405/);
					assert.ok(error.englishMessage?.includes("does not serve either discovery endpoint"));
					assert.strictEqual(error.logClassification, "RequestError(http, status 405, discovery, no endpoint served)");
					return true;
				});
			});

			test("a 404 probe beside a 405 listing is still both-refused and takes the served-nothing verdict", async () => {
				// Same evidence KIND (status), different codes: the same-kind rule only
				// excludes mixed timeout-beside-status pairs, and the 404 carve-out
				// reads the models leg alone.
				mswServer.use(
					http.get(MODEL_INFO_URL, () => emptyErrorResponse(404)),
					http.get(MODELS_URL, () => emptyErrorResponse(405))
				);
				await assert.rejects(fetchModels(request()), (error: unknown) => {
					assert.ok(error instanceof RequestError);
					assert.strictEqual(error.status, 405);
					assert.strictEqual(error.setupHint, "check-base-url");
					assert.strictEqual(error.unsupportedEndpoint, undefined);
					assert.match(error.message, /does not serve either discovery endpoint/);
					assert.match(error.message, /GET \/model\/info answered HTTP 404; GET \/models answered HTTP 405/);
					return true;
				});
			});

			test("both endpoints answering 404 keeps the docs-quoted 404 message, which already gives that verdict", async () => {
				mswServer.use(
					http.get(MODEL_INFO_URL, () => emptyErrorResponse(404)),
					http.get(MODELS_URL, () => emptyErrorResponse(404))
				);
				await assert.rejects(fetchModels(request()), (error: unknown) => {
					assert.ok(error instanceof RequestError);
					assert.match(error.message, /does not serve the LiteLLM API at this address/);
					assert.ok(!error.message.includes("Neither discovery endpoint"));
					assert.strictEqual(error.setupHint, "check-base-url");
					return true;
				});
			});

			test("mixed evidence keeps the plain timeout message: a 400 model-info failure proves nothing", async function () {
				this.timeout(15000);
				// 400 is not retryable, so the probe's verdict is its mapped HTTP class
				// - no unserved evidence - and the stalled listing keeps the
				// raise-the-timeout advice.
				mswServer.use(
					http.get(MODEL_INFO_URL, () => emptyErrorResponse(400)),
					http.get(MODELS_URL, hangForever)
				);
				await assert.rejects(fetchModels({ ...request(), discoveryTimeout: 400 }), /discovery\.timeout/);
			});

			test("mixed evidence kinds keep the plain message: a 404 probe beside a stalled listing is not both-unserved", async function () {
				this.timeout(15000);
				mswServer.use(
					http.get(MODEL_INFO_URL, () => emptyErrorResponse(404)),
					http.get(MODELS_URL, hangForever)
				);
				await assert.rejects(fetchModels({ ...request(), discoveryTimeout: 400 }), /discovery\.timeout/);
			});
		});

		test("JSON served without a JSON content type is still parsed", async () => {
			const asPlainText = (payload: unknown) =>
				new HttpResponse(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "text/plain" } });
			mswServer.use(
				http.get(MODEL_INFO_URL, () =>
					asPlainText({ data: [{ model_name: "plain-model", model_info: { supports_function_calling: true } }] })
				),
				http.get(MODELS_URL, () => asPlainText({ object: "list", data: [] }))
			);

			const { models } = await fetchModels(request());
			assert.deepStrictEqual(
				models.map((m) => m.id),
				["plain-model"],
				"A JSON body with a non-JSON content type must not silently fall back"
			);
		});
	});

	suite("mergeModelDeployments", () => {
		/** Build a deployment through the production parse-and-map path, never by hand. */
		function deployment(modelInfo: Record<string, unknown>): MappedModelInfo {
			return mapModelInfoEntry(expectDefined(parseModelInfoItem({ model_name: "balanced", model_info: modelInfo })));
		}

		test("a single deployment passes through unchanged", () => {
			const sole = deployment({ max_output_tokens: 8000, supports_prompt_caching: true, supports_vision: true });
			assert.strictEqual(mergeModelDeployments([sole]), sole);
		});

		test("disjoint per-level reasoning flags collapse to no signal, never an empty menu", () => {
			const merged = mergeModelDeployments([
				deployment({ supports_reasoning: true, supports_low_reasoning_effort: true }),
				deployment({ supports_reasoning: true, supports_high_reasoning_effort: true }),
			]);
			assert.deepStrictEqual(merged.provider.reasoning_effort_levels, [], "the raw intersection is empty");
			const { infos } = buildModelInfos(
				[{ id: "balanced", shape: { kind: "deployment", provider: merged.provider } }],
				{ id: "srv1", label: "Default", baseUrl: TEST_BASE_URL, apiKey: "k" },
				1,
				() => {}
			);
			const info = expectDefined(infos[0]);
			assert.deepStrictEqual(
				info.configurationSchema,
				reasoningEffortSchema(DEFAULT_REASONING_EFFORT_LEVELS),
				"an empty intersection reads as no signal, so the menu falls back to the built-in list"
			);
			const declared = info.litellm.serverDeclared;
			assert.ok(declared.kind === "discovered");
			assert.ok(
				!("reasoning_effort_levels" in declared.values),
				"the baseline omits the field so the walk's server level cannot pin an empty menu"
			);
		});

		test("a merged deployment's baseline never claims more than the merge advertised", () => {
			// Disagreeing per-deployment costs merge to unknown and a true+null flag
			// merges to unknown: the entry must not price the disagreeing field, and
			// the baseline must leave both unreported so lower walk levels can fill.
			const merged = mergeModelDeployments([
				deployment({
					input_cost_per_token: 0.000003,
					output_cost_per_token: 0.000015,
					supports_prompt_caching: true,
					supported_openai_params: ["temperature", "reasoning_effort"],
				}),
				deployment({
					input_cost_per_token: 0.000004,
					output_cost_per_token: 0.000015,
					supported_openai_params: ["temperature"],
				}),
			]);
			const { infos } = buildModelInfos(
				[{ id: "balanced", shape: { kind: "deployment", provider: merged.provider } }],
				{ id: "srv1", label: "Default", baseUrl: TEST_BASE_URL, apiKey: "k" },
				1,
				() => {}
			);
			const info = expectDefined(infos[0]);
			assert.ok(!("inputCost" in info), "a disagreeing cost must not price the merged entry");
			assert.strictEqual(info.outputCost, 15, "the agreed cost still prices");
			assert.strictEqual(info.litellm.supportsPromptCaching, false, "an unknown merged flag does not advertise");
			const declared = info.litellm.serverDeclared;
			assert.ok(declared.kind === "discovered");
			assert.ok(!("input_cost_per_token" in declared.values), "the baseline mirrors the un-priced field");
			assert.strictEqual(declared.values.output_cost_per_token, 0.000015);
			assert.ok(!("supports_prompt_caching" in declared.values), "an unknown (null) merged flag stays unreported");
			assert.deepStrictEqual(
				declared.values.supported_openai_params,
				["temperature"],
				"the baseline carries the merge's intersected params, never one deployment's longer list"
			);
		});

		test("merged token advertisement equals the minimum of the standalone advertisements (A/B case)", () => {
			// A advertises input/output limits; B advertises only max_tokens, so
			// standing alone B's input budget collapses to max(1, 8000 - 8000) = 1.
			// A raw per-field merge would advertise more than B could ever serve.
			const a = deployment({ max_input_tokens: 128000, max_output_tokens: 16000 });
			const b = deployment({ max_tokens: 8000 });
			const merged = mergeModelDeployments([a, b]);

			const standalone = [a, b].map((d) => deriveTokenConstraints(d.provider));
			const constraints = deriveTokenConstraints(merged.provider);
			assert.strictEqual(constraints.maxOutputTokens, Math.min(...standalone.map((c) => c.maxOutputTokens)));
			assert.strictEqual(constraints.contextLength, Math.min(...standalone.map((c) => c.contextLength)));
			assert.strictEqual(constraints.maxInputTokens, Math.min(...standalone.map((c) => c.maxInputTokens)));
			assert.strictEqual(constraints.maxOutputTokens, 8000);
			assert.strictEqual(constraints.contextLength, 8000);
			assert.strictEqual(constraints.maxInputTokens, 1);
		});

		test("a deployment without any output limit contributes the built-in floor, not another's value", () => {
			const limited = deployment({ max_output_tokens: 32000, max_input_tokens: 128000 });
			const unlimited = deployment({ max_input_tokens: 128000 });
			const merged = mergeModelDeployments([limited, unlimited]);
			const constraints = deriveTokenConstraints(merged.provider);
			assert.strictEqual(
				constraints.maxOutputTokens,
				CAPABILITY_FLOOR.max_output_tokens,
				"standalone, the second deployment would advertise the floor output limit; the merge must not exceed it"
			);
		});

		test("the merged output limit counts as server-declared only when every deployment declared one", () => {
			const allDeclared = mergeModelDeployments([
				deployment({ max_output_tokens: 16000 }),
				deployment({ max_tokens: 8000 }),
			]);
			assert.strictEqual(deriveTokenConstraints(allDeclared.provider).outputLimitSource, "provider");

			const oneUndeclared = mergeModelDeployments([
				deployment({ max_output_tokens: 16000 }),
				deployment({ max_input_tokens: 128000 }),
			]);
			assert.strictEqual(
				deriveTokenConstraints(oneUndeclared.provider).outputLimitSource,
				"defaults",
				"a floor-filled deployment must demote the merged limit, even though the merge stores it in provider fields"
			);
		});

		test("limits no deployment reported are not stored back as if the server declared them", () => {
			// A defaults-filled number stored as a provider field would occupy the
			// capability walk's server level and block the catalog from backfilling.
			const merged = mergeModelDeployments([deployment({}), deployment({ supports_vision: true })]);
			assert.strictEqual(merged.provider.context_length, undefined);
			assert.strictEqual(merged.provider.max_output_tokens, undefined);
			assert.strictEqual(merged.provider.max_tokens, undefined);
			assert.strictEqual(merged.provider.max_input_tokens, undefined);
			assert.deepStrictEqual(
				deriveTokenConstraints(merged.provider),
				deriveTokenConstraints(deployment({}).provider),
				"the merged advertisement equals the all-floor standalone one"
			);
		});

		test("a limit some deployment reported stays stored as the conservative collapse", () => {
			const merged = mergeModelDeployments([deployment({ max_output_tokens: 32000 }), deployment({})]);
			assert.strictEqual(
				merged.provider.max_output_tokens,
				Math.min(32000, CAPABILITY_FLOOR.max_output_tokens),
				"a floor-filled deployment can still contribute the minimum"
			);
			// mapModelInfoEntry grounds context_length in max_tokens, so the
			// reporting deployment reports context too and the collapse stores it.
			assert.strictEqual(merged.provider.context_length, 32000);
		});

		test("a passed-through output_limit_source can demote but never promote", () => {
			// normalizeModelItem strips the marker from wire entries, so only merged
			// providers carry it; this pins deriveTokenConstraints' defense in depth:
			// a "provider" claim without declared limit fields must not lift the cap.
			const spoofed = deriveTokenConstraints({ provider: "wire", status: "ok", output_limit_source: "provider" });
			assert.strictEqual(spoofed.outputLimitSource, "defaults");

			const demoted = deriveTokenConstraints({
				provider: "wire",
				status: "ok",
				max_output_tokens: 8000,
				output_limit_source: "defaults",
			});
			assert.strictEqual(demoted.outputLimitSource, "defaults");
			assert.strictEqual(demoted.maxOutputTokens, 8000, "the demoted value still bounds the advertisement");
		});

		test("tool support holds only when every deployment supports it", () => {
			const both = mergeModelDeployments([
				deployment({ supports_function_calling: true }),
				deployment({ supports_tool_choice: true }),
			]);
			assert.strictEqual(both.provider.supports_tools, true);
			const oneOut = mergeModelDeployments([
				deployment({ supports_function_calling: true }),
				deployment({ supports_function_calling: false }),
			]);
			assert.strictEqual(oneOut.provider.supports_tools, false);
		});

		test("capability flags AND across deployments and stay unknown when any deployment leaves them unknown", () => {
			const merged = mergeModelDeployments([
				deployment({ supports_reasoning: true, supports_prompt_caching: true, supports_pdf_input: true }),
				deployment({ supports_reasoning: true, supports_prompt_caching: false }),
			]);
			assert.strictEqual(merged.provider.supports_reasoning, true);
			assert.strictEqual(merged.provider.supports_prompt_caching, false);
			assert.strictEqual(merged.provider.supports_pdf_input, null);
		});

		test("input modalities intersect across deployments", () => {
			const merged = mergeModelDeployments([
				deployment({ supports_vision: true, supports_pdf_input: true }),
				deployment({ supports_vision: true }),
				deployment({ supports_vision: true, supports_pdf_input: true }),
			]);
			assert.deepStrictEqual(merged.inputModalities, ["image"]);
		});

		test("supported_openai_params intersect, and go unknown when any deployment omits them", () => {
			const intersected = mergeModelDeployments([
				deployment({ supported_openai_params: ["temperature", "seed", "top_p"] }),
				deployment({ supported_openai_params: ["seed", "temperature"] }),
			]);
			assert.deepStrictEqual(intersected.provider.supported_openai_params, ["temperature", "seed"]);

			const unknown = mergeModelDeployments([deployment({ supported_openai_params: ["temperature"] }), deployment({})]);
			assert.strictEqual(unknown.provider.supported_openai_params, null);
		});

		test("cost fields land on the mapped provider and malformed values degrade to absent", () => {
			const mapped = deployment({
				input_cost_per_token: 0.000003,
				output_cost_per_token: 0,
				cache_read_input_token_cost: "0.0000003" as unknown as number,
				cache_creation_input_token_cost: -0.000001,
			});
			assert.strictEqual(mapped.provider.input_cost_per_token, 0.000003);
			assert.strictEqual(mapped.provider.output_cost_per_token, 0, "a zero cost is real data, not absence");
			assert.strictEqual(mapped.provider.cache_read_input_token_cost, undefined, "a string cost never parses");
			assert.strictEqual(mapped.provider.cache_creation_input_token_cost, undefined, "a negative cost never parses");
		});

		test("pricing merges only when every deployment agrees exactly per field", () => {
			const merged = mergeModelDeployments([
				deployment({
					input_cost_per_token: 0.000003,
					output_cost_per_token: 0.000015,
					cache_read_input_token_cost: 0.0000003,
				}),
				deployment({
					input_cost_per_token: 0.000003,
					output_cost_per_token: 0.00001,
				}),
			]);
			assert.strictEqual(merged.provider.input_cost_per_token, 0.000003, "every deployment agrees, so the cost holds");
			assert.strictEqual(merged.provider.output_cost_per_token, null, "disagreeing costs must not survive the merge");
			assert.strictEqual(
				merged.provider.cache_read_input_token_cost,
				null,
				"a cost only some deployments report must not survive the merge"
			);
		});

		test("agreement on zero and joint absence both survive the merge honestly", () => {
			const merged = mergeModelDeployments([
				deployment({ input_cost_per_token: 0, output_cost_per_token: 0.000015 }),
				deployment({ input_cost_per_token: 0, output_cost_per_token: 0.000015 }),
			]);
			assert.strictEqual(merged.provider.input_cost_per_token, 0, "an agreed zero cost is data, not absence");
			assert.strictEqual(merged.provider.output_cost_per_token, 0.000015, "other agreed fields stay unaffected");
			assert.strictEqual(
				merged.provider.cache_read_input_token_cost,
				null,
				"a cost no deployment reports stays unknown"
			);
		});

		test("long-context tier costs land on the mapped provider and non-tier key variants stay out", () => {
			const tiered: Record<string, unknown> = {
				input_cost_per_token_above_200k_tokens: 0.000006,
				output_cost_per_token_above_200k_tokens: 0.0000225,
				cache_read_input_token_cost_above_200k_tokens: "0.0000006",
				cache_creation_input_token_cost_above_1hr: 0.000006,
				cache_creation_input_token_cost_above_1hr_above_200k_tokens: 0.000006,
				input_cost_per_token_above_200k_tokens_priority: 0.000012,
				input_cost_per_character_above_128k_tokens: 0.000001,
			};
			const mapped = deployment({ input_cost_per_token: 0.000003, ...tiered });
			assert.strictEqual(
				mapped.provider.long_context_input_cost_per_token,
				0.000006,
				"the _priority and per-character variants must not have overridden the token tier"
			);
			assert.strictEqual(mapped.provider.long_context_output_cost_per_token, 0.0000225);
			assert.strictEqual(
				mapped.provider.long_context_cache_read_input_token_cost,
				undefined,
				"a malformed tier cost degrades to absent like a malformed base cost"
			);
			assert.strictEqual(
				mapped.provider.long_context_cache_creation_input_token_cost,
				undefined,
				"time-window cache variants are not token tiers"
			);
			assert.strictEqual(mapped.provider.input_cost_per_token, 0.000003, "the base cost is untouched");
		});

		test("a raw long_context_* key in model_info never reaches the synthesized provider fields", () => {
			const spoof: Record<string, unknown> = { long_context_input_cost_per_token: 0.000099 };
			const mapped = deployment({ input_cost_per_token: 0.000003, ...spoof });
			assert.strictEqual(
				mapped.provider.long_context_input_cost_per_token,
				undefined,
				"the synthesized fields are discovery-authored; the wire cannot inject them"
			);
		});

		test("the lowest declared threshold wins and an all-malformed tier cannot mask a higher one", () => {
			const multiTier: Record<string, unknown> = {
				input_cost_per_token_above_128k_tokens: 0.000004,
				input_cost_per_token_above_200k_tokens: 0.000006,
				output_cost_per_token_above_200k_tokens: 0.0000225,
			};
			const lowest = deployment({ ...multiTier });
			assert.strictEqual(
				lowest.provider.long_context_input_cost_per_token,
				0.000004,
				"128k is the first boundary a growing prompt crosses, so its price is the honest single value"
			);
			assert.strictEqual(
				lowest.provider.long_context_output_cost_per_token,
				undefined,
				"a field not declared at the selected threshold stays absent instead of borrowing a higher tier's price"
			);

			const malformedLowTier: Record<string, unknown> = {
				input_cost_per_token_above_128k_tokens: "not-a-number",
				input_cost_per_token_above_200k_tokens: 0.000006,
			};
			const masked = deployment({ ...malformedLowTier });
			assert.strictEqual(
				masked.provider.long_context_input_cost_per_token,
				0.000006,
				"only tiers with a usable cost participate in threshold selection"
			);
		});

		test("long-context costs merge only when every deployment agrees exactly per field", () => {
			const tierA: Record<string, unknown> = {
				input_cost_per_token_above_128k_tokens: 0.000006,
				output_cost_per_token_above_128k_tokens: 0.0000225,
			};
			const tierB: Record<string, unknown> = {
				input_cost_per_token_above_272k_tokens: 0.000006,
				output_cost_per_token_above_272k_tokens: 0.00003,
				cache_read_input_token_cost_above_272k_tokens: 0.0000006,
			};
			const merged = mergeModelDeployments([deployment({ ...tierA }), deployment({ ...tierB })]);
			assert.strictEqual(
				merged.provider.long_context_input_cost_per_token,
				0.000006,
				"identical resolved tier prices merge even across different thresholds: the host displays no boundary"
			);
			assert.strictEqual(
				merged.provider.long_context_output_cost_per_token,
				null,
				"disagreeing tier costs must not survive the merge"
			);
			assert.strictEqual(
				merged.provider.long_context_cache_read_input_token_cost,
				null,
				"a tier cost only some deployments report must not survive the merge"
			);
		});
	});
});
