import * as assert from "node:assert";
import { HttpResponse, http } from "msw";
import * as vscode from "vscode";
import type { AggregatedStatus } from "../../shared/servers";
import {
	CHAT_COMPLETIONS_URL,
	discoveryHandlers,
	MODEL_INFO_URL,
	MODELS_URL,
	mswServer,
	sseTextResponse,
	TEST_BASE_URL,
	useMsw,
} from "../mocks/handlers";
import { DEFAULT_DISCOVERY_PAYLOAD, expectDefined, makeProvider, toHeaderMap, userMessage } from "../testUtils";

const TOKEN_URL = "http://idp.test/oauth2/token";

const OAUTH_GROUP_CONFIGURATION = {
	baseUrl: TEST_BASE_URL,
	oauthTokenUrl: TOKEN_URL,
	oauthClientId: "client-1",
	oauthClientSecret: "secret-1",
};

/** The host passes the group configuration structurally; stable typings only declare `silent`. */
function groupOptions(configuration: unknown, silent = true): { silent: boolean } {
	return { silent, configuration } as { silent: boolean };
}

const cancellation = () => new vscode.CancellationTokenSource().token;

/** Answer the token endpoint with sequentially numbered tokens and count the exchanges. */
function tokenEndpoint(expiresIn = 3600): { count: () => number } {
	let exchanges = 0;
	mswServer.use(
		http.post(TOKEN_URL, () => {
			exchanges += 1;
			return HttpResponse.json({ access_token: `tok-${exchanges}`, token_type: "Bearer", expires_in: expiresIn });
		})
	);
	return { count: () => exchanges };
}

function sendChat(
	provider: ReturnType<typeof makeProvider>,
	model: Parameters<ReturnType<typeof makeProvider>["provideLanguageModelChatResponse"]>[0]
): Promise<void> {
	return provider.provideLanguageModelChatResponse(
		model,
		[userMessage("hi")],
		{ toolMode: vscode.LanguageModelChatToolMode.Auto } as vscode.ProvideLanguageModelChatResponseOptions,
		{ report: () => {} },
		cancellation()
	);
}

