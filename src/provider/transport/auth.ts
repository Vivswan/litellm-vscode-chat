import { l10n } from "vscode";
import { CONFIG_SECTION } from "../../shared/config/settingSpec";
import { collapseWhitespace } from "../../shared/util/errorText";
import { fingerprint } from "../../shared/util/fingerprint";
import { isValidHeaderValue } from "../../shared/util/headers";
import { isRecord } from "../../shared/util/json";
import { sleepUnlessAborted } from "../../shared/util/timer";
import { DISCOVERY_MAX_RETRIES } from "../catalog/discovery";
import { RequestError } from "./errorMapping";

/**
 * OAuth2 client-credentials authentication for gateways behind an identity
 * provider (issue #161): the extension exchanges a client ID and secret at a
 * token endpoint for a short-lived bearer token and sends that token as the
 * Authorization header on every request to the server.
 *
 * Error ownership follows the transport-module convention (AGENTS.md,
 * "Error ownership"). Token values and client secrets never appear in any
 * message.
 */

/** Client-credentials grant configuration; present as a whole or not at all. */
export interface OAuthConfig {
	tokenUrl: string;
	clientId: string;
	/** Empty string when the identity provider issues public clients without a secret. */
	clientSecret: string;
	/** Space-separated scope list, omitted from the token request when absent. */
	scopes?: string;
}

/** A gateway "virtual key" sent in a custom header on every request to the server. */
export interface VirtualKeyConfig {
	header: string;
	value: string;
}

/**
 * Non-secret identity of a credential set: the canonical enumeration of what
 * makes OAuth credentials "the same" (groupClientId composes group identity
 * from it). Rotating any part (secret included) changes the key, so caches
 * keyed by it self-invalidate. JSON-encoded before hashing: the fields are
 * free-form strings, so a delimiter join would let two different credential
 * sets serialize identically and share a cached token.
 */
export function oauthCredentialFingerprint(config: OAuthConfig): string {
	// Every OAuthConfig field participates in the identity: the satisfies
	// clause breaks the build when a field is added without extending `parts`,
	// and hashing the whole object (not a hand-picked array) means extending
	// `parts` is the same edit as extending the hash.
	const parts = {
		tokenUrl: config.tokenUrl,
		clientId: config.clientId,
		clientSecret: config.clientSecret,
		scopes: config.scopes ?? "",
	} satisfies Record<keyof OAuthConfig, string>;
	return fingerprint(JSON.stringify(parts));
}

/**
 * A token is refreshed this long before its nominal expiry so it never goes
 * stale mid-request; clamped to half the lifetime so short-lived tokens
 * still spend some of their life cached.
 */
const REFRESH_SKEW_MS = 60_000;

/** Applied when the token response omits expires_in (RFC 6749 only recommends it). */
const DEFAULT_EXPIRES_IN_SECONDS = 300;

const RETRY_DELAY_MS = 200;

interface CachedToken {
	accessToken: string;
	refreshAtMs: number;
}

/**
 * Fetches and caches client-credentials tokens, keyed by the credential
 * fingerprint so a rotated secret starts from a fresh entry. Concurrent
 * requests for the same credentials share one in-flight exchange.
 */
export class OAuthTokenSource {
	private readonly tokens = new Map<string, CachedToken>();
	private readonly pending = new Map<string, Promise<string>>();

	/**
	 * The cached token while it is not yet due for refresh, otherwise a fresh
	 * exchange bounded by `timeoutMs` (the discovery timeout: the exchange is
	 * auth plumbing, not a chat call, even when a chat triggers it) and, when
	 * given, by `signal` (the triggering call's cancellation and timeout, so
	 * the user can interrupt the exchange). A caller that joins an exchange
	 * another call started shares that call's bounds, except that its own
	 * signal still stops its wait: the shared exchange continues for the
	 * other waiters.
	 */
	async getToken(config: OAuthConfig, timeoutMs: number, signal?: AbortSignal): Promise<string> {
		const key = oauthCredentialFingerprint(config);
		const cached = this.tokens.get(key);
		if (cached && Date.now() < cached.refreshAtMs) {
			return cached.accessToken;
		}
		const inFlight = this.pending.get(key);
		if (inFlight) {
			return signal !== undefined ? abortableWait(inFlight, signal) : inFlight;
		}
		const exchange = (async () => {
			try {
				const { accessToken, expiresInSeconds } = await exchangeClientCredentials(config, timeoutMs, signal);
				const lifetimeMs = expiresInSeconds * 1000;
				const skewMs = Math.min(REFRESH_SKEW_MS, lifetimeMs / 2);
				this.tokens.set(key, { accessToken, refreshAtMs: Date.now() + lifetimeMs - skewMs });
				return accessToken;
			} finally {
				this.pending.delete(key);
			}
		})();
		this.pending.set(key, exchange);
		return exchange;
	}

