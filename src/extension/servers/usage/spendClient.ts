/**
 * The spend client: authenticated GETs to a LiteLLM server's usage endpoints.
 * Unlike discovery these sit at the server ROOT, not under /v1, so the SDK
 * client (rooted at `${baseUrl}/v1`) cannot serve them and the transport is a
 * plain fetch reusing the provider's header precedence (buildDefaultHeaders)
 * plus the OAuth and virtual-key overlays the chat path applies per request.
 *
 * Transport conventions match discovery: idempotent GETs retry up to
 * DISCOVERY_MAX_RETRIES on network failures and 5xx, the discovery timeout is
 * a hard whole-call bound, and errors are constructed specific and thrown
 * WITHOUT logging (the poller boundary logs one classification). Usage
 * responses embed hashed key material, aliases, and user IDs, so no error
 * message or log line ever carries response-derived text - not even the
 * truncated snippets discovery allows itself.
 *
 * Parsing is lenient field-by-field: every retained value is a number, an
 * epoch timestamp, a YYYY-MM-DD day key, or a pattern-validated duration
 * token, so nothing response-derived can ride into the store (whose contents
 * later reach the dashboard webview).
 */

import { l10n } from "vscode";
import { DISCOVERY_MAX_RETRIES } from "../../../provider/catalog/discovery";
import type { OAuthConfig, VirtualKeyConfig } from "../../../provider/transport/auth";
import { OAuthTokenSource } from "../../../provider/transport/auth";
import { buildDefaultHeaders } from "../../../provider/transport/clients";
import { RequestError } from "../../../provider/transport/errorMapping";
import { CONFIG_SECTION } from "../../../shared/config/settingSpec";
import { getDiscoveryTimeout } from "../../../shared/config/settings";
import { normalizeBaseUrl } from "../../../shared/util/baseUrl";
import { isValidHeaderName, isValidHeaderValue } from "../../../shared/util/headers";
import { isRecord } from "../../../shared/util/json";
import { sleepUnlessAborted } from "../../../shared/util/timer";
import type { StoredServerSecrets } from "../serverSync/secrets";
import { inlineSecretValues } from "../serverSync/secrets";
import type { DeclaredServer } from "../serverSync/setting";

/** Usage endpoint paths, relative to the server root (NOT the /v1 API root). */
const KEY_INFO_PATH = "/key/info";
const USER_INFO_PATH = "/user/info";
const DAILY_ACTIVITY_PATH = "/user/daily/activity";

/** The absolute own-key info endpoint (no `key` param: the caller's own key). */
export function keyInfoUrl(baseUrl: string): string {
	return `${baseUrl}${KEY_INFO_PATH}`;
}

/** The absolute user-rollup endpoint; only called when the key carries a user. */
export function userInfoUrl(baseUrl: string): string {
	return `${baseUrl}${USER_INFO_PATH}`;
}

/** The absolute daily-activity endpoint; requests carry start_date/end_date. */
export function dailyActivityUrl(baseUrl: string): string {
	return `${baseUrl}${DAILY_ACTIVITY_PATH}`;
}

/**
 * One server's connection material for usage calls, fully resolved. Values
 * exist extension-side only; this shape is never logged.
 */
export interface UsageConnection {
	readonly label: string;
	readonly baseUrl: string;
	/** Empty string for keyless servers, matching the transport convention. */
	readonly apiKey: string;
	/** The entry's custom headers (there is no global headers setting); auth headers win conflicts. */
	readonly headers: Readonly<Record<string, string>>;
	readonly oauth?: OAuthConfig | undefined;
	readonly virtualKey?: VirtualKeyConfig | undefined;
}

/**
 * Resolve a declared entry's connection the way the sync engine resolves its
 * group args: inline settings values outrank the label's SecretStorage blob,
 * OAuth is one unit (token URL plus client ID; the request path drops partial
 * configurations silently), and the virtual key is both-or-neither AND must
 * be header-legal (an invalid name or value would make the platform's fetch
 * throw a TypeError embedding the full plaintext value - the same rule
 * narrowVirtualKey applies on the chat path). The base URL is normalized so
 * a trailing slash cannot double up in the endpoint paths (LiteLLM answers
 * `//key/info` with a 404, which would misclassify the server as
 * usage-unsupported).
 */
