#!/usr/bin/env bun
// scripts/fake-openai-server.ts
//
// OpenAI-compatible fake backend for the docker LiteLLM stack. The LiteLLM
// proxy routes each fake/<scenario> model here with the bare scenario name in
// the request body, so the scenario doubles as the model ID. Scenario
// definitions are shared with the in-process capture server.
//
// Routes:
//   GET  /health                  liveness for the compose healthcheck
//   GET  /v1/models               every scenario name plus "dynamic"
//   POST /v1/chat/completions     plays the scenario named by body.model;
//                                 unknown names (fake/dynamic) play the
//                                 dynamically selected scenario
//   PUT  /_test/scenario          selects the dynamic scenario (plain text body)
//   PUT  /_test/custom-scenario   registers {name, config} at runtime
//   GET  /_test/last-request      last parsed chat completion body

import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import { URL } from "node:url";
import type { Scenario } from "../src/test/scenarios";
import { BUILTIN_SCENARIOS, collapseChunks, readBody, sendJson, sendSse, sendSseDelayed } from "../src/test/scenarios";

const PORT = Number(process.env.PORT || 8080);

const scenarios = new Map<string, Scenario>(Object.entries(BUILTIN_SCENARIOS));
let dynamicScenario = "text-only";
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

const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
	const url = new URL(req.url || "/", `http://${req.headers.host}`);

	if (req.method === "GET" && url.pathname === "/health") {
		return sendJson(res, 200, { status: "ok" });
	}

	if (req.method === "GET" && url.pathname === "/v1/models") {
		const ids = [...scenarios.keys(), "dynamic"];
		return sendJson(res, 200, {
			object: "list",
			data: ids.map((id) => ({ id, object: "model", created: 0, owned_by: "fake-openai" })),
		});
	}

	if (req.method === "GET" && url.pathname === "/_test/last-request") {
		return sendJson(res, 200, lastRequest || {});
	}

	if (req.method === "PUT" && url.pathname === "/_test/scenario") {
		const name = (await readBody(req)).trim();
		if (!scenarios.has(name)) {
			return sendJson(res, 404, { error: { message: `Unknown scenario: ${name}` } });
		}
		dynamicScenario = name;
		return sendJson(res, 200, { scenario: name });
	}

	if (req.method === "PUT" && url.pathname === "/_test/custom-scenario") {
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readBody(req));
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

		const model = typeof body.model === "string" ? body.model : "";
		const scenario = scenarios.get(model) ?? scenarios.get(dynamicScenario);
		if (!scenario) {
			return sendJson(res, 500, { error: { message: `No scenario for model "${model}"` } });
		}
		return playScenario(res, scenario, body.stream === true);
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
