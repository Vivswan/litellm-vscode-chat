import { APIConnectionError, APIError } from "openai";
import * as vscode from "vscode";
import { fixedHeaderValue, type HeaderValue } from "../../shared/util/headers";
import { isRecord } from "../../shared/util/json";
import type { OAuthConfig, TimeoutBudget, VirtualKeyConfig } from "./auth";
import { OAuthTokenSource } from "./auth";
import type { AuthOverlayScope } from "./authOverlay";
import { applyAuthOverlay, plainFetchBaseHeaders, setOwnedHeader } from "./authOverlay";
import { chatCompletionsUrl, completionsUrl } from "./clients";
import { mapSdkError } from "./errorMapping";
import { parseCompletionText } from "./fim";
import type { TransportFetch } from "./nodeHttpFetch";
import { nodeHttpFetch } from "./nodeHttpFetch";
import type { MapErrorContext, TransportErrorSurface } from "./transportErrors";
import { RequestError, timeoutRequestError } from "./transportErrors";

/**
 * No retries, since completions never retry.
 *   Transport-module error ownership applies -> the caller's boundary logs once, and cancellation surfaces as
 *     vscode.CancellationError, never logged
 */

export interface OneShotChatMessage {
	readonly role: "system" | "user" | "assistant";
	readonly content: string;
}

/**
 * The request fields a one-shot chat call sends, and nothing else: the body is exactly model/messages/stream:false,
 * plus max_tokens only when the caller sets it - the pass-through invariant's "never inject what the user did not
 * set" applied to a provider-owned surface.
 */
export interface OneShotChatRequest {
	readonly model: string;
	readonly messages: readonly OneShotChatMessage[];
	readonly maxTokens?: number | undefined;
}

/**
 * The request fields a FIM call sends, and nothing else: the body is exactly
 * model/prompt/suffix/max_tokens/stream:false, with `suffix` omitted when a `_fim_template` already placed it inside
 * the prompt. models.parameters records deliberately do NOT apply to /completions - the template directive is the one
 * documented exception, and it is applied by the caller through buildFimPrompt, never sent.
 */
export interface FimCompletionRequest {
	readonly model: string;
	readonly prompt: string;
	/** Absent exactly when the template owns the whole prompt. */
	readonly suffix?: string | undefined;
	readonly maxTokens: number;
}

/**
 * Structurally satisfied by the usage subsystem's UsageConnection, so extension-side features resolve their
 * connection once and hand it to both.
 */
export interface OneShotConnection {
	readonly baseUrl: string;
	/** Forwarded to apiRootOf; undefined means the auto rule. */
	readonly apiVersion?: string | undefined;
	/** Empty string for keyless servers, matching the transport convention. */
	readonly apiKey: HeaderValue | "";
	/** Auth headers win conflicts. */
	readonly headers: Readonly<Record<string, HeaderValue>>;
	readonly oauth?: OAuthConfig | undefined;
	readonly virtualKey?: VirtualKeyConfig | undefined;
}

export interface OneShotClientOptions {
	readonly userAgent: HeaderValue;
	/** The HTTP transport; tests inject a fake here. */
	readonly fetch?: TransportFetch | undefined;
}

const JSON_CONTENT_TYPE = fixedHeaderValue("application/json");

export interface OneShotCallOptions {
	/**
	 * Hard whole-call bound, this call's OAuth token wait and the body read included, with the identity of the
	 * setting that owns it (undefined for fixed bounds like the inline-completion timeout). Minted where the
	 * caller reads its number, so timeout advice names the setting that really governs this call's clock or none.
	 */
	readonly timeout: TimeoutBudget;
	readonly token: vscode.CancellationToken;
}

/**
 * The reply text of a non-streaming chat completion, leniently: anything not shaped as choices[0].message.content
 * reads as an empty answer rather than an error, so a malformed 200 body never rides into an error message.
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
 * Owns the HTTP side of one-shot completions.
 *
 *   Exactly ONE instance exists per activation - extension/wiring/features.ts constructs it -> OAuth tokens cache
 *     across features and invalidate on 401 exactly like the chat and usage paths; a second instance would split
 *     that cache
 */
export class OneShotClient {
	private readonly oauthTokens = new OAuthTokenSource();
	private readonly fetch: TransportFetch;