export function usageConnectionFor(entry: DeclaredServer, stored: StoredServerSecrets): UsageConnection {
	const inline = inlineSecretValues(entry);
	const secret = (field: keyof typeof inline): string | undefined => inline[field] ?? stored[field];
	const oauth: OAuthConfig | undefined =
		entry.oauthTokenUrl !== undefined && entry.oauthClientId !== undefined
			? {
					tokenUrl: entry.oauthTokenUrl,
					clientId: entry.oauthClientId,
					clientSecret: secret("oauthClientSecret") ?? "",
					...(entry.oauthScopes !== undefined ? { scopes: entry.oauthScopes } : {}),
				}
			: undefined;
	const virtualKeyValue = secret("virtualKeyValue");
	const virtualKey: VirtualKeyConfig | undefined =
		entry.virtualKeyHeader !== undefined &&
		virtualKeyValue !== undefined &&
		isValidHeaderName(entry.virtualKeyHeader) &&
		isValidHeaderValue(virtualKeyValue)
			? { header: entry.virtualKeyHeader, value: virtualKeyValue }
			: undefined;
	return {
		label: entry.label,
		baseUrl: normalizeBaseUrl(entry.baseUrl),
		apiKey: secret("apiKey") ?? "",
		headers: entry.headers ?? {},
		...(oauth !== undefined ? { oauth } : {}),
		...(virtualKey !== undefined ? { virtualKey } : {}),
	};
}

/** The caller's own key as /key/info reports it: budget and spend numbers only. */
export interface KeyUsage {
	readonly spend: number | undefined;
	readonly maxBudget: number | undefined;
	readonly softBudget: number | undefined;
	/** Epoch milliseconds; the reset cadence surfaces through this, so the raw budget_duration token (response-derived text) is never retained. */
	readonly budgetResetAt: number | undefined;
	/** Whether the key carries a user (gates the /user/info rollup call); the ID itself is never retained. */
	readonly hasUser: boolean;
}

/** One day of /user/daily/activity, every field a checked number. */
export interface UsageDay {
	/** YYYY-MM-DD, pattern-validated. */
	readonly date: string;
	readonly spend: number;
	readonly promptTokens: number;
	readonly completionTokens: number;
	readonly totalTokens: number;
	readonly apiRequests: number;
	readonly successfulRequests: number;
	readonly failedRequests: number;
	readonly cacheReadInputTokens: number;
	readonly cacheCreationInputTokens: number;
}

/** The numeric fields of UsageDay, summed over the window. */
export type UsageTotals = Omit<UsageDay, "date">;

/** The daily-activity window as fetched: recognized days plus their sums. */
export interface DailyUsage {
	readonly days: readonly UsageDay[];
	readonly totals: UsageTotals;
}

/** The user-level rollup /user/info reports when the key carries a user. */
export interface UserUsage {
	readonly spend: number | undefined;
	readonly maxBudget: number | undefined;
	/** Epoch milliseconds. */
	readonly budgetResetAt: number | undefined;
}

/** An inclusive day window in the YYYY-MM-DD form the endpoint expects. */
export interface ActivityWindow {
	readonly startDate: string;
	readonly endDate: string;
}

/**
 * The window ending today (UTC) and reaching back `days - 1` days, so a
 * 30-day window covers 30 calendar day buckets including today.
 */
export function activityWindow(nowMs: number, days: number): ActivityWindow {
	const dayMs = 24 * 60 * 60 * 1000;
	const format = (ms: number) => new Date(ms).toISOString().slice(0, 10);
	return { startDate: format(nowMs - (days - 1) * dayMs), endDate: format(nowMs) };
}

/**
 * Why a usage endpoint is permanently unavailable on a server, judged from
 * the thrown error: "unsupported" is the DB-less proxy answering 400/404 (or
 * a route the version lacks: 405/501), "forbidden" is a key the proxy will
 * not let read usage (401/403). Transient failures (network, timeout, 5xx)
 * return undefined: the next poll retries them, availability unchanged.
 */
export type UsageUnavailableReason = "unsupported" | "forbidden";

export function usageUnavailabilityOf(error: unknown): UsageUnavailableReason | undefined {
	if (!(error instanceof RequestError) || error.status === undefined) {
		return undefined;
	}
	// An OAuth token-endpoint rejection (auth.ts) fails BEFORE the usage
	// endpoint is called, so it proves nothing about the endpoint itself: it
	// stays transient rather than misattributing a "forbidden" standing.
	if (error.oauthTokenEndpoint === true) {
		return undefined;
	}
	if (error.status === 401 || error.status === 403) {
		return "forbidden";
	}
	return [400, 404, 405, 501].includes(error.status) ? "unsupported" : undefined;
}

