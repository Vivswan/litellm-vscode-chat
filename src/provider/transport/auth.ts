import * as l10n from "@vscode/l10n";
import { CONFIG_SECTION } from "../../shared/config/settingSpec";
import { Logger } from "../../shared/logger";
import { collapseWhitespace } from "../../shared/util/errorText";
import { fingerprint } from "../../shared/util/fingerprint";
import { type HeaderValue, headerValue } from "../../shared/util/headers";
import { isRecord } from "../../shared/util/json";
import { sleepUnlessAborted } from "../../shared/util/timer";
import { DISCOVERY_MAX_RETRIES } from "../catalog/discovery";
import { type MapErrorContext, RequestError, socketFailureRequestError, twoPartTexts } from "./transportErrors";

/** Error ownership follows the transport-module convention: construct and throw without logging. */

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
	value: HeaderValue;
}

/**
 * Which caller's error surface renders a token failure: the exchange is the same on every path, but the two-part
 * message join differs, so every token request states the surface it fails toward.
 */
export type OAuthErrorSurface = MapErrorContext["surface"];

/**
 * A hard time bound together with the identity of the setting that owns it, minted at the ONE place the number is read
 * from configuration (or fixed in code) and passed through as a unit.
 *
 * `setting` is required but may be undefined: a fixed bound no setting can raise states that explicitly instead of
 * omitting it.
 *
 *   Timeout advice renders from `setting` -> it can never name a setting that does not govern the elapsed clock
 */
export interface TimeoutBudget {
	readonly ms: number;
	readonly setting: "chat.timeout" | "discovery.timeout" | undefined;
}

/**
 * JSON-encoded before hashing: the fields are free-form strings, so a delimiter join would let two different credential
 * sets serialize identically and share a cached token.
 */
export function oauthCredentialFingerprint(config: OAuthConfig): string {
	const parts = {
		tokenUrl: config.tokenUrl,
		clientId: config.clientId,
		clientSecret: config.clientSecret,
		scopes: config.scopes ?? "",
	} satisfies Record<keyof OAuthConfig, string>;
	return fingerprint(JSON.stringify(parts));
}

/** Clamped to half the lifetime so short-lived tokens still spend some of their life cached. */
const REFRESH_SKEW_MS = 60_000;

/** Applied when the token response omits expires_in (RFC 6749 only recommends it). */
const DEFAULT_EXPIRES_IN_SECONDS = 300;

const RETRY_DELAY_MS = 200;

interface CachedToken {
	accessToken: HeaderValue;
	refreshAtMs: number;
}

/** The one in-flight exchange for a credential set. It runs exactly as long as at least one caller awaits it. */
interface SharedExchange {
	readonly token: Promise<HeaderValue>;
	readonly abandon: () => void;
	waiters: number;
}

export class OAuthTokenSource {
	private readonly tokens = new Map<string, CachedToken>();
	private readonly exchanges = new Map<string, SharedExchange>();

	/**
	 * No caller's bounds reach the exchange: it is abandoned only when its last waiter leaves, so a waiter never
	 * renders a bound or a cancellation that was not its own.
	 */
	async getToken(
		config: OAuthConfig,
		surface: OAuthErrorSurface,
		budget: TimeoutBudget,
		signal?: AbortSignal
	): Promise<HeaderValue> {
		const key = oauthCredentialFingerprint(config);
		const cached = this.tokens.get(key);
		if (cached && Date.now() < cached.refreshAtMs) {
			return cached.accessToken;
		}
		if (signal?.aborted) {
			throw abortReason(signal);
		}
		const ownClock = AbortSignal.timeout(budget.ms);
		const ownBounds = signal !== undefined ? AbortSignal.any([signal, ownClock]) : ownClock;
		const exchange = this.exchanges.get(key) ?? this.startExchange(key, config);
		exchange.waiters += 1;
		try {
			return await abortableWait(exchange.token, ownBounds);
		} catch (error) {
			if (error instanceof OAuthExchangeFailure) {
				throw error.render(surface, budget);
			}
			if (signal?.aborted) {
				throw abortReason(signal);
			}
			if (ownClock.aborted) {
				throw timeoutError(config.tokenUrl, budget, ownClock.reason);
			}
			throw error;
		} finally {
			exchange.waiters -= 1;
			if (exchange.waiters === 0) {
				this.forget(key, exchange);
				exchange.abandon();
			}
		}
	}

	private startExchange(key: string, config: OAuthConfig): SharedExchange {
		const controller = new AbortController();
		const exchange: SharedExchange = {
			waiters: 0,
			abandon: () => controller.abort(),
			// A settled exchange is never joinable: both arms leave the map before they settle.
			//   fulfilled -> cache the token -> forget -> resolve
			//   rejected  -> forget -> rethrow
			token: exchangeClientCredentials(config, controller.signal).then(
				({ accessToken, expiresInSeconds }) => {
					const lifetimeMs = expiresInSeconds * 1000;
					const skewMs = Math.min(REFRESH_SKEW_MS, lifetimeMs / 2);
					this.tokens.set(key, { accessToken, refreshAtMs: Date.now() + lifetimeMs - skewMs });
					this.forget(key, exchange);
					return accessToken;
				},
				(error: unknown) => {
					this.forget(key, exchange);
					throw error;
				}
			),
		};
		// An abandoned exchange rejects after its last waiter has already left.
		exchange.token.catch(() => undefined);
		this.exchanges.set(key, exchange);
		return exchange;
	}

