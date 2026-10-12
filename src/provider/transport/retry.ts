import { APIConnectionError, APIError } from "openai";
import { MAX_TIMER_MS } from "../../shared/config/settingSpec";
import { sleepUnlessAborted } from "../../shared/util/timer";

/** Spacing between attempts grows linearly: attempt n waits n times this, unless the server named a wait. */
const RETRY_DELAY_MS = 200;

/** A server-named wait longer than this is treated as absent, as the SDK does. */
const MAX_SERVER_RETRY_DELAY_MS = 60_000;

/** Resolves after `ms` or as soon as `signal` aborts, whichever is first; every retry loop reads the signal after it. */
export type BackoffSleep = (ms: number, signal: AbortSignal) => Promise<void>;

export interface RetryOptions {
	readonly maxRetries: number;
	/**
	 * The caller's whole-call bound, a retryBudgetMs deadline or a lifetime cancellation: it ends a sleep and the loop
	 * at once, so backoff never outlives it.
	 */
	readonly signal: AbortSignal;
	/** The real timer unless a test passes a zero sleep, so a retrying case pays no wall time. */
	readonly sleep?: BackoffSleep;
}

/**
 * The SDK's own retry verdict, re-stated here because the SDK's backoff sleep ignores the abort signal, so the SDK
 * runs with maxRetries 0 and this loop retries in its place. The one retry rule for every idempotent GET: the
 * OpenRouter catalog refresh and the catalog fetch script render their failures as these SDK errors to ask it.
 *   a connection failure, including a per-attempt timeout -> retried
 *   HTTP 408, 409, 429, 5xx                                -> retried
 *   an `x-should-retry` header                             -> overrides the status rule either way
 */
export function isRetryableFailure(error: unknown): boolean {
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

/**
 * The whole-call bound to arm around retryIdempotent when each attempt carries its own timeout: every attempt may run
 * to that timeout and every backoff may sleep, so the budget is their sum, clamped to what the platform's timers
 * schedule. Armed at one attempt's timeout instead, a single hung attempt ends the retries the verdict above promises.
 * A server-named wait is not budgeted: the signal ends that sleep.
 */
export function retryBudgetMs(attemptTimeoutMs: number, maxRetries: number): number {
	const backoffMs = (RETRY_DELAY_MS * maxRetries * (maxRetries + 1)) / 2;
	return Math.min(MAX_TIMER_MS, (maxRetries + 1) * attemptTimeoutMs + backoffMs);
}

export async function retryIdempotent<T>(attempt: () => Promise<T>, options: RetryOptions): Promise<T> {
	const sleep = options.sleep ?? sleepUnlessAborted;
	for (let retries = 0; ; retries += 1) {
		let failure: unknown;
		try {
			return await attempt();
		} catch (error) {
			if (options.signal.aborted || retries >= options.maxRetries || !isRetryableFailure(error)) {
				throw error;
			}
			failure = error;
		}
		await sleep(serverRetryDelayMs(failure) ?? RETRY_DELAY_MS * (retries + 1), options.signal);
		if (options.signal.aborted) {
			throw options.signal.reason ?? new Error("The operation was aborted");
		}
	}
}