const RETRY_DELAY_MS = 200;

/** A non-negative finite JSON number; spend and budgets are never negative, and zero is meaningful. */
function usageNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** An ISO timestamp string as epoch milliseconds; anything unparseable reads as absent. */
function usageEpochMs(value: unknown): number | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/** A calendar day key exactly as the activity endpoint buckets them. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseKeyUsage(payload: unknown): KeyUsage {
	const info = isRecord(payload) && isRecord(payload.info) ? payload.info : {};
	return {
		spend: usageNumber(info.spend),
		maxBudget: usageNumber(info.max_budget),
		softBudget: usageNumber(info.soft_budget),
		budgetResetAt: usageEpochMs(info.budget_reset_at),
		hasUser: typeof info.user_id === "string" && info.user_id.length > 0,
	};
}

function parseUserUsage(payload: unknown): UserUsage {
	const info = isRecord(payload) && isRecord(payload.user_info) ? payload.user_info : {};
	return {
		spend: usageNumber(info.spend),
		maxBudget: usageNumber(info.max_budget),
		budgetResetAt: usageEpochMs(info.budget_reset_at),
	};
}

const EMPTY_TOTALS: UsageTotals = {
	spend: 0,
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	apiRequests: 0,
	successfulRequests: 0,
	failedRequests: 0,
	cacheReadInputTokens: 0,
	cacheCreationInputTokens: 0,
};

function parseUsageDay(entry: unknown): UsageDay | undefined {
	if (!isRecord(entry) || typeof entry.date !== "string" || !DAY_PATTERN.test(entry.date)) {
		return undefined;
	}
	const metrics = isRecord(entry.metrics) ? entry.metrics : {};
	return {
		date: entry.date,
		spend: usageNumber(metrics.spend) ?? 0,
		promptTokens: usageNumber(metrics.prompt_tokens) ?? 0,
		completionTokens: usageNumber(metrics.completion_tokens) ?? 0,
		totalTokens: usageNumber(metrics.total_tokens) ?? 0,
		apiRequests: usageNumber(metrics.api_requests) ?? 0,
		successfulRequests: usageNumber(metrics.successful_requests) ?? 0,
		failedRequests: usageNumber(metrics.failed_requests) ?? 0,
		cacheReadInputTokens: usageNumber(metrics.cache_read_input_tokens) ?? 0,
		cacheCreationInputTokens: usageNumber(metrics.cache_creation_input_tokens) ?? 0,
	};
}

/**
 * Element-wise like discovery's narrowing: a malformed day drops itself, not
 * the window. Totals are summed here rather than trusted from the response
 * metadata, so the numbers always agree with the days shown.
 */
function parseDailyUsage(payload: unknown): DailyUsage {
	const results = isRecord(payload) && Array.isArray(payload.results) ? payload.results : [];
	const days = results
		.map(parseUsageDay)
		.filter((day): day is UsageDay => day !== undefined)
		.sort((a, b) => a.date.localeCompare(b.date));
	const totals = days.reduce<UsageTotals>(
		(sum, day) => ({
			spend: sum.spend + day.spend,
			promptTokens: sum.promptTokens + day.promptTokens,
			completionTokens: sum.completionTokens + day.completionTokens,
			totalTokens: sum.totalTokens + day.totalTokens,
			apiRequests: sum.apiRequests + day.apiRequests,
			successfulRequests: sum.successfulRequests + day.successfulRequests,
			failedRequests: sum.failedRequests + day.failedRequests,
			cacheReadInputTokens: sum.cacheReadInputTokens + day.cacheReadInputTokens,
			cacheCreationInputTokens: sum.cacheCreationInputTokens + day.cacheCreationInputTokens,
		}),
		EMPTY_TOTALS
	);
	return { days, totals };
}

function timeoutError(url: string, timeoutMs: number, cause?: unknown): RequestError {
	return new RequestError(
		l10n.t(
			'LiteLLM usage request to {0} timed out after {1}ms. Increase the "{2}.discovery.timeout" setting if your server needs more time.',
			url,
			timeoutMs,
			CONFIG_SECTION
		),
		"timeout",
		{
			cause,
			englishMessage: `LiteLLM usage request to ${url} timed out after ${timeoutMs}ms. Increase the "${CONFIG_SECTION}.discovery.timeout" setting if your server needs more time.`,
		}
	);
}

