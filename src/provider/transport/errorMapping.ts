import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from "openai";
import { CancellationError, LanguageModelError, l10n } from "vscode";
import { manageCommandTitle, syncModelsCommandTitle } from "../../shared/config/commandIds";
import { CONFIG_SECTION } from "../../shared/config/settingSpec";
import type { SetupHintKind, TransportErrorClassification, TransportErrorKind } from "../../shared/errorClassification";
import { transportClassificationOf } from "../../shared/errorClassification";
import { chatErrorMessage, englishChatErrorMessage } from "../../shared/localizedError";
import type { LogSafeErrorText } from "../../shared/logger";
import { errorMessageText, markLogSafe, publicErrorText } from "../../shared/logger";
import { collapseWhitespace } from "../../shared/util/errorText";

export { chatErrorMessage, englishChatErrorMessage, localizedError } from "../../shared/localizedError";

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

interface ChainLink {
	name: string;
	message: string;
	code?: string | undefined;
}

function causeChain(err: unknown): ChainLink[] {
	const chain: ChainLink[] = [];
	let current: unknown = err;
	while (current instanceof Error && chain.length < 10) {
		// Every read is guarded and coerced: a hostile subclass's throwing
		// getter or non-string field must not escape mapSdkError, whose
		// contract is total.
		let link: ChainLink;
		try {
			const rawCode = (current as Error & { code?: unknown }).code;
			link = {
				name: typeof current.name === "string" ? current.name : "Error",
				message: typeof current.message === "string" ? current.message : "",
				code: typeof rawCode === "string" ? rawCode : undefined,
			};
		} catch {
			link = { name: "Error", message: "" };
		}
		chain.push(link);
		try {
			current = current.cause;
		} catch {
			break;
		}
	}
	return chain;
}

/**
 * One compact diagnostic from the cause chain: the first message (trailing
 * period trimmed) plus the deepest distinct cause, e.g.
 * "fetch failed (cause: getaddrinfo EAI_AGAIN litellm.internal)". The detail
 * line both network branches put under their headline; compacted so a
 * multi-line cause cannot break the two-line message shape.
 */
function chainDetail(chain: ChainLink[], fallbackMessage: string): string {
	const fallback = typeof fallbackMessage === "string" ? fallbackMessage : "";
	const first = chain[0]?.message ?? fallback;
	const deepest = chain.at(-1)?.message;
	const head = first.replace(/\.$/, "");
	const joined = deepest !== undefined && deepest !== "" && deepest !== first ? `${head} (cause: ${deepest})` : head;
	return compactText(joined, 300);
}

/** Server-derived text made one compact line: whitespace runs collapsed, trimmed, capped. */
function compactText(text: string, cap: number): string {
	const collapsed = collapseWhitespace(text);
	return collapsed.length > cap ? `${collapsed.slice(0, cap)}...` : collapsed;
}

/** A compact non-empty string, with LiteLLM's literal "None" counting as absent; capped so a hostile type/code field cannot bloat a detail line. */
function meaningfulString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const compact = compactText(value, 80);
	return compact !== "" && compact !== "None" ? compact : undefined;
}

/** LiteLLM's error envelope when the body parsed as one: err.error as an object, fields kept only when meaningful. */
interface ErrorEnvelope {
	message: string | undefined;
	type: string | undefined;
	code: string | undefined;
}

function errorEnvelopeOf(err: APIError): ErrorEnvelope | undefined {
	const raw = err.error;
	if (typeof raw !== "object" || raw === null) {
		return undefined;
	}
	const { message, type, code } = raw as { message?: unknown; type?: unknown; code?: unknown };
	const envelope: ErrorEnvelope = {
		message: typeof message === "string" && message.trim() !== "" ? message : undefined,
		type: meaningfulString(type),
		code: typeof code === "number" ? String(code) : meaningfulString(code),
	};
	// An object body with none of the envelope fields ({}, [], FastAPI's
	// {"detail": ...}) is not LiteLLM's envelope; headline branches keying on
	// envelope presence (the 403 split) must not treat it as one.
	return envelope.message === undefined && envelope.type === undefined && envelope.code === undefined
		? undefined
		: envelope;
}

