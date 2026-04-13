#!/usr/bin/env node
/**
 * Programmable capture server for host-fidelity tests.
 *
 * Exports a factory function that returns a controllable HTTP server.
 * The server captures inbound request bodies and returns scenario-specific
 * SSE responses, enabling deterministic testing of the VS Code LM API path.
 */
const http = require("http");
const { URL } = require("url");

const MODEL_ID = "openai/gpt-5-mini-flex";

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

// ── Helpers ──────────────────────────────────────────────────────────────────

const readBody = (req) =>
	new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (chunk) => {
			data += chunk;
		});
		req.on("end", () => resolve(data));
		req.on("error", reject);
	});

const sendJson = (res, statusCode, body) => {
	const json = JSON.stringify(body);
	res.writeHead(statusCode, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(json),
	});
	res.end(json);
};

const sendSse = (res, chunks) => {
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});
	for (const chunk of chunks) {
		res.write(`data: ${JSON.stringify(chunk)}\n\n`);
	}
	res.write("data: [DONE]\n\n");
	res.end();
};

const sendSseDelayed = (res, chunks, delayMs) => {
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});
	let i = 0;
	const next = () => {
		if (res.destroyed) {
			return;
		}
		if (i < chunks.length) {
			res.write(`data: ${JSON.stringify(chunks[i])}\n\n`);
			i++;
			setTimeout(next, delayMs);
		} else {
			res.write("data: [DONE]\n\n");
			res.end();
		}
	};
	next();
};

// ── Built-in Scenarios ───────────────────────────────────────────────────────

function makeChunk(delta, finishReason) {
	return {
		id: "chatcmpl-capture",
		object: "chat.completion.chunk",
		choices: [
			{
				index: 0,
				delta,
				...(finishReason ? { finish_reason: finishReason } : {}),
			},
		],
	};
}

const BUILTIN_SCENARIOS = {
	"text-only": {
		type: "sse",
		chunks: [makeChunk({ role: "assistant", content: "Hello from capture server" }), makeChunk({}, "stop")],
	},

	"structured-content": {
		type: "sse",
		chunks: [
			makeChunk({ role: "assistant", content: [{ type: "text", text: "structured text" }] }),
			makeChunk({}, "stop"),
		],
	},

	reasoning: {
		type: "sse",
		chunks: [
			makeChunk({ role: "assistant", reasoning_content: "Let me think about this..." }),
			makeChunk({ content: "The answer is 42" }),
			makeChunk({}, "stop"),
		],
	},

	"tool-call-single": {
		type: "sse",
		chunks: [
			makeChunk({
				role: "assistant",
				tool_calls: [
					{
						index: 0,
						id: "call_abc123",
						type: "function",
						function: {
							name: "get_weather",
							arguments: '{"location":"Paris"}',
						},
					},
				],
			}),
			makeChunk({}, "tool_calls"),
		],
	},

	"tool-call-chunked": {
		type: "sse",
		chunks: [
			// Frame 1: id + name, no args yet
			makeChunk({
				role: "assistant",
				tool_calls: [
					{
						index: 0,
						id: "call_chunked1",
						type: "function",
						function: {
							name: "get_weather",
							arguments: "",
						},
					},
				],
			}),
			// Frame 2: partial args
			makeChunk({
				tool_calls: [
					{
						index: 0,
						function: {
							arguments: '{"loc',
						},
					},
				],
			}),
			// Frame 3: rest of args
			makeChunk({
				tool_calls: [
					{
						index: 0,
						function: {
							arguments: 'ation":"Paris"}',
						},
					},
				],
			}),
			makeChunk({}, "tool_calls"),
		],
	},

	"usage-only-final": {
		type: "sse",
		chunks: [
			makeChunk({ role: "assistant", content: "Response with usage" }),
			makeChunk({}, "stop"),
			// Final chunk: empty choices + usage trailer
			{
				id: "chatcmpl-capture",
				object: "chat.completion.chunk",
				choices: [],
				usage: {
					prompt_tokens: 100,
					completion_tokens: 50,
					total_tokens: 150,
				},
			},
		],
	},

	"error-400": {
		type: "error",
		statusCode: 400,
		body: { error: { message: "Bad request: unknown parameter" } },
	},

	"error-401": {
		type: "error",
		statusCode: 401,
		body: { error: { message: "Unauthorized" } },
	},

	"slow-stream": {
		type: "sse-delayed",
		delayMs: 100,
		chunks: [
			makeChunk({ role: "assistant", content: "chunk1 " }),
			makeChunk({ content: "chunk2 " }),
			makeChunk({ content: "chunk3 " }),
			makeChunk({ content: "chunk4 " }),
			makeChunk({ content: "chunk5 " }),
			makeChunk({}, "stop"),
		],
	},
};

// ── Factory ──────────────────────────────────────────────────────────────────

function createCaptureServer() {
	let lastRequest = null;
	let activeScenario = "text-only";
	const scenarios = new Map(Object.entries(BUILTIN_SCENARIOS));

	const server = http.createServer(async (req, res) => {
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
				lastRequest = raw ? JSON.parse(raw) : {};
			} catch {
				lastRequest = { _parseError: true, _raw: raw };
				return sendJson(res, 400, { error: { message: "Invalid JSON" } });
			}

			const scenario = scenarios.get(activeScenario);
			if (!scenario) {
				return sendJson(res, 500, { error: { message: `No scenario configured` } });
			}

			if (scenario.type === "error") {
				return sendJson(res, scenario.statusCode, scenario.body);
			}

			if (scenario.type === "sse-delayed") {
				return sendSseDelayed(res, scenario.chunks, scenario.delayMs);
			}

			// Default: immediate SSE
			return sendSse(res, scenario.chunks);
		}

		sendJson(res, 404, { error: { message: "Not found" } });
	});

	let resolvedPort = 0;

	return {
		start() {
			return new Promise((resolve, reject) => {
				server.listen(0, () => {
					resolvedPort = server.address().port;
					resolve();
				});
				server.on("error", reject);
			});
		},

		get port() {
			return resolvedPort;
		},

		setScenario(name) {
			if (!scenarios.has(name)) {
				throw new Error(`Unknown scenario: ${name}`);
			}
			activeScenario = name;
		},

		getLastRequest() {
			return lastRequest;
		},

		addScenario(name, config) {
			scenarios.set(name, config);
		},

		close() {
			return new Promise((resolve) => {
				server.close(resolve);
			});
		},
	};
}

module.exports = { createCaptureServer };
