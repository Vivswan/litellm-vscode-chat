import * as assert from "node:assert";
import type { OAuthProviderState, TokenGrantOutcome } from "./oauth";
import {
	authErrorBody,
	createOAuthProviderState,
	FAKE_OAUTH_CLIENT_ID,
	FAKE_OAUTH_CLIENT_SECRET,
	FAKE_OAUTH_EXPIRES_IN_SECONDS,
	FAKE_OAUTH_TOKEN_PREFIX,
	grantToken,
	hasDotSegmentBypass,
	isLiveBearer,
	oauthStats,
	parseTokenRequestBody,
	revokeAllTokens,
} from "./oauth";

/**
 * Pins the fake identity provider's pure logic without a socket: tokens are
 * counter-numbered (deterministic), every grant outcome lands in the
 * counters, the bearer check accepts exactly the live tokens, and rejection
 * bodies never echo submitted material. The docker-serversync suite drives
 * the same logic over HTTP through scripts/fake-openai-server.ts.
 */
suite("fakeStack oauth provider logic", () => {
	const goodParams = {
		grant_type: "client_credentials",
		client_id: FAKE_OAUTH_CLIENT_ID,
		client_secret: FAKE_OAUTH_CLIENT_SECRET,
	};

	/** A grant that must succeed, narrowed to its token. */
	function granted(state: OAuthProviderState, params: Record<string, string> = goodParams): string {
		const outcome = grantToken(state, params);
		if (outcome.status !== 200) {
			assert.fail(`grant must succeed, got ${outcome.status}: ${JSON.stringify(outcome.body)}`);
		}
		return outcome.body.access_token;
	}

	/** A grant that must fail, narrowed to its error body. */
	function denied(
		state: OAuthProviderState,
		params: Record<string, string>
	): TokenGrantOutcome & { status: 400 | 401 } {
		const outcome = grantToken(state, params);
		if (outcome.status === 200) {
			assert.fail("the grant must be rejected");
		}
		return outcome;
	}

	test("a valid grant issues counter-numbered Bearer tokens with the fixed lifetime", () => {
		const state = createOAuthProviderState();
		const outcome = grantToken(state, goodParams);
		if (outcome.status !== 200) {
			assert.fail(`grant must succeed, got ${JSON.stringify(outcome.body)}`);
		}
		assert.strictEqual(outcome.body.access_token, `${FAKE_OAUTH_TOKEN_PREFIX}1`);
		assert.strictEqual(outcome.body.token_type, "Bearer");
		assert.strictEqual(outcome.body.expires_in, FAKE_OAUTH_EXPIRES_IN_SECONDS);
		assert.strictEqual(granted(state), `${FAKE_OAUTH_TOKEN_PREFIX}2`, "the counter numbers each token");
		assert.deepStrictEqual(oauthStats(state), { issued: 2, rejected: 0, live: 2, authedChatRequests: 0 });
	});

	test("wrong credentials are rejected with an OAuth-style body that echoes nothing submitted", () => {
		const state = createOAuthProviderState();
		const submittedSecret = "definitely-not-the-secret";
		const outcome = denied(state, { ...goodParams, client_secret: submittedSecret });
		assert.strictEqual(outcome.status, 401);
		assert.strictEqual(outcome.body.error, "invalid_client");
		assert.ok(!JSON.stringify(outcome.body).includes(submittedSecret), "the rejection must not echo the secret");
		assert.deepStrictEqual(oauthStats(state), { issued: 0, rejected: 1, live: 0, authedChatRequests: 0 });
	});

	test("a grant_type other than client_credentials is a 400, counted as rejected", () => {
		const state = createOAuthProviderState();
		const outcome = denied(state, { ...goodParams, grant_type: "authorization_code" });
		assert.strictEqual(outcome.status, 400);
		assert.strictEqual(outcome.body.error, "unsupported_grant_type");
		assert.deepStrictEqual(oauthStats(state), { issued: 0, rejected: 1, live: 0, authedChatRequests: 0 });
	});

	test("parseTokenRequestBody reads both encodings the endpoint accepts", () => {
		const form = new URLSearchParams(goodParams).toString();
		assert.deepStrictEqual(parseTokenRequestBody(form, "application/x-www-form-urlencoded"), goodParams);
		assert.deepStrictEqual(parseTokenRequestBody(JSON.stringify(goodParams), "application/json; charset=utf-8"), {
			...goodParams,
		});
	});

	test("parseTokenRequestBody degrades junk to empty parameters instead of throwing", () => {
		assert.deepStrictEqual(parseTokenRequestBody("{not json", "application/json"), {});
		assert.deepStrictEqual(parseTokenRequestBody("[1,2]", "application/json"), {});
		// Non-string JSON values are dropped, so they can never satisfy the credential check.
		assert.deepStrictEqual(
			parseTokenRequestBody(JSON.stringify({ grant_type: 42, client_id: "x" }), "application/json"),
			{ client_id: "x" }
		);
		const state = createOAuthProviderState();
		denied(state, parseTokenRequestBody("", undefined));
	});

	test("isLiveBearer accepts exactly the live tokens under the exact Bearer scheme", () => {
		const state = createOAuthProviderState();
		const token = granted(state);
		assert.strictEqual(isLiveBearer(state, `Bearer ${token}`), true);
		assert.strictEqual(isLiveBearer(state, undefined), false);
		assert.strictEqual(isLiveBearer(state, token), false, "a bare token without the scheme is not a bearer header");
		assert.strictEqual(isLiveBearer(state, `Bearer ${FAKE_OAUTH_TOKEN_PREFIX}999`), false, "never-issued tokens fail");
	});

	test("revokeAllTokens kills every live token; later grants keep counting upward", () => {
		const state = createOAuthProviderState();
		const first = granted(state);
		const second = granted(state);
		assert.strictEqual(revokeAllTokens(state), 2);
		assert.strictEqual(isLiveBearer(state, `Bearer ${first}`), false);
		assert.strictEqual(isLiveBearer(state, `Bearer ${second}`), false);
		const third = granted(state);
		assert.strictEqual(third, `${FAKE_OAUTH_TOKEN_PREFIX}3`, "revocation never resets the issue counter");
		assert.deepStrictEqual(oauthStats(state), { issued: 3, rejected: 0, live: 1, authedChatRequests: 0 });
	});

	test("hasDotSegmentBypass rejects literal and percent-encoded dot segments, any case", () => {
		// The two bypass shapes new URL() would normalize into unguarded paths.
		assert.strictEqual(hasDotSegmentBypass("/authed/../v1/models"), true);
		assert.strictEqual(hasDotSegmentBypass("/authed/%2e%2e/v1/models"), true);
		assert.strictEqual(hasDotSegmentBypass("/authed/%2E%2E/v1/models"), true);
		assert.strictEqual(hasDotSegmentBypass("/authed/%2e./v1/models"), true);
		// Every path the server actually serves stays clean.
		for (const served of [
			"/health",
			"/v1/models",
			"/v1/chat/completions",
			"/oauth/token",
			"/authed/v1/models",
			"/authed/v1/chat/completions",
			"/_test/oauth-stats",
			"/_test/custom-scenario",
		]) {
			assert.strictEqual(hasDotSegmentBypass(served), false, `${served} must not be rejected`);
		}
	});

	test("authErrorBody carries the LiteLLM auth_error envelope shape", () => {
		const body = authErrorBody("Authentication Error: bad token");
		assert.deepStrictEqual(body, {
			error: { message: "Authentication Error: bad token", type: "auth_error", param: "None", code: "401" },
		});
	});
});
