import { describe, test } from "bun:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	FETCH_ATTEMPTS,
	FETCH_TIMEOUT_MS,
	fetchLivePayload,
	fetchOnce,
	retryDelayMs,
	UnreachableError,
	worstCaseWallTimeMs,
} from "../../../../../scripts/dev/openRouterCatalogFetch";
import { OPENROUTER_MODELS_URL } from "../../../../../src/shared/config/openRouterCatalog";
import { REPO_ROOT } from "../../../util/repoRoot";

/**
 * The fetch script's failure classification, asserted on the whole message:
 * a CI operator reads that one line and nothing else. The stall case is the
 * one that motivated the module - headers 200 from a CDN edge, body never
 * finishing - and it used to read "the response body is not JSON" because the
 * abort landed in a discarded catch.
 */

const encoder = new TextEncoder();
const HTML = "<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>challenge</body></html>";
const BUDGET_MS = 50;

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
	readonly fetch: (url: string, init: { readonly signal: AbortSignal }) => Promise<Response>;
	readonly message: string;
}[] = [
	{
		name: "a body that stalls past the budget is a timeout with the headers and the bytes seen so far",
		fetch: async (_url, init) => stalledResponse("<!DOCTYPE html", init.signal),
		message:
			`timed out after ${BUDGET_MS} ms while reading the body (status 200, ` +
			`content-type text/html; charset=utf-8, content-length 5120, received 14 bytes, ` +
			`first 14 bytes: "<!DOCTYPE html")`,
	},
	{
		name: "a stalled body nothing else releases is the same timeout, released by the reader",
		fetch: async () => stalledResponse("<!DOCTYPE html"),
		message:
			`timed out after ${BUDGET_MS} ms while reading the body (status 200, ` +
			`content-type text/html; charset=utf-8, content-length 5120, received 14 bytes, ` +
			`first 14 bytes: "<!DOCTYPE html")`,
	},
	{
		name: "headers that never arrive are a timeout in the headers phase",
		fetch: neverAnswers,
		message: `timed out after ${BUDGET_MS} ms waiting for the response headers`,
	},
	{
		name: "a 200 with an HTML body is not JSON, with the first bytes as evidence",
		fetch: async () => new Response(HTML, { status: 200, headers: { "content-type": "text/html" } }),
		message:
			`the response body is not JSON (status 200, content-type text/html, content-length absent, ` +
			`received ${HTML.length} bytes, first ${HTML.length} bytes: ${JSON.stringify(HTML)})`,
	},
	{
		name: "a body that breaks mid-stream inside the budget is a read failure with the runtime's error",
		fetch: async () => brokenResponse('{"data":'),
		message:
			"reading the body failed (TypeError: socket hang up; status 200, content-type application/json, " +
			`content-length absent, received 8 bytes, first 8 bytes: ${JSON.stringify('{"data":')})`,
	},
	{
		name: "a 429 is the HTTP status, body unread",
		fetch: async () => new Response(HTML, { status: 429, headers: { "content-type": "text/html" } }),
		message: `HTTP 429 from ${OPENROUTER_MODELS_URL}`,
	},
	{
		name: "a connect failure keeps the runtime's own message",
		fetch: async () => {
			throw new Error("Unable to connect. Is the computer able to access the url?");
		},
		message: "Unable to connect. Is the computer able to access the url?",
	},
];

describe("fetchOnce classification", () => {
	for (const { name, fetch, message } of fetchCases) {
		test(name, async () => {
			await assert.rejects(fetchOnce({ fetch, timeoutMs: BUDGET_MS }), (error: unknown) => {
				assert.ok(error instanceof UnreachableError, `transient, got ${String(error)}`);
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
	function harness(responses: readonly (() => Promise<Response>)[]) {
		const slept: number[] = [];
		const lines: string[] = [];
		let call = 0;
		const options = {
			fetch: () => {
				const next = responses[call];
				call += 1;
				if (!next) {
					throw new Error(`fetch called ${call} times for ${responses.length} scripted responses`);
				}
				return next();
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

	test("the delays grow 5 s, 15 s and the third failure escapes without a sleep", async () => {
		const limited = async () => new Response("", { status: 429 });
		const { options, slept, lines, calls } = harness([limited, limited, limited]);
		await assert.rejects(fetchLivePayload(options), (error: unknown) => {
			assert.ok(error instanceof UnreachableError);
			assert.strictEqual(error.message, `HTTP 429 from ${OPENROUTER_MODELS_URL}`);
			return true;
		});
		assert.strictEqual(calls(), FETCH_ATTEMPTS);
		assert.deepStrictEqual(slept, [5_000, 15_000]);
		assert.deepStrictEqual(lines, [
			`Attempt 1/3 failed (HTTP 429 from ${OPENROUTER_MODELS_URL}); retrying in 5000ms`,
			`Attempt 2/3 failed (HTTP 429 from ${OPENROUTER_MODELS_URL}); retrying in 15000ms`,
		]);
	});

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
