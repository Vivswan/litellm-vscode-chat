import { describe, expect, test } from "bun:test";
import OpenAI from "openai";
import {
	fetchModels,
	mapModelInfoEntry,
	mergeModelDeployments,
	normalizeModelItem,
	parseModelInfoItem,
} from "../../../../provider/catalog/discovery";
import type { DiscoveryLog } from "../../../../provider/catalog/discoveryLog";
import { discoveredCapabilityBaseline, replaysReasoningContent } from "../../../../provider/catalog/modelCatalog";
import type { TransportFetch } from "../../../../provider/transport/nodeHttpFetch";
import type { BackoffSleep } from "../../../../provider/transport/retry";
import { retryBudgetMs } from "../../../../provider/transport/retry";
import { RequestError } from "../../../../provider/transport/transportErrors";
import { DISCOVERY_MAX_RETRIES } from "../../../../shared/config/settingSpec";

/** The server every discovery request in this file targets; nothing listens there, the fetches are fakes. */
const BASE_URL = "http://litellm.test";

/** Per attempt, far below any real setting: the clocks under test are the attempt's and the budget's, not the server's. */
const ATTEMPT_TIMEOUT_MS = 50;

/** A backoff that returns at once, so a retry costs no wall clock. */
const noBackoff: BackoffSleep = () => Promise.resolve();

/** The host's predicate is vscode.CancellationError, which this tree cannot load; this one never fires. */
const neverCancelled = (_error: unknown): _error is Error => false;

type Signal = AbortSignal | null | undefined;

/** What undici rejects or errors a body with once the request's signal aborts. */
const abortError = () => new DOMException("This operation was aborted", "AbortError");

/** Never answers; rejects the way undici does once the attempt's clock aborts the request. */
function hangBeforeHeaders(signal: Signal): Promise<Response> {
	return new Promise((_resolve, reject) => {
		signal?.addEventListener("abort", () => reject(abortError()), { once: true });
	});
}

/** Answers HTTP 200 at once with a body that never flows, which the SDK's own headers clock would never catch. */
function stallAfterHeaders(signal: Signal): Promise<Response> {
	const body = new ReadableStream({
		start(controller) {
			signal?.addEventListener("abort", () => controller.error(abortError()), { once: true });
		},
	});
	return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
}

/** The headers arrive with an error status and the body never flows; the SDK still raises the status, not the stall. */
function stallErrorBody(status: number): Hang {
	return (signal) => stallAfterHeaders(signal).then((answered) => new Response(answered.body, { status }));
}

type Hang = (signal: Signal) => Promise<Response>;
const HANG_PHASES: readonly [phase: string, hang: Hang][] = [
	["before the headers", hangBeforeHeaders],
	["after the headers", stallAfterHeaders],
];

interface Attempts {
	info: number;
	models: number;
}

/** Both discovery endpoints hang for their first `hangs` attempts and answer after; every other route is a 404. */
function fakeServer(hang: Hang, hangs: number): { transport: TransportFetch; attempts: Attempts } {
	const attempts: Attempts = { info: 0, models: 0 };
	const transport: TransportFetch = (url, init) => {
		const { pathname } = new URL(String(url));
		if (pathname === "/v1/model/info") {
			attempts.info += 1;
			return attempts.info <= hangs
				? hang(init?.signal)
				: Promise.resolve(Response.json({ data: [{ model_name: "answered", model_info: {} }] }));
		}
		if (pathname === "/v1/models") {
			attempts.models += 1;
			return attempts.models <= hangs
				? hang(init?.signal)
				: Promise.resolve(Response.json({ object: "list", data: [{ id: "fallback" }] }));
		}
		return Promise.resolve(new Response("", { status: 404 }));
	};
	return { transport, attempts };
}

function request(transport: TransportFetch) {
	return {
		// Not createServerClient: the bun preload registers happy-dom's window, which the SDK's constructor reads as a
		// browser and refuses. The per-request options getJson passes (maxRetries 0, the signal) are what is under test.
		client: new OpenAI({
			baseURL: `${BASE_URL}/v1`,
			apiKey: "test-key",
			dangerouslyAllowBrowser: true,
			fetch: (url, init) => transport(url instanceof Request ? url.url : url, init),
		}),
		baseUrl: BASE_URL,
		apiVersion: undefined,
		discoveryTimeout: ATTEMPT_TIMEOUT_MS,
		log: () => {},
		isCancellation: neverCancelled,
		sleep: noBackoff,
	};
}

describe("discovery GETs retry a timed-out attempt", () => {
	// Regression: the whole-call bound used to equal the per-attempt timeout, so one hung attempt spent the entire
	// budget and the retries only ever covered fast failures. The SDK's own timeout stops at the headers, so a body that
	// stalls after them is the second way an attempt hangs.
	test.each(HANG_PHASES)(
		"a first attempt that hangs %s past the per-attempt timeout is retried and the second attempt's answer serves",
		async (_phase, hang) => {
			const server = fakeServer(hang, 1);
			const result = await fetchModels(request(server.transport));
			expect(result.models.map((model) => model.id)).toEqual(["answered"]);
			expect(server.attempts).toEqual({ info: 2, models: 0 });
		}
	);

	test.each(HANG_PHASES)(
		"every attempt hanging %s ends the call inside the retry budget with the both-unserved timeout verdict",
		async (_phase, hang) => {
			const server = fakeServer(hang, Number.POSITIVE_INFINITY);
			const started = Date.now();
			const failure = await fetchModels(request(server.transport)).then(
				() => undefined,
				(error: unknown) => error
			);
			const elapsed = Date.now() - started;
			expect(failure).toBeInstanceOf(RequestError);
			const mapped = failure as RequestError;
			expect(mapped.kind).toBe("timeout");
			expect(mapped.logClassification).toBe("RequestError(timeout, discovery, no endpoint served)");
			expect(server.attempts).toEqual({ info: DISCOVERY_MAX_RETRIES + 1, models: DISCOVERY_MAX_RETRIES + 1 });
			// Two GETs, each with its own budget, every attempt run to its timeout and every backoff slept at zero.
			expect(elapsed).toBeLessThan(2 * retryBudgetMs(ATTEMPT_TIMEOUT_MS, DISCOVERY_MAX_RETRIES));
		}
	);
});