	/** A settled or abandoned exchange leaves the map; a successor already in its place stays. */
	private forget(key: string, exchange: SharedExchange): void {
		if (this.exchanges.get(key) === exchange) {
			this.exchanges.delete(key);
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

/** `signal` ends only this wait; the promise runs on for its other awaiters. */
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

/** A surface-free exchange failure; `render` mints a fresh RequestError per waiter, so waiters never share one. */
class OAuthExchangeFailure extends Error {
	constructor(readonly render: (surface: OAuthErrorSurface, budget: TimeoutBudget) => RequestError) {
		super("OAuth token exchange failed");
		this.name = "OAuthExchangeFailure";
	}
}

/**
 * The advice rides the TimeoutBudget minted where the number was read, so it cannot drift from the budget
 * choice, and an undefined `setting` (the fixed inline-completion bound) gets none, since advising a setting
 * that cannot extend the bound is a lie.
 */
function timeoutError(url: string, budget: TimeoutBudget, cause?: unknown): RequestError {
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
 * Never the raw body: it is untrusted and can be huge. The IdP's fields enter the extension here, so each is masked
 * as it is read, again after the collapse (which can respell a value), and only then capped.
 */
function oauthErrorDetail(payload: string): string {
	try {
		const parsed: unknown = JSON.parse(payload);
		if (isRecord(parsed)) {
			const parts = [parsed.error, parsed.error_description]
				.filter((part): part is string => typeof part === "string" && part.length > 0)
				.map((part) => Logger.redact(part));
			if (parts.length > 0) {
				return Logger.redact(collapseWhitespace(parts.join(": "))).slice(0, 200);
			}
		}
	} catch {
		// A non-JSON error body carries no detail worth surfacing.
	}
	return "";
}

/**
 * The token lifetime in seconds: the advertised expires_in, a conservative default when the field is absent, and zero
 * (already due for refresh, so never served from cache) when it is present but zero, negative, or unparseable.
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

function parseTokenResponse(payload: string, tokenUrl: string): { accessToken: HeaderValue; expiresInSeconds: number } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		parsed = undefined;
	}
	// Each malformed shape throws a localized headline over a fixed English detail line; these errors carry no
	// logClassification, so the byte-faithful English mirror is what the diagnostics surfaces render.
	const record = isRecord(parsed) ? parsed : undefined;
	const rawToken = typeof record?.access_token === "string" ? record.access_token : undefined;
	const accessToken = rawToken === undefined ? undefined : headerValue(rawToken);
	if (record === undefined || rawToken === undefined || accessToken?.length === 0) {
		const detail = `OAuth token endpoint ${tokenUrl} answered 2xx without JSON containing a non-empty access_token.`;
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
	if (accessToken === undefined) {
		const detail = `OAuth token from ${tokenUrl} contains characters not allowed in an HTTP header value (control characters or non-Latin-1 text); the token was not sent, and its value is never shown or logged.`;
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
	return { accessToken, expiresInSeconds: tokenLifetimeSeconds(record) };
}

/**
 * Retries like the discovery GETs, because the grant is idempotent. `signal` is the shared exchange's own
 * abandonment, never a caller's, so every failure leaves surface-free for each waiter to render as its own.
 */
async function exchangeClientCredentials(
	config: OAuthConfig,
	signal: AbortSignal
): Promise<{ accessToken: HeaderValue; expiresInSeconds: number }> {
	const form = new URLSearchParams({
		grant_type: "client_credentials",
		client_id: config.clientId,
		// RFC 6749 2.3.1: public clients authenticate with the client ID alone.
		...(config.clientSecret.length > 0 ? { client_secret: config.clientSecret } : {}),
		...(config.scopes !== undefined ? { scope: config.scopes } : {}),
	});

	let lastFailure: unknown;
	for (let attempt = 0; attempt <= DISCOVERY_MAX_RETRIES; attempt += 1) {
		if (attempt > 0) {
			await sleepUnlessAborted(RETRY_DELAY_MS * attempt, signal);
			if (signal.aborted) {
				throw abortReason(signal);
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
			if (signal.aborted) {
				throw error;
			}
			lastFailure = error;
			continue;
		}

		if (response.ok) {
			return parseTokenResponse(payload, config.tokenUrl);
		}
		const { status } = response;
		const idpDetail = oauthErrorDetail(payload);
		if (status >= 500) {
			// `idpDetail` quotes the IdP's error/error_description (response-derived), so it rides only the message and
			// its English mirror; the classification is what public surfaces record.
			const detailLine = collapseWhitespace(
				`OAuth token endpoint ${status} at ${config.tokenUrl}${idpDetail === "" ? "" : `: ${idpDetail}`}`
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
				`OAuth ${status} at ${config.tokenUrl}${idpDetail === "" ? "" : `: ${idpDetail}`}`
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
			`OAuth token endpoint ${status} at ${config.tokenUrl}${idpDetail === "" ? "" : `: ${idpDetail}`}`
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
	const failure = lastFailure;
	throw new OAuthExchangeFailure((surface, budget) =>
		socketFailureRequestError(failure, failure, { endpoint: "oauthToken", surface, url: config.tokenUrl }, () =>
			timeoutError(config.tokenUrl, budget, failure)
		)
	);
}
