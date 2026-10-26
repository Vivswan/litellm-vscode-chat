#!/usr/bin/env bun
// The OpenAI-compatible fake backend for the docker LiteLLM stack; the model id routes nothing, so one grammar serves
// every fake upstream.

import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import { URL } from "node:url";
import type { CommandContext, CommandResult } from "../../src/test/fakeStack/commands";
import { dispatchCommand, dispatchLine, fallbackReply } from "../../src/test/fakeStack/commands";
import { FAKE_MODEL_UPSTREAM_IDS } from "../../src/test/fakeStack/models";
import {
	createNoDiscoveryState,
	isDiscoveryRoute,
	noDiscoveryStats,
	recordDiscoveryAttempt,
	stripNoDiscoveryPrefix,
} from "../../src/test/fakeStack/noDiscovery";
import {
	authErrorBody,
	createOAuthProviderState,
	grantToken,
	hasDotSegmentBypass,
	isLiveBearer,
	oauthStats,
	parseTokenRequestBody,
	revokeAllTokens,
} from "../../src/test/fakeStack/oauth";
import { FAKE_BACKEND_PORT } from "../../src/test/fakeStack/proxyConfig";
import type { Scenario } from "../../src/test/scenarios";
import {
	BUILTIN_SCENARIOS,
	collapseChunks,
	isScenario,
	playScenario,
	readBody,
	sendJson,
} from "../../src/test/scenarios";

/** PORT from the container environment, else the fake backend's conventional port. */
const PORT = Number(process.env.PORT || FAKE_BACKEND_PORT);

/** Cap on a posted custom scenario; past it the body is drained and the request answered 413. */
const MAX_CUSTOM_SCENARIO_BYTES = 1024 * 1024;

/** The dev launcher sets this: every chat request and response body lands in the container log. */
const VERBOSE = process.env.FAKE_VERBOSE === "1";

/** The built-in scenarios plus any posted custom ones, by name. */
const scenarios = new Map<string, Scenario>(Object.entries(BUILTIN_SCENARIOS));

let lastRequest: Record<string, unknown> | null = null;
/** Its own slot: a reader of either route must never wonder which arm wrote what it sees. */
let lastCompletionRequest: Record<string, unknown> | null = null;
const oauthState = createOAuthProviderState();
const noDiscoveryState = createNoDiscoveryState();

interface BoundedBody {
	body: string;
	overflow: boolean;
}

/**
 * Read a request body, giving up as soon as it exceeds maxBytes. The remainder is drained rather than the socket
 * destroyed, because fetch clients cannot read an early response over a killed connection - the 413 would surface as a
 * network error instead of a status.
 */
function readBodyBounded(req: IncomingMessage, maxBytes: number): Promise<BoundedBody> {
	return new Promise((resolve, reject) => {
		req.setEncoding("utf8");
		let data = "";
		let bytes = 0;
		let overflowed = false;
		req.on("data", (chunk: string) => {
			if (overflowed) {
				return;
			}
			bytes += Buffer.byteLength(chunk, "utf8");
			if (bytes > maxBytes) {
				overflowed = true;
				data = "";
				resolve({ body: "", overflow: true });
				return;
			}
			data += chunk;
		});
		req.on("end", () => {
			if (!overflowed) {
				resolve({ body: data, overflow: false });
			}
		});
		req.on("error", reject);
	});
}

function playResult(res: ServerResponse, result: CommandResult, stream: boolean): void {
	if (result.firstByteDelayMs === undefined) {
		playScenario(res, result.scenario, stream);
		return;
	}
	// codeql[js/resource-exhaustion] -- fake-backend timer; the delay is capped by the command grammar
	setTimeout(() => {
		if (!res.destroyed) {
			playScenario(res, result.scenario, stream);
		}
	}, result.firstByteDelayMs);
}

/**
 * One line per chat completion in the container log, carrying the exact line the grammar dispatched on: the debugging
 * surface for "I typed %help and got the fallback", where a host that appends context after the typed text, or indents
 * it, shows up.
 */
