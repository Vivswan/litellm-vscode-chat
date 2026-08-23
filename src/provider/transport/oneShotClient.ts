import { APIConnectionError, APIError } from "openai";
import * as vscode from "vscode";
import { isRecord } from "../../shared/util/json";
import type { OAuthConfig, VirtualKeyConfig } from "./auth";
import { OAuthTokenSource } from "./auth";
import { applyAuthOverlay, invalidateRejectedOAuthToken, plainFetchBaseHeaders, setOwnedHeader } from "./authOverlay";
import { chatCompletionsUrl, completionsUrl } from "./clients";
import type { MapErrorContext, TransportErrorSurface } from "./errorMapping";
import { bodylessResponseError, mapSdkError, timeoutRequestError } from "./errorMapping";
import { parseCompletionText } from "./fim";

/**
 * The one-shot transport: single plain-fetch POSTs for the extension-side
 * features - /chat/completions for the background chat features and
 * /completions for inline completions (FIM). sendJson is the core every call
 * shares: header composition through the shared auth overlay, the whole-call
 * timeout, the one error pipeline (mapSdkError), and OAuth invalidation on a
 * rejected token. On top of it sit the completion helpers: completeChatOnce
 * (one non-streaming reply string), completeFim (one completion text), and
 * completeChatStream (the raw SSE body for the streaming machinery). No SDK
 * client cache, no retries (completions never retry).
 *
 * Error ownership follows the transport-module convention: construct specific
 * errors through the shared error pipeline - each call under its caller's
 * error surface - and throw WITHOUT logging; the caller's boundary logs once.
 * Cancellation surfaces as vscode.CancellationError and is never logged.
 */

/** One wire message of a one-shot request; this path carries plain text only, no multimodal parts. */
export interface OneShotChatMessage {
	readonly role: "system" | "user" | "assistant";
	readonly content: string;
}

/**
 * The request fields a one-shot chat call sends, and nothing else: the body is
 * exactly model/messages/stream (false for completeChatOnce, true for
 * completeChatStream), plus max_tokens only when the caller sets it - the
 * pass-through invariant's "never inject what the user did not set" applied
 * to a provider-owned surface.
 */
export interface OneShotChatRequest {
	readonly model: string;
	readonly messages: readonly OneShotChatMessage[];
	readonly maxTokens?: number | undefined;
}

/**
 * The request fields a FIM call sends, and nothing else: the body is exactly
 * model/prompt/suffix/max_tokens/stream:false, with `suffix` omitted when a
 * `_fim_template` already placed it inside the prompt. models.parameters
 * records deliberately do NOT apply to /completions - the template directive
 * is the one documented exception, and it is applied by the caller through
 * buildFimPrompt, never sent.
 */
export interface FimCompletionRequest {
	readonly model: string;
	readonly prompt: string;
	/** Absent exactly when the template owns the whole prompt. */
	readonly suffix?: string | undefined;
	readonly maxTokens: number;
}

/**
 * One server's connection material for a one-shot call, fully resolved by the
 * caller. Structurally satisfied by the usage subsystem's UsageConnection, so
 * extension-side features resolve their connection once and hand it to both.
 */
export interface OneShotConnection {
	readonly baseUrl: string;
	/** The entry's apiVersion override, forwarded to apiRootOf; undefined means the auto rule. */
	readonly apiVersion?: string | undefined;
	/** Empty string for keyless servers, matching the transport convention. */
	readonly apiKey: string;
	/** The entry's custom headers; auth headers win conflicts. */
	readonly headers: Readonly<Record<string, string>>;
	readonly oauth?: OAuthConfig | undefined;
	readonly virtualKey?: VirtualKeyConfig | undefined;
}

export interface OneShotClientOptions {
	readonly userAgent: string;
}

export interface OneShotCallOptions {
	/** Hard whole-call bound, the OAuth exchange and the body read included. */
	readonly timeoutMs: number;
	readonly token: vscode.CancellationToken;
}

