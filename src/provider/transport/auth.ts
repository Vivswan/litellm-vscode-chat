import * as l10n from "@vscode/l10n";
import { CONFIG_SECTION } from "../../shared/config/settingSpec";
import { displayUrl } from "../../shared/util/displayUrl";
import { collapseWhitespace } from "../../shared/util/errorText";
import { fingerprint } from "../../shared/util/fingerprint";
import { isValidHeaderValue } from "../../shared/util/headers";
import { isRecord } from "../../shared/util/json";
import { sleepUnlessAborted } from "../../shared/util/timer";
import { DISCOVERY_MAX_RETRIES } from "../catalog/discovery";
import { type MapErrorContext, RequestError, socketFailureRequestError, twoPartTexts } from "./errorMapping";

/**
 * OAuth2 client-credentials authentication for gateways behind an identity
 * provider: the extension exchanges a client ID and secret at a token endpoint
 * for a short-lived bearer token and sends it as the Authorization header on
 * every request to the server.
 *
 * Error ownership follows the transport-module convention: construct and throw
 * without logging. Token values and client secrets never appear in any message.
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
 * Which caller's error surface renders a token failure: the exchange is the
 * same on every path, but the two-part message join differs, so every token
 * request states the surface it fails toward.
 */
export type OAuthErrorSurface = MapErrorContext["surface"];

/**
 * Non-secret identity of a credential set: what makes OAuth credentials "the
 * same". Rotating any part (secret included) changes the key, so caches keyed
 * by it self-invalidate. JSON-encoded before hashing: the fields are free-form
 * strings, so a delimiter join would let two different credential sets
 * serialize identically and share a cached token.
 */