function logChatRequest(context: CommandContext, stream: boolean, dispatched: boolean): void {
	const rawModel = context.request.model;
	const model = JSON.stringify(typeof rawModel === "string" ? rawModel.slice(0, 60) : "?");
	const line = dispatchLine(context);
	const shown =
		line === undefined ? "(no user text)" : JSON.stringify(line.length > 200 ? `${line.slice(0, 200)}...` : line);
	console.log(`chat model=${model} stream=${stream} ${dispatched ? "command" : "fallback"} line=${shown}`);
}

/**
 * Verbose exchange logging for the dev launcher: the full inbound messages array and the full outbound reply, one JSON
 * line each so the ./logs/ tee stays greppable. Never enabled by the test orchestrator - the fuzz suites would multiply
 * megabytes into the log.
 */
function logChatExchange(context: CommandContext, result: CommandResult, stream: boolean): void {
	console.log(`chat-request ${JSON.stringify(context.request.messages ?? [])}`);
	if (result.scenario.type === "error") {
		console.log(`chat-response ${JSON.stringify({ status: result.scenario.statusCode, body: result.scenario.body })}`);
		return;
	}
	if (result.scenario.type === "raw") {
		// Raw scenarios ARE their bytes; the whole definition is the honest log.
		console.log(`chat-response ${JSON.stringify(result.scenario)}`);
		return;
	}
	const sent = stream ? result.scenario.chunks : collapseChunks(result.scenario.chunks);
	console.log(`chat-response ${JSON.stringify(sent)}`);
}

/**
 * The text-completions (FIM) reply: a pure echo of the context nearest the cursor, so identical requests always get
 * identical bytes and every assertion can derive the expected text from the request alone.
 *
 *   the chat command grammar routes nothing here -> Deliberately grammar-free
 */
function fimCompletionText(prompt: string, suffix: string): string {
	const head = prompt.slice(-24);
	return suffix === "" ? `fim(${head})` : `fim(${head}|${suffix.slice(0, 12)})`;
}

/**
 * A request body as JSON, or undefined for invalid JSON. An empty body, or a document that is a number, string,
 * boolean, or null, reads as {}; an array passes through under the record type, as the chat and FIM handlers read it.
 */
function parseRequestBody(raw: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = raw ? JSON.parse(raw) : {};
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
	} catch {
		return undefined;
	}
}

/** The OAuth token grant: a bounded body, then the provider state's verdict. */
async function handleOAuthToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const read = await readBodyBounded(req, MAX_CUSTOM_SCENARIO_BYTES);
	if (read.overflow) {
		req.resume();
		sendJson(res, 413, { error: { message: "Token request body exceeds 1 MiB" } });
		return;
	}
	const outcome = grantToken(oauthState, parseTokenRequestBody(read.body, req.headers["content-type"]));
	sendJson(res, outcome.status, outcome.body);
}

/** The routes outside the /authed and /nodiscovery mirrors: the OAuth grant and the test counters. True once sent. */
async function handleProviderRoutes(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
	if (req.method === "POST" && url.pathname === "/oauth/token") {
		await handleOAuthToken(req, res);
		return true;
	}
	if (req.method === "GET" && url.pathname === "/_test/oauth-stats") {
		sendJson(res, 200, oauthStats(oauthState));
		return true;
	}
	if (req.method === "POST" && url.pathname === "/_test/oauth-revoke") {
		sendJson(res, 200, { revoked: revokeAllTokens(oauthState) });
		return true;
	}
	if (req.method === "GET" && url.pathname === "/_test/nodiscovery-stats") {
		sendJson(res, 200, noDiscoveryStats(noDiscoveryState));
		return true;
	}
	return false;
}

/**
 * The /authed prefix is the bearer-guarded mirror of every route below: a live token strips the prefix and dispatches
 * to the normal handlers, so the OAuth suites drive real discovery and chat over a real socket without a second port.
 * Anything else gets the LiteLLM-shaped 401 the extension's error mapping classifies as an auth failure. The path with
 * the prefix stripped, or undefined once the 401 went out.
 */
