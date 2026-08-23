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
import { withFetch } from "../../pureHelpers";

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
		const result = await client().completeChatOnce(
			connection(),
			{ model: "gpt-test", messages },
			"commitGeneration",
			callOptions()
		);

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
			"commitGeneration",
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
			"commitGeneration",
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

		const error = await expectRequestError(
			oneShot.completeChatOnce(conn, request, "commitGeneration", callOptions()),
			"auth"
		);
		assert.strictEqual(error.status, 401);
		assert.strictEqual(exchanges, 1);

		// The rejected token is gone, so the second call exchanges anew.
		const second = await oneShot.completeChatOnce(conn, request, "commitGeneration", callOptions());
		assert.strictEqual(exchanges, 2);
		assert.strictEqual(second, "answered with Bearer tok-2");

		// And a token the server accepted stays cached: no third exchange.
		await oneShot.completeChatOnce(conn, request, "commitGeneration", callOptions());
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
				"commitGeneration",
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
				"commitGeneration",
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
				"commitGeneration",
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
				"commitGeneration",
				callOptions()
			),
			"http"
		);

		assert.strictEqual(error.status, 404);
		assert.match(error.message, /commit message model/);
		assert.ok(!error.message.includes("Sync Models"), "Sync Models does not touch the commit model setting");
		// The commit boundary shows this in a VS Code notification, which
		// flattens newlines: the two-part join must carry the Details lead-in.
		assert.match(error.message, /\n\nDetails: LiteLLM 404/);
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
			"commitGeneration",
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

		const straggler = oneShot.completeChatOnce(conn, request, "commitGeneration", callOptions());
		straggler.catch(() => {}); // settled below; the handler keeps it pending meanwhile
		await new Promise((resolve) => setTimeout(resolve, 100));
		const fresh = await oneShot.completeChatOnce(conn, request, "commitGeneration", callOptions());
		assert.strictEqual(fresh, "answered with Bearer tok-2");
		assert.strictEqual(exchanges, 2);

		await expectRequestError(straggler, "auth");

		// Keyed invalidation: the straggler's 401 named tok-1, so tok-2 survives
		// and the next call is served from cache. An unconditional invalidation
		// would exchange a third token here.
		const after = await oneShot.completeChatOnce(conn, request, "commitGeneration", callOptions());
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
			"commitGeneration",
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
				"commitGeneration",
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
				"commitGeneration",
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
			"commitGeneration",
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

	test("the surface parameter is caller-owned: the same 404 renders the caller's surface copy", async () => {
		// completeChatOnce serves several features, each under its own error
		// surface; the transport must not hardcode any one of them.
		mswServer.use(
			http.post(CHAT_COMPLETIONS_URL, () =>
				HttpResponse.json({ error: { message: "model not found", type: "invalid_request_error" } }, { status: 404 })
			)
		);

		const error = await expectRequestError(
			client().completeChatOnce(
				connection(),
				{ model: "gone-model", messages: [{ role: "user", content: "hi" }] },
				"chat",
				callOptions()
			),
			"http"
		);

		assert.match(error.message, /Sync Models/, "the chat surface keeps the chat catalog advice");
		assert.strictEqual(error.logClassification, "RequestError(http, status 404, chat)");
	});

	suite("sendJson (the shared Response core)", () => {
		test("returns the raw 2xx Response with its body unread", async () => {
			let seenContentType: string | null = null;
			mswServer.use(
				http.post(CHAT_COMPLETIONS_URL, ({ request }) => {
					seenContentType = request.headers.get("content-type");
					return new HttpResponse("raw payload, not parsed here", { status: 201 });
				})
			);

			const response = await client().sendJson(
				CHAT_COMPLETIONS_URL,
				JSON.stringify({ ping: true }),
				connection(),
				"commitGeneration",
				callOptions()
			);

			assert.strictEqual(response.status, 201);
			assert.strictEqual(seenContentType, "application/json");
			assert.strictEqual(await response.text(), "raw payload, not parsed here", "the body reaches the caller unread");
		});

		test("a non-2xx never returns: the error body is read and mapped through the shared pipeline", async () => {
			mswServer.use(
				http.post(CHAT_COMPLETIONS_URL, () =>
					HttpResponse.json(
						{ error: { message: "Budget has been exceeded for this key", type: "budget_exceeded" } },
						{ status: 429 }
					)
				)
			);

			const error = await expectRequestError(
				client().sendJson(
					CHAT_COMPLETIONS_URL,
					JSON.stringify({ ping: true }),
					connection(),
					"commitGeneration",
					callOptions()
				),
				"http"
			);

			assert.strictEqual(error.status, 429);
			assert.match(error.message, /budget is used up/);
			assert.strictEqual(error.logClassification, "RequestError(http, status 429, budget_exceeded)");
		});
	});

	suite("completeChatStream", () => {
		const sseBody = 'data: {"choices":[{"delta":{"content":"streamed"}}]}\n\ndata: [DONE]\n\n';

		test("sends exactly model/messages/stream:true and returns the raw SSE body", async () => {
			let seenBody: Record<string, unknown> | undefined;
			mswServer.use(
				http.post(CHAT_COMPLETIONS_URL, async ({ request }) => {
					seenBody = (await request.json()) as Record<string, unknown>;
					return new HttpResponse(sseBody, { status: 200, headers: { "Content-Type": "text/event-stream" } });
				})
			);

			const stream = await client().completeChatStream(
				connection(),
				{ model: "gpt-test", messages: [{ role: "user", content: "hi" }] },
				"chat",
				callOptions()
			);

			assert.ok(seenBody, "the request must carry a JSON body");
			// The body key set is the whole contract: nothing injected beyond the
			// provider-owned fields, and max_tokens absent when the caller set none.
			assert.deepStrictEqual(Object.keys(seenBody).sort(), ["messages", "model", "stream"]);
			assert.strictEqual(seenBody.stream, true);
			// The raw bytes reach the caller unframed; sseFrames + StreamProcessor
			// own everything downstream of here.
			assert.strictEqual(await new Response(stream).text(), sseBody);
		});

		test("max_tokens rides the streaming body only when the caller sets it", async () => {
			let seenBody: Record<string, unknown> | undefined;
			mswServer.use(
				http.post(CHAT_COMPLETIONS_URL, async ({ request }) => {
					seenBody = (await request.json()) as Record<string, unknown>;
					return new HttpResponse(sseBody, { status: 200, headers: { "Content-Type": "text/event-stream" } });
				})
			);

			await client().completeChatStream(
				connection(),
				{ model: "gpt-test", messages: [{ role: "user", content: "hi" }], maxTokens: 128 },
				"chat",
				callOptions()
			);

			assert.ok(seenBody);
			assert.deepStrictEqual(Object.keys(seenBody).sort(), ["max_tokens", "messages", "model", "stream"]);
			assert.strictEqual(seenBody.max_tokens, 128);
		});

		test("an HTTP error before any stream maps through the shared pipeline under the caller's surface", async () => {
			mswServer.use(
				http.post(CHAT_COMPLETIONS_URL, () =>
					HttpResponse.json(
						{ error: { message: "maximum context length exceeded", type: "context_window_exceeded" } },
						{ status: 400 }
					)
				)
			);

			const error = await expectRequestError(
				client().completeChatStream(
					connection(),
					{ model: "gpt-test", messages: [{ role: "user", content: "hi" }] },
					"chat",
					callOptions()
				),
				"http"
			);

			assert.strictEqual(error.status, 400);
			assert.match(error.message, /conversation is too long for this model/);
			assert.strictEqual(error.logClassification, "RequestError(http, status 400, context_window_exceeded)");
		});

		test("user cancellation keeps aborting the in-flight request after the headers arrived", async () => {
			// msw does not tie a mocked body stream to the request's AbortSignal,
			// so this observes the signal itself through the withFetch escape
			// hatch (tying the stub body to it like undici does): the outliving
			// cancellation bridge (armed for the stream's lifetime, after
			// postJson's own call-scoped bridge was disposed) must abort the
			// wired signal, and the reader must see the classified cancellation.
			let wiredSignal: AbortSignal | undefined;
			const cts = new vscode.CancellationTokenSource();
			await withFetch(
				async (_url, init) => {
					const signal = init?.signal ?? undefined;
					wiredSignal = signal;
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'));
								// Never closed: only the abort can end this stream.
								signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
							},
						}),
						{ status: 200, headers: { "Content-Type": "text/event-stream" } }
					);
				},
				async () => {
					const stream = await client().completeChatStream(
						connection(),
						{ model: "gpt-test", messages: [{ role: "user", content: "hi" }] },
						"chat",
						{ timeoutMs: 5000, token: cts.token }
					);
					const reader = stream.getReader();
					const first = await reader.read();
					assert.strictEqual(first.done, false, "the first chunk streams before cancellation");
					assert.ok(wiredSignal, "fetch must be armed with the combined signal");
					assert.strictEqual(wiredSignal.aborted, false, "nothing has aborted yet");
					cts.cancel();
					await assert.rejects(reader.read(), (err: unknown) => {
						assert.ok(err instanceof vscode.CancellationError, `expected CancellationError, got ${String(err)}`);
						return true;
					});
					assert.strictEqual(wiredSignal.aborted, true, "cancellation must reach the in-flight request");
				}
			);
		});

		test("a post-header timeout reaches the reader as the classified timeout error", async () => {
			// The stub ties its body to the wired signal like undici does; the
			// returned stream's mapping is what must turn the abort into the
			// surface's classified timeout error at the reader.
			await withFetch(
				async (_url, init) => {
					const signal = init?.signal ?? undefined;
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								// Never emits: only the whole-call timeout ends it.
								signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
							},
						}),
						{ status: 200, headers: { "Content-Type": "text/event-stream" } }
					);
				},
				async () => {
					const stream = await client().completeChatStream(
						connection(),
						{ model: "gpt-test", messages: [{ role: "user", content: "hi" }] },
						"chat",
						callOptions(50)
					);
					const reader = stream.getReader();
					await assert.rejects(reader.read(), (err: unknown) => {
						assert.ok(err instanceof RequestError, `expected RequestError, got ${String(err)}`);
						assert.strictEqual(err.kind, "timeout");
						assert.match(err.message, /LiteLLM request timed out after 50ms/);
						return true;
					});
				}
			);
		});

		test("the whole-call timeout stays armed on the returned stream", async () => {
			// The signal must fire at the hard bound even though completeChatStream
			// resolved long before - the stream's reclamation is the timeout's job.
			let wiredSignal: AbortSignal | undefined;
			await withFetch(
				async (_url, init) => {
					wiredSignal = init?.signal ?? undefined;
					return new Response(
						new ReadableStream<Uint8Array>({
							start() {
								// Never emits and never closes: only the timeout ends it.
							},
						}),
						{ status: 200, headers: { "Content-Type": "text/event-stream" } }
					);
				},
				async () => {
					await client().completeChatStream(
						connection(),
						{ model: "gpt-test", messages: [{ role: "user", content: "hi" }] },
						"chat",
						callOptions(50)
					);
					assert.ok(wiredSignal, "fetch must be armed with the combined signal");
					const aborted = new Promise<void>((resolve) =>
						wiredSignal?.addEventListener("abort", () => resolve(), { once: true })
					);
					await aborted;
					assert.strictEqual(wiredSignal.aborted, true, "the timeout must fire after the call returned");
					assert.strictEqual((wiredSignal.reason as Error).name, "TimeoutError", "the abort must be the timeout's");
				}
			);
		});

		test("a bodyless 200 throws the shared classified error instead of returning null", async () => {
			await withFetch(
				async () => new Response(null, { status: 200 }),
				async () => {
					await assert.rejects(
						client().completeChatStream(
							connection(),
							{ model: "gpt-test", messages: [{ role: "user", content: "hi" }] },
							"chat",
							callOptions()
						),
						(err: unknown) => {
							assert.ok(err instanceof Error, `expected an Error, got ${String(err)}`);
							// The chat transport's exact bodyless-200 message (one shared
							// constructor), joined chat-style for this surface.
							assert.strictEqual(
								err.message,
								"The server accepted the request but sent nothing back. Try again; if it keeps happening, check any proxy or gateway between VS Code and the LiteLLM server.\n\nDetails: LiteLLM answered 200 with a missing response body (http://litellm.test)"
							);
							assert.strictEqual((err as Error & { englishMessage?: string }).englishMessage, err.message);
							return true;
						}
					);
				}
			);
		});
	});
	suite("authHeaders", () => {
		test("composes what a request would carry, without making one", async () => {
			// No msw handler is registered for the server: any request would fail
			// the suite through onUnhandledRequest: "error".
			const headers = await client().authHeaders(
				connection({ headers: { "x-routing-env": "prod" }, virtualKey: { header: "x-litellm-key", value: "vk-1" } }),
				"discovery",
				callOptions()
			);
			assert.strictEqual(headers.Authorization, "Bearer sk-test");
			assert.strictEqual(headers["X-API-Key"], "sk-test");
			assert.strictEqual(headers["x-litellm-key"], "vk-1");
			assert.strictEqual(headers["x-routing-env"], "prod");
			// No body goes out, so no Content-Type is invented for one.
			assert.strictEqual(headers["Content-Type"], undefined);
		});

		test("a token-exchange timeout keeps the OAuth-specific message, not the surface's request wording", async () => {
			// The call has no whole-call bound of its own precisely so the
			// exchange's own bound wins: a second timer sharing the budget would
			// race it and re-attribute the failure to "model discovery timed out".
			mswServer.use(http.post(TOKEN_URL, () => new Promise<Response>(() => {})));
			const error = await expectRequestError(
				client().authHeaders(
					connection({ oauth: { tokenUrl: TOKEN_URL, clientId: "c", clientSecret: "s" } }),
					"discovery",
					callOptions(60)
				),
				"timeout"
			);
			assert.ok(error.message.startsWith("OAuth token request to"), error.message);
		});

		test("cancellation surfaces as a CancellationError", async () => {
			mswServer.use(http.post(TOKEN_URL, () => new Promise<Response>(() => {})));
			const source = new vscode.CancellationTokenSource();
			const pending = client().authHeaders(
				connection({ oauth: { tokenUrl: TOKEN_URL, clientId: "c", clientSecret: "s" } }),
				"discovery",
				{ timeoutMs: 5000, token: source.token }
			);
			source.cancel();
			await assert.rejects(() => pending, vscode.CancellationError);
		});
	});

	suite("header precedence", () => {
		test("a virtual key named Content-Type still owns that header, as it always has", async () => {
			// The overlay runs AFTER the body's Content-Type is set, so what a
			// credential displaces stays the overlay's decision. Nonsensical
			// placement, but changing it is not the transport refactor's call.
			let seen: string | null = null;
			mswServer.use(
				http.post(CHAT_COMPLETIONS_URL, ({ request }) => {
					seen = request.headers.get("content-type");
					return chatJson("ok");
				})
			);
			await client().completeChatOnce(
				connection({ virtualKey: { header: "Content-Type", value: "application/vnd.litellm" } }),
				{ model: "m", messages: [{ role: "user", content: "hi" }] },
				"chat",
				callOptions()
			);
			assert.strictEqual(seen, "application/vnd.litellm");
		});
	});
});