suite("provider groups with OAuth", () => {
	useMsw();

	test("the exchanged bearer token authenticates both discovery and chat requests", async () => {
		const provider = makeProvider();
		const tokens = tokenEndpoint();
		const authHeaders: Array<string | undefined> = [];
		const recordAuth = (request: Request) => {
			authHeaders.push(toHeaderMap(request.headers).authorization);
		};
		mswServer.use(
			http.get(MODEL_INFO_URL, ({ request }) => {
				recordAuth(request);
				return HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD);
			}),
			http.post(CHAT_COMPLETIONS_URL, ({ request }) => {
				recordAuth(request);
				return sseTextResponse("ok");
			})
		);

		const infos = await provider.provideLanguageModelChatInformation(
			groupOptions(OAUTH_GROUP_CONFIGURATION),
			cancellation()
		);
		await sendChat(provider, expectDefined(infos[0]));

		assert.strictEqual(tokens.count(), 1, "one exchange must cover discovery and chat");
		assert.deepStrictEqual(authHeaders, ["Bearer tok-1", "Bearer tok-1"]);
	});

	test("a cached discovery sweep still attaches working OAuth credentials", async () => {
		const provider = makeProvider();
		const tokens = tokenEndpoint();
		let discoveryHits = 0;
		const chatAuth: Array<string | undefined> = [];
		mswServer.use(
			http.get(MODEL_INFO_URL, () => {
				discoveryHits += 1;
				return HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD);
			}),
			http.post(CHAT_COMPLETIONS_URL, ({ request }) => {
				chatAuth.push(toHeaderMap(request.headers).authorization);
				return sseTextResponse("ok");
			})
		);

		await provider.provideLanguageModelChatInformation(groupOptions(OAUTH_GROUP_CONFIGURATION), cancellation());
		const secondSweep = await provider.provideLanguageModelChatInformation(
			groupOptions(OAUTH_GROUP_CONFIGURATION),
			cancellation()
		);

		assert.strictEqual(discoveryHits, 1, "the second sweep must be served from the discovery cache");
		await sendChat(provider, expectDefined(secondSweep[0]));
		assert.deepStrictEqual(
			chatAuth,
			["Bearer tok-1"],
			"a model from the cached sweep must route with the group's OAuth credentials"
		);
		assert.strictEqual(tokens.count(), 1, "the still-valid token serves the cached sweep's chat too");
	});

	test("an OAuth group without a static API key sends no X-API-Key header", async () => {
		const provider = makeProvider();
		tokenEndpoint();
		let headers: Record<string, string> | undefined;
		mswServer.use(
			...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD),
			http.post(CHAT_COMPLETIONS_URL, ({ request }) => {
				headers = toHeaderMap(request.headers);
				return sseTextResponse("ok");
			})
		);

		const infos = await provider.provideLanguageModelChatInformation(
			groupOptions(OAUTH_GROUP_CONFIGURATION),
			cancellation()
		);
		await sendChat(provider, expectDefined(infos[0]));

		const sent = expectDefined(headers);
		assert.strictEqual(sent.authorization, "Bearer tok-1");
		assert.strictEqual(sent["x-api-key"], undefined);
	});

	test("a static API key configured alongside OAuth keeps going out as X-API-Key next to the bearer token", async () => {
		const provider = makeProvider();
		tokenEndpoint();
		let headers: Record<string, string> | undefined;
		mswServer.use(
			...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD),
			http.post(CHAT_COMPLETIONS_URL, ({ request }) => {
				headers = toHeaderMap(request.headers);
				return sseTextResponse("ok");
			})
		);

		const infos = await provider.provideLanguageModelChatInformation(
			groupOptions({ ...OAUTH_GROUP_CONFIGURATION, apiKey: "static-key" }),
			cancellation()
		);
		await sendChat(provider, expectDefined(infos[0]));

		const sent = expectDefined(headers);
		assert.strictEqual(sent.authorization, "Bearer tok-1", "the bearer token owns Authorization");
		assert.strictEqual(sent["x-api-key"], "static-key", "the static key still rides along for gateways that check it");
	});

	test("user cancellation interrupts a chat-triggered token exchange", async () => {
		const provider = makeProvider();
		let tokenExchanges = 0;
		let chatHits = 0;
		mswServer.use(
			// The first exchange (discovery) answers with an immediately-expiring
			// token so the chat call must exchange afresh; that one hangs.
			http.post(TOKEN_URL, () => {
				tokenExchanges += 1;
				if (tokenExchanges === 1) {
					return HttpResponse.json({ access_token: "tok-1", token_type: "Bearer", expires_in: 0 });
				}
				return new Promise<Response>(() => {});
			}),
			...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD),
			http.post(CHAT_COMPLETIONS_URL, () => {
				chatHits += 1;
				return sseTextResponse("ok");
			})
		);

		const infos = await provider.provideLanguageModelChatInformation(
			groupOptions(OAUTH_GROUP_CONFIGURATION),
			cancellation()
		);
		const tokenSource = new vscode.CancellationTokenSource();
		setTimeout(() => tokenSource.cancel(), 100);

		await assert.rejects(
			provider.provideLanguageModelChatResponse(
				expectDefined(infos[0]),
				[userMessage("hi")],
				{ toolMode: vscode.LanguageModelChatToolMode.Auto } as vscode.ProvideLanguageModelChatResponseOptions,
				{ report: () => {} },
				tokenSource.token
			),
			(error: unknown) => error instanceof vscode.CancellationError
		);
		assert.strictEqual(tokenExchanges, 2, "the chat must have started a fresh exchange");
		assert.strictEqual(chatHits, 0, "no chat request may go out without a token");
	});

	test("an OAuth-only group reports authentication configured in its status", async () => {
		const provider = makeProvider();
		tokenEndpoint();
		const statuses: AggregatedStatus[] = [];
		provider.setStatusCallback((status) => statuses.push(status));
		mswServer.use(...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD));

		await provider.provideLanguageModelChatInformation(groupOptions(OAUTH_GROUP_CONFIGURATION), cancellation());

		const last = expectDefined(statuses.at(-1));
		assert.strictEqual(
			expectDefined(last.serverStatuses[0]).hasApiKey,
			true,
			"diagnostics reads hasApiKey as authentication configured"
		);
	});

	test("the virtual-key header rides on discovery and chat requests when configured", async () => {
		const provider = makeProvider();
		tokenEndpoint();
		const virtualKeys: Array<string | undefined> = [];
		mswServer.use(
			http.get(MODEL_INFO_URL, ({ request }) => {
				virtualKeys.push(toHeaderMap(request.headers)["x-litellm-api-key"]);
				return HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD);
			}),
			http.post(CHAT_COMPLETIONS_URL, ({ request }) => {
				virtualKeys.push(toHeaderMap(request.headers)["x-litellm-api-key"]);
				return sseTextResponse("ok");
			})
		);

		const infos = await provider.provideLanguageModelChatInformation(
			groupOptions({
				...OAUTH_GROUP_CONFIGURATION,
				virtualKeyHeader: "x-litellm-api-key",
				virtualKeyValue: "vk-secret",
			}),
			cancellation()
		);
		await sendChat(provider, expectDefined(infos[0]));

		assert.deepStrictEqual(virtualKeys, ["vk-secret", "vk-secret"]);
	});

	test("an expired token is replaced before the next request, not during one", async () => {
		const provider = makeProvider();
		const tokens = tokenEndpoint(3600);
		const chatAuth: Array<string | undefined> = [];
		mswServer.use(
			...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD),
			http.post(CHAT_COMPLETIONS_URL, ({ request }) => {
				chatAuth.push(toHeaderMap(request.headers).authorization);
				return sseTextResponse("ok");
			})
		);

		const infos = await provider.provideLanguageModelChatInformation(
			groupOptions(OAUTH_GROUP_CONFIGURATION),
			cancellation()
		);
		const model = expectDefined(infos[0]);
		await sendChat(provider, model);

		const realNow = Date.now;
		Date.now = () => realNow() + 3600 * 1000;
		try {
			await sendChat(provider, model);
		} finally {
			Date.now = realNow;
		}

		assert.strictEqual(tokens.count(), 2, "the expired token must trigger exactly one fresh exchange");
		assert.deepStrictEqual(chatAuth, ["Bearer tok-1", "Bearer tok-2"]);
	});

	test("a 401 on a chat call is not retried; the next request exchanges a fresh token", async () => {
		const provider = makeProvider();
		const tokens = tokenEndpoint();
		let chatAttempts = 0;
		mswServer.use(
			...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD),
			http.post(CHAT_COMPLETIONS_URL, ({ request }) => {
				chatAttempts += 1;
				if (toHeaderMap(request.headers).authorization === "Bearer tok-1") {
					return HttpResponse.json({ error: { message: "token expired" } }, { status: 401 });
				}
				return sseTextResponse("ok");
			})
		);

		const infos = await provider.provideLanguageModelChatInformation(
			groupOptions(OAUTH_GROUP_CONFIGURATION),
			cancellation()
		);
		const model = expectDefined(infos[0]);

		await assert.rejects(sendChat(provider, model), /Authentication failed/);
		assert.strictEqual(chatAttempts, 1, "the rejected chat call must not be retried");

		await sendChat(provider, model);
		assert.strictEqual(chatAttempts, 2);
		assert.strictEqual(tokens.count(), 2, "the 401 must invalidate the cached token for the next request");
	});

	test("a 401 with the virtual key on its own header still invalidates the bearer token that was sent", async () => {
		// Guards the discriminating half of the sent-token capture: a virtual
		// key on a non-Authorization header leaves the bearer entry in place,
		// so the 401 concerns the sent token and must force a fresh exchange.
		const provider = makeProvider();
		const tokens = tokenEndpoint();
		let chatAttempts = 0;
		mswServer.use(
			...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD),
			http.post(CHAT_COMPLETIONS_URL, ({ request }) => {
				chatAttempts += 1;
				if (toHeaderMap(request.headers).authorization === "Bearer tok-1") {
					return HttpResponse.json({ error: { message: "token expired" } }, { status: 401 });
				}
				return sseTextResponse("ok");
			})
		);

		const infos = await provider.provideLanguageModelChatInformation(
			groupOptions({
				...OAUTH_GROUP_CONFIGURATION,
				virtualKeyHeader: "x-litellm-api-key",
				virtualKeyValue: "vk-secret",
			}),
			cancellation()
		);
		const model = expectDefined(infos[0]);

		await assert.rejects(sendChat(provider, model), /Authentication failed/);
		await sendChat(provider, model);
		assert.strictEqual(chatAttempts, 2);
		assert.strictEqual(tokens.count(), 2, "the sent bearer token was rejected and must be replaced");
	});

	test("a 401 when the virtual key overwrites the Authorization header does not discard the unsent OAuth token", async () => {
		// The virtual key replaces the bearer entry - under any casing, since
		// HTTP header names are case-insensitive - so no OAuth token went out
		// and the 401 says nothing about the cached one: invalidating it anyway
		// (the old header re-parse missed the overwrite) would force a needless
		// exchange on every retry against a misconfigured gateway.
		for (const spelling of ["Authorization", "authorization"]) {
			const provider = makeProvider();
			const tokens = tokenEndpoint();
			let chatAttempts = 0;
			const chatAuth: Array<string | undefined> = [];
			mswServer.use(
				...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD),
				http.post(CHAT_COMPLETIONS_URL, ({ request }) => {
					chatAttempts += 1;
					chatAuth.push(toHeaderMap(request.headers).authorization);
					if (chatAttempts === 1) {
						return HttpResponse.json({ error: { message: "bad virtual key" } }, { status: 401 });
					}
					return sseTextResponse("ok");
				})
			);

			const infos = await provider.provideLanguageModelChatInformation(
				groupOptions({
					...OAUTH_GROUP_CONFIGURATION,
					virtualKeyHeader: spelling,
					virtualKeyValue: "vk-master",
				}),
				cancellation()
			);
			const model = expectDefined(infos[0]);

			await assert.rejects(sendChat(provider, model), /Authentication failed/);
			await sendChat(provider, model);

			assert.deepStrictEqual(
				chatAuth,
				["vk-master", "vk-master"],
				`the virtual key must own the Authorization header alone (spelled "${spelling}"), never combined with the bearer entry`
			);
			assert.strictEqual(
				tokens.count(),
				0,
				`the token could never be sent (spelled "${spelling}"), so no exchange runs and the 401 invalidates nothing`
			);
		}
	});

	test("a 401 on discovery invalidates the sent bearer token, so the next sweep exchanges afresh", async () => {
		const provider = makeProvider();
		const tokens = tokenEndpoint();
		const reject401 = (request: Request) =>
			toHeaderMap(request.headers).authorization === "Bearer tok-1"
				? HttpResponse.json({ error: "expired" }, { status: 401 })
				: HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD);
		mswServer.use(
			http.get(MODEL_INFO_URL, ({ request }) => reject401(request)),
			http.get(MODELS_URL, ({ request }) => reject401(request))
		);

		const first = await provider.provideLanguageModelChatInformation(
			groupOptions(OAUTH_GROUP_CONFIGURATION),
			cancellation()
		);
		assert.deepStrictEqual(first, [], "the silent rejected sweep serves no models");

		const second = await provider.provideLanguageModelChatInformation(
			groupOptions(OAUTH_GROUP_CONFIGURATION),
			cancellation()
		);
		assert.ok(second.length > 0, "the fresh token's sweep must succeed");
		assert.strictEqual(tokens.count(), 2, "the discovery 401 must invalidate the token it sent");
	});

	test("a credential rejection at the token endpoint surfaces its message and stops before the server", async () => {
		const provider = makeProvider();
		let tokenAttempts = 0;
		let serverHits = 0;
		const countServerHit = () => {
			serverHits += 1;
			return HttpResponse.json(DEFAULT_DISCOVERY_PAYLOAD);
		};
		mswServer.use(
			http.post(TOKEN_URL, () => {
				tokenAttempts += 1;
				return HttpResponse.json({ error: "invalid_client" }, { status: 401 });
			}),
			http.get(MODEL_INFO_URL, countServerHit),
			http.get(MODELS_URL, countServerHit)
		);

		await assert.rejects(
			provider.provideLanguageModelChatInformation(groupOptions(OAUTH_GROUP_CONFIGURATION, false), cancellation()),
			/OAuth authentication failed: the token endpoint at http:\/\/idp\.test\/oauth2\/token rejected the client credentials/
		);
		assert.strictEqual(tokenAttempts, 1, "a credential rejection must not be retried");
		assert.strictEqual(serverHits, 0, "no request may reach the LiteLLM server without a token");
	});

	test("neither the client secret nor the token nor the virtual key reaches the log channel", async () => {
		const lines: string[] = [];
		const channel = {
			info: (line: string) => lines.push(line),
			error: (line: string) => lines.push(`ERROR: ${line}`),
		} as unknown as vscode.LogOutputChannel;
		const provider = makeProvider(undefined, "unused", channel);
		mswServer.use(
			http.post(TOKEN_URL, () =>
				HttpResponse.json({ access_token: "super-secret-token", token_type: "Bearer", expires_in: 3600 })
			),
			...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD),
			http.post(CHAT_COMPLETIONS_URL, () => sseTextResponse("ok"))
		);

		const infos = await provider.provideLanguageModelChatInformation(
			groupOptions({
				...OAUTH_GROUP_CONFIGURATION,
				virtualKeyHeader: "x-litellm-api-key",
				virtualKeyValue: "super-secret-virtual-key",
			}),
			cancellation()
		);
		await sendChat(provider, expectDefined(infos[0]));

		assert.ok(lines.length > 0, "the round trip must have produced log lines");
		for (const secret of ["secret-1", "super-secret-token", "super-secret-virtual-key"]) {
			assert.ok(
				lines.every((line) => !line.includes(secret)),
				`"${secret}" leaked into the log channel: ${lines.filter((line) => line.includes(secret)).join(" | ")}`
			);
		}
	});

	test("groups with different client secrets at one base URL keep distinct status identities", async () => {
		const provider = makeProvider();
		tokenEndpoint();
		const statuses: Array<{ serverStatuses: Array<{ serverId: string }> }> = [];
		provider.setStatusCallback((status) => statuses.push(status));
		mswServer.use(...discoveryHandlers(DEFAULT_DISCOVERY_PAYLOAD));

		await provider.provideLanguageModelChatInformation({ silent: true }, cancellation());
		await provider.provideLanguageModelChatInformation(groupOptions(OAUTH_GROUP_CONFIGURATION), cancellation());
		await provider.provideLanguageModelChatInformation(
			groupOptions({ ...OAUTH_GROUP_CONFIGURATION, oauthClientSecret: "rotated" }),
			cancellation()
		);

		const last = expectDefined(statuses.at(-1));
		assert.strictEqual(last.serverStatuses.length, 2, "rotating the secret must mint a new identity");
		const [first, second] = last.serverStatuses;
		assert.notStrictEqual(expectDefined(first).serverId, expectDefined(second).serverId);
	});
});