function authedPathname(req: IncomingMessage, res: ServerResponse, pathname: string): string | undefined {
	if (!(pathname === "/authed" || pathname.startsWith("/authed/"))) {
		return pathname;
	}
	if (req.method === "POST" && pathname === "/authed/v1/chat/completions") {
		// Every wire attempt counts, auth outcome included: the suite's no-retry assertions read this as "how many
		// times did the client actually hit the guarded chat endpoint".
		oauthState.authedChatRequests += 1;
	}
	if (!isLiveBearer(oauthState, req.headers.authorization)) {
		sendJson(res, 401, authErrorBody("Authentication Error: invalid or revoked bearer token"));
		return undefined;
	}
	return pathname.slice("/authed".length) || "/";
}

/**
 * The /nodiscovery prefix is the discovery-less mirror: a gateway that serves chat but cannot list models. The routed
 * path, or undefined once a discovery route was refused. The OpenAI SDK never retries a plain 404, which would make the
 * expectedFailures no-retry assertions vacuous; x-should-retry: true overrides its policy, so only a zeroed retry
 * budget yields one attempt against the counters.
 */
function noDiscoveryPathname(req: IncomingMessage, res: ServerResponse, pathname: string): string | undefined {
	const routed = stripNoDiscoveryPrefix(pathname);
	if (routed.noDiscovery && req.method === "GET" && isDiscoveryRoute(routed.pathname)) {
		recordDiscoveryAttempt(noDiscoveryState, routed.pathname, req.headers.authorization);
		res.setHeader("x-should-retry", "true");
		sendJson(res, 404, { error: { message: "Not found" } });
		return undefined;
	}
	return routed.pathname;
}

/**
 * The custom-scenario upload. A fast 413 on the declared length; the bounded read still guards chunked or lying
 * senders, and resume() drains the unread remainder so the client can complete its upload and read the 413.
 */
async function handleCustomScenario(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const oversized = { error: { message: "Custom scenario body exceeds 1 MiB" } };
	const declared = Number(req.headers["content-length"]);
	if (Number.isFinite(declared) && declared > MAX_CUSTOM_SCENARIO_BYTES) {
		req.resume();
		sendJson(res, 413, oversized);
		return;
	}
	const read = await readBodyBounded(req, MAX_CUSTOM_SCENARIO_BYTES);
	if (read.overflow) {
		req.resume();
		sendJson(res, 413, oversized);
		return;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(read.body);
	} catch {
		sendJson(res, 400, { error: { message: "Body must be JSON: {name, config}" } });
		return;
	}
	const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
	const name = typeof record.name === "string" ? record.name : "";
	if (!name || !isScenario(record.config)) {
		sendJson(res, 400, {
			error: { message: "Expected {name: string, config: {type: sse|sse-delayed|error|sse-abort|raw, ...}}" },
		});
		return;
	}
	scenarios.set(name, record.config);
	sendJson(res, 200, { scenario: name });
}

/**
 * The text-completions (FIM) route. Always a plain JSON body: the extension's FIM requests are non-streaming by
 * contract, so a stream flag is ignored rather than answered with a second SSE grammar.
 */
async function handleCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const body = parseRequestBody(await readBody(req));
	if (body === undefined) {
		sendJson(res, 400, { error: { message: "Invalid JSON" } });
		return;
	}
	// The completions-side observation point: the docker suites' only proof of what actually reached the wire (no
	// injected params, no underscore directives, stream: false).
	lastCompletionRequest = body;
	const prompt = typeof body.prompt === "string" ? body.prompt : "";
	const suffix = typeof body.suffix === "string" ? body.suffix : "";
	const text = fimCompletionText(prompt, suffix);
	const promptTokens = Math.max(1, Math.ceil((prompt.length + suffix.length) / 4));
	const completionTokens = Math.max(1, Math.ceil(text.length / 4));
	sendJson(res, 200, {
		id: "cmpl-fake",
		object: "text_completion",
		created: 0,
		model: typeof body.model === "string" ? body.model : "fake-fim",
		choices: [{ index: 0, text, logprobs: null, finish_reason: "stop" }],
		usage: {
			prompt_tokens: promptTokens,
			completion_tokens: completionTokens,
			total_tokens: promptTokens + completionTokens,
		},
	});
}

