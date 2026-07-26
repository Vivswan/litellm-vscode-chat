import * as assert from "node:assert";
import * as vscode from "vscode";
import { ChatClient } from "../../provider/chatClient";
import { withFetch } from "../testUtils";

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
} as unknown as vscode.LanguageModelChatInformation;

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

suite("provider/chatClient", () => {
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
				client.setServerProvider(() =>
					Promise.resolve([{ id: "srv1", label: "Default", baseUrl: "http://litellm.test", apiKey: "k" }])
				);

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
				client.setServerProvider(() =>
					Promise.resolve([{ id: "srv1", label: "Default", baseUrl: "http://litellm.test", apiKey: "k" }])
				);

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

	test("request timeout surfaces an actionable error naming the requestTimeout setting", async () => {
		await withFetch(
			async () => {
				throw new DOMException("The operation timed out.", "TimeoutError");
			},
			async () => {
				const client = new ChatClient({ userAgent: "test-agent" });
				client.setServerProvider(() =>
					Promise.resolve([{ id: "srv1", label: "Default", baseUrl: "http://litellm.test", apiKey: "k" }])
				);

				const token = new vscode.CancellationTokenSource().token;
				await assert.rejects(
					client.send({ model, messages, options, progress: collector().progress, token }),
					/requestTimeout/
				);
			}
		);
	});
});
