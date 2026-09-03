// scripts/dev/openRouterCatalogFetch.ts
//
// The network half of fetch-openrouter-catalog.ts: one bounded GET of the
// OpenRouter models endpoint, retried under the rule the runtime refresh
// shares, with every failure class named as what it is. The classification is
// the whole point - CI operators triage from the message alone, and a body
// that stalls at a CDN edge (headers 200, bytes never finishing) used to
// surface as "the response body is not JSON" because the abort landed inside
// a discarded catch.
//
// Every failure here is an UnreachableError - OpenRouter did not hand over a
// catalog - carrying the OpenRouterFetchFailure reason both fetchers share:
// the connect/headers phase timing out or failing, a non-2xx status, the body
// read timing out or breaking, and a completed body that is not JSON.
// Whether a failure earns another attempt is isRetryableOpenRouterFailure's
// call, not this module's: a timeout, a connection failure, or a 408/409/429/
// 5xx retries; any other 4xx and a non-JSON 200 (a CDN interstitial) are the
// server's settled answer within this run's budget and exit after one attempt
// with the same evidence. Schema drift is the caller's judgement over the
// parsed payload, never made here.

import {
	isRetryableOpenRouterFailure,
	OPENROUTER_MODELS_URL,
	type OpenRouterFetchFailure,
} from "../../src/shared/config/openRouterCatalog";

/**
 * Per-attempt budget covering the connect, the headers, and the whole body
 * read; one signal carries it through every phase so a stall anywhere trips
 * the same clock.
 */
export const FETCH_TIMEOUT_MS = 20_000;

/**
 * Retryable failures (idempotent GET; CI runners hit rate limits) get this
 * many attempts; settled answers and schema drift get one.
 */
export const FETCH_ATTEMPTS = 3;

const RETRY_BASE_DELAY_MS = 5_000;

/** The pause after failed attempt `attempt` (1-based): 5 s, 15 s, 45 s, ... - a rate limit wants room, not a hammer. */
export function retryDelayMs(attempt: number): number {
	return RETRY_BASE_DELAY_MS * 3 ** (attempt - 1);
}

export function worstCaseWallTimeMs(): number {
	let total = FETCH_ATTEMPTS * FETCH_TIMEOUT_MS;
	for (let attempt = 1; attempt < FETCH_ATTEMPTS; attempt += 1) {
		total += retryDelayMs(attempt);
	}
	return total;
}

/** OpenRouter did not hand over a catalog; `reason` is the shared classification the retry loop consults. */
export class UnreachableError extends Error {
	constructor(
		readonly reason: OpenRouterFetchFailure,
		message: string
	) {
		super(message);
	}
}

/**
 * The operator-facing words for an UnreachableError, read from the shared
 * retry rule and nowhere else: `headline` prefixes the evidence in both the
 * lenient ::warning:: line and the fatal stderr line, `advice` is the fatal
 * path's second line. A retryable reason says transient; a settled answer (a
 * 404, an interstitial 200) says so, never the other way round.
 */
export function unreachableVerdict(error: UnreachableError): { readonly headline: string; readonly advice: string } {
	return isRetryableOpenRouterFailure(error.reason)
		? {
				headline: "OpenRouter unreachable (transient)",
				advice: "Not a schema problem - retry once the endpoint is reachable.",
			}
		: {
				headline: "OpenRouter answered but the catalog was unusable (settled, not retried)",
				advice:
					"Not a schema problem - the endpoint answered but the catalog was unusable; " +
					"check the URL and the response before retrying.",
			};
}

/**
 * How the fetch script exits on a failure. Anything that is not an
 * UnreachableError - schema drift above all - is fatal in every mode. An
 * UnreachableError is fatal by default; under `unreachableIsWarning` it is one
 * GitHub `::warning::` line carrying the evidence and exit 0, whatever its
 * reason, headlined by unreachableVerdict. Push-to-main builds opt in, so a
 * third-party outage does not block landing; pull request runs, ci.yml's weekly
 * schedule, manual dispatch, and the release build's own fetch stay fatal, so
 * an outage is still caught loudly where a re-run is cheap.
 */
export type FailureExit = { readonly exitCode: 0; readonly warning: string } | { readonly exitCode: 1 };

export function failureExit(error: unknown, options: { readonly unreachableIsWarning: boolean }): FailureExit {
	if (options.unreachableIsWarning && error instanceof UnreachableError) {
		return {
			exitCode: 0,
			warning:
				`::warning::${unreachableVerdict(error).headline}: ${error.message}; ` +
				"skipping the live catalog check on this push - pull request runs, ci.yml's weekly schedule, and release builds still fail on it",
		};
	}
	return { exitCode: 1 };
}

