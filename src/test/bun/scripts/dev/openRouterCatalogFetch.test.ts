import { describe, test } from "bun:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	FETCH_ATTEMPTS,
	FETCH_TIMEOUT_MS,
	failureExit,
	fetchLivePayload,
	fetchOnce,
	retryDelayMs,
	UnreachableError,
	unreachableVerdict,
	worstCaseWallTimeMs,
} from "../../../../../scripts/dev/openRouterCatalogFetch";
import { OPENROUTER_MODELS_URL, type OpenRouterFetchFailure } from "../../../../../src/shared/config/openRouterCatalog";
import { REPO_ROOT } from "../../../util/repoRoot";

/**
 * The fetch script's failure classification, asserted on the whole message
 * and on the shared reason behind it: a CI operator reads that one line and
 * nothing else, and the retry loop reads the reason and nothing else. The
 * stall case is the one that motivated the module - headers 200 from a CDN
 * edge, body never finishing - and it used to read "the response body is not
 * JSON" because the abort landed in a discarded catch.
 */

const encoder = new TextEncoder();
const HTML = "<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>challenge</body></html>";
const BUDGET_MS = 50;

type Fetch = (url: string, init: { readonly signal: AbortSignal }) => Promise<Response>;

/**
 * A 200 whose body sends `head` and then never closes. With a signal, the
 * stream errors on abort the way a real fetch body does; without one it is a
 * plain fake nothing releases, as a hand-built Response in a test is.
 */
function stalledResponse(head: string, signal?: AbortSignal): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(head));
			signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/html; charset=utf-8", "content-length": "5120" },
	});
}

function neverAnswers(_url: string, init: { readonly signal: AbortSignal }): Promise<Response> {
	return new Promise((_, reject) => {
		init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
	});
}

/** A 200 whose body delivers `head` on the first read and breaks on the second, well inside the budget. */
function brokenResponse(head: string): Response {
	let pulls = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			pulls += 1;
			if (pulls === 1) {
				controller.enqueue(encoder.encode(head));
			} else {
				controller.error(new TypeError("socket hang up"));
			}
		},
	});
	return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
}

const fetchCases: readonly {
	readonly name: string;
	readonly fetch: Fetch;
	readonly reason: OpenRouterFetchFailure;
	readonly message: string;
}[] = [
	{
		name: "a body that stalls past the budget is a timeout with the headers and the bytes seen so far",
		fetch: async (_url, init) => stalledResponse("<!DOCTYPE html", init.signal),
		reason: { kind: "timeout", phase: "body" },
		message:
			`timed out after ${BUDGET_MS} ms while reading the body (status 200, ` +
			`content-type text/html; charset=utf-8, content-length 5120, received 14 bytes, ` +
			`first 14 bytes: "<!DOCTYPE html")`,
	},
	{
		name: "a stalled body nothing else releases is the same timeout, released by the reader",
		fetch: async () => stalledResponse("<!DOCTYPE html"),
		reason: { kind: "timeout", phase: "body" },
		message:
			`timed out after ${BUDGET_MS} ms while reading the body (status 200, ` +
			`content-type text/html; charset=utf-8, content-length 5120, received 14 bytes, ` +
			`first 14 bytes: "<!DOCTYPE html")`,
	},
	{
		name: "headers that never arrive are a timeout in the headers phase",
		fetch: neverAnswers,
		reason: { kind: "timeout", phase: "headers" },
		message: `timed out after ${BUDGET_MS} ms waiting for the response headers`,
	},
	{
		name: "a 200 with an HTML body is not JSON, with the first bytes as evidence",
		fetch: async () => new Response(HTML, { status: 200, headers: { "content-type": "text/html" } }),
		reason: { kind: "unparseable" },
		message:
			`the response body is not JSON (status 200, content-type text/html, content-length absent, ` +
			`received ${HTML.length} bytes, first ${HTML.length} bytes: ${JSON.stringify(HTML)})`,
	},
	{
		name: "a body that breaks mid-stream inside the budget is a read failure with the runtime's error",
		fetch: async () => brokenResponse('{"data":'),
		reason: { kind: "network" },
		message:
			"reading the body failed (TypeError: socket hang up; status 200, content-type application/json, " +
			`content-length absent, received 8 bytes, first 8 bytes: ${JSON.stringify('{"data":')})`,
	},
	{
		name: "a 429 is the HTTP status, body unread",
		fetch: async () => new Response(HTML, { status: 429, headers: { "content-type": "text/html" } }),
		reason: { kind: "http", status: 429 },
		message: `HTTP 429 from ${OPENROUTER_MODELS_URL}`,
	},
	{
		name: "a connect failure keeps the runtime's own message",
		fetch: async () => {
			throw new Error("Unable to connect. Is the computer able to access the url?");
		},
		reason: { kind: "network" },
		message: "Unable to connect. Is the computer able to access the url?",
	},
];

