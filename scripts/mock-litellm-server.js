#!/usr/bin/env node
const http = require("http");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 4000);

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
				supports_vision: false,
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

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url || "/", `http://${req.headers.host}`);

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
		let payload = {};
		try {
			payload = raw ? JSON.parse(raw) : {};
		} catch {
			return sendJson(res, 400, { error: { message: "Invalid JSON" } });
		}

		const stream = payload.stream === true;
		const userMessage =
			Array.isArray(payload.messages) &&
			payload.messages
				.filter((m) => m && m.role === "user")
				.map((m) => m.content)
				.join(" ")
				.slice(0, 200);

		const content = userMessage ? `Mock LiteLLM response to: ${userMessage}` : "Hello from mock LiteLLM.";

		if (stream) {
			const chunks = [
				{
					id: "chatcmpl-mock",
					object: "chat.completion.chunk",
					choices: [
						{
							index: 0,
							delta: { role: "assistant", content },
						},
					],
				},
				{
					id: "chatcmpl-mock",
					object: "chat.completion.chunk",
					choices: [
						{
							index: 0,
							delta: {},
							finish_reason: "stop",
						},
					],
				},
			];
			return sendSse(res, chunks);
		}

		return sendJson(res, 200, {
			id: "chatcmpl-mock",
			object: "chat.completion",
			created: Math.floor(Date.now() / 1000),
			model: payload.model || MODEL_ID,
			choices: [
				{
					index: 0,
					message: { role: "assistant", content },
					finish_reason: "stop",
				},
			],
		});
	}

	sendJson(res, 404, { error: { message: "Not found" } });
});

server.listen(PORT, () => {
	console.log(`[mock-litellm] listening on http://localhost:${PORT}`);
});
