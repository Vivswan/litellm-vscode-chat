import * as l10n from "@vscode/l10n";
import { CONFIG_SECTION } from "../../shared/config/settingSpec";
import { displayUrl } from "../../shared/util/displayUrl";
import { collapseWhitespace } from "../../shared/util/errorText";
import { fingerprint } from "../../shared/util/fingerprint";
import { isValidHeaderValue } from "../../shared/util/headers";
import { isRecord } from "../../shared/util/json";
import { sleepUnlessAborted } from "../../shared/util/timer";
import { DISCOVERY_MAX_RETRIES } from "../catalog/discovery";
import {
	type MapErrorContext,
	RequestError,
	socketFailureIsTimeout,
	socketFailureRequestError,
	twoPartTexts,
} from "./errorMapping";

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
 * A hard time bound together with the identity of the setting that owns it,
 * minted at the ONE place the number is read from configuration (or fixed in
 * code) and passed through as a unit. Timeout advice renders from `setting`,
 * so it can never name a setting that does not govern the elapsed clock -
 * the drift a caller-side table of budget choices once shipped. `setting` is
 * required but may be undefined: a fixed bound no setting can raise states
 * that explicitly instead of omitting it.
 */
export interface TimeoutBudget {
	readonly ms: number;
	readonly setting: "chat.timeout" | "discovery.timeout" | undefined;
}

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
	 * The cached token until it is due for refresh, else a fresh exchange bounded by `budget` (whose setting
	 * identity is what timeout advice names, or none) and, when given, by `signal`. Concurrent calls for the
	 * same credentials share ONE live exchange, yet every waiter's bounds and error surface stay its own.
	 *
	 *   a joiner's clock or `signal` fires -> only its own wait ends; the exchange continues for the others
	 *   the shared exchange fails          -> each waiter renders it through its OWN surface
	 *   it died of its ORIGINATOR's bounds -> joiners never render a bound they did not own; they fall through to a
	 *                                         fresh join or exchange on its own fresh `budget` (join wait + one budget)
	 */
	async getToken(
		config: OAuthConfig,
		surface: OAuthErrorSurface,
		budget: TimeoutBudget,
		signal?: AbortSignal
	): Promise<string> {
		try {
			return await this.acquireToken(config, budget, signal);
		} catch (error) {
			// The ONE render boundary: a surface-free exchange failure becomes
			// this caller's error here, so the carrier cannot escape by
			// construction; cancellation reasons and already-rendered errors pass
			// through unchanged.
			throw error instanceof OAuthExchangeFailure ? error.render(surface) : error;
		}
	}

	/** getToken's acquisition walk; exchange failures may leave here as surface-free OAuthExchangeFailure carriers. */
	private async acquireToken(config: OAuthConfig, budget: TimeoutBudget, signal?: AbortSignal): Promise<string> {
		const key = oauthCredentialFingerprint(config);
		const cached = this.tokens.get(key);
		if (cached && Date.now() < cached.refreshAtMs) {
			return cached.accessToken;
		}
		// This waiter's OWN clock and signal. They bound every JOIN wait and gate
		// every pass of the loop; an exchange this waiter originates runs on its
		// own fresh budget instead (see getToken's doc). Neither cancels a shared
		// exchange for its other waiters.
		const waitTimeout = AbortSignal.timeout(budget.ms);
		const waitSignal = signal !== undefined ? AbortSignal.any([waitTimeout, signal]) : waitTimeout;
		for (;;) {
			// Re-read on every pass: a fall-through below may find the token a
			// racing caller cached since this waiter last looked.
			const fresh = this.tokens.get(key);
			if (fresh && Date.now() < fresh.refreshAtMs) {
				return fresh.accessToken;
			}
			// The caller's own abort outranks its elapsed clock when both have
			// fired: an abort the caller asked for must not be relabeled a token
			// timeout (the exchange applies the same rule). Checked ahead of the
			// join AND the originate branch, so a waiter whose own bounds fired
			// never starts a fresh exchange either.
			if (signal?.aborted) {
				throw abortReason(signal);
			}
			if (waitTimeout.aborted) {
				throw timeoutError(config.tokenUrl, budget);
			}
			const inFlight = this.pending.get(key);
			if (inFlight === undefined) {
				const exchange = (async () => {
					try {
						const { accessToken, expiresInSeconds } = await exchangeClientCredentials(config, budget, signal);
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
			try {
				return await abortableWait(inFlight, waitSignal);
			} catch (error) {
				if (error instanceof OAuthExchangeFailure) {
					if (!error.originatorBound) {
						throw error;
					}
					// The exchange died of its originator's clock - a bound that was
					// never this waiter's, so neither the elapsed ms nor any setting
					// advice would be truthful here. Recover below instead.
				} else {
					if (signal?.aborted) {
						throw abortReason(signal);
					}
					if (waitTimeout.aborted) {
						throw timeoutError(config.tokenUrl, budget, error);
					}
					// The exchange rejects non-carriers only when its originator's
					// own cancellation interrupted it - and either way, a reason
					// that is not this waiter's own is not its to surface.
				}
				// Fall through: serve the token a racing caller may have cached
				// since, join a newer exchange, or originate a fresh one - each
				// pass still gated by this waiter's own bounds above.
			}
		}
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
 * `render` mints a fresh RequestError per waiter, since N waiters must never share one error object.
 * `originatorBound` marks a death by the ORIGINATING caller's clock, the one failure whose elapsed ms and
 * setting advice are truthful for the originator alone, so joiners recover instead of rendering it.
 */
class OAuthExchangeFailure extends Error {
	constructor(
		readonly render: (surface: OAuthErrorSurface) => RequestError,
		readonly originatorBound: boolean = false
	) {
		super("OAuth token exchange failed");
		this.name = "OAuthExchangeFailure";
	}
}

/**
 * The advice rides the TimeoutBudget minted where the number was read, so it cannot drift from the budget
 * choice, and an undefined `setting` (the fixed inline-completion bound) gets none, since advising a setting
 * that cannot extend the bound is a lie. The switch is exhaustive on purpose; a ladder's fall-through would misattribute a new setting.
 */
function timeoutError(tokenUrl: string, budget: TimeoutBudget, cause?: unknown): RequestError {
	const url = displayUrl(tokenUrl);
	// English mirrors ride each construction for the output channel and the
	// issue-report buffer; the display message localizes.
	switch (budget.setting) {
		case undefined:
			return new RequestError(l10n.t("OAuth token request to {0} timed out after {1}ms.", url, budget.ms), "timeout", {
				cause,
				englishMessage: `OAuth token request to ${url} timed out after ${budget.ms}ms.`,
			});
		case "chat.timeout":
			return new RequestError(
				l10n.t(
					'OAuth token request to {0} timed out after {1}ms. Increase the "{2}.chat.timeout" setting if your identity provider needs more time.',
					url,
					budget.ms,
					CONFIG_SECTION
				),
				"timeout",
				{
					cause,
					englishMessage: `OAuth token request to ${url} timed out after ${budget.ms}ms. Increase the "${CONFIG_SECTION}.chat.timeout" setting if your identity provider needs more time.`,
				}
			);
		case "discovery.timeout":
			return new RequestError(
				l10n.t(
					'OAuth token request to {0} timed out after {1}ms. Increase the "{2}.discovery.timeout" setting if your identity provider needs more time.',
					url,
					budget.ms,
					CONFIG_SECTION
				),
				"timeout",
				{
					cause,
					englishMessage: `OAuth token request to ${url} timed out after ${budget.ms}ms. Increase the "${CONFIG_SECTION}.discovery.timeout" setting if your identity provider needs more time.`,
				}
			);
		default:
			return budget.setting satisfies never;
	}
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
	// Each malformed shape throws a localized headline over a fixed English
	// detail line; these errors carry no logClassification, so the
	// byte-faithful English mirror is what the diagnostics surfaces render.
	if (!isRecord(parsed) || typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
		const detail = `OAuth token endpoint ${displayUrl(tokenUrl)} answered 2xx without JSON containing a non-empty access_token.`;
		throw new OAuthExchangeFailure((surface) => {
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
			return new RequestError(texts.message, "http", { englishMessage: texts.englishMessage });
		});
	}
	if (!isValidHeaderValue(parsed.access_token)) {
		const detail = `OAuth token from ${displayUrl(tokenUrl)} contains characters not allowed in an HTTP header value (control characters or non-Latin-1 text); the token was not sent, and its value is never shown or logged.`;
		throw new OAuthExchangeFailure((surface) => {
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
			return new RequestError(texts.message, "http", { englishMessage: texts.englishMessage });
		});
	}
	return { accessToken: parsed.access_token, expiresInSeconds: tokenLifetimeSeconds(parsed) };
}

/**
 * Retries like the discovery GETs because the exchange is idempotent, under `budget.ms` as a hard bound
 * across all attempts. Every concurrent getToken caller shares this exchange, so non-cancellation failures
 * leave surface-free as OAuthExchangeFailure, while a `signal` abort rethrows as-is so the caller attributes it truthfully.
 */
async function exchangeClientCredentials(
	config: OAuthConfig,
	budget: TimeoutBudget,
	outerSignal?: AbortSignal
): Promise<{ accessToken: string; expiresInSeconds: number }> {
	const timeoutSignal = AbortSignal.timeout(budget.ms);
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
				const failure = lastFailure;
				throw new OAuthExchangeFailure(
					(surface) =>
						timeoutError(
							config.tokenUrl,
							budget,
							failure instanceof OAuthExchangeFailure ? failure.render(surface) : failure
						),
					true
				);
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
				throw new OAuthExchangeFailure(() => timeoutError(config.tokenUrl, budget, error), true);
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
			// `idpDetail` quotes the IdP's error/error_description
			// (response-derived), so it rides only the message and its English
			// mirror; the classification is what public surfaces record.
			const detailLine = collapseWhitespace(
				`OAuth token endpoint ${status} at ${displayUrl(config.tokenUrl)}${idpDetail === "" ? "" : `: ${idpDetail}`}`
			);
			lastFailure = new OAuthExchangeFailure((surface) => {
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
				return new RequestError(texts.message, "http", {
					status,
					logClassification: `RequestError(http, status ${status}, oauth token endpoint)`,
					englishMessage: texts.englishMessage,
					oauthTokenEndpoint: true,
				});
			});
			continue;
		}
		if (status === 400 || status === 401 || status === 403) {
			// Same: the IdP detail can carry correlation IDs and tenant text.
			const detailLine = collapseWhitespace(
				`OAuth ${status} at ${displayUrl(config.tokenUrl)}${idpDetail === "" ? "" : `: ${idpDetail}`}`
			);
			throw new OAuthExchangeFailure((surface) => {
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
				return new RequestError(texts.message, "auth", {
					status,
					logClassification: `RequestError(auth, status ${status}, oauth token endpoint)`,
					englishMessage: texts.englishMessage,
					oauthTokenEndpoint: true,
				});
			});
		}
		const detailLine = collapseWhitespace(
			`OAuth token endpoint ${status} at ${displayUrl(config.tokenUrl)}${idpDetail === "" ? "" : `: ${idpDetail}`}`
		);
		throw new OAuthExchangeFailure((surface) => {
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
			return new RequestError(texts.message, "http", {
				status,
				logClassification: `RequestError(http, status ${status}, oauth token endpoint)`,
				englishMessage: texts.englishMessage,
				oauthTokenEndpoint: true,
			});
		});
	}

	if (lastFailure instanceof OAuthExchangeFailure) {
		throw lastFailure;
	}
	// The shared socket-failure classifier: identical kind and cause-detail
	// rules as the chat and discovery transports, with token-endpoint advice.
	// Its timeout arm renders this exchange's own budget message, a number and
	// setting only the exchange's originator owns - so a timeout-flavored
	// failure marks the carrier originatorBound and joiners recover instead.
	// The exchange's signal-governed timeouts have already thrown above.
	const failure = lastFailure;
	throw new OAuthExchangeFailure(
		(surface) =>
			socketFailureRequestError(failure, failure, { endpoint: "oauthToken", surface, url: config.tokenUrl }, () =>
				timeoutError(config.tokenUrl, budget, failure)
			),
		socketFailureIsTimeout(failure)
	);
}
