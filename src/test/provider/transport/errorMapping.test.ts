import * as assert from "node:assert";
import {
	APIConnectionError,
	APIConnectionTimeoutError,
	APIError,
	APIUserAbortError,
	AuthenticationError,
} from "openai";
import { CancellationError, LanguageModelError } from "vscode";
import { OAuthTokenSource } from "../../../provider/transport/auth";
import {
	type MapErrorContext,
	mapSdkError,
	RequestError,
	socketFailureRequestError,
	statusErrorTexts,
	streamErrorFrame,
	TRANSPORT_ERROR_SURFACES,
	timeoutMessage,
	timeoutRequestError,
	toLanguageModelError,
	twoPartTexts,
} from "../../../provider/transport/errorMapping";
import { localizedError, MirroredError } from "../../../shared/mirroredError";
import { DEFAULT_API_VERSION } from "../../../shared/util/baseUrl";
import { assertShows, assertStartsWith } from "../../pureHelpers";

const chatCtx: MapErrorContext = { surface: "chat", baseUrl: "http://litellm.test", timeoutMs: 5000 };
const discoveryCtx: MapErrorContext = { surface: "discovery", baseUrl: "http://litellm.test", timeoutMs: 5000 };
const commitCtx: MapErrorContext = { surface: "commitGeneration", baseUrl: "http://litellm.test", timeoutMs: 5000 };

