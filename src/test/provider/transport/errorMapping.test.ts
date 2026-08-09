import * as assert from "node:assert";
import {
	APIConnectionError,
	APIConnectionTimeoutError,
	APIError,
	APIUserAbortError,
	AuthenticationError,
} from "openai";
import { CancellationError, LanguageModelError } from "vscode";
import {
	localizedError,
	type MapErrorContext,
	mapSdkError,
	RequestError,
	statusErrorTexts,
	streamErrorFrame,
	timeoutMessage,
	timeoutRequestError,
	toLanguageModelError,
} from "../../../provider/transport/errorMapping";
import { assertShows, assertStartsWith } from "../../testUtils";

const chatCtx: MapErrorContext = { surface: "chat", baseUrl: "http://litellm.test", timeoutMs: 5000 };
const discoveryCtx: MapErrorContext = { surface: "discovery", baseUrl: "http://litellm.test", timeoutMs: 5000 };

/**
 * Build the cause chain the SDK produces for transport failures: the SDK's
 * "Connection error." wrapper around undici's TypeError "fetch failed", which
 * carries the actionable socket/TLS/timeout error as its own cause.
 */
function connectionError(deepest: unknown): APIConnectionError {
	return new APIConnectionError({
		cause: Object.assign(new TypeError("fetch failed"), { cause: deepest }),
	});
}

function expectRequestError(mapped: Error, kind: RequestError["kind"]): RequestError {
	assert.ok(mapped instanceof RequestError, `Expected RequestError, got ${mapped.name}: ${mapped.message}`);
	assert.strictEqual(mapped.kind, kind);
	return mapped;
}