/**
 * The per-call abort machinery a postJson consumer may need: the combined
 * cancel+timeout signal the fetch is armed with, its timeout source, and the
 * abort that kills the in-flight exchange. Consumers that let the body outlive
 * the call hold this scope in their bridge closures, which also keeps both
 * signals strongly reachable for the body's lifetime - AbortSignal.any's
 * source tracking has been weak in some runtimes (nodejs/node#57736), and the
 * whole-call bound must not be collectable while a body is outstanding.
 */
interface CallScope {
	readonly requestSignal: AbortSignal;
	readonly timeoutSignal: AbortSignal;
	readonly abort: () => void;
}

/**
 * Keep user cancellation aborting an in-flight response whose body outlives
 * the call: postJson's own call-scoped bridge dies in its finally, so a
 * consumer handing the body outward (sendJson, completeChatStream) arms this
 * second bridge. It disposes itself when the combined signal fires - the
 * whole-call timeout always does - so nothing dangles past the call's hard
 * bound, and its closures hold `scope` (see CallScope) for the body's
 * lifetime.
 */
function armOutlivingCancelBridge(scope: CallScope, token: vscode.CancellationToken): void {
	const bridge = token.onCancellationRequested(() => scope.abort());
	if (scope.requestSignal.aborted) {
		// An already-aborted signal never fires "abort" again (a token cancelled
		// synchronously during registration lands here), so the bridge would
		// linger on the token's emitter; dispose it on the spot instead.
		bridge.dispose();
		return;
	}
	scope.requestSignal.addEventListener("abort", () => bridge.dispose(), { once: true });
}

/**
 * Forward the raw SSE body while attributing terminal read failures through
 * the call's own error pipeline: cancellation surfaces as
 * vscode.CancellationError, the whole-call timeout as the surface's timeout
 * error, and anything else through mapSdkError - the same catch shape as
 * postJson's. The wrapper is what crosses the API boundary, and the combined
 * signal is private to this call, so without it a post-header timeout would
 * reach the consumer as a raw AbortError nothing downstream can classify.
 * Cancelling the wrapper propagates to the raw body, and its closures hold
 * `scope` strongly for the stream's lifetime (see CallScope).
 */
function mappedBodyStream(
	body: ReadableStream<Uint8Array>,
	scope: CallScope,
	token: vscode.CancellationToken,
	errorContext: MapErrorContext
): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			let result: Awaited<ReturnType<typeof reader.read>>;
			try {
				result = await reader.read();
			} catch (err) {
				if (token.isCancellationRequested) {
					throw new vscode.CancellationError();
				}
				if (scope.timeoutSignal.aborted) {
					throw timeoutRequestError(errorContext, err);
				}
				throw mapSdkError(err, errorContext);
			}
			if (result.done) {
				controller.close();
				return;
			}
			controller.enqueue(result.value);
		},
		async cancel(reason: unknown) {
			await reader.cancel(reason);
		},
	});
}

/**
 * The reply text of a non-streaming chat completion, leniently: anything not
 * shaped as choices[0].message.content reads as an empty answer rather than an
 * error, so a malformed 200 body never rides into an error message.
 */
function oneShotContentOf(payload: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return "";
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.choices)) {
		return "";
	}
	const first: unknown = parsed.choices[0];
	if (!isRecord(first) || !isRecord(first.message)) {
		return "";
	}
	return typeof first.message.content === "string" ? first.message.content : "";
}

/**
 * Owns the HTTP side of one-shot completions: header composition through the
 * shared overlay and the whole-call timeout. Exactly ONE instance exists per
 * activation - extension/wiring/features.ts constructs it and hands it to
 * every feature wiring - so OAuth tokens cache across features and
 * invalidate on 401 exactly like the chat and usage paths; a second instance
 * would split that cache.
 */
export class OneShotClient {
	private readonly oauthTokens = new OAuthTokenSource();

	constructor(private readonly options: OneShotClientOptions) {}

