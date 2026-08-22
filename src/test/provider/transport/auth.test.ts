import * as assert from "node:assert";
import { HttpResponse, http } from "msw";
import { type OAuthConfig, OAuthTokenSource, oauthCredentialFingerprint } from "../../../provider/transport/auth";
import { RequestError } from "../../../provider/transport/errorMapping";
import { mswServer, useMsw } from "../../mocks/handlers";

const TOKEN_URL = "http://idp.test/oauth2/token";

function oauthConfig(overrides: Partial<OAuthConfig> = {}): OAuthConfig {
	return { tokenUrl: TOKEN_URL, clientId: "client-1", clientSecret: "secret-1", ...overrides };
}

interface TokenEndpointOptions {
	accessToken?: string;
	expiresIn?: number;
}

/** Answer the token endpoint and collect the form fields of every request. */
function tokenEndpoint(options: TokenEndpointOptions = {}): { requests: Array<Record<string, string>> } {
	const requests: Array<Record<string, string>> = [];
	mswServer.use(
		http.post(TOKEN_URL, async ({ request }) => {
			requests.push(Object.fromEntries(new URLSearchParams(await request.text())));
			return HttpResponse.json({
				access_token: options.accessToken ?? `tok-${requests.length}`,
				token_type: "Bearer",
				...(options.expiresIn !== undefined ? { expires_in: options.expiresIn } : {}),
			});
		})
	);
	return { requests };
}

async function expectRequestError(promise: Promise<unknown>, kind: RequestError["kind"]): Promise<RequestError> {
	try {
		await promise;
	} catch (error) {
		assert.ok(error instanceof RequestError, `expected a RequestError, got ${String(error)}`);
		assert.strictEqual(error.kind, kind);
		// Every auth.ts construction site localizes its headline and must carry the
		// full English mirror; under the test host's English fallback the two
		// coincide byte-for-byte on every surface.
		assert.strictEqual(error.englishMessage, error.message, "the English mirror must match the English display");
		return error;
	}
	assert.fail("expected the promise to reject");
}

