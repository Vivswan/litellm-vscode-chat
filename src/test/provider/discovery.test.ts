import * as assert from "node:assert";
import { HttpResponse, http } from "msw";
import { createServerClient } from "../../provider/clients";
import {
	fetchModels,
	isLiteLLMModelInfoItem,
	isLiteLLMModelItem,
	type MappedModelInfo,
	mapModelInfoEntry,
	mergeModelDeployments,
} from "../../provider/discovery";
import { deriveTokenConstraints } from "../../provider/modelCatalog";
import { buildModelInfos } from "../../provider/registration";
import type { LiteLLMModelInfoItem } from "../../provider/schemas";
import type { TokenDefaults } from "../../shared/settings";
import {
	discoveryHandlers,
	emptyErrorResponse,
	MODEL_INFO_URL,
	MODELS_URL,
	mswServer,
	useMsw,
} from "../mocks/handlers";
import { expectDefined, withConfig, withFetch } from "../testUtils";

/** Fixed per-pass defaults snapshot, mirroring the provider's single read per refresh. */
const TEST_TOKEN_DEFAULTS: TokenDefaults = { maxOutputTokens: 4096, contextLength: 128000, maxInputTokens: undefined };

function request(log: (message: string, data?: unknown) => void = () => {}) {
	const client = createServerClient({
		serverId: "srv1",
		baseUrl: "http://litellm.test",
		apiKey: "test-key",
		userAgent: "test-agent",
		customHeaders: {},
	});
	return {
		client,
		baseUrl: "http://litellm.test",
		discoveryTimeout: 5000,
		tokenDefaults: TEST_TOKEN_DEFAULTS,
		log,
	};
}

