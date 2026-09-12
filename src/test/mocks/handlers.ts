import { HttpResponse, http, type JsonBodyType, type RequestHandler } from "msw";
import { setupServer } from "msw/node";
import { OPENROUTER_MODELS_URL } from "../../shared/config/openRouterCatalog";

/** Base URL every unit-test server config points at. */
export const TEST_BASE_URL = "http://litellm.test";
export const MODEL_INFO_URL = `${TEST_BASE_URL}/v1/model/info`;
export const MODELS_URL = `${TEST_BASE_URL}/v1/models`;
export const CHAT_COMPLETIONS_URL = `${TEST_BASE_URL}/v1/chat/completions`;
export const COMPLETIONS_URL = `${TEST_BASE_URL}/v1/completions`;

/**
 * Initial handlers survive resetHandlers() and per-test use() handlers take precedence, so these two baselines
 * absorb the requests no suite registers for. msw intercepts nothing between a file's close() and the next file's
 * listen(), so the unit label's primary catalog guard stays util/fingerprintSalt.ts's mochaGlobalSetup.
 *
 *   localhost:49999/*     -> refreshes of panelIntegration's leftover host provider group (no group-removal API)
 *   OPENROUTER_MODELS_URL -> any OpenRouter catalog refresh that fires while msw is listening
 */
export const mswServer = setupServer(
	http.all("http://localhost:49999/*", () => emptyErrorResponse(503)),
	http.get(OPENROUTER_MODELS_URL, () => emptyErrorResponse(503))
);

let activeSuites = 0;

/**
 * Install the msw lifecycle on the calling suite. What keeps interceptors away
 * from fetch-mocking suites is that each file's suiteTeardown closes the server
 * before the next file runs; the counter only exists so two opted-in suites
 * within one file share a single listen/close cycle.
 */
export function useMsw(): void {
	suiteSetup(() => {
		if (activeSuites === 0) {
			mswServer.listen({ onUnhandledRequest: "error" });
		}
		activeSuites += 1;
	});
	suiteTeardown(() => {
		activeSuites -= 1;
		if (activeSuites === 0) {
			mswServer.close();
		}
	});
	teardown(() => {
		mswServer.resetHandlers();
	});
}

/** JSON handlers answering both discovery endpoints with the same payload. */
export function discoveryHandlers(payload: JsonBodyType): RequestHandler[] {
	return [
		http.get(MODEL_INFO_URL, () => HttpResponse.json(payload)),
		http.get(MODELS_URL, () => HttpResponse.json(payload)),
	];
}

/**
 * An error response with an empty body. Responses with retryable statuses
 * (5xx) must use this: the SDK cancels the unread body before retrying, and
 * cancelling an msw-mocked body never settles (msw 2.15), deadlocking the
 * retry. The SDK skips the cancel for a null body.
 */
export function emptyErrorResponse(status: number, headers?: Record<string, string>): Response {
	return new HttpResponse(null, headers ? { status, headers } : { status });
}

/** An SSE response streaming the given pre-formatted event strings. */
export function sseResponse(...events: string[]): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const event of events) {
				controller.enqueue(encoder.encode(event));
			}
			controller.close();
		},
	});
	return new HttpResponse(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** An SSE response delivering one content delta followed by [DONE]. */
export function sseTextResponse(text: string): Response {
	const chunk = JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] });
	return sseResponse(`data: ${chunk}\n\n`, "data: [DONE]\n\n");
}

/** A non-streaming /completions body carrying one choice's text (the FIM response shape). */
export function completionJsonResponse(text: string): Response {
	return HttpResponse.json({ choices: [{ index: 0, text, finish_reason: "stop" }] });
}
