import * as assert from "node:assert";
import * as fc from "fast-check";
import { APIConnectionTimeoutError, APIError, APIUserAbortError, AuthenticationError } from "openai";
import {
	type MapErrorContext,
	mapSdkError,
	RequestError,
	timeoutMessage,
} from "../../../provider/transport/errorMapping";
import { MANAGE_COMMAND_TITLE } from "../../../shared/commandIds";
import { resolveFuzzSeed } from "../../fuzzStream";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 200;
// Pinned by default; FUZZ_SEED overrides so the nightly explores fresh seeds.
const SEED = resolveFuzzSeed();

/**
 * Property suite for provider/errorMapping. Mapped messages are user-facing
 * and feed the issue-report buffer that opens public GitHub issues, so
 * mapSdkError must be total (always an Error, never a throw) and a 401 must
 * map to one of the two fixed classification strings, never to text derived
 * from the response body.
 *
 * AUTH_MESSAGE and UPSTREAM_AUTH_MESSAGE are not exported by the source, so
 * the expected strings are mirrored here; the AUTH_MESSAGE mirror is built
 * from the same MANAGE_COMMAND_TITLE constant the source interpolates.
 */
const AUTH_MESSAGE = `Authentication failed: Your LiteLLM server requires an API key. Please run the "${MANAGE_COMMAND_TITLE}" command to configure your API key.`;

const UPSTREAM_AUTH_MESSAGE =
	"Authentication failed upstream: the LiteLLM server accepted your key but could not authenticate to the model's upstream provider. Fix that provider's credentials on the LiteLLM server.";

const ctxArb: fc.Arbitrary<MapErrorContext> = fc.record({
	surface: fc.constantFrom("chat", "discovery"),
	baseUrl: fc.constantFrom("http://litellm.test", "https://proxy.internal:4000/v1", "http://localhost:4000/"),
	timeoutMs: fc.integer({ min: 1, max: 3_600_000 }),
});

function auth401(body: unknown): AuthenticationError {
	return new AuthenticationError(401, body as Record<string, unknown> | undefined, undefined, new Headers());
}

interface Auth401Case {
	body: unknown;
	marker: string;
	expected: "proxy" | "upstream";
}

const markerArb = fc.nat().map((n) => `SECRET_MARKER_${n}`);

const litellmMentionArb = fc.constantFrom(
	"litellm.AuthenticationError: AnthropicException - ",
	"litellm.exceptions.AuthenticationError: BedrockException - ",
	"LiteLLM.AuthenticationError: OpenAIException - "
);

/** Upstream-provider failures: a litellm exception name in the top-level message, no auth_error envelope. */
// The nested-body expectations below lean on the openai SDK assigning the
// parsed body to APIError.error verbatim (no error.error unwrapping); if the
// SDK ever unwraps, the nested cases' expected classifications invert.
const upstreamCaseArb: fc.Arbitrary<Auth401Case> = fc
	.record({
		marker: markerArb,
		mention: litellmMentionArb,
		type: fc.constantFrom<unknown>(undefined, null, "invalid_request_error", 401),
		nested: fc.boolean(),
	})
	.map(({ marker, mention, type, nested }) => ({
		marker,
		expected: "upstream" as const,
		body: {
			message: `${mention}{"error":{"message":"${marker}"}}. Received Model Group=${marker}`,
			type,
			param: null,
			code: "401",
			...(nested ? { error: { message: marker, metadata: [marker, { deep: marker }] } } : {}),
		},
	}));

/** The proxy gate's own envelope: type "auth_error" outranks any litellm exception name quoted in the message. */
const proxyEnvelopeCaseArb: fc.Arbitrary<Auth401Case> = fc
	.record({
		marker: markerArb,
		mention: litellmMentionArb,
		quoteLitellm: fc.boolean(),
		nested: fc.boolean(),
	})
	.map(({ marker, mention, quoteLitellm, nested }) => ({
		marker,
		expected: "proxy" as const,
		body: {
			message: quoteLitellm
				? `Authentication Error - key rejected before ${mention}${marker}`
				: `Authentication Error, No api key passed in. ${marker}`,
			type: "auth_error",
			param: "None",
			code: "401",
			...(nested ? { error: { message: marker } } : {}),
		},
	}));

/** Bodies that fall through to the proxy-auth message: only a string top-level `message` is ever classified. */
const proxyPlainCaseArb: fc.Arbitrary<Auth401Case> = fc
	.record({ marker: markerArb, shape: fc.nat({ max: 5 }) })
	.map(({ marker, shape }) => {
		const bodies: unknown[] = [
			{ message: marker, type: null, code: "401" },
			{ message: `openai.AuthenticationError - ${marker}` },
			{ message: [marker], error: { message: marker } },
			{ error: { message: `litellm.AuthenticationError: ${marker}` } },
			marker,
			[{ message: `litellm.AuthenticationError: ${marker}` }],
		];
		return { marker, expected: "proxy" as const, body: bodies[shape] };
	});