suite("provider/transport/auth", () => {
	useMsw();

	suite("token exchange", () => {
		test("posts a form-encoded client-credentials grant", async () => {
			const { requests } = tokenEndpoint({ expiresIn: 3600 });
			const source = new OAuthTokenSource();

			const token = await source.getToken(oauthConfig({ scopes: "read write" }), "discovery", 5000);

			assert.strictEqual(token, "tok-1");
			assert.deepStrictEqual(requests[0], {
				grant_type: "client_credentials",
				client_id: "client-1",
				client_secret: "secret-1",
				scope: "read write",
			});
		});

		test("omits the scope field when no scopes are configured", async () => {
			const { requests } = tokenEndpoint({ expiresIn: 3600 });
			const source = new OAuthTokenSource();

			await source.getToken(oauthConfig(), "discovery", 5000);

			assert.ok(requests[0] !== undefined && !("scope" in requests[0]));
		});

		test("a 401 from the token endpoint surfaces as a credential rejection without a retry", async () => {
			let attempts = 0;
			mswServer.use(
				http.post(TOKEN_URL, () => {
					attempts += 1;
					return HttpResponse.json({ error: "invalid_client" }, { status: 401 });
				})
			);
			const source = new OAuthTokenSource();

			const error = await expectRequestError(source.getToken(oauthConfig(), "discovery", 5000), "auth");

			assert.strictEqual(attempts, 1, "credential rejections must not be retried");
			assert.strictEqual(error.status, 401);
			assert.ok(
				error.message.includes("The identity provider refused to issue a token for this server"),
				`unexpected message: ${error.message}`
			);
			assert.ok(
				error.message.includes(`OAuth 401 at ${TOKEN_URL}: invalid_client`),
				`unexpected message: ${error.message}`
			);
			assert.ok(!error.message.includes("secret-1"), "the client secret must never appear in the error message");
		});

		test('a chat-triggered failure carries the "Details:" lead-in; a discovery one keeps the plain newline', async () => {
			// Failed exchanges are never cached, so both calls hit the endpoint
			// and each gets the shape of its own surface.
			mswServer.use(http.post(TOKEN_URL, () => HttpResponse.json({ error: "invalid_client" }, { status: 401 })));
			const source = new OAuthTokenSource();

			const chat = await expectRequestError(source.getToken(oauthConfig(), "chat", 5000), "auth");
			assert.ok(chat.message.includes(`\n\nDetails: OAuth 401 at ${TOKEN_URL}`), chat.message);

			const discovery = await expectRequestError(source.getToken(oauthConfig(), "discovery", 5000), "auth");
			assert.ok(!discovery.message.includes("Details:"), discovery.message);
			assert.ok(discovery.message.includes(`\nOAuth 401 at ${TOKEN_URL}`), discovery.message);
			assert.ok(!discovery.message.includes("\n\n"), discovery.message);
		});

		test("a malformed token response on the chat surface joins its detail with the Details lead-in", async () => {
			mswServer.use(http.post(TOKEN_URL, () => HttpResponse.json({ token: "wrong-field" })));
			const source = new OAuthTokenSource();

			const error = await expectRequestError(source.getToken(oauthConfig(), "chat", 5000), "http");

			assert.ok(
				error.message.includes(`\n\nDetails: OAuth token endpoint ${TOKEN_URL} answered 2xx without JSON`),
				`unexpected message: ${error.message}`
			);
		});

		test("a 400 error body's description reaches the message but never the log classification", async () => {
			mswServer.use(
				http.post(TOKEN_URL, () =>
					HttpResponse.json({ error: "invalid_scope", error_description: "unknown scope" }, { status: 400 })
				)
			);
			const source = new OAuthTokenSource();

			const error = await expectRequestError(source.getToken(oauthConfig(), "discovery", 5000), "auth");

			assert.ok(error.message.includes("invalid_scope: unknown scope"), `unexpected message: ${error.message}`);
			// The IdP detail is response-derived (Azure AD puts correlation IDs
			// there), so this site opts into a classification public surfaces record
			// instead of the message.
			assert.strictEqual(error.logClassification, "RequestError(auth, status 400, oauth token endpoint)");
			assert.strictEqual(error.oauthTokenEndpoint, true, "usage-availability classification keys on this flag");
		});

		test("an error description echoing the client secret is scrubbed before it reaches the message", async () => {
			mswServer.use(
				http.post(TOKEN_URL, () =>
					HttpResponse.json(
						{ error: "invalid_client", error_description: "the secret secret-1 does not match" },
						{ status: 401 }
					)
				)
			);
			const source = new OAuthTokenSource();

			const error = await expectRequestError(source.getToken(oauthConfig(), "discovery", 5000), "auth");

			assert.ok(!error.message.includes("secret-1"), `the client secret leaked: ${error.message}`);
			assert.ok(error.message.includes("the secret [REDACTED] does not match"), `unexpected message: ${error.message}`);
		});

		test("a secret longer than the detail cap is scrubbed before truncation, so no prefix leaks", async () => {
			const secret = `superlongsecret-${"x".repeat(300)}`;
			mswServer.use(
				http.post(TOKEN_URL, () =>
					HttpResponse.json(
						{ error: "invalid_client", error_description: `the secret ${secret} does not match` },
						{ status: 401 }
					)
				)
			);
			const source = new OAuthTokenSource();

			const error = await expectRequestError(
				source.getToken(oauthConfig({ clientSecret: secret }), "discovery", 5000),
				"auth"
			);

			assert.ok(!error.message.includes("superlongsecret-"), `a prefix of the secret leaked: ${error.message}`);
			assert.ok(!error.message.includes("x".repeat(20)), `part of the secret leaked: ${error.message}`);
			assert.ok(error.message.includes("[REDACTED]"), `unexpected message: ${error.message}`);
		});

		test("a secret containing whitespace cannot be reassembled by the whitespace collapse", async () => {
			// The exact-match scrub misses when the IdP echoes the secret with
			// different whitespace, and the detail's newline collapse would then
			// reconstruct it; the second, post-collapse scrub pass must catch it.
			mswServer.use(
				http.post(TOKEN_URL, () =>
					HttpResponse.json(
						{ error: "invalid_client", error_description: "the secret alpha\nbeta does not match" },
						{ status: 401 }
					)
				)
			);
			const source = new OAuthTokenSource();

			const error = await expectRequestError(
				source.getToken(oauthConfig({ clientSecret: "alpha beta" }), "discovery", 5000),
				"auth"
			);

			assert.ok(!error.message.includes("alpha beta"), `the collapsed secret leaked: ${error.message}`);
			assert.ok(error.message.includes("[REDACTED]"), `unexpected message: ${error.message}`);
		});

		test("a public client's grant omits the client_secret field entirely", async () => {
			const { requests } = tokenEndpoint({ expiresIn: 3600 });
			const source = new OAuthTokenSource();

			await source.getToken(oauthConfig({ clientSecret: "" }), "discovery", 5000);

			const request = requests[0];
			assert.ok(request !== undefined && !("client_secret" in request), "public clients send the client ID alone");
		});

		test("network failures are retried up to the discovery cap, then surface as a network error", async () => {
			let attempts = 0;
			mswServer.use(
				http.post(TOKEN_URL, () => {
					attempts += 1;
					return HttpResponse.error();
				})
			);
			const source = new OAuthTokenSource();

			const error = await expectRequestError(source.getToken(oauthConfig(), "discovery", 5000), "network");

			assert.strictEqual(attempts, 3, "two retries after the initial attempt, matching the discovery GETs");
			assert.ok(
				error.message.includes(`Unable to reach the OAuth token endpoint at ${TOKEN_URL}`),
				`unexpected message: ${error.message}`
			);
		});

		test("a DNS failure classifies as a connection error with the cause chain on the detail line", async () => {
			// Under undici a DNS failure surfaces as TypeError "fetch failed" with
			// the real reason on error.cause; the shared socket-failure classifier
			// gives it the same "connection" kind and cause-detail extraction as
			// the chat and discovery transports, with token-endpoint advice.
			const realFetch = globalThis.fetch;
			globalThis.fetch = () =>
				Promise.reject(
					Object.assign(new TypeError("fetch failed"), {
						cause: Object.assign(new Error("getaddrinfo ENOTFOUND idp.test"), { code: "ENOTFOUND" }),
					})
				);
			try {
				const source = new OAuthTokenSource();

				const error = await expectRequestError(source.getToken(oauthConfig(), "discovery", 5000), "connection");

				assert.ok(
					error.message.includes(`Unable to connect to the OAuth token endpoint at ${TOKEN_URL}`),
					`unexpected message: ${error.message}`
				);
				assert.ok(
					error.message.includes("\nfetch failed (cause: getaddrinfo ENOTFOUND idp.test)"),
					`the discovery detail sits under the headline on its own line: ${error.message}`
				);
				assert.strictEqual(error.setupHint, undefined, "the proxy-not-running hint would name the wrong process");
				assert.strictEqual(error.oauthTokenEndpoint, true, "usage-availability classification keys on this flag");
			} finally {
				globalThis.fetch = realFetch;
			}
		});

		test("a hostile cause getter cannot replace the network error with its own throw", async () => {
			const realFetch = globalThis.fetch;
			const hostile = new TypeError("fetch failed");
			Object.defineProperty(hostile, "cause", {
				get() {
					throw new Error("hostile getter");
				},
			});
			globalThis.fetch = () => Promise.reject(hostile);
			try {
				const source = new OAuthTokenSource();

				const error = await expectRequestError(source.getToken(oauthConfig(), "discovery", 5000), "network");

				assert.ok(
					error.message.includes(`Unable to reach the OAuth token endpoint at ${TOKEN_URL}`),
					`unexpected message: ${error.message}`
				);
				assert.ok(!error.message.includes("hostile getter"), `the getter's throw leaked: ${error.message}`);
			} finally {
				globalThis.fetch = realFetch;
			}
		});

		test("a transient 5xx is retried and the eventual token is returned", async () => {
			let attempts = 0;
			mswServer.use(
				http.post(TOKEN_URL, () => {
					attempts += 1;
					if (attempts === 1) {
						return HttpResponse.json({ error: "temporarily_unavailable" }, { status: 503 });
					}
					return HttpResponse.json({ access_token: "tok-after-retry", expires_in: 3600 });
				})
			);
			const source = new OAuthTokenSource();

			assert.strictEqual(await source.getToken(oauthConfig(), "discovery", 5000), "tok-after-retry");
			assert.strictEqual(attempts, 2);
		});

		test("a persistent 5xx surfaces as an http error after the retries", async () => {
			let attempts = 0;
			mswServer.use(
				http.post(TOKEN_URL, () => {
					attempts += 1;
					return HttpResponse.json({}, { status: 502 });
				})
			);
			const source = new OAuthTokenSource();

			const error = await expectRequestError(source.getToken(oauthConfig(), "discovery", 5000), "http");

			assert.strictEqual(attempts, 3);
			assert.strictEqual(error.status, 502);
			assert.strictEqual(error.logClassification, "RequestError(http, status 502, oauth token endpoint)");
			assert.strictEqual(error.oauthTokenEndpoint, true, "usage-availability classification keys on this flag");
		});

		test("a status outside the credential and 5xx sets fails immediately through the catch-all http branch", async () => {
			// 404 is neither a credential rejection (400/401/403) nor retryable
			// (5xx), so it exercises the catch-all throw.
			let attempts = 0;
			mswServer.use(
				http.post(TOKEN_URL, () => {
					attempts += 1;
					return HttpResponse.json({ error: "not_found" }, { status: 404 });
				})
			);
			const source = new OAuthTokenSource();

			const error = await expectRequestError(source.getToken(oauthConfig(), "discovery", 5000), "http");

			assert.strictEqual(attempts, 1, "a non-5xx failure must not be retried");
			assert.strictEqual(error.status, 404);
			assert.ok(
				error.message.includes("The OAuth token endpoint gave an unexpected answer"),
				`unexpected message: ${error.message}`
			);
			assert.ok(
				error.message.includes(`OAuth token endpoint 404 at ${TOKEN_URL}: not_found`),
				`unexpected message: ${error.message}`
			);
			assert.strictEqual(error.logClassification, "RequestError(http, status 404, oauth token endpoint)");
			assert.strictEqual(error.oauthTokenEndpoint, true, "usage-availability classification keys on this flag");
		});

		test("a response without an access_token fails as malformed without a retry", async () => {
			let attempts = 0;
			mswServer.use(
				http.post(TOKEN_URL, () => {
					attempts += 1;
					return HttpResponse.json({ token: "wrong-field" });
				})
			);
			const source = new OAuthTokenSource();

			const error = await expectRequestError(source.getToken(oauthConfig(), "discovery", 5000), "http");
			assert.ok(error.message.includes("didn't return a usable access token"), `unexpected message: ${error.message}`);
			assert.ok(
				error.message.includes(`OAuth token endpoint ${TOKEN_URL} answered 2xx without JSON`),
				`unexpected message: ${error.message}`
			);
			assert.strictEqual(attempts, 1, "malformed responses must not be retried");
		});

		test("an access token outside the header-value charset is rejected as malformed", async () => {
			mswServer.use(http.post(TOKEN_URL, () => HttpResponse.json({ access_token: "tok\nInjected: x" })));
			const source = new OAuthTokenSource();

			const error = await expectRequestError(source.getToken(oauthConfig(), "discovery", 5000), "http");
			assert.ok(error.message.includes("not allowed in an HTTP header value"), `unexpected message: ${error.message}`);
			assert.ok(!error.message.includes("Injected"), "the invalid token value must not appear in the message");
		});

		test("the timeout is a hard bound on the exchange", async () => {
			mswServer.use(http.post(TOKEN_URL, () => new Promise<Response>(() => {})));
			const source = new OAuthTokenSource();

			const error = await expectRequestError(source.getToken(oauthConfig(), "discovery", 100), "timeout");

			assert.ok(error.message.includes("timed out after 100ms"), `unexpected message: ${error.message}`);
			assert.ok(error.message.includes("discovery.timeout"), "the message must name the governing setting");
		});

		test("the exchange-timeout advice names each surface's true bound", async () => {
			mswServer.use(http.post(TOKEN_URL, () => new Promise<Response>(() => {})));

			// The chat transport bounds the exchange by the discovery timeout too
			// (chatClient passes it through; chat.timeout only interrupts via the
			// outer signal and renders its own message there), so the chat surface
			// keeps the discovery.timeout advice - naming chat.timeout would point
			// at a setting that cannot extend this bound.
			const chat = await expectRequestError(new OAuthTokenSource().getToken(oauthConfig(), "chat", 100), "timeout");
			assert.ok(chat.message.includes("discovery.timeout"), `unexpected message: ${chat.message}`);

			// The commit call passes its chat.timeout whole-call budget through.
			const commit = await expectRequestError(
				new OAuthTokenSource().getToken(oauthConfig(), "commitGeneration", 100),
				"timeout"
			);
			assert.ok(commit.message.includes("chat.timeout"), `unexpected message: ${commit.message}`);
			assert.ok(!commit.message.includes("discovery.timeout"), "the commit bound is not the discovery timeout");

			// The inline-completion bound is fixed in code (FIM_TIMEOUT_MS), so no
			// setting is named - advice to raise one would be a lie.
			const completion = await expectRequestError(
				new OAuthTokenSource().getToken(oauthConfig(), "completion", 100),
				"timeout"
			);
			assert.ok(completion.message.includes("timed out after 100ms"), `unexpected message: ${completion.message}`);
			assert.ok(!completion.message.includes(".timeout"), "no setting can raise the fixed FIM bound");

			// English fallback: display and mirror coincide on every surface.
			for (const error of [chat, commit, completion]) {
				assert.strictEqual(error.englishMessage, error.message);
			}
		});

		test("an aborted caller signal interrupts the exchange and surfaces the abort, not a token timeout", async () => {
			mswServer.use(http.post(TOKEN_URL, () => new Promise<Response>(() => {})));
			const source = new OAuthTokenSource();
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 50);

			await assert.rejects(source.getToken(oauthConfig(), "discovery", 5000, controller.signal), (error: unknown) => {
				assert.ok(!(error instanceof RequestError), `the abort must be rethrown as-is, got: ${String(error)}`);
				assert.ok(error instanceof Error && error.name === "AbortError", `expected AbortError, got ${String(error)}`);
				return true;
			});
		});
	});

	suite("token cache", () => {
		test("a live token is reused without hitting the token endpoint again", async () => {
			const { requests } = tokenEndpoint({ expiresIn: 3600 });
			const source = new OAuthTokenSource();

			const first = await source.getToken(oauthConfig(), "discovery", 5000);
			const second = await source.getToken(oauthConfig(), "discovery", 5000);

			assert.strictEqual(first, second);
			assert.strictEqual(requests.length, 1);
		});

		test("an expired token is replaced on the next request", async () => {
			const { requests } = tokenEndpoint({ expiresIn: 3600 });
			const source = new OAuthTokenSource();

			const first = await source.getToken(oauthConfig(), "discovery", 5000);
			const realNow = Date.now;
			Date.now = () => realNow() + 3600 * 1000;
			try {
				const second = await source.getToken(oauthConfig(), "discovery", 5000);
				assert.notStrictEqual(second, first);
			} finally {
				Date.now = realNow;
			}
			assert.strictEqual(requests.length, 2);
		});

		test("a token inside the refresh skew of its expiry is treated as expired", async () => {
			const { requests } = tokenEndpoint({ expiresIn: 300 });
			const source = new OAuthTokenSource();

			await source.getToken(oauthConfig(), "discovery", 5000);
			const realNow = Date.now;
			// 250 s in: 50 s of nominal validity left, inside the 60 s skew.
			Date.now = () => realNow() + 250 * 1000;
			try {
				await source.getToken(oauthConfig(), "discovery", 5000);
			} finally {
				Date.now = realNow;
			}
			assert.strictEqual(requests.length, 2);
		});

		test("a short-lived token still caches: the skew is clamped to half the lifetime", async () => {
			const { requests } = tokenEndpoint({ expiresIn: 30 });
			const source = new OAuthTokenSource();

			await source.getToken(oauthConfig(), "discovery", 5000);
			await source.getToken(oauthConfig(), "discovery", 5000);

			assert.strictEqual(requests.length, 1, "a 30 s token must serve from cache for its first 15 s");
		});

		test("a zero or negative expires_in means the token is never served from cache", async () => {
			const { requests } = tokenEndpoint({ expiresIn: 0 });
			const source = new OAuthTokenSource();

			await source.getToken(oauthConfig(), "discovery", 5000);
			await source.getToken(oauthConfig(), "discovery", 5000);

			assert.strictEqual(requests.length, 2, "an already-expired token must not be cached for the default lifetime");
		});

		test("a response without expires_in still caches for the conservative default", async () => {
			const { requests } = tokenEndpoint();
			const source = new OAuthTokenSource();

			await source.getToken(oauthConfig(), "discovery", 5000);
			await source.getToken(oauthConfig(), "discovery", 5000);

			assert.strictEqual(requests.length, 1);
		});

		test("concurrent requests for the same credentials share one exchange", async () => {
			const { requests } = tokenEndpoint({ expiresIn: 3600 });
			const source = new OAuthTokenSource();

			const [first, second] = await Promise.all([
				source.getToken(oauthConfig(), "discovery", 5000),
				source.getToken(oauthConfig(), "discovery", 5000),
			]);

			assert.strictEqual(first, second);
			assert.strictEqual(requests.length, 1);
		});

		test("a joiner's abort stops its own wait while the shared exchange completes for the starter", async () => {
			let releaseToken: ((response: Response) => void) | undefined;
			mswServer.use(
				http.post(
					TOKEN_URL,
					() =>
						new Promise<Response>((resolve) => {
							releaseToken = resolve;
						})
				)
			);
			const source = new OAuthTokenSource();

			const starter = source.getToken(oauthConfig(), "discovery", 5000);
			const controller = new AbortController();
			const joiner = source.getToken(oauthConfig(), "discovery", 5000, controller.signal);
			controller.abort();

			await assert.rejects(joiner, (error: unknown) => {
				assert.ok(error instanceof Error && error.name === "AbortError", `expected AbortError, got ${String(error)}`);
				return true;
			});

			while (releaseToken === undefined) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			releaseToken(HttpResponse.json({ access_token: "tok-1", token_type: "Bearer", expires_in: 3600 }));
			assert.strictEqual(await starter, "tok-1", "the shared exchange must survive the joiner's abort");
		});

		test("invalidate discards the cached token so the next request exchanges afresh", async () => {
			const { requests } = tokenEndpoint({ expiresIn: 3600 });
			const source = new OAuthTokenSource();

			const first = await source.getToken(oauthConfig(), "discovery", 5000);
			source.invalidate(oauthConfig(), first);
			const second = await source.getToken(oauthConfig(), "discovery", 5000);

			assert.notStrictEqual(second, first);
			assert.strictEqual(requests.length, 2);
		});

		test("a straggling 401 for an already-replaced token does not discard the fresh one", async () => {
			const { requests } = tokenEndpoint({ expiresIn: 3600 });
			const source = new OAuthTokenSource();

			const fresh = await source.getToken(oauthConfig(), "discovery", 5000);
			source.invalidate(oauthConfig(), "tok-stale");

			assert.strictEqual(await source.getToken(oauthConfig(), "discovery", 5000), fresh);
			assert.strictEqual(requests.length, 1, "the fresh token must survive the stale rejection");
		});

		test("invalidate without a rejected token discards unconditionally", async () => {
			const { requests } = tokenEndpoint({ expiresIn: 3600 });
			const source = new OAuthTokenSource();

			await source.getToken(oauthConfig(), "discovery", 5000);
			source.invalidate(oauthConfig());
			await source.getToken(oauthConfig(), "discovery", 5000);

			assert.strictEqual(requests.length, 2);
		});

		test("a rotated client secret does not reuse the previous secret's token", async () => {
			const { requests } = tokenEndpoint({ expiresIn: 3600 });
			const source = new OAuthTokenSource();

			await source.getToken(oauthConfig(), "discovery", 5000);
			await source.getToken(oauthConfig({ clientSecret: "rotated" }), "discovery", 5000);

			assert.strictEqual(requests.length, 2);
			assert.strictEqual(requests[1]?.client_secret, "rotated");
		});

		test("a failed exchange is not cached", async () => {
			let attempts = 0;
			mswServer.use(
				http.post(TOKEN_URL, () => {
					attempts += 1;
					if (attempts === 1) {
						return HttpResponse.json({ error: "invalid_client" }, { status: 401 });
					}
					return HttpResponse.json({ access_token: "tok-recovered", expires_in: 3600 });
				})
			);
			const source = new OAuthTokenSource();

			await expectRequestError(source.getToken(oauthConfig(), "discovery", 5000), "auth");
			assert.strictEqual(await source.getToken(oauthConfig(), "discovery", 5000), "tok-recovered");
		});
	});

	suite("oauthCredentialFingerprint", () => {
		test("is stable for equal credentials and never contains the secret", () => {
			const fingerprint = oauthCredentialFingerprint(oauthConfig());
			assert.strictEqual(oauthCredentialFingerprint(oauthConfig()), fingerprint);
			assert.ok(!fingerprint.includes("secret-1"));
		});

		test("changes when any credential part rotates", () => {
			const base = oauthCredentialFingerprint(oauthConfig());
			assert.notStrictEqual(oauthCredentialFingerprint(oauthConfig({ clientSecret: "rotated" })), base);
			assert.notStrictEqual(oauthCredentialFingerprint(oauthConfig({ clientId: "client-2" })), base);
			assert.notStrictEqual(oauthCredentialFingerprint(oauthConfig({ tokenUrl: "http://idp.test/other" })), base);
			assert.notStrictEqual(oauthCredentialFingerprint(oauthConfig({ scopes: "read" })), base);
		});

		test("field boundaries are unambiguous: content shifted across fields never collides", () => {
			// The fields are free-form strings, so a delimiter join would hash
			// {clientId: "a\nb", clientSecret: "c"} and {clientId: "a", clientSecret:
			// "b\nc"} identically and share a cached token across different credentials.
			const shifted = oauthCredentialFingerprint(oauthConfig({ clientId: "a\nb", clientSecret: "c" }));
			const original = oauthCredentialFingerprint(oauthConfig({ clientId: "a", clientSecret: "b\nc" }));
			assert.notStrictEqual(shifted, original);
		});
	});
});
