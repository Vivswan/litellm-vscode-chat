import * as assert from "assert";
import { getAuthHeaders, buildAuthFromServer, clearTokenCache } from "../../provider/auth";
import { DEFAULT_VIRTUAL_KEY_HEADER } from "../../extension/serverRegistry";
import type { ServerWithKey } from "../../extension/serverRegistry";

type FetchLike = typeof globalThis.fetch;

interface RecordedRequest {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
}

function jsonResponse(body: unknown, init?: { status?: number; statusText?: string }): Response {
	return new Response(JSON.stringify(body), {
		status: init?.status ?? 200,
		statusText: init?.statusText ?? "OK",
		headers: { "Content-Type": "application/json" },
	});
}

function makeFetch(handler: (req: RecordedRequest) => Response, log: RecordedRequest[]): FetchLike {
	return (async (input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => {
		const req: RecordedRequest = {
			url: typeof input === "string" ? input : input.toString(),
			method: init?.method,
			headers: init?.headers as Record<string, string> | undefined,
			body: typeof init?.body === "string" ? init.body : undefined,
		};
		log.push(req);
		return handler(req);
	}) as FetchLike;
}

function oauthServer(overrides: Partial<ServerWithKey> = {}): ServerWithKey {
	return {
		id: "srv1",
		label: "OAuth Server",
		baseUrl: "https://llm.example.com",
		authMethod: "oauth2",
		oauthTokenUrl: "https://idp.example.com/token",
		oauthClientId: "client-123",
		oauthClientSecret: "secret-456",
		apiKey: "",
		...overrides,
	};
}

suite("provider/auth", () => {
	teardown(() => {
		clearTokenCache();
	});

	test("apiKey auth produces Bearer + X-API-Key headers", async () => {
		const auth = buildAuthFromServer({
			id: "a",
			label: "A",
			baseUrl: "https://x",
			authMethod: "apiKey",
			apiKey: "my-key",
		});
		const headers = await getAuthHeaders(auth);
		assert.strictEqual(headers.Authorization, "Bearer my-key");
		assert.strictEqual(headers["X-API-Key"], "my-key");
	});

	test("apiKey auth with empty key produces no auth headers", async () => {
		const auth = buildAuthFromServer({ id: "a", label: "A", baseUrl: "https://x", apiKey: "" });
		const headers = await getAuthHeaders(auth);
		assert.deepStrictEqual(headers, {});
	});

	test("missing authMethod is treated as apiKey", async () => {
		const auth = buildAuthFromServer({ id: "a", label: "A", baseUrl: "https://x", apiKey: "legacy" });
		assert.strictEqual(auth.method, "apiKey");
		const headers = await getAuthHeaders(auth);
		assert.strictEqual(headers.Authorization, "Bearer legacy");
	});

	test("oauth2 exchanges client credentials and uses the returned token", async () => {
		clearTokenCache();
		const log: RecordedRequest[] = [];
		const fetchImpl = makeFetch(() => jsonResponse({ access_token: "tok-abc", expires_in: 3600 }), log);

		const headers = await getAuthHeaders(buildAuthFromServer(oauthServer()), fetchImpl);

		assert.strictEqual(log.length, 1, "should make exactly one token request");
		const req = log[0];
		assert.strictEqual(req.url, "https://idp.example.com/token");
		assert.strictEqual(req.method, "POST");
		assert.strictEqual(
			(req.headers as Record<string, string>)["Content-Type"],
			"application/x-www-form-urlencoded"
		);
		const params = new URLSearchParams(req.body ?? "");
		assert.strictEqual(params.get("grant_type"), "client_credentials");
		assert.strictEqual(params.get("client_id"), "client-123");
		assert.strictEqual(params.get("client_secret"), "secret-456");

		assert.strictEqual(headers.Authorization, "Bearer tok-abc");
		assert.strictEqual(headers["X-API-Key"], "tok-abc");
	});

	test("oauth2 omits virtual key header when no virtual key configured", async () => {
		clearTokenCache();
		const log: RecordedRequest[] = [];
		const fetchImpl = makeFetch(() => jsonResponse({ access_token: "tok", expires_in: 3600 }), log);
		const headers = await getAuthHeaders(buildAuthFromServer(oauthServer()), fetchImpl);
		assert.ok(!(DEFAULT_VIRTUAL_KEY_HEADER in headers), "default virtual key header should be absent");
	});

	test("oauth2 sends virtual key in default header", async () => {
		clearTokenCache();
		const log: RecordedRequest[] = [];
		const fetchImpl = makeFetch(() => jsonResponse({ access_token: "tok", expires_in: 3600 }), log);
		const headers = await getAuthHeaders(
			buildAuthFromServer(oauthServer({ oauthVirtualKey: "vkey-9" })),
			fetchImpl
		);
		assert.strictEqual(headers[DEFAULT_VIRTUAL_KEY_HEADER], "vkey-9");
	});

	test("oauth2 sends virtual key in custom header override", async () => {
		clearTokenCache();
		const log: RecordedRequest[] = [];
		const fetchImpl = makeFetch(() => jsonResponse({ access_token: "tok", expires_in: 3600 }), log);
		const headers = await getAuthHeaders(
			buildAuthFromServer(oauthServer({ oauthVirtualKey: "vkey-9", oauthVirtualKeyHeader: "X-Custom-Key" })),
			fetchImpl
		);
		assert.strictEqual(headers["X-Custom-Key"], "vkey-9");
		assert.ok(!(DEFAULT_VIRTUAL_KEY_HEADER in headers), "default header should not be used when overridden");
	});

	test("oauth2 reuses cached token before expiry", async () => {
		clearTokenCache();
		const log: RecordedRequest[] = [];
		const fetchImpl = makeFetch(() => jsonResponse({ access_token: "tok-cached", expires_in: 3600 }), log);
		const auth = buildAuthFromServer(oauthServer());

		const first = await getAuthHeaders(auth, fetchImpl);
		const second = await getAuthHeaders(auth, fetchImpl);

		assert.strictEqual(log.length, 1, "second call should hit the cache, not the IdP");
		assert.strictEqual(first.Authorization, "Bearer tok-cached");
		assert.strictEqual(second.Authorization, "Bearer tok-cached");
	});

	test("oauth2 refreshes token after expiry margin", async () => {
		clearTokenCache();
		const log: RecordedRequest[] = [];
		let counter = 0;
		// expires_in below the 60s safety margin => immediately considered expired.
		const fetchImpl = makeFetch(() => jsonResponse({ access_token: `tok-${++counter}`, expires_in: 1 }), log);
		const auth = buildAuthFromServer(oauthServer());

		const first = await getAuthHeaders(auth, fetchImpl);
		const second = await getAuthHeaders(auth, fetchImpl);

		assert.strictEqual(log.length, 2, "token should be re-fetched after expiry");
		assert.strictEqual(first.Authorization, "Bearer tok-1");
		assert.strictEqual(second.Authorization, "Bearer tok-2");
	});

	test("oauth2 token request invalidates cache when credentials change", async () => {
		clearTokenCache();
		const log: RecordedRequest[] = [];
		let counter = 0;
		const fetchImpl = makeFetch(() => jsonResponse({ access_token: `tok-${++counter}`, expires_in: 3600 }), log);

		await getAuthHeaders(buildAuthFromServer(oauthServer({ oauthClientSecret: "secret-A" })), fetchImpl);
		await getAuthHeaders(buildAuthFromServer(oauthServer({ oauthClientSecret: "secret-B" })), fetchImpl);

		assert.strictEqual(log.length, 2, "different client secret should produce a separate cache entry");
	});

	test("oauth2 throws actionable error on IdP failure", async () => {
		clearTokenCache();
		const log: RecordedRequest[] = [];
		const fetchImpl = makeFetch(
			() => new Response("invalid_client", { status: 401, statusText: "Unauthorized" }),
			log
		);
		await assert.rejects(
			() => getAuthHeaders(buildAuthFromServer(oauthServer()), fetchImpl),
			/OAuth2 token request failed: 401 Unauthorized/
		);
	});

	test("oauth2 throws when access_token missing from response", async () => {
		clearTokenCache();
		const log: RecordedRequest[] = [];
		const fetchImpl = makeFetch(() => jsonResponse({ token_type: "Bearer" }), log);
		await assert.rejects(
			() => getAuthHeaders(buildAuthFromServer(oauthServer()), fetchImpl),
			/did not include an access_token/
		);
	});

	test("oauth2 throws when configuration is incomplete", async () => {
		clearTokenCache();
		const log: RecordedRequest[] = [];
		const fetchImpl = makeFetch(() => jsonResponse({ access_token: "tok" }), log);
		await assert.rejects(
			() => getAuthHeaders(buildAuthFromServer(oauthServer({ oauthClientSecret: "" })), fetchImpl),
			/not fully configured/
		);
		assert.strictEqual(log.length, 0, "should not contact the IdP when config is incomplete");
	});

	test("oauth2 falls back to a token TTL when expires_in is absent", async () => {
		clearTokenCache();
		const log: RecordedRequest[] = [];
		const fetchImpl = makeFetch(() => jsonResponse({ access_token: "tok-noexp" }), log);
		const auth = buildAuthFromServer(oauthServer());

		await getAuthHeaders(auth, fetchImpl);
		await getAuthHeaders(auth, fetchImpl);

		// With the fallback TTL (5 min) the token should still be cached on the second call.
		assert.strictEqual(log.length, 1, "fallback TTL should keep the token cached");
	});
});