	/**
	 * POST one JSON body and return the raw Response, its body unread. Every
	 * failure up to and including the response headers - and any non-2xx, whose
	 * error body is read here - has already been mapped through the shared
	 * pipeline under `surface`. The returned body stays armed with the
	 * whole-call timeout signal, and user cancellation keeps aborting the
	 * in-flight response for as long as that bound runs, so an unconsumed or
	 * stalled body is always reclaimed; failures while the CALLER reads the
	 * body surface raw and are that caller's to map.
	 */
	async sendJson(
		url: string,
		body: string,
		connection: OneShotConnection,
		surface: TransportErrorSurface,
		opts: OneShotCallOptions
	): Promise<Response> {
		return this.postJson(url, body, connection, surface, opts, async (response, scope) => {
			armOutlivingCancelBridge(scope, opts.token);
			return response;
		});
	}

	/** POST the request and return the reply's message content; "" when the model answered with none. */
	async completeChatOnce(
		connection: OneShotConnection,
		request: OneShotChatRequest,
		surface: TransportErrorSurface,
		opts: OneShotCallOptions
	): Promise<string> {
		const url = chatCompletionsUrl(connection.baseUrl, connection.apiVersion);
		const body = JSON.stringify({
			model: request.model,
			messages: request.messages,
			stream: false,
			...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
		});
		const payload = await this.postJson(url, body, connection, surface, opts, (response, scope) =>
			this.readBodyText(response, scope.requestSignal)
		);
		return oneShotContentOf(payload);
	}

	/**
	 * POST one streaming /chat/completions request and return the SSE body for
	 * the streaming machinery (sseFrames + StreamProcessor). The whole-call
	 * timeout stays armed on the returned stream - a stall or an abandoned body
	 * is reclaimed at the hard bound, the chat transport's own semantics - and
	 * user cancellation aborts the in-flight response for as long as that bound
	 * runs. Read failures reach the consumer already classified (see
	 * mappedBodyStream); what the STREAMED PAYLOAD means - in-band error
	 * frames, malformed lines - stays the processor's and the consumer
	 * boundary's business (the chatClient.send pattern).
	 */
	async completeChatStream(
		connection: OneShotConnection,
		request: OneShotChatRequest,
		surface: TransportErrorSurface,
		opts: OneShotCallOptions
	): Promise<ReadableStream<Uint8Array>> {
		const url = chatCompletionsUrl(connection.baseUrl, connection.apiVersion);
		const body = JSON.stringify({
			model: request.model,
			messages: request.messages,
			stream: true,
			...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
		});
		return this.postJson(url, body, connection, surface, opts, async (response, scope) => {
			if (response.body === null) {
				// The shared bodyless-200 constructor (also the streaming chat
				// path's), joined per this call's surface.
				throw bodylessResponseError(surface, response.status, connection.baseUrl);
			}
			armOutlivingCancelBridge(scope, opts.token);
			return mappedBodyStream(response.body, scope, opts.token, {
				surface,
				baseUrl: connection.baseUrl,
				timeoutMs: opts.timeoutMs,
			});
		});
	}

	/**
	 * POST one non-streaming /completions (FIM) request and return its
	 * completion text; undefined when the 200 body carried none (malformed or
	 * choiceless - the caller treats it as "no suggestion", never an error).
	 */
	async completeFim(
		connection: OneShotConnection,
		request: FimCompletionRequest,
		opts: OneShotCallOptions
	): Promise<string | undefined> {
		const url = completionsUrl(connection.baseUrl, connection.apiVersion);
		const body = JSON.stringify({
			model: request.model,
			prompt: request.prompt,
			...(request.suffix !== undefined ? { suffix: request.suffix } : {}),
			max_tokens: request.maxTokens,
			stream: false,
		});
		const payload = await this.postJson(url, body, connection, "completion", opts, (response, scope) =>
			this.readBodyText(response, scope.requestSignal)
		);
		let parsed: unknown;
		try {
			parsed = JSON.parse(payload);
		} catch {
			return undefined;
		}
		return parseCompletionText(parsed);
	}

