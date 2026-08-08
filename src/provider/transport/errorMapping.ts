import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from "openai";
import { LanguageModelError, l10n } from "vscode";
import { manageCommandTitle, syncModelsCommandTitle } from "../../shared/config/commandIds";
import { CONFIG_SECTION } from "../../shared/config/settingSpec";
import type { SetupHintKind, TransportErrorClassification, TransportErrorKind } from "../../shared/errorClassification";
import { transportClassificationOf } from "../../shared/errorClassification";
import type { LogSafeErrorText } from "../../shared/logger";
import { errorMessageText, markLogSafe, publicErrorText } from "../../shared/logger";

/** The kind union lives in shared (status surfaces and the dashboard protocol may not import this layer); the transport keeps its established name. */
export type RequestErrorKind = TransportErrorKind;

/**
 * Error thrown across the provider's transport boundary. `kind` lets callers
 * branch without matching on message text; the message itself stays the
 * user-facing string surfaced in the chat UI and the status callback.
 *
 * Two English renderings ride alongside the (possibly localized) message,
 * both explicit PER-CONSTRUCTION-SITE opt-ins, never derived from `kind`:
 *
 * - `logClassification`: the terse classification-only rendering that PUBLIC
 *   surfaces (the issue-report buffer and the latest-error prefill; see
 *   shared/logger.ts) record instead of the message. A site whose message
 *   embeds response-derived text (an HTTP error body, an IdP's
 *   error_description) must pass one; each site's string should be distinct
 *   enough that maintainers can tell the failure modes apart in an issue
 *   without the body.
 * - `englishMessage`: the full English mirror of a localized display
 *   message, response-derived detail included. The output channel renders it
 *   instead of the message (the channel stays English by policy), and the
 *   public surfaces fall back to it when no classification applies, so a
 *   template-only site keeps its text useful in issues in every locale.
 *   Every site whose message goes through l10n.t must pass one.
 *
 * `setupHint` is a third per-construction-site opt-in: the id of the setup
 * advice UI surfaces may append (see shared/errorClassification.ts). Only a
 * site that knows the advice is right sets one - sites where the same
 * kind/status can mean something else (OAuth endpoints in auth.ts,
 * upstream-auth 401s, chat 404s) must NOT.
 */
export class RequestError extends Error {
	readonly kind: RequestErrorKind;
	readonly status?: number | undefined;
	readonly logClassification?: string;
	readonly englishMessage?: string;
	readonly setupHint?: SetupHintKind;
	/**
	 * Set by auth.ts at the OAuth token-endpoint construction sites: the
	 * failure happened during the token exchange, BEFORE the target endpoint
	 * was called, so consumers judging the target endpoint from this error
	 * (usage availability classification) must treat it as proving nothing
	 * about that endpoint.
	 */
	readonly oauthTokenEndpoint?: true;

	constructor(
		message: string,
		kind: RequestErrorKind,
		options?: {
			status?: number;
			cause?: unknown;
			logClassification?: string;
			englishMessage?: string;
			setupHint?: SetupHintKind;
			oauthTokenEndpoint?: true;
		}
	) {
		super(message, { cause: options?.cause });
		this.name = "RequestError";
		this.kind = kind;
		this.status = options?.status;
		if (options?.logClassification !== undefined) {
			this.logClassification = options.logClassification;
		}
		if (options?.englishMessage !== undefined) {
			this.englishMessage = options.englishMessage;
		}
		if (options?.setupHint !== undefined) {
			this.setupHint = options.setupHint;
		}
		if (options?.oauthTokenEndpoint !== undefined) {
			this.oauthTokenEndpoint = options.oauthTokenEndpoint;
		}
	}
}

export interface MapErrorContext {
	surface: "chat" | "discovery";
	baseUrl: string;
	timeoutMs: number;
}

/**
 * Both renderings of a failed fetch for the error status, plus the
 * classification when the reason carries one (a classified RequestError):
 * `error` renders directly in the status bar and toasts, `logSafeError` is
 * what log lines carry (see ServerStatusError), and `classification` is the
 * enum-only shape UI surfaces branch on for setup hints (absent for
 * unclassified errors, and every consumer must render exactly today's UI
 * then). An empty message (new Error("")) is classified here, at the boundary
 * that constructs the status.
 */
