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

/**
 * A well-formed SSE prefix with a broken ending: after the chunks, "destroy"
 * drops the socket, "no-done" ends the body cleanly WITHOUT the [DONE]
 * sentinel, and "stall" holds the connection silent for stallMs (default
 * STALL_MS_DEFAULT) before destroying it server-side. delayMs paces the
 * chunks like sse-delayed.
 */
interface SseAbortScenario {
	type: "sse-abort";
	chunks: unknown[];
	tail: "destroy" | "no-done" | "stall";
	stallMs?: number;
	delayMs?: number;
}

/**
 * Verbatim response bytes: statusCode and headers as given, then the frames
 * written in order (each frame's characters are single bytes, written as
 * latin1, so a test can split a multi-byte UTF-8 sequence across frames).
 * Nothing is implied - no Content-Type, no [DONE]; callers spell out every
 * byte. This is the surface for malformed SSE framing, wrong content types,
 * and non-JSON error bodies.
 */
interface RawScenario {
	type: "raw";
	statusCode: number;
	headers: Record<string, string>;
	frames: string[];
	frameDelayMs?: number;
	tail: "end" | "destroy" | "stall";
	stallMs?: number;
}

export type Scenario = SseScenario | SseDelayedScenario | ErrorScenario | SseAbortScenario | RawScenario;

/** Stall duration when an sse-abort or raw scenario names none. */
export const STALL_MS_DEFAULT = 10000;

/**
 * Hard bound on stall durations and per-step pacing delays, and the whole
 * paced-playback deadline: paced sse-abort/raw playback destroys its response
 * this long after it starts even when steps times delay would run longer, so
 * a leaked test cannot wedge the fake backend's container.
 */
export const MAX_STALL_MS = 60000;

/**
 * Upper bound on the chunks/frames list of a runtime-registered scenario: the
 * 1 MiB body cap alone still admits hundreds of thousands of entries, whose
 * paced playback would occupy the socket far past every delay cap.
 */
