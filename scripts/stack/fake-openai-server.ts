#!/usr/bin/env bun
// scripts/stack/fake-openai-server.ts
//
// OpenAI-compatible fake backend for the docker LiteLLM stack. The chat input
// is the control surface: a "%" command on the last non-empty line of the last
// user message selects the response (grammar in
// src/test/fakeStack/commands.ts); anything else gets the fixed reply pointing
// at %help. The model id routes nothing - one grammar serves every fake-
// upstream.
//
// Routes:
//   GET  /health                  liveness for the compose healthcheck
//   GET  /v1/models               the consolidated fake- upstream ids
//                                 (blocked deployments excluded)
//   POST /v1/chat/completions     command dispatch, else the fixed reply
//   POST /oauth/token             client-credentials grant for the fixed fake
//                                 credentials (src/test/fakeStack/oauth.ts)
//   *    /authed/...              bearer-guarded mirror: a live token strips
//                                 the prefix and dispatches normally, else 401
//   *    /nodiscovery/...         no-discovery mirror: the discovery GETs
//                                 (/v1/models, /v1/model/info) answer 404,
//                                 everything else dispatches normally
//                                 (src/test/fakeStack/noDiscovery.ts)
//   PUT  /_test/custom-scenario   registers {name, config} at runtime (<= 1 MiB)
//   GET  /_test/last-request      last parsed chat completion body
//   GET  /_test/oauth-stats       { issued, rejected, live }
//   POST /_test/oauth-revoke      revoke all live tokens
//   GET  /_test/nodiscovery-stats per-bearer counts of the blanked discovery GETs

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

const PORT = Number(process.env.PORT || FAKE_BACKEND_PORT);
const MAX_CUSTOM_SCENARIO_BYTES = 1024 * 1024;
/** The dev launcher sets this: every chat request and response body lands in the container log. */
const VERBOSE = process.env.FAKE_VERBOSE === "1";

const scenarios = new Map<string, Scenario>(Object.entries(BUILTIN_SCENARIOS));
let lastRequest: Record<string, unknown> | null = null;
const oauthState = createOAuthProviderState();
const noDiscoveryState = createNoDiscoveryState();

interface BoundedBody {
	body: string;
	overflow: boolean;
}

