import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from "openai";

export type RequestErrorKind = "auth" | "http" | "certificate" | "connection" | "network" | "timeout" | "aborted";

/**
 * Error thrown across the provider's transport boundary. `kind` lets callers
 * branch without matching on message text; the message itself stays the
 * user-facing string surfaced in the chat UI and the status callback.
 */
export class RequestError extends Error {
	readonly kind: RequestErrorKind;
	readonly status?: number;

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

const AUTH_MESSAGE = `Authentication failed: Your LiteLLM server requires an API key. Please run the "Manage LiteLLM Provider" command to configure your API key.`;

export function timeoutMessage(ctx: MapErrorContext): string {
	return ctx.surface === "chat"
		? `LiteLLM request timed out after ${ctx.timeoutMs}ms. Increase the "litellm-vscode-chat.requestTimeout" setting if your model needs more time.`
		: `LiteLLM model discovery timed out after ${ctx.timeoutMs}ms. Increase the "litellm-vscode-chat.discoveryTimeout" setting if your server needs more time.`;
}

interface ChainLink {
	name: string;
	message: string;
	code?: string;
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
			return new RequestError(AUTH_MESSAGE, "auth", { status: 401, cause: err });
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
		const first = chain[0]?.message ?? err.message;
		const deepest = chain.at(-1)?.message;
		const detail = `${first}${deepest && deepest !== first ? `. Cause: ${deepest}` : ""}`;
		const message =
			ctx.surface === "chat"
				? `Network Error: Unable to reach ${ctx.baseUrl}. ${detail}`
				: `Network Error: Failed to fetch models from ${ctx.baseUrl}. ${detail}`;
		return new RequestError(message, "network", { cause: err });
	}

	return err instanceof Error ? err : new Error(String(err));
}
