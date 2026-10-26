import { describe, expect, test } from "bun:test";
import { APIConnectionTimeoutError, APIError } from "openai";
import type { BackoffSleep } from "../../../../provider/transport/retry";
import { retryBudgetMs, retryFetch } from "../../../../provider/transport/retry";
import { sleepUnlessAborted } from "../../../../shared/util/timer";
import { HANG_PHASES, type Hang, stalledBody } from "./hangingFetch";

/** Per attempt, far below any real setting: the clocks under test are the attempt's and the budget's. */
const ATTEMPT_TIMEOUT_MS = 50;

const MAX_RETRIES = 2;
const noBackoff: BackoffSleep = () => Promise.resolve();

function fakeServer(
	respond: (attempt: number, signal: AbortSignal) => Promise<Response> | undefined,
	signal?: AbortSignal
) {
	let attempts = 0;
	const judged: number[] = [];
	const call = retryFetch(
		(attemptSignal) => {
			attempts += 1;
			return respond(attempts, attemptSignal) ?? Promise.resolve(Response.json({ served: true }));
		},
		({ response, text }) => {
			judged.push(response.status);
			if (!response.ok) {
				throw new APIError(response.status, undefined, undefined, undefined);
			}
			return JSON.parse(text) as unknown;
		},
		{ attemptTimeoutMs: ATTEMPT_TIMEOUT_MS, maxRetries: MAX_RETRIES, signal, sleep: noBackoff }
	);
	return { call, attempts: () => attempts, judged };
}

const hangingServer = (hang: Hang, hangs: number, signal?: AbortSignal) =>
	fakeServer((attempt, attemptSignal) => (attempt <= hangs ? hang(attemptSignal) : undefined), signal);

const stallingServer = (statuses: readonly number[], signal?: AbortSignal) =>
	fakeServer((attempt) => {
		const status = statuses[attempt - 1];
		return status === undefined ? undefined : stalledBody(status);
	}, signal);