suite("provider/transport/errorMapping", () => {
	suite("HTTP status errors", () => {
		test("401 maps to the authentication message on both surfaces", () => {
			const err = new AuthenticationError(401, { message: "Invalid API key" }, undefined, new Headers());
			for (const ctx of [chatCtx, discoveryCtx]) {
				const mapped = expectRequestError(mapSdkError(err, ctx), "auth");
				assert.strictEqual(mapped.status, 401);
				assert.ok(
					mapped.message.startsWith("Authentication failed: Your LiteLLM server requires an API key."),
					mapped.message
				);
				assert.strictEqual(mapped.cause, err);
				// The proxy's own gate rejected this client's key, so the
				// configure-the-key advice is certain.
				assert.strictEqual(mapped.setupHint, "configure-api-key");
			}
		});

		test("401 wrapping an upstream provider failure blames the server's provider credentials, not the extension key", () => {
			// The exact envelope a LiteLLM proxy returns when the caller's key was
			// accepted but the proxy could not authenticate to the upstream
			// provider (e.g. a catalog model whose provider key is unset).
			const err = new AuthenticationError(
				401,
				{
					message:
						'litellm.AuthenticationError: AnthropicException - {"type":"error","error":{"type":"authentication_error","message":"x-api-key header is required"}}. Received Model Group=anthropic/claude-x\nAvailable Model Group Fallbacks=None',
					type: null,
					param: null,
					code: "401",
				},
				undefined,
				new Headers()
			);
			for (const ctx of [chatCtx, discoveryCtx]) {
				const mapped = expectRequestError(mapSdkError(err, ctx), "auth");
				assert.strictEqual(mapped.status, 401);
				assert.ok(mapped.message.startsWith("Authentication failed upstream:"), mapped.message);
				assert.ok(
					!mapped.message.includes("Manage LiteLLM Provider"),
					"must not send the user to reconfigure the extension key"
				);
				assert.ok(!mapped.message.includes("Anthropic"), "response-derived text must not be echoed");
				assert.strictEqual(
					mapped.setupHint,
					undefined,
					"updating the extension's key cannot fix the proxy's upstream credentials, so no hint"
				);
			}
		});

		test("a genuine proxy-auth 401 envelope keeps the extension-key message", () => {
			const err = new AuthenticationError(
				401,
				{ message: "Authentication Error, No api key passed in.", type: "auth_error", param: "None", code: "401" },
				undefined,
				new Headers()
			);
			const mapped = expectRequestError(mapSdkError(err, chatCtx), "auth");
			assert.ok(
				mapped.message.startsWith("Authentication failed: Your LiteLLM server requires an API key."),
				mapped.message
			);
		});

		test("a litellm exception name quoted inside the proxy's auth_error envelope stays proxy-auth", () => {
			// The envelope type is the proxy gate's own signature and outranks the
			// message text; a body that merely mentions litellm.AuthenticationError
			// is still the proxy rejecting this client's key.
			const err = new AuthenticationError(
				401,
				{
					message: "Authentication Error - key rejected before litellm.AuthenticationError could be raised upstream",
					type: "auth_error",
					param: "None",
					code: "401",
				},
				undefined,
				new Headers()
			);
			const mapped = expectRequestError(mapSdkError(err, chatCtx), "auth");
			assert.ok(
				mapped.message.startsWith("Authentication failed: Your LiteLLM server requires an API key."),
				mapped.message
			);
		});

		test("a module-qualified litellm exception name still classifies as an upstream failure", () => {
			const err = new AuthenticationError(
				401,
				{
					message: "litellm.exceptions.AuthenticationError: BedrockException - unable to authenticate to AWS",
					type: null,
					param: null,
					code: "401",
				},
				undefined,
				new Headers()
			);
			const mapped = expectRequestError(mapSdkError(err, chatCtx), "auth");
			assert.ok(mapped.message.startsWith("Authentication failed upstream:"), mapped.message);
		});

		test("400 with a JSON error body renders a headline plus a compact LiteLLM detail line per surface", () => {
			const err = APIError.generate(
				400,
				{ error: { message: "unsupported parameter: frobnicate", type: "invalid_request_error" } },
				undefined,
				new Headers()
			);
			// generate() unwraps the response's `error` envelope onto err.error.
			assert.deepStrictEqual(err.error, {
				message: "unsupported parameter: frobnicate",
				type: "invalid_request_error",
			});

			const detail = "LiteLLM 400 invalid_request_error: unsupported parameter: frobnicate";
			const chat = expectRequestError(mapSdkError(err, chatCtx), "http");
			assert.strictEqual(chat.message, `The server rejected this request as invalid.\n\nDetails: ${detail}`);
			assert.strictEqual(chat.status, 400);
			const discovery = expectRequestError(mapSdkError(err, discoveryCtx), "http");
			assert.strictEqual(discovery.message, `The server refused the model-list request.\n${detail}`);
			assert.strictEqual(discovery.status, 400);
			assert.ok(!chat.message.includes('{"error"'), "the JSON envelope is never re-serialized into the message");
		});

		test("a blown budget gets the budget headline and the classifier's own token on the classification", () => {
			const err = APIError.generate(
				429,
				{
					error: {
						message: "Budget has been exceeded! Current cost: 0.40, Max budget: 0.37",
						type: "budget_exceeded",
						code: "429",
					},
				},
				undefined,
				new Headers()
			);
			const chat = expectRequestError(mapSdkError(err, chatCtx), "http");
			assert.strictEqual(chat.status, 429, "Blocked mapping keys off status 429; it must survive");
			assert.ok(
				chat.message.startsWith(
					"This key's budget is used up - requests will fail until the budget resets or an admin raises it."
				),
				chat.message
			);
			// The code is just the stringified status, so the detail carries only
			// the type - never "LiteLLM 429 429". The chat surface separates the
			// detail with the "Details:" lead-in (Copilot Chat flattens newlines).
			assert.ok(
				chat.message.endsWith(
					"\n\nDetails: LiteLLM 429 budget_exceeded: Budget has been exceeded! Current cost: 0.40, Max budget: 0.37"
				),
				chat.message
			);
			// The token is the classifier's own closed-set decision, never echoed
			// body text (the isUpstreamAuthFailure precedent).
			assert.strictEqual(chat.logClassification, "RequestError(http, status 429, budget_exceeded)");
			assert.strictEqual(chat.englishMessage, chat.message);

			const discovery = expectRequestError(mapSdkError(err, discoveryCtx), "http");
			assert.ok(
				discovery.message.startsWith("This key's budget is used up - the server refused to refresh the model list."),
				discovery.message
			);
			assert.strictEqual(discovery.logClassification, "RequestError(http, status 429, budget_exceeded)");
		});

		test("a plain 429 keeps the rate-limit headline and the status-only classification", () => {
			const err = APIError.generate(429, { error: { message: "Rate limit reached" } }, undefined, new Headers());
			const chat = expectRequestError(mapSdkError(err, chatCtx), "http");
			assert.ok(
				chat.message.startsWith("The server is handling too many requests - wait a moment and try again."),
				chat.message
			);
			assert.strictEqual(chat.logClassification, "RequestError(http, status 429)");
		});

		test('chat messages separate headline and detail with "Details:"; discovery keeps the plain newline', () => {
			// Copilot Chat's error block flattens newlines, so the chat surface
			// needs the textual boundary; the dashboard and tooltips split
			// discovery messages on the single "\n".
			const err = APIError.generate(500, { error: { message: "boom" } }, undefined, new Headers());
			const chat = expectRequestError(mapSdkError(err, chatCtx), "http");
			assert.ok(chat.message.includes("\n\nDetails: "), chat.message);
			const discovery = expectRequestError(mapSdkError(err, discoveryCtx), "http");
			assert.ok(!discovery.message.includes("Details:"), discovery.message);
			assert.ok(discovery.message.includes("\n") && !discovery.message.includes("\n\n"), discovery.message);
		});

		test("400 with a non-JSON body recovers the text from the SDK message into the detail line", () => {
			const err = new APIError(400, undefined, "plain text failure, not JSON", new Headers());
			assert.strictEqual(err.error, undefined);
			assert.strictEqual(err.message, "400 plain text failure, not JSON");

			const mapped = expectRequestError(mapSdkError(err, chatCtx), "http");
			assert.strictEqual(
				mapped.message,
				"The server rejected this request as invalid.\n\nDetails: LiteLLM 400: plain text failure, not JSON"
			);
			assert.strictEqual(mapped.status, 400);
			// Discovery does not brand a non-envelope body as LiteLLM's: the
			// gateway may be the one speaking.
			const discovery = expectRequestError(mapSdkError(err, discoveryCtx), "http");
			assert.ok(discovery.message.endsWith("\nHTTP 400: plain text failure, not JSON"), discovery.message);
		});

		test("discovery 404 points at the base URL with the /v1 and default-port guidance", () => {
			const err = APIError.generate(404, { error: { message: "no such route" } }, undefined, new Headers());
			const mapped = expectRequestError(mapSdkError(err, discoveryCtx), "http");
			assert.strictEqual(mapped.status, 404);
			assert.strictEqual(mapped.setupHint, "check-base-url");
			assertShows(mapped.message, "http://litellm.test", "discovery 404 names the base URL");
			assert.ok(mapped.message.includes("/v1 suffix"), mapped.message);
			assert.ok(mapped.message.includes("default port is 4000"), mapped.message);
			assert.strictEqual(mapped.logClassification, "RequestError(http, status 404, discovery)");
			// The envelope's message rides as a compact detail line, never the
			// re-serialized JSON envelope.
			assert.ok(mapped.message.endsWith("\nLiteLLM 404: no such route"), mapped.message);
			assert.strictEqual(mapped.englishMessage, mapped.message, "English fallback: the two renderings coincide");
		});

		test("chat 404 leads with the removed-model guidance and suggests Sync Models, with no setupHint", () => {
			const err = APIError.generate(404, { error: { message: "model not found" } }, undefined, new Headers());
			const mapped = expectRequestError(mapSdkError(err, chatCtx), "http");
			assert.strictEqual(mapped.status, 404);
			assert.ok(mapped.message.startsWith("The server did not recognize this request"), mapped.message);
			assert.ok(mapped.message.includes("LiteLLM: Sync Models Now"), mapped.message);
			assert.strictEqual(
				mapped.setupHint,
				undefined,
				"a chat 404 usually means a removed model, not a bad base URL, so no hint"
			);
			assert.strictEqual(mapped.logClassification, "RequestError(http, status 404, chat)");
			// docker-transport.test.ts pins `LiteLLM ${status}\b` against the live
			// stack, so the detail line must keep the status greppable.
			assert.ok(mapped.message.endsWith("\n\nDetails: LiteLLM 404: model not found"), mapped.message);
			assert.strictEqual(mapped.englishMessage, mapped.message, "English fallback: the two renderings coincide");
		});

		test("a 404 with a non-JSON body keeps the recovery on chat and drops the detail on discovery", () => {
			const err = new APIError(404, undefined, "default backend - 404", new Headers());
			// Chat keeps the recovered text: the nginx/wrong-server signature of a
			// /v1-doubled base URL is the useful clue.
			const chat = expectRequestError(mapSdkError(err, chatCtx), "http");
			assert.ok(chat.message.endsWith("\n\nDetails: LiteLLM 404: default backend - 404"), chat.message);
			// The discovery headline already says this address does not serve the
			// LiteLLM API; an HTML 404 page or plain-text body adds nothing.
			const discovery = expectRequestError(mapSdkError(err, discoveryCtx), "http");
			assert.ok(!discovery.message.includes("\n"), discovery.message);
			assert.ok(!discovery.message.includes("default backend"), discovery.message);
		});
	});

	suite("connection errors", () => {
		test("ECONNREFUSED in the cause chain maps to the connection message", () => {
			const err = connectionError(new Error("connect ECONNREFUSED 127.0.0.1:4000"));
			const mapped = expectRequestError(mapSdkError(err, chatCtx), "connection");
			assert.strictEqual(
				mapped.message,
				"Connection Error: Unable to connect to http://litellm.test. Please check that the server is running and the URL is correct."
			);
			assert.strictEqual(mapped.cause, err);
			// Nothing listens on that port - the one connection failure where "is
			// the proxy running?" is certainly the right first question.
			assert.strictEqual(mapped.setupHint, "proxy-not-running");
		});

		test("ENOTFOUND maps to the same connection message but carries no setupHint", () => {
			const err = connectionError(
				Object.assign(new Error("getaddrinfo ENOTFOUND litellm.internal"), { code: "ENOTFOUND" })
			);
			const mapped = expectRequestError(mapSdkError(err, chatCtx), "connection");
			assert.strictEqual(
				mapped.message,
				"Connection Error: Unable to connect to http://litellm.test. Please check that the server is running and the URL is correct."
			);
			// DNS failure does not establish the proxy is stopped (a mistyped
			// hostname resolves nowhere with the proxy running fine), so the
			// construction-site-certainty contract forbids the hint here.
			assert.strictEqual(mapped.setupHint, undefined);
		});

		test("expired certificate in the cause chain maps to the SSL-expired message", () => {
			const err = connectionError(new Error("certificate has expired"));
			const mapped = expectRequestError(mapSdkError(err, chatCtx), "certificate");
			assert.strictEqual(
				mapped.message,
				"SSL Certificate Error: The SSL certificate for http://litellm.test has expired. Please contact your LiteLLM server administrator to renew the certificate, or update your base URL."
			);
		});

		test("other certificate failures get the untrusted-certificate headline with the cause on the detail line", () => {
			const err = connectionError(new Error("self-signed certificate"));
			const mapped = expectRequestError(mapSdkError(err, chatCtx), "certificate");
			assert.strictEqual(
				mapped.message,
				"The server's SSL certificate couldn't be verified, so the connection was blocked. Trust the server's certificate authority on this machine (for example via NODE_EXTRA_CA_CERTS), or contact your LiteLLM server administrator.\n\nDetails: SSL certificate error for http://litellm.test: self-signed certificate"
			);
			// Node's hostname-mismatch text can embed the certificate's SAN list
			// (server-supplied), so the public surfaces get a classification.
			assert.strictEqual(mapped.logClassification, "RequestError(certificate, unverified)");
		});

		test("the certificate detail picks the deepest certificate-naming chain link and carries its code", () => {
			const err = connectionError(
				Object.assign(new Error("unable to verify the first certificate"), {
					code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
				})
			);
			const mapped = expectRequestError(mapSdkError(err, chatCtx), "certificate");
			assert.ok(
				mapped.message.endsWith(
					"\n\nDetails: SSL certificate error for http://litellm.test: unable to verify the first certificate (UNABLE_TO_VERIFY_LEAF_SIGNATURE)"
				),
				mapped.message
			);
		});
	});

	suite("timeouts", () => {
		test("a TimeoutError DOMException in the cause chain maps to the per-surface timeout message", () => {
			const err = connectionError(new DOMException("The operation was aborted due to timeout", "TimeoutError"));

			const chat = expectRequestError(mapSdkError(err, chatCtx), "timeout");
			assert.strictEqual(chat.message, timeoutMessage(chatCtx));
			assert.match(chat.message, /chat\.timeout/);

			const discovery = expectRequestError(mapSdkError(err, discoveryCtx), "timeout");
			assert.strictEqual(discovery.message, timeoutMessage(discoveryCtx));
			assert.match(discovery.message, /discovery\.timeout/);
		});

		test("APIConnectionTimeoutError maps to the per-surface timeout message", () => {
			const err = new APIConnectionTimeoutError();

			const chat = expectRequestError(mapSdkError(err, chatCtx), "timeout");
			assert.match(chat.message, /chat\.timeout/);

			const discovery = expectRequestError(mapSdkError(err, discoveryCtx), "timeout");
			assert.match(discovery.message, /discovery\.timeout/);
		});

		test("timeoutMessage pins the exact user-facing strings", () => {
			assert.strictEqual(
				timeoutMessage(chatCtx),
				'LiteLLM request timed out after 5000ms. Increase the "litellm-vscode-chat.chat.timeout" setting if your model needs more time.'
			);
			assert.strictEqual(
				timeoutMessage(discoveryCtx),
				'LiteLLM model discovery timed out after 5000ms. Increase the "litellm-vscode-chat.discovery.timeout" setting if your server needs more time.'
			);
		});
	});

	suite("pass-through and construction", () => {
		test("APIUserAbortError maps to an aborted RequestError", () => {
			const mapped = expectRequestError(mapSdkError(new APIUserAbortError(), chatCtx), "aborted");
			assert.strictEqual(mapped.message, "Request was aborted.");
		});

		test("a bare body-read termination maps to the mid-stream network message per surface", () => {
			// The shape undici throws when the socket dies AFTER headers: the SDK
			// already returned the Response, so no SDK error class wraps it and
			// the user would otherwise see the raw "terminated".
			const err = Object.assign(new TypeError("terminated"), {
				cause: Object.assign(new Error("other side closed"), { name: "SocketError", code: "UND_ERR_SOCKET" }),
			});
			const mapped = expectRequestError(mapSdkError(err, chatCtx), "network");
			assert.ok(mapped.message.startsWith("The connection dropped before the model finished replying"), mapped.message);
			assert.ok(
				mapped.message.endsWith(
					"\n\nDetails: Connection to http://litellm.test closed mid-response: terminated (cause: other side closed)"
				),
				"the deepest cause stays in the detail line"
			);
			assert.strictEqual(mapped.cause, err);
			const disco = expectRequestError(mapSdkError(err, discoveryCtx), "network");
			assertStartsWith(disco.message, "The connection to http://litellm.test dropped while fetching models");
			assert.ok(disco.message.endsWith("\nterminated (cause: other side closed)"), disco.message);
		});

		test("an ECONNRESET without SDK wrapping still classifies as a network error", () => {
			const err = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
			expectRequestError(mapSdkError(err, chatCtx), "network");
		});

		test("the never-connected fallback splits headline and cause detail per surface", () => {
			const err = connectionError(
				Object.assign(new Error("getaddrinfo EAI_AGAIN litellm.internal"), { code: "EAI_AGAIN" })
			);
			const chat = expectRequestError(mapSdkError(err, chatCtx), "network");
			assert.strictEqual(
				chat.message,
				"Could not reach http://litellm.test. Check your network, VPN, or proxy settings, and that the server is up.\n\nDetails: fetch failed (cause: getaddrinfo EAI_AGAIN litellm.internal)"
			);
			const disco = expectRequestError(mapSdkError(err, discoveryCtx), "network");
			assertStartsWith(disco.message, "Could not reach http://litellm.test to list its models.");
			assert.ok(
				disco.message.endsWith("\nfetch failed (cause: getaddrinfo EAI_AGAIN litellm.internal)"),
				disco.message
			);
		});

		test("an already-classified RequestError passes through even when its message mentions a socket term", () => {
			const err = new RequestError("upstream said: terminated", "http", { status: 500 });
			assert.strictEqual(mapSdkError(err, chatCtx), err);
		});

		test("a CancellationError passes through unwrapped", () => {
			const err = new CancellationError();
			assert.strictEqual(mapSdkError(err, chatCtx), err);
			assert.strictEqual(mapSdkError(err, discoveryCtx), err);
		});

		test("an Error already carrying an englishMessage mirror passes through unwrapped", () => {
			// The localizedError construction sites (chatClient pre-flight throws,
			// the stream processor) arrive here already shaped; re-headlining
			// would double-wrap them.
			const err = localizedError("display", "english");
			assert.strictEqual(mapSdkError(err, chatCtx), err);
		});

		test("a plain Error merely containing the word terminated is not reclassified as network", () => {
			// The termination branch requires a socket-level signature or undici's
			// exact top-level TypeError; unrelated errors fall to the anonymous
			// wrapper instead.
			const err = new Error("worker terminated by policy");
			const mapped = mapSdkError(err, chatCtx);
			assert.ok(!(mapped instanceof RequestError), "must not classify as a transport RequestError");
			assert.ok(mapped.message.startsWith("The request failed unexpectedly."), mapped.message);
		});

		test("an unknown plain Error is wrapped with the unexpected-failure headline and a fixed classification", () => {
			const err = new Error("boom");
			const mapped = mapSdkError(err, chatCtx) as Error & { englishMessage?: string; logClassification?: string };
			assert.strictEqual(
				mapped.message,
				"The request failed unexpectedly. Try again; if it keeps happening, report an issue so we can look at it.\n\nDetails: Unexpected Error during the chat request to http://litellm.test: boom"
			);
			assert.strictEqual(mapped.englishMessage, mapped.message);
			// The thrown value's text is arbitrary, so the public surfaces record
			// only the fixed shape.
			assert.strictEqual(mapped.logClassification, "unhandled Error in transport (Error, chat)");
			assert.strictEqual(mapped.cause, err);
			const disco = mapSdkError(err, discoveryCtx) as Error & { logClassification?: string };
			assert.ok(disco.message.includes("during the discovery request to http://litellm.test"), disco.message);
			assert.strictEqual(disco.logClassification, "unhandled Error in transport (Error, discovery)");
		});

		test("a non-Error value is wrapped with its string form on the detail line", () => {
			const mapped = mapSdkError("boom", chatCtx) as Error & { logClassification?: string };
			assert.ok(mapped instanceof Error);
			assert.ok(
				mapped.message.endsWith("\n\nDetails: Unexpected string during the chat request to http://litellm.test: boom"),
				mapped.message
			);
			assert.strictEqual(mapped.logClassification, "non-Error throw in transport (string, chat)");
		});

		test("a value whose String() coercion throws still maps to an Error", () => {
			const mapped = mapSdkError({ toString: null, valueOf: null }, chatCtx);
			assert.ok(mapped instanceof Error);
			assert.ok(mapped.message.includes("[object Object]"), mapped.message);
		});

		test("RequestError preserves cause, status, kind, and name", () => {
			const cause = new Error("underlying failure");
			const err = new RequestError("wrapped", "network", { status: 502, cause });
			assert.strictEqual(err.cause, cause);
			assert.strictEqual(err.status, 502);
			assert.strictEqual(err.kind, "network");
			assert.strictEqual(err.name, "RequestError");
			assert.strictEqual(err.message, "wrapped");
		});

		test("streamErrorFrame renders the envelope fields on a compact detail line and carries no HTTP status", () => {
			const envelope = { message: "upstream died mid-stream", code: "500" };
			const err = streamErrorFrame(envelope);
			assert.strictEqual(err.kind, "http");
			assert.strictEqual(err.status, undefined, "the response was already 200; there is no status to carry");
			assert.ok(err.message.startsWith("The server reported an error while it was streaming this reply"), err.message);
			assert.ok(err.message.endsWith("\n\nDetails: LiteLLM stream error (500): upstream died mid-stream"), err.message);
			assert.ok(!err.message.includes('{"error"'), "the envelope is never re-serialized");
			// mapSdkError must hand it through untouched on the way out of send().
			assert.strictEqual(mapSdkError(err, chatCtx), err);
		});

		test("a message-less stream error frame still surfaces its type and code", () => {
			const err = streamErrorFrame({ type: "rate_limit_error", code: 429 });
			// A known class swaps in that class's headline: "trying again may
			// work" would be wrong advice for a rate limit or a blown budget.
			assert.ok(err.message.startsWith("The server is handling too many requests"), err.message);
			assert.ok(err.message.endsWith("\n\nDetails: LiteLLM stream error rate_limit_error (429)"), err.message);
			assert.strictEqual(err.status, undefined, "no status may be derived from the envelope's code");
		});

		test("an empty stream error frame says the server provided no detail", () => {
			const err = streamErrorFrame({});
			assert.ok(
				err.message.endsWith("\n\nDetails: LiteLLM stream error (no detail provided by the server)"),
				err.message
			);
		});

		test("logClassification is an explicit construction-site opt-in, never derived from kind", () => {
			const optedIn = new RequestError("LiteLLM API error: 503\nresponse body text", "http", {
				status: 503,
				logClassification: "RequestError(http, status 503)",
			});
			assert.strictEqual(optedIn.logClassification, "RequestError(http, status 503)");
			// No opt-in, no classification - regardless of kind: a site with a
			// template-only message keeps its text useful in issues.
			assert.strictEqual(new RequestError("template text", "http", { status: 503 }).logClassification, undefined);
			assert.strictEqual(new RequestError("timed out", "timeout").logClassification, undefined);
			assert.strictEqual(new RequestError("auth template", "auth", { status: 401 }).logClassification, undefined);
		});

		test("mapSdkError's http mapping opts in with the status, never the body", () => {
			const err = new APIError(503, { error: { message: "internal-host body" } }, "503 boom", new Headers());
			const mapped = expectRequestError(mapSdkError(err, chatCtx), "http");
			assert.strictEqual(mapped.logClassification, "RequestError(http, status 503)");
		});

		test("streamErrorFrame carries its own distinct classification", () => {
			const err = streamErrorFrame({ message: "upstream died" });
			assert.strictEqual(err.logClassification, "RequestError(http, in-band stream error frame)");
		});
	});

	suite("classification for status surfaces", () => {
		test("statusErrorTexts carries a RequestError's classification, present fields only", () => {
			const withHint = statusErrorTexts(
				new RequestError("guidance", "http", { status: 404, setupHint: "check-base-url" })
			);
			assert.deepStrictEqual(withHint.classification, { kind: "http", status: 404, setupHint: "check-base-url" });

			const bare = statusErrorTexts(new RequestError("timed out", "timeout"));
			assert.deepStrictEqual(bare.classification, { kind: "timeout" });
			assert.ok(
				!("status" in (bare.classification ?? {})) && !("setupHint" in (bare.classification ?? {})),
				"absent fields stay absent, not present-as-undefined"
			);
		});

		test("statusErrorTexts omits the classification for a plain Error", () => {
			const texts = statusErrorTexts(new Error("boom"));
			assert.strictEqual(texts.error, "boom");
			assert.ok(!("classification" in texts), "unclassified errors must render exactly today's status shape");
		});

		test("toLanguageModelError still maps a chat 404 to NotFound", () => {
			const err = APIError.generate(404, { error: { message: "model not found" } }, undefined, new Headers());
			const mapped = mapSdkError(err, chatCtx);
			const wrapped = toLanguageModelError(mapped);
			assert.ok(wrapped instanceof LanguageModelError, `expected LanguageModelError, got ${String(wrapped)}`);
			assert.strictEqual(wrapped.code, LanguageModelError.NotFound().code);
			assert.strictEqual(wrapped.cause, mapped);
		});
	});

	suite("display/English split (localized display, English logs)", () => {
		test("every localized mapSdkError site records an englishMessage identical to the English display", () => {
			// Under the test host's English fallback, l10n.t returns the English
			// template, so the localized display message and the hand-written
			// English mirror must be the same string. A mismatch here means a
			// site's English mirror drifted from its t() literal.
			const upstream401 = {
				message: "litellm.AuthenticationError: AnthropicException - upstream key missing",
				type: null,
			};
			const cases: Error[] = [
				mapSdkError(new APIConnectionTimeoutError(), chatCtx),
				mapSdkError(new APIConnectionTimeoutError(), discoveryCtx),
				mapSdkError(new AuthenticationError(401, { message: "Invalid API key" }, undefined, new Headers()), chatCtx),
				mapSdkError(new AuthenticationError(401, upstream401, undefined, new Headers()), chatCtx),
				mapSdkError(new APIError(503, { error: { message: "boom" } }, "503 boom", new Headers()), chatCtx),
				mapSdkError(new APIError(503, { error: { message: "boom" } }, "503 boom", new Headers()), discoveryCtx),
				mapSdkError(new APIError(404, { error: { message: "no such route" } }, undefined, new Headers()), chatCtx),
				mapSdkError(new APIError(404, { error: { message: "no such route" } }, undefined, new Headers()), discoveryCtx),
				mapSdkError(new APIUserAbortError(), chatCtx),
				mapSdkError(
					connectionError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })),
					chatCtx
				),
				mapSdkError(connectionError(new Error("certificate has expired")), chatCtx),
				mapSdkError(connectionError(new Error("self-signed certificate")), chatCtx),
				mapSdkError(connectionError(new Error("socket hang up")), chatCtx),
				mapSdkError(connectionError(new Error("socket hang up")), discoveryCtx),
				mapSdkError(
					Object.assign(new TypeError("terminated"), {
						cause: Object.assign(new Error("other side closed"), { name: "SocketError", code: "UND_ERR_SOCKET" }),
					}),
					chatCtx
				),
				mapSdkError(
					Object.assign(new TypeError("terminated"), {
						cause: Object.assign(new Error("other side closed"), { name: "SocketError", code: "UND_ERR_SOCKET" }),
					}),
					discoveryCtx
				),
				streamErrorFrame({ message: "upstream died" }),
			];
			for (const mapped of cases) {
				const mirrored = mapped as Error & { englishMessage?: string };
				assert.strictEqual(mirrored.englishMessage, mapped.message, mapped.message);
			}
		});

		test("timeoutRequestError carries the display message, the cause, and the English mirror", () => {
			const cause = new Error("boom");
			const err = timeoutRequestError(chatCtx, cause);
			assert.strictEqual(err.kind, "timeout");
			assert.strictEqual(err.cause, cause);
			assert.strictEqual(err.message, timeoutMessage(chatCtx));
			// English fallback: the two renderings coincide.
			assert.strictEqual(err.englishMessage, timeoutMessage(chatCtx));
			assert.strictEqual(err.logClassification, undefined, "template-only sites carry no terse classification");
		});

		test("localizedError pairs the display message with its English mirror", () => {
			const err = localizedError("display text", "english text") as Error & { englishMessage?: string };
			assert.strictEqual(err.message, "display text");
			assert.strictEqual(err.englishMessage, "english text");
		});
	});
});