	/**
	 * Drop the cached token after the server rejected it (a 401 on a chat or
	 * discovery call), so the next request performs a fresh exchange. The
	 * rejected call itself is never retried. When the rejected token is known
	 * and a fresh one has already replaced it, the fresh token is kept: a
	 * straggling 401 earned by the old token must not discard its successor.
	 */
	invalidate(config: OAuthConfig, rejectedToken?: string): void {
		const key = oauthCredentialFingerprint(config);
		const cached = this.tokens.get(key);
		if (cached === undefined) {
			return;
		}
		if (rejectedToken !== undefined && cached.accessToken !== rejectedToken) {
			return;
		}
		this.tokens.delete(key);
	}
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new Error("The operation was aborted");
}

/**
 * Await a shared promise but stop waiting as soon as the caller's own signal
 * aborts: the rejection carries the abort reason, while the shared work
 * continues untouched for its other waiters. The listener is removed once
 * either side settles.
 */
function abortableWait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		return Promise.reject(abortReason(signal));
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(abortReason(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			}
		);
	});
}

function timeoutError(tokenUrl: string, timeoutMs: number, cause?: unknown): RequestError {
	return new RequestError(
		l10n.t(
			'OAuth token request to {0} timed out after {1}ms. Increase the "{2}.discovery.timeout" setting if your identity provider needs more time.',
			tokenUrl,
			timeoutMs,
			CONFIG_SECTION
		),
		"timeout",
		{
			cause,
			// The English mirror for the output channel and the issue-report buffer; the display message localizes.
			englishMessage: `OAuth token request to ${tokenUrl} timed out after ${timeoutMs}ms. Increase the "${CONFIG_SECTION}.discovery.timeout" setting if your identity provider needs more time.`,
		}
	);
}

/**
 * The RFC 6749 error code and description from an error response, when the
 * body carries them, as bare "error: description" text (empty when absent).
 * Never the raw body: it is untrusted and can be huge. The configured client
 * secret is scrubbed in case the identity provider echoes it back in the
 * description.
 */
function oauthErrorDetail(payload: string, clientSecret: string): string {
	try {
		const parsed: unknown = JSON.parse(payload);
		if (isRecord(parsed)) {
			const parts = [parsed.error, parsed.error_description].filter(
				(part): part is string => typeof part === "string" && part.length > 0
			);
			if (parts.length > 0) {
				// Scrub before truncating: a secret longer than the cap, or one
				// crossing it, must not leak its prefix. Scrub again after the
				// whitespace collapse: a secret containing whitespace dodges the
				// exact-match pass when the IdP echoes it with different
				// whitespace, and the collapse would otherwise reassemble it.
				let detail = parts.join(": ");
				if (clientSecret.length > 0) {
					detail = detail.split(clientSecret).join("[REDACTED]");
				}
				detail = collapseWhitespace(detail);
				const collapsedSecret = collapseWhitespace(clientSecret);
				if (collapsedSecret.length > 0) {
					detail = detail.split(collapsedSecret).join("[REDACTED]");
				}
				return detail.slice(0, 200);
			}
		}
	} catch {
		// A non-JSON error body carries no detail worth surfacing.
	}
	return "";
}

/**
 * The token lifetime in seconds: the advertised expires_in, a conservative
 * default when the field is absent, and zero (already due for refresh, so
 * never served from cache) when it is present but zero, negative, or
 * unparseable.
 */
function tokenLifetimeSeconds(parsed: Record<string, unknown>): number {
	if (!("expires_in" in parsed)) {
		return DEFAULT_EXPIRES_IN_SECONDS;
	}
	const value = parsed.expires_in;
	const candidate =
		typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
	return Number.isFinite(candidate) && candidate > 0 ? candidate : 0;
}