suite("provider/discovery", () => {
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

		test("isLiteLLMModelInfoItem requires one usable model identifier", () => {
			assert.ok(isLiteLLMModelInfoItem({ model_name: "gpt-4" }));
			assert.ok(isLiteLLMModelInfoItem({ litellm_params: { model: "openai/gpt-4" } }));
			assert.ok(isLiteLLMModelInfoItem({ model_info: { key: "gpt-4" } }));
			assert.ok(isLiteLLMModelInfoItem({ model_info: { id: "abc" } }));
			assert.ok(!isLiteLLMModelInfoItem({ model_name: "" }));
			assert.ok(!isLiteLLMModelInfoItem({ model_name: 42 }));
			assert.ok(!isLiteLLMModelInfoItem({}));
			assert.ok(!isLiteLLMModelInfoItem(null));
		});
	});

	suite("fetchModels", () => {
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
				const fallbackLog = logged.find((l) => l.message.includes("falling back to /v1/models"));
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
			assert.deepStrictEqual(model.providers, []);
			assert.ok(
				logs.some((m) => m.includes("Skipping malformed models entry")),
				"Malformed /v1/models entries should be skipped with a log line"
			);
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
			const model = expectDefined(models[0]);
			assert.strictEqual(model.providers.length, 1, "Only the well-formed provider survives");
			assert.strictEqual(expectDefined(model.providers[0]).provider, "openai");
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
			// A recognized-but-blocked entry counts as usable on purpose: falling
			// back to /v1/models here would re-list the blocked model, so the
			// garbage entry is skipped, the blocked one filtered, and the result
			// stays empty.
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
							},
						},
					],
				})
			);

			const { models } = await fetchModels(request());

			assert.strictEqual(models.length, 1, "One deployment entry per model_name must collapse to one model");
			const model = expectDefined(models[0]);
			assert.strictEqual(model.id, "balanced-model");
			assert.strictEqual(model.providers.length, 1, "The merge must keep the sole-provider registration path");
			const provider = expectDefined(model.providers[0]);
			assert.strictEqual(provider.source, "model_info");
			assert.strictEqual(provider.max_input_tokens, 64000);
			assert.strictEqual(provider.max_output_tokens, 8000);
			assert.strictEqual(provider.context_length, 64000);
			assert.strictEqual(provider.supports_tools, true);
			assert.strictEqual(provider.supports_reasoning, true);
			assert.strictEqual(provider.supports_prompt_caching, false);
			assert.deepStrictEqual(provider.supported_openai_params, ["temperature"]);
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
			const provider = expectDefined(expectDefined(models[0]).providers[0]);
			assert.strictEqual(provider.max_input_tokens, 128000);
			assert.strictEqual(provider.max_output_tokens, 16000);
			assert.strictEqual(provider.supports_tools, true, "The blocked deployment must not veto tool support");
		});

		test("the passed defaults snapshot wins over live settings from discovery through registration", async () => {
			// The provider reads getTokenDefaults() once per refresh and threads
			// that snapshot through fetchModels and buildModelInfos. Live settings
			// diverging mid-pass must not leak into either stage: one deployment
			// has no output limit, so its standalone limit comes from the
			// snapshot's default and caps the merged model.
			const snapshot: TokenDefaults = { maxOutputTokens: 2048, contextLength: 32000, maxInputTokens: undefined };
			mswServer.use(
				...discoveryHandlers({
					data: [
						{ model_name: "snapshot-model", model_info: { max_input_tokens: 128000, max_output_tokens: 16000 } },
						{ model_name: "snapshot-model", model_info: { max_input_tokens: 128000 } },
					],
				})
			);

			const infos = await withConfig({ defaultMaxOutputTokens: 999, defaultContextLength: 777 }, async () => {
				const { models } = await fetchModels({ ...request(), tokenDefaults: snapshot });
				const server = { id: "srv1", label: "Default", baseUrl: "http://litellm.test", apiKey: "test-key" };
				return buildModelInfos(models, server, 1, () => {}, snapshot).infos;
			});

			const info = expectDefined(infos.find((i) => i.id === "snapshot-model"));
			assert.strictEqual(info.maxOutputTokens, 2048, "the snapshot's default output limit must win, not the live 999");
			assert.strictEqual(
				info.maxInputTokens,
				128000,
				"the deployments' own input limit stays untouched by live settings"
			);
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

		test("a large Retry-After cannot stall discovery past the timeout", async function () {
			this.timeout(15000);
			mswServer.use(
				// 404 is not retryable, so discovery falls straight through to /v1/models.
				http.get(MODEL_INFO_URL, () => new HttpResponse("not found", { status: 404 })),
				http.get(MODELS_URL, () => emptyErrorResponse(500, { "Retry-After": "60" }))
			);

			const started = Date.now();
			await assert.rejects(fetchModels({ ...request(), discoveryTimeout: 1000 }), /discoveryTimeout/);
			const elapsed = Date.now() - started;
			assert.ok(elapsed < 6000, `Timeout must bound the whole call including backoff sleeps, took ${elapsed}ms`);
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
		/** The same fixed snapshot the fetchModels helper threads; tests never read workspace settings. */
		const DEFAULTS = TEST_TOKEN_DEFAULTS;

		/** Build a deployment through the production mapper, never by hand. */
		function deployment(modelInfo: NonNullable<LiteLLMModelInfoItem["model_info"]>): MappedModelInfo {
			return expectDefined(mapModelInfoEntry({ model_name: "balanced", model_info: modelInfo }));
		}

		test("a single deployment passes through unchanged", () => {
			const sole = deployment({ max_output_tokens: 8000, supports_prompt_caching: true, supports_vision: true });
			assert.strictEqual(mergeModelDeployments([sole], DEFAULTS), sole);
		});

		test("merged token advertisement equals the minimum of the standalone advertisements (A/B case)", () => {
			// A advertises input/output limits; B advertises only max_tokens, so
			// standing alone B's input budget collapses to max(1, 8000 - 8000) = 1.
			// A raw per-field merge would keep A's 128000 input alongside B's 8000
			// output and advertise more than B could ever serve.
			const a = deployment({ max_input_tokens: 128000, max_output_tokens: 16000 });
			const b = deployment({ max_tokens: 8000 });
			const merged = mergeModelDeployments([a, b], DEFAULTS);

			const standalone = [a, b].map((d) => deriveTokenConstraints(d.provider, DEFAULTS));
			const constraints = deriveTokenConstraints(merged.provider, DEFAULTS);
			assert.strictEqual(constraints.maxOutputTokens, Math.min(...standalone.map((c) => c.maxOutputTokens)));
			assert.strictEqual(constraints.contextLength, Math.min(...standalone.map((c) => c.contextLength)));
			assert.strictEqual(constraints.maxInputTokens, Math.min(...standalone.map((c) => c.maxInputTokens)));
			assert.strictEqual(constraints.maxOutputTokens, 8000);
			assert.strictEqual(constraints.contextLength, 8000);
			assert.strictEqual(constraints.maxInputTokens, 1);
		});

		test("a deployment without any output limit contributes the configured default, not another's value", () => {
			const limited = deployment({ max_output_tokens: 16000, max_input_tokens: 128000 });
			const unlimited = deployment({ max_input_tokens: 128000 });
			const merged = mergeModelDeployments([limited, unlimited], DEFAULTS);
			const constraints = deriveTokenConstraints(merged.provider, DEFAULTS);
			assert.strictEqual(
				constraints.maxOutputTokens,
				DEFAULTS.maxOutputTokens,
				"standalone, the second deployment would advertise the default output limit; the merge must not exceed it"
			);
		});

		test("the merged output limit counts as server-declared only when every deployment declared one", () => {
			const allDeclared = mergeModelDeployments(
				[deployment({ max_output_tokens: 16000 }), deployment({ max_tokens: 8000 })],
				DEFAULTS
			);
			assert.strictEqual(deriveTokenConstraints(allDeclared.provider, DEFAULTS).outputLimitSource, "provider");

			const oneUndeclared = mergeModelDeployments(
				[deployment({ max_output_tokens: 16000 }), deployment({ max_input_tokens: 128000 })],
				DEFAULTS
			);
			assert.strictEqual(
				deriveTokenConstraints(oneUndeclared.provider, DEFAULTS).outputLimitSource,
				"defaults",
				"a defaults-filled deployment must demote the merged limit, even though the merge stores it in provider fields"
			);
		});

		test("a passed-through output_limit_source can demote but never promote", () => {
			// providerEntrySchema is loose, so a wire payload could carry the
			// merge's internal marker; claiming "provider" without declared limit
			// fields must not lift the cap.
			const spoofed = deriveTokenConstraints(
				{ provider: "wire", status: "ok", output_limit_source: "provider" },
				DEFAULTS
			);
			assert.strictEqual(spoofed.outputLimitSource, "defaults");

			const demoted = deriveTokenConstraints(
				{ provider: "wire", status: "ok", max_output_tokens: 8000, output_limit_source: "defaults" },
				DEFAULTS
			);
			assert.strictEqual(demoted.outputLimitSource, "defaults");
			assert.strictEqual(demoted.maxOutputTokens, 8000, "the demoted value still bounds the advertisement");
		});

		test("tool support holds only when every deployment supports it", () => {
			const both = mergeModelDeployments(
				[deployment({ supports_function_calling: true }), deployment({ supports_tool_choice: true })],
				DEFAULTS
			);
			assert.strictEqual(both.provider.supports_tools, true);
			const oneOut = mergeModelDeployments(
				[deployment({ supports_function_calling: true }), deployment({ supports_function_calling: false })],
				DEFAULTS
			);
			assert.strictEqual(oneOut.provider.supports_tools, false);
		});

		test("capability flags AND across deployments and stay unknown when any deployment leaves them unknown", () => {
			const merged = mergeModelDeployments(
				[
					deployment({ supports_reasoning: true, supports_prompt_caching: true, supports_pdf_input: true }),
					deployment({ supports_reasoning: true, supports_prompt_caching: false }),
				],
				DEFAULTS
			);
			assert.strictEqual(merged.provider.supports_reasoning, true);
			assert.strictEqual(merged.provider.supports_prompt_caching, false);
			assert.strictEqual(merged.provider.supports_pdf_input, null);
		});

		test("input modalities intersect across deployments", () => {
			const merged = mergeModelDeployments(
				[
					deployment({ supports_vision: true, supports_pdf_input: true }),
					deployment({ supports_vision: true }),
					deployment({ supports_vision: true, supports_pdf_input: true }),
				],
				DEFAULTS
			);
			assert.deepStrictEqual(merged.inputModalities, ["image"]);
		});

		test("supported_openai_params intersect, and go unknown when any deployment omits them", () => {
			const intersected = mergeModelDeployments(
				[
					deployment({ supported_openai_params: ["temperature", "seed", "top_p"] }),
					deployment({ supported_openai_params: ["seed", "temperature"] }),
				],
				DEFAULTS
			);
			assert.deepStrictEqual(intersected.provider.supported_openai_params, ["temperature", "seed"]);

			const unknown = mergeModelDeployments(
				[deployment({ supported_openai_params: ["temperature"] }), deployment({})],
				DEFAULTS
			);
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
			const merged = mergeModelDeployments(
				[
					deployment({
						input_cost_per_token: 0.000003,
						output_cost_per_token: 0.000015,
						cache_read_input_token_cost: 0.0000003,
					}),
					deployment({
						input_cost_per_token: 0.000003,
						output_cost_per_token: 0.00001,
					}),
				],
				DEFAULTS
			);
			assert.strictEqual(merged.provider.input_cost_per_token, 0.000003, "every deployment agrees, so the cost holds");
			assert.strictEqual(merged.provider.output_cost_per_token, null, "disagreeing costs must not survive the merge");
			assert.strictEqual(
				merged.provider.cache_read_input_token_cost,
				null,
				"a cost only some deployments report must not survive the merge"
			);
		});

		test("agreement on zero and joint absence both survive the merge honestly", () => {
			const merged = mergeModelDeployments(
				[
					deployment({ input_cost_per_token: 0, output_cost_per_token: 0.000015 }),
					deployment({ input_cost_per_token: 0, output_cost_per_token: 0.000015 }),
				],
				DEFAULTS
			);
			assert.strictEqual(merged.provider.input_cost_per_token, 0, "an agreed zero cost is data, not absence");
			assert.strictEqual(merged.provider.output_cost_per_token, 0.000015, "other agreed fields stay unaffected");
			assert.strictEqual(
				merged.provider.cache_read_input_token_cost,
				null,
				"a cost no deployment reports stays unknown"
			);
		});
	});
});
