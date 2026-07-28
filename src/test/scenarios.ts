/**
 * Shared streaming scenario definitions for the fake LiteLLM backends: the
 * in-process capture server (host-fidelity tests) and the containerized
 * fake OpenAI server behind the docker LiteLLM proxy. Each scenario is a
 * canned /v1/chat/completions response, addressed per request with the
 * %play:<name> command (src/test/fakeStack/commands.ts). The model catalog
 * lives separately in src/test/fakeStack/models.ts.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

interface SseScenario {
	type: "sse";
	chunks: unknown[];
}

interface SseDelayedScenario {
	type: "sse-delayed";
	delayMs: number;
	chunks: unknown[];
}

interface ErrorScenario {
	type: "error";
	statusCode: number;
	body: unknown;
}

export type Scenario = SseScenario | SseDelayedScenario | ErrorScenario;

/** Total content chunks in the "slow-stream" scenario; cancellation tests assert against this. */
export const SLOW_STREAM_CHUNK_COUNT = 50;

function makeChunk(delta: Record<string, unknown>, finishReason?: string): Record<string, unknown> {
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

export const BUILTIN_SCENARIOS: Record<string, Scenario> = {
	"text-only": {
		type: "sse",
		chunks: [makeChunk({ role: "assistant", content: "Hello from capture server" }), makeChunk({}, "stop")],
	},

	// A playback shape from the era when this scenario had its own two-
	// deployment proxy model; the load-balanced group is now gpt-5.2 in
	// src/test/fakeStack/models.ts, and this stays as a %play target.
	"load-balanced": {
		type: "sse",
		chunks: [makeChunk({ role: "assistant", content: "Balanced across deployments" }), makeChunk({}, "stop")],
	},

	// Multi-sentence reply for suites that assert substantial output length
	"long-text": {
		type: "sse",
		chunks: [
			makeChunk({ role: "assistant", content: "Blue is the color of the daytime sky, " }),
			makeChunk({ content: "the deep sea, and countless flags. " }),
			makeChunk({ content: "It reads as calm and dependable, which is why interfaces lean on it so heavily." }),
			makeChunk({}, "stop"),
		],
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

	"error-429": {
		type: "error",
		statusCode: 429,
		body: { error: { message: "Rate limit exceeded. Retry after 60 seconds.", type: "rate_limit_error" } },
	},

	"slow-stream": {
		type: "sse-delayed",
		delayMs: 100,
		chunks: [
			makeChunk({ role: "assistant", content: "chunk1 " }),
			...Array.from({ length: SLOW_STREAM_CHUNK_COUNT - 1 }, (_, i) => makeChunk({ content: `chunk${i + 2} ` })),
			makeChunk({}, "stop"),
		],
	},

	// Anthropic-style structured thinking object (text + id + metadata)
	"thinking-structured": {
		type: "sse",
		chunks: [
			makeChunk({
				role: "assistant",
				thinking: { text: "I need to work through this step by step.", id: "think_001" },
			}),
			makeChunk({ thinking: { text: " First, consider the problem.", id: "think_001" } }),
			makeChunk({ content: "Here is my answer." }),
			makeChunk({}, "stop"),
		],
	},

	// Text followed by tool call in the same response (common with reasoning models)
	"text-then-tool": {
		type: "sse",
		chunks: [
			makeChunk({ role: "assistant", content: "Let me check that for you." }),
			makeChunk({
				tool_calls: [
					{
						index: 0,
						id: "call_after_text",
						type: "function",
						function: { name: "get_weather", arguments: '{"location":"London"}' },
					},
				],
			}),
			makeChunk({}, "tool_calls"),
		],
	},

	// Multiple parallel tool calls in one response
	"parallel-tool-calls": {
		type: "sse",
		chunks: [
			makeChunk({
				role: "assistant",
				tool_calls: [
					{
						index: 0,
						id: "call_p1",
						type: "function",
						function: { name: "get_weather", arguments: '{"location":"Paris"}' },
					},
					{
						index: 1,
						id: "call_p2",
						type: "function",
						function: { name: "get_weather", arguments: '{"location":"Tokyo"}' },
					},
				],
			}),
			makeChunk({}, "tool_calls"),
		],
	},

	// Usage trailer with cache token details (Anthropic prompt caching)
	"usage-with-cache-tokens": {
		type: "sse",
		chunks: [
			makeChunk({ role: "assistant", content: "Cached response" }),
			makeChunk({}, "stop"),
			{
				id: "chatcmpl-capture",
				object: "chat.completion.chunk",
				choices: [],
				usage: {
					prompt_tokens: 200,
					completion_tokens: 30,
					total_tokens: 230,
					cache_creation_input_tokens: 150,
					cache_read_input_tokens: 50,
				},
			},
		],
	},

	// DeepSeek reasoning field (plain string, different from reasoning_content)
	"reasoning-field": {
		type: "sse",
		chunks: [
			makeChunk({ role: "assistant", reasoning: "Working through the math..." }),
			makeChunk({ content: "The result is 7." }),
			makeChunk({}, "stop"),
		],
	},

	// Tool call embedded in streamed text via control tokens, split across chunks
	"inline-tool-call-tokens": {
		type: "sse",
		chunks: [
			makeChunk({ role: "assistant", content: "Checking the weather. <|tool_call_begin|>get_wea" }),
			makeChunk({ content: 'ther:0<|tool_call_argument_begin|>{"location":' }),
			makeChunk({ content: '"Paris"}<|tool_call_end|>' }),
			makeChunk({}, "stop"),
		],
	},

	// Section control tokens wrapping ordinary text; markers must be stripped
	"control-token-sections": {
		type: "sse",
		chunks: [
			makeChunk({ role: "assistant", content: "<|assistant_section_begin|>Hello" }),
			makeChunk({ content: " world<|assistant_" }),
			makeChunk({ content: "section_end|>" }),
			makeChunk({}, "stop"),
		],
	},

	// Truncated output: finish_reason "length" after partial text
	"finish-length": {
		type: "sse",
		chunks: [makeChunk({ role: "assistant", content: "This answer was cut sho" }), makeChunk({}, "length")],
	},

	// Provider content filter ended the stream
	"finish-content-filter": {
		type: "sse",
		chunks: [makeChunk({ role: "assistant", content: "Partial answer" }), makeChunk({}, "content_filter")],
	},

	// Tool call whose arguments never become valid JSON; the request must fail on completion
	"tool-call-invalid-json": {
		type: "sse",
		chunks: [
			makeChunk({
				role: "assistant",
				tool_calls: [
					{
						index: 0,
						id: "call_bad_json",
						type: "function",
						function: { name: "get_weather", arguments: '{"location":' },
					},
				],
			}),
			makeChunk({}, "tool_calls"),
		],
	},

	// The same call arrives on the delta channel and inline in text; only one may be emitted
	"duplicate-tool-calls": {
		type: "sse",
		chunks: [
			makeChunk({
				role: "assistant",
				tool_calls: [
					{
						index: 0,
						id: "call_dup",
						type: "function",
						function: { name: "get_weather", arguments: '{"location":"Paris"}' },
					},
				],
			}),
			makeChunk({
				content: '<|tool_call_begin|>get_weather:0<|tool_call_argument_begin|>{"location":"Paris"}<|tool_call_end|>',
			}),
			makeChunk({}, "tool_calls"),
		],
	},

	// Structured content array mixing text blocks with non-text blocks; only text renders
	"structured-content-mixed": {
		type: "sse",
		chunks: [
			makeChunk({
				role: "assistant",
				content: [
					{ type: "text", text: "visible text" },
					{ type: "image_url", image_url: { url: "https://example.test/image.png" } },
					{ type: "audio", audio: { data: "UklGRg==" } },
				],
			}),
			makeChunk({}, "stop"),
		],
	},

	// OpenAI structured-output refusal delta
	refusal: {
		type: "sse",
		chunks: [
			makeChunk({ role: "assistant", refusal: "I cannot help" }),
			makeChunk({ refusal: " with that request." }),
			makeChunk({}, "stop"),
		],
	},

	// URL citations attached to a content delta (web-search-enabled models)
	annotations: {
		type: "sse",
		chunks: [
			makeChunk({
				role: "assistant",
				content: "The sky is blue.",
				annotations: [
					{
						type: "url_citation",
						url_citation: {
							url: "https://example.test/sky",
							title: "Why the sky is blue",
							start_index: 0,
							end_index: 16,
						},
					},
				],
			}),
			makeChunk({}, "stop"),
		],
	},

	// LiteLLM's Anthropic extended-thinking mapping: thinking_blocks with signatures
	// alongside the duplicate reasoning_content text
	"thinking-blocks": {
		type: "sse",
		chunks: [
			makeChunk({
				role: "assistant",
				reasoning_content: "Consider the problem.",
				thinking_blocks: [{ type: "thinking", thinking: "Consider the problem.", signature: "sig-block-1" }],
			}),
			makeChunk({
				reasoning_content: " Weigh the options.",
				thinking_blocks: [{ type: "thinking", thinking: " Weigh the options.", signature: "sig-block-2" }],
			}),
			makeChunk({ content: "Decided: option A." }),
			makeChunk({}, "stop"),
		],
	},

	// Redacted thinking block: opaque data, no visible text
	"redacted-thinking": {
		type: "sse",
		chunks: [
			makeChunk({
				role: "assistant",
				thinking_blocks: [{ type: "redacted_thinking", data: "opaque-redacted-payload" }],
			}),
			makeChunk({ content: "Answer after redacted thinking." }),
			makeChunk({}, "stop"),
		],
	},

	// Audio output delta (gpt-4o-audio shape); the transcript streams as text, the clip as one DataPart at end of stream
	"audio-output": {
		type: "sse",
		chunks: [
			makeChunk({ role: "assistant", audio: { id: "audio_1", data: "UklGRg==", transcript: "Spoken words" } }),
			makeChunk({ content: "Text alongside audio." }),
			makeChunk({}, "stop"),
		],
	},

	// Usage trailer carrying nested token detail objects
	"usage-token-details": {
		type: "sse",
		chunks: [
			makeChunk({ role: "assistant", content: "Detailed usage" }),
			makeChunk({}, "stop"),
			{
				id: "chatcmpl-capture",
				object: "chat.completion.chunk",
				choices: [],
				usage: {
					prompt_tokens: 120,
					completion_tokens: 80,
					total_tokens: 200,
					prompt_tokens_details: { cached_tokens: 90, audio_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 40, audio_tokens: 0 },
				},
			},
		],
	},
};

// ── Playback helpers ─────────────────────────────────────────────────────────
// Shared by the capture server and the containerized fake OpenAI server.

export const readBody = (req: IncomingMessage): Promise<string> =>
	new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (chunk) => {
			data += chunk;
		});
		req.on("end", () => resolve(data));
		req.on("error", reject);
	});

