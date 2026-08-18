import * as assert from "node:assert";
import * as vscode from "vscode";
import type { LiteLLMModelInfo } from "../../../provider/catalog/groupModels";
import { ChatClient } from "../../../provider/transport/chatClient";
import { convertMessages } from "../../../shared/conversion/messages";
import { normalizeBaseUrl } from "../../../shared/util/baseUrl";
import { makeLogger, withFetch } from "../../pureHelpers";
import { withConfig } from "../../testUtils";

function controllableStream(): { stream: ReadableStream<Uint8Array>; push(text: string): void; close(): void } {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});
	const encoder = new TextEncoder();
	return {
		stream,
		push: (text: string) => controller.enqueue(encoder.encode(text)),
		close: () => controller.close(),
	};
}

/** A tool-call delta without an id, forcing the client to generate one. */
function idlessToolCallChunk(name: string): string {
	const chunk = {
		choices: [{ delta: { tool_calls: [{ index: 0, function: { name, arguments: '{"x":1}' } }] } }],
	};
	return `data: ${JSON.stringify(chunk)}\n\n`;
}

function collector(): { callIds: string[]; progress: vscode.Progress<vscode.LanguageModelResponsePart> } {
	const callIds: string[] = [];
	return {
		callIds,
		progress: {
			report: (part: vscode.LanguageModelResponsePart) => {
				if (part instanceof vscode.LanguageModelToolCallPart) {
					callIds.push(part.callId);
				}
			},
		},
	};
}

const model = {
	id: "test-model",
	name: "test-model",
	family: "litellm",
	version: "1.0.0",
	maxInputTokens: 100000,
	maxOutputTokens: 8000,
	capabilities: {},
	litellm: {
		supportsPromptCaching: false,
		outputLimitSource: "defaults",
		// The attached group connection, as every served model carries it; the
		// request path routes by nothing else.
		server: { baseUrl: normalizeBaseUrl("http://litellm.test"), apiKey: "k", label: "Default" },
	},
} satisfies LiteLLMModelInfo;

const messages: vscode.LanguageModelChatRequestMessage[] = [
	{
		role: vscode.LanguageModelChatMessageRole.User,
		content: [new vscode.LanguageModelTextPart("hi")],
		name: undefined,
	},
];

const options = {
	toolMode: vscode.LanguageModelChatToolMode.Auto,
} as unknown as vscode.ProvideLanguageModelChatResponseOptions;

