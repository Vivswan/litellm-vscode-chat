import { bearerHeaderValue, type HeaderValue, headerNameKey } from "../../shared/util/headers";
import type { OAuthConfig, OAuthErrorSurface, OAuthTokenSource, TimeoutBudget, VirtualKeyConfig } from "./auth";
import { buildDefaultHeaders } from "./clients";
import { RequestError } from "./errorMapping";

/**
 * The per-request credential overlay every transport applies the same way.
 *   One home -> the chat path, the usage poller, and the one-shot client cannot drift
 */

export interface AuthOverlayCredentials {
	readonly oauth?: OAuthConfig | undefined;
	readonly virtualKey?: VirtualKeyConfig | undefined;
}

export interface AuthOverlayContext {
	/** The caller's token cache, so exchanges and 401 invalidation stay per-client. */
	readonly tokens: OAuthTokenSource;
	readonly surface: OAuthErrorSurface;
	/**
	 * Bound on this call's token wait plus the identity of the setting that owns it (timeout advice renders from
	 * that identity): the chat and discovery callers pass the discovery timeout (auth plumbing with its own
	 * budget), the one-shot callers their whole-call budget.
	 */
	readonly timeout: TimeoutBudget;
	/**
	 * Ends this call's token wait when the triggering call is aborted or times out; the exchange itself runs on
	 * for any other waiter.
	 */
	readonly signal?: AbortSignal | undefined;
}

/**
 * The caller's only remaining duty is to route the request's classified failure through `fail`; which token to drop,
 * whether one was sent at all, and whether the error is a token rejection are all decided in here, so no call site
 * can invalidate the wrong token or forget which one it sent. A fail-closed census (authOverlayScope.test.ts) pins
 * every shipped call site to its routing.
 */
export interface AuthOverlayScope {
	/**
	 * Safe to call with anything a catch block holds.
	 *   the rejected call itself                                                            -> is never retried
	 *   any error when the virtual key owned the Authorization header, so no token was sent -> is a no-op
	 */
	readonly fail: (error: unknown) => void;
}

/**
 * Set `name` in a plain-object header record, owning the name outright: every existing spelling is removed first (HTTP
 * header names are case-insensitive, and two spellings in a plain-object fetch would COMBINE into "custom, Bearer ..."
 * on the wire instead of replacing).
 */
export function setOwnedHeader(headers: Record<string, HeaderValue>, name: string, value: HeaderValue): void {
	for (const existing of Object.keys(headers)) {
		if (headerNameKey(existing) === headerNameKey(name)) {
			delete headers[existing];
		}
	}
	headers[name] = value;
}

/**
 * The base header record for a plain-fetch call to a LiteLLM server: the provider's static precedence rule
 * (buildDefaultHeaders) with null-valued entries dropped, plus the explicit Bearer Authorization the SDK would add on
 * its own client - no SDK adds one on a plain fetch. X-API-Key already rides in the defaults.
 */
export function plainFetchBaseHeaders(config: {
	readonly apiKey: HeaderValue | "";
	readonly userAgent: HeaderValue;
	readonly customHeaders: Readonly<Record<string, HeaderValue>>;
}): Record<string, HeaderValue> {
	const base = buildDefaultHeaders({
		apiKey: config.apiKey,
		userAgent: config.userAgent,
		customHeaders: { ...config.customHeaders },
	});
	const headers: Record<string, HeaderValue> = {};
	for (const [name, value] of Object.entries(base)) {
		if (value !== null) {
			headers[name] = value;
		}
	}
	if (config.apiKey) {
		setOwnedHeader(headers, "Authorization", bearerHeaderValue(config.apiKey));
	}
	return headers;
}

/**
 * A virtual key naming the Authorization header (any casing) skips the token exchange, because an unreachable identity
 * provider must not fail a request that would not carry the token anyway. The returned scope captures the bearer token
 * it sent, so no caller handles the token value or re-parses the header.
 */
export async function applyAuthOverlay(
	headers: Record<string, HeaderValue>,
	credentials: AuthOverlayCredentials,
	context: AuthOverlayContext
): Promise<AuthOverlayScope> {
	const authorizationOverridden = headerNameKey(credentials.virtualKey?.header ?? "") === "authorization";
	let sentOAuthToken: HeaderValue | undefined;
	if (credentials.oauth && !authorizationOverridden) {
		const token = await context.tokens.getToken(credentials.oauth, context.surface, context.timeout, context.signal);
		setOwnedHeader(headers, "Authorization", bearerHeaderValue(token));
		sentOAuthToken = token;
	}
	if (credentials.virtualKey) {
		setOwnedHeader(headers, credentials.virtualKey.header, credentials.virtualKey.value);
	}
	const oauth = credentials.oauth;
	return {
		fail: (error: unknown): void => {
			// Keyed on the token that actually went out: a straggling 401 earned by an old token cannot discard the
			// fresh one that already replaced it (OAuthTokenSource.invalidate re-checks the same identity), and a
			// request whose Authorization header the virtual key replaced invalidates nothing.
			if (!oauth || sentOAuthToken === undefined || !(error instanceof RequestError) || error.kind !== "auth") {
				return;
			}
			context.tokens.invalidate(oauth, sentOAuthToken);
		},
	};
}
