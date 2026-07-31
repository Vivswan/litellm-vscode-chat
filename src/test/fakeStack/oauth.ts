/**
 * The fake identity provider behind scripts/stack/fake-openai-server.ts's
 * /oauth/token endpoint and /authed path prefix: the fixed test credentials
 * and the pure grant/bearer/revocation logic, shared by the server and the
 * suites so the two cannot drift apart. Deterministic on purpose - tokens
 * are counter-numbered, never random or clock-derived - and the only state
 * is the counters plus the live-token set. Counters reset only on a process
 * restart, so tests assert deltas, not absolutes.
 */

export const FAKE_OAUTH_CLIENT_ID = "fake-oauth-client";
export const FAKE_OAUTH_CLIENT_SECRET = "fake-oauth-secret";
/** Every issued access token is this prefix plus the issue counter. */
export const FAKE_OAUTH_TOKEN_PREFIX = "fake-token-";
/** Advertised token lifetime; long enough that no test ever sees a natural expiry. */
export const FAKE_OAUTH_EXPIRES_IN_SECONDS = 3600;

/** The identity provider's whole state; the counters only ever grow. */
export interface OAuthProviderState {
	issued: number;
	rejected: number;
	/**
	 * Wire attempts on the bearer-guarded chat endpoint, auth outcome
	 * included: the docker-serversync no-retry assertions read this as "how
	 * many times did the extension actually hit /authed/v1/chat/completions",
	 * which token-issuance counters cannot answer (a background discovery
	 * sweep may legitimately re-exchange).
	 */
	authedChatRequests: number;
	readonly live: Set<string>;
}

export function createOAuthProviderState(): OAuthProviderState {
	return { issued: 0, rejected: 0, authedChatRequests: 0, live: new Set() };
}

/**
 * Raw-URL guard the server applies before URL parsing: new URL() normalizes
 * dot segments, so "/authed/../v1/models" (or a percent-encoded spelling
 * like "/authed/%2e%2e/v1/models") would otherwise reach the unguarded
 * handlers with the prefix already folded away. No served route contains
 * ".." or a percent-encoded dot, so rejecting the raw string is total.
 */
export function hasDotSegmentBypass(rawUrl: string): boolean {
	return rawUrl.includes("..") || /%2e/i.test(rawUrl);
}

/**
 * The token request's parameters, from either encoding a client may pick:
 * application/x-www-form-urlencoded (what the extension sends) or a JSON
 * object with string values. Anything unparseable comes back empty and fails
 * the credential check downstream instead of erroring here.
 */
export function parseTokenRequestBody(raw: string, contentType: string | undefined): Record<string, string> {
	if (contentType?.toLowerCase().includes("json")) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return {};
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return {};
		}
		const params: Record<string, string> = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value === "string") {
				params[key] = value;
			}
		}
		return params;
	}
	return Object.fromEntries(new URLSearchParams(raw));
}

export type TokenGrantOutcome =
	| { readonly status: 200; readonly body: { access_token: string; token_type: "Bearer"; expires_in: number } }
	| { readonly status: 400 | 401; readonly body: { error: string; error_description: string } };

/**
 * One client-credentials grant attempt. Only the exact fixed test
 * credentials succeed; every outcome lands in the counters so suites can
 * assert issue and reject deltas over the /_test/oauth-stats route. The
 * error descriptions never echo anything the client submitted.
 */
export function grantToken(state: OAuthProviderState, params: Record<string, string>): TokenGrantOutcome {
	if (params.grant_type !== "client_credentials") {
		state.rejected += 1;
		return {
			status: 400,
			body: { error: "unsupported_grant_type", error_description: "only client_credentials is supported" },
		};
	}
	if (params.client_id !== FAKE_OAUTH_CLIENT_ID || params.client_secret !== FAKE_OAUTH_CLIENT_SECRET) {
		state.rejected += 1;
		return { status: 401, body: { error: "invalid_client", error_description: "client authentication failed" } };
	}
	state.issued += 1;
	const token = `${FAKE_OAUTH_TOKEN_PREFIX}${state.issued}`;
	state.live.add(token);
	return {
		status: 200,
		body: { access_token: token, token_type: "Bearer", expires_in: FAKE_OAUTH_EXPIRES_IN_SECONDS },
	};
}

/**
 * Whether an Authorization header carries a currently live bearer token.
 * The scheme match is exact-case: the extension always sends "Bearer", so
 * accepting other spellings would only mask a regression.
 */
export function isLiveBearer(state: OAuthProviderState, authorization: string | undefined): boolean {
	if (authorization === undefined || !authorization.startsWith("Bearer ")) {
		return false;
	}
	return state.live.has(authorization.slice("Bearer ".length));
}

/** Revoke every live token; returns how many were revoked. */
export function revokeAllTokens(state: OAuthProviderState): number {
	const revoked = state.live.size;
	state.live.clear();
	return revoked;
}

/** The /_test/oauth-stats body. */
export function oauthStats(state: OAuthProviderState): {
	issued: number;
	rejected: number;
	live: number;
	authedChatRequests: number;
} {
	return {
		issued: state.issued,
		rejected: state.rejected,
		live: state.live.size,
		authedChatRequests: state.authedChatRequests,
	};
}

/**
 * The 401 envelope LiteLLM's proxy sends for a rejected key, so the /authed
 * prefix fails requests in the exact shape the extension's error mapping
 * classifies as an auth error.
 */
export function authErrorBody(message: string): {
	error: { message: string; type: string; param: string; code: string };
} {
	return { error: { message, type: "auth_error", param: "None", code: "401" } };
}