describe("retryFetch runs each attempt on its own clock inside the retry budget", () => {
	// Regression: the plain-fetch callers (the usage GETs, the OAuth exchange) bounded the whole call with one
	// AbortSignal.timeout equal to the attempt timeout, so one hung attempt spent the budget and no retry ever ran.
	test.each(HANG_PHASES)(
		"a first attempt that hangs %s is retried and the second attempt's answer serves",
		async (_phase, hang) => {
			const server = hangingServer(hang, 1);
			expect(await server.call).toEqual({ served: true });
			expect(server.attempts()).toBe(2);
		}
	);

	test.each(HANG_PHASES)(
		"every attempt hanging %s runs every attempt and ends inside the budget as the SDK's timeout",
		async (_phase, hang) => {
			const server = hangingServer(hang, Number.POSITIVE_INFINITY);
			const started = Date.now();
			const failure = await server.call.then(
				() => undefined,
				(error: unknown) => error
			);
			expect(failure).toBeInstanceOf(APIConnectionTimeoutError);
			expect(Date.now() - started).toBeLessThan(retryBudgetMs(ATTEMPT_TIMEOUT_MS, MAX_RETRIES));
			expect(server.attempts()).toBe(MAX_RETRIES + 1);
		}
	);

	test("the budget ends a server-named wait longer than itself, and the call ends as the timeout", async () => {
		// Pins what the hang cases cannot: with a zero backoff every attempt settles well before the budget, so only a
		// sleep the budget must cut shows the budget is armed at all. The real sleep is in play, so the attempt timeout
		// is small and the retry count one: the budget is two attempts plus one 200 ms backoff step.
		let attempts = 0;
		const started = Date.now();
		const failure = await retryFetch(
			() => {
				attempts += 1;
				return Promise.resolve(new Response("", { status: 503, headers: { "retry-after": "60" } }));
			},
			({ response }) => {
				throw new APIError(response.status, undefined, undefined, response.headers);
			},
			{ attemptTimeoutMs: 20, maxRetries: 1 }
		).then(
			() => undefined,
			(error: unknown) => error
		);
		expect(failure).toBeInstanceOf(APIConnectionTimeoutError);
		expect(attempts).toBe(1);
		expect(Date.now() - started).toBeLessThan(5 * retryBudgetMs(20, 1));
	});

	test.each(HANG_PHASES)(
		"the caller's abort during an attempt that hangs %s ends the call with its own reason and no further attempt",
		async (_phase, hang) => {
			const controller = new AbortController();
			const reason = new Error("caller left");
			const server = hangingServer(hang, Number.POSITIVE_INFINITY, controller.signal);
			setTimeout(() => controller.abort(reason), ATTEMPT_TIMEOUT_MS / 5);
			const failure = await server.call.then(
				() => undefined,
				(error: unknown) => error
			);
			// Both phases surface the caller's own reason: the request rejects with it, and the body read's race does too.
			expect(failure).toBe(reason);
			expect(server.attempts()).toBe(1);
		}
	);

	test("the caller's abort in the same turn as the budget's surfaces the caller's reason, not the budget's", async () => {
		// The budget fires inside the last attempt when a backoff ran longer than budgeted; a caller leaving in that same
		// turn, before the rejection reaches the catch, owns the verdict. Regression: the budget's own TimeoutError was
		// rethrown as if it were the caller's reason.
		const attemptTimeoutMs = 200;
		const controller = new AbortController();
		const reason = new Error("caller left");
		let attempts = 0;
		let abortedInsideAttemptMs: number | undefined;
		const failure = await retryFetch(
			(signal) => {
				attempts += 1;
				const attemptStarted = Date.now();
				return new Promise<Response>((_resolve, reject) => {
					signal.addEventListener(
						"abort",
						() => {
							if (attempts === 2) {
								abortedInsideAttemptMs = Date.now() - attemptStarted;
								controller.abort(reason);
							}
							reject(signal.reason);
						},
						{ once: true }
					);
				});
			},
			() => {
				throw new Error("never answered");
			},
			{
				attemptTimeoutMs,
				maxRetries: 1,
				signal: controller.signal,
				// Longer than the 200 ms step the budget allows for, so the budget (two attempts plus that step) fires
				// while attempt two is still inside its own clock.
				sleep: (_ms, signal) => sleepUnlessAborted(300, signal),
			}
		).then(
			() => undefined,
			(error: unknown) => error
		);
		expect(attempts).toBe(2);
		expect(abortedInsideAttemptMs).toBeLessThan(attemptTimeoutMs);
		expect(failure).toBe(reason);
	});
});

describe("retryFetch keeps a non-OK status whose body stalls", () => {
	// Regression: the body read ran under the attempt clock with no look at the headers, so a 401 whose body never
	// flowed was retried as a timeout, every attempt ran, and the callers reported the clock instead of the refusal.
	test.each([
		[401, 1],
		[503, MAX_RETRIES + 1],
	])(
		"every attempt answering a %i whose body stalls ends as that status after %i attempt(s), never as the clock",
		async (status, attempts) => {
			const server = stallingServer([status, status, status]);
			const failure = await server.call.then(
				() => undefined,
				(error: unknown) => error
			);
			expect(failure).toBeInstanceOf(APIError);
			expect((failure as APIError).status).toBe(status);
			expect(server.judged).toEqual(Array<number>(attempts).fill(status));
			expect(server.attempts()).toBe(attempts);
		}
	);

	test("a 503 whose body stalls is retried by its status and the next attempt's answer serves", async () => {
		const server = stallingServer([503]);
		expect(await server.call).toEqual({ served: true });
		expect(server.judged).toEqual([503, 200]);
		expect(server.attempts()).toBe(2);
	});

	test("the caller's abort during a stalled 401 body ends the call with the caller's reason, unjudged", async () => {
		const controller = new AbortController();
		const reason = new Error("caller left");
		const server = stallingServer([401], controller.signal);
		setTimeout(() => controller.abort(reason), ATTEMPT_TIMEOUT_MS / 5);
		const failure = await server.call.then(
			() => undefined,
			(error: unknown) => error
		);
		expect(failure).toBe(reason);
		expect(server.judged).toEqual([]);
		expect(server.attempts()).toBe(1);
	});
});
