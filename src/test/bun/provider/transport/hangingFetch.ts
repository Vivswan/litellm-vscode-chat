/**
 * The two ways a plain fetch hangs, for the suites that pin a retry under a per-attempt clock: a request that never
 * answers, and a 200 whose body never flows. Neither watches the signal beyond what undici itself does, so a clock that
 * only covers the headers would miss the second.
 */

type Signal = AbortSignal | null | undefined;

/** Never answers; rejects with the signal's reason once it aborts, as undici does. */
function hangBeforeHeaders(signal: Signal): Promise<Response> {
	return new Promise((_resolve, reject) => {
		signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}

/** Answers `status` at once with a body that never flows and never notices the signal. */
export function stalledBody(status: number): Promise<Response> {
	return Promise.resolve(
		new Response(new ReadableStream(), { status, headers: { "content-type": "application/json" } })
	);
}

function stallAfterHeaders(): Promise<Response> {
	return stalledBody(200);
}

export type Hang = (signal: Signal) => Promise<Response>;

export const HANG_PHASES: readonly [phase: string, hang: Hang][] = [
	["before the headers", hangBeforeHeaders],
	["after the headers", stallAfterHeaders],
];
