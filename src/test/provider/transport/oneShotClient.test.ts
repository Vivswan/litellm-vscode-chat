import * as assert from "node:assert";
import { HttpResponse, http } from "msw";
import * as vscode from "vscode";
import { RequestError } from "../../../provider/transport/errorMapping";
import type { OneShotChatMessage, OneShotConnection } from "../../../provider/transport/oneShotClient";
import { OneShotClient } from "../../../provider/transport/oneShotClient";
import {
	CHAT_COMPLETIONS_URL,
	COMPLETIONS_URL,
	completionJsonResponse,
	emptyErrorResponse,
	mswServer,
	TEST_BASE_URL,
	useMsw,
} from "../../mocks/handlers";

const TOKEN_URL = "http://idp.test/oauth2/token";

function client(): OneShotClient {
	return new OneShotClient({ userAgent: "test-agent" });
}

function connection(overrides: Partial<OneShotConnection> = {}): OneShotConnection {
	return { baseUrl: TEST_BASE_URL, apiKey: "sk-test", headers: {}, ...overrides };
}

function callOptions(timeoutMs = 5000): { timeoutMs: number; token: vscode.CancellationToken } {
	return { timeoutMs, token: new vscode.CancellationTokenSource().token };
}

/** A completed non-streaming chat body carrying one assistant message. */
function chatJson(content: string): Response {
	return HttpResponse.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] });
}

async function expectRequestError(promise: Promise<unknown>, kind: RequestError["kind"]): Promise<RequestError> {
	try {
		await promise;
	} catch (error) {
		assert.ok(error instanceof RequestError, `expected a RequestError, got ${String(error)}`);
		assert.strictEqual(error.kind, kind);
		return error;
	}
	assert.fail("expected the promise to reject");
}