export function statusErrorTexts(reason: unknown): {
	error: string;
	logSafeError: LogSafeErrorText;
	classification?: TransportErrorClassification;
} {
	const display = errorMessageText(reason);
	const logSafe = publicErrorText(reason);
	// The shared extractor duck-types kind/status/setupHint, which for a
	// RequestError is exactly its classification; a plain Error yields none.
	const classification = transportClassificationOf(reason);
	return {
		error: display.length > 0 ? display : l10n.t("Unknown error"),
		logSafeError: logSafe.length > 0 ? logSafe : markLogSafe("Unknown error"),
		...(classification !== undefined ? { classification } : {}),
	};
}

/**
 * Wrap a classified transport failure in the stable LanguageModelError so
 * vscode.lm consumers can branch on the documented codes (NoPermissions for a
 * rejected key, Blocked for a rate limit, NotFound for a model the proxy no
 * longer serves) instead of matching message text. Only the taxonomy-backed
 * cases map; everything else - including CancellationError, which is never
 * wrapped or logged - passes through unchanged, and 401s keep their auth
 * classification rather than being re-wrapped as anything else. The message
 * is preserved because it renders in the chat UI. The original RequestError
 * rides as `cause` for in-process inspection only: the extension-host
 * boundary flattens a thrown error to name, message, stack, and code, so the
 * cause - and with it the RequestError's kind and status - does not survive
 * to vscode.lm consumers. The surviving contract is the code itself.
 */
export function toLanguageModelError(err: unknown): unknown {
	if (!(err instanceof RequestError)) {
		return err;
	}
	let wrapped: Error | undefined;
	if (err.kind === "auth") {
		wrapped = LanguageModelError.NoPermissions(err.message);
	} else if (err.status === 404) {
		wrapped = LanguageModelError.NotFound(err.message);
	} else if (err.status === 429) {
		wrapped = LanguageModelError.Blocked(err.message);
	}
	if (wrapped === undefined) {
		return err;
	}
	wrapped.cause = err;
	return wrapped;
}

/**
 * Lazy so the l10n bundle lookup and the interpolated manage-command title
 * both resolve at 401 time, not module load. The paired *_ENGLISH constant
 * is the English mirror the output channel and the issue-report buffer
 * record instead of the (possibly localized) display message.
 */
function authMessage(): string {
	return l10n.t(
		'Authentication failed: Your LiteLLM server requires an API key. Please run the "{0}" command to configure your API key.',
		manageCommandTitle()
	);
}

/** English mirror of authMessage; "Manage LiteLLM Provider" is the palette title package.json contributes. */
const AUTH_MESSAGE_ENGLISH =
	'Authentication failed: Your LiteLLM server requires an API key. Please run the "Manage LiteLLM Provider" command to configure your API key.';

/** Lazy for the same reason as authMessage: the display string resolves through the l10n bundle at 401 time. */
function upstreamAuthMessage(): string {
	return l10n.t(
		"Authentication failed upstream: the LiteLLM server accepted your key but could not authenticate to the model's upstream provider. Fix that provider's credentials on the LiteLLM server."
	);
}

/** English mirror of upstreamAuthMessage. */
const UPSTREAM_AUTH_MESSAGE_ENGLISH =
	"Authentication failed upstream: the LiteLLM server accepted your key but could not authenticate to the model's upstream provider. Fix that provider's credentials on the LiteLLM server.";

/**
 * Whether a 401 body reports the proxy's own upstream call failing to
 * authenticate rather than this client's key being rejected. LiteLLM wraps
 * upstream failures in its exception names ("litellm.AuthenticationError:
 * AnthropicException - ...", sometimes module-qualified); its own gate
 * answers with an auth_error envelope ("Authentication Error, No api key
 * passed in."). The envelope type outranks the message text: an exception
 * name quoted inside an auth_error body is still the proxy rejecting this
 * client's key. Telling them apart matters: the proxy message tells the user
 * to fix the extension's key, which for an upstream failure is the wrong
 * credential entirely. Classification only; the body text itself is never
 * echoed anywhere.
 */
function isUpstreamAuthFailure(error: unknown): boolean {
	if (typeof error !== "object" || error === null) {
		return false;
	}
	const { message, type } = error as { message?: unknown; type?: unknown };
	if (type === "auth_error") {
		return false;
	}
	return typeof message === "string" && /litellm\.[\w.]*AuthenticationError/i.test(message);
}