describe("fetchOnce classification", () => {
	for (const { name, fetch, reason, message } of fetchCases) {
		test(name, async () => {
			await assert.rejects(fetchOnce({ fetch, timeoutMs: BUDGET_MS }), (error: unknown) => {
				assert.ok(error instanceof UnreachableError, `not a catalog, got ${String(error)}`);
				assert.deepStrictEqual(error.reason, reason);
				assert.strictEqual(error.message, message);
				return true;
			});
		});
	}

	test("a JSON body within the budget is the parsed payload", async () => {
		const payload = { data: [{ id: "openai/gpt-4o" }] };
		const fetch = async () => Response.json(payload);
		assert.deepStrictEqual(await fetchOnce({ fetch, timeoutMs: BUDGET_MS }), payload);
	});

	test("the stall is reported against the attempt's own clock, not a slow success", async () => {
		// Same stalled body, generous budget; the stream is closed by hand
		// before the budget runs out, so the read completes and only the parse
		// can fail: the timeout message must not appear.
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		const stream = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
				c.enqueue(encoder.encode("<!DOCTYPE html"));
			},
		});
		const response = new Response(stream, { status: 200, headers: { "content-type": "text/html" } });
		setTimeout(() => controller?.close(), 5);
		await assert.rejects(fetchOnce({ fetch: async () => response, timeoutMs: 10_000 }), (error: unknown) => {
			assert.ok(error instanceof UnreachableError);
			assert.ok(error.message.startsWith("the response body is not JSON ("), error.message);
			return true;
		});
	});
});

