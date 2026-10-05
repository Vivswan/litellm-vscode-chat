import { APIConnectionError, APIError } from "openai";
import { sleepUnlessAborted } from "../../shared/util/timer";

/** Spacing between attempts grows linearly: attempt n waits n times this, unless the server named a wait. */
const RETRY_DELAY_MS = 200;

/** A server-named wait longer than this is treated as absent, as the SDK does. */
const MAX_SERVER_RETRY_DELAY_MS = 60_000;

export interface RetryOptions {
	readonly maxRetries: number;
	/** The caller's whole-call bound: it ends a sleep and the loop at once, so backoff never outlives it. */
	readonly signal: AbortSignal;
}

/**
 * The SDK's own retry verdict, re-stated here because the SDK's backoff sleep ignores the abort signal, so the SDK
 * runs with maxRetries 0 and this loop retries in its place.
 *   a connection failure, including a per-attempt timeout -> retried
 *   HTTP 408, 409, 429, 5xx                                -> retried
 *   an `x-should-retry` header                             -> overrides the status rule either way
 */
function isRetryableSdkFailure(error: unknown): boolean {
	if (error instanceof APIConnectionError) {
		return true;
	}
	if (!(error instanceof APIError) || error.status === undefined) {
		return false;
	}
	const shouldRetry = error.headers?.get("x-should-retry");
	if (shouldRetry === "true" || shouldRetry === "false") {
		return shouldRetry === "true";
	}
	const { status } = error;
	return status === 408 || status === 409 || status === 429 || status >= 500;
}

/** The server's `retry-after-ms` or `retry-after` (seconds or an HTTP date), when it names a wait the SDK honors. */
function serverRetryDelayMs(error: unknown): number | undefined {
	if (!(error instanceof APIError)) {
		return undefined;
	}
	const ms = Number(error.headers?.get("retry-after-ms") || Number.NaN);
	const after = error.headers?.get("retry-after");
	const delay = Number.isFinite(ms)
		? ms
		: after
			? Number.isNaN(Number(after))
				? Date.parse(after) - Date.now()
				: Number(after) * 1000
			: Number.NaN;
	return Number.isFinite(delay) && delay >= 0 && delay <= MAX_SERVER_RETRY_DELAY_MS ? delay : undefined;
}

export async function retryIdempotent<T>(attempt: () => Promise<T>, options: RetryOptions): Promise<T> {
	for (let retries = 0; ; retries += 1) {
		let failure: unknown;
		try {
			return await attempt();
		} catch (error) {
			if (options.signal.aborted || retries >= options.maxRetries || !isRetryableSdkFailure(error)) {
				throw error;
			}
			failure = error;
		}
		await sleepUnlessAborted(serverRetryDelayMs(failure) ?? RETRY_DELAY_MS * (retries + 1), options.signal);
		if (options.signal.aborted) {
			throw options.signal.reason ?? new Error("The operation was aborted");
		}
	}
}