	/**
	 * Read the whole body inside the call's error pipeline: an abort is left
	 * for postJson's catch to attribute (cancellation first, then timeout), and
	 * a socket death mid-body wraps like a fetch failure, so mapSdkError
	 * classifies it exactly like one on the chat stream.
	 */
	private async readBodyText(response: Response, requestSignal: AbortSignal): Promise<string> {
		try {
			return await response.text();
		} catch (readError) {
			if (requestSignal.aborted) {
				throw readError;
			}
			throw new APIConnectionError({ cause: readError instanceof Error ? readError : undefined });
		}
	}

	/**
	 * The shared HTTP core of every one-shot call: header composition through
	 * the shared overlay, the whole-call timeout, and the one error pipeline
	 * (mapSdkError via the SDK's own error factory). `consume` runs INSIDE the
	 * pipeline with the vetted Response and the call's abort scope, so a body
	 * read there fails exactly like the fetch itself would; each caller owns
	 * its lenient parse of what consume returns.
	 */
	private async postJson<T>(
		url: string,
		body: string,
		connection: OneShotConnection,
		surface: TransportErrorSurface,
		opts: OneShotCallOptions,
		consume: (response: Response, scope: CallScope) => Promise<T>
	): Promise<T> {
		// User cancellation must abort the in-flight request, not just abandon
		// the await, so the token is bridged onto an AbortController combined
		// with the whole-call timeout (the chatClient.send pattern).
		const cancelController = new AbortController();
		const cancelListener = opts.token.onCancellationRequested(() => cancelController.abort());
		const timeoutSignal = AbortSignal.timeout(opts.timeoutMs);
		const requestSignal = AbortSignal.any([cancelController.signal, timeoutSignal]);
		const scope: CallScope = { requestSignal, timeoutSignal, abort: () => cancelController.abort() };
		const errorContext: MapErrorContext = { surface, baseUrl: connection.baseUrl, timeoutMs: opts.timeoutMs };
		let sentOAuthToken: string | undefined;

		try {
			const headers = plainFetchBaseHeaders({
				apiKey: connection.apiKey,
				userAgent: this.options.userAgent,
				customHeaders: connection.headers,
			});
			setOwnedHeader(headers, "Content-Type", "application/json");
			sentOAuthToken = await applyAuthOverlay(headers, connection, {
				tokens: this.oauthTokens,
				surface,
				timeoutMs: opts.timeoutMs,
				signal: requestSignal,
			});
			let response: Response;
			try {
				response = await globalThis.fetch(url, { method: "POST", headers, body, signal: requestSignal });
			} catch (fetchError) {
				if (requestSignal.aborted) {
					// Attributed by the outer catch: cancellation first, then timeout.
					throw fetchError;
				}
				// A plain fetch rejects with a bare TypeError on socket failures; the
				// SDK wrapper is what routes it into mapSdkError's socket classifier,
				// so an ECONNREFUSED here reads exactly like one on the chat stream.
				throw new APIConnectionError({ cause: fetchError instanceof Error ? fetchError : undefined });
			}
			if (!response.ok) {
				// The SDK's own error factory (it extracts the body's `error` envelope
				// itself), so the catch below classifies this plain-fetch failure
				// through the exact mapSdkError pipeline the streaming chat path uses
				// - one classifier, one message shape. A body that is not a JSON
				// object (unparseable, a bare string, an array) rides as recovered
				// text instead, like the SDK keeps raw bodies in its message.
				const payload = await this.readBodyText(response, requestSignal);
				let parsed: unknown;
				try {
					parsed = JSON.parse(payload);
				} catch {
					parsed = undefined;
				}
				const envelope = isRecord(parsed) ? parsed : undefined;
				const recoveredText = envelope === undefined && payload !== "" ? payload : undefined;
				throw APIError.generate(response.status, envelope, recoveredText, response.headers);
			}
			return await consume(response, scope);
		} catch (err) {
			if (opts.token.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			if (timeoutSignal.aborted) {
				throw timeoutRequestError(errorContext, err);
			}
			const mapped = mapSdkError(err, errorContext);
			invalidateRejectedOAuthToken(this.oauthTokens, connection.oauth, mapped, sentOAuthToken);
			throw mapped;
		} finally {
			cancelListener.dispose();
		}
	}
}
