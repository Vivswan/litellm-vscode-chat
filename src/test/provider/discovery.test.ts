import * as assert from "node:assert";
import { HttpResponse, http } from "msw";
import { createServerClient } from "../../provider/clients";
import { fetchModels, isLiteLLMModelInfoItem, isLiteLLMModelItem } from "../../provider/discovery";
import { emptyErrorResponse, MODEL_INFO_URL, MODELS_URL, mswServer, useMsw } from "../mocks/handlers";
import { expectDefined, withFetch } from "../testUtils";

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
});