/**
 * The recovery the old raw-body suffix performed for bodies that did not
 * parse as a JSON envelope: the SDK keeps the raw text in its message behind
 * a "{status} " prefix.
 */
function recoveredSdkText(status: number, err: APIError, cap: number): string {
	const prefix = `${status} `;
	const text = err.message.startsWith(prefix) ? err.message.slice(prefix.length) : err.message;
	return compactText(text, cap);
}

/**
 * The user-facing classes the generic HTTP branch (and the stream error
 * frame) sorts a status plus envelope into. A CLOSED set decided by this
 * classifier: budget_exceeded and context_window_exceeded ride the
 * logClassification (the isUpstreamAuthFailure precedent - classify FROM the
 * body, never quote it), so response text must never become a member.
 */
type HttpErrorClass =
	| "budget_exceeded"
	| "rate_limited"
	| "context_window_exceeded"
	| "invalid_request"
	| "model_access"
	| "forbidden"
	| "billing"
	| "request_timeout"
	| "server_error"
	| "bad_gateway"
	| "unavailable"
	| "unexpected";

function classifyHttpError(status: number, envelope: ErrorEnvelope | undefined): HttpErrorClass {
	const marks = `${envelope?.type ?? ""} ${envelope?.code ?? ""}`;
	const budget = marks.includes("budget_exceeded") || /budget has been exceeded/i.test(envelope?.message ?? "");
	if ((status === 429 || status === 400) && budget) {
		return "budget_exceeded";
	}
	if (status === 429) {
		return "rate_limited";
	}
	if (status === 400) {
		const contextWindow =
			marks.includes("context_window_exceeded") ||
			marks.includes("context_length_exceeded") ||
			/context (window|length)/i.test(envelope?.message ?? "");
		return contextWindow ? "context_window_exceeded" : "invalid_request";
	}
	if (status === 403) {
		return envelope !== undefined ? "model_access" : "forbidden";
	}
	if (status === 402) {
		return "billing";
	}
	if (status === 408) {
		return "request_timeout";
	}
	if (status === 500) {
		return "server_error";
	}
	if (status === 502 || status === 504) {
		return "bad_gateway";
	}
	if (status === 503) {
		return "unavailable";
	}
	return "unexpected";
}

/** A localized display string paired with its English mirror; the pair is built at call time (no localized constants). */
interface LocalizedText {
	display: string;
	english: string;
}

/** The chat-surface headline per error class; streamErrorFrame reuses the budget and rate-limit entries. */
function chatHttpHeadline(cls: HttpErrorClass): LocalizedText {
	switch (cls) {
		case "budget_exceeded":
			return {
				display: l10n.t(
					"This key's budget is used up - requests will fail until the budget resets or an admin raises it."
				),
				english: "This key's budget is used up - requests will fail until the budget resets or an admin raises it.",
			};
		case "rate_limited":
			return {
				display: l10n.t("The server is handling too many requests - wait a moment and try again."),
				english: "The server is handling too many requests - wait a moment and try again.",
			};
		case "context_window_exceeded":
			return {
				display: l10n.t(
					"The conversation is too long for this model - trim it, remove attachments, or start a new chat."
				),
				english: "The conversation is too long for this model - trim it, remove attachments, or start a new chat.",
			};
		case "invalid_request":
			return {
				display: l10n.t("The server rejected this request as invalid."),
				english: "The server rejected this request as invalid.",
			};
		case "model_access":
			return {
				display: l10n.t("This key is not allowed to use this model."),
				english: "This key is not allowed to use this model.",
			};
		case "forbidden":
			return {
				display: l10n.t("The server refused this request."),
				english: "The server refused this request.",
			};
		case "billing":
			return {
				display: l10n.t("The server reports a billing problem with this key."),
				english: "The server reports a billing problem with this key.",
			};
		case "request_timeout":
			return {
				display: l10n.t("The server gave up waiting on this request - try again."),
				english: "The server gave up waiting on this request - try again.",
			};
		case "server_error":
			return {
				display: l10n.t(
					"The LiteLLM server hit an internal error - try again, and check the server's logs if it persists."
				),
				english: "The LiteLLM server hit an internal error - try again, and check the server's logs if it persists.",
			};
		case "bad_gateway":
		case "unavailable":
			return {
				display: l10n.t("The LiteLLM server is unreachable or overloaded - try again shortly."),
				english: "The LiteLLM server is unreachable or overloaded - try again shortly.",
			};
		case "unexpected":
			return {
				display: l10n.t("The server answered with an unexpected error."),
				english: "The server answered with an unexpected error.",
			};
	}
}

