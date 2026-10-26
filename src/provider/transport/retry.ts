import { APIConnectionError, APIConnectionTimeoutError, APIError } from "openai";
import { MAX_TIMER_MS } from "../../shared/config/settingSpec";
import { sleepUnlessAborted } from "../../shared/util/timer";

/** Spacing between attempts grows linearly: attempt n waits n times this, unless the server named a wait. */
const RETRY_DELAY_MS = 200;

/** A server-named wait longer than this is treated as absent, as the SDK does. */
const MAX_SERVER_RETRY_DELAY_MS = 60_000;

/** Resolves after `ms` or as soon as `signal` aborts, whichever is first; every retry loop reads the signal after it. */
export type BackoffSleep = (ms: number, signal: AbortSignal) => Promise<void>;

/**
 * What retryIdempotent runs under. `signal` is the caller's whole-call bound, a retryBudgetMs deadline or a lifetime
 * cancellation: it ends a sleep and the loop at once, so backoff never outlives it. `sleep` is the real timer unless a
 * test passes a zero sleep, so a retrying case pays no wall time.
 */
export interface RetryOptions {
	readonly maxRetries: number;

	readonly signal: AbortSignal;

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

/** A `retry-after` value in milliseconds: seconds when numeric, else an HTTP date relative to now; NaN when absent. */
function retryAfterMs(after: string | null | undefined): number {
	if (!after) {
		return Number.NaN;
	}
	const seconds = Number(after);
	return Number.isNaN(seconds) ? Date.parse(after) - Date.now() : seconds * 1000;
}

/** The server's `retry-after-ms` or `retry-after` (seconds or an HTTP date), when it names a wait the SDK honors. */
function serverRetryDelayMs(error: unknown): number | undefined {
	if (!(error instanceof APIError)) {
		return undefined;
	}
	const ms = Number(error.headers?.get("retry-after-ms") || Number.NaN);
	const delay = Number.isFinite(ms) ? ms : retryAfterMs(error.headers?.get("retry-after"));
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

/**
 * What one attempt answered, the body read whole under the attempt's clock, so an OK stream that stalls after the
 * headers times out like a connect that never finished. A non-OK response whose body is lost to that clock or the
 * socket is judged on its status with an empty `text`, as the SDK does. The caller's abort and the budget's still
 * end the call unjudged.
 */
export interface FetchAnswer {
	readonly response: Response;
	readonly text: string;
}

/**
 * What retryFetch runs under.
 *   attemptTimeoutMs -> each attempt's own clock over the headers and the body together; retryBudgetMs derives the
 *                       whole-call budget from it and maxRetries
 *   signal           -> the caller's lifetime bound: its abort ends the call at once and is rethrown as-is, never
 *                       read as a timeout
 *   sleep            -> the real timer unless a test passes a zero sleep
 */
export interface RetryFetchOptions {
	readonly attemptTimeoutMs: number;

	readonly maxRetries: number;

	readonly signal?: AbortSignal | undefined;

	readonly sleep?: BackoffSleep;
}

export function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new Error("The operation was aborted");
}

/** `signal` ends only this wait; the promise runs on for its other awaiters. */
export function abortableWait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		return Promise.reject(abortReason(signal));
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(abortReason(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			}
		);
	});
}

/**
 * retryIdempotent over a plain fetch, under the two clocks the SDK-backed discovery GETs run on: each attempt gets
 * `attemptTimeoutMs` for its headers and body together, and the whole call ends at retryBudgetMs of it. Every failure
 * leaves in the SDK's vocabulary, so the one retry rule above judges it and the caller maps it once.
 *   the caller's signal aborting              -> rethrown as-is, never retried
 *   the budget                                -> APIConnectionTimeoutError
 *   an attempt's clock                        -> APIConnectionTimeoutError
 *   a connect failure or a socket death       -> APIConnectionError carrying the cause
 *   either of those two over a non-OK body    -> judged on its status instead, the body unread, so a 401 is final
 *   what `judge` throws                       -> retried when the rule says so (an APIError 5xx), final otherwise
 */
export async function retryFetch<T>(
	request: (signal: AbortSignal) => Promise<Response>,
	judge: (answer: FetchAnswer) => T,
	options: RetryFetchOptions
): Promise<T> {
	const { attemptTimeoutMs, maxRetries, sleep } = options;
	const budget = AbortSignal.timeout(retryBudgetMs(attemptTimeoutMs, maxRetries));
	const bounds = options.signal === undefined ? budget : AbortSignal.any([options.signal, budget]);
	try {
		return await retryIdempotent(
			async () => {
				const attemptClock = AbortSignal.timeout(attemptTimeoutMs);
				const signal = AbortSignal.any([bounds, attemptClock]);
				const failAttempt = (error: unknown): never => {
					if (bounds.aborted) {
						throw error;
					}
					throw attemptClock.aborted
						? new APIConnectionTimeoutError()
						: new APIConnectionError({ cause: error instanceof Error ? error : undefined });
				};
				const response = await request(signal).catch(failAttempt);
				// Raced against the signal, so a body that never flows and never watches it still ends on the clock.
				const text = await abortableWait(response.text(), signal).catch((error: unknown) => {
					// The headers already named the verdict; only the caller's or the budget's abort outranks it.
					if (response.ok || bounds.aborted) {
						failAttempt(error);
					}
					return "";
				});
				return judge({ response, text });
			},
			{ maxRetries, signal: bounds, ...(sleep === undefined ? {} : { sleep }) }
		);
	} catch (error) {
		// Read after the fact, not from the error: the budget can fire first and the caller leave in the same turn,
		// before the rejection lands, and the caller's reason is still the verdict.
		if (options.signal?.aborted) {
			throw abortReason(options.signal);
		}
		throw budget.aborted ? new APIConnectionTimeoutError() : error;
	}
}