suite("provider/errorMapping properties", () => {
	test("mapSdkError is total: any input under any context maps to an Error and never throws", () => {
		fc.assert(
			fc.property(
				fc.oneof(fc.anything({ maxDepth: 3, maxKeys: 5, withNullPrototype: true }), fc.jsonValue({ maxDepth: 3 })),
				ctxArb,
				(raw, ctx) => {
					const mapped = mapSdkError(raw, ctx);
					assert.ok(mapped instanceof Error, `mapSdkError must return an Error, got ${typeof mapped}`);
				}
			),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("401 bodies map to exactly one of the two fixed auth messages and never echo body text", () => {
		fc.assert(
			fc.property(fc.oneof(upstreamCaseArb, proxyEnvelopeCaseArb, proxyPlainCaseArb), ctxArb, (authCase, ctx) => {
				const mapped = mapSdkError(auth401(authCase.body), ctx);
				assert.ok(mapped instanceof RequestError, `expected RequestError, got ${mapped.name}: ${mapped.message}`);
				assert.strictEqual(mapped.kind, "auth");
				assert.strictEqual(mapped.status, 401);
				assert.ok(
					mapped.message === AUTH_MESSAGE || mapped.message === UPSTREAM_AUTH_MESSAGE,
					`401 must map to a fixed auth message, got: ${mapped.message}`
				);
				assert.strictEqual(mapped.message, authCase.expected === "upstream" ? UPSTREAM_AUTH_MESSAGE : AUTH_MESSAGE);
				assert.ok(
					!mapped.message.includes("SECRET_MARKER_"),
					"response-derived text must never reach the mapped message"
				);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("an auth_error envelope outranks a litellm exception name in the message text", () => {
		fc.assert(
			fc.property(markerArb, litellmMentionArb, ctxArb, (marker, mention, ctx) => {
				const body = { message: `${mention}${marker}`, type: "auth_error", param: "None", code: "401" };
				const mapped = mapSdkError(auth401(body), ctx);
				assert.ok(mapped instanceof RequestError, `expected RequestError, got ${mapped.name}`);
				assert.strictEqual(mapped.message, AUTH_MESSAGE);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("an APIError's status is preserved and picks kind auth exactly for 401, http otherwise", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 100, max: 599 }),
				fc.option(fc.jsonValue({ maxDepth: 2 }), { nil: undefined }),
				ctxArb,
				(status, body, ctx) => {
					const err = new APIError(status, body as Record<string, unknown> | undefined, undefined, new Headers());
					const mapped = mapSdkError(err, ctx);
					assert.ok(mapped instanceof RequestError, `expected RequestError, got ${mapped.name}: ${mapped.message}`);
					assert.strictEqual(mapped.status, status);
					assert.strictEqual(mapped.kind, status === 401 ? "auth" : "http");
					assert.notStrictEqual(mapped.kind, "network", "a status-bearing error must never classify as network");
					if (status !== 401) {
						const prefix =
							ctx.surface === "chat" ? `LiteLLM API error: ${status}` : `Failed to fetch LiteLLM models: ${status}`;
						assert.ok(mapped.message.startsWith(prefix), mapped.message);
					}
				}
			),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("timeouts map to the exact per-surface timeout message and aborts to kind aborted", () => {
		fc.assert(
			fc.property(ctxArb, (ctx) => {
				const timedOut = mapSdkError(new APIConnectionTimeoutError(), ctx);
				assert.ok(timedOut instanceof RequestError, `expected RequestError, got ${timedOut.name}`);
				assert.strictEqual(timedOut.kind, "timeout");
				assert.strictEqual(timedOut.status, undefined);
				assert.strictEqual(timedOut.message, timeoutMessage(ctx));
				assert.ok(timedOut.message.includes(`${ctx.timeoutMs}ms`));
				assert.ok(timedOut.message.includes(ctx.surface === "chat" ? "requestTimeout" : "discoveryTimeout"));

				// This layer maps SDK aborts to kind "aborted"; converting a
				// cancellation to vscode.CancellationError is the caller's concern.
				const aborted = mapSdkError(new APIUserAbortError(), ctx);
				assert.ok(aborted instanceof RequestError, `expected RequestError, got ${aborted.name}`);
				assert.strictEqual(aborted.kind, "aborted");
				assert.strictEqual(aborted.status, undefined);
				assert.strictEqual(aborted.message, "Request was aborted.");
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});
