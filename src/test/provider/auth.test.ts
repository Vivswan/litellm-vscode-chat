import * as assert from "assert";
import {
	resolveAuthHeaders,
	clearTokenCache,
	authFailureMessage,
	DEFAULT_VIRTUAL_KEY_HEADER,
} from "../../provider/auth";

suite("provider/auth", () => {
	teardown(() => {
		clearTokenCache();
	});

	test("API-key server sends Bearer + X-API-Key headers", async () => {
		const headers = await resolveAuthHeaders({ id: "s1", apiKey: "secret-key" });
		assert.equal(headers.Authorization, "Bearer secret-key");
		assert.equal(headers["X-API-Key"], "secret-key");
	});

	test("key-less server sends no auth headers", async () => {
		const headers = await resolveAuthHeaders({ id: "s1", apiKey: "" });
		assert.deepEqual(headers, {});
	});

	test("OAuth server fetches a token and adds the virtual-key header", async () => {
		const originalFetch = global.fetch;
		let capturedBody = "";
		let capturedUrl = "";
		try {
			global.fetch = async (url: string | URL | Request, init?: RequestInit) => {
				capturedUrl = url.toString();
				capturedBody = init?.body as string;
				return {
					ok: true,
					json: async () => ({ access_token: "tok-123", expires_in: 3600 }),
				} as unknown as Response;
			};

			const headers = await resolveAuthHeaders({
				id: "oauth-1",
				apiKey: "",
				auth: { type: "oauth" },
				oauth: {
					idpUrl: "https://idp.example.com/token",
					clientId: "cid",
					clientSecret: "csecret",
					virtualKey: "vkey",
				},
			});

			assert.equal(headers.Authorization, "Bearer tok-123");
			assert.equal(headers[DEFAULT_VIRTUAL_KEY_HEADER], "vkey");
			assert.equal(capturedUrl, "https://idp.example.com/token");
			assert.ok(capturedBody.includes("grant_type=client_credentials"));
			assert.ok(capturedBody.includes("client_id=cid"));
			assert.ok(capturedBody.includes("client_secret=csecret"));
		} finally {
			global.fetch = originalFetch;
		}
	});

	test("OAuth token is cached across calls", async () => {
		const originalFetch = global.fetch;
		let calls = 0;
		try {
			global.fetch = async () => {
				calls++;
				return {
					ok: true,
					json: async () => ({ access_token: "tok-cache", expires_in: 3600 }),
				} as unknown as Response;
			};

			const server = {
				id: "oauth-cache",
				apiKey: "",
				auth: { type: "oauth" as const },
				oauth: { idpUrl: "https://idp.example.com/token", clientId: "c", clientSecret: "s", virtualKey: "v" },
			};
			await resolveAuthHeaders(server);
			await resolveAuthHeaders(server);
			assert.equal(calls, 1, "token should be fetched only once and then cached");
		} finally {
			global.fetch = originalFetch;
		}
	});

	test("short-lived tokens (expires_in <= 60) are still cached, not re-fetched every call", async () => {
		const originalFetch = global.fetch;
		let calls = 0;
		try {
			global.fetch = async () => {
				calls++;
				return {
					ok: true,
					json: async () => ({ access_token: "tok-short", expires_in: 30 }),
				} as unknown as Response;
			};

			const server = {
				id: "oauth-short",
				apiKey: "",
				auth: { type: "oauth" as const },
				oauth: { idpUrl: "https://idp.example.com/token", clientId: "c", clientSecret: "s", virtualKey: "v" },
			};
			await resolveAuthHeaders(server);
			await resolveAuthHeaders(server);
			assert.equal(calls, 1, "a 30s token should remain cached for a usable window");
		} finally {
			global.fetch = originalFetch;
		}
	});

	test("custom virtual-key header name is honored", async () => {
		const originalFetch = global.fetch;
		try {
			global.fetch = async () =>
				({ ok: true, json: async () => ({ access_token: "t", expires_in: 3600 }) }) as unknown as Response;

			const headers = await resolveAuthHeaders({
				id: "oauth-hdr",
				apiKey: "",
				auth: { type: "oauth" },
				oauth: {
					idpUrl: "https://idp.example.com/token",
					clientId: "c",
					clientSecret: "s",
					virtualKey: "v",
					virtualKeyHeader: "X-Custom-Client",
				},
			});

			assert.equal(headers["X-Custom-Client"], "v");
			assert.equal(headers[DEFAULT_VIRTUAL_KEY_HEADER], undefined);
		} finally {
			global.fetch = originalFetch;
		}
	});

	test("OAuth without a virtual key only sends the bearer token", async () => {
		const originalFetch = global.fetch;
		try {
			global.fetch = async () =>
				({ ok: true, json: async () => ({ access_token: "t-only", expires_in: 3600 }) }) as unknown as Response;

			const headers = await resolveAuthHeaders({
				id: "oauth-novk",
				apiKey: "",
				auth: { type: "oauth" },
				oauth: { idpUrl: "https://idp.example.com/token", clientId: "c", clientSecret: "s", virtualKey: "" },
			});

			assert.equal(headers.Authorization, "Bearer t-only");
			assert.equal(headers[DEFAULT_VIRTUAL_KEY_HEADER], undefined);
		} finally {
			global.fetch = originalFetch;
		}
	});

	test("authFailureMessage tailors the 401 message to the auth method", () => {
		const oauthMsg = authFailureMessage("oauth");
		assert.ok(/OAuth access token/i.test(oauthMsg), "OAuth message should mention the access token");
		assert.ok(/token URL|client ID|virtual key/i.test(oauthMsg), "OAuth message should point at OAuth fields");
		assert.ok(
			!/configure your API key/i.test(oauthMsg),
			"OAuth message should not tell the user to configure an API key"
		);

		const apiKeyMsg = authFailureMessage("apikey");
		assert.ok(/API key/i.test(apiKeyMsg), "API-key message should mention an API key");
		assert.ok(!/OAuth/i.test(apiKeyMsg), "API-key message should not mention OAuth");
	});

	test("a failed token request throws", async () => {
		const originalFetch = global.fetch;
		try {
			global.fetch = async () =>
				({ ok: false, status: 401, statusText: "Unauthorized", text: async () => "bad creds" }) as unknown as Response;

			await assert.rejects(
				resolveAuthHeaders({
					id: "oauth-fail",
					apiKey: "",
					auth: { type: "oauth" },
					oauth: { idpUrl: "https://idp.example.com/token", clientId: "c", clientSecret: "s", virtualKey: "v" },
				}),
				/OAuth token request failed: 401/
			);
		} finally {
			global.fetch = originalFetch;
		}
	});
});