	constructor(private readonly options: OneShotClientOptions) {
		this.fetch = options.fetch ?? nodeHttpFetch;
	}

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
		return oneShotContentOf(await this.postJson(url, body, connection, surface, opts));
	}

	/**
	 * POST one non-streaming /completions (FIM) request and return its completion text; undefined when the 200 body
	 * carried none (malformed or choiceless - the caller treats it as "no suggestion", never an error).
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
		const payload = await this.postJson(url, body, connection, "completion", opts);
		let parsed: unknown;
		try {
			parsed = JSON.parse(payload);
		} catch {
			return undefined;
		}
		return parseCompletionText(parsed);
	}

	/**
	 * Read the whole body inside the call's error pipeline: an abort is left for postJson's catch to attribute
	 * (cancellation first, then timeout), and a socket death mid-body wraps like a fetch failure.
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
	 * The editor sends these headers itself and owns the 401s, so a token the server stops accepting is corrected by
	 * the next exchange after expiry, never by a rejection here.
	 *
	 * The caller's whole-call `timeout` is the token wait's only clock; nothing here adds a second.
	 *
	 *   `timeout` elapses -> the OAuth timeout message naming the setting to raise
	 *   `token` cancels   -> the cancellation, as-is
	 */
	async authHeaders(
		connection: OneShotConnection,
		surface: TransportErrorSurface,
		opts: OneShotCallOptions
	): Promise<Record<string, HeaderValue>> {
		const cancelController = new AbortController();
		const cancelListener = opts.token.onCancellationRequested(() => cancelController.abort());
		try {
			const headers = plainFetchBaseHeaders({
				apiKey: connection.apiKey,
				userAgent: this.options.userAgent,
				customHeaders: connection.headers,
			});
			// The overlay scope is deliberately dropped: no request of ours goes out with these headers (the editor
			// sends them), so no rejection ever comes back here to route through fail - the documented pairless call
			// site in the authOverlayScope census.
			await applyAuthOverlay(headers, connection, {
				tokens: this.oauthTokens,
				surface,
				timeout: opts.timeout,
				signal: cancelController.signal,
			});
			return headers;
		} catch (err) {
			if (opts.token.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			throw err instanceof RequestError
				? err
				: mapSdkError(err, { surface, baseUrl: connection.baseUrl, timeoutMs: opts.timeout.ms });
		} finally {
			cancelListener.dispose();
		}
	}

	/**
	 * The shared HTTP core of every one-shot call, one error pipeline (mapSdkError via the SDK's own error factory)
	 * for the fetch and the body read alike; each caller owns its lenient parse of the returned body text.
	 */
	private async postJson(
		url: string,
		body: string,
		connection: OneShotConnection,
		surface: TransportErrorSurface,
		opts: OneShotCallOptions
	): Promise<string> {
		// User cancellation must abort the in-flight request, not just abandon the await, so the token is bridged onto
		// an AbortController combined with the whole-call timeout (the chatClient.send pattern).
		const cancelController = new AbortController();
		const cancelListener = opts.token.onCancellationRequested(() => cancelController.abort());
		const timeoutSignal = AbortSignal.timeout(opts.timeout.ms);
		const requestSignal = AbortSignal.any([cancelController.signal, timeoutSignal]);
		const errorContext: MapErrorContext = { surface, baseUrl: connection.baseUrl, timeoutMs: opts.timeout.ms };
		let auth: AuthOverlayScope | undefined;

		try {
			const headers = plainFetchBaseHeaders({
				apiKey: connection.apiKey,
				userAgent: this.options.userAgent,
				customHeaders: connection.headers,
			});
			// Before the overlay, so a virtual key named Content-Type still owns that header.
			setOwnedHeader(headers, "Content-Type", JSON_CONTENT_TYPE);
			auth = await applyAuthOverlay(headers, connection, {
				tokens: this.oauthTokens,
				surface,
				timeout: opts.timeout,
				signal: requestSignal,
			});
			let response: Response;
			try {
				response = await this.fetch(url, { method: "POST", headers, body, signal: requestSignal });
			} catch (fetchError) {
				if (requestSignal.aborted) {
					// Attributed by the outer catch: cancellation first, then timeout.
					throw fetchError;
				}
				// The transport rejects with a bare TypeError on socket failures; the SDK wrapper is what routes it
				// into mapSdkError's socket classifier, so an ECONNREFUSED here reads exactly like one on the chat
				// stream.
				throw new APIConnectionError({ cause: fetchError instanceof Error ? fetchError : undefined });
			}
			if (!response.ok) {
				// The SDK's own error factory (it extracts the body's `error` envelope itself), so the catch below
				// classifies this plain-fetch failure through the exact mapSdkError pipeline the streaming chat path
				// uses - one classifier, one message shape. A body that is not a JSON object (unparseable, a bare
				// string, an array) rides as recovered text instead, like the SDK keeps raw bodies in its message.
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
			return await this.readBodyText(response, requestSignal);
		} catch (err) {
			if (opts.token.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			if (timeoutSignal.aborted) {
				throw timeoutRequestError(errorContext, err);
			}
			const mapped = mapSdkError(err, errorContext);
			auth?.fail(mapped);
			throw mapped;
		} finally {
			cancelListener.dispose();
		}
	}
}