/**
 * A non-OK usage response as a classified error. The body is NEVER read into
 * the message (usage bodies embed hashed keys), so unlike discovery's mapped
 * errors these are template-only and need no logClassification.
 */
function usageHttpError(url: string, status: number): RequestError {
	if (status === 401 || status === 403) {
		return new RequestError(
			l10n.t(
				"LiteLLM usage request to {0} was rejected ({1}). The configured key may not be allowed to read usage data on this server.",
				url,
				status
			),
			"auth",
			{
				status,
				englishMessage: `LiteLLM usage request to ${url} was rejected (${status}). The configured key may not be allowed to read usage data on this server.`,
			}
		);
	}
	return new RequestError(
		l10n.t({
			message: "LiteLLM usage request to {0} failed: {1}",
			args: [url, status],
			comment: ["{1} is the HTTP status code the server answered with"],
		}),
		"http",
		{ status, englishMessage: `LiteLLM usage request to ${url} failed: ${status}` }
	);
}

export interface UsageClientOptions {
	readonly userAgent: string;
	/** The whole-call timeout read, injectable for tests; the default reads the live discovery.timeout setting. */
	readonly getTimeoutMs?: () => number;
	readonly log?: ((message: string, data?: unknown) => void) | undefined;
}

/**
 * Owns the HTTP side of usage polling: header composition (the provider's
 * precedence rule over the connection's per-entry headers, plus the
 * OAuth/virtual-key overlays), the whole-call timeout, and the
 * idempotent-GET retry budget. One instance per poller so OAuth tokens cache
 * across polls and invalidate on 401 exactly like the chat path.
 */
export class UsageClient {
	private readonly oauthTokens = new OAuthTokenSource();
	private readonly getTimeoutMs: () => number;

	constructor(private readonly options: UsageClientOptions) {
		this.getTimeoutMs = options.getTimeoutMs ?? (() => getDiscoveryTimeout(options.log));
	}

	async fetchKeyInfo(connection: UsageConnection, signal?: AbortSignal): Promise<KeyUsage> {
		return parseKeyUsage(await this.getJson(connection, keyInfoUrl(connection.baseUrl), signal));
	}

	async fetchDailyActivity(
		connection: UsageConnection,
		window: ActivityWindow,
		signal?: AbortSignal
	): Promise<DailyUsage> {
		const url = `${dailyActivityUrl(connection.baseUrl)}?${new URLSearchParams({
			start_date: window.startDate,
			end_date: window.endDate,
		}).toString()}`;
		return parseDailyUsage(await this.getJson(connection, url, signal));
	}

	async fetchUserInfo(connection: UsageConnection, signal?: AbortSignal): Promise<UserUsage> {
		return parseUserUsage(await this.getJson(connection, userInfoUrl(connection.baseUrl), signal));
	}

	/**
	 * The request headers for one call: the provider's static precedence over
	 * the connection's per-entry headers (custom headers, User-Agent, API-key
	 * ownership of the auth headers) plus the per-request credentials the chat
	 * path resolves the same way - the OAuth bearer token (skipped when the
	 * virtual key owns the Authorization header) and the virtual-key header.
	 * Returns the token that actually went out so a 401 can invalidate exactly
	 * it.
	 */
	private async resolveHeaders(
		connection: UsageConnection,
		timeoutMs: number,
		signal: AbortSignal
	): Promise<{ headers: Record<string, string>; sentOAuthToken: string | undefined }> {
		const base = buildDefaultHeaders({
			apiKey: connection.apiKey,
			userAgent: this.options.userAgent,
			customHeaders: { ...connection.headers },
		});
		const headers: Record<string, string> = {};
		for (const [name, value] of Object.entries(base)) {
			// A value the platform's Headers would reject must never reach fetch:
			// the thrown TypeError embeds the full plaintext value, and these
			// values can be secrets (the same guard the settings reader applies
			// to custom headers; this covers the API key too).
			if (value !== null && isValidHeaderValue(value)) {
				headers[name] = value;
			}
		}
		// Auth headers win conflicts case-insensitively, like the chat path:
		// this is a plain-object fetch, where two spellings of one header name
		// would COMBINE into "custom, Bearer ..." instead of replacing (the SDK
		// path gets replace semantics from its Headers merge).
		const setAuthHeader = (name: string, value: string) => {
			for (const existing of Object.keys(headers)) {
				if (existing.toLowerCase() === name.toLowerCase()) {
					delete headers[existing];
				}
			}
			headers[name] = value;
		};
		if (connection.apiKey && isValidHeaderValue(connection.apiKey)) {
			// The SDK's bearer auth adds this on the /v1 client; the plain fetch
			// states it explicitly. X-API-Key already rides in `base`.
			setAuthHeader("Authorization", `Bearer ${connection.apiKey}`);
		}
		let sentOAuthToken: string | undefined;
		const authorizationOverridden = connection.virtualKey?.header.toLowerCase() === "authorization";
		if (connection.oauth && !authorizationOverridden) {
			sentOAuthToken = await this.oauthTokens.getToken(connection.oauth, "discovery", timeoutMs, signal);
			setAuthHeader("Authorization", `Bearer ${sentOAuthToken}`);
		}
		if (connection.virtualKey) {
			setAuthHeader(connection.virtualKey.header, connection.virtualKey.value);
		}
		return { headers, sentOAuthToken };
	}