/** The localized display string for a timed-out call; englishTimeoutMessage mirrors it for the log side. */
export function timeoutMessage(ctx: MapErrorContext): string {
	return ctx.surface === "chat"
		? l10n.t(
				'LiteLLM request timed out after {0}ms. Increase the "{1}.chat.timeout" setting if your model needs more time.',
				ctx.timeoutMs,
				CONFIG_SECTION
			)
		: l10n.t(
				'LiteLLM model discovery timed out after {0}ms. Increase the "{1}.discovery.timeout" setting if your server needs more time.',
				ctx.timeoutMs,
				CONFIG_SECTION
			);
}

/** English mirror of timeoutMessage: what the English-by-policy log surfaces record (issueReporter.test.ts pins the English form). */
function englishTimeoutMessage(ctx: MapErrorContext): string {
	return ctx.surface === "chat"
		? `LiteLLM request timed out after ${ctx.timeoutMs}ms. Increase the "${CONFIG_SECTION}.chat.timeout" setting if your model needs more time.`
		: `LiteLLM model discovery timed out after ${ctx.timeoutMs}ms. Increase the "${CONFIG_SECTION}.discovery.timeout" setting if your server needs more time.`;
}

/** One constructor for every timed-out call, so a throw site cannot forget the display/English split. */
export function timeoutRequestError(ctx: MapErrorContext, cause: unknown): RequestError {
	return new RequestError(timeoutMessage(ctx), "timeout", { cause, englishMessage: englishTimeoutMessage(ctx) });
}

/**
 * A plain Error whose display message may be localized: `english` rides as
 * the englishMessage mirror, so the output channel, the issue-report buffer,
 * and the latest-error prefill (see shared/logger.ts) keep the English
 * rendering whatever the display locale. For the transport sites that throw
 * plain Errors rather than classified RequestErrors.
 */
export function localizedError(display: string, english: string): Error {
	return Object.assign(new Error(display), { englishMessage: english });
}

interface ChainLink {
	name: string;
	message: string;
	code?: string | undefined;
}

function causeChain(err: unknown): ChainLink[] {
	const chain: ChainLink[] = [];
	let current: unknown = err;
	while (current instanceof Error && chain.length < 10) {
		chain.push({
			name: current.name,
			message: current.message,
			code: (current as Error & { code?: string }).code,
		});
		current = current.cause;
	}
	return chain;
}

/** The first message plus the deepest cause, the detail suffix both network branches share. */
function chainDetail(chain: ChainLink[], fallbackMessage: string): string {
	const first = chain[0]?.message ?? fallbackMessage;
	const deepest = chain.at(-1)?.message;
	return `${first}${deepest && deepest !== first ? `. Cause: ${deepest}` : ""}`;
}

/**
 * An in-band error frame: a streamed `data: {"error": {...}}` payload, the
 * shape LiteLLM emits when an upstream dies after the 200 and the first
 * chunks already went out. Constructed here so the stream processor throws a
 * classified transport error instead of ending the request as a silent
 * truncation; the envelope is re-serialized exactly like errorBodyText does
 * for HTTP errors. There is no HTTP status - the response was already 200 -
 * so the RequestError carries none.
 */
export function streamErrorFrame(error: Record<string, unknown>): RequestError {
	const envelope = JSON.stringify({ error });
	return new RequestError(`${l10n.t("LiteLLM API error: the stream reported an error")}\n${envelope}`, "http", {
		// The re-serialized envelope is response-derived; the distinct
		// classification keeps a mid-stream death recognizable in an issue.
		logClassification: "RequestError(http, in-band stream error frame)",
		englishMessage: `LiteLLM API error: the stream reported an error\n${envelope}`,
	});
}

/**
 * The old raiseHttpError appended the raw response text; the SDK only keeps a
 * parsed representation, so the body is re-serialized in the LiteLLM error
 * envelope when it parsed as one, and recovered from the SDK message otherwise.
 */
function errorBodyText(err: APIError): string {
	if (err.error !== undefined) {
		return JSON.stringify({ error: err.error });
	}
	const prefix = `${err.status} `;
	return err.message.startsWith(prefix) ? err.message.slice(prefix.length) : err.message;
}

/**
 * Map an error thrown by the openai SDK transport onto the provider's typed
 * errors, preserving the established user-facing strings per surface.
 * Network classification walks the full cause chain because the SDK adds a
 * wrapper level ("Connection error." -> TypeError "fetch failed" -> the
 * socket/TLS error that carries the actionable string).
 */