/** The discovery-surface headline per error class: what the failure means for the model list. */
function discoveryHttpHeadline(cls: HttpErrorClass): LocalizedText {
	switch (cls) {
		case "budget_exceeded":
			return {
				display: l10n.t("This key's budget is used up - the server refused to refresh the model list."),
				english: "This key's budget is used up - the server refused to refresh the model list.",
			};
		case "rate_limited":
			return {
				display: l10n.t(
					'The server rate limited the model list refresh - try again shortly or run "{0}".',
					syncModelsCommandTitle()
				),
				english:
					'The server rate limited the model list refresh - try again shortly or run "LiteLLM: Sync Models Now".',
			};
		case "model_access":
			return {
				display: l10n.t("This key is not allowed to list the server's models."),
				english: "This key is not allowed to list the server's models.",
			};
		case "server_error":
			return {
				display: l10n.t("The LiteLLM server hit an internal error while listing models."),
				english: "The LiteLLM server hit an internal error while listing models.",
			};
		case "bad_gateway":
			return {
				display: l10n.t("A gateway in front of the server could not reach it while listing models."),
				english: "A gateway in front of the server could not reach it while listing models.",
			};
		case "unavailable":
			return {
				display: l10n.t("The server is unavailable or overloaded - the model list could not be refreshed."),
				english: "The server is unavailable or overloaded - the model list could not be refreshed.",
			};
		default:
			return {
				display: l10n.t("The server refused the model-list request."),
				english: "The server refused the model-list request.",
			};
	}
}

/**
 * Compact technical line for a chat-surface HTTP error, e.g.
 * "LiteLLM 429 budget_exceeded: Budget has been exceeded! ...". Never a
 * re-serialized JSON envelope and never the literal "undefined"; the type
 * outranks the code, and a code that is just the stringified status is
 * dropped (never "LiteLLM 429 429"). Response-derived, so it rides only in
 * message/englishMessage, never the logClassification.
 */
function chatHttpDetail(status: number, err: APIError, envelope: ErrorEnvelope | undefined): string {
	const kind =
		envelope?.type !== undefined
			? ` ${envelope.type}`
			: envelope?.code !== undefined && !/^\d+$/.test(envelope.code)
				? ` ${envelope.code}`
				: "";
	const text =
		envelope?.message !== undefined ? compactText(envelope.message, 300) : recoveredSdkText(status, err, 300);
	return text !== "" ? `LiteLLM ${status}${kind}: ${text}` : `LiteLLM ${status}${kind}`;
}

/**
 * Discovery twin of chatHttpDetail. "LiteLLM" brands only bodies that parsed
 * as LiteLLM's envelope - a 502/504 body is often the gateway speaking, and
 * gets the plain HTTP form with the recovered body text.
 */