export const MAX_SCENARIO_ITEMS = 10000;

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

	// Perplexity-style chunk-root citations and search_results (LiteLLM's
	// streaming pass-through): the source list grows as the model finds
	// sources, so later chunks repeat the already-reported entries; the
	// repeats must dedupe into one Sources trailer. makeChunk only builds
	// choices, so the root fields are spread onto its result.
	"citations-chunk-level": {
		type: "sse",
		chunks: [
			{
				...makeChunk({ role: "assistant", content: "Grass is green." }),
				citations: ["https://example.test/grass"],
				search_results: [{ title: "Grass color", url: "https://example.test/grass", date: "2026-01-01" }],
			},
			{
				...makeChunk({ content: " The sky is blue." }),
				citations: ["https://example.test/grass", "https://example.test/sky"],
				search_results: [
					{ title: "Grass color", url: "https://example.test/grass", date: "2026-01-01" },
					{ title: "Sky color", url: "https://example.test/sky", date: "2026-01-02" },
				],
			},
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
		// Decode as one utf8 stream: per-chunk Buffer.toString would corrupt a
		// multi-byte character split across TCP reads.
		req.setEncoding("utf8");
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

const SSE_HEADERS = {
	"Content-Type": "text/event-stream",
	"Cache-Control": "no-cache",
	Connection: "keep-alive",
} as const;

const sendSse = (res: ServerResponse, chunks: unknown[]): void => {
	res.writeHead(200, SSE_HEADERS);
	for (const chunk of chunks) {
		res.write(`data: ${JSON.stringify(chunk)}\n\n`);
	}
	res.write("data: [DONE]\n\n");
	res.end();
};

const sendSseDelayed = (res: ServerResponse, chunks: unknown[], delayMs: number): void => {
	res.writeHead(200, SSE_HEADERS);
	runPaced(
		res,
		chunks.length,
		(i) => res.write(`data: ${JSON.stringify(chunks[i])}\n\n`),
		delayMs,
		() => {
			res.write("data: [DONE]\n\n");
			res.end();
		}
	);
};

/**
 * Delay between the last written bytes and a destroy tail. Destroying in the
 * same tick as the writes sends an RST while headers and chunks still sit in
 * local buffers, and the peer then observes a zero-byte connection failure
 * instead of a mid-stream abort; the pause lets the peer read what was
 * written first.
 */
const DESTROY_FLUSH_MS = 100;

/**
 * A timer that dies with the response: cleared when the client closes, so a
 * cancelled request never keeps its response retained by a pending callback.
 */
const armTimer = (res: ServerResponse, fn: () => void, ms: number): void => {
	// codeql[js/resource-exhaustion] -- fake-backend timer; every duration here is capped at MAX_STALL_MS
	const timer = setTimeout(fn, ms);
	res.once("close", () => clearTimeout(timer));
};

/** Hold the connection silent, then destroy it server-side; the duration is capped at MAX_STALL_MS regardless of the ask. */
const stallThenDestroy = (res: ServerResponse, stallMs: number | undefined): void => {
	armTimer(res, () => res.destroy(), Math.min(stallMs ?? STALL_MS_DEFAULT, MAX_STALL_MS));
};

/** Destroy the socket once the written bytes had a chance to reach the peer; see DESTROY_FLUSH_MS. */
const destroyAfterFlush = (res: ServerResponse): void => {
	armTimer(res, () => res.destroy(), DESTROY_FLUSH_MS);
};

/**
 * Write `count` paced steps, then finish. One close listener clears whatever
 * timer is pending, and a whole-playback deadline destroys the response
 * MAX_STALL_MS after the first write: a validator-passing scenario can still
 * carry thousands of steps, so the per-value caps alone do not bound socket
 * occupation. The deadline stays armed through the finish tail (a stall after
 * a long playback dies with it) and is cleared by the close event.
 */
function runPaced(
	res: ServerResponse,
	count: number,
	writeStep: (i: number) => void,
	delayMs: number,
	finish: () => void
): void {
	let pending: NodeJS.Timeout | undefined;
	// codeql[js/resource-exhaustion] -- fake-backend deadline; fixed at MAX_STALL_MS
	const deadline = setTimeout(() => res.destroy(), MAX_STALL_MS);
	res.once("close", () => {
		clearTimeout(deadline);
		if (pending !== undefined) {
			clearTimeout(pending);
		}
	});
	let i = 0;
	const next = (): void => {
		if (res.destroyed) {
			return;
		}
		if (i < count) {
			writeStep(i);
			i++;
			// codeql[js/resource-exhaustion] -- fake-backend pacing timer; delay capped by the validator, total by the deadline
			pending = setTimeout(next, delayMs);
		} else {
			finish();
		}
	};
	next();
}

const sendSseAbort = (res: ServerResponse, scenario: SseAbortScenario): void => {
	res.writeHead(200, SSE_HEADERS);
	const finish = (): void => {
		if (res.destroyed) {
			return;
		}
		if (scenario.tail === "destroy") {
			destroyAfterFlush(res);
		} else if (scenario.tail === "no-done") {
			res.end();
		} else {
			stallThenDestroy(res, scenario.stallMs);
		}
	};
	const writeChunk = (i: number): void => {
		res.write(`data: ${JSON.stringify(scenario.chunks[i])}\n\n`);
	};
	if (scenario.delayMs === undefined) {
		for (let i = 0; i < scenario.chunks.length; i++) {
			writeChunk(i);
		}
		finish();
	} else {
		runPaced(res, scenario.chunks.length, writeChunk, scenario.delayMs, finish);
	}
};

const sendRaw = (res: ServerResponse, scenario: RawScenario): void => {
	res.writeHead(scenario.statusCode, scenario.headers);
	const finish = (): void => {
		if (res.destroyed) {
			return;
		}
		if (scenario.tail === "end") {
			res.end();
		} else if (scenario.tail === "destroy") {
			destroyAfterFlush(res);
		} else {
			stallThenDestroy(res, scenario.stallMs);
		}
	};
	// latin1 maps each character to one byte, so frames state exact wire bytes.
	const writeFrame = (i: number): void => {
		res.write(Buffer.from(scenario.frames[i] as string, "latin1"));
	};
	if (scenario.frameDelayMs === undefined) {
		for (let i = 0; i < scenario.frames.length; i++) {
			writeFrame(i);
		}
		finish();
	} else {
		runPaced(res, scenario.frames.length, writeFrame, scenario.frameDelayMs, finish);
	}
};

/**
 * The one playback dispatch, shared by the containerized fake OpenAI server
 * and the in-process capture server. `raw` plays verbatim regardless of the
 * stream flag; `sse-abort` collapses for stream:false like plain sse does,
 * because abort semantics are stream-only (there is no mid-body failure to
 * fake in a single JSON response).
 */
export function playScenario(res: ServerResponse, scenario: Scenario, stream: boolean): void {
	if (scenario.type === "error") {
		sendJson(res, scenario.statusCode, scenario.body ?? {});
	} else if (scenario.type === "raw") {
		sendRaw(res, scenario);
	} else if (!stream) {
		sendJson(res, 200, collapseChunks(scenario.chunks));
	} else if (scenario.type === "sse-abort") {
		sendSseAbort(res, scenario);
	} else if (scenario.type === "sse-delayed") {
		sendSseDelayed(res, scenario.chunks, scenario.delayMs);
	} else {
		sendSse(res, scenario.chunks);
	}
}

// ── Runtime-registration validation ──────────────────────────────────────────

/** Bounded chunk/frame lists; the count cap is what keeps paced playback finite (see MAX_SCENARIO_ITEMS). */
const isBoundedList = (value: unknown): value is unknown[] =>
	Array.isArray(value) && value.length <= MAX_SCENARIO_ITEMS;

/** Durations must be finite and inside [0, MAX_STALL_MS]; optional ones may be absent. */
const isBoundedMs = (value: unknown): boolean =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_STALL_MS;
const isOptionalBoundedMs = (value: unknown): boolean => value === undefined || isBoundedMs(value);

/** Statuses a scenario may answer with: writeHead-safe, no 1xx interim responses. */
const isStatusCode = (value: unknown): boolean =>
	typeof value === "number" && Number.isInteger(value) && value >= 200 && value <= 599;

const isStringRecord = (value: unknown): value is Record<string, string> =>
	typeof value === "object" &&
	value !== null &&
	!Array.isArray(value) &&
	Object.values(value).every((entry) => typeof entry === "string");

/** Raw frames are written as latin1, one char per byte; a code point above 0xFF would silently mojibake, so it is rejected here. */
const isByteString = (value: unknown): value is string => {
	if (typeof value !== "string") {
		return false;
	}
	for (let i = 0; i < value.length; i++) {
		if (value.charCodeAt(i) > 0xff) {
			return false;
		}
	}
	return true;
};

/**
 * Validator for PUT /_test/custom-scenario payloads. Built-in scenarios do
 * not pass through here; the caps exist so a runtime registration cannot
 * wedge the fake backend (unbounded lists, delays, or statuses writeHead
 * would reject).
 */
export function isScenario(value: unknown): value is Scenario {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as Record<string, unknown>;
	if (record.type === "sse") {
		return isBoundedList(record.chunks);
	}
	if (record.type === "sse-delayed") {
		return isBoundedList(record.chunks) && isBoundedMs(record.delayMs);
	}
	if (record.type === "error") {
		return isStatusCode(record.statusCode);
	}
	if (record.type === "sse-abort") {
		return (
			isBoundedList(record.chunks) &&
			(record.tail === "destroy" || record.tail === "no-done" || record.tail === "stall") &&
			isOptionalBoundedMs(record.stallMs) &&
			isOptionalBoundedMs(record.delayMs)
		);
	}
	if (record.type === "raw") {
		return (
			isStatusCode(record.statusCode) &&
			isStringRecord(record.headers) &&
			isBoundedList(record.frames) &&
			record.frames.every(isByteString) &&
			(record.tail === "end" || record.tail === "destroy" || record.tail === "stall") &&
			isOptionalBoundedMs(record.frameDelayMs) &&
			isOptionalBoundedMs(record.stallMs)
		);
	}
	return false;
}

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
