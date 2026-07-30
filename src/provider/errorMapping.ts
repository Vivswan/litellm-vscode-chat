import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from "openai";
import { MANAGE_COMMAND_TITLE } from "../shared/commandIds";
import { CONFIG_SECTION } from "../shared/settingSpec";

export type RequestErrorKind = "auth" | "http" | "certificate" | "connection" | "network" | "timeout" | "aborted";

/**
 * Error thrown across the provider's transport boundary. `kind` lets callers
 * branch without matching on message text; the message itself stays the
 * user-facing string surfaced in the chat UI and the status callback.
 */
export class RequestError extends Error {
	readonly kind: RequestErrorKind;
	readonly status?: number | undefined;

	constructor(message: string, kind: RequestErrorKind, options?: { status?: number; cause?: unknown }) {
		super(message, { cause: options?.cause });
		this.name = "RequestError";
		this.kind = kind;
		this.status = options?.status;
	}
}

export interface MapErrorContext {
	surface: "chat" | "discovery";
	baseUrl: string;
	timeoutMs: number;
}

const AUTH_MESSAGE = `Authentication failed: Your LiteLLM server requires an API key. Please run the "${MANAGE_COMMAND_TITLE}" command to configure your API key.`;

const UPSTREAM_AUTH_MESSAGE =
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

export function timeoutMessage(ctx: MapErrorContext): string {
	return ctx.surface === "chat"
		? `LiteLLM request timed out after ${ctx.timeoutMs}ms. Increase the "${CONFIG_SECTION}.requestTimeout" setting if your model needs more time.`
		: `LiteLLM model discovery timed out after ${ctx.timeoutMs}ms. Increase the "${CONFIG_SECTION}.discoveryTimeout" setting if your server needs more time.`;
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
	return new RequestError(`LiteLLM API error: the stream reported an error\n${JSON.stringify({ error })}`, "http");
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
			const message = isUpstreamAuthFailure(err.error) ? UPSTREAM_AUTH_MESSAGE : AUTH_MESSAGE;
			return new RequestError(message, "auth", { status: 401, cause: err });
		}
		const text = errorBodyText(err);
		const message =
			ctx.surface === "chat"
				? `LiteLLM API error: ${err.status}${text ? `\n${text}` : ""}`
				: `Failed to fetch LiteLLM models: ${err.status}${text ? `\n${text}` : ""}`;
		return new RequestError(message, "http", { status: err.status, cause: err });
	}

	if (err instanceof APIConnectionTimeoutError) {
		return new RequestError(timeoutMessage(ctx), "timeout", { cause: err });
	}

	if (err instanceof APIUserAbortError) {
		return new RequestError("Request was aborted.", "aborted", { cause: err });
	}

	if (err instanceof APIConnectionError) {
		const chain = causeChain(err.cause);
		const haystack = chain.map((link) => `${link.message} ${link.code ?? ""}`).join(" ");

		if (chain.some((link) => link.name === "TimeoutError")) {
			return new RequestError(timeoutMessage(ctx), "timeout", { cause: err });
		}
		if (haystack.includes("certificate has expired") || haystack.includes("CERT_HAS_EXPIRED")) {
			return new RequestError(
				`SSL Certificate Error: The SSL certificate for ${ctx.baseUrl} has expired. Please contact your LiteLLM server administrator to renew the certificate, or update your base URL.`,
				"certificate",
				{ cause: err }
			);
		}
		if (haystack.includes("certificate")) {
			const certMessage = chain.find((link) => link.message.includes("certificate"))?.message ?? haystack;
			return new RequestError(
				`SSL Certificate Error: There is an issue with the SSL certificate for ${ctx.baseUrl}. Error: ${certMessage}`,
				"certificate",
				{ cause: err }
			);
		}
		if (haystack.includes("ENOTFOUND") || haystack.includes("ECONNREFUSED")) {
			return new RequestError(
				`Connection Error: Unable to connect to ${ctx.baseUrl}. Please check that the server is running and the URL is correct.`,
				"connection",
				{ cause: err }
			);
		}
		const detail = chainDetail(chain, err.message);
		const message =
			ctx.surface === "chat"
				? `Network Error: Unable to reach ${ctx.baseUrl}. ${detail}`
				: `Network Error: Failed to fetch models from ${ctx.baseUrl}. ${detail}`;
		return new RequestError(message, "network", { cause: err });
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
					? `Network Error: The connection to ${ctx.baseUrl} was closed before the response completed. ${detail}`
					: `Network Error: Failed to fetch models from ${ctx.baseUrl}. ${detail}`;
			return new RequestError(message, "network", { cause: err });
		}
	}

	if (err instanceof Error) {
		return err;
	}
	try {
		return new Error(String(err));
	} catch {
		// String() itself can throw (a non-callable toString, a hostile
		// Symbol.toPrimitive); the tag never does, and this path must be total.
		return new Error(Object.prototype.toString.call(err));
	}
}
