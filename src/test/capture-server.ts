/**
 * Programmable capture server for host-fidelity tests.
 *
 * Exports a factory function that returns a controllable HTTP server.
 * The server captures inbound request bodies and returns scenario-specific
 * SSE responses, enabling deterministic testing of the VS Code LM API path.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import { URL } from "node:url";
import type { Scenario } from "./scenarios";
import { BUILTIN_SCENARIOS, playScenario, readBody, sendJson } from "./scenarios";

/** The single model this fixture serves; host-fidelity.test.ts derives its scoped modelParameters keys from it. */
export const MODEL_ID = "openai/gpt-5-mini-flex";

const MODEL_INFO = {
	data: [
		{
			model_name: MODEL_ID,
			litellm_params: { model: MODEL_ID },
			model_info: {
				id: MODEL_ID,
				key: MODEL_ID,
				litellm_provider: "openai",
				max_input_tokens: 128000,
				max_output_tokens: 16000,
				max_tokens: 16000,
				supports_function_calling: true,
				supports_tool_choice: true,
				supports_prompt_caching: false,
				supports_vision: true,
			},
		},
	],
};

const MODELS = {
	object: "list",
	data: [
		{
			id: MODEL_ID,
			object: "model",
			created: 0,
			owned_by: "openai",
		},
	],
};

export interface CaptureServer {
	start(): Promise<void>;
	readonly port: number;
	setScenario(name: string): void;
	getLastRequest(): Record<string, unknown> | null;
	addScenario(name: string, config: Scenario): void;
	close(): Promise<void>;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createCaptureServer(): CaptureServer {
	let lastRequest: Record<string, unknown> | null = null;
	let activeScenario = "text-only";
	const scenarios = new Map<string, Scenario>(Object.entries(BUILTIN_SCENARIOS));

	const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		const url = new URL(req.url || "/", `http://${req.headers.host}`);

		// ── Test introspection endpoints ──
		if (req.method === "GET" && url.pathname === "/_test/last-request") {
			return sendJson(res, 200, lastRequest || {});
		}

		if (req.method === "PUT" && url.pathname === "/_test/scenario") {
			const body = await readBody(req);
			const name = body.trim();
			if (!scenarios.has(name)) {
				return sendJson(res, 404, { error: { message: `Unknown scenario: ${name}` } });
			}
			activeScenario = name;
			return sendJson(res, 200, { scenario: name });
		}

		// ── Standard LiteLLM-compatible endpoints ──
		if (req.method === "GET" && url.pathname === "/health") {
			return sendJson(res, 200, { status: "ok" });
		}

		if (req.method === "GET" && url.pathname === "/v1/model/info") {
			return sendJson(res, 200, MODEL_INFO);
		}

		if (req.method === "GET" && url.pathname === "/v1/models") {
			return sendJson(res, 200, MODELS);
		}

		if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
			const raw = await readBody(req);
			try {
				lastRequest = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
			} catch {
				lastRequest = { _parseError: true, _raw: raw };
				return sendJson(res, 400, { error: { message: "Invalid JSON" } });
			}

			const scenario = scenarios.get(activeScenario);
			if (!scenario) {
				return sendJson(res, 500, { error: { message: `No scenario configured` } });
			}

			// Always the streaming rendition: this fixture's host-fidelity callers
			// stream every request, and the pre-refactor behavior never collapsed.
			return playScenario(res, scenario, true);
		}

		sendJson(res, 404, { error: { message: "Not found" } });
	};

	const server = http.createServer((req, res) => {
		handleRequest(req, res).catch(() => {
			// A failed handler must not hang the connection open.
			res.destroy();
		});
	});

	let resolvedPort = 0;

	return {
		start() {
			return new Promise<void>((resolve, reject) => {
				server.listen(0, () => {
					const address = server.address();
					resolvedPort = typeof address === "object" && address !== null ? address.port : 0;
					resolve();
				});
				server.on("error", reject);
			});
		},

		get port() {
			return resolvedPort;
		},

		setScenario(name: string) {
			if (!scenarios.has(name)) {
				throw new Error(`Unknown scenario: ${name}`);
			}
			activeScenario = name;
		},

		getLastRequest() {
			return lastRequest;
		},

		addScenario(name: string, config: Scenario) {
			scenarios.set(name, config);
		},

		close() {
			return new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
		},
	};
}