/**
 * The chat route: the request recorded (a parse failure under its own marker), the command grammar dispatched, the
 * result played.
 */
async function handleChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const raw = await readBody(req);
	const body = parseRequestBody(raw);
	if (body === undefined) {
		lastRequest = { _parseError: true, _raw: raw };
		sendJson(res, 400, { error: { message: "Invalid JSON" } });
		return;
	}
	lastRequest = body;

	const context = { request: body, scenarios };
	const stream = body.stream === true;

	const command = dispatchCommand(context);
	logChatRequest(context, stream, command !== undefined);
	const result = command ?? fallbackReply(context);
	if (VERBOSE) {
		logChatExchange(context, result, stream);
	}
	playResult(res, result, stream);
}

/** The read-only routes behind the mirrors; a miss is a 404. */
function handleRead(res: ServerResponse, pathname: string): void {
	if (pathname === "/health") {
		sendJson(res, 200, { status: "ok" });
		return;
	}
	if (pathname === "/v1/models") {
		// The consolidated fake- upstream ids only; blocked deployments are excluded exactly as a real provider would
		// not list a decommissioned model. Scenarios are not models - they are %play targets.
		sendJson(res, 200, {
			object: "list",
			data: FAKE_MODEL_UPSTREAM_IDS.map((id) => ({ id, object: "model", created: 0, owned_by: "fake-openai" })),
		});
		return;
	}
	if (pathname === "/_test/last-request") {
		sendJson(res, 200, lastRequest || {});
		return;
	}
	if (pathname === "/_test/last-completion-request") {
		sendJson(res, 200, lastCompletionRequest || {});
		return;
	}
	sendJson(res, 404, { error: { message: "Not found" } });
}

/** The routes behind the mirrors, by method and path; a miss is a 404. */
async function dispatch(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
	if (req.method === "GET") {
		handleRead(res, pathname);
		return;
	}
	if (req.method === "PUT" && pathname === "/_test/custom-scenario") {
		await handleCustomScenario(req, res);
		return;
	}
	if (req.method === "POST" && pathname === "/v1/completions") {
		await handleCompletions(req, res);
		return;
	}
	if (req.method === "POST" && pathname === "/v1/chat/completions") {
		await handleChatCompletions(req, res);
		return;
	}
	sendJson(res, 404, { error: { message: "Not found" } });
}

const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
	const rawUrl = req.url || "/";
	// Checked on the RAW request line, before URL parsing: new URL() folds dot segments away, so "/authed/../v1/models"
	// (or a percent-encoded spelling) would otherwise dodge the /authed guard below. No served route contains ".." or
	// "%2e", so the blanket rejection is total.
	if (hasDotSegmentBypass(rawUrl)) {
		sendJson(res, 404, { error: { message: "Not found" } });
		return;
	}
	const url = new URL(rawUrl, `http://${req.headers.host}`);
	if (await handleProviderRoutes(req, res, url)) {
		return;
	}
	const authed = authedPathname(req, res, url.pathname);
	if (authed === undefined) {
		return;
	}
	const pathname = noDiscoveryPathname(req, res, authed);
	if (pathname === undefined) {
		return;
	}
	await dispatch(req, res, pathname);
};

const server = http.createServer((req, res) => {
	handleRequest(req, res).catch(() => {
		// A failed handler must not hang the connection open.
		res.destroy();
	});
});

server.listen(PORT, "0.0.0.0", () => {
	console.log(`fake-openai-server listening on 0.0.0.0:${PORT} (${scenarios.size} scenarios)`);
});
