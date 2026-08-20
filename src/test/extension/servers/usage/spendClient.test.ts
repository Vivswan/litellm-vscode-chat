import * as assert from "node:assert";
import { HttpResponse, http } from "msw";
import type { DeclaredServer } from "../../../../extension/servers/serverSync";
import {
	activityWindow,
	dailyActivityUrl,
	keyInfoUrl,
	UsageClient,
	type UsageClientOptions,
	type UsageConnection,
	type UsageDay,
	usageConnectionFor,
	usageUnavailabilityOf,
	userInfoUrl,
} from "../../../../extension/servers/usage";
import { RequestError } from "../../../../provider/transport/errorMapping";
import { mswServer, TEST_BASE_URL, useMsw } from "../../../mocks/handlers";

/** The usage endpoints sit at the server ROOT, not under /v1 like discovery. */
const KEY_INFO_URL = `${TEST_BASE_URL}/key/info`;
const USER_INFO_URL = `${TEST_BASE_URL}/user/info`;
const DAILY_ACTIVITY_URL = `${TEST_BASE_URL}/user/daily/activity`;
const TOKEN_URL = "http://idp.test/oauth2/token";

const WINDOW = { startDate: "2026-07-01", endDate: "2026-07-30" };

function client(overrides: Partial<UsageClientOptions> = {}): UsageClient {
	return new UsageClient({ userAgent: "test-agent", getTimeoutMs: () => 5000, ...overrides });
}

function connection(overrides: Partial<UsageConnection> = {}): UsageConnection {
	return { label: "alpha", baseUrl: TEST_BASE_URL, apiKey: "sk-test", headers: {}, ...overrides };
}

async function expectRequestError(promise: Promise<unknown>, kind: RequestError["kind"]): Promise<RequestError> {
	try {
		await promise;
	} catch (error) {
		assert.ok(error instanceof RequestError, `expected a RequestError, got ${String(error)}`);
		assert.strictEqual(error.kind, kind);
		// Every construction site localizes its display message and must carry
		// the full English mirror; under the test host's English fallback the
		// two coincide.
		assert.strictEqual(error.englishMessage, error.message, "the English mirror must match the English display");
		return error;
	}
	assert.fail("expected the promise to reject");
}

