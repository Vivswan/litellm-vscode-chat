import { APIConnectionError, APIError } from "openai";
import * as vscode from "vscode";
import { isRecord } from "../../shared/util/json";
import type { OAuthConfig, VirtualKeyConfig } from "./auth";
import { OAuthTokenSource } from "./auth";
import { applyAuthOverlay, invalidateRejectedOAuthToken, plainFetchBaseHeaders, setOwnedHeader } from "./authOverlay";
import { chatCompletionsUrl, completionsUrl } from "./clients";
import { type MapErrorContext, mapSdkError, timeoutRequestError } from "./errorMapping";
import { parseCompletionText } from "./fim";

/**
 * The one-shot transport: single non-streaming POSTs whose whole reply is one
 * string - /chat/completions for the background chat features (commit message
 * generation) and /completions for inline completions (FIM). Both need an
 * answer, not a stream, so this stays a plain fetch on the spend-client
 * pattern - no SDK client cache, no retries (completions never retry), and
 * the shared auth overlay for its headers.
 *
 * Error ownership follows the transport-module convention: construct specific
 * errors through the existing chat-surface constructors and throw WITHOUT
 * logging; the caller's boundary logs once. Cancellation surfaces as
 * vscode.CancellationError and is never logged.
 */

/** One wire message of a one-shot request; this path carries plain text only, no multimodal parts. */
export interface OneShotChatMessage {
	readonly role: "system" | "user" | "assistant";
	readonly content: string;
}

/**
 * The request fields a one-shot call sends, and nothing else: the body is
 * exactly model/messages/stream:false, plus max_tokens only when the caller
 * sets it - the pass-through invariant's "never inject what the user did not
 * set" applied to a provider-owned surface.
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
 * shared overlay and the whole-call timeout. One instance per feature wiring
 * so OAuth tokens cache across calls and invalidate on 401 exactly like the
 * chat and usage paths.
 */
export class OneShotClient {
	private readonly oauthTokens = new OAuthTokenSource();

	constructor(private readonly options: OneShotClientOptions) {}

	/** POST the request and return the reply's message content; "" when the model answered with none. */
	async completeChatOnce(
		connection: OneShotConnection,
		request: OneShotChatRequest,
		opts: OneShotCallOptions
	): Promise<string> {
		const url = chatCompletionsUrl(connection.baseUrl, connection.apiVersion);
		const body = JSON.stringify({
			model: request.model,
			messages: request.messages,
			stream: false,
			...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
		});
		return oneShotContentOf(await this.postJson(url, body, connection, "chat", opts));
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
	 * The shared HTTP core of both one-shot calls: header composition through
	 * the shared overlay, the whole-call timeout, and the one error pipeline
	 * (mapSdkError via the SDK's own error factory). Returns the raw 200 body;
	 * each caller owns its lenient parse.
	 */
	private async postJson(
		url: string,
		body: string,
		connection: OneShotConnection,
		surface: MapErrorContext["surface"],
		opts: OneShotCallOptions
	): Promise<string> {
		// User cancellation must abort the in-flight request, not just abandon
		// the await, so the token is bridged onto an AbortController combined
		// with the whole-call timeout (the chatClient.send pattern).
		const cancelController = new AbortController();
		const cancelListener = opts.token.onCancellationRequested(() => cancelController.abort());
		const timeoutSignal = AbortSignal.timeout(opts.timeoutMs);
		const requestSignal = AbortSignal.any([cancelController.signal, timeoutSignal]);
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
			let payload: string;
			try {
				response = await globalThis.fetch(url, { method: "POST", headers, body, signal: requestSignal });
				payload = await response.text();
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
			return payload;
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
