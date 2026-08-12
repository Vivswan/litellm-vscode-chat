import * as assert from "node:assert";
import { HttpResponse, http } from "msw";
import type OpenAI from "openai";
import { createServerClient, ServerClientCache, type ServerClientConfig } from "../../../provider/transport/clients";
import { MODELS_URL, mswServer, TEST_BASE_URL, useMsw } from "../../mocks/handlers";
import { toHeaderMap } from "../../pureHelpers";

function config(overrides: Partial<ServerClientConfig> = {}): ServerClientConfig {
	return {
		serverId: "srv1",
		baseUrl: TEST_BASE_URL,
		apiKey: "sk-k",
		userAgent: "test-agent",
		customHeaders: {},
		...overrides,
	};
}

/**
 * Issue a GET through the client against an msw handler and capture the
 * outgoing request. The client reads globalThis.fetch per call, so msw's
 * interception applies even to clients constructed before the server started.
 */
async function captureGet(
	client: OpenAI,
	absoluteUrl: string = MODELS_URL
): Promise<{ url: string; headers: Record<string, string> }> {
	let url = "";
	let headers: Record<string, string> = {};
	mswServer.use(
		http.get(absoluteUrl, ({ request }) => {
			url = request.url;
			headers = toHeaderMap(request.headers);
			return HttpResponse.json({ data: [] });
		})
	);
	await client.get("/models", { timeout: 5000 });
	return { url, headers };
}

suite("provider/transport/clients", () => {
	useMsw();

	suite("createServerClient", () => {
		test("keyed client sends both auth headers, the User-Agent, and custom headers", async () => {
			const client = createServerClient(config({ customHeaders: { "X-Custom": "custom-value" } }));
			const { headers } = await captureGet(client);
			assert.strictEqual(headers.authorization, "Bearer sk-k");
			assert.strictEqual(headers["x-api-key"], "sk-k");
			assert.strictEqual(headers["user-agent"], "test-agent");
			assert.strictEqual(headers["x-custom"], "custom-value");
		});

		test("keyless client sends no auth headers at all", async () => {
			const client = createServerClient(config({ apiKey: "" }));
			const { headers } = await captureGet(client);
			assert.ok(!("authorization" in headers), `Unexpected Authorization header: ${headers.authorization}`);
			assert.ok(!("x-api-key" in headers), `Unexpected X-API-Key header: ${headers["x-api-key"]}`);
		});

		test("keyless client sends a user-configured Authorization header", async () => {
			const client = createServerClient(config({ apiKey: "", customHeaders: { Authorization: "Basic dXNlcg==" } }));
			const { headers } = await captureGet(client);
			assert.strictEqual(headers.authorization, "Basic dXNlcg==");
			assert.ok(!("x-api-key" in headers), `Unexpected X-API-Key header: ${headers["x-api-key"]}`);
		});

		test("the API key wins over conflicting custom auth headers", async () => {
			const client = createServerClient(
				config({ customHeaders: { Authorization: "Basic other", "x-api-key": "other-key" } })
			);
			const { headers } = await captureGet(client);
			assert.strictEqual(headers.authorization, "Bearer sk-k");
			assert.strictEqual(headers["x-api-key"], "sk-k");
		});

		test("requests go to the server's /v1 prefix", async () => {
			const client = createServerClient(config());
			const { url } = await captureGet(client);
			assert.strictEqual(url, `${TEST_BASE_URL}/v1/models`);
		});

		test("a version segment already in the base URL is kept, not doubled", async () => {
			const client = createServerClient(config({ baseUrl: `${TEST_BASE_URL}/v1` }));
			const { url } = await captureGet(client);
			assert.strictEqual(url, `${TEST_BASE_URL}/v1/models`);
		});

		test("a /v2 base URL is honored as the API root", async () => {
			const client = createServerClient(config({ baseUrl: `${TEST_BASE_URL}/v2` }));
			const { url } = await captureGet(client, `${TEST_BASE_URL}/v2/models`);
			assert.strictEqual(url, `${TEST_BASE_URL}/v2/models`);
		});

		test('apiVersion "" makes the base URL the API root as-is', async () => {
			const client = createServerClient(config({ apiVersion: "" }));
			const { url } = await captureGet(client, `${TEST_BASE_URL}/models`);
			assert.strictEqual(url, `${TEST_BASE_URL}/models`);
		});

		test("an explicit apiVersion beats a version segment in the URL", async () => {
			const client = createServerClient(config({ baseUrl: `${TEST_BASE_URL}/v1`, apiVersion: "v3" }));
			const { url } = await captureGet(client, `${TEST_BASE_URL}/v1/v3/models`);
			assert.strictEqual(url, `${TEST_BASE_URL}/v1/v3/models`);
		});
	});

	suite("ServerClientCache", () => {
		test("the same config returns the same client instance", () => {
			const cache = new ServerClientCache();
			const first = cache.get(config());
			assert.strictEqual(cache.get(config()), first);
		});

		test("a changed API key produces a new client", () => {
			const cache = new ServerClientCache();
			const first = cache.get(config());
			assert.notStrictEqual(cache.get(config({ apiKey: "sk-rotated" })), first);
		});

		test("changed custom headers produce a new client", () => {
			const cache = new ServerClientCache();
			const first = cache.get(config());
			assert.notStrictEqual(cache.get(config({ customHeaders: { "X-Custom": "added" } })), first);
		});

		test('a changed apiVersion produces a new client, and "" is distinct from unset', () => {
			const cache = new ServerClientCache();
			const first = cache.get(config());
			const empty = cache.get(config({ apiVersion: "" }));
			assert.notStrictEqual(empty, first);
			assert.notStrictEqual(cache.get(config({ apiVersion: "v2" })), empty);
		});

		test("different server IDs get independent cache entries", () => {
			const cache = new ServerClientCache();
			const first = cache.get(config({ serverId: "srv1" }));
			const second = cache.get(config({ serverId: "srv2", baseUrl: "http://other" }));
			assert.notStrictEqual(first, second);
			assert.strictEqual(cache.get(config({ serverId: "srv1" })), first);
			assert.strictEqual(cache.get(config({ serverId: "srv2", baseUrl: "http://other" })), second);
		});

		test("prune drops entries for removed servers only", () => {
			const cache = new ServerClientCache();
			const kept = cache.get(config({ serverId: "srv1" }));
			const removed = cache.get(config({ serverId: "srv2", baseUrl: "http://other" }));
			cache.prune(["srv1"]);
			assert.strictEqual(cache.get(config({ serverId: "srv1" })), kept, "Kept server keeps its client");
			assert.notStrictEqual(
				cache.get(config({ serverId: "srv2", baseUrl: "http://other" })),
				removed,
				"Removed server's client must be rebuilt after prune"
			);
		});

		test("SDK logging is off regardless of ambient OPENAI_LOG", () => {
			const original = process.env.OPENAI_LOG;
			process.env.OPENAI_LOG = "debug";
			try {
				const client = createServerClient(config());
				assert.strictEqual((client as unknown as { logLevel?: string }).logLevel, "off");
			} finally {
				if (original === undefined) {
					delete process.env.OPENAI_LOG;
				} else {
					process.env.OPENAI_LOG = original;
				}
			}
		});
	});
});