function discoveryHttpDetail(status: number, err: APIError, envelope: ErrorEnvelope | undefined): string {
	if (envelope?.message !== undefined) {
		const kind =
			envelope.type !== undefined
				? ` ${envelope.type}`
				: envelope.code !== undefined && !/^\d+$/.test(envelope.code)
					? ` ${envelope.code}`
					: "";
		return `LiteLLM ${status}${kind}: ${compactText(envelope.message, 300)}`;
	}
	const recovered = recoveredSdkText(status, err, 200);
	return recovered !== "" ? `HTTP ${status}: ${recovered}` : `HTTP ${status}`;
}

/**
 * An in-band error frame: a streamed `data: {"error": {...}}` payload, the
 * shape LiteLLM emits when an upstream dies after the 200 and the first
 * chunks already went out. Constructed here so the stream processor throws a
 * classified transport error instead of ending the request as a silent
 * truncation. There is no HTTP status - the response was already 200 - so
 * the RequestError carries none, and none may be derived from the envelope's
 * code: a synthesized status 429 would re-map the frame as Blocked.
 */
export function streamErrorFrame(error: Record<string, unknown>): RequestError {
	const message = typeof error.message === "string" && error.message.trim() !== "" ? error.message : undefined;
	const type = meaningfulString(error.type);
	const code = typeof error.code === "number" ? String(error.code) : meaningfulString(error.code);
	// A frame carrying a known failure class gets that class's headline (a
	// budget frame must not promise that trying again may work); classified
	// FROM the envelope, never quoting it.
	const marks = `${type ?? ""} ${code ?? ""}`;
	const knownClass: HttpErrorClass | undefined =
		marks.includes("budget_exceeded") || /budget has been exceeded/i.test(message ?? "")
			? "budget_exceeded"
			: marks.includes("rate_limit")
				? "rate_limited"
				: undefined;
	const headline: LocalizedText =
		knownClass !== undefined
			? chatHttpHeadline(knownClass)
			: {
					display: l10n.t(
						"The server reported an error while it was streaming this reply, so the response was interrupted. This is often temporary - trying again may work; if it repeats, the detail below shows what the server said."
					),
					english:
						"The server reported an error while it was streaming this reply, so the response was interrupted. This is often temporary - trying again may work; if it repeats, the detail below shows what the server said.",
				};
	let detail = "LiteLLM stream error";
	if (type !== undefined) {
		detail += ` ${type}`;
	}
	if (code !== undefined) {
		detail += ` (${code})`;
	}
	if (message !== undefined) {
		detail += `: ${compactText(message, 300)}`;
	}
	if (type === undefined && code === undefined && message === undefined) {
		detail = "LiteLLM stream error (no detail provided by the server)";
	}
	return new RequestError(chatErrorMessage(headline.display, detail), "http", {
		// The detail is response-derived; the distinct classification keeps a
		// mid-stream death recognizable in an issue.
		logClassification: "RequestError(http, in-band stream error frame)",
		englishMessage: englishChatErrorMessage(headline.english, detail),
	});
}