export interface CatalogFetchOptions {
	readonly fetch: (url: string, init: { readonly signal: AbortSignal }) => Promise<Response>;
	readonly timeoutMs: number;
	readonly sleep: (ms: number) => Promise<void>;
	readonly onRetry: (line: string) => void;
}

const BODY_HEAD_BYTES = 200;

/** The response facts every body-phase message carries, so a CDN interstitial is recognizable from the log alone. */
function describeResponse(response: Response, body: Uint8Array): string {
	const contentType = response.headers.get("content-type") ?? "absent";
	const contentLength = response.headers.get("content-length") ?? "absent";
	const head = body.subarray(0, BODY_HEAD_BYTES);
	return (
		`status ${response.status}, content-type ${contentType}, content-length ${contentLength}, ` +
		`received ${body.byteLength} bytes, first ${head.byteLength} bytes: ${JSON.stringify(new TextDecoder().decode(head))}`
	);
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
	const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

/**
 * Read the body chunk by chunk under the attempt's signal. The bytes received
 * before an abort are kept: they are the evidence that names a stall.
 */
async function readBody(response: Response, signal: AbortSignal): Promise<{ bytes: Uint8Array; error?: unknown }> {
	const chunks: Uint8Array[] = [];
	if (!response.body) {
		return { bytes: new Uint8Array() };
	}
	const reader = response.body.getReader();
	// A body the runtime did not wire to the signal (or one the runtime aborts a
	// tick late) needs the reader released by hand; cancel() resolves the pending
	// read as done, and signal.aborted then says what really happened.
	const release = () => void reader.cancel().catch(() => undefined);
	if (signal.aborted) {
		release();
	} else {
		signal.addEventListener("abort", release, { once: true });
	}
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			chunks.push(value);
		}
		return { bytes: concat(chunks) };
	} catch (error) {
		return { bytes: concat(chunks), error };
	} finally {
		signal.removeEventListener("abort", release);
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** One attempt; every failure is an UnreachableError whose reason names the phase and whose message is the evidence. */
export async function fetchOnce(options: Pick<CatalogFetchOptions, "fetch" | "timeoutMs">): Promise<unknown> {
	const signal = AbortSignal.timeout(options.timeoutMs);
	let response: Response;
	try {
		response = await options.fetch(OPENROUTER_MODELS_URL, { signal });
	} catch (error) {
		if (signal.aborted) {
			throw new UnreachableError(
				{ kind: "timeout", phase: "headers" },
				`timed out after ${options.timeoutMs} ms waiting for the response headers`
			);
		}
		throw new UnreachableError({ kind: "network" }, error instanceof Error ? error.message : String(error));
	}
	if (!response.ok) {
		throw new UnreachableError(
			{ kind: "http", status: response.status },
			`HTTP ${response.status} from ${OPENROUTER_MODELS_URL}`
		);
	}
	const body = await readBody(response, signal);
	if (signal.aborted) {
		throw new UnreachableError(
			{ kind: "timeout", phase: "body" },
			`timed out after ${options.timeoutMs} ms while reading the body (${describeResponse(response, body.bytes)})`
		);
	}
	if ("error" in body) {
		throw new UnreachableError(
			{ kind: "network" },
			`reading the body failed (${errorText(body.error)}; ${describeResponse(response, body.bytes)})`
		);
	}
	try {
		return JSON.parse(new TextDecoder().decode(body.bytes));
	} catch (error) {
		if (!(error instanceof SyntaxError)) {
			throw error;
		}
		throw new UnreachableError(
			{ kind: "unparseable" },
			`the response body is not JSON (${describeResponse(response, body.bytes)})`
		);
	}
}

/**
 * A non-UnreachableError escapes at once (nothing here is a schema judgement),
 * and so does an UnreachableError the shared rule calls settled: only a
 * retryable reason spends another attempt and a backoff sleep.
 */
export async function fetchLivePayload(options: CatalogFetchOptions): Promise<unknown> {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await fetchOnce(options);
		} catch (error) {
			if (
				!(error instanceof UnreachableError) ||
				!isRetryableOpenRouterFailure(error.reason) ||
				attempt >= FETCH_ATTEMPTS
			) {
				throw error;
			}
			const delay = retryDelayMs(attempt);
			options.onRetry(`Attempt ${attempt}/${FETCH_ATTEMPTS} failed (${error.message}); retrying in ${delay}ms`);
			await options.sleep(delay);
		}
	}
}
