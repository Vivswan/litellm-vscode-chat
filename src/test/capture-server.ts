/**
 * Programmable capture server for host-fidelity tests: a controllable HTTP
 * server that captures inbound request bodies and returns scenario-specific SSE
 * responses.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import { URL } from "node:url";
import type { Scenario } from "./scenarios";
import { BUILTIN_SCENARIOS, playScenario, readBody, sendJson } from "./scenarios";

/** The single model this fixture serves when the caller mints no per-group-unique ID of its own. */
const DEFAULT_MODEL_ID = "openai/gpt-5-mini-flex";

const modelInfoFor = (modelId: string) => ({
	data: [
		{
			model_name: modelId,
			litellm_params: { model: modelId },
			model_info: {
				id: modelId,
				key: modelId,
				litellm_provider: "openai",
				// Deliberately off the built-in floors (128000 context, 16000 output) and
				// their derived input (112000), so the pins on these numbers fail the
				// moment a floor is served instead of the declared value.
				max_input_tokens: 200000,
				max_output_tokens: 12000,
				max_tokens: 12000,
				supports_function_calling: true,
				supports_tool_choice: true,
				supports_prompt_caching: false,
				supports_vision: true,
				// Declared pricing makes every capture run register the numeric cost
				// fields plus the derived priceCategory through the real host.
				input_cost_per_token: 0.00000125,
				output_cost_per_token: 0.00001,
			},
		},
	],
});

const modelsFor = (modelId: string) => ({
	object: "list",
	data: [
		{
			id: modelId,
			object: "model",
			created: 0,
			owned_by: "openai",
		},
	],
});

export interface CaptureServer {
	start(): Promise<void>;
	readonly port: number;
	setScenario(name: string): void;
	getLastRequest(): Record<string, unknown> | null;
	/** Every distinct Authorization header observed past the _test introspection block, verbatim; membership is race-free where a last-write-wins field is not. */
	getSeenAuthorizations(): readonly string[];
	addScenario(name: string, config: Scenario): void;
	close(): Promise<void>;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createCaptureServer(options?: { modelId?: string }): CaptureServer {
	const modelId = options?.modelId ?? DEFAULT_MODEL_ID;
	const modelInfo = modelInfoFor(modelId);
	const models = modelsFor(modelId);
	let lastRequest: Record<string, unknown> | null = null;
	const seenAuthorizations = new Set<string>();
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

		// Recorded for every request past the _test block above (unmatched paths
		// included), so suites can prove which credential a request carried.
		if (typeof req.headers.authorization === "string") {
			seenAuthorizations.add(req.headers.authorization);
		}

		// ── Standard LiteLLM-compatible endpoints ──
		if (req.method === "GET" && url.pathname === "/health") {
			return sendJson(res, 200, { status: "ok" });
		}

		if (req.method === "GET" && url.pathname === "/v1/model/info") {
			return sendJson(res, 200, modelInfo);
		}

		if (req.method === "GET" && url.pathname === "/v1/models") {
			return sendJson(res, 200, models);
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

			// Always the streaming rendition: this fixture's callers stream every
			// request.
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

		getSeenAuthorizations() {
			return [...seenAuthorizations];
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