describe("fetchLivePayload retry cadence", () => {
	function harness(responses: readonly Fetch[]) {
		const slept: number[] = [];
		const lines: string[] = [];
		let call = 0;
		const options = {
			fetch: (url: string, init: { readonly signal: AbortSignal }) => {
				const next = responses[call];
				call += 1;
				if (!next) {
					throw new Error(`fetch called ${call} times for ${responses.length} scripted responses`);
				}
				return next(url, init);
			},
			timeoutMs: BUDGET_MS,
			sleep: async (ms: number) => {
				slept.push(ms);
			},
			onRetry: (line: string) => {
				lines.push(line);
			},
		};
		return { options, slept, lines, calls: () => call };
	}

	/**
	 * The shared rule as the script lives it (isRetryableOpenRouterFailure,
	 * mirrored by the runtime refresh's own table): a retryable failure spends
	 * the whole ladder - three attempts, 5 s then 15 s, the third escaping
	 * without a sleep - and a settled answer escapes after ONE attempt with the
	 * same evidence message, sleeping never. The harness scripts exactly
	 * `attempts` responses, so an extra attempt fails as an over-read.
	 */
	const status = (code: number) => async () =>
		new Response(HTML, { status: code, headers: { "content-type": "text/html" } });
	const cadenceCases: readonly {
		readonly name: string;
		readonly fetch: Fetch;
		readonly attempts: 1 | 3;
		readonly message: string;
	}[] = [
		{ name: "a 503", fetch: status(503), attempts: 3, message: `HTTP 503 from ${OPENROUTER_MODELS_URL}` },
		{ name: "a 429", fetch: status(429), attempts: 3, message: `HTTP 429 from ${OPENROUTER_MODELS_URL}` },
		{ name: "a 408", fetch: status(408), attempts: 3, message: `HTTP 408 from ${OPENROUTER_MODELS_URL}` },
		{ name: "a 409", fetch: status(409), attempts: 3, message: `HTTP 409 from ${OPENROUTER_MODELS_URL}` },
		{
			name: "a headers timeout",
			fetch: neverAnswers,
			attempts: 3,
			message: `timed out after ${BUDGET_MS} ms waiting for the response headers`,
		},
		{
			name: "a connect failure",
			fetch: async () => {
				throw new Error("Unable to connect. Is the computer able to access the url?");
			},
			attempts: 3,
			message: "Unable to connect. Is the computer able to access the url?",
		},
		{ name: "a 404", fetch: status(404), attempts: 1, message: `HTTP 404 from ${OPENROUTER_MODELS_URL}` },
		{
			name: "a non-JSON 200",
			fetch: status(200),
			attempts: 1,
			message:
				`the response body is not JSON (status 200, content-type text/html, content-length absent, ` +
				`received ${HTML.length} bytes, first ${HTML.length} bytes: ${JSON.stringify(HTML)})`,
		},
	];
	for (const { name, fetch, attempts, message } of cadenceCases) {
		const sleeps = attempts === 3 ? "5 s then 15 s" : "never";
		test(`${name} escapes after ${attempts} attempt(s) with the evidence, sleeping ${sleeps}`, async () => {
			const { options, slept, lines, calls } = harness(Array.from({ length: attempts }, () => fetch));
			await assert.rejects(fetchLivePayload(options), (error: unknown) => {
				assert.ok(error instanceof UnreachableError, `not a catalog, got ${String(error)}`);
				assert.strictEqual(error.message, message);
				return true;
			});
			assert.strictEqual(calls(), attempts);
			assert.deepStrictEqual(slept, attempts === 3 ? [5_000, 15_000] : []);
			assert.deepStrictEqual(
				lines,
				attempts === 3
					? [
							`Attempt 1/3 failed (${message}); retrying in 5000ms`,
							`Attempt 2/3 failed (${message}); retrying in 15000ms`,
						]
					: []
			);
		});
	}

	test("a stall followed by a success returns the payload after one 5 s pause", async () => {
		const payload = { data: [] };
		const { options, slept, lines } = harness([async () => stalledResponse(""), async () => Response.json(payload)]);
		assert.deepStrictEqual(await fetchLivePayload(options), payload);
		assert.deepStrictEqual(slept, [5_000]);
		assert.deepStrictEqual(lines, [
			`Attempt 1/3 failed (timed out after ${BUDGET_MS} ms while reading the body (status 200, ` +
				`content-type text/html; charset=utf-8, content-length 5120, received 0 bytes, first 0 bytes: "")); ` +
				"retrying in 5000ms",
		]);
	});

	test("the worst-case wall time fits the openrouter-catalog job's timeout with a minute to spare for setup", () => {
		const workflow = fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/checks.yml"), "utf8");
		const job = /\n {2}openrouter-catalog:\n(?<body>(?: {4}.*\n|\n)*)/.exec(workflow)?.groups?.body;
		assert.ok(job, "the openrouter-catalog job is declared in checks.yml");
		const minutes = /^ {4}timeout-minutes: (\d+)$/m.exec(job)?.[1];
		assert.ok(minutes, "the openrouter-catalog job declares timeout-minutes");
		const budgetMs = Number(minutes) * 60_000;
		assert.strictEqual(retryDelayMs(1), 5_000);
		assert.strictEqual(retryDelayMs(2), 15_000);
		assert.strictEqual(retryDelayMs(3), 45_000);
		assert.strictEqual(worstCaseWallTimeMs(), FETCH_ATTEMPTS * FETCH_TIMEOUT_MS + 5_000 + 15_000);
		assert.ok(
			worstCaseWallTimeMs() + 60_000 <= budgetMs,
			`${worstCaseWallTimeMs()} ms of fetching plus a minute of setup exceeds the job's ${budgetMs} ms`
		);
	});
});

/**
 * The operator-facing words for an UnreachableError, asserted as the whole
 * outcome per reason: main()'s fatal path prints exactly these two lines and
 * failureExit's ::warning:: reuses the headline, so this table is where the
 * fatal path's strings are pinned - main() itself is not unit-tested.
 */