export function oauthCredentialFingerprint(config: OAuthConfig): string {
	// The satisfies clause breaks the build when a field is added without
	// extending `parts`, so every OAuthConfig field participates in the identity.
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
	 * exchange bounded by `timeoutMs` (the calling transport's budget: the
	 * discovery timeout on the chat and discovery paths, the one-shot callers'
	 * whole-call budgets) and, when given, by `signal`. A caller that joins an exchange another call started
	 * shares that call's bounds and surface shape, except that its own signal
	 * still stops its wait while the shared exchange continues for the others.
	 */
	async getToken(
		config: OAuthConfig,
		surface: OAuthErrorSurface,
		timeoutMs: number,
		signal?: AbortSignal
	): Promise<string> {
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
				const { accessToken, expiresInSeconds } = await exchangeClientCredentials(config, surface, timeoutMs, signal);
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
	 * Drop the cached token after the server rejected it, so the next request
	 * performs a fresh exchange; the rejected call itself is never retried.
	 * When the rejected token is known and a fresh one has already replaced it,
	 * the fresh token is kept: a straggling 401 earned by the old token must
	 * not discard its successor.
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

/**
 * Which setting actually bounds the OAuth exchange on each surface, because
 * `timeoutMs` is whatever the calling transport passed: the chat and discovery
 * paths both bound the exchange by "discovery.timeout" (auth plumbing with its
 * own budget, even when a chat triggers it), the one-shot chat callers pass
 * their "chat.timeout" whole-call budget through, and the inline-completion
 * call passes the fixed FIM bound no setting can raise - so that surface names
 * none.
 *
 * A total Record rather than a branch ladder: a ladder's fall-through silently
 * hands a new surface discovery's advice, which is advice to raise a setting
 * that does not bound it. This does not compile until a new surface says which
 * bound is its own.
 */
const OAUTH_EXCHANGE_BOUND: Record<OAuthErrorSurface, "chat" | "discovery" | "fixed"> = {
	chat: "discovery",
	discovery: "discovery",
	completion: "fixed",
	commitGeneration: "chat",
	consultTool: "chat",
	prGeneration: "chat",
	quickFix: "chat",
	reviewComments: "chat",
};

/** The exchange-timeout advice, naming the surface's true bound (see OAUTH_EXCHANGE_BOUND). */
function timeoutError(tokenUrl: string, surface: OAuthErrorSurface, timeoutMs: number, cause?: unknown): RequestError {
	const url = displayUrl(tokenUrl);
	const bound = OAUTH_EXCHANGE_BOUND[surface];
	// English mirrors ride each construction for the output channel and the
	// issue-report buffer; the display message localizes.
	if (bound === "fixed") {
		return new RequestError(l10n.t("OAuth token request to {0} timed out after {1}ms.", url, timeoutMs), "timeout", {
			cause,
			englishMessage: `OAuth token request to ${url} timed out after ${timeoutMs}ms.`,
		});
	}
	if (bound === "chat") {
		return new RequestError(
			l10n.t(
				'OAuth token request to {0} timed out after {1}ms. Increase the "{2}.chat.timeout" setting if your identity provider needs more time.',
				url,
				timeoutMs,
				CONFIG_SECTION
			),
			"timeout",
			{
				cause,
				englishMessage: `OAuth token request to ${url} timed out after ${timeoutMs}ms. Increase the "${CONFIG_SECTION}.chat.timeout" setting if your identity provider needs more time.`,
			}
		);
	}
	return new RequestError(
		l10n.t(
			'OAuth token request to {0} timed out after {1}ms. Increase the "{2}.discovery.timeout" setting if your identity provider needs more time.',
			url,
			timeoutMs,
			CONFIG_SECTION
		),
		"timeout",
		{
			cause,
			englishMessage: `OAuth token request to ${url} timed out after ${timeoutMs}ms. Increase the "${CONFIG_SECTION}.discovery.timeout" setting if your identity provider needs more time.`,
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

function parseTokenResponse(
	payload: string,
	tokenUrl: string,
	surface: OAuthErrorSurface
): { accessToken: string; expiresInSeconds: number } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		parsed = undefined;
	}
	// Each malformed shape throws a localized headline over a fixed English
	// detail line; these errors carry no logClassification, so the
	// byte-faithful English mirror is what the diagnostics surfaces render.
	if (!isRecord(parsed) || typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
		const detail = `OAuth token endpoint ${displayUrl(tokenUrl)} answered 2xx without JSON containing a non-empty access_token.`;
		const texts = twoPartTexts(
			surface,
			{
				display: l10n.t(
					"The identity provider answered but didn't return a usable access token - check that the OAuth token URL points at an OAuth2 token endpoint, not a login or SSO page."
				),
				english:
					"The identity provider answered but didn't return a usable access token - check that the OAuth token URL points at an OAuth2 token endpoint, not a login or SSO page.",
			},
			detail
		);
		throw new RequestError(texts.message, "http", { englishMessage: texts.englishMessage });
	}
	if (!isValidHeaderValue(parsed.access_token)) {
		const detail = `OAuth token from ${displayUrl(tokenUrl)} contains characters not allowed in an HTTP header value (control characters or non-Latin-1 text); the token was not sent, and its value is never shown or logged.`;
		const texts = twoPartTexts(
			surface,
			{
				display: l10n.t(
					"The identity provider returned an access token the extension can't use - check the OAuth token endpoint configuration for this server."
				),
				english:
					"The identity provider returned an access token the extension can't use - check the OAuth token endpoint configuration for this server.",
			},
			detail
		);
		throw new RequestError(texts.message, "http", { englishMessage: texts.englishMessage });
	}
	return { accessToken: parsed.access_token, expiresInSeconds: tokenLifetimeSeconds(parsed) };
}

/**
 * POST the client-credentials grant to the token endpoint. Network failures
 * and 5xx responses are retried up to the discovery cap because the exchange
 * is idempotent; `timeoutMs` is a hard bound across all attempts, and an abort
 * of the caller's `signal` interrupts the exchange and is rethrown as-is so
 * the caller attributes it truthfully. Credential rejections (400/401/403) and
 * malformed responses fail immediately with distinct messages.
 */
async function exchangeClientCredentials(
	config: OAuthConfig,
	surface: OAuthErrorSurface,
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
				throw timeoutError(config.tokenUrl, surface, timeoutMs, lastFailure);
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
				throw timeoutError(config.tokenUrl, surface, timeoutMs, error);
			}
			lastFailure = error;
			continue;
		}

		if (response.ok) {
			return parseTokenResponse(payload, config.tokenUrl, surface);
		}
		const { status } = response;
		const idpDetail = oauthErrorDetail(payload, config.clientSecret);
		if (status >= 500) {
			// `idpDetail` quotes the IdP's error/error_description
			// (response-derived), so it rides only the message and its English
			// mirror; the classification is what public surfaces record.
			const detailLine = collapseWhitespace(
				`OAuth token endpoint ${status} at ${displayUrl(config.tokenUrl)}${idpDetail === "" ? "" : `: ${idpDetail}`}`
			);
			const texts = twoPartTexts(
				surface,
				{
					display: l10n.t(
						"The identity provider had a server problem, so the extension could not get an access token. It already retried; try again in a moment or contact the identity provider's administrator."
					),
					english:
						"The identity provider had a server problem, so the extension could not get an access token. It already retried; try again in a moment or contact the identity provider's administrator.",
				},
				detailLine
			);
			lastFailure = new RequestError(texts.message, "http", {
				status,
				logClassification: `RequestError(http, status ${status}, oauth token endpoint)`,
				englishMessage: texts.englishMessage,
				oauthTokenEndpoint: true,
			});
			continue;
		}
		if (status === 400 || status === 401 || status === 403) {
			// Same: the IdP detail can carry correlation IDs and tenant text.
			const detailLine = collapseWhitespace(
				`OAuth ${status} at ${displayUrl(config.tokenUrl)}${idpDetail === "" ? "" : `: ${idpDetail}`}`
			);
			const texts = twoPartTexts(
				surface,
				{
					display: l10n.t(
						"The identity provider refused to issue a token for this server - check the OAuth client ID, client secret, and scopes in the server entry."
					),
					english:
						"The identity provider refused to issue a token for this server - check the OAuth client ID, client secret, and scopes in the server entry.",
				},
				detailLine
			);
			throw new RequestError(texts.message, "auth", {
				status,
				logClassification: `RequestError(auth, status ${status}, oauth token endpoint)`,
				englishMessage: texts.englishMessage,
				oauthTokenEndpoint: true,
			});
		}
		const detailLine = collapseWhitespace(
			`OAuth token endpoint ${status} at ${displayUrl(config.tokenUrl)}${idpDetail === "" ? "" : `: ${idpDetail}`}`
		);
		const texts = twoPartTexts(
			surface,
			{
				display: l10n.t(
					"The OAuth token endpoint gave an unexpected answer. Check the OAuth token URL in this server's settings."
				),
				english:
					"The OAuth token endpoint gave an unexpected answer. Check the OAuth token URL in this server's settings.",
			},
			detailLine
		);
		throw new RequestError(texts.message, "http", {
			status,
			logClassification: `RequestError(http, status ${status}, oauth token endpoint)`,
			englishMessage: texts.englishMessage,
			oauthTokenEndpoint: true,
		});
	}

	if (lastFailure instanceof RequestError) {
		throw lastFailure;
	}
	// The shared socket-failure classifier: identical kind and cause-detail
	// rules as the chat and discovery transports, with token-endpoint advice.
	// Its timeout arm renders this exchange's own budget message; the exchange's
	// signal-governed timeouts have already thrown above.
	throw socketFailureRequestError(
		lastFailure,
		lastFailure,
		{ endpoint: "oauthToken", surface, url: config.tokenUrl },
		() => timeoutError(config.tokenUrl, surface, timeoutMs, lastFailure)
	);
}