suite("provider/transport/chatClient", () => {
	// These tests stay on withFetch: they observe interleaved stream delivery
	// across concurrent requests, AbortSignal wiring, and injected transport
	// errors, none of which msw handlers can express.
	test("concurrent send() calls generate disjoint tool-call IDs", async () => {
		const first = controllableStream();
		const second = controllableStream();
		const bodies = [first, second];
		await withFetch(
			async () => {
				const body = bodies.shift();
				assert.ok(body, "Only two requests are expected");
				return new Response(body.stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
			},
			async () => {
				const client = new ChatClient({ userAgent: "test-agent" });

				const a = collector();
				const b = collector();
				const token = new vscode.CancellationTokenSource().token;
				const sendA = client.send({ model, messages, options, progress: a.progress, token });
				const sendB = client.send({ model, messages, options, progress: b.progress, token });

				// Both requests are now in flight; complete their streams interleaved.
				first.push(idlessToolCallChunk("tool_one"));
				second.push(idlessToolCallChunk("tool_two"));
				first.push("data: [DONE]\n\n");
				second.push("data: [DONE]\n\n");
				first.close();
				second.close();
				await Promise.all([sendA, sendB]);

				assert.equal(a.callIds.length, 1, "First request should emit one generated tool call");
				assert.equal(b.callIds.length, 1, "Second request should emit one generated tool call");
				const all = new Set([...a.callIds, ...b.callIds]);
				assert.equal(all.size, 2, `Generated IDs must be disjoint across overlapping requests, got ${[...all]}`);
				for (const id of all) {
					assert.match(id, /^call_\d+$/);
				}
			}
		);
	});

	test("the request's audio.format reaches the emitted audio DataPart as its mime", async () => {
		const body = controllableStream();
		await withFetch(
			async () => new Response(body.stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
			async () => {
				const client = new ChatClient({ userAgent: "test-agent" });

				const parts: vscode.LanguageModelResponsePart[] = [];
				const progress = { report: (p: vscode.LanguageModelResponsePart) => parts.push(p) };
				const audioOptions = {
					toolMode: vscode.LanguageModelChatToolMode.Auto,
					modelOptions: { audio: { voice: "alloy", format: "mp3" } },
				} as unknown as vscode.ProvideLanguageModelChatResponseOptions;
				const send = client.send({
					model,
					messages,
					options: audioOptions,
					progress,
					token: new vscode.CancellationTokenSource().token,
				});

				body.push(`data: ${JSON.stringify({ choices: [{ delta: { audio: { id: "a1", data: "AQID" } } }] })}\n\n`);
				body.push("data: [DONE]\n\n");
				body.close();
				await send;

				const dataParts = parts.filter((p) => p instanceof vscode.LanguageModelDataPart);
				assert.equal(dataParts.length, 1, "the audio clip must surface as one DataPart");
				const part = dataParts[0] as vscode.LanguageModelDataPart;
				assert.equal(part.mimeType, "audio/mpeg", "the pass-through audio.format parameter names the encoding");
			}
		);
	});

	test("a validation-rejected request emits zero conversion-side logs and never reaches fetch", async () => {
		// A history that both fails validation (unpaired tool call) and would log
		// during conversion (a DataPart with no wire mapping).
		const rejectedMessages: vscode.LanguageModelChatRequestMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [
					new vscode.LanguageModelTextPart("hi"),
					new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), "application/octet-stream"),
				],
				name: undefined,
			},
			{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelToolCallPart("call_1", "lookup", {})],
				name: undefined,
			},
		];
		const conversionLogPattern = /Skipping LanguageModelDataPart|Tool returned/;

		// Positive control: converting this history does emit the drop log, so the
		// zero-logs assertion below cannot pass vacuously.
		const controlLogs: string[] = [];
		convertMessages(rejectedMessages, { log: (message) => controlLogs.push(message) });
		assert.ok(
			controlLogs.some((message) => conversionLogPattern.test(message)),
			`the control conversion must log the dropped DataPart, got ${JSON.stringify(controlLogs)}`
		);

		let fetchCalled = false;
		await withFetch(
			async () => {
				fetchCalled = true;
				throw new Error("a validation-rejected request must never reach fetch");
			},
			async () => {
				const { logger, lines } = makeLogger();
				const client = new ChatClient({ userAgent: "test-agent", logger });

				const token = new vscode.CancellationTokenSource().token;
				await assert.rejects(
					client.send({ model, messages: rejectedMessages, options, progress: collector().progress, token }),
					/missing a tool result/
				);

				assert.strictEqual(fetchCalled, false, "the rejected request must never leave the machine");
				const leaked = lines.filter((message) => conversionLogPattern.test(message));
				assert.deepStrictEqual(leaked, [], "a validation-rejected request must emit zero conversion-side logs");
			}
		);
	});

	test("user cancellation aborts the in-flight fetch and throws CancellationError", async () => {
		let observedSignal: AbortSignal | undefined;
		await withFetch(
			async (_url, init) => {
				observedSignal = init?.signal ?? undefined;
				const signal = init?.signal;
				// Behave like a real fetch: the body stream errors when the request signal aborts.
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						signal?.addEventListener("abort", () => controller.error(signal.reason ?? new Error("aborted")));
					},
				});
				return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
			},
			async () => {
				const client = new ChatClient({ userAgent: "test-agent" });

				const cts = new vscode.CancellationTokenSource();
				const sendPromise = client.send({
					model,
					messages,
					options,
					progress: collector().progress,
					token: cts.token,
				});
				setTimeout(() => cts.cancel(), 20);

				await assert.rejects(sendPromise, (err: unknown) => {
					assert.ok(err instanceof vscode.CancellationError, `Expected CancellationError, got ${String(err)}`);
					return true;
				});
				assert.ok(observedSignal, "fetch should receive an AbortSignal");
				assert.strictEqual(observedSignal.aborted, true, "Cancellation must abort the fetch signal");
			}
		);
	});

	test("request timeout surfaces an actionable error naming the chat.timeout setting", async () => {
		await withFetch(
			async () => {
				throw new DOMException("The operation timed out.", "TimeoutError");
			},
			async () => {
				const client = new ChatClient({ userAgent: "test-agent" });

				const token = new vscode.CancellationTokenSource().token;
				await assert.rejects(
					client.send({ model, messages, options, progress: collector().progress, token }),
					/chat\.timeout/
				);
			}
		);
	});

	test("a stream that stalls mid-body aborts at the configured chat.timeout", async function () {
		// The configured timeouts are hard whole-call bounds. The SDK's own timeout
		// disarms once headers arrive, so only send()'s AbortSignal.timeout wiring
		// can abort a body that stops flowing.
		this.timeout(10000);
		await withFetch(
			async (_url, init) => {
				const signal = init?.signal;
				const encoder = new TextEncoder();
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						// One delta arrives, then the body stalls forever. Like a real
						// fetch, the body stream errors when the request signal aborts.
						controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
						signal?.addEventListener("abort", () => controller.error(signal.reason ?? new Error("aborted")));
					},
				});
				return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
			},
			() =>
				withConfig({ "chat.timeout": 1000 }, async () => {
					const client = new ChatClient({ userAgent: "test-agent" });

					const token = new vscode.CancellationTokenSource().token;
					const startedAt = Date.now();
					await assert.rejects(
						client.send({ model, messages, options, progress: collector().progress, token }),
						/chat\.timeout/
					);
					assert.ok(
						Date.now() - startedAt >= 900,
						"the abort must come from the whole-call timeout, not an early transport failure"
					);
				})
		);
	});
});
