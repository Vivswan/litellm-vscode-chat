#!/usr/bin/env bun
// scripts/fake-openai-server.ts
//
// OpenAI-compatible fake backend for the docker LiteLLM stack. The chat
// input is the control surface: a "%" command on the last non-empty line
// of the last user message selects the response (see
// src/test/fakeStack/commands.ts for the grammar and for why the sigil is
// "%" rather than "/" or "!"); anything else gets the fixed reply
// pointing at %help. The model id routes nothing - one grammar serves every
// fake- upstream.
//
// Routes:
//   GET  /health                  liveness for the compose healthcheck
//   GET  /v1/models               the consolidated fake- upstream ids
//                                 (blocked deployments excluded)
//   POST /v1/chat/completions     command dispatch, else the fixed reply
//   PUT  /_test/custom-scenario   registers {name, config} at runtime (<= 1 MiB)
//   GET  /_test/last-request      last parsed chat completion body

import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import { URL } from "node:url";
import type { CommandContext, CommandResult } from "../src/test/fakeStack/commands";
import { dispatchCommand, dispatchLine, fallbackReply } from "../src/test/fakeStack/commands";
import { FAKE_MODEL_UPSTREAM_IDS } from "../src/test/fakeStack/models";
import { FAKE_BACKEND_PORT } from "../src/test/fakeStack/proxyConfig";
import type { Scenario } from "../src/test/scenarios";
import { BUILTIN_SCENARIOS, collapseChunks, readBody, sendJson, sendSse, sendSseDelayed } from "../src/test/scenarios";

const PORT = Number(process.env.PORT || FAKE_BACKEND_PORT);
const MAX_CUSTOM_SCENARIO_BYTES = 1024 * 1024;

const scenarios = new Map<string, Scenario>(Object.entries(BUILTIN_SCENARIOS));
let lastRequest: Record<string, unknown> | null = null;

function isScenario(value: unknown): value is Scenario {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as Record<string, unknown>;
	if (record.type === "sse") {
		return Array.isArray(record.chunks);
	}
	if (record.type === "sse-delayed") {
		return Array.isArray(record.chunks) && typeof record.delayMs === "number";
	}
	if (record.type === "error") {
		return typeof record.statusCode === "number";
	}
	return false;
}

function playScenario(res: ServerResponse, scenario: Scenario, stream: boolean): void {
	if (scenario.type === "error") {
		sendJson(res, scenario.statusCode, scenario.body ?? {});
	} else if (!stream) {
		sendJson(res, 200, collapseChunks(scenario.chunks));
	} else if (scenario.type === "sse-delayed") {
		sendSseDelayed(res, scenario.chunks, scenario.delayMs);
	} else {
		sendSse(res, scenario.chunks);
	}
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
 * the grammar dispatched on. This is the debugging surface for "I typed
 * %help and got the fallback": a chat host that appends context after the
 * typed text, or indents it, shows up right here.
 */
function logChatRequest(context: CommandContext, stream: boolean, dispatched: boolean): void {
	const rawModel = context.request.model;
	const model = JSON.stringify(typeof rawModel === "string" ? rawModel.slice(0, 60) : "?");
	const line = dispatchLine(context);
	const shown =
		line === undefined ? "(no user text)" : JSON.stringify(line.length > 200 ? `${line.slice(0, 200)}...` : line);
	console.log(`chat model=${model} stream=${stream} ${dispatched ? "command" : "fallback"} line=${shown}`);
}

const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
	const url = new URL(req.url || "/", `http://${req.headers.host}`);

	if (req.method === "GET" && url.pathname === "/health") {
		return sendJson(res, 200, { status: "ok" });
	}

	if (req.method === "GET" && url.pathname === "/v1/models") {
		// The consolidated fake- upstream ids only; blocked deployments are
		// excluded exactly as a real provider would not list a decommissioned
		// model. Scenarios are not models - they are %play targets.
		return sendJson(res, 200, {
			object: "list",
			data: FAKE_MODEL_UPSTREAM_IDS.map((id) => ({ id, object: "model", created: 0, owned_by: "fake-openai" })),
		});
	}

	if (req.method === "GET" && url.pathname === "/_test/last-request") {
		return sendJson(res, 200, lastRequest || {});
	}

	if (req.method === "PUT" && url.pathname === "/_test/custom-scenario") {
		const raw = await readBody(req);
		if (Buffer.byteLength(raw, "utf8") > MAX_CUSTOM_SCENARIO_BYTES) {
			return sendJson(res, 413, { error: { message: "Custom scenario body exceeds 1 MiB" } });
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return sendJson(res, 400, { error: { message: "Body must be JSON: {name, config}" } });
		}
		const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
		const name = typeof record.name === "string" ? record.name : "";
		if (!name || !isScenario(record.config)) {
			return sendJson(res, 400, {
				error: { message: "Expected {name: string, config: {type: sse|sse-delayed|error, ...}}" },
			});
		}
		scenarios.set(name, record.config);
		return sendJson(res, 200, { scenario: name });
	}

	if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
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
		if (command !== undefined) {
			return playResult(res, command, stream);
		}
		return playResult(res, fallbackReply(context), stream);
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
