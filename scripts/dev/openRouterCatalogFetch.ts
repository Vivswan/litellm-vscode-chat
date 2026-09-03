// scripts/dev/openRouterCatalogFetch.ts
//
// The network half of fetch-openrouter-catalog.ts: one bounded GET of the
// OpenRouter models endpoint, retried on transient failure, with every failure
// class named as what it is. The classification is the whole point - CI
// operators triage from the message alone, and a body that stalls at a CDN
// edge (headers 200, bytes never finishing) used to surface as "the response
// body is not JSON" because the abort landed inside a discarded catch.
//
// Failure classes, all transient (UnreachableError): the connect/headers phase
// timing out or failing, a non-2xx status, the body read timing out, and a
// completed body that is not JSON (an interstitial, not a schema statement).
// Schema drift is the caller's judgement over the parsed payload, never made
// here.

import { OPENROUTER_MODELS_URL } from "../../src/shared/config/openRouterCatalog";

/**
 * Per-attempt budget covering the connect, the headers, and the whole body
 * read; one signal carries it through every phase so a stall anywhere trips
 * the same clock.
 */
export const FETCH_TIMEOUT_MS = 20_000;

/** Transient failures retry (idempotent GET; CI runners hit rate limits), schema drift never does. */
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

export class UnreachableError extends Error {}

/**
 * How the fetch script exits on a failure. Anything that is not an
 * UnreachableError - schema drift above all - is fatal in every mode. An
 * UnreachableError is fatal by default; under `unreachableIsWarning` it is one
 * GitHub `::warning::` line carrying the evidence and exit 0. Push-to-main
 * builds opt in, so a third-party outage does not block landing; pull request
 * runs, ci.yml's weekly schedule, manual dispatch, and the release build's own
 * fetch stay fatal, so an outage is still caught loudly where a re-run is cheap.
 */
export type FailureExit = { readonly exitCode: 0; readonly warning: string } | { readonly exitCode: 1 };

export function failureExit(error: unknown, options: { readonly unreachableIsWarning: boolean }): FailureExit {
	if (options.unreachableIsWarning && error instanceof UnreachableError) {
		return {
			exitCode: 0,
			warning:
				`::warning::OpenRouter unreachable (transient): ${error.message}; ` +
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

/** One attempt; every failure is an UnreachableError whose message names the phase and the evidence. */
export async function fetchOnce(options: Pick<CatalogFetchOptions, "fetch" | "timeoutMs">): Promise<unknown> {
	const signal = AbortSignal.timeout(options.timeoutMs);
	let response: Response;
	try {
		response = await options.fetch(OPENROUTER_MODELS_URL, { signal });
	} catch (error) {
		if (signal.aborted) {
			throw new UnreachableError(`timed out after ${options.timeoutMs} ms waiting for the response headers`);
		}
		throw new UnreachableError(error instanceof Error ? error.message : String(error));
	}
	if (!response.ok) {
		throw new UnreachableError(`HTTP ${response.status} from ${OPENROUTER_MODELS_URL}`);
	}
	const body = await readBody(response, signal);
	if (signal.aborted) {
		throw new UnreachableError(
			`timed out after ${options.timeoutMs} ms while reading the body (${describeResponse(response, body.bytes)})`
		);
	}
	if ("error" in body) {
		throw new UnreachableError(
			`reading the body failed (${errorText(body.error)}; ${describeResponse(response, body.bytes)})`
		);
	}
	try {
		return JSON.parse(new TextDecoder().decode(body.bytes));
	} catch (error) {
		if (!(error instanceof SyntaxError)) {
			throw error;
		}
		throw new UnreachableError(`the response body is not JSON (${describeResponse(response, body.bytes)})`);
	}
}

/** A non-UnreachableError escapes at once; nothing here is a schema judgement. */
export async function fetchLivePayload(options: CatalogFetchOptions): Promise<unknown> {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await fetchOnce(options);
		} catch (error) {
			if (!(error instanceof UnreachableError) || attempt >= FETCH_ATTEMPTS) {
				throw error;
			}
			const delay = retryDelayMs(attempt);
			options.onRetry(`Attempt ${attempt}/${FETCH_ATTEMPTS} failed (${error.message}); retrying in ${delay}ms`);
			await options.sleep(delay);
		}
	}
}
