import * as assert from "node:assert";
import {
	APIConnectionError,
	APIConnectionTimeoutError,
	APIError,
	APIUserAbortError,
	AuthenticationError,
} from "openai";
import { LanguageModelError } from "vscode";
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

/**
 * Containment assert for rendered output. The needle rides a parameter so a
 * URL literal never sits at an includes() call, the shape CodeQL reads as
 * URL-sanitization-by-substring (js/incomplete-url-substring-sanitization).
 */
function assertShows(text: string, needle: string, context: string): void {
	assert.ok(text.includes(needle), `${context}, got ${text}`);
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

		test("400 with a JSON error body re-serializes the LiteLLM error envelope per surface", () => {
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

			const body = '{"error":{"message":"unsupported parameter: frobnicate","type":"invalid_request_error"}}';
			const chat = expectRequestError(mapSdkError(err, chatCtx), "http");
			assert.strictEqual(chat.message, `LiteLLM API error: 400\n${body}`);
			assert.strictEqual(chat.status, 400);
			const discovery = expectRequestError(mapSdkError(err, discoveryCtx), "http");
			assert.strictEqual(discovery.message, `Failed to fetch LiteLLM models: 400\n${body}`);
			assert.strictEqual(discovery.status, 400);
		});

		test("400 with a non-JSON body recovers the text from the SDK message", () => {
			const err = new APIError(400, undefined, "plain text failure, not JSON", new Headers());
			assert.strictEqual(err.error, undefined);
			assert.strictEqual(err.message, "400 plain text failure, not JSON");

			const mapped = expectRequestError(mapSdkError(err, chatCtx), "http");
			assert.strictEqual(mapped.message, "LiteLLM API error: 400\nplain text failure, not JSON");
			assert.strictEqual(mapped.status, 400);
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
			// The response body rides as the same suffix the generic branch appends.
			assert.ok(mapped.message.endsWith('\n{"error":{"message":"no such route"}}'), mapped.message);
			assert.strictEqual(mapped.englishMessage, mapped.message, "English fallback: the two renderings coincide");
		});

		test("chat 404 keeps the pinned status prefix and suggests Sync Models, with no setupHint", () => {
			const err = APIError.generate(404, { error: { message: "model not found" } }, undefined, new Headers());
			const mapped = expectRequestError(mapSdkError(err, chatCtx), "http");
			assert.strictEqual(mapped.status, 404);
			// docker-transport.test.ts pins `LiteLLM API error: ${status}\b`
			// against the live stack; the guidance may only follow the prefix.
			assert.ok(mapped.message.startsWith("LiteLLM API error: 404."), mapped.message);
			assert.ok(mapped.message.includes("LiteLLM: Sync Models Now"), mapped.message);
			assert.strictEqual(
				mapped.setupHint,
				undefined,
				"a chat 404 usually means a removed model, not a bad base URL, so no hint"
			);
			assert.strictEqual(mapped.logClassification, "RequestError(http, status 404, chat)");
			assert.ok(mapped.message.endsWith('\n{"error":{"message":"model not found"}}'), mapped.message);
			assert.strictEqual(mapped.englishMessage, mapped.message, "English fallback: the two renderings coincide");
		});

		test("a 404 with a non-JSON body recovers the text from the SDK message like the generic branch", () => {
			const err = new APIError(404, undefined, "default backend - 404", new Headers());
			const chat = expectRequestError(mapSdkError(err, chatCtx), "http");
			assert.ok(chat.message.endsWith("\ndefault backend - 404"), chat.message);
			const discovery = expectRequestError(mapSdkError(err, discoveryCtx), "http");
			assert.ok(discovery.message.endsWith("\ndefault backend - 404"), discovery.message);
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

		test("other certificate failures map to the generic SSL message carrying the cause text", () => {
			const err = connectionError(new Error("self-signed certificate"));
			const mapped = expectRequestError(mapSdkError(err, chatCtx), "certificate");
			assert.strictEqual(
				mapped.message,
				"SSL Certificate Error: There is an issue with the SSL certificate for http://litellm.test. Error: self-signed certificate"
			);
		});
	});

	suite("timeouts", () => {
		test("a TimeoutError DOMException in the cause chain maps to the per-surface timeout message", () => {
			const err = connectionError(new DOMException("The operation was aborted due to timeout", "TimeoutError"));

			const chat = expectRequestError(mapSdkError(err, chatCtx), "timeout");
			assert.strictEqual(chat.message, timeoutMessage(chatCtx));
			assert.match(chat.message, /requestTimeout/);

			const discovery = expectRequestError(mapSdkError(err, discoveryCtx), "timeout");
			assert.strictEqual(discovery.message, timeoutMessage(discoveryCtx));
			assert.match(discovery.message, /discoveryTimeout/);
		});

		test("APIConnectionTimeoutError maps to the per-surface timeout message", () => {
			const err = new APIConnectionTimeoutError();

			const chat = expectRequestError(mapSdkError(err, chatCtx), "timeout");
			assert.match(chat.message, /requestTimeout/);

			const discovery = expectRequestError(mapSdkError(err, discoveryCtx), "timeout");
			assert.match(discovery.message, /discoveryTimeout/);
		});

		test("timeoutMessage pins the exact user-facing strings", () => {
			assert.strictEqual(
				timeoutMessage(chatCtx),
				'LiteLLM request timed out after 5000ms. Increase the "litellm-vscode-chat.requestTimeout" setting if your model needs more time.'
			);
			assert.strictEqual(
				timeoutMessage(discoveryCtx),
				'LiteLLM model discovery timed out after 5000ms. Increase the "litellm-vscode-chat.discoveryTimeout" setting if your server needs more time.'
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
			assert.ok(
				mapped.message.startsWith(
					"Network Error: The connection to http://litellm.test was closed before the response completed."
				),
				mapped.message
			);
			assert.ok(mapped.message.includes("other side closed"), "the deepest cause stays in the detail");
			assert.strictEqual(mapped.cause, err);
			const disco = expectRequestError(mapSdkError(err, discoveryCtx), "network");
			assert.ok(disco.message.startsWith("Network Error: Failed to fetch models from http://litellm.test."));
		});

		test("an ECONNRESET without SDK wrapping still classifies as a network error", () => {
			const err = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
			expectRequestError(mapSdkError(err, chatCtx), "network");
		});

		test("an already-classified RequestError passes through even when its message mentions a socket term", () => {
			const err = new RequestError("upstream said: terminated", "http", { status: 500 });
			assert.strictEqual(mapSdkError(err, chatCtx), err);
		});

		test("a plain Error merely containing the word terminated is not reclassified", () => {
			// The termination branch requires a socket-level signature or undici's
			// exact top-level TypeError; unrelated errors keep their identity.
			const err = new Error("worker terminated by policy");
			assert.strictEqual(mapSdkError(err, chatCtx), err);
		});

		test("an unknown plain Error passes through as the same instance", () => {
			const err = new Error("boom");
			assert.strictEqual(mapSdkError(err, chatCtx), err);
			assert.strictEqual(mapSdkError(err, discoveryCtx), err);
		});

		test("a non-Error value is wrapped in an Error with its string form", () => {
			const mapped = mapSdkError("boom", chatCtx);
			assert.ok(mapped instanceof Error);
			assert.strictEqual(mapped.message, "boom");
		});

		test("a value whose String() coercion throws still maps to an Error", () => {
			const mapped = mapSdkError({ toString: null, valueOf: null }, chatCtx);
			assert.ok(mapped instanceof Error);
			assert.strictEqual(mapped.message, "[object Object]");
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

		test("streamErrorFrame re-serializes the envelope and carries no HTTP status", () => {
			const envelope = { message: "upstream died mid-stream", code: "500" };
			const err = streamErrorFrame(envelope);
			assert.strictEqual(err.kind, "http");
			assert.strictEqual(err.status, undefined, "the response was already 200; there is no status to carry");
			assert.strictEqual(
				err.message,
				`LiteLLM API error: the stream reported an error\n${JSON.stringify({ error: envelope })}`
			);
			// mapSdkError must hand it through untouched on the way out of send().
			assert.strictEqual(mapSdkError(err, chatCtx), err);
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