function parseTokenResponse(payload: string, tokenUrl: string): { accessToken: string; expiresInSeconds: number } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		parsed = undefined;
	}
	// Each malformed shape throws a localized headline (a whole sentence per
	// part; translators never see composed fragments) over a fixed English
	// detail line, with a single-line English mirror: these errors carry no
	// logClassification, so the mirror itself is what the one-line diagnostics
	// surfaces render.
	if (!isRecord(parsed) || typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
		const detail = `OAuth token endpoint ${tokenUrl} answered 2xx without JSON containing a non-empty access_token.`;
		throw new RequestError(
			`${l10n.t(
				"The identity provider answered but didn't return a usable access token - check that the OAuth token URL points at an OAuth2 token endpoint, not a login or SSO page."
			)}\n${detail}`,
			"http",
			{
				englishMessage: `The identity provider answered but didn't return a usable access token - check that the OAuth token URL points at an OAuth2 token endpoint, not a login or SSO page. ${detail}`,
			}
		);
	}
	if (!isValidHeaderValue(parsed.access_token)) {
		const detail = `OAuth token from ${tokenUrl} contains characters not allowed in an HTTP header value (control characters or non-Latin-1 text); the token was not sent, and its value is never shown or logged.`;
		throw new RequestError(
			`${l10n.t(
				"The identity provider returned an access token the extension can't use - check the OAuth token endpoint configuration for this server."
			)}\n${detail}`,
			"http",
			{
				englishMessage: `The identity provider returned an access token the extension can't use - check the OAuth token endpoint configuration for this server. ${detail}`,
			}
		);
	}
	return { accessToken: parsed.access_token, expiresInSeconds: tokenLifetimeSeconds(parsed) };
}

/**
 * POST the client-credentials grant to the token endpoint. Network failures
 * and 5xx responses are retried up to the discovery cap because the exchange
 * is idempotent (a lost token costs nothing); `timeoutMs` is a hard bound
 * across all attempts, and an abort of the caller's `signal` (cancellation,
 * or the triggering chat call's own timeout) interrupts the exchange and is
 * rethrown as-is so the caller attributes it truthfully. Credential
 * rejections (400/401/403) and malformed responses fail immediately with
 * distinct messages.
 */