describe("a stalled error body keeps its status", () => {
	// Regression: an attempt-clock abort used to replace whatever the SDK threw with its timeout error, so a stalled
	// 401 body was retried three times and reported as a timeout; with retries off, the budget rendering did the same.
	// A status that reached the headers keeps its classification under either clock.
	// Declaring both failures expected turns retries off, so the budget clock and the attempt clock fire together.
	const retriesOff = { expected: { modelInfo: true, modelListing: true } };
	test.each([
		[401, "auth", "retries on", {}],
		[404, "http", "retries on", {}],
		[401, "auth", "retries off", retriesOff],
		[404, "http", "retries off", retriesOff],
	] as const)(
		"an HTTP %i whose body stalls past the attempt timeout ends after one attempt as %s (%s)",
		async (status, kind, _clocks, overrides) => {
			const server = fakeServer(stallErrorBody(status), Number.POSITIVE_INFINITY);
			const failure = await fetchModels({ ...request(server.transport), ...overrides }).then(
				() => undefined,
				(error: unknown) => error
			);
			expect(failure).toBeInstanceOf(RequestError);
			const mapped = failure as RequestError;
			expect(mapped.kind).toBe(kind);
			expect(mapped.status).toBe(status);
			expect(server.attempts).toEqual({ info: 1, models: 1 });
		}
	);
});

describe("the reasoning replay default a deployment's provider name sets", () => {
	/** Through the production parse-and-map path, never by hand. */
	function deployment(modelInfo: Record<string, unknown>) {
		const item = parseModelInfoItem({ model_name: "thinking", model_info: modelInfo });
		if (item === undefined) {
			throw new Error("the fixture did not parse");
		}
		return mapModelInfoEntry(item);
	}

	/** The server level the capability walk reads for this deployment set. */
	function serverValues(mapped: ReturnType<typeof deployment>) {
		const baseline = discoveredCapabilityBaseline({
			providers: [mapped.provider],
			limits: mapped.limits,
			modalities: undefined,
			toolCalling: true,
			reasoning: true,
		});
		return baseline.kind === "discovered" ? baseline.values : {};
	}

	test("LiteLLM spells the provider `deepseek`: that deployment's server level carries replay_reasoning_content true, any other leaves the field unset", () => {
		expect(serverValues(deployment({ litellm_provider: "deepseek" })).replay_reasoning_content).toBe(true);
		for (const modelInfo of [{}, { litellm_provider: "openai" }, { litellm_provider: "anthropic" }]) {
			expect(serverValues(deployment(modelInfo))).not.toHaveProperty("replay_reasoning_content");
		}
	});

	test("a model_name load-balanced over a deepseek and a non-deepseek deployment reports nothing, so the user's record decides", () => {
		const merged = mergeModelDeployments([
			deployment({ litellm_provider: "deepseek" }),
			deployment({ litellm_provider: "openai" }),
		]);
		expect(serverValues(merged)).not.toHaveProperty("replay_reasoning_content");
		const allDeepseek = mergeModelDeployments([
			deployment({ litellm_provider: "deepseek" }),
			deployment({ litellm_provider: "deepseek" }),
		]);
		expect(serverValues(allDeepseek).replay_reasoning_content).toBe(true);
	});

	test("the providers-array shape (/v1/models, and /v1/model/info entries carrying one) stamps each entry from its own provider name, so a DeepSeek route found that way replays too", () => {
		const noLog = (() => {}) as DiscoveryLog;
		const groupProviders = (names: readonly string[]) => {
			const item = normalizeModelItem({ id: "thinking", providers: names.map((provider) => ({ provider })) }, noLog);
			if (item.shape.kind !== "group") {
				throw new Error("the fixture did not produce a provider group");
			}
			return item.shape.providers;
		};
		const groupValues = (names: readonly string[]) => {
			const providers = groupProviders(names);
			const baseline = discoveredCapabilityBaseline({
				providers,
				limits: mapModelInfoEntry(expectParsed(parseModelInfoItem({ model_name: "thinking", model_info: {} }))).limits,
				modalities: undefined,
				toolCalling: true,
				reasoning: true,
			});
			return baseline.kind === "discovered" ? baseline.values : {};
		};

		expect(replaysReasoningContent(groupProviders(["deepseek"]))).toBe(true);
		expect(groupValues(["deepseek", "deepseek"]).replay_reasoning_content).toBe(true);
		// Mixed routes report false: the proxy may route to the deployment that rejects the field.
		expect(replaysReasoningContent(groupProviders(["deepseek", "openrouter"]))).toBe(false);
		expect(groupValues(["deepseek", "openrouter"]).replay_reasoning_content).toBe(false);
		expect(replaysReasoningContent(groupProviders(["openrouter", "anthropic"]))).toBe(false);
		expect(groupValues(["openrouter", "anthropic"])).not.toHaveProperty("replay_reasoning_content");
	});
});

function expectParsed<T>(value: T | undefined): T {
	if (value === undefined) {
		throw new Error("the fixture did not parse");
	}
	return value;
}