export const sendJson = (res: ServerResponse, statusCode: number, body: unknown): void => {
	const json = JSON.stringify(body);
	res.writeHead(statusCode, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(json),
	});
	res.end(json);
};

export const sendSse = (res: ServerResponse, chunks: unknown[]): void => {
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

export const sendSseDelayed = (res: ServerResponse, chunks: unknown[], delayMs: number): void => {
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});
	let i = 0;
	const next = (): void => {
		if (res.destroyed) {
			return;
		}
		if (i < chunks.length) {
			res.write(`data: ${JSON.stringify(chunks[i])}\n\n`);
			i++;
			// codeql[js/resource-exhaustion] -- fake-backend timer; delayMs comes from authored scenario definitions
			setTimeout(next, delayMs);
		} else {
			res.write("data: [DONE]\n\n");
			res.end();
		}
	};
	next();
};

/**
 * Collapse an SSE chunk list into one non-streaming chat.completion body.
 * Used for stream:false requests (LiteLLM's own health probes send those, and
 * raw curl calls default to non-streaming). Text, refusal, tool calls, the
 * finish reason, and the usage trailer all carry over.
 */
export function collapseChunks(chunks: unknown[]): Record<string, unknown> {
	let content = "";
	let refusal = "";
	let finishReason = "stop";
	let usage: unknown;
	const toolCalls = new Map<number, { id?: string; name?: string; args: string }>();
	for (const chunk of chunks) {
		if (typeof chunk !== "object" || chunk === null) {
			continue;
		}
		const record = chunk as Record<string, unknown>;
		if (record.usage !== undefined && record.usage !== null) {
			usage = record.usage;
		}
		const choices = Array.isArray(record.choices) ? record.choices : [];
		for (const choice of choices) {
			if (typeof choice !== "object" || choice === null) {
				continue;
			}
			const choiceRecord = choice as Record<string, unknown>;
			if (typeof choiceRecord.finish_reason === "string") {
				finishReason = choiceRecord.finish_reason;
			}
			const delta = choiceRecord.delta;
			if (typeof delta !== "object" || delta === null) {
				continue;
			}
			const deltaRecord = delta as Record<string, unknown>;
			if (typeof deltaRecord.content === "string") {
				content += deltaRecord.content;
			}
			if (typeof deltaRecord.refusal === "string") {
				refusal += deltaRecord.refusal;
			}
			const deltaToolCalls = Array.isArray(deltaRecord.tool_calls) ? deltaRecord.tool_calls : [];
			for (const rawCall of deltaToolCalls) {
				if (typeof rawCall !== "object" || rawCall === null) {
					continue;
				}
				const call = rawCall as { index?: number; id?: string; function?: { name?: string; arguments?: string } };
				const index = typeof call.index === "number" ? call.index : 0;
				const buffer = toolCalls.get(index) ?? { args: "" };
				if (call.id) {
					buffer.id = call.id;
				}
				if (call.function?.name) {
					buffer.name = call.function.name;
				}
				if (typeof call.function?.arguments === "string") {
					buffer.args += call.function.arguments;
				}
				toolCalls.set(index, buffer);
			}
		}
	}
	const message: Record<string, unknown> = { role: "assistant", content };
	if (refusal) {
		message.refusal = refusal;
	}
	if (toolCalls.size > 0) {
		message.tool_calls = Array.from(toolCalls.entries()).map(([index, buffer]) => ({
			id: buffer.id ?? `call_collapsed_${index}`,
			type: "function",
			function: { name: buffer.name ?? "unknown_tool", arguments: buffer.args },
		}));
	}
	return {
		id: "chatcmpl-capture",
		object: "chat.completion",
		choices: [{ index: 0, message, finish_reason: finishReason }],
		...(usage !== undefined ? { usage } : {}),
	};
}