suite("extension/servers/usage spendClient", () => {
	useMsw();

	suite("URL helpers", () => {
		test("state the root-level endpoints the requests really call", () => {
			assert.strictEqual(keyInfoUrl(TEST_BASE_URL, undefined), KEY_INFO_URL);
			assert.strictEqual(userInfoUrl(TEST_BASE_URL, undefined), USER_INFO_URL);
			assert.strictEqual(dailyActivityUrl(TEST_BASE_URL, undefined), DAILY_ACTIVITY_URL);
		});

		test("a version segment in the base URL is stripped back to the server root", () => {
			assert.strictEqual(keyInfoUrl(`${TEST_BASE_URL}/v1`, undefined), KEY_INFO_URL);
			assert.strictEqual(userInfoUrl(`${TEST_BASE_URL}/v2`, undefined), USER_INFO_URL);
			assert.strictEqual(dailyActivityUrl(`${TEST_BASE_URL}/v1/`, undefined), DAILY_ACTIVITY_URL);
		});

		test("an explicit apiVersion means the base URL already is the server root", () => {
			assert.strictEqual(keyInfoUrl(`${TEST_BASE_URL}/v1`, "v2"), `${TEST_BASE_URL}/v1/key/info`);
			assert.strictEqual(keyInfoUrl(TEST_BASE_URL, ""), KEY_INFO_URL);
		});
	});

	suite("fetchKeyInfo", () => {
		test("parses budget fields and sends both API-key auth headers", async () => {
			let seenAuthorization: string | null = null;
			let seenApiKey: string | null = null;
			mswServer.use(
				http.get(KEY_INFO_URL, ({ request }) => {
					seenAuthorization = request.headers.get("authorization");
					seenApiKey = request.headers.get("x-api-key");
					return HttpResponse.json({
						key: "hashed-key-material",
						info: {
							spend: 42.5,
							max_budget: 100,
							soft_budget: 80,
							budget_duration: "30d",
							budget_reset_at: "2026-09-01T00:00:00.000Z",
							user_id: "user-1",
						},
					});
				})
			);

			const key = await client().fetchKeyInfo(connection());

			assert.strictEqual(seenAuthorization, "Bearer sk-test");
			assert.strictEqual(seenApiKey, "sk-test");
			assert.strictEqual(key.spend, 42.5);
			assert.strictEqual(key.maxBudget, 100);
			assert.strictEqual(key.softBudget, 80);
			assert.strictEqual(key.budgetResetAt, Date.parse("2026-09-01T00:00:00.000Z"));
			assert.strictEqual(key.hasUser, true);
		});

		test("keyless connections send no auth headers at all", async () => {
			let seenAuthorization: string | null = "unset";
			mswServer.use(
				http.get(KEY_INFO_URL, ({ request }) => {
					seenAuthorization = request.headers.get("authorization");
					return HttpResponse.json({ info: {} });
				})
			);

			const key = await client().fetchKeyInfo(connection({ apiKey: "" }));

			assert.strictEqual(seenAuthorization, null);
			assert.strictEqual(key.hasUser, false);
			assert.strictEqual(key.spend, undefined);
		});

		test("malformed field values degrade to absent instead of riding into the result", async () => {
			mswServer.use(
				http.get(KEY_INFO_URL, () =>
					HttpResponse.json({
						info: {
							spend: "not-a-number",
							max_budget: -5,
							budget_duration: "next tuesday or so",
							budget_reset_at: "not-a-date",
							user_id: "",
						},
					})
				)
			);

			const key = await client().fetchKeyInfo(connection());

			assert.deepStrictEqual(key, {
				spend: undefined,
				maxBudget: undefined,
				softBudget: undefined,
				budgetResetAt: undefined,
				hasUser: false,
			});
		});

		test("OAuth connections send the exchanged bearer token and the virtual key its header", async () => {
			let seenAuthorization: string | null = null;
			let seenVirtual: string | null = null;
			mswServer.use(
				http.post(TOKEN_URL, () => HttpResponse.json({ access_token: "tok-1", expires_in: 3600 })),
				http.get(KEY_INFO_URL, ({ request }) => {
					seenAuthorization = request.headers.get("authorization");
					seenVirtual = request.headers.get("x-litellm-key");
					return HttpResponse.json({ info: { spend: 1 } });
				})
			);

			await client().fetchKeyInfo(
				connection({
					apiKey: "",
					oauth: { tokenUrl: TOKEN_URL, clientId: "client-1", clientSecret: "secret" },
					virtualKey: { header: "x-litellm-key", value: "vk-1" },
				})
			);

			assert.strictEqual(seenAuthorization, "Bearer tok-1");
			assert.strictEqual(seenVirtual, "vk-1");
		});

		test("auth overlays replace same-named custom headers case-insensitively, never combine with them", async () => {
			// This is a plain-object fetch: two spellings of one header name in
			// the object would COMBINE into "custom, Bearer tok-1" on the wire.
			let seenAuthorization: string | null = null;
			let seenVirtual: string | null = null;
			mswServer.use(
				http.post(TOKEN_URL, () => HttpResponse.json({ access_token: "tok-1", expires_in: 3600 })),
				http.get(KEY_INFO_URL, ({ request }) => {
					seenAuthorization = request.headers.get("authorization");
					seenVirtual = request.headers.get("x-litellm-key");
					return HttpResponse.json({ info: { spend: 1 } });
				})
			);

			await client().fetchKeyInfo(
				connection({
					apiKey: "",
					headers: { authorization: "custom-token", "X-LiteLLM-Key": "custom-vk" },
					oauth: { tokenUrl: TOKEN_URL, clientId: "client-1", clientSecret: "secret" },
					virtualKey: { header: "x-litellm-key", value: "vk-1" },
				})
			);

			assert.strictEqual(seenAuthorization, "Bearer tok-1");
			assert.strictEqual(seenVirtual, "vk-1");
		});

		test("a credentialed base URL never echoes its userinfo in usage error messages", async () => {
			// fetch itself refuses credentialed URLs, so every attempt throws and
			// the failure surfaces as the network tail; the echoed URL must carry
			// no userinfo whichever error shape renders it.
			const error = await expectRequestError(
				client().fetchKeyInfo(connection({ baseUrl: "http://user:sekret@usage.test:4000" })),
				"network"
			);
			assert.ok(!error.message.includes("sekret"), error.message);
			assert.ok(error.message.includes("http://usage.test:4000/key/info"), error.message);
		});
	});

	suite("fetchDailyActivity", () => {
		test("sends the window, keeps well-formed days sorted, and sums totals itself", async () => {
			let seenSearch: string | undefined;
			mswServer.use(
				http.get(DAILY_ACTIVITY_URL, ({ request }) => {
					seenSearch = new URL(request.url).search;
					return HttpResponse.json({
						results: [
							{
								date: "2026-07-02",
								metrics: {
									spend: 2,
									prompt_tokens: 20,
									completion_tokens: 10,
									total_tokens: 30,
									api_requests: 4,
									successful_requests: 3,
									failed_requests: 1,
									cache_read_input_tokens: 5,
									cache_creation_input_tokens: 6,
								},
							},
							{ date: "not-a-day", metrics: { spend: 99 } },
							{ date: "2026-07-01", metrics: { spend: 1, api_requests: 1, successful_requests: 1 } },
							"junk",
						],
						metadata: { total_spend: 12345 },
					});
				})
			);

			const daily = await client().fetchDailyActivity(connection(), WINDOW);

			assert.strictEqual(seenSearch, "?start_date=2026-07-01&end_date=2026-07-30");
			const expectedSecondDay: UsageDay = {
				date: "2026-07-02",
				spend: 2,
				promptTokens: 20,
				completionTokens: 10,
				totalTokens: 30,
				apiRequests: 4,
				successfulRequests: 3,
				failedRequests: 1,
				cacheReadInputTokens: 5,
				cacheCreationInputTokens: 6,
			};
			assert.deepStrictEqual(
				daily.days.map((day) => day.date),
				["2026-07-01", "2026-07-02"]
			);
			assert.deepStrictEqual(daily.days[1], expectedSecondDay);
			// Summed from the recognized days, never trusted from the metadata.
			assert.strictEqual(daily.totals.spend, 3);
			assert.strictEqual(daily.totals.apiRequests, 5);
			assert.strictEqual(daily.totals.successfulRequests, 4);
			assert.strictEqual(daily.totals.failedRequests, 1);
			assert.strictEqual(daily.totals.cacheReadInputTokens, 5);
		});
	});

	suite("fetchUserInfo", () => {
		test("parses the rollup", async () => {
			mswServer.use(
				http.get(USER_INFO_URL, () =>
					HttpResponse.json({
						user_id: "user-1",
						user_info: { spend: 12, max_budget: 200, budget_reset_at: "2026-09-01T00:00:00.000Z" },
					})
				)
			);

			const user = await client().fetchUserInfo(connection());

			assert.strictEqual(user.spend, 12);
			assert.strictEqual(user.maxBudget, 200);
			assert.strictEqual(user.budgetResetAt, Date.parse("2026-09-01T00:00:00.000Z"));
		});
	});

	suite("failure classification", () => {
		test("a 403 is an auth error, not retried, and reads as forbidden", async () => {
			let attempts = 0;
			mswServer.use(
				http.get(KEY_INFO_URL, () => {
					attempts += 1;
					return HttpResponse.json({ error: "not allowed" }, { status: 403 });
				})
			);

			const error = await expectRequestError(client().fetchKeyInfo(connection()), "auth");

			assert.strictEqual(attempts, 1, "4xx responses must not be retried");
			assert.strictEqual(error.status, 403);
			assert.strictEqual(usageUnavailabilityOf(error), "forbidden");
		});

		test("a DB-less proxy's 404 and 400 read as unsupported", async () => {
			mswServer.use(http.get(KEY_INFO_URL, () => HttpResponse.json({ error: "no db" }, { status: 404 })));
			const notFound = await expectRequestError(client().fetchKeyInfo(connection()), "http");
			assert.strictEqual(usageUnavailabilityOf(notFound), "unsupported");

			mswServer.use(http.get(KEY_INFO_URL, () => HttpResponse.json({ error: "no db" }, { status: 400 })));
			const badRequest = await expectRequestError(client().fetchKeyInfo(connection()), "http");
			assert.strictEqual(usageUnavailabilityOf(badRequest), "unsupported");
		});

		test("5xx responses retry and read as transient", async () => {
			let attempts = 0;
			mswServer.use(
				http.get(KEY_INFO_URL, () => {
					attempts += 1;
					return attempts < 3
						? HttpResponse.json({ error: "boom" }, { status: 500 })
						: HttpResponse.json({ info: { spend: 7 } });
				})
			);

			const key = await client().fetchKeyInfo(connection());

			assert.strictEqual(attempts, 3, "idempotent GETs retry through 5xx");
			assert.strictEqual(key.spend, 7);
		});

		test("an exhausted 5xx retry budget surfaces the http error as transient", async () => {
			mswServer.use(http.get(KEY_INFO_URL, () => HttpResponse.json({ error: "boom" }, { status: 500 })));

			const error = await expectRequestError(client().fetchKeyInfo(connection()), "http");

			assert.strictEqual(error.status, 500);
			assert.strictEqual(usageUnavailabilityOf(error), undefined, "5xx must not read as permanently unavailable");
		});

		test("error messages never embed the response body", async () => {
			const marker = "hashed-key-sk-abc123";
			mswServer.use(http.get(KEY_INFO_URL, () => HttpResponse.json({ error: marker }, { status: 400 })));

			const error = await expectRequestError(client().fetchKeyInfo(connection()), "http");

			assert.ok(!error.message.includes(marker), "usage error messages must stay template-only");
		});

		test("a malformed JSON body throws without quoting the payload", async () => {
			const marker = "not json at all sk-secret";
			mswServer.use(http.get(KEY_INFO_URL, () => new HttpResponse(marker, { status: 200 })));

			const error = await expectRequestError(client().fetchKeyInfo(connection()), "http");

			assert.ok(!error.message.includes("sk-secret"), "parse failures must not quote the payload");
			assert.strictEqual(error.cause, undefined, "the SyntaxError quotes the payload, so it must not ride as cause");
		});

		test("the discovery timeout is a hard whole-call bound", async () => {
			mswServer.use(
				http.get(KEY_INFO_URL, async () => {
					await new Promise((resolve) => setTimeout(resolve, 500));
					return HttpResponse.json({ info: {} });
				})
			);

			await expectRequestError(client({ getTimeoutMs: () => 50 }).fetchKeyInfo(connection()), "timeout");
		});
	});

	suite("activityWindow", () => {
		test("reaches back the requested number of calendar days including today", () => {
			const window = activityWindow(Date.UTC(2026, 6, 30, 12), 30);
			assert.deepStrictEqual(window, WINDOW);
		});
	});

	suite("usageConnectionFor", () => {
		test("inline secrets win, OAuth needs its pair, and a partial virtual key drops", () => {
			const entry: DeclaredServer = {
				label: "alpha",
				baseUrl: TEST_BASE_URL,
				oauthTokenUrl: TOKEN_URL,
				oauthClientId: "client-1",
				virtualKeyHeader: "x-litellm-key",
			};

			const resolved = usageConnectionFor(entry, {
				apiKey: "stored-key",
				oauthClientSecret: "stored-secret",
			});

			assert.strictEqual(resolved.apiKey, "stored-key");
			assert.deepStrictEqual(resolved.oauth, {
				tokenUrl: TOKEN_URL,
				clientId: "client-1",
				clientSecret: "stored-secret",
			});
			assert.strictEqual(resolved.virtualKey, undefined, "a header without a value must not probe half-configured");

			const inlineWins = usageConnectionFor(
				{ label: "alpha", baseUrl: TEST_BASE_URL, apiKey: "inline-key" },
				{
					apiKey: "stored-key",
				}
			);
			assert.strictEqual(inlineWins.apiKey, "inline-key");
		});

		test('the entry\'s apiVersion rides the connection, with "" kept distinct from absent', () => {
			// Pins the ...(entry.apiVersion !== undefined) spread: without it the
			// usage URLs silently revert to the auto rule and the suite stays green.
			const custom = usageConnectionFor({ label: "a", baseUrl: TEST_BASE_URL, apiVersion: "v2" }, {});
			assert.strictEqual(custom.apiVersion, "v2");
			const none = usageConnectionFor({ label: "a", baseUrl: TEST_BASE_URL, apiVersion: "" }, {});
			assert.strictEqual(none.apiVersion, "");
			const auto = usageConnectionFor({ label: "a", baseUrl: TEST_BASE_URL }, {});
			assert.ok(!("apiVersion" in auto), "auto must omit the key, not carry present-as-undefined");
		});

		test("normalizes a trailing-slash base URL so endpoint paths cannot double the slash", () => {
			const resolved = usageConnectionFor({ label: "alpha", baseUrl: `${TEST_BASE_URL}//` }, {});
			assert.strictEqual(resolved.baseUrl, TEST_BASE_URL);
			// The URL a fetch would really hit: a double slash here would 404 on
			// LiteLLM and misclassify the server as usage-unsupported.
			assert.strictEqual(keyInfoUrl(resolved.baseUrl, undefined), KEY_INFO_URL);
		});

		test("drops a virtual key whose header or value cannot be sent as an HTTP header", () => {
			const badValue = usageConnectionFor(
				{ label: "alpha", baseUrl: TEST_BASE_URL, virtualKeyHeader: "x-litellm-key", virtualKeyValue: "bad\nvalue" },
				{}
			);
			assert.strictEqual(badValue.virtualKey, undefined, "an invalid value would make fetch throw it in plaintext");

			const badName = usageConnectionFor(
				{ label: "alpha", baseUrl: TEST_BASE_URL, virtualKeyHeader: "bad header", virtualKeyValue: "vk-1" },
				{}
			);
			assert.strictEqual(badName.virtualKey, undefined);
		});
	});

	suite("usageUnavailabilityOf", () => {
		test("an OAuth token-endpoint rejection stays transient instead of reading as forbidden", async () => {
			mswServer.use(
				http.post(TOKEN_URL, () => HttpResponse.json({ error: "invalid_client" }, { status: 401 })),
				http.get(KEY_INFO_URL, () => HttpResponse.json({ info: {} }))
			);
			const oauth = { tokenUrl: TOKEN_URL, clientId: "client-1", clientSecret: "secret-1" };

			const error = await expectRequestError(client().fetchKeyInfo(connection({ oauth })), "auth");

			assert.strictEqual(error.status, 401);
			assert.strictEqual(error.oauthTokenEndpoint, true, "auth.ts must mark its token-endpoint errors structurally");
			assert.strictEqual(
				error.logClassification,
				"RequestError(auth, status 401, oauth token endpoint)",
				"the marker rides beside the classification, never replaces it"
			);
			assert.strictEqual(usageUnavailabilityOf(error), undefined);
		});

		test("the verdict reads the structured marker, not the classification text", () => {
			const marked = new RequestError("rejected", "auth", {
				status: 401,
				oauthTokenEndpoint: true,
				englishMessage: "rejected",
			});
			assert.strictEqual(usageUnavailabilityOf(marked), undefined);

			const textOnly = new RequestError("rejected", "auth", {
				status: 401,
				logClassification: "RequestError(auth, status 401, oauth token endpoint)",
			});
			assert.strictEqual(
				usageUnavailabilityOf(textOnly),
				"forbidden",
				"a log-string mention alone must no longer suppress the classification"
			);
		});
	});
});
