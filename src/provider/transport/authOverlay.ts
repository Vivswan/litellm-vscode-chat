import { isValidHeaderValue } from "../../shared/util/headers";
import type { OAuthConfig, OAuthErrorSurface, OAuthTokenSource, VirtualKeyConfig } from "./auth";
import { buildDefaultHeaders } from "./clients";
import { RequestError } from "./errorMapping";

/**
 * The per-request credential overlay every transport applies the same way: the
 * OAuth bearer token and the gateway virtual-key header, layered over a
 * plain-object header record with case-insensitive name ownership. One home so
 * the chat path, the usage poller, and the one-shot client cannot drift.
 *
 * Fail-closed by construction: a value isValidHeaderValue rejects never reaches
 * the platform's Headers, whose thrown TypeError embeds the full plaintext
 * value - and these values are secrets.
 */

/** The credential fields of a connection this overlay reads; wider connection shapes satisfy it structurally. */
export interface AuthOverlayCredentials {
	readonly oauth?: OAuthConfig | undefined;
	readonly virtualKey?: VirtualKeyConfig | undefined;
}

/** What one overlay application needs beyond the credentials themselves. */
export interface AuthOverlayContext {
	/** The caller's token cache, so exchanges and 401 invalidation stay per-client. */
	readonly tokens: OAuthTokenSource;
	/** The error surface a token-exchange failure renders toward. */
	readonly surface: OAuthErrorSurface;
	/** Hard bound on the token exchange: the chat and discovery callers pass the discovery timeout (auth plumbing with its own budget), the one-shot callers their whole-call budget. */
	readonly timeoutMs: number;
	/** Interrupts the exchange when the triggering call is aborted or times out. */
	readonly signal?: AbortSignal | undefined;
}

/**
 * Set `name` in a plain-object header record, owning the name outright: every
 * existing spelling is removed first (HTTP header names are case-insensitive,
 * and two spellings in a plain-object fetch would COMBINE into
 * "custom, Bearer ..." on the wire instead of replacing). A value
 * isValidHeaderValue rejects is dropped rather than set - fail closed, so the
 * conflicting header it displaced is not resurrected either. Returns whether
 * the header was actually set.
 */
export function setOwnedHeader(headers: Record<string, string>, name: string, value: string): boolean {
	for (const existing of Object.keys(headers)) {
		if (existing.toLowerCase() === name.toLowerCase()) {
			delete headers[existing];
		}
	}
	if (!isValidHeaderValue(value)) {
		return false;
	}
	headers[name] = value;
	return true;
}

/**
 * The base header record for a plain-fetch call to a LiteLLM server: the
 * provider's static precedence rule (buildDefaultHeaders) with null-valued
 * entries dropped and every value fail-closed filtered, plus the explicit
 * Bearer Authorization the SDK would add on its own client - no SDK adds one
 * on a plain fetch. X-API-Key already rides in the defaults.
 */
export function plainFetchBaseHeaders(config: {
	readonly apiKey: string;
	readonly userAgent: string;
	readonly customHeaders: Readonly<Record<string, string>>;
}): Record<string, string> {
	const base = buildDefaultHeaders({
		apiKey: config.apiKey,
		userAgent: config.userAgent,
		customHeaders: { ...config.customHeaders },
	});
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(base)) {
		if (value !== null && isValidHeaderValue(value)) {
			headers[name] = value;
		}
	}
	if (config.apiKey) {
		setOwnedHeader(headers, "Authorization", `Bearer ${config.apiKey}`);
	}
	return headers;
}

/**
 * Apply the OAuth and virtual-key overlay onto `headers`, in place. A virtual
 * key naming the Authorization header (any casing) owns it outright, so the
 * token exchange is skipped: an unreachable identity provider must not fail a
 * request that would not carry the token anyway.
 *
 * Returns the bearer token the headers actually carry, so a later 401 never
 * has to re-parse it out of the Authorization header; undefined when the
 * virtual key owns that header and no token was exchanged or sent.
 */
export async function applyAuthOverlay(
	headers: Record<string, string>,
	credentials: AuthOverlayCredentials,
	context: AuthOverlayContext
): Promise<string | undefined> {
	const authorizationOverridden = credentials.virtualKey?.header.toLowerCase() === "authorization";
	let sentOAuthToken: string | undefined;
	if (credentials.oauth && !authorizationOverridden) {
		const token = await context.tokens.getToken(credentials.oauth, context.surface, context.timeoutMs, context.signal);
		// Recorded only when the header really carries it (parseTokenResponse
		// already rejects header-illegal tokens, so the drop cannot fire today,
		// but the returned claim stays true by construction).
		if (setOwnedHeader(headers, "Authorization", `Bearer ${token}`)) {
			sentOAuthToken = token;
		}
	}
	if (credentials.virtualKey) {
		setOwnedHeader(headers, credentials.virtualKey.header, credentials.virtualKey.value);
	}
	return sentOAuthToken;
}

/**
 * A 401 means the server no longer accepts the bearer token the call sent, so
 * the next request must perform a fresh exchange. The rejected call itself is
 * never retried. Keyed on the token that actually went out, so a straggling
 * 401 cannot discard a token that already replaced the rejected one, and a
 * request whose Authorization header the virtual key replaced invalidates
 * nothing.
 */
export function invalidateRejectedOAuthToken(
	tokens: OAuthTokenSource,
	oauth: OAuthConfig | undefined,
	error: unknown,
	sentOAuthToken: string | undefined
): void {
	if (!oauth || sentOAuthToken === undefined || !(error instanceof RequestError) || error.kind !== "auth") {
		return;
	}
	tokens.invalidate(oauth, sentOAuthToken);
}
