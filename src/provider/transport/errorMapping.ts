import * as l10n from "@vscode/l10n";
import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from "openai";
import { CancellationError, LanguageModelError } from "vscode";
import { manageCommandTitle, syncModelsCommandTitle } from "../../shared/config/commandIds";
import { CONFIG_SECTION } from "../../shared/config/settingSpec";
import type { SetupHintKind, TransportErrorClassification, TransportErrorKind } from "../../shared/errorClassification";
import { transportClassificationOf } from "../../shared/errorClassification";
import type { LogSafeErrorText } from "../../shared/logger";
import { errorMessageText, markLogSafe, publicErrorText } from "../../shared/logger";
import {
	chatErrorMessage,
	type EnglishRendering,
	englishChatErrorMessage,
	MirroredError,
} from "../../shared/mirroredError";
import { collapseWhitespace } from "../../shared/util/errorText";

/** The kind union lives in shared (status surfaces and the dashboard protocol may not import this layer); the transport keeps its established name. */
export type RequestErrorKind = TransportErrorKind;

/**
 * Error thrown across the provider's transport boundary. `kind` lets callers
 * branch without matching on message text; the message itself stays the
 * user-facing string surfaced in the chat UI and the status callback.
 *
 * Extends MirroredError, so every construction site must pass at least one of
 * the two English renderings, and the choice stays PER CONSTRUCTION SITE,
 * never derived from `kind`:
 *
 * - `logClassification` when the message embeds response-derived text (an
 *   HTTP error body, an IdP's error_description).
 * - `englishMessage` when the message goes through l10n.t.
 *
 * `setupHint` is a per-construction-site opt-in: the id of the setup advice UI
 * surfaces may append. Only a site that knows the advice is right sets one -
 * sites where the same kind/status can mean something else (OAuth endpoints in
 * auth.ts, upstream-auth 401s, chat 404s) must NOT.
 */
export class RequestError extends MirroredError {
	readonly kind: RequestErrorKind;
	readonly status?: number | undefined;
	readonly setupHint?: SetupHintKind;
	/**
	 * Discovery's endpoint-unsupported marker, assigned only at the discovery
	 * construction site that proved it in one pass; see
	 * TransportErrorClassification.unsupportedEndpoint.
	 */
	readonly unsupportedEndpoint?: "modelListing";
	/**
	 * Set at the OAuth token-endpoint construction sites (auth.ts and the
	 * shared socket-failure classifier's oauthToken context): the failure
	 * happened during the token exchange, BEFORE the target endpoint was
	 * called, so consumers judging the target endpoint from this error must
	 * treat it as proving nothing about that endpoint.
	 */
	readonly oauthTokenEndpoint?: true;

	constructor(
		message: string,
		kind: RequestErrorKind,
		options: EnglishRendering & {
			readonly status?: number;
			readonly cause?: unknown;
			readonly setupHint?: SetupHintKind;
			readonly unsupportedEndpoint?: "modelListing";
			readonly oauthTokenEndpoint?: true;
		}
	) {
		super(message, options);
		this.name = "RequestError";
		this.kind = kind;
		this.status = options.status;
		if (options.setupHint !== undefined) {
			this.setupHint = options.setupHint;
		}
		if (options.unsupportedEndpoint !== undefined) {
			this.unsupportedEndpoint = options.unsupportedEndpoint;
		}
		if (options.oauthTokenEndpoint !== undefined) {
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
 * classification when the reason carries one: `error` renders directly in the
 * status bar and toasts, `logSafeError` is what log lines carry, and
 * `classification` is the enum-only shape UI surfaces branch on for setup
 * hints (absent for unclassified errors). An empty message is classified here,
 * at the boundary that constructs the status.
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
 * vscode.lm consumers can branch on the documented codes instead of matching
 * message text. Only the taxonomy-backed cases map; everything else -
 * including CancellationError, which is never wrapped or logged - passes
 * through unchanged, and 401s keep their auth classification rather than being
 * re-wrapped as anything else. The message is preserved because it renders in
 * the chat UI. The original RequestError rides as `cause` for in-process
 * inspection only: the extension-host boundary flattens a thrown error to
 * name, message, stack, and code, so the code itself is the surviving
 * contract.
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
 * both resolve at 401 time, not module load. The paired *_ENGLISH constant is
 * the English mirror the log surfaces record.
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
 * ..."); its own gate answers with an auth_error envelope. The envelope type
 * outranks the message text: an exception name quoted inside an auth_error
 * body is still the proxy rejecting this client's key. Telling them apart
 * matters: the proxy message tells the user to fix the extension's key, the
 * wrong credential entirely for an upstream failure. Classification only; the
 * body text itself is never echoed anywhere.
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

/** English mirror of timeoutMessage: what the English-by-policy log surfaces record. */
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
			const next: unknown = current.cause;
			if (next instanceof Error) {
				current = next;
			} else if (current instanceof AggregateError && current.errors[0] instanceof Error) {
				// Undici aggregates parallel connect attempts (IPv4 + IPv6) into an
				// AggregateError whose own message is empty; the first attempt
				// carries the actionable socket text.
				current = current.errors[0];
			} else {
				break;
			}
		} catch {
			break;
		}
	}
	return chain;
}