	/**
	 * One idempotent GET with the discovery retry rules: network failures and
	 * 5xx retry up to DISCOVERY_MAX_RETRIES, 4xx fail immediately, and the
	 * discovery timeout bounds the whole call including backoffs and the OAuth
	 * exchange. `outerSignal` (the poller's dispose) interrupts everything and
	 * is rethrown as-is so the caller attributes it truthfully.
	 */
	private async getJson(connection: UsageConnection, url: string, outerSignal?: AbortSignal): Promise<unknown> {
		const timeoutMs = this.getTimeoutMs();
		const timeoutSignal = AbortSignal.timeout(timeoutMs);
		const signal = outerSignal !== undefined ? AbortSignal.any([timeoutSignal, outerSignal]) : timeoutSignal;
		const { headers, sentOAuthToken } = await this.resolveHeaders(connection, timeoutMs, signal);

		let lastFailure: unknown;
		for (let attempt = 0; attempt <= DISCOVERY_MAX_RETRIES; attempt += 1) {
			if (attempt > 0) {
				await sleepUnlessAborted(RETRY_DELAY_MS * attempt, signal);
				// The outer signal wins the classification when both have fired: an
				// abort the caller asked for must not be relabeled a timeout.
				if (outerSignal?.aborted) {
					throw outerSignal.reason ?? new Error("The operation was aborted");
				}
				if (timeoutSignal.aborted) {
					throw timeoutError(url, timeoutMs, lastFailure);
				}
			}

			let response: Response;
			let payload: string;
			try {
				response = await globalThis.fetch(url, { method: "GET", headers, signal });
				payload = await response.text();
			} catch (error) {
				if (outerSignal?.aborted) {
					throw error;
				}
				if (timeoutSignal.aborted) {
					throw timeoutError(url, timeoutMs, error);
				}
				lastFailure = error;
				continue;
			}

			if (response.ok) {
				try {
					return JSON.parse(payload) as unknown;
				} catch {
					// The SyntaxError quotes a payload snippet (response-derived),
					// so it does not ride along - not even as the cause.
					throw new RequestError(l10n.t("Failed to parse the LiteLLM usage response from {0}.", url), "http", {
						englishMessage: `Failed to parse the LiteLLM usage response from ${url}.`,
					});
				}
			}
			const failure = usageHttpError(url, response.status);
			if (response.status >= 500) {
				lastFailure = failure;
				continue;
			}
			if (failure.kind === "auth" && connection.oauth && sentOAuthToken !== undefined) {
				// The server no longer accepts the token this call sent; the next
				// poll performs a fresh exchange. This call itself never retries.
				this.oauthTokens.invalidate(connection.oauth, sentOAuthToken);
			}
			throw failure;
		}

		if (lastFailure instanceof RequestError) {
			throw lastFailure;
		}
		throw new RequestError(
			l10n.t("Network Error: Unable to reach {0} for usage data. Check that the server is reachable.", url),
			"network",
			{
				cause: lastFailure,
				englishMessage: `Network Error: Unable to reach ${url} for usage data. Check that the server is reachable.`,
			}
		);
	}
}