describe("unreachableVerdict", () => {
	const transient = {
		headline: "OpenRouter unreachable (transient)",
		advice: "Not a schema problem - retry once the endpoint is reachable.",
	};
	const settled = {
		headline: "OpenRouter answered but the catalog was unusable (settled, not retried)",
		advice:
			"Not a schema problem - the endpoint answered but the catalog was unusable; " +
			"check the URL and the response before retrying.",
	};
	const cases: readonly { readonly reason: OpenRouterFetchFailure; readonly verdict: typeof transient }[] = [
		{ reason: { kind: "timeout", phase: "headers" }, verdict: transient },
		{ reason: { kind: "timeout", phase: "body" }, verdict: transient },
		{ reason: { kind: "network" }, verdict: transient },
		{ reason: { kind: "http", status: 429 }, verdict: transient },
		{ reason: { kind: "http", status: 503 }, verdict: transient },
		{ reason: { kind: "http", status: 404 }, verdict: settled },
		{ reason: { kind: "unparseable" }, verdict: settled },
	];
	for (const { reason, verdict } of cases) {
		test(`${JSON.stringify(reason)} reads as ${verdict === transient ? "transient" : "settled"}`, () => {
			assert.deepStrictEqual(unreachableVerdict(new UnreachableError(reason, "evidence")), verdict);
		});
	}
});

/**
 * The script's exit on a failure, asserted as the whole outcome: the lenient
 * mode downgrades every UnreachableError to one annotation line and a green
 * exit, with the headline read from the shared retry rule - transient for a
 * retryable reason, settled for one the loop did not retry - and nothing else:
 * schema drift is the signal the check exists for, so it stays red in every
 * mode.
 */
describe("failureExit", () => {
	class DriftError extends Error {}
	const unreachable = new UnreachableError({ kind: "http", status: 503 }, `HTTP 503 from ${OPENROUTER_MODELS_URL}`);
	const settled = new UnreachableError({ kind: "http", status: 404 }, `HTTP 404 from ${OPENROUTER_MODELS_URL}`);
	const drift = new DriftError("payload yields 3 usable models (floor 100)");
	const skipTail =
		"skipping the live catalog check on this push - pull request runs, ci.yml's weekly schedule, " +
		"and release builds still fail on it";
	const cases: readonly {
		readonly name: string;
		readonly error: unknown;
		readonly unreachableIsWarning: boolean;
		readonly exit: ReturnType<typeof failureExit>;
	}[] = [
		{
			name: "lenient: an unreachable OpenRouter is the one ::warning:: line carrying the evidence, exit 0",
			error: unreachable,
			unreachableIsWarning: true,
			exit: {
				exitCode: 0,
				warning: `::warning::OpenRouter unreachable (transient): HTTP 503 from ${OPENROUTER_MODELS_URL}; ${skipTail}`,
			},
		},
		{
			name: "lenient: a settled answer is the same one ::warning:: line and exit 0, headlined as settled, not transient",
			error: settled,
			unreachableIsWarning: true,
			exit: {
				exitCode: 0,
				warning:
					"::warning::OpenRouter answered but the catalog was unusable (settled, not retried): " +
					`HTTP 404 from ${OPENROUTER_MODELS_URL}; ${skipTail}`,
			},
		},
		{ name: "lenient: schema drift stays fatal", error: drift, unreachableIsWarning: true, exit: { exitCode: 1 } },
		{
			name: "lenient: an unclassified error stays fatal",
			error: new TypeError("x is not a function"),
			unreachableIsWarning: true,
			exit: { exitCode: 1 },
		},
		{
			name: "default: an unreachable OpenRouter is fatal",
			error: unreachable,
			unreachableIsWarning: false,
			exit: { exitCode: 1 },
		},
		{ name: "default: a settled answer is fatal", error: settled, unreachableIsWarning: false, exit: { exitCode: 1 } },
		{ name: "default: schema drift is fatal", error: drift, unreachableIsWarning: false, exit: { exitCode: 1 } },
	];
	for (const { name, error, unreachableIsWarning, exit } of cases) {
		test(name, () => {
			assert.deepStrictEqual(failureExit(error, { unreachableIsWarning }), exit);
		});
	}
});
