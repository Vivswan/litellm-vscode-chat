import * as assert from "node:assert";
import {
	APIConnectionError,
	APIConnectionTimeoutError,
	APIError,
	APIUserAbortError,
	AuthenticationError,
} from "openai";
import { type MapErrorContext, mapSdkError, RequestError, timeoutMessage } from "../../provider/errorMapping";

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

suite("provider/errorMapping", () => {
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
	});
});