/** One link's diagnostic text: its message, or its bare code when the message is empty (Node's AggregateError shape). */
function linkText(link: ChainLink | undefined): string {
	if (link === undefined) {
		return "";
	}
	return link.message !== "" ? link.message : (link.code ?? "");
}

/**
 * One compact diagnostic from the cause chain: the first link's text (trailing
 * period trimmed) plus the deepest distinct cause. Compacted so a multi-line
 * cause cannot break the two-line message shape.
 */
function chainDetail(chain: ChainLink[], fallbackMessage: string): string {
	const fallback = typeof fallbackMessage === "string" ? fallbackMessage : "";
	const first = chain.length > 0 ? linkText(chain[0]) : fallback;
	const deepest = linkText(chain.at(-1));
	const head = first.replace(/\.$/, "");
	const joined = deepest !== "" && deepest !== first ? `${head} (cause: ${deepest})` : head;
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

function errorEnvelopeOf(raw: unknown): ErrorEnvelope | undefined {
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
 * The user-facing classes the generic HTTP branch (and the stream error frame)
 * sorts a status plus envelope into. A CLOSED set decided by this classifier:
 * budget_exceeded and context_window_exceeded ride the logClassification
 * (classify FROM the body, never quote it), so response text must never become
 * a member.
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

/**
 * The one classifier for both delivery paths of the same LiteLLM envelope: an
 * HTTP error response (status known) and an in-band stream error frame (the
 * response was already 200, so there is no status). The failure marks and
 * message signatures are detected once here so the two paths cannot drift.
 * Without a status only the classes the envelope itself proves may be claimed
 * - everything else returns undefined and the frame keeps its generic
 * interrupted-stream headline. One asymmetry is inherent: with a status the
 * status arbitrates (429 is rate-limited whatever the message says, the
 * context-window signatures count only at 400, where the status vouches that
 * the request was refused and the mention just picks the flavor); a frame has
 * no status, so its envelope is judged alone, in budget > context-window >
 * rate-limit order, and a bare context-window mention proves nothing there -
 * the structured marks or an exceedance signature must accompany it.
 */
function classifyEnvelope(envelope: ErrorEnvelope | undefined, status: number): HttpErrorClass;
function classifyEnvelope(envelope: ErrorEnvelope | undefined, status?: number): HttpErrorClass | undefined;
function classifyEnvelope(envelope: ErrorEnvelope | undefined, status?: number): HttpErrorClass | undefined {
	const marks = `${envelope?.type ?? ""} ${envelope?.code ?? ""}`;
	const message = envelope?.message ?? "";
	const budget = marks.includes("budget_exceeded") || /budget has been exceeded/i.test(message);
	const contextWindowMarks = marks.includes("context_window_exceeded") || marks.includes("context_length_exceeded");
	const contextWindowMention = /context (window|length)/i.test(message);
	if (status === undefined) {
		// The signature is exceed/too-long/too-large or OpenAI's exact
		// "maximum context length is N" shape; a bare "maximum" proves nothing.
		const contextWindowProven =
			contextWindowMarks ||
			(contextWindowMention && /exceed|too (long|large)|maximum context length is \d/i.test(message));
		return budget
			? "budget_exceeded"
			: contextWindowProven
				? "context_window_exceeded"
				: marks.includes("rate_limit")
					? "rate_limited"
					: undefined;
	}
	if ((status === 429 || status === 400) && budget) {
		return "budget_exceeded";
	}
	if (status === 429) {
		return "rate_limited";
	}
	if (status === 400) {
		return contextWindowMarks || contextWindowMention ? "context_window_exceeded" : "invalid_request";
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

/**
 * Both renderings of a two-part error message, joined per surface: chat
 * carries the "Details:" lead-in after a blank line (Copilot Chat's error
 * block flattens newlines), discovery the single "\n" the dashboard and
 * tooltips split on. The English mirror is byte-faithful to the English
 * display: the same join applied to the English headline and the same detail.
 * An empty detail renders the headline alone rather than a trailing blank
 * detail line.
 */
export function twoPartTexts(
	surface: MapErrorContext["surface"],
	headline: LocalizedText,
	detail: string
): { message: string; englishMessage: string } {
	if (detail === "") {
		return { message: headline.display, englishMessage: headline.english };
	}
	return surface === "chat"
		? {
				message: chatErrorMessage(headline.display, detail),
				englishMessage: englishChatErrorMessage(headline.english, detail),
			}
		: { message: `${headline.display}\n${detail}`, englishMessage: `${headline.english}\n${detail}` };
}

/** The chat-surface headline per error class; streamErrorFrame reuses the entries of the classes classifiable without a status. */
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
 * Compact technical line for a chat-surface HTTP error. Never a re-serialized
 * JSON envelope and never the literal "undefined"; the type outranks the code,
 * and a code that is just the stringified status is dropped. Response-derived,
 * so it rides only in message/englishMessage, never the logClassification.
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
 * shape LiteLLM emits when an upstream dies after the 200. Constructed here so
 * the stream processor throws a classified transport error instead of ending
 * the request as a silent truncation. There is no HTTP status - the response
 * was already 200 - so the RequestError carries none, and none may be derived
 * from the envelope's code: a synthesized status 429 would re-map the frame as
 * Blocked.
 */
export function streamErrorFrame(error: Record<string, unknown>): RequestError {
	const envelope = errorEnvelopeOf(error);
	// A frame carrying a known failure class gets that class's headline (a
	// budget or context-window frame must not promise that trying again may
	// work); classified FROM the envelope by the same classifier as the HTTP
	// path, never quoting it.
	const knownClass = classifyEnvelope(envelope);
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
	if (envelope === undefined) {
		detail = "LiteLLM stream error (no detail provided by the server)";
	} else {
		if (envelope.type !== undefined) {
			detail += ` ${envelope.type}`;
		}
		if (envelope.code !== undefined) {
			detail += ` (${envelope.code})`;
		}
		if (envelope.message !== undefined) {
			detail += `: ${compactText(envelope.message, 300)}`;
		}
	}
	// The classifier's closed-set token may ride the classification (the same
	// rule as the HTTP path); the response text itself never does.
	const token = knownClass === "budget_exceeded" || knownClass === "context_window_exceeded" ? `, ${knownClass}` : "";
	const texts = twoPartTexts("chat", headline, detail);
	return new RequestError(texts.message, "http", {
		// The detail is response-derived; the distinct classification keeps a
		// mid-stream death recognizable in an issue.
		logClassification: `RequestError(http, in-band stream error frame${token})`,
		englishMessage: texts.englishMessage,
	});
}

/**
 * Where a non-HTTP fetch failure happened. The endpoint varies ADVICE only -
 * which headline renders, which URL it names, whether a setup hint is certain -
 * never the classification: kind and cause-detail extraction are one rule for
 * the chat, discovery, and OAuth token-endpoint callers.
 */
interface SocketFailureContext {
	endpoint: "chat" | "discovery" | "oauthToken";
	/** The surface whose two-part join renders the message; the token exchange fails toward its caller's surface. */
	surface: MapErrorContext["surface"];
	/** The URL the advice names: the server base URL, or the OAuth token endpoint. */
	url: string;
}

/** Expired-certificate advice per endpoint: who renews it, and which URL setting to revisit. */
function expiredCertificateHeadline(ctx: SocketFailureContext): LocalizedText {
	if (ctx.endpoint === "oauthToken") {
		return {
			display: l10n.t(
				"SSL Certificate Error: The SSL certificate for the OAuth token endpoint at {0} has expired. Please contact your identity provider's administrator to renew the certificate, or update the OAuth token URL in this server's settings.",
				ctx.url
			),
			english: `SSL Certificate Error: The SSL certificate for the OAuth token endpoint at ${ctx.url} has expired. Please contact your identity provider's administrator to renew the certificate, or update the OAuth token URL in this server's settings.`,
		};
	}
	return {
		display: l10n.t(
			"SSL Certificate Error: The SSL certificate for {0} has expired. Please contact your LiteLLM server administrator to renew the certificate, or update your base URL.",
			ctx.url
		),
		english: `SSL Certificate Error: The SSL certificate for ${ctx.url} has expired. Please contact your LiteLLM server administrator to renew the certificate, or update your base URL.`,
	};
}

/** Unverified-certificate advice per endpoint: whose certificate authority to trust or whose admin to call. */
function unverifiedCertificateHeadline(ctx: SocketFailureContext): LocalizedText {
	if (ctx.endpoint === "oauthToken") {
		return {
			display: l10n.t(
				"The identity provider's SSL certificate couldn't be verified, so the connection was blocked. Trust its certificate authority on this machine (for example via NODE_EXTRA_CA_CERTS), or contact your identity provider's administrator."
			),
			english:
				"The identity provider's SSL certificate couldn't be verified, so the connection was blocked. Trust its certificate authority on this machine (for example via NODE_EXTRA_CA_CERTS), or contact your identity provider's administrator.",
		};
	}
	return {
		display: l10n.t(
			"The server's SSL certificate couldn't be verified, so the connection was blocked. Trust the server's certificate authority on this machine (for example via NODE_EXTRA_CA_CERTS), or contact your LiteLLM server administrator."
		),
		english:
			"The server's SSL certificate couldn't be verified, so the connection was blocked. Trust the server's certificate authority on this machine (for example via NODE_EXTRA_CA_CERTS), or contact your LiteLLM server administrator.",
	};
}

/**
 * The corrected URL to suggest when the target host sits under `.localhost`
 * (www.localhost, api.localhost, ...): those hosts do not resolve on stock
 * systems while plain `localhost` does, so the same URL with the bare host is
 * a recognizable fix rather than a guess. Undefined for every other host -
 * bare `localhost` included - and for unparseable URLs. The family is decided
 * by hostname alone (port irrelevant); the parser lowercases registered names,
 * one trailing dot counts (it fails resolution the same way), and an IPv6
 * literal never ends in the suffix.
 */
function bareLocalhostUrl(url: string): string | undefined {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return undefined;
	}
	const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
	if (!host.endsWith(".localhost") || host === ".localhost") {
		return undefined;
	}
	parsed.hostname = "localhost";
	const suggested = parsed.href;
	// href appends "/" to a bare origin; trim that one back so the common
	// bare-origin case reads like the configured URL. Other href
	// normalizations (default-port drop, "/" before a query) may remain.
	return !url.endsWith("/") && suggested.endsWith("/") && parsed.pathname === "/" ? suggested.slice(0, -1) : suggested;
}

/**
 * Nothing-answered advice per endpoint: which process to check and which URL
 * setting names it. `suggestedUrl` is the caller's ENOTFOUND-proven
 * bare-localhost correction; when present the correction IS the headline,
 * leading the sentence - toasts truncate from the tail, so advice appended
 * there is the first thing cut - in lockstep with the use-bare-localhost hint
 * the caller assigns. The certain diagnosis replaces the generic
 * is-the-server-running advice rather than following it.
 */
function connectionHeadline(ctx: SocketFailureContext, suggestedUrl?: string): LocalizedText {
	if (ctx.endpoint === "oauthToken") {
		return {
			display: l10n.t(
				"Connection Error: Unable to connect to the OAuth token endpoint at {0}. Please check that the OAuth token URL is correct and the identity provider is reachable.",
				ctx.url
			),
			english: `Connection Error: Unable to connect to the OAuth token endpoint at ${ctx.url}. Please check that the OAuth token URL is correct and the identity provider is reachable.`,
		};
	}
	if (suggestedUrl !== undefined) {
		return {
			display: l10n.t(
				"Connection Error: Try {0} instead of {1} - subdomains of localhost usually do not resolve.",
				suggestedUrl,
				ctx.url
			),
			english: `Connection Error: Try ${suggestedUrl} instead of ${ctx.url} - subdomains of localhost usually do not resolve.`,
		};
	}
	return {
		display: l10n.t(
			"Connection Error: Unable to connect to {0}. Please check that the server is running and the URL is correct.",
			ctx.url
		),
		english: `Connection Error: Unable to connect to ${ctx.url}. Please check that the server is running and the URL is correct.`,
	};
}

/** Generic could-not-reach advice per endpoint; chat and discovery keep their distinct framing of what was lost. */
function unreachableHeadline(ctx: SocketFailureContext): LocalizedText {
	if (ctx.endpoint === "oauthToken") {
		return {
			display: l10n.t(
				"Network Error: Unable to reach the OAuth token endpoint at {0}. Please check that the URL is correct and the identity provider is reachable.",
				ctx.url
			),
			english: `Network Error: Unable to reach the OAuth token endpoint at ${ctx.url}. Please check that the URL is correct and the identity provider is reachable.`,
		};
	}
	return ctx.endpoint === "chat"
		? {
				display: l10n.t(
					"Could not reach {0}. Check your network, VPN, or proxy settings, and that the server is up.",
					ctx.url
				),
				english: `Could not reach ${ctx.url}. Check your network, VPN, or proxy settings, and that the server is up.`,
			}
		: {
				display: l10n.t(
					"Could not reach {0} to list its models. Check your network, VPN, or proxy settings, and that the server is up.",
					ctx.url
				),
				english: `Could not reach ${ctx.url} to list its models. Check your network, VPN, or proxy settings, and that the server is up.`,
			};
}

/**
 * The one classifier for every non-HTTP fetch failure: the chat and discovery
 * transports (via mapSdkError) and the OAuth token exchange (auth.ts) all
 * classify the same raw socket failures here, so an expired certificate or an
 * ECONNREFUSED gets the same kind and the same cause-detail extraction
 * whichever endpoint tripped it; only the advice wording follows the context.
 * `root` is where the cause chain starts (the SDK error's cause, or the raw
 * fetch rejection), `cause` is what the RequestError carries. A TimeoutError
 * link defers to `onTimeout`: timeout messages stay endpoint-owned because
 * each endpoint has its own budget (the OAuth exchange's hard bound is not the
 * chat timeout).
 */
export function socketFailureRequestError(
	root: unknown,
	cause: unknown,
	ctx: SocketFailureContext,
	onTimeout: () => RequestError
): RequestError {
	const chain = causeChain(root);
	const haystack = chain.map((link) => `${link.message} ${link.code ?? ""}`).join(" ");
	if (chain.some((link) => link.name === "TimeoutError")) {
		return onTimeout();
	}
	const oauthMark = ctx.endpoint === "oauthToken" ? { oauthTokenEndpoint: true as const } : {};
	if (haystack.includes("certificate has expired") || haystack.includes("CERT_HAS_EXPIRED")) {
		// The headline already states the socket-level diagnosis, so it carries
		// no detail line - at any endpoint.
		const headline = expiredCertificateHeadline(ctx);
		return new RequestError(headline.display, "certificate", {
			cause,
			englishMessage: headline.english,
			...oauthMark,
		});
	}
	if (haystack.includes("certificate")) {
		// The deepest chain link naming the certificate carries the socket-level
		// diagnosis; the joined haystack is never rendered (it splices unrelated
		// wrapper messages together). Node's hostname-mismatch text embeds the
		// server-supplied SAN list, so the public surfaces get the classification.
		const certLink =
			[...chain].reverse().find((link) => link.message.includes("certificate") || (link.code ?? "").includes("CERT")) ??
			chain.at(-1);
		const certMessage = compactText(certLink?.message ?? "", 300);
		const certCode = certLink?.code !== undefined ? compactText(certLink.code, 80) : "";
		const certText = certMessage !== "" ? `${certMessage}${certCode !== "" ? ` (${certCode})` : ""}` : certCode;
		const detail = `SSL certificate error for ${ctx.url}${certText !== "" ? `: ${certText}` : ""}`;
		const texts = twoPartTexts(ctx.surface, unverifiedCertificateHeadline(ctx), detail);
		return new RequestError(texts.message, "certificate", {
			cause,
			logClassification: "RequestError(certificate, unverified)",
			englishMessage: texts.englishMessage,
			...oauthMark,
		});
	}
	// An empty cause chain gets no detail line rather than a trailing blank.
	const detail = chainDetail(chain, "");
	if (haystack.includes("ENOTFOUND") || haystack.includes("ECONNREFUSED")) {
		// A *.localhost host that failed to RESOLVE is a recognizable
		// misconfiguration (subdomains of localhost do not resolve on stock
		// systems while plain localhost does), so the corrected URL is the
		// certain advice there. ECONNREFUSED proves resolution worked and
		// nothing listens on that port - bare localhost would reach the same
		// loopback - so it keeps "is the proxy running?" even for the family.
		// At the token endpoint the stopped process would be the identity
		// provider, not the proxy, and a plain-host ENOTFOUND is just DNS (the
		// process may run fine behind a mistyped hostname) - so no hint.
		const suggestedUrl =
			ctx.endpoint !== "oauthToken" && haystack.includes("ENOTFOUND") ? bareLocalhostUrl(ctx.url) : undefined;
		const texts = twoPartTexts(ctx.surface, connectionHeadline(ctx, suggestedUrl), detail);
		const setupHint =
			suggestedUrl !== undefined
				? ("use-bare-localhost" as const)
				: ctx.endpoint !== "oauthToken" && haystack.includes("ECONNREFUSED")
					? ("proxy-not-running" as const)
					: undefined;
		return new RequestError(texts.message, "connection", {
			cause,
			englishMessage: texts.englishMessage,
			...(setupHint !== undefined ? { setupHint } : {}),
			...oauthMark,
		});
	}
	const texts = twoPartTexts(ctx.surface, unreachableHeadline(ctx), detail);
	return new RequestError(texts.message, "network", {
		cause,
		englishMessage: texts.englishMessage,
		...oauthMark,
	});
}

/**
 * Map an error thrown by the openai SDK transport onto the provider's typed
 * errors. Every mapped message follows the two-part shape: a plain-language
 * headline (localized) plus one compact English technical line - never a
 * re-serialized response envelope - joined per surface by twoPartTexts.
 * Network classification walks the full cause chain because the SDK adds a
 * wrapper level over the socket/TLS error that carries the actionable string.
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
		const envelope = errorEnvelopeOf(err.error);
		// 404 gets its own guidance per surface: on discovery it almost always
		// means the base URL points at something that is not a LiteLLM proxy
		// (wrong port, a path that is not the API root); on chat it usually means
		// the proxy dropped the model, so no setupHint - "check the base URL"
		// would be wrong advice for an otherwise healthy server.
		if (err.status === 404) {
			if (ctx.surface === "discovery") {
				// The headline is quoted verbatim by docs/troubleshooting.md - only
				// the detail line may change. It renders only when the body parsed
				// as an error envelope with a message.
				const typeSeg = envelope?.type !== undefined ? ` ${envelope.type}` : "";
				const detail =
					envelope?.message !== undefined ? `LiteLLM 404${typeSeg}: ${compactText(envelope.message, 240)}` : "";
				const headline: LocalizedText = {
					display: l10n.t(
						"Failed to fetch LiteLLM models: the server at {0} answered 404 - it responded, but does not serve the LiteLLM API at this address. Check the base URL: the extension appends /v1 unless the URL already ends in a version segment like /v1 or /v2, and note the LiteLLM proxy's default port is 4000.",
						ctx.baseUrl
					),
					english: `Failed to fetch LiteLLM models: the server at ${ctx.baseUrl} answered 404 - it responded, but does not serve the LiteLLM API at this address. Check the base URL: the extension appends /v1 unless the URL already ends in a version segment like /v1 or /v2, and note the LiteLLM proxy's default port is 4000.`,
				};
				const texts = twoPartTexts("discovery", headline, detail);
				return new RequestError(texts.message, "http", {
					status: 404,
					cause: err,
					logClassification: "RequestError(http, status 404, discovery)",
					englishMessage: texts.englishMessage,
					setupHint: "check-base-url",
				});
			}
			// The envelope code outranks the type here, and the non-envelope
			// recovery keeps the nginx/wrong-server signature of a mispointed
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
			// "LiteLLM: Sync Models Now" is the palette title package.json
			// contributes (the manageCommandTitle mirror pattern).
			const headline: LocalizedText = {
				display: l10n.t(
					'The server did not recognize this request - the model may have been removed from the proxy. Run "{0}" to refresh the model list; if every request fails this way, check the base URL (the extension appends /v1 unless the URL already ends in a version segment like /v1 or /v2).',
					syncModelsCommandTitle()
				),
				english:
					'The server did not recognize this request - the model may have been removed from the proxy. Run "LiteLLM: Sync Models Now" to refresh the model list; if every request fails this way, check the base URL (the extension appends /v1 unless the URL already ends in a version segment like /v1 or /v2).',
			};
			const texts = twoPartTexts("chat", headline, detail);
			return new RequestError(texts.message, "http", {
				status: 404,
				cause: err,
				logClassification: "RequestError(http, status 404, chat)",
				englishMessage: texts.englishMessage,
			});
		}
		const cls = classifyEnvelope(envelope, err.status);
		const headline = ctx.surface === "chat" ? chatHttpHeadline(cls) : discoveryHttpHeadline(cls);
		const detail =
			ctx.surface === "chat"
				? chatHttpDetail(err.status, err, envelope)
				: discoveryHttpDetail(err.status, err, envelope);
		// The classifier's own closed-set token may ride the classification
		// (classify FROM the body, never quote it); the response text itself
		// rides only in message/englishMessage.
		const token = cls === "budget_exceeded" || cls === "context_window_exceeded" ? `, ${cls}` : "";
		const texts = twoPartTexts(ctx.surface, headline, detail);
		return new RequestError(texts.message, "http", {
			status: err.status,
			cause: err,
			logClassification: `RequestError(http, status ${err.status}${token})`,
			englishMessage: texts.englishMessage,
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
		return socketFailureRequestError(
			err.cause,
			err,
			{ endpoint: ctx.surface, surface: ctx.surface, url: ctx.baseUrl },
			() => timeoutRequestError(ctx, err)
		);
	}

	if (err instanceof RequestError || err instanceof MirroredError || err instanceof CancellationError) {
		return err;
	}
	// Errors shaped elsewhere but carrying the English mirror duck-typed already
	// carry their display/English pair; re-headlining them would double-wrap,
	// and a socket term quoted in their text must not reclassify them, so this
	// pass-through sits before the socket branch. The property read is guarded:
	// a hostile getter must not escape mapSdkError.
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
	// bare TypeError arrives here wrapped in no SDK error class, and the user
	// would otherwise see the raw "terminated". The match requires a
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
				const texts = twoPartTexts(
					"chat",
					{
						display: l10n.t(
							"The connection dropped before the model finished replying, so the answer may be cut short. Try again; if it keeps happening, check any proxy or load balancer between you and the server."
						),
						english:
							"The connection dropped before the model finished replying, so the answer may be cut short. Try again; if it keeps happening, check any proxy or load balancer between you and the server.",
					},
					detail
				);
				return new RequestError(texts.message, "network", {
					cause: err,
					englishMessage: texts.englishMessage,
				});
			}
			// Distinct from the never-connected discovery headline above: here the
			// server did respond, then the connection died.
			const texts = twoPartTexts(
				"discovery",
				{
					display: l10n.t(
						"The connection to {0} dropped while fetching models - the response never completed. Try again; if it keeps happening, check your network and any VPN or proxy.",
						ctx.baseUrl
					),
					english: `The connection to ${ctx.baseUrl} dropped while fetching models - the response never completed. Try again; if it keeps happening, check your network and any VPN or proxy.`,
				},
				chainText
			);
			return new RequestError(texts.message, "network", {
				cause: err,
				englishMessage: texts.englishMessage,
			});
		}
	}

	// The truly anonymous tail: an Error no branch recognized, or a non-Error
	// throw. errorMessageText is total; the name read is guarded the same way,
	// and only an identifier-shaped name may enter the classification - an
	// arbitrary name string is caller-controlled text and stays off the public
	// log surfaces.
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
	const texts = twoPartTexts(ctx.surface, tailHeadline, detail);
	return new MirroredError(texts.message, {
		cause: err,
		englishMessage: texts.englishMessage,
		logClassification:
			err instanceof Error
				? `unhandled Error in transport (${name}, ${ctx.surface})`
				: `non-Error throw in transport (${name}, ${ctx.surface})`,
	});
}