/**
 * Read a request body, giving up as soon as it exceeds maxBytes. The remainder
 * is drained rather than the socket destroyed, because fetch clients cannot
 * read an early response over a killed connection - the 413 would surface as a
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
 * One line per chat completion in the container log, carrying the exact line
 * the grammar dispatched on: the debugging surface for "I typed %help and got
 * the fallback", where a host that appends context after the typed text, or
 * indents it, shows up.
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
 * Verbose exchange logging for the dev launcher: the full inbound messages
 * array and the full outbound reply, one JSON line each so the ./logs/ tee
 * stays greppable. Streamed requests log the raw chunk list, non-streaming
 * ones the collapsed body they receive. Never enabled by the test
 * orchestrator - the fuzz suites would multiply megabytes into the log.
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

const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
	const rawUrl = req.url || "/";
	// Checked on the RAW request line, before URL parsing: new URL() folds
	// dot segments away, so "/authed/../v1/models" (or a percent-encoded
	// spelling) would otherwise dodge the /authed guard below. No served
	// route contains ".." or "%2e", so the blanket rejection is total.
	if (hasDotSegmentBypass(rawUrl)) {
		return sendJson(res, 404, { error: { message: "Not found" } });
	}
	const url = new URL(rawUrl, `http://${req.headers.host}`);

	if (req.method === "POST" && url.pathname === "/oauth/token") {
		const read = await readBodyBounded(req, MAX_CUSTOM_SCENARIO_BYTES);
		if (read.overflow) {
			req.resume();
			return sendJson(res, 413, { error: { message: "Token request body exceeds 1 MiB" } });
		}
		const outcome = grantToken(oauthState, parseTokenRequestBody(read.body, req.headers["content-type"]));
		return sendJson(res, outcome.status, outcome.body);
	}

	if (req.method === "GET" && url.pathname === "/_test/oauth-stats") {
		return sendJson(res, 200, oauthStats(oauthState));
	}

	if (req.method === "POST" && url.pathname === "/_test/oauth-revoke") {
		return sendJson(res, 200, { revoked: revokeAllTokens(oauthState) });
	}

	if (req.method === "GET" && url.pathname === "/_test/nodiscovery-stats") {
		return sendJson(res, 200, noDiscoveryStats(noDiscoveryState));
	}

	// The /authed prefix is the bearer-guarded mirror of every route below: a
	// live token strips the prefix and dispatches to the normal handlers, so the
	// OAuth suites drive real discovery and chat over a real socket without a
	// second port. Anything else gets the LiteLLM-shaped 401 the extension's
	// error mapping classifies as an auth failure.
	let pathname = url.pathname;
	if (pathname === "/authed" || pathname.startsWith("/authed/")) {
		if (req.method === "POST" && pathname === "/authed/v1/chat/completions") {
			// Every wire attempt counts, auth outcome included: the suite's
			// no-retry assertions read this as "how many times did the client
			// actually hit the guarded chat endpoint".
			oauthState.authedChatRequests += 1;
		}
		if (!isLiveBearer(oauthState, req.headers.authorization)) {
			return sendJson(res, 401, authErrorBody("Authentication Error: invalid or revoked bearer token"));
		}
		pathname = pathname.slice("/authed".length) || "/";
	}

	// The /nodiscovery prefix is the discovery-less mirror: a gateway that
	// serves chat but cannot list models. Its discovery GETs answer 404 while
	// every other route (chat completions above all) dispatches normally.
	const routed = stripNoDiscoveryPrefix(pathname);
	pathname = routed.pathname;
	if (routed.noDiscovery && req.method === "GET" && isDiscoveryRoute(pathname)) {
		recordDiscoveryAttempt(noDiscoveryState, pathname, req.headers.authorization);
		// The OpenAI SDK never retries a plain 404, which would make the
		// expectedFailures no-retry assertions vacuous; x-should-retry: true
		// overrides its policy, so only a zeroed retry budget yields one
		// attempt against the counters above.
		res.setHeader("x-should-retry", "true");
		return sendJson(res, 404, { error: { message: "Not found" } });
	}

	if (req.method === "GET" && pathname === "/health") {
		return sendJson(res, 200, { status: "ok" });
	}

	if (req.method === "GET" && pathname === "/v1/models") {
		// The consolidated fake- upstream ids only; blocked deployments are
		// excluded exactly as a real provider would not list a decommissioned
		// model. Scenarios are not models - they are %play targets.
		return sendJson(res, 200, {
			object: "list",
			data: FAKE_MODEL_UPSTREAM_IDS.map((id) => ({ id, object: "model", created: 0, owned_by: "fake-openai" })),
		});
	}

	if (req.method === "GET" && pathname === "/_test/last-request") {
		return sendJson(res, 200, lastRequest || {});
	}

	if (req.method === "PUT" && pathname === "/_test/custom-scenario") {
		const oversized = { error: { message: "Custom scenario body exceeds 1 MiB" } };
		// Fast path on the declared length; the bounded read below still guards
		// chunked or lying senders. resume() drains the unread remainder so the
		// client can complete its upload and read the 413.
		const declared = Number(req.headers["content-length"]);
		if (Number.isFinite(declared) && declared > MAX_CUSTOM_SCENARIO_BYTES) {
			req.resume();
			return sendJson(res, 413, oversized);
		}
		const read = await readBodyBounded(req, MAX_CUSTOM_SCENARIO_BYTES);
		if (read.overflow) {
			req.resume();
			return sendJson(res, 413, oversized);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(read.body);
		} catch {
			return sendJson(res, 400, { error: { message: "Body must be JSON: {name, config}" } });
		}
		const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
		const name = typeof record.name === "string" ? record.name : "";
		if (!name || !isScenario(record.config)) {
			return sendJson(res, 400, {
				error: { message: "Expected {name: string, config: {type: sse|sse-delayed|error|sse-abort|raw, ...}}" },
			});
		}
		scenarios.set(name, record.config);
		return sendJson(res, 200, { scenario: name });
	}

	if (req.method === "POST" && pathname === "/v1/chat/completions") {
		const raw = await readBody(req);
		let body: Record<string, unknown>;
		try {
			const parsed: unknown = raw ? JSON.parse(raw) : {};
			body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
		} catch {
			lastRequest = { _parseError: true, _raw: raw };
			return sendJson(res, 400, { error: { message: "Invalid JSON" } });
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
		return playResult(res, result, stream);
	}

	sendJson(res, 404, { error: { message: "Not found" } });
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