/**
 * The cause chain the SDK produces for transport failures: its "Connection
 * error." wrapper around undici's TypeError "fetch failed", which carries the
 * actionable socket/TLS/timeout error as its own cause.
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
			// The code is just the stringified status, so the detail carries only the
			// type, never "LiteLLM 429 429". The chat surface leads the detail with
			// "Details:" (Copilot Chat flattens newlines).
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
			assert.ok(mapped.message.includes("version segment like /v1 or /v2"), mapped.message);
			// Drift guard: if DEFAULT_API_VERSION ever changes, the guidance must
			// be reworded to name the new default.
			assert.ok(mapped.message.includes(`appends /${DEFAULT_API_VERSION}`), mapped.message);
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
		test("ECONNREFUSED in the cause chain maps to the connection message with the cause on the detail line", () => {
			const err = connectionError(new Error("connect ECONNREFUSED 127.0.0.1:4000"));
			const mapped = expectRequestError(mapSdkError(err, chatCtx), "connection");
			assert.strictEqual(
				mapped.message,
				"Connection Error: Unable to connect to http://litellm.test. Please check that the server is running and the URL is correct.\n\nDetails: fetch failed (cause: connect ECONNREFUSED 127.0.0.1:4000)"
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
			assertStartsWith(
				mapped.message,
				"Connection Error: Unable to connect to http://litellm.test. Please check that the server is running and the URL is correct."
			);
			assert.ok(
				mapped.message.endsWith("\n\nDetails: fetch failed (cause: getaddrinfo ENOTFOUND litellm.internal)"),
				mapped.message
			);
			// DNS failure does not establish the proxy is stopped (a mistyped hostname
			// resolves nowhere with the proxy running fine), so no hint.
			assert.strictEqual(mapped.setupHint, undefined);
		});

		suite("*.localhost hosts", () => {
			function localhostCtx(baseUrl: string): MapErrorContext {
				return { surface: "chat", baseUrl, timeoutMs: 5000 };
			}
			const enotfound = () =>
				connectionError(Object.assign(new Error("getaddrinfo ENOTFOUND www.localhost"), { code: "ENOTFOUND" }));

			test("ENOTFOUND at a *.localhost host leads with the bare-localhost correction and its setup hint", () => {
				const mapped = expectRequestError(
					mapSdkError(enotfound(), localhostCtx("http://www.localhost:8001")),
					"connection"
				);
				// The correction leads the headline: toasts truncate from the tail,
				// so a trailing try-this sentence would be the first thing cut.
				assertStartsWith(
					mapped.message,
					"Connection Error: Try http://localhost:8001 instead of http://www.localhost:8001 - subdomains of localhost usually do not resolve."
				);
				assert.strictEqual(mapped.setupHint, "use-bare-localhost");
				// The classification rides to the status surfaces (toast actions and
				// the dashboard's draft-test footer branch on it).
				assert.strictEqual(statusErrorTexts(mapped).classification?.setupHint, "use-bare-localhost");
				assert.strictEqual(mapped.englishMessage, mapped.message, "English fallback: the two renderings coincide");
			});

			test("the discovery surface carries the same suggestion and hint", () => {
				const mapped = expectRequestError(
					mapSdkError(enotfound(), { surface: "discovery", baseUrl: "http://www.localhost:8001", timeoutMs: 5000 }),
					"connection"
				);
				assert.ok(mapped.message.includes("Try http://localhost:8001 instead"), mapped.message);
				assert.strictEqual(mapped.setupHint, "use-bare-localhost");
			});

			test("the corrected URL keeps scheme, port, and path: only the host changes", () => {
				const mapped = expectRequestError(
					mapSdkError(enotfound(), localhostCtx("https://api.dev.localhost:8080/v1")),
					"connection"
				);
				assert.ok(mapped.message.includes("Try https://localhost:8080/v1 instead"), mapped.message);
				assert.strictEqual(mapped.setupHint, "use-bare-localhost");
			});

			test("a trailing dot on the host still counts as the family", () => {
				const mapped = expectRequestError(
					mapSdkError(enotfound(), localhostCtx("http://www.localhost.:8001")),
					"connection"
				);
				assert.ok(mapped.message.includes("Try http://localhost:8001 instead"), mapped.message);
				assert.strictEqual(mapped.setupHint, "use-bare-localhost");
			});

			test("the family check is case-insensitive", () => {
				const mapped = expectRequestError(
					mapSdkError(enotfound(), localhostCtx("http://WWW.LOCALHOST:8001")),
					"connection"
				);
				assert.ok(mapped.message.includes("Try http://localhost:8001 instead"), mapped.message);
				assert.strictEqual(mapped.setupHint, "use-bare-localhost");
			});

			test("ECONNREFUSED at a *.localhost host keeps proxy-not-running: resolution worked, nothing listens", () => {
				// The refusal proves the name resolved and the port answered "nothing
				// here"; bare localhost would reach the same loopback, so the
				// corrected-URL advice cannot fix the observed failure.
				const err = connectionError(new Error("connect ECONNREFUSED 127.0.0.1:8001"));
				const mapped = expectRequestError(mapSdkError(err, localhostCtx("http://www.localhost:8001")), "connection");
				assert.strictEqual(mapped.setupHint, "proxy-not-running");
				assert.ok(!mapped.message.includes("Try "), mapped.message);
			});

			test("plain localhost is not the family: ECONNREFUSED keeps proxy-not-running and no suggestion renders", () => {
				const err = connectionError(new Error("connect ECONNREFUSED 127.0.0.1:4000"));
				const mapped = expectRequestError(mapSdkError(err, localhostCtx("http://localhost:4000")), "connection");
				assert.strictEqual(mapped.setupHint, "proxy-not-running");
				assert.ok(!mapped.message.includes("Try "), mapped.message);
			});

			test("an IPv6 loopback host is not the family", () => {
				const mapped = expectRequestError(mapSdkError(enotfound(), localhostCtx("http://[::1]:8001")), "connection");
				assert.strictEqual(mapped.setupHint, undefined);
				assert.ok(!mapped.message.includes("Try "), mapped.message);
			});

			test("a non-connection failure at a *.localhost host gets neither suggestion nor hint", () => {
				const err = connectionError(new Error("certificate has expired"));
				const mapped = expectRequestError(mapSdkError(err, localhostCtx("http://www.localhost:8001")), "certificate");
				assert.strictEqual(mapped.setupHint, undefined);
				assert.ok(!mapped.message.includes("Try "), mapped.message);
			});

			test("the OAuth token endpoint gets neither the suggestion nor the hint", () => {
				const mapped = socketFailureRequestError(
					Object.assign(new Error("getaddrinfo ENOTFOUND www.localhost"), { code: "ENOTFOUND" }),
					undefined,
					{ endpoint: "oauthToken", surface: "chat", url: "http://www.localhost:8080/token" },
					() => timeoutRequestError(chatCtx, undefined)
				);
				assert.strictEqual(mapped.setupHint, undefined);
				assert.ok(!mapped.message.includes("Try "), mapped.message);
				assert.strictEqual(mapped.oauthTokenEndpoint, true);
			});
		});

		suite("userinfo in the configured URL never renders", () => {
			test("a connection error echoes the base URL without its credentials", () => {
				const err = connectionError(new Error("connect ECONNREFUSED 127.0.0.1:4000"));
				const mapped = expectRequestError(
					mapSdkError(err, { surface: "chat", baseUrl: "http://user:sekret@litellm.test:4000", timeoutMs: 5000 }),
					"connection"
				);
				assert.ok(mapped.message.includes("http://litellm.test:4000"), mapped.message);
				assert.ok(!mapped.message.includes("sekret"), mapped.message);
				assert.ok(!mapped.message.includes("user:"), mapped.message);
				assert.ok(!mapped.englishMessage?.includes("sekret"), mapped.englishMessage ?? "");
			});

			test("the bare-localhost correction strips credentials from both echoed URLs", () => {
				// Before the display pipeline, the one headline echoed the userinfo
				// TWICE: once in the configured URL and once in the corrected one.
				const err = connectionError(
					Object.assign(new Error("getaddrinfo ENOTFOUND www.localhost"), { code: "ENOTFOUND" })
				);
				const mapped = expectRequestError(
					mapSdkError(err, { surface: "chat", baseUrl: "http://user:sekret@www.localhost:8001", timeoutMs: 5000 }),
					"connection"
				);
				assertStartsWith(
					mapped.message,
					"Connection Error: Try http://localhost:8001 instead of http://www.localhost:8001 - subdomains of localhost usually do not resolve."
				);
				assert.strictEqual(mapped.setupHint, "use-bare-localhost");
				assert.ok(!mapped.message.includes("sekret"), mapped.message);
				assert.ok(!mapped.message.includes("@"), mapped.message);
			});

			test("the certificate detail line echoes the URL without its credentials", () => {
				const err = connectionError(new Error("unable to verify the first certificate"));
				const mapped = expectRequestError(
					mapSdkError(err, { surface: "chat", baseUrl: "https://user:sekret@litellm.test", timeoutMs: 5000 }),
					"certificate"
				);
				assert.ok(mapped.message.includes("SSL certificate error for https://litellm.test"), mapped.message);
				assert.ok(!mapped.message.includes("sekret"), mapped.message);
			});

			test("the OAuth token endpoint connection headline strips credentials too", () => {
				const mapped = socketFailureRequestError(
					new Error("connect ECONNREFUSED 127.0.0.1:8080"),
					undefined,
					{ endpoint: "oauthToken", surface: "chat", url: "http://user:sekret@idp.test:8080/token" },
					() => timeoutRequestError(chatCtx, undefined)
				);
				assert.ok(mapped.message.includes("http://idp.test:8080/token"), mapped.message);
				assert.ok(!mapped.message.includes("sekret"), mapped.message);
			});

			test("a cause-chain message quoting a credentialed URL is scrubbed on the detail line", () => {
				// Node and undici quote the offending URL verbatim in some failure
				// messages; the chain-derived detail must not re-leak what the
				// headline stripped.
				const err = connectionError(new Error("Failed to parse URL from http://user:sekret@litellm.test:4000/v1"));
				const mapped = expectRequestError(
					mapSdkError(err, { surface: "chat", baseUrl: "http://user:sekret@litellm.test:4000", timeoutMs: 5000 }),
					"network"
				);
				assert.ok(!mapped.message.includes("sekret"), mapped.message);
				assert.ok(mapped.message.includes("Failed to parse URL from http://litellm.test:4000/v1"), mapped.message);
				assert.ok(!mapped.englishMessage?.includes("sekret"), mapped.englishMessage ?? "");
			});

			test("the anonymous tail scrubs a credentialed URL quoted in arbitrary error text", () => {
				const mapped = mapSdkError(new Error("boom while probing http://user:sekret@x.test/v1"), chatCtx);
				assert.ok(mapped instanceof MirroredError, mapped.message);
				assert.ok(!mapped.message.includes("sekret"), mapped.message);
				assert.ok(mapped.message.includes("http://x.test/v1"), mapped.message);
			});
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

	suite("socket-failure classifier parity (chat transport vs OAuth token endpoint)", () => {
		// Both entry points classify the same raw fetch failures through the one
		// shared classifier: identical kind and identical cause-detail
		// extraction, with only the context-sanctioned advice differing. The
		// expected headlines are pinned per entry point so every wording
		// difference is a decision recorded here, not drift.
		const URL_UNDER_TEST = "http://litellm.test";

		/** Drive the OAuth exchange's socket-failure tail: fetch rejects with the synthetic failure on every retry. */
		async function oauthSocketFailure(makeFailure: () => unknown): Promise<RequestError> {
			const realFetch = globalThis.fetch;
			globalThis.fetch = () => Promise.reject(makeFailure());
			try {
				await new OAuthTokenSource().getToken(
					{ tokenUrl: URL_UNDER_TEST, clientId: "client-1", clientSecret: "secret-1" },
					"chat",
					5000
				);
			} catch (error) {
				assert.ok(error instanceof RequestError, `expected a RequestError, got ${String(error)}`);
				return error;
			} finally {
				globalThis.fetch = realFetch;
			}
			assert.fail("expected the token exchange to reject");
		}

		/** The undici shape both entry points see: TypeError "fetch failed" carrying the socket failure as its cause. */
		function fetchFailure(deepest: unknown): TypeError {
			return Object.assign(new TypeError("fetch failed"), { cause: deepest });
		}

		/** The chat-surface join split back into headline and detail. */
		function parts(message: string): { headline: string; detail: string } {
			const [headline = "", detail = ""] = message.split("\n\nDetails: ");
			return { headline, detail };
		}

		const CHAT_CONNECTION_HEADLINE =
			"Connection Error: Unable to connect to http://litellm.test. Please check that the server is running and the URL is correct.";
		const OAUTH_CONNECTION_HEADLINE =
			"Connection Error: Unable to connect to the OAuth token endpoint at http://litellm.test. Please check that the OAuth token URL is correct and the identity provider is reachable.";

		const cases: {
			name: string;
			deepest: () => unknown;
			kind: RequestError["kind"];
			detail: string;
			chatHeadline: string;
			oauthHeadline: string;
			chatSetupHint?: "proxy-not-running";
		}[] = [
			{
				name: "an expired certificate",
				deepest: () => new Error("certificate has expired"),
				kind: "certificate",
				// The expired headline states the diagnosis itself, so no detail line.
				detail: "",
				chatHeadline:
					"SSL Certificate Error: The SSL certificate for http://litellm.test has expired. Please contact your LiteLLM server administrator to renew the certificate, or update your base URL.",
				oauthHeadline:
					"SSL Certificate Error: The SSL certificate for the OAuth token endpoint at http://litellm.test has expired. Please contact your identity provider's administrator to renew the certificate, or update the OAuth token URL in this server's settings.",
			},
			{
				name: "an expired certificate signalled by code alone",
				deepest: () => Object.assign(new Error("socket connect failure"), { code: "CERT_HAS_EXPIRED" }),
				kind: "certificate",
				detail: "",
				chatHeadline:
					"SSL Certificate Error: The SSL certificate for http://litellm.test has expired. Please contact your LiteLLM server administrator to renew the certificate, or update your base URL.",
				oauthHeadline:
					"SSL Certificate Error: The SSL certificate for the OAuth token endpoint at http://litellm.test has expired. Please contact your identity provider's administrator to renew the certificate, or update the OAuth token URL in this server's settings.",
			},
			{
				name: "an unverifiable certificate",
				deepest: () =>
					Object.assign(new Error("unable to verify the first certificate"), {
						code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
					}),
				kind: "certificate",
				detail:
					"SSL certificate error for http://litellm.test: unable to verify the first certificate (UNABLE_TO_VERIFY_LEAF_SIGNATURE)",
				chatHeadline:
					"The server's SSL certificate couldn't be verified, so the connection was blocked. Trust the server's certificate authority on this machine (for example via NODE_EXTRA_CA_CERTS), or contact your LiteLLM server administrator.",
				oauthHeadline:
					"The identity provider's SSL certificate couldn't be verified, so the connection was blocked. Trust its certificate authority on this machine (for example via NODE_EXTRA_CA_CERTS), or contact your identity provider's administrator.",
			},
			{
				name: "ECONNREFUSED",
				deepest: () => new Error("connect ECONNREFUSED 127.0.0.1:4000"),
				kind: "connection",
				detail: "fetch failed (cause: connect ECONNREFUSED 127.0.0.1:4000)",
				chatHeadline: CHAT_CONNECTION_HEADLINE,
				oauthHeadline: OAUTH_CONNECTION_HEADLINE,
				// Sanctioned per-endpoint difference: at the server "is the proxy
				// running?" is certain; at the token endpoint the stopped process
				// would be the identity provider, so the OAuth side gets no hint.
				chatSetupHint: "proxy-not-running",
			},
			{
				name: "ENOTFOUND",
				deepest: () => Object.assign(new Error("getaddrinfo ENOTFOUND litellm.internal"), { code: "ENOTFOUND" }),
				kind: "connection",
				detail: "fetch failed (cause: getaddrinfo ENOTFOUND litellm.internal)",
				chatHeadline: CHAT_CONNECTION_HEADLINE,
				oauthHeadline: OAUTH_CONNECTION_HEADLINE,
			},
			{
				name: "an AggregateError of parallel connect attempts",
				// Node's happy-eyeballs shape: the aggregate's own message is empty
				// and the first attempt carries the actionable socket text.
				deepest: () =>
					Object.assign(
						new AggregateError([
							Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:4000"), { code: "ECONNREFUSED" }),
							Object.assign(new Error("connect ECONNREFUSED [::1]:4000"), { code: "ECONNREFUSED" }),
						]),
						{ code: "ECONNREFUSED" }
					),
				kind: "connection",
				detail: "fetch failed (cause: connect ECONNREFUSED 127.0.0.1:4000)",
				chatHeadline: CHAT_CONNECTION_HEADLINE,
				oauthHeadline: OAUTH_CONNECTION_HEADLINE,
				// Still an ECONNREFUSED, so the chat side keeps its sanctioned hint.
				chatSetupHint: "proxy-not-running",
			},
			{
				name: "an AggregateError carrying only a code",
				// The aggregate stays the deepest link when it has no Error members,
				// so its bare code is the only cause text available.
				deepest: () => Object.assign(new AggregateError([]), { code: "ECONNREFUSED" }),
				kind: "connection",
				detail: "fetch failed (cause: ECONNREFUSED)",
				chatHeadline: CHAT_CONNECTION_HEADLINE,
				oauthHeadline: OAUTH_CONNECTION_HEADLINE,
				chatSetupHint: "proxy-not-running",
			},
			{
				name: "a deep cause chain ending in an unroutable network",
				deepest: () =>
					new Error("request dispatch failed", {
						cause: new Error("socket dial error", {
							cause: Object.assign(new Error("connect ENETUNREACH 10.0.0.1:443"), { code: "ENETUNREACH" }),
						}),
					}),
				kind: "network",
				detail: "fetch failed (cause: connect ENETUNREACH 10.0.0.1:443)",
				chatHeadline:
					"Could not reach http://litellm.test. Check your network, VPN, or proxy settings, and that the server is up.",
				oauthHeadline:
					"Network Error: Unable to reach the OAuth token endpoint at http://litellm.test. Please check that the URL is correct and the identity provider is reachable.",
			},
		];

		for (const c of cases) {
			test(`${c.name} classifies identically at both entry points`, async () => {
				const chat = expectRequestError(
					mapSdkError(new APIConnectionError({ cause: fetchFailure(c.deepest()) }), chatCtx),
					c.kind
				);
				const oauth = await oauthSocketFailure(() => fetchFailure(c.deepest()));

				// One classification rule: identical kind, identical cause-detail extraction.
				assert.strictEqual(oauth.kind, chat.kind);
				assert.strictEqual(parts(chat.message).detail, c.detail);
				assert.strictEqual(parts(oauth.message).detail, parts(chat.message).detail);

				// The sanctioned differences: advice wording per endpoint, the chat-only
				// setup hint, and the token-endpoint provenance mark.
				assert.strictEqual(parts(chat.message).headline, c.chatHeadline);
				assert.strictEqual(parts(oauth.message).headline, c.oauthHeadline);
				assert.strictEqual(chat.setupHint, c.chatSetupHint);
				assert.strictEqual(oauth.setupHint, undefined, "token-endpoint failures never carry a setup hint");
				assert.strictEqual(oauth.oauthTokenEndpoint, true);
				assert.strictEqual(chat.oauthTokenEndpoint, undefined);

				// English fallback: both entry points keep byte-faithful mirrors.
				assert.strictEqual(chat.englishMessage, chat.message);
				assert.strictEqual(oauth.englishMessage, oauth.message);
			});
		}

		test("a TimeoutError link classifies as timeout at both entry points, each rendering its own budget message", async () => {
			// The classifier's onTimeout parameter is the one sanctioned
			// classification-level hand-back: the kind is one rule, but the message
			// stays endpoint-owned because each endpoint has its own budget.
			const deepest = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

			const chat = expectRequestError(
				mapSdkError(new APIConnectionError({ cause: fetchFailure(deepest()) }), chatCtx),
				"timeout"
			);
			assert.strictEqual(chat.message, timeoutMessage(chatCtx));

			const oauth = await oauthSocketFailure(() => fetchFailure(deepest()));
			assert.strictEqual(oauth.kind, "timeout");
			assert.strictEqual(
				oauth.message,
				'OAuth token request to http://litellm.test timed out after 5000ms. Increase the "litellm-vscode-chat.discovery.timeout" setting if your identity provider needs more time.'
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
			// The commit call is non-streaming: no partial answer exists, so the
			// "cut short" wording would be false there.
			const commit = expectRequestError(mapSdkError(err, commitCtx), "network");
			assertStartsWith(
				commit.message,
				"The connection dropped before the reply arrived, so no commit message was generated"
			);
			assert.ok(!commit.message.includes("cut short"), "a non-streaming call leaves nothing to cut short");
			assert.ok(
				commit.message.includes("\n\nDetails: Connection to http://litellm.test closed mid-response"),
				"commit errors reach a newline-flattening notification, so the join carries the Details lead-in"
			);
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
			const err = new RequestError("upstream said: terminated", "http", {
				status: 500,
				englishMessage: "upstream said: terminated",
			});
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

		test("a classification-only MirroredError passes through unwrapped too", () => {
			// The other valid EnglishRendering arm: no englishMessage, only the terse
			// classification. Re-headlining would fold its possibly body-quoting
			// display message into the English mirror and onto the output channel.
			const err = new MirroredError("display quoting a response body", {
				logClassification: "ValidationError(example)",
			});
			assert.strictEqual(mapSdkError(err, chatCtx), err);
			assert.strictEqual(mapSdkError(err, discoveryCtx), err);
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
			const err = new RequestError("wrapped", "network", { status: 502, cause, englishMessage: "wrapped" });
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
			assert.strictEqual(
				new RequestError("template text", "http", { status: 503, englishMessage: "template text" }).logClassification,
				undefined
			);
			assert.strictEqual(
				new RequestError("timed out", "timeout", { englishMessage: "timed out" }).logClassification,
				undefined
			);
			assert.strictEqual(
				new RequestError("auth template", "auth", { status: 401, englishMessage: "auth template" }).logClassification,
				undefined
			);
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
				new RequestError("guidance", "http", { status: 404, setupHint: "check-base-url", englishMessage: "guidance" })
			);
			assert.deepStrictEqual(withHint.classification, { kind: "http", status: 404, setupHint: "check-base-url" });

			const bare = statusErrorTexts(new RequestError("timed out", "timeout", { englishMessage: "timed out" }));
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

	suite("envelope classification parity (HTTP response vs mid-stream frame)", () => {
		// The same LiteLLM envelope must sort into the same class - and so the
		// same chat headline - whether it arrives as an HTTP error response or
		// as an in-band stream error frame after the 200.
		const cases: {
			name: string;
			status: number;
			envelope: Record<string, unknown>;
			headline: string;
			token: string;
		}[] = [
			{
				name: "budget",
				status: 429,
				envelope: {
					message: "Budget has been exceeded! Current cost: 0.40, Max budget: 0.37",
					type: "budget_exceeded",
					code: "429",
				},
				headline: "This key's budget is used up - requests will fail until the budget resets or an admin raises it.",
				token: ", budget_exceeded",
			},
			{
				name: "rate-limit",
				status: 429,
				envelope: { message: "Rate limit reached for model", type: "rate_limit_error", code: "429" },
				headline: "The server is handling too many requests - wait a moment and try again.",
				token: "",
			},
			{
				name: "context-window",
				status: 400,
				envelope: {
					message: "This model's maximum context length is 8192 tokens",
					type: "context_window_exceeded",
					code: "400",
				},
				headline: "The conversation is too long for this model - trim it, remove attachments, or start a new chat.",
				token: ", context_window_exceeded",
			},
		];
		for (const c of cases) {
			test(`a ${c.name} envelope gets the same headline over HTTP and mid-stream`, () => {
				const http = expectRequestError(
					mapSdkError(APIError.generate(c.status, { error: c.envelope }, undefined, new Headers()), chatCtx),
					"http"
				);
				assertStartsWith(http.message, c.headline);
				assert.strictEqual(http.logClassification, `RequestError(http, status ${c.status}${c.token})`);
				assert.strictEqual(http.englishMessage, http.message, "English fallback: the two renderings coincide");

				const frame = streamErrorFrame(c.envelope);
				assertStartsWith(frame.message, c.headline);
				assert.strictEqual(frame.status, undefined, "no status may be derived from the envelope");
				assert.strictEqual(frame.logClassification, `RequestError(http, in-band stream error frame${c.token})`);
				assert.strictEqual(frame.englishMessage, frame.message, "English fallback: the two renderings coincide");
			});
		}

		test("a mid-stream context-window frame gives the conversation-too-long advice, never the generic retry advice", () => {
			const frame = streamErrorFrame({
				message: "litellm.ContextWindowExceededError: input is too long",
				type: "context_window_exceeded",
			});
			assertStartsWith(frame.message, "The conversation is too long for this model");
			assert.ok(!frame.message.includes("trying again may work"), frame.message);
		});

		test("a statusless frame merely mentioning the context window keeps the generic interrupted-stream headline", () => {
			// No status vouches for the frame, so a bare mention proves nothing:
			// "trim the conversation" would be wrong advice for an upstream that
			// died for another reason while talking about its context window.
			const frame = streamErrorFrame({
				message: "The upstream provider failed while preparing the model's context window",
			});
			assertStartsWith(frame.message, "The server reported an error while it was streaming this reply");
			assert.strictEqual(frame.logClassification, "RequestError(http, in-band stream error frame)");
		});

		test("a statusless frame naming the maximum context length without a limit figure stays generic too", () => {
			// The signature is the exceedance, not the word "maximum": a message
			// describing the limit without overrunning it proves nothing.
			const frame = streamErrorFrame({
				message: "The upstream failed while reading the model's maximum context length",
			});
			assertStartsWith(frame.message, "The server reported an error while it was streaming this reply");
			assert.strictEqual(frame.logClassification, "RequestError(http, in-band stream error frame)");
		});

		test("a statusless frame whose message proves the exceedance classifies without the structured marks", () => {
			const frame = streamErrorFrame({
				message: "This model's maximum context length is 8192 tokens. However, your messages resulted in 9021 tokens.",
			});
			assertStartsWith(frame.message, "The conversation is too long for this model");
			assert.strictEqual(
				frame.logClassification,
				"RequestError(http, in-band stream error frame, context_window_exceeded)"
			);
		});

		test("a 400 with a bare context-window mention still classifies as context-window (the status vouches)", () => {
			const http = expectRequestError(
				mapSdkError(
					APIError.generate(
						400,
						{ error: { message: "the request does not fit this model's context window" } },
						undefined,
						new Headers()
					),
					chatCtx
				),
				"http"
			);
			assertStartsWith(http.message, "The conversation is too long for this model");
			assert.strictEqual(http.logClassification, "RequestError(http, status 400, context_window_exceeded)");
		});
	});

	suite("twoPartTexts (the one headline+detail join)", () => {
		test("joins per surface and applies the identical join to the English mirror", () => {
			const headline = { display: "AFFICHAGE", english: "HEADLINE" };
			const chat = twoPartTexts("chat", headline, "detail line");
			assert.strictEqual(chat.message, "AFFICHAGE\n\nDetails: detail line");
			assert.strictEqual(chat.englishMessage, "HEADLINE\n\nDetails: detail line");
			// Commit errors reach a VS Code notification, which flattens newlines:
			// the "Details:" lead-in is the visible boundary there, like chat.
			const commit = twoPartTexts("commitGeneration", headline, "detail line");
			assert.strictEqual(commit.message, "AFFICHAGE\n\nDetails: detail line");
			assert.strictEqual(commit.englishMessage, "HEADLINE\n\nDetails: detail line");
			const discovery = twoPartTexts("discovery", headline, "detail line");
			assert.strictEqual(discovery.message, "AFFICHAGE\ndetail line");
			assert.strictEqual(discovery.englishMessage, "HEADLINE\ndetail line");
			// Completion errors serve the dashboard's test probe, which splits on
			// the discovery-style "\n".
			const completion = twoPartTexts("completion", headline, "detail line");
			assert.strictEqual(completion.message, "AFFICHAGE\ndetail line");
			assert.strictEqual(completion.englishMessage, "HEADLINE\ndetail line");
		});

		test("an English headline yields a byte-identical message and mirror on every surface", () => {
			// Under the test host's English fallback the display headline IS the
			// English headline, so the two products must coincide byte for byte.
			const headline = { display: "same text", english: "same text" };
			for (const surface of TRANSPORT_ERROR_SURFACES) {
				const texts = twoPartTexts(surface, headline, "LiteLLM 500: boom");
				assert.strictEqual(texts.englishMessage, texts.message);
			}
		});

		test("an empty detail renders the headline alone on every surface", () => {
			const headline = { display: "affichage", english: "english" };
			for (const surface of TRANSPORT_ERROR_SURFACES) {
				const texts = twoPartTexts(surface, headline, "");
				assert.strictEqual(texts.message, "affichage");
				assert.strictEqual(texts.englishMessage, "english");
			}
		});
	});

	suite("display/English split (localized display, English logs)", () => {
		test("every localized mapSdkError site records an englishMessage identical to the English display", () => {
			// Under the test host's English fallback, l10n.t returns the English
			// template, so display and hand-written mirror must be the same string.
			// A mismatch means a site's English mirror drifted from its t() literal.
			const upstream401 = {
				message: "litellm.AuthenticationError: AnthropicException - upstream key missing",
				type: null,
			};
			const cases: Error[] = [
				mapSdkError(new APIConnectionTimeoutError(), chatCtx),
				mapSdkError(new APIConnectionTimeoutError(), discoveryCtx),
				mapSdkError(new APIConnectionTimeoutError(), commitCtx),
				mapSdkError(new AuthenticationError(401, { message: "Invalid API key" }, undefined, new Headers()), chatCtx),
				mapSdkError(new AuthenticationError(401, upstream401, undefined, new Headers()), chatCtx),
				mapSdkError(new APIError(503, { error: { message: "boom" } }, "503 boom", new Headers()), chatCtx),
				mapSdkError(new APIError(503, { error: { message: "boom" } }, "503 boom", new Headers()), discoveryCtx),
				mapSdkError(new APIError(503, { error: { message: "boom" } }, "503 boom", new Headers()), commitCtx),
				mapSdkError(
					new APIError(400, { error: { message: "maximum context length is 8192 tokens" } }, undefined, new Headers()),
					commitCtx
				),
				mapSdkError(new APIError(404, { error: { message: "no such route" } }, undefined, new Headers()), chatCtx),
				mapSdkError(new APIError(404, { error: { message: "no such route" } }, undefined, new Headers()), discoveryCtx),
				mapSdkError(new APIError(404, { error: { message: "no such route" } }, undefined, new Headers()), commitCtx),
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
				mapSdkError(
					Object.assign(new TypeError("terminated"), {
						cause: Object.assign(new Error("other side closed"), { name: "SocketError", code: "UND_ERR_SOCKET" }),
					}),
					commitCtx
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
			const err = localizedError("display text", "english text");
			assert.strictEqual(err.message, "display text");
			assert.strictEqual(err.englishMessage, "english text");
		});
	});

	suite("per-surface copy equality pins", () => {
		// Byte-equality pins over every axis the copy table owns (join,
		// httpVocabulary, timeout, notFound, contextWindow, dropped, phrase),
		// written against the branch ladders BEFORE they collapsed onto
		// SURFACE_COPY and kept as the table's regression pins. The expected
		// table is a Record over the surface union, so a new surface fails
		// typecheck here until it declares its copy.
		interface SurfaceCopyPins {
			/** How headline and detail join: the "Details:" lead-in for newline-flattening hosts, or the bare "\n". */
			readonly join: "details" | "newline";
			readonly timeout: string;
			readonly notFound: string;
			readonly notFoundHint: "check-base-url" | undefined;
			readonly contextWindow: string;
			readonly dropped: string;
			readonly droppedDetail: string;
			/** The httpVocabulary axis, pinned through a 500: the base headline and the non-envelope detail form. */
			readonly serverError: string;
			readonly serverErrorDetail: string;
			readonly phrase: string;
		}

		const SURFACE_PINS: Record<MapErrorContext["surface"], SurfaceCopyPins> = {
			chat: {
				join: "details",
				timeout:
					'LiteLLM request timed out after 5000ms. Increase the "litellm-vscode-chat.chat.timeout" setting if your model needs more time.',
				notFound:
					'The server did not recognize this request - the model may have been removed from the proxy. Run "LiteLLM: Sync Models Now" to refresh the model list; if every request fails this way, check the base URL (the extension appends /v1 unless the URL already ends in a version segment like /v1 or /v2).',
				notFoundHint: undefined,
				contextWindow:
					"The conversation is too long for this model - trim it, remove attachments, or start a new chat.",
				dropped:
					"The connection dropped before the model finished replying, so the answer may be cut short. Try again; if it keeps happening, check any proxy or load balancer between you and the server.",
				droppedDetail: "Connection to http://litellm.test closed mid-response: terminated (cause: other side closed)",
				serverError:
					"The LiteLLM server hit an internal error - try again, and check the server's logs if it persists.",
				serverErrorDetail: "LiteLLM 500: upstream exploded",
				phrase: "chat",
			},
			discovery: {
				join: "newline",
				timeout:
					'LiteLLM model discovery timed out after 5000ms. Increase the "litellm-vscode-chat.discovery.timeout" setting if your server needs more time.',
				notFound:
					"Failed to fetch LiteLLM models: the server at http://litellm.test answered 404 - it responded, but does not serve the LiteLLM API at this address. Check the base URL: the extension appends /v1 unless the URL already ends in a version segment like /v1 or /v2, and note the LiteLLM proxy's default port is 4000.",
				notFoundHint: "check-base-url",
				contextWindow: "The server refused the model-list request.",
				dropped:
					"The connection to http://litellm.test dropped while fetching models - the response never completed. Try again; if it keeps happening, check your network and any VPN or proxy.",
				droppedDetail: "terminated (cause: other side closed)",
				serverError: "The LiteLLM server hit an internal error while listing models.",
				serverErrorDetail: "HTTP 500: upstream exploded",
				phrase: "discovery",
			},
			completion: {
				join: "newline",
				timeout: "LiteLLM inline completion request timed out after 5000ms.",
				notFound:
					"The server did not recognize this completion request. Check that the configured inline completions model is a text-completion model the server still serves.",
				notFoundHint: undefined,
				contextWindow: "The completion was refused: the code context around the cursor is too long for this model.",
				dropped:
					"The connection dropped before the model finished replying, so the answer may be cut short. Try again; if it keeps happening, check any proxy or load balancer between you and the server.",
				droppedDetail: "Connection to http://litellm.test closed mid-response: terminated (cause: other side closed)",
				serverError:
					"The LiteLLM server hit an internal error - try again, and check the server's logs if it persists.",
				serverErrorDetail: "LiteLLM 500: upstream exploded",
				phrase: "completion",
			},
			commitGeneration: {
				join: "details",
				timeout:
					'LiteLLM commit message generation timed out after 5000ms. Increase the "litellm-vscode-chat.chat.timeout" setting if your model needs more time.',
				notFound:
					"The server did not recognize this commit message request. Check that the configured commit message model is one the server still serves.",
				notFoundHint: undefined,
				contextWindow:
					"The changes are too large for this model - stage a smaller change or pick a commit model with a larger context window.",
				dropped:
					"The connection dropped before the reply arrived, so no commit message was generated. Try again; if it keeps happening, check any proxy or load balancer between you and the server.",
				droppedDetail: "Connection to http://litellm.test closed mid-response: terminated (cause: other side closed)",
				serverError:
					"The LiteLLM server hit an internal error - try again, and check the server's logs if it persists.",
				serverErrorDetail: "LiteLLM 500: upstream exploded",
				phrase: "commit generation",
			},
		};

		// Derived from the copy table, with the pin table's own keys pinned
		// against it: a new surface row must bring its pins here or fail.
		const surfaces = TRANSPORT_ERROR_SURFACES;

		test("the pin table covers exactly the copy table's surfaces", () => {
			assert.deepStrictEqual([...Object.keys(SURFACE_PINS)].sort(), [...TRANSPORT_ERROR_SURFACES].sort());
		});

		const ctxFor = (surface: MapErrorContext["surface"]): MapErrorContext => ({
			surface,
			baseUrl: "http://litellm.test",
			timeoutMs: 5000,
		});
		/** The surface's pinned join applied to a headline and detail - the shape every two-part message must land in. */
		const joined = (surface: MapErrorContext["surface"], headline: string, detail: string): string =>
			SURFACE_PINS[surface].join === "details" ? `${headline}\n\nDetails: ${detail}` : `${headline}\n${detail}`;

		test("timeout: the exact per-surface message on display and mirror", () => {
			for (const surface of surfaces) {
				const mapped = expectRequestError(mapSdkError(new APIConnectionTimeoutError(), ctxFor(surface)), "timeout");
				assert.strictEqual(mapped.message, SURFACE_PINS[surface].timeout, surface);
				assert.strictEqual(mapped.englishMessage, SURFACE_PINS[surface].timeout, surface);
			}
		});

		test("404: the exact per-surface advice, hint, detail join, and classification", () => {
			for (const surface of surfaces) {
				const err = APIError.generate(
					404,
					{ error: { message: "model gone", type: "invalid_request_error" } },
					undefined,
					new Headers()
				);
				const mapped = expectRequestError(mapSdkError(err, ctxFor(surface)), "http");
				const expected = joined(
					surface,
					SURFACE_PINS[surface].notFound,
					"LiteLLM 404 invalid_request_error: model gone"
				);
				assert.strictEqual(mapped.message, expected, surface);
				assert.strictEqual(mapped.englishMessage, expected, surface);
				assert.strictEqual(mapped.setupHint, SURFACE_PINS[surface].notFoundHint, surface);
				assert.strictEqual(mapped.logClassification, `RequestError(http, status 404, ${surface})`, surface);
			}
		});

		test("context window: the exact per-surface headline over the shared classifier", () => {
			for (const surface of surfaces) {
				const err = APIError.generate(
					400,
					{ error: { message: "maximum context length exceeded", type: "context_window_exceeded" } },
					undefined,
					new Headers()
				);
				const mapped = expectRequestError(mapSdkError(err, ctxFor(surface)), "http");
				const expected = joined(
					surface,
					SURFACE_PINS[surface].contextWindow,
					"LiteLLM 400 context_window_exceeded: maximum context length exceeded"
				);
				assert.strictEqual(mapped.message, expected, surface);
				assert.strictEqual(mapped.englishMessage, expected, surface);
				assert.strictEqual(
					mapped.logClassification,
					"RequestError(http, status 400, context_window_exceeded)",
					surface
				);
			}
		});

		test("dropped connection: the exact per-surface headline and detail", () => {
			for (const surface of surfaces) {
				const err = Object.assign(new TypeError("terminated"), {
					cause: Object.assign(new Error("other side closed"), { name: "SocketError", code: "UND_ERR_SOCKET" }),
				});
				const mapped = expectRequestError(mapSdkError(err, ctxFor(surface)), "network");
				const expected = joined(surface, SURFACE_PINS[surface].dropped, SURFACE_PINS[surface].droppedDetail);
				assert.strictEqual(mapped.message, expected, surface);
				assert.strictEqual(mapped.englishMessage, expected, surface);
			}
		});

		test("http vocabulary: the exact per-surface 500 headline and non-envelope detail", () => {
			// A non-envelope body makes the two vocabularies' detail forms diverge
			// ("LiteLLM 500: ..." vs "HTTP 500: ..."), so this pins the
			// httpVocabulary axis on both of its consumers.
			for (const surface of surfaces) {
				const err = new APIError(500, undefined, "upstream exploded", new Headers());
				const mapped = expectRequestError(mapSdkError(err, ctxFor(surface)), "http");
				const expected = joined(surface, SURFACE_PINS[surface].serverError, SURFACE_PINS[surface].serverErrorDetail);
				assert.strictEqual(mapped.message, expected, surface);
				assert.strictEqual(mapped.englishMessage, expected, surface);
				assert.strictEqual(mapped.logClassification, "RequestError(http, status 500)", surface);
			}
		});

		test("anonymous tail: the exact per-surface phrase in the detail line", () => {
			for (const surface of surfaces) {
				const mapped = mapSdkError(new RangeError("boom"), ctxFor(surface));
				assert.ok(mapped instanceof MirroredError, surface);
				const expected = joined(
					surface,
					"The request failed unexpectedly. Try again; if it keeps happening, report an issue so we can look at it.",
					`Unexpected RangeError during the ${SURFACE_PINS[surface].phrase} request to http://litellm.test: boom`
				);
				assert.strictEqual(mapped.message, expected, surface);
				assert.strictEqual(mapped.englishMessage, expected, surface);
				assert.strictEqual(mapped.logClassification, `unhandled Error in transport (RangeError, ${surface})`, surface);
			}
		});
	});
});