async function exchangeClientCredentials(
	config: OAuthConfig,
	timeoutMs: number,
	outerSignal?: AbortSignal
): Promise<{ accessToken: string; expiresInSeconds: number }> {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const signal = outerSignal !== undefined ? AbortSignal.any([timeoutSignal, outerSignal]) : timeoutSignal;
	const form = new URLSearchParams({
		grant_type: "client_credentials",
		client_id: config.clientId,
		// RFC 6749 2.3.1: public clients authenticate with the client ID alone.
		...(config.clientSecret.length > 0 ? { client_secret: config.clientSecret } : {}),
		...(config.scopes !== undefined ? { scope: config.scopes } : {}),
	});

	let lastFailure: unknown;
	// The client-credentials exchange is idempotent, so it retries like the discovery GETs.
	for (let attempt = 0; attempt <= DISCOVERY_MAX_RETRIES; attempt += 1) {
		if (attempt > 0) {
			await sleepUnlessAborted(RETRY_DELAY_MS * attempt, signal);
			// The outer signal wins the classification when both have fired: an
			// abort the caller asked for must not be relabeled a token timeout.
			if (outerSignal?.aborted) {
				throw abortReason(outerSignal);
			}
			if (timeoutSignal.aborted) {
				throw timeoutError(config.tokenUrl, timeoutMs, lastFailure);
			}
		}

		let response: Response;
		let payload: string;
		try {
			response = await globalThis.fetch(config.tokenUrl, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: form.toString(),
				signal,
			});
			payload = await response.text();
		} catch (error) {
			if (outerSignal?.aborted) {
				throw error;
			}
			if (timeoutSignal.aborted) {
				throw timeoutError(config.tokenUrl, timeoutMs, error);
			}
			lastFailure = error;
			continue;
		}

		if (response.ok) {
			return parseTokenResponse(payload, config.tokenUrl);
		}
		const { status } = response;
		const idpDetail = oauthErrorDetail(payload, config.clientSecret);
		if (status >= 500) {
			// `idpDetail` quotes the IdP's error/error_description (response-derived),
			// so the detail line rides only the message and its English mirror; the
			// classification is what public surfaces record.
			const detailLine = collapseWhitespace(
				`OAuth token endpoint ${status} at ${config.tokenUrl}${idpDetail === "" ? "" : `: ${idpDetail}`}`
			);
			lastFailure = new RequestError(
				`${l10n.t(
					"The identity provider had a server problem, so the extension could not get an access token. It already retried; try again in a moment or contact the identity provider's administrator."
				)}\n${detailLine}`,
				"http",
				{
					status,
					logClassification: `RequestError(http, status ${status}, oauth token endpoint)`,
					englishMessage: `The identity provider had a server problem, so the extension could not get an access token. It already retried; try again in a moment or contact the identity provider's administrator.\n${detailLine}`,
					oauthTokenEndpoint: true,
				}
			);
			continue;
		}
		if (status === 400 || status === 401 || status === 403) {
			// Same: the IdP detail can carry correlation IDs and tenant text.
			const detailLine = collapseWhitespace(
				`OAuth ${status} at ${config.tokenUrl}${idpDetail === "" ? "" : `: ${idpDetail}`}`
			);
			throw new RequestError(
				`${l10n.t(
					"The identity provider refused to issue a token for this server - check the OAuth client ID, client secret, and scopes in the server entry."
				)}\n${detailLine}`,
				"auth",
				{
					status,
					logClassification: `RequestError(auth, status ${status}, oauth token endpoint)`,
					englishMessage: `The identity provider refused to issue a token for this server - check the OAuth client ID, client secret, and scopes in the server entry.\n${detailLine}`,
					oauthTokenEndpoint: true,
				}
			);
		}
		const detailLine = collapseWhitespace(
			`OAuth token endpoint ${status} at ${config.tokenUrl}${idpDetail === "" ? "" : `: ${idpDetail}`}`
		);
		throw new RequestError(
			`${l10n.t(
				"The OAuth token endpoint gave an unexpected answer. Check the OAuth token URL in this server's settings."
			)}\n${detailLine}`,
			"http",
			{
				status,
				logClassification: `RequestError(http, status ${status}, oauth token endpoint)`,
				englishMessage: `The OAuth token endpoint gave an unexpected answer. Check the OAuth token URL in this server's settings.\n${detailLine}`,
				oauthTokenEndpoint: true,
			}
		);
	}

	if (lastFailure instanceof RequestError) {
		throw lastFailure;
	}
	const detail = socketFailureDetail(lastFailure);
	throw new RequestError(
		`${l10n.t(
			"Network Error: Unable to reach the OAuth token endpoint at {0}. Please check that the URL is correct and the identity provider is reachable.",
			config.tokenUrl
		)}${detail === "" ? "" : `\n${detail}`}`,
		"network",
		{
			cause: lastFailure,
			// The English mirror for the output channel and the issue-report
			// buffer; single-line because this unclassified mirror is what the
			// one-line diagnostics surfaces render.
			englishMessage: `Network Error: Unable to reach the OAuth token endpoint at ${config.tokenUrl}. Please check that the URL is correct and the identity provider is reachable.${detail === "" ? "" : ` ${detail}`}`,
		}
	);
}

/**
 * The socket-level failure text with one level of cause unwrapped: under the
 * extension host's undici fetch, failures surface as a TypeError whose
 * message is literally "fetch failed" with the real reason (getaddrinfo
 * ENOTFOUND, ECONNREFUSED, TLS errors) in error.cause. Runtime error-object
 * text only - this must never be handed a response payload. Total by
 * construction: a hostile getter on cause/code/message must not replace the
 * network error with its own throw.
 */
function socketFailureDetail(failure: unknown): string {
	try {
		if (!(failure instanceof Error)) {
			return "";
		}
		const cause = failure.cause instanceof AggregateError ? failure.cause.errors[0] : failure.cause;
		const code = cause instanceof Error ? (cause as { code?: unknown }).code : undefined;
		const causeMessage = cause instanceof Error && typeof cause.message === "string" ? cause.message : "";
		const reason = typeof code === "string" && code !== "" ? code : causeMessage;
		const message = typeof failure.message === "string" ? failure.message : "";
		return collapseWhitespace([message, reason].filter((part) => part !== "").join(": "));
	} catch {
		return "";
	}
}