suite("provider/transport/oneShotClient", () => {
	useMsw();

	test("sends exactly model/messages/stream:false and returns the reply content", async () => {
		let seenBody: Record<string, unknown> | undefined;
		let seenAuthorization: string | null = null;
		let seenApiKey: string | null = null;
		let seenContentType: string | null = null;
		mswServer.use(
			http.post(CHAT_COMPLETIONS_URL, async ({ request }) => {
				seenBody = (await request.json()) as Record<string, unknown>;
				seenAuthorization = request.headers.get("authorization");
				seenApiKey = request.headers.get("x-api-key");
				seenContentType = request.headers.get("content-type");
				return chatJson("feat: add the thing");
			})
		);

		const messages: OneShotChatMessage[] = [{ role: "user", content: "diff" }];
		const result = await client().completeChatOnce(connection(), { model: "gpt-test", messages }, callOptions());

		assert.strictEqual(result, "feat: add the thing");
		assert.ok(seenBody, "the request must carry a JSON body");
		// The body key set is the whole contract: nothing injected beyond the
		// provider-owned fields, and max_tokens absent when the caller set none.
		assert.deepStrictEqual(Object.keys(seenBody).sort(), ["messages", "model", "stream"]);
		assert.strictEqual(seenBody.model, "gpt-test");
		assert.strictEqual(seenBody.stream, false);
		assert.deepStrictEqual(seenBody.messages, messages);
		// Plain-fetch parity with the SDK client: both API-key auth headers.
		assert.strictEqual(seenAuthorization, "Bearer sk-test");
		assert.strictEqual(seenApiKey, "sk-test");
		assert.strictEqual(seenContentType, "application/json");
	});

	test("max_tokens rides the body only when the caller sets it", async () => {
		let seenBody: Record<string, unknown> | undefined;
		mswServer.use(
			http.post(CHAT_COMPLETIONS_URL, async ({ request }) => {
				seenBody = (await request.json()) as Record<string, unknown>;
				return chatJson("ok");
			})
		);

		await client().completeChatOnce(
			connection(),
			{ model: "gpt-test", messages: [{ role: "user", content: "hi" }], maxTokens: 256 },
			callOptions()
		);

		assert.ok(seenBody);
		assert.deepStrictEqual(Object.keys(seenBody).sort(), ["max_tokens", "messages", "model", "stream"]);
		assert.strictEqual(seenBody.max_tokens, 256);
	});

	test("a malformed 200 body reads as an empty answer, never as quoted error text", async () => {
		mswServer.use(http.post(CHAT_COMPLETIONS_URL, () => new HttpResponse("not json sk-secret", { status: 200 })));

		const result = await client().completeChatOnce(
			connection(),
			{ model: "gpt-test", messages: [{ role: "user", content: "hi" }] },
			callOptions()
		);

		assert.strictEqual(result, "");
	});

	test("a 401 invalidates exactly the sent OAuth token: the next call performs a fresh exchange", async () => {
		let exchanges = 0;
		let chatCalls = 0;
		mswServer.use(
			http.post(TOKEN_URL, () => {
				exchanges += 1;
				return HttpResponse.json({ access_token: `tok-${exchanges}`, expires_in: 3600 });
			}),
			http.post(CHAT_COMPLETIONS_URL, ({ request }) => {
				chatCalls += 1;
				if (chatCalls === 1) {
					return HttpResponse.json({ error: { message: "Invalid key" } }, { status: 401 });
				}
				return chatJson(`answered with ${request.headers.get("authorization")}`);
			})
		);

		const oneShot = client();
		const oauth = { tokenUrl: TOKEN_URL, clientId: "client-1", clientSecret: "secret-1" };
		const conn = connection({ apiKey: "", oauth });
		const request = { model: "gpt-test", messages: [{ role: "user" as const, content: "hi" }] };

		const error = await expectRequestError(oneShot.completeChatOnce(conn, request, callOptions()), "auth");
		assert.strictEqual(error.status, 401);
		assert.strictEqual(exchanges, 1);

		// The rejected token is gone, so the second call exchanges anew.
		const second = await oneShot.completeChatOnce(conn, request, callOptions());
		assert.strictEqual(exchanges, 2);
		assert.strictEqual(second, "answered with Bearer tok-2");

		// And a token the server accepted stays cached: no third exchange.
		await oneShot.completeChatOnce(conn, request, callOptions());
		assert.strictEqual(exchanges, 2, "an accepted token must be served from cache, not re-exchanged");
	});

	test("the body's error envelope drives classification, exactly like the streaming chat path", async () => {
		// Pins the APIError.generate bridging: generate extracts the body's
		// `error` field itself, so it must be handed the TOP-LEVEL parsed body -
		// passing the inner envelope loses every envelope-driven classification.
		mswServer.use(
			http.post(CHAT_COMPLETIONS_URL, () =>
				HttpResponse.json(
					{ error: { type: "budget_exceeded", message: "Budget has been exceeded for this key" } },
					{ status: 429 }
				)
			)
		);
		const budget = await expectRequestError(
			client().completeChatOnce(
				connection(),
				{ model: "gpt-test", messages: [{ role: "user", content: "hi" }] },
				callOptions()
			),
			"http"
		);
		assert.match(budget.message, /budget is used up/);
		assert.strictEqual(budget.logClassification, "RequestError(http, status 429, budget_exceeded)");

		// The upstream-auth split reads the same envelope: a proxy-wrapped
		// upstream failure must not blame the extension's key.
		mswServer.use(
			http.post(CHAT_COMPLETIONS_URL, () =>
				HttpResponse.json({ error: { message: "litellm.AuthenticationError: bad upstream key" } }, { status: 401 })
			)
		);
		const upstream = await expectRequestError(
			client().completeChatOnce(
				connection(),
				{ model: "gpt-test", messages: [{ role: "user", content: "hi" }] },
				callOptions()
			),
			"auth"
		);
		assert.match(upstream.message, /upstream/);

		// The likeliest failure for a feature that ships 80000 characters of
		// diff: a 400 context-window rejection must render the commit surface's
		// own headline - there is no conversation to trim and no new chat to
		// start.
		mswServer.use(
			http.post(CHAT_COMPLETIONS_URL, () =>
				HttpResponse.json(
					{ error: { message: "This model's maximum context length is 8192 tokens, however you requested 90000" } },
					{ status: 400 }
				)
			)
		);
		const contextWindow = await expectRequestError(
			client().completeChatOnce(
				connection(),
				{ model: "gpt-test", messages: [{ role: "user", content: "hi" }] },
				callOptions()
			),
			"http"
		);
		assert.match(contextWindow.message, /changes are too large for this model/);
		assert.ok(!contextWindow.message.includes("new chat"), "no chat-flavored advice on a commit call");
		assert.strictEqual(contextWindow.logClassification, "RequestError(http, status 400, context_window_exceeded)");
		assert.strictEqual(contextWindow.englishMessage, contextWindow.message);
	});

	test("a 404 gets the commit surface's own advice, never the chat path's Sync Models hint", async () => {
		// Sync Models refreshes the chat catalog; the commit model setting never
		// reads it, so the chat advice would misdirect.
		mswServer.use(
			http.post(CHAT_COMPLETIONS_URL, () =>
				HttpResponse.json({ error: { message: "model not found", type: "invalid_request_error" } }, { status: 404 })
			)
		);

		const error = await expectRequestError(
			client().completeChatOnce(
				connection(),
				{ model: "gone-model", messages: [{ role: "user", content: "hi" }] },
				callOptions()
			),
			"http"
		);

		assert.strictEqual(error.status, 404);
		assert.match(error.message, /commit message model/);
		assert.ok(!error.message.includes("Sync Models"), "Sync Models does not touch the commit model setting");
		assert.strictEqual(error.logClassification, "RequestError(http, status 404, commitGeneration)");
		assert.strictEqual(error.englishMessage, error.message);
	});

	test("a header-illegal virtual-key value is dropped fail-closed, never handed to fetch", async () => {
		// The platform's Headers would throw a TypeError embedding the plaintext
		// value; the overlay drops the header instead, so the request still goes
		// out (and fails honestly server-side if the key was required).
		let seenVirtual: string | null = "unset";
		mswServer.use(
			http.post(CHAT_COMPLETIONS_URL, ({ request }) => {
				seenVirtual = request.headers.get("x-litellm-key");
				return chatJson("ok");
			})
		);

		const result = await client().completeChatOnce(
			connection({ virtualKey: { header: "x-litellm-key", value: "bad\nvalue" } }),
			{ model: "gpt-test", messages: [{ role: "user", content: "hi" }] },
			callOptions()
		);

		assert.strictEqual(result, "ok", "the request must not die in a header TypeError");
		assert.strictEqual(seenVirtual, null, "the invalid value must never reach the wire");
	});

	test("a straggling 401 keyed to an old token never discards the token that replaced it", async () => {
		let exchanges = 0;
		mswServer.use(
			http.post(TOKEN_URL, () => {
				exchanges += 1;
				// tok-1 is born already due for refresh, so the next call performs
				// its own exchange instead of reusing it.
				return HttpResponse.json({ access_token: `tok-${exchanges}`, expires_in: exchanges === 1 ? 0 : 3600 });
			}),
			http.post(CHAT_COMPLETIONS_URL, async ({ request }) => {
				if (request.headers.get("authorization") === "Bearer tok-1") {
					// The straggler: rejected only after tok-2 has entered the cache.
					await new Promise((resolve) => setTimeout(resolve, 250));
					return HttpResponse.json({ error: { message: "Invalid key" } }, { status: 401 });
				}
				return chatJson(`answered with ${request.headers.get("authorization")}`);
			})
		);

		const oneShot = client();
		const conn = connection({
			apiKey: "",
			oauth: { tokenUrl: TOKEN_URL, clientId: "client-1", clientSecret: "secret-1" },
		});
		const request = { model: "gpt-test", messages: [{ role: "user" as const, content: "hi" }] };

		const straggler = oneShot.completeChatOnce(conn, request, callOptions());
		straggler.catch(() => {}); // settled below; the handler keeps it pending meanwhile
		await new Promise((resolve) => setTimeout(resolve, 100));
		const fresh = await oneShot.completeChatOnce(conn, request, callOptions());
		assert.strictEqual(fresh, "answered with Bearer tok-2");
		assert.strictEqual(exchanges, 2);

		await expectRequestError(straggler, "auth");

		// Keyed invalidation: the straggler's 401 named tok-1, so tok-2 survives
		// and the next call is served from cache. An unconditional invalidation
		// would exchange a third token here.
		const after = await oneShot.completeChatOnce(conn, request, callOptions());
		assert.strictEqual(after, "answered with Bearer tok-2");
		assert.strictEqual(exchanges, 2, "a straggling 401 must not discard the token that already replaced it");
	});

	test("a virtual key naming Authorization owns it: no exchange, no bearer, any casing", async () => {
		let exchanges = 0;
		let seenAuthorization: string | null = null;
		mswServer.use(
			http.post(TOKEN_URL, () => {
				exchanges += 1;
				return HttpResponse.json({ access_token: "tok-never", expires_in: 3600 });
			}),
			http.post(CHAT_COMPLETIONS_URL, ({ request }) => {
				seenAuthorization = request.headers.get("authorization");
				return chatJson("ok");
			})
		);

		await client().completeChatOnce(
			connection({
				oauth: { tokenUrl: TOKEN_URL, clientId: "client-1", clientSecret: "secret-1" },
				virtualKey: { header: "authorization", value: "vk-value" },
			}),
			{ model: "gpt-test", messages: [{ role: "user", content: "hi" }] },
			callOptions()
		);

		assert.strictEqual(exchanges, 0, "an unreachable IdP must not fail a request that would not carry the token");
		assert.strictEqual(seenAuthorization, "vk-value", "the virtual key must own Authorization outright");
	});

	test("a 5xx maps as a classified http error and is never retried", async () => {
		let attempts = 0;
		mswServer.use(
			http.post(CHAT_COMPLETIONS_URL, () => {
				attempts += 1;
				return emptyErrorResponse(500);
			})
		);

		const error = await expectRequestError(
			client().completeChatOnce(
				connection(),
				{ model: "gpt-test", messages: [{ role: "user", content: "hi" }] },
				callOptions()
			),
			"http"
		);

		assert.strictEqual(error.status, 500);
		assert.strictEqual(attempts, 1, "chat completions never retry");
		assert.strictEqual(error.englishMessage, error.message, "the English mirror must match the English display");
	});

	test("the timeout is a hard whole-call bound naming the commit call and its chat.timeout budget", async () => {
		mswServer.use(
			http.post(CHAT_COMPLETIONS_URL, async () => {
				await new Promise((resolve) => setTimeout(resolve, 500));
				return chatJson("too late");
			})
		);

		const error = await expectRequestError(
			client().completeChatOnce(
				connection(),
				{ model: "gpt-test", messages: [{ role: "user", content: "hi" }] },
				callOptions(50)
			),
			"timeout"
		);

		assert.match(error.message, /commit message generation timed out after 50ms/);
		// chat.timeout IS this call's bound, so unlike the FIM surface the
		// advice names the setting to raise.
		assert.match(error.message, /chat\.timeout/);
		assert.strictEqual(error.englishMessage, error.message);
	});

	test("cancellation aborts the in-flight request and surfaces as CancellationError", async () => {
		mswServer.use(
			http.post(CHAT_COMPLETIONS_URL, async () => {
				await new Promise((resolve) => setTimeout(resolve, 500));
				return chatJson("too late");
			})
		);

		const cts = new vscode.CancellationTokenSource();
		const pending = client().completeChatOnce(
			connection(),
			{ model: "gpt-test", messages: [{ role: "user", content: "hi" }] },
			{ timeoutMs: 5000, token: cts.token }
		);
		setTimeout(() => cts.cancel(), 20);

		await assert.rejects(pending, (err: unknown) => {
			assert.ok(err instanceof vscode.CancellationError, `expected CancellationError, got ${String(err)}`);
			return true;
		});
	});

	suite("completeFim", () => {
		test("sends exactly model/prompt/suffix/max_tokens/stream:false and returns the completion text", async () => {
			let seenBody: Record<string, unknown> | undefined;
			mswServer.use(
				http.post(COMPLETIONS_URL, async ({ request }) => {
					seenBody = (await request.json()) as Record<string, unknown>;
					return completionJsonResponse("d(a, b) {");
				})
			);

			const result = await client().completeFim(
				connection(),
				{ model: "codestral-fim", prompt: "function ad", suffix: "\n}", maxTokens: 256 },
				callOptions()
			);

			assert.strictEqual(result, "d(a, b) {");
			assert.ok(seenBody, "the request must carry a JSON body");
			// The exact key set IS the zero-injection guard: no parameters record
			// field, no temperature, nothing beyond the five provider-owned keys.
			assert.deepStrictEqual(Object.keys(seenBody).sort(), ["max_tokens", "model", "prompt", "stream", "suffix"]);
			assert.strictEqual(seenBody.model, "codestral-fim");
			assert.strictEqual(seenBody.prompt, "function ad");
			assert.strictEqual(seenBody.suffix, "\n}");
			assert.strictEqual(seenBody.max_tokens, 256);
			assert.strictEqual(seenBody.stream, false);
		});

		test("a template-owned prompt omits the wire suffix key entirely", async () => {
			let seenBody: Record<string, unknown> | undefined;
			mswServer.use(
				http.post(COMPLETIONS_URL, async ({ request }) => {
					seenBody = (await request.json()) as Record<string, unknown>;
					return completionJsonResponse("filled");
				})
			);

			await client().completeFim(
				connection(),
				{ model: "codestral-fim", prompt: "<fim_prefix>a<fim_suffix>b<fim_middle>", maxTokens: 256 },
				callOptions()
			);

			assert.ok(seenBody);
			assert.deepStrictEqual(Object.keys(seenBody).sort(), ["max_tokens", "model", "prompt", "stream"]);
		});

		test("a malformed 200 body reads as undefined, never as an error or quoted text", async () => {
			for (const body of ["not json", JSON.stringify({ choices: [] }), JSON.stringify({ error: "secret" })]) {
				mswServer.use(http.post(COMPLETIONS_URL, () => new HttpResponse(body, { status: 200 }), { once: true }));
				const result = await client().completeFim(
					connection(),
					{ model: "codestral-fim", prompt: "p", suffix: "s", maxTokens: 256 },
					callOptions()
				);
				assert.strictEqual(result, undefined);
			}
		});

		test("the completion surface's timeout text names no setting", async () => {
			mswServer.use(
				http.post(COMPLETIONS_URL, async () => {
					await new Promise((resolve) => setTimeout(resolve, 500));
					return completionJsonResponse("late");
				})
			);

			const error = await expectRequestError(
				client().completeFim(
					connection(),
					{ model: "codestral-fim", prompt: "p", suffix: "s", maxTokens: 256 },
					callOptions(50)
				),
				"timeout"
			);

			assert.match(error.message, /inline completion request timed out after 50ms/);
			assert.ok(!error.message.includes("setting"), "the FIM bound is fixed in code; no setting to raise");
			assert.strictEqual(error.englishMessage, error.message);
		});

		test("a 5xx maps as a classified http error and is never retried", async () => {
			let attempts = 0;
			mswServer.use(
				http.post(COMPLETIONS_URL, () => {
					attempts += 1;
					return emptyErrorResponse(503);
				})
			);

			const error = await expectRequestError(
				client().completeFim(
					connection(),
					{ model: "codestral-fim", prompt: "p", suffix: "s", maxTokens: 256 },
					callOptions()
				),
				"http"
			);

			assert.strictEqual(error.status, 503);
			assert.strictEqual(attempts, 1, "completions never retry");
		});

		test("a 404 gets the completion surface's own advice, never the chat path's Sync Models hint", async () => {
			mswServer.use(
				http.post(COMPLETIONS_URL, () =>
					HttpResponse.json({ error: { message: "model not found", type: "invalid_request_error" } }, { status: 404 })
				)
			);

			const error = await expectRequestError(
				client().completeFim(
					connection(),
					{ model: "gone-fim", prompt: "p", suffix: "s", maxTokens: 256 },
					callOptions()
				),
				"http"
			);

			assert.strictEqual(error.status, 404);
			assert.match(error.message, /text-completion model/);
			assert.ok(!error.message.includes("Sync Models"), "Sync Models cannot discover completion-mode models");
			assert.strictEqual(error.logClassification, "RequestError(http, status 404, completion)");
		});

		test("a context-window 400 gets the completion surface's own headline, never chat's new-chat advice", async () => {
			mswServer.use(
				http.post(COMPLETIONS_URL, () =>
					HttpResponse.json(
						{ error: { message: "maximum context length exceeded", type: "context_window_exceeded" } },
						{ status: 400 }
					)
				)
			);

			const error = await expectRequestError(
				client().completeFim(
					connection(),
					{ model: "codestral-fim", prompt: "p", suffix: "s", maxTokens: 256 },
					callOptions()
				),
				"http"
			);

			assert.strictEqual(error.status, 400);
			assert.match(error.message, /code context around the cursor is too long/);
			assert.ok(!error.message.includes("new chat"), "no chat-flavored advice on a FIM call");
			assert.strictEqual(error.englishMessage?.split("\n")[0], error.message.split("\n")[0]);
		});
	});
});