export function mapSdkError(err: unknown, ctx: MapErrorContext): Error {
	if (err instanceof APIError && typeof err.status === "number") {
		if (err.status === 401) {
			return isUpstreamAuthFailure(err.error)
				? new RequestError(upstreamAuthMessage(), "auth", {
						status: 401,
						cause: err,
						englishMessage: UPSTREAM_AUTH_MESSAGE_ENGLISH,
					})
				: new RequestError(authMessage(), "auth", {
						status: 401,
						cause: err,
						englishMessage: AUTH_MESSAGE_ENGLISH,
						// The proxy's own gate rejected this client's key, so the advice
						// is certain; the upstream variant above gets none (updating the
						// extension's key cannot fix the proxy's provider credentials).
						setupHint: "configure-api-key",
					});
		}
		const text = errorBodyText(err);
		const suffix = text ? `\n${text}` : "";
		// 404 gets its own guidance per surface: on discovery it almost always
		// means the base URL points at something that is not a LiteLLM proxy
		// (wrong port, a /v1 suffix doubling the path); on chat it usually means
		// the proxy dropped the model, so no setupHint - "check the base URL"
		// would be wrong advice for an otherwise healthy server.
		if (err.status === 404) {
			if (ctx.surface === "discovery") {
				return new RequestError(
					`${l10n.t(
						"Failed to fetch LiteLLM models: the server at {0} answered 404 - it responded, but does not serve the LiteLLM API at this address. Check the base URL: do not include a /v1 suffix (the extension appends it), and note the LiteLLM proxy's default port is 4000.",
						ctx.baseUrl
					)}${suffix}`,
					"http",
					{
						status: 404,
						cause: err,
						logClassification: "RequestError(http, status 404, discovery)",
						englishMessage: `Failed to fetch LiteLLM models: the server at ${ctx.baseUrl} answered 404 - it responded, but does not serve the LiteLLM API at this address. Check the base URL: do not include a /v1 suffix (the extension appends it), and note the LiteLLM proxy's default port is 4000.${suffix}`,
						setupHint: "check-base-url",
					}
				);
			}
			return new RequestError(
				`${l10n.t(
					'LiteLLM API error: 404. The server no longer recognizes this request - the model may have been removed from the proxy (run "{0}" to refresh the list); if every request fails with 404, check the base URL (do not include a /v1 suffix).',
					syncModelsCommandTitle()
				)}${suffix}`,
				"http",
				{
					status: 404,
					cause: err,
					logClassification: "RequestError(http, status 404, chat)",
					// "LiteLLM: Sync Models Now" is the palette title package.json
					// contributes (the manageCommandTitle mirror pattern).
					englishMessage: `LiteLLM API error: 404. The server no longer recognizes this request - the model may have been removed from the proxy (run "LiteLLM: Sync Models Now" to refresh the list); if every request fails with 404, check the base URL (do not include a /v1 suffix).${suffix}`,
				}
			);
		}
		const message =
			ctx.surface === "chat"
				? `${l10n.t({
						message: "LiteLLM API error: {0}",
						args: [err.status],
						comment: ["{0} is the HTTP status code the server answered with"],
					})}${suffix}`
				: `${l10n.t({
						message: "Failed to fetch LiteLLM models: {0}",
						args: [err.status],
						comment: ["{0} is the HTTP status code the server answered with"],
					})}${suffix}`;
		const englishMessage =
			ctx.surface === "chat"
				? `LiteLLM API error: ${err.status}${suffix}`
				: `Failed to fetch LiteLLM models: ${err.status}${suffix}`;
		return new RequestError(message, "http", {
			status: err.status,
			cause: err,
			// The message embeds the response body (errorBodyText above).
			logClassification: `RequestError(http, status ${err.status})`,
			englishMessage,
		});
	}

	if (err instanceof APIConnectionTimeoutError) {
		return timeoutRequestError(ctx, err);
	}

	if (err instanceof APIUserAbortError) {
		return new RequestError(l10n.t("Request was aborted."), "aborted", {
			cause: err,
			englishMessage: "Request was aborted.",
		});
	}

	if (err instanceof APIConnectionError) {
		const chain = causeChain(err.cause);
		const haystack = chain.map((link) => `${link.message} ${link.code ?? ""}`).join(" ");

		if (chain.some((link) => link.name === "TimeoutError")) {
			return timeoutRequestError(ctx, err);
		}
		if (haystack.includes("certificate has expired") || haystack.includes("CERT_HAS_EXPIRED")) {
			return new RequestError(
				l10n.t(
					"SSL Certificate Error: The SSL certificate for {0} has expired. Please contact your LiteLLM server administrator to renew the certificate, or update your base URL.",
					ctx.baseUrl
				),
				"certificate",
				{
					cause: err,
					englishMessage: `SSL Certificate Error: The SSL certificate for ${ctx.baseUrl} has expired. Please contact your LiteLLM server administrator to renew the certificate, or update your base URL.`,
				}
			);
		}
		if (haystack.includes("certificate")) {
			const certMessage = chain.find((link) => link.message.includes("certificate"))?.message ?? haystack;
			return new RequestError(
				l10n.t(
					"SSL Certificate Error: There is an issue with the SSL certificate for {0}. Error: {1}",
					ctx.baseUrl,
					certMessage
				),
				"certificate",
				{
					cause: err,
					englishMessage: `SSL Certificate Error: There is an issue with the SSL certificate for ${ctx.baseUrl}. Error: ${certMessage}`,
				}
			);
		}
		if (haystack.includes("ENOTFOUND") || haystack.includes("ECONNREFUSED")) {
			return new RequestError(
				l10n.t(
					"Connection Error: Unable to connect to {0}. Please check that the server is running and the URL is correct.",
					ctx.baseUrl
				),
				"connection",
				{
					cause: err,
					englishMessage: `Connection Error: Unable to connect to ${ctx.baseUrl}. Please check that the server is running and the URL is correct.`,
					// ECONNREFUSED means the host answered "nothing listens on that
					// port", so "is the proxy running?" is certainly the right first
					// question. ENOTFOUND is a DNS failure - the proxy may be running
					// fine behind a mistyped hostname - so it gets no hint.
					...(haystack.includes("ECONNREFUSED") ? { setupHint: "proxy-not-running" as const } : {}),
				}
			);
		}
		const detail = chainDetail(chain, err.message);
		const message =
			ctx.surface === "chat"
				? l10n.t("Network Error: Unable to reach {0}. {1}", ctx.baseUrl, detail)
				: l10n.t("Network Error: Failed to fetch models from {0}. {1}", ctx.baseUrl, detail);
		const english =
			ctx.surface === "chat"
				? `Network Error: Unable to reach ${ctx.baseUrl}. ${detail}`
				: `Network Error: Failed to fetch models from ${ctx.baseUrl}. ${detail}`;
		return new RequestError(message, "network", { cause: err, englishMessage: english });
	}

	// A socket that dies AFTER headers surfaces from the body reader, not from
	// the SDK transport: the SDK already returned the Response, so undici's
	// bare TypeError ("terminated", cause SocketError "other side closed" /
	// ECONNRESET) arrives here wrapped in no SDK error class. Without this
	// branch the user would see the raw "terminated". The match requires a
	// socket-level signature (or undici's exact top-level TypeError): a mere
	// "terminated" inside some other error's message must not reclassify it.
	// RequestErrors are excluded: an already-classified error whose message
	// happens to mention a socket term must pass through unchanged.
	if (err instanceof Error && !(err instanceof RequestError)) {
		const chain = causeChain(err);
		const haystack = chain.map((link) => `${link.name} ${link.message} ${link.code ?? ""}`).join(" ");
		const socketSignature = /other side closed|ECONNRESET|UND_ERR_SOCKET/.test(haystack);
		const undiciTermination = err instanceof TypeError && err.message === "terminated";
		if (socketSignature || undiciTermination) {
			const detail = chainDetail(chain, err.message);
			const message =
				ctx.surface === "chat"
					? l10n.t(
							"Network Error: The connection to {0} was closed before the response completed. {1}",
							ctx.baseUrl,
							detail
						)
					: l10n.t("Network Error: Failed to fetch models from {0}. {1}", ctx.baseUrl, detail);
			const english =
				ctx.surface === "chat"
					? `Network Error: The connection to ${ctx.baseUrl} was closed before the response completed. ${detail}`
					: `Network Error: Failed to fetch models from ${ctx.baseUrl}. ${detail}`;
			return new RequestError(message, "network", { cause: err, englishMessage: english });
		}
	}

	if (err instanceof Error) {
		return err;
	}
	// errorMessageText is total: it falls back to the Object.prototype.toString
	// tag when a hostile value's String() coercion throws.
	return new Error(errorMessageText(err));
}