/**
 * Map an error thrown by the openai SDK transport onto the provider's typed
 * errors. Every mapped message follows the two-part shape: a plain-language
 * headline (localized, stating what happened and what the user can do) plus
 * one compact English technical line - never a re-serialized response
 * envelope. The join is per surface: chat messages carry the "Details:"
 * lead-in after a blank line (chatErrorMessage - Copilot Chat's error block
 * flattens newlines), discovery messages the single "\n" the dashboard and
 * tooltips split on. Network classification walks the full cause chain
 * because the SDK adds a wrapper level ("Connection error." -> TypeError
 * "fetch failed" -> the socket/TLS error that carries the actionable string).
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
		const envelope = errorEnvelopeOf(err);
		// 404 gets its own guidance per surface: on discovery it almost always
		// means the base URL points at something that is not a LiteLLM proxy
		// (wrong port, a /v1 suffix doubling the path); on chat it usually means
		// the proxy dropped the model, so no setupHint - "check the base URL"
		// would be wrong advice for an otherwise healthy server.
		if (err.status === 404) {
			if (ctx.surface === "discovery") {
				// The headline is quoted verbatim by docs/troubleshooting.md - only
				// the detail line may change. It renders only when the body parsed
				// as an error envelope with a message: an HTML 404 page or FastAPI's
				// {"detail":"Not Found"} adds nothing the headline does not say.
				const typeSeg = envelope?.type !== undefined ? ` ${envelope.type}` : "";
				const detail =
					envelope?.message !== undefined ? `\nLiteLLM 404${typeSeg}: ${compactText(envelope.message, 240)}` : "";
				return new RequestError(
					`${l10n.t(
						"Failed to fetch LiteLLM models: the server at {0} answered 404 - it responded, but does not serve the LiteLLM API at this address. Check the base URL: do not include a /v1 suffix (the extension appends it), and note the LiteLLM proxy's default port is 4000.",
						ctx.baseUrl
					)}${detail}`,
					"http",
					{
						status: 404,
						cause: err,
						logClassification: "RequestError(http, status 404, discovery)",
						englishMessage: `Failed to fetch LiteLLM models: the server at ${ctx.baseUrl} answered 404 - it responded, but does not serve the LiteLLM API at this address. Check the base URL: do not include a /v1 suffix (the extension appends it), and note the LiteLLM proxy's default port is 4000.${detail}`,
						setupHint: "check-base-url",
					}
				);
			}
			// The envelope code outranks the type here, and the non-envelope
			// recovery keeps the nginx/wrong-server signature of a /v1-doubled
			// base URL visible in the detail.
			const kind =
				envelope?.code !== undefined && !/^\d+$/.test(envelope.code)
					? ` ${envelope.code}`
					: envelope?.type !== undefined
						? ` ${envelope.type}`
						: "";
			const text =
				envelope?.message !== undefined ? compactText(envelope.message, 300) : recoveredSdkText(404, err, 200);
			const detail = text !== "" ? `LiteLLM 404${kind}: ${text}` : `LiteLLM 404${kind}`;
			return new RequestError(
				chatErrorMessage(
					l10n.t(
						'The server did not recognize this request - the model may have been removed from the proxy. Run "{0}" to refresh the model list; if every request fails this way, check the base URL (do not include a /v1 suffix - the extension adds it).',
						syncModelsCommandTitle()
					),
					detail
				),
				"http",
				{
					status: 404,
					cause: err,
					logClassification: "RequestError(http, status 404, chat)",
					// "LiteLLM: Sync Models Now" is the palette title package.json
					// contributes (the manageCommandTitle mirror pattern).
					englishMessage: englishChatErrorMessage(
						'The server did not recognize this request - the model may have been removed from the proxy. Run "LiteLLM: Sync Models Now" to refresh the model list; if every request fails this way, check the base URL (do not include a /v1 suffix - the extension adds it).',
						detail
					),
				}
			);
		}
		const cls = classifyHttpError(err.status, envelope);
		const headline = ctx.surface === "chat" ? chatHttpHeadline(cls) : discoveryHttpHeadline(cls);
		const detail =
			ctx.surface === "chat"
				? chatHttpDetail(err.status, err, envelope)
				: discoveryHttpDetail(err.status, err, envelope);
		// The classifier's own closed-set token may ride the classification
		// (classify FROM the body, never quote it); the response text itself
		// rides only in message/englishMessage.
		const token = cls === "budget_exceeded" || cls === "context_window_exceeded" ? `, ${cls}` : "";
		const message =
			ctx.surface === "chat" ? chatErrorMessage(headline.display, detail) : `${headline.display}\n${detail}`;
		const english =
			ctx.surface === "chat" ? englishChatErrorMessage(headline.english, detail) : `${headline.english}\n${detail}`;
		return new RequestError(message, "http", {
			status: err.status,
			cause: err,
			logClassification: `RequestError(http, status ${err.status}${token})`,
			englishMessage: english,
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
			// The deepest chain link naming the certificate carries the
			// socket-level diagnosis; the joined haystack is never rendered (it
			// splices unrelated wrapper messages together). Node's
			// hostname-mismatch text embeds the certificate's SAN list
			// (server-supplied), so the public surfaces get the classification.
			const certLink =
				[...chain]
					.reverse()
					.find((link) => link.message.includes("certificate") || (link.code ?? "").includes("CERT")) ?? chain.at(-1);
			const certMessage = compactText(certLink?.message ?? err.message, 300);
			const certCode = certLink?.code !== undefined ? compactText(certLink.code, 80) : "";
			const detail = `SSL certificate error for ${ctx.baseUrl}: ${certMessage}${certCode !== "" ? ` (${certCode})` : ""}`;
			const headline: LocalizedText = {
				display: l10n.t(
					"The server's SSL certificate couldn't be verified, so the connection was blocked. Trust the server's certificate authority on this machine (for example via NODE_EXTRA_CA_CERTS), or contact your LiteLLM server administrator."
				),
				english:
					"The server's SSL certificate couldn't be verified, so the connection was blocked. Trust the server's certificate authority on this machine (for example via NODE_EXTRA_CA_CERTS), or contact your LiteLLM server administrator.",
			};
			return new RequestError(
				ctx.surface === "chat" ? chatErrorMessage(headline.display, detail) : `${headline.display}\n${detail}`,
				"certificate",
				{
					cause: err,
					logClassification: "RequestError(certificate, unverified)",
					englishMessage:
						ctx.surface === "chat"
							? englishChatErrorMessage(headline.english, detail)
							: `${headline.english}\n${detail}`,
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
		const headline: LocalizedText =
			ctx.surface === "chat"
				? {
						display: l10n.t(
							"Could not reach {0}. Check your network, VPN, or proxy settings, and that the server is up.",
							ctx.baseUrl
						),
						english: `Could not reach ${ctx.baseUrl}. Check your network, VPN, or proxy settings, and that the server is up.`,
					}
				: {
						display: l10n.t(
							"Could not reach {0} to list its models. Check your network, VPN, or proxy settings, and that the server is up.",
							ctx.baseUrl
						),
						english: `Could not reach ${ctx.baseUrl} to list its models. Check your network, VPN, or proxy settings, and that the server is up.`,
					};
		// An empty cause chain gets no detail line rather than a trailing blank.
		const message =
			detail === ""
				? headline.display
				: ctx.surface === "chat"
					? chatErrorMessage(headline.display, detail)
					: `${headline.display}\n${detail}`;
		const english =
			detail === ""
				? headline.english
				: ctx.surface === "chat"
					? englishChatErrorMessage(headline.english, detail)
					: `${headline.english}\n${detail}`;
		return new RequestError(message, "network", {
			cause: err,
			englishMessage: english,
		});
	}

	if (err instanceof RequestError || err instanceof CancellationError) {
		return err;
	}
	// Errors shaped by a localizedError construction site (chatClient's
	// pre-flight throws, the stream processor's end-of-stream errors) arrive
	// already carrying their display/English pair; re-headlining them would
	// double-wrap, and a socket term quoted in their text must not reclassify
	// them, so this pass-through sits before the socket branch. The property
	// read is guarded: a hostile getter must not escape mapSdkError.
	if (err instanceof Error) {
		let mirrored = false;
		try {
			mirrored = typeof (err as { englishMessage?: unknown }).englishMessage === "string";
		} catch {
			mirrored = false;
		}
		if (mirrored) {
			return err;
		}
	}

	// A socket that dies AFTER headers surfaces from the body reader, not from
	// the SDK transport: the SDK already returned the Response, so undici's
	// bare TypeError ("terminated", cause SocketError "other side closed" /
	// ECONNRESET) arrives here wrapped in no SDK error class. Without this
	// branch the user would see the raw "terminated". The match requires a
	// socket-level signature (or undici's exact top-level TypeError): a mere
	// "terminated" inside some other error's message must not reclassify it.
	if (err instanceof Error) {
		const chain = causeChain(err);
		const haystack = chain.map((link) => `${link.name} ${link.message} ${link.code ?? ""}`).join(" ");
		const socketSignature = /other side closed|ECONNRESET|UND_ERR_SOCKET/.test(haystack);
		// The top link is causeChain's guarded read of err.message: arbitrary
		// errors reach this branch from the body reader, so err.message is
		// never read directly here (a hostile getter must not escape).
		const topMessage = chain[0]?.message ?? "";
		const undiciTermination = err instanceof TypeError && topMessage === "terminated";
		if (socketSignature || undiciTermination) {
			const chainText = chainDetail(chain, topMessage);
			if (ctx.surface === "chat") {
				const detail = `Connection to ${ctx.baseUrl} closed mid-response${chainText !== "" ? `: ${chainText}` : ""}`;
				return new RequestError(
					chatErrorMessage(
						l10n.t(
							"The connection dropped before the model finished replying, so the answer may be cut short. Try again; if it keeps happening, check any proxy or load balancer between you and the server."
						),
						detail
					),
					"network",
					{
						cause: err,
						englishMessage: englishChatErrorMessage(
							"The connection dropped before the model finished replying, so the answer may be cut short. Try again; if it keeps happening, check any proxy or load balancer between you and the server.",
							detail
						),
					}
				);
			}
			// Distinct from the never-connected discovery headline above: here the
			// server did respond, then the connection died.
			const suffix = chainText !== "" ? `\n${chainText}` : "";
			return new RequestError(
				`${l10n.t(
					"The connection to {0} dropped while fetching models - the response never completed. Try again; if it keeps happening, check your network and any VPN or proxy.",
					ctx.baseUrl
				)}${suffix}`,
				"network",
				{
					cause: err,
					englishMessage: `The connection to ${ctx.baseUrl} dropped while fetching models - the response never completed. Try again; if it keeps happening, check your network and any VPN or proxy.${suffix}`,
				}
			);
		}
	}

	// The truly anonymous tail: an Error no branch recognized, or a non-Error
	// throw. errorMessageText is total (it falls back to the
	// Object.prototype.toString tag when a hostile value's String() coercion
	// throws); the name read is guarded the same way, and only an
	// identifier-shaped name may enter the classification - an arbitrary name
	// string is caller-controlled text and stays off the public log surfaces.
	let name: string;
	if (err instanceof Error) {
		try {
			name = typeof err.name === "string" && /^[\w$.]{1,64}$/.test(err.name) ? err.name : "Error";
		} catch {
			name = "Error";
		}
	} else {
		name = typeof err;
	}
	const rawText = errorMessageText(err);
	const text = compactText(typeof rawText === "string" ? rawText : "", 300);
	const detail = `Unexpected ${name} during the ${ctx.surface} request to ${ctx.baseUrl}${text !== "" ? `: ${text}` : ""}`;
	const tailHeadline: LocalizedText = {
		display: l10n.t(
			"The request failed unexpectedly. Try again; if it keeps happening, report an issue so we can look at it."
		),
		english: "The request failed unexpectedly. Try again; if it keeps happening, report an issue so we can look at it.",
	};
	return Object.assign(
		new Error(
			ctx.surface === "chat" ? chatErrorMessage(tailHeadline.display, detail) : `${tailHeadline.display}\n${detail}`,
			{ cause: err }
		),
		{
			englishMessage:
				ctx.surface === "chat"
					? englishChatErrorMessage(tailHeadline.english, detail)
					: `${tailHeadline.english}\n${detail}`,
			logClassification:
				err instanceof Error
					? `unhandled Error in transport (${name}, ${ctx.surface})`
					: `non-Error throw in transport (${name}, ${ctx.surface})`,
		}
	);
}
