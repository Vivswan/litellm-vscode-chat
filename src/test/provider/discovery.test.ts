import * as assert from "node:assert";
import { createServerClient } from "../../provider/clients";
import { fetchModels, isLiteLLMModelInfoItem, isLiteLLMModelItem } from "../../provider/discovery";

function request(log: (message: string, data?: unknown) => void = () => {}) {
	const client = createServerClient({
		serverId: "srv1",
		baseUrl: "http://test",
		apiKey: "test-key",
		userAgent: "test-agent",
		customHeaders: {},
	});
	return {
		client,
		baseUrl: "http://test",
		discoveryTimeout: 5000,
		log,
	};
}

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

suite("provider/discovery", () => {
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
			const originalFetch = global.fetch;
			let modelsEndpointCalled = false;
			try {
				global.fetch = (async (url: string | URL | Request) => {
					if (url.toString().includes("/v1/model/info")) {
						return jsonResponse({
							data: [
								{ model_name: "good-model", model_info: { supports_function_calling: true } },
								{ model_name: 42, bogus: true },
								{ id: "listing-shaped-model", providers: [] },
							],
						});
					}
					modelsEndpointCalled = true;
					return jsonResponse({ object: "list", data: [] });
				}) as unknown as typeof fetch;

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
			} finally {
				global.fetch = originalFetch;
			}
		});

		test("nonempty model/info payload with zero valid items falls back to /v1/models", async () => {
			const originalFetch = global.fetch;
			try {
				global.fetch = (async (url: string | URL | Request) => {
					if (url.toString().includes("/v1/model/info")) {
						return jsonResponse({ data: [{ nothing: "usable" }, 17] });
					}
					return jsonResponse({ object: "list", data: [{ id: "fallback-model" }] });
				}) as unknown as typeof fetch;

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
			} finally {
				global.fetch = originalFetch;
			}
		});

		test("model/info payload without a data array falls back to /v1/models", async () => {
			const originalFetch = global.fetch;
			try {
				global.fetch = (async (url: string | URL | Request) => {
					if (url.toString().includes("/v1/model/info")) {
						return jsonResponse({ data: { not: "an array" } });
					}
					return jsonResponse({ object: "list", data: [{ id: "fallback-model" }] });
				}) as unknown as typeof fetch;

				const { models } = await fetchModels(request());
				assert.deepStrictEqual(
					models.map((m) => m.id),
					["fallback-model"]
				);
			} finally {
				global.fetch = originalFetch;
			}
		});

		test("/v1/models items without providers are normalized to an empty providers array", async () => {
			const originalFetch = global.fetch;
			try {
				global.fetch = (async (url: string | URL | Request) => {
					if (url.toString().includes("/v1/model/info")) {
						return jsonResponse({ error: "nope" }, 500);
					}
					return jsonResponse({ object: "list", data: [{ id: "bare-model" }, { id: 42 }] });
				}) as unknown as typeof fetch;

				const logs: string[] = [];
				const { models } = await fetchModels(request((m) => logs.push(m)));

				assert.strictEqual(models.length, 1);
				assert.strictEqual(models[0].id, "bare-model");
				assert.deepStrictEqual(models[0].providers, []);
				assert.ok(
					logs.some((m) => m.includes("Skipping malformed models entry")),
					"Malformed /v1/models entries should be skipped with a log line"
				);
			} finally {
				global.fetch = originalFetch;
			}
		});

		test("malformed nested provider entries are dropped without crashing registration", async () => {
			const originalFetch = global.fetch;
			const logs: string[] = [];
			try {
				global.fetch = (async () =>
					jsonResponse({
						data: [
							{
								id: "mixed-model",
								providers: [null, "bogus", { supports_tools: true }, { provider: "openai", supports_tools: true }],
							},
						],
					})) as unknown as typeof fetch;
				const { models } = await fetchModels(request((msg) => logs.push(msg)));
				assert.strictEqual(models.length, 1);
				assert.strictEqual(models[0].providers.length, 1, "Only the well-formed provider survives");
				assert.strictEqual(models[0].providers[0].provider, "openai");
				assert.ok(
					logs.some((l) => l.includes("Skipping malformed provider entry")),
					"Dropped provider entries must be logged"
				);
			} finally {
				global.fetch = originalFetch;
			}
		});

		test("conflicting model identifiers resolve by documented priority with valid strings only", async () => {
			const originalFetch = global.fetch;
			try {
				global.fetch = (async () =>
					jsonResponse({
						data: [
							{ model_name: 42, litellm_params: { model: "good-fallback" } },
							{ id: "listing-id", model_name: "preferred-name" },
						],
					})) as unknown as typeof fetch;
				const { models } = await fetchModels(request());
				assert.deepStrictEqual(
					models.map((m) => m.id),
					["good-fallback", "preferred-name"],
					"Non-string candidates are skipped and model_name wins over a listing id"
				);
			} finally {
				global.fetch = originalFetch;
			}
		});

		test("401 from /v1/models surfaces as an authentication error, not a network error", async () => {
			const originalFetch = global.fetch;
			try {
				global.fetch = (async (url: string | URL | Request) => {
					if (url.toString().includes("/v1/model/info")) {
						return jsonResponse({ error: "nope" }, 500);
					}
					return jsonResponse({ error: "unauthorized" }, 401);
				}) as unknown as typeof fetch;

				await assert.rejects(fetchModels(request()), (err: Error) => {
					assert.match(err.message, /^Authentication failed/);
					assert.ok(!err.message.includes("Network Error"), `401 must not be re-wrapped: ${err.message}`);
					return true;
				});
			} finally {
				global.fetch = originalFetch;
			}
		});

		test("connection refusal is classified as a connection error", async () => {
			const originalFetch = global.fetch;
			try {
				global.fetch = (async () => {
					throw Object.assign(new TypeError("fetch failed"), {
						cause: new Error("connect ECONNREFUSED 127.0.0.1:4000"),
					});
				}) as unknown as typeof fetch;

				await assert.rejects(fetchModels(request()), /Connection Error: Unable to connect to http:\/\/test/);
			} finally {
				global.fetch = originalFetch;
			}
		});

		test("transient 5xx discovery failures are retried and then succeed", async function () {
			this.timeout(15000);
			const originalFetch = global.fetch;
			const attempts = { info: 0, models: 0 };
			try {
				global.fetch = (async (url: string | URL | Request) => {
					if (url.toString().includes("/v1/model/info")) {
						attempts.info += 1;
						if (attempts.info < 3) {
							return new Response('{"error":{"message":"transient"}}', {
								status: 500,
								headers: { "Content-Type": "application/json" },
							});
						}
						return new Response(
							JSON.stringify({
								data: [{ model_name: "retried-model", model_info: { supports_function_calling: true } }],
							}),
							{ status: 200, headers: { "Content-Type": "application/json" } }
						);
					}
					attempts.models += 1;
					return new Response(JSON.stringify({ object: "list", data: [] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}) as unknown as typeof fetch;

				const { models } = await fetchModels(request());
				assert.deepStrictEqual(
					models.map((m) => m.id),
					["retried-model"],
					"The third attempt succeeds without falling back"
				);
				assert.strictEqual(attempts.info, 3, "Two retries after the initial attempt");
				assert.strictEqual(attempts.models, 0, "No fallback once a retry succeeds");
			} finally {
				global.fetch = originalFetch;
			}
		});

		test("a large Retry-After cannot stall discovery past the timeout", async function () {
			this.timeout(15000);
			const originalFetch = global.fetch;
			try {
				global.fetch = (async (url: string | URL | Request) => {
					if (url.toString().includes("/v1/model/info")) {
						// 404 is not retryable, so discovery falls straight through to /v1/models.
						return new Response("not found", { status: 404, headers: { "Content-Type": "text/plain" } });
					}
					return new Response('{"error":{"message":"backoff"}}', {
						status: 500,
						headers: { "Content-Type": "application/json", "Retry-After": "60" },
					});
				}) as unknown as typeof fetch;

				const started = Date.now();
				await assert.rejects(fetchModels({ ...request(), discoveryTimeout: 1000 }), /discoveryTimeout/);
				const elapsed = Date.now() - started;
				assert.ok(elapsed < 6000, `Timeout must bound the whole call including backoff sleeps, took ${elapsed}ms`);
			} finally {
				global.fetch = originalFetch;
			}
		});

		test("JSON served without a JSON content type is still parsed", async () => {
			const originalFetch = global.fetch;
			try {
				global.fetch = (async (url: string | URL | Request) => {
					const payload = url.toString().includes("/v1/model/info")
						? { data: [{ model_name: "plain-model", model_info: { supports_function_calling: true } }] }
						: { object: "list", data: [] };
					return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "text/plain" } });
				}) as unknown as typeof fetch;

				const { models } = await fetchModels(request());
				assert.deepStrictEqual(
					models.map((m) => m.id),
					["plain-model"],
					"A JSON body with a non-JSON content type must not silently fall back"
				);
			} finally {
				global.fetch = originalFetch;
			}
		});
	});
});
