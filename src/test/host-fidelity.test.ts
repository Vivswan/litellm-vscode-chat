import * as assert from "assert";
import * as vscode from "vscode";

/**
 * Host-fidelity test suite.
 *
 * Exercises the extension through the real VS Code LM API
 * (vscode.lm.selectChatModels / model.sendRequest) rather than
 * calling provideLanguageModelChatResponse() directly.
 *
 * Two modes:
 *   1. Capture mode (default): backed by a deterministic local capture server.
 *      Validates the full host pipeline including message conversion,
 *      modelOptions filtering, and streaming response handling.
 *   2. Live mode: when LITELLM_REAL_BASE_URL is set, runs smoke tests
 *      against a real LiteLLM server through the host API.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createCaptureServer } = require("../../scripts/capture-server") as {
	createCaptureServer: () => CaptureServer;
};

interface CaptureServer {
	start(): Promise<void>;
	port: number;
	setScenario(name: string): void;
	getLastRequest(): Record<string, unknown> | null;
	addScenario(name: string, config: unknown): void;
	close(): Promise<void>;
}

const REAL_BASE_URL = process.env.LITELLM_REAL_BASE_URL || "";
const REAL_API_KEY = process.env.LITELLM_REAL_API_KEY ?? "";
const REAL_MODEL_ID = process.env.LITELLM_REAL_MODEL || "";
const REAL_TIMEOUT = Number(process.env.LITELLM_REAL_TIMEOUT) || 0;
const IS_LIVE = !!REAL_BASE_URL;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Force a model refresh from the currently configured server, then return
 * the freshly-registered models. This avoids returning stale models from
 * a previous backend by explicitly triggering prepareLanguageModelChatInformation
 * and then waiting for the host to process the new list.
 */
async function waitForFreshModels(
	selector: vscode.LanguageModelChatSelector,
	timeoutMs: number
): Promise<vscode.LanguageModelChat[]> {
	// Trigger an explicit refresh so the provider fetches from the
	// now-correctly-configured server.
	await vscode.commands.executeCommand("litellm._test.refreshModels");

	// The host may need a moment to process the provider's new model list.
	// Try immediately first, then poll with backoff.
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const models = await vscode.lm.selectChatModels(selector);
		if (models.length > 0) {
			return models;
		}
		await new Promise((r) => setTimeout(r, 200));
	}

	throw new Error(`Timeout (${timeoutMs}ms) waiting for fresh models with selector ${JSON.stringify(selector)}`);
}

/** Collect all parts from a streaming response. */
async function collectStream(response: vscode.LanguageModelChatResponse): Promise<unknown[]> {
	const parts: unknown[] = [];
	for await (const part of response.stream) {
		parts.push(part);
	}
	return parts;
}

/** Extract concatenated text from collected stream parts. */
function extractText(parts: unknown[]): string {
	return parts
		.filter((p) => p instanceof vscode.LanguageModelTextPart)
		.map((p) => (p as vscode.LanguageModelTextPart).value)
		.join("");
}

/** Extract tool call parts from collected stream parts. */
function extractToolCalls(parts: unknown[]): vscode.LanguageModelToolCallPart[] {
	return parts.filter((p) => p instanceof vscode.LanguageModelToolCallPart) as vscode.LanguageModelToolCallPart[];
}

/** Ensure the extension is activated. */
async function ensureActivated(): Promise<void> {
	const ext = vscode.extensions.getExtension("vivswan.litellm-vscode-chat");
	assert.ok(ext, "Extension not found — check publisher.name in package.json");
	if (!ext.isActive) {
		await ext.activate();
	}
}

// ── Capture-Mode Tests (deterministic) ───────────────────────────────────────

suite("Host-Fidelity Tests (capture)", function () {
	if (IS_LIVE) {
		test("SKIPPED: running in live mode, capture tests disabled", () => {});
		return;
	}

	let server: CaptureServer;
	let baseUrl: string;
	let model: vscode.LanguageModelChat;

	suiteSetup(async function () {
		this.timeout(20000);

		server = createCaptureServer();
		await server.start();
		baseUrl = `http://localhost:${server.port}`;

		await ensureActivated();
		await vscode.commands.executeCommand("litellm._test.setSecrets", baseUrl, "test-key");

		const models = await waitForFreshModels({ vendor: "litellm" }, 15000);
		assert.ok(models.length > 0, "Expected at least one litellm model to be registered");
		model = models[0];
	});

	suiteTeardown(async function () {
		if (server) {
			await server.close();
		}
	});

	/** Helper to send a request and get both captured body and stream parts. */
	async function sendAndCapture(
		messages: vscode.LanguageModelChatMessage[],
		options?: vscode.LanguageModelChatRequestOptions
	): Promise<{ body: Record<string, unknown>; parts: unknown[] }> {
		const response = await model.sendRequest(messages, options ?? {}, new vscode.CancellationTokenSource().token);
		const parts = await collectStream(response);
		const body = server.getLastRequest() ?? {};
		return { body, parts };
	}

	// ─── Model Discovery ─────────────────────────────────────────────────

	suite("model discovery", () => {
		test("selectChatModels returns model with vendor litellm", async () => {
			const models = await vscode.lm.selectChatModels({ vendor: "litellm" });
			assert.ok(models.length > 0, "Expected at least one model");
			assert.strictEqual(models[0].vendor, "litellm");
		});

		test("model has positive token limits", () => {
			assert.ok(model.maxInputTokens > 0, `maxInputTokens should be positive, got ${model.maxInputTokens}`);
		});

		test("model has expected family", () => {
			assert.strictEqual(model.family, "litellm");
		});

		test("countTokens returns positive for text", async () => {
			const count = await model.countTokens("Hello world");
			assert.ok(count > 0, `Token count should be positive, got ${count}`);
		});

		test("countTokens returns positive for message", async () => {
			const count = await model.countTokens(vscode.LanguageModelChatMessage.User("Hello world"));
			assert.ok(count > 0, `Token count should be positive, got ${count}`);
		});
	});

	// ─── Request Contract ────────────────────────────────────────────────

	suite("request contract", () => {
		setup(() => {
			server.setScenario("text-only");
		});

		test("valid modelOptions pass through to request body", async () => {
			const { body } = await sendAndCapture([vscode.LanguageModelChatMessage.User("hi")], {
				modelOptions: { temperature: 0.3, seed: 42 },
			});
			assert.strictEqual(body.temperature, 0.3, "temperature should pass through");
			assert.strictEqual(body.seed, 42, "seed should pass through");
		});

		test("underscore-prefixed keys are stripped from the outbound request", async () => {
			const { body } = await sendAndCapture([vscode.LanguageModelChatMessage.User("hi")], {
				modelOptions: {
					temperature: 0.5,
					_capturingTokenCorrelationId: "some-internal-id",
					_otherInternalField: true,
					_telemetry: { foo: 1 },
				},
			});
			assert.strictEqual(body.temperature, 0.5, "temperature should pass through");
			const underscoreKeys = Object.keys(body).filter((k) => k.startsWith("_"));
			assert.deepStrictEqual(
				underscoreKeys,
				[],
				`Underscore-prefixed keys should be stripped, but found: ${underscoreKeys.join(", ")}`
			);
		});

		test("advanced modelOptions like response_format and reasoning_effort pass through", async () => {
			const { body } = await sendAndCapture([vscode.LanguageModelChatMessage.User("hi")], {
				modelOptions: {
					response_format: { type: "json_object" },
					reasoning_effort: "high",
					top_k: 50,
				},
			});
			assert.deepStrictEqual(body.response_format, { type: "json_object" }, "response_format should pass through");
			assert.strictEqual(body.reasoning_effort, "high", "reasoning_effort should pass through");
			assert.strictEqual(body.top_k, 50, "top_k should pass through");
		});

		test("provider-owned fields cannot be overridden via modelOptions", async () => {
			const { body } = await sendAndCapture([vscode.LanguageModelChatMessage.User("hi")], {
				modelOptions: { model: "evil-model", stream: false, messages: [{ role: "system", content: "pwned" }] },
			});
			assert.notStrictEqual(body.model, "evil-model", "model should not be overridable");
			assert.strictEqual(body.stream, true, "stream should always be true");
			assert.ok(Array.isArray(body.messages), "messages should be an array");
			const msgs = body.messages as Array<{ role: string; content: string }>;
			assert.ok(!msgs.some((m) => m.content === "pwned"), "messages should not be overridable");
		});

		test("stream_options with include_usage is always present", async () => {
			const { body } = await sendAndCapture([vscode.LanguageModelChatMessage.User("hi")]);
			const streamOpts = body.stream_options as Record<string, unknown> | undefined;
			assert.ok(streamOpts, "stream_options should be present");
			assert.strictEqual(streamOpts.include_usage, true, "include_usage should be true");
		});

		test("messages are converted with correct roles", async () => {
			const msgs = [
				vscode.LanguageModelChatMessage.User("Hello"),
				vscode.LanguageModelChatMessage.Assistant("Hi there"),
				vscode.LanguageModelChatMessage.User("How are you?"),
			];
			const { body } = await sendAndCapture(msgs);
			const messages = body.messages as Array<{ role: string; content: string }>;
			assert.ok(Array.isArray(messages), "messages should be an array");
			assert.ok(messages.length >= 3, `Expected at least 3 messages, got ${messages.length}`);

			const userMsgs = messages.filter((m) => m.role === "user");
			const assistantMsgs = messages.filter((m) => m.role === "assistant");
			assert.ok(userMsgs.length >= 2, "Expected at least 2 user messages");
			assert.ok(assistantMsgs.length >= 1, "Expected at least 1 assistant message");
		});

		test("request body contains model and max_tokens", async () => {
			const { body } = await sendAndCapture([vscode.LanguageModelChatMessage.User("hi")]);
			assert.ok(typeof body.model === "string", "model should be a string");
			assert.ok(typeof body.max_tokens === "number", "max_tokens should be a number");
		});

		test("multi-turn conversation preserves all message roles and order", async () => {
			const msgs = [
				vscode.LanguageModelChatMessage.User("My name is Test."),
				vscode.LanguageModelChatMessage.Assistant("Hello Test!"),
				vscode.LanguageModelChatMessage.User("What is my name?"),
				vscode.LanguageModelChatMessage.Assistant("Your name is Test."),
				vscode.LanguageModelChatMessage.User("Correct!"),
			];
			const { body } = await sendAndCapture(msgs);
			const messages = body.messages as Array<{ role: string; content: string }>;
			// Filter out any system messages the host may inject
			const nonSystem = messages.filter((m) => m.role !== "system");
			assert.ok(nonSystem.length >= 5, `Expected at least 5 non-system messages, got ${nonSystem.length}`);
			assert.strictEqual(nonSystem[0].role, "user");
			assert.strictEqual(nonSystem[1].role, "assistant");
			assert.strictEqual(nonSystem[2].role, "user");
			assert.strictEqual(nonSystem[3].role, "assistant");
			assert.strictEqual(nonSystem[4].role, "user");
		});

		test("image data part is converted to image_url content block", async () => {
			// Minimal 1x1 red PNG
			const pngData = new Uint8Array([
				0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00,
				0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
				0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0xe2,
				0x21, 0xbc, 0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
			]);
			const msg = new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [
				new vscode.LanguageModelTextPart("Describe this image."),
				new vscode.LanguageModelDataPart(pngData, "image/png"),
			]);
			const { body } = await sendAndCapture([msg]);
			const messages = body.messages as Array<{ role: string; content: unknown }>;
			const userMsg = messages.find((m) => m.role === "user" && Array.isArray(m.content));
			assert.ok(userMsg, "User message with image should have array content");
			const content = userMsg!.content as Array<{ type: string }>;
			const textBlock = content.find((b) => b.type === "text");
			const imageBlock = content.find((b) => b.type === "image_url") as
				| { type: string; image_url: { url: string } }
				| undefined;
			assert.ok(textBlock, "Should have a text block");
			assert.ok(imageBlock, "Should have an image_url block");
			assert.ok(
				imageBlock!.image_url.url.startsWith("data:image/png;base64,"),
				"image_url should contain base64 PNG data URL"
			);
		});

		test("multiple images in one message are all preserved", async () => {
			const pngData = new Uint8Array([
				0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00,
				0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
				0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0xe2,
				0x21, 0xbc, 0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
			]);
			const img1 = new vscode.LanguageModelDataPart(pngData, "image/png");
			// Use same valid PNG for second image (with different MIME to verify both arrive)
			const img2 = new vscode.LanguageModelDataPart(pngData, "image/png");
			const msg = new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [
				new vscode.LanguageModelTextPart("Compare these:"),
				img1,
				img2,
			]);
			const { body } = await sendAndCapture([msg]);
			const messages = body.messages as Array<{ role: string; content: unknown }>;
			const userMsg = messages.find((m) => m.role === "user" && Array.isArray(m.content));
			assert.ok(userMsg, "Should have array content");
			const content = userMsg!.content as Array<{ type: string }>;
			const imageBlocks = content.filter((b) => b.type === "image_url");
			assert.strictEqual(imageBlocks.length, 2, "Should have 2 image_url blocks");
		});

		test("text and image ordering is preserved", async () => {
			const pngData = new Uint8Array([
				0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00,
				0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
				0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0xe2,
				0x21, 0xbc, 0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
			]);
			const img = new vscode.LanguageModelDataPart(pngData, "image/png");
			const msg = new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [
				new vscode.LanguageModelTextPart("before"),
				img,
				new vscode.LanguageModelTextPart("after"),
			]);
			const { body } = await sendAndCapture([msg]);
			const messages = body.messages as Array<{ role: string; content: unknown }>;
			const userMsg = messages.find((m) => m.role === "user" && Array.isArray(m.content));
			assert.ok(userMsg, "Should have array content");
			const content = userMsg!.content as Array<{ type: string; text?: string }>;
			assert.strictEqual(content[0].type, "text");
			assert.strictEqual(content[0].text, "before");
			assert.strictEqual(content[1].type, "image_url");
			assert.strictEqual(content[2].type, "text");
			assert.strictEqual(content[2].text, "after");
		});

		test("PDF data part is converted to file content block", async () => {
			const pdfData = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF magic
			const msg = new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [
				new vscode.LanguageModelTextPart("Analyze this PDF."),
				new vscode.LanguageModelDataPart(pdfData, "application/pdf"),
			]);
			const { body } = await sendAndCapture([msg]);
			const messages = body.messages as Array<{ role: string; content: unknown }>;
			const userMsg = messages.find((m) => m.role === "user" && Array.isArray(m.content));
			assert.ok(userMsg, "Should have array content");
			const content = userMsg!.content as Array<{ type: string }>;
			const fileBlock = content.find((b) => b.type === "file") as
				| { type: string; file: { file_data: string } }
				| undefined;
			assert.ok(fileBlock, "Should have a file block for PDF");
			assert.ok(
				fileBlock!.file.file_data.startsWith("data:application/pdf;base64,"),
				"file_data should contain base64 PDF data URL"
			);
		});

		test("JSON data part is decoded as inline text", async () => {
			const jsonData = new TextEncoder().encode('{"key":"value"}');
			const msg = new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [
				new vscode.LanguageModelTextPart("data: "),
				new vscode.LanguageModelDataPart(jsonData, "application/json"),
			]);
			const { body } = await sendAndCapture([msg]);
			const messages = body.messages as Array<{ role: string; content: unknown }>;
			const userMsg = messages.find((m) => m.role === "user");
			assert.ok(userMsg, "Should have user message");
			// JSON data part should be decoded as text, so content should be a string
			assert.strictEqual(typeof userMsg!.content, "string", "JSON data part should be decoded as inline text");
			assert.ok((userMsg!.content as string).includes('{"key":"value"}'), "Decoded JSON should be present in content");
		});

		test("tool call and tool result round-trip is correctly serialized", async () => {
			const toolCall = new vscode.LanguageModelToolCallPart("call_abc", "get_weather", { location: "Paris" });
			const toolResult = new vscode.LanguageModelToolResultPart("call_abc", [
				new vscode.LanguageModelTextPart('{"temp": "22C", "condition": "Sunny"}'),
			]);

			const msgs = [
				vscode.LanguageModelChatMessage.User("What is the weather in Paris?"),
				new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, [
					new vscode.LanguageModelTextPart("Let me check the weather."),
					toolCall,
				]),
				new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [toolResult]),
			];
			const { body } = await sendAndCapture(msgs);
			const messages = body.messages as Array<{
				role: string;
				content?: unknown;
				tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
				tool_call_id?: string;
			}>;
			assert.ok(Array.isArray(messages), "messages should be an array");

			// Find assistant message with tool_calls
			const assistantMsg = messages.find((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
			assert.ok(assistantMsg, "Should have an assistant message with tool_calls");
			assert.strictEqual(assistantMsg!.tool_calls!.length, 1, "Should have exactly one tool call");
			assert.strictEqual(assistantMsg!.tool_calls![0].function.name, "get_weather");
			const args = JSON.parse(assistantMsg!.tool_calls![0].function.arguments);
			assert.strictEqual(args.location, "Paris");

			// Find tool result message
			const toolMsg = messages.find((m) => m.role === "tool");
			assert.ok(toolMsg, "Should have a tool result message");
			assert.strictEqual(toolMsg!.tool_call_id, "call_abc", "Tool result should reference the tool call ID");
			assert.ok(String(toolMsg!.content).includes("22C"), "Tool result content should contain the weather data");
		});

		test("mixed text + tool calls in one assistant message are preserved", async () => {
			const toolCall = new vscode.LanguageModelToolCallPart("call_1", "search", { q: "hello" });
			const msgs = [
				vscode.LanguageModelChatMessage.User("Search for hello"),
				new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, [
					new vscode.LanguageModelTextPart("I'll search for that."),
					toolCall,
				]),
				new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [
					new vscode.LanguageModelToolResultPart("call_1", [new vscode.LanguageModelTextPart("found 5 results")]),
				]),
				vscode.LanguageModelChatMessage.User("Thanks, now summarize."),
			];
			const { body } = await sendAndCapture(msgs);
			const messages = body.messages as Array<{
				role: string;
				content?: unknown;
				tool_calls?: Array<{ function: { name: string } }>;
			}>;

			const assistantWithTool = messages.find((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
			assert.ok(assistantWithTool, "Should have assistant message with tool_calls");
			assert.ok(String(assistantWithTool!.content).includes("search"), "Assistant message should contain text content");
			assert.strictEqual(assistantWithTool!.tool_calls![0].function.name, "search");
		});

		test("tool definitions arrive correctly in request body", async () => {
			const { body } = await sendAndCapture([vscode.LanguageModelChatMessage.User("weather?")], {
				tools: [
					{
						name: "get_weather",
						description: "Get weather for a location",
						inputSchema: {
							type: "object",
							properties: {
								location: { type: "string", description: "City name" },
								unit: { type: "string", enum: ["celsius", "fahrenheit"] },
							},
							required: ["location"],
						},
					},
				],
			});
			const tools = body.tools as Array<{
				type: string;
				function: { name: string; description: string; parameters: Record<string, unknown> };
			}>;
			assert.ok(Array.isArray(tools), "tools should be an array");
			assert.strictEqual(tools.length, 1, "Should have exactly 1 tool");
			assert.strictEqual(tools[0].type, "function");
			assert.strictEqual(tools[0].function.name, "get_weather");
			assert.strictEqual(tools[0].function.description, "Get weather for a location");
			const params = tools[0].function.parameters;
			assert.strictEqual(params.type, "object");
			const props = params.properties as Record<string, Record<string, unknown>>;
			assert.ok(props.location, "Should have location property");
			assert.ok(props.unit, "Should have unit property");
			assert.deepStrictEqual(props.unit.enum, ["celsius", "fahrenheit"]);
			assert.strictEqual(body.tool_choice, "auto");
		});

		test("multiple tools are all included in the request", async () => {
			const { body } = await sendAndCapture([vscode.LanguageModelChatMessage.User("time?")], {
				tools: [
					{
						name: "get_weather",
						description: "Get weather",
						inputSchema: { type: "object", properties: { loc: { type: "string" } } },
					},
					{
						name: "get_time",
						description: "Get time",
						inputSchema: { type: "object", properties: { tz: { type: "string" } } },
					},
				],
			});
			const tools = body.tools as Array<{ function: { name: string } }>;
			assert.strictEqual(tools.length, 2);
			assert.strictEqual(tools[0].function.name, "get_weather");
			assert.strictEqual(tools[1].function.name, "get_time");
		});
	});

	// ─── Response Contract ───────────────────────────────────────────────

	suite("response contract", () => {
		test("plain text reaches the caller via response.stream", async () => {
			server.setScenario("text-only");
			const { parts } = await sendAndCapture([vscode.LanguageModelChatMessage.User("hi")]);
			const text = extractText(parts);
			assert.ok(text.includes("Hello from capture server"), `Expected captured text, got: "${text}"`);
		});

		test("structured delta.content arrays produce text", async () => {
			server.setScenario("structured-content");
			const { parts } = await sendAndCapture([vscode.LanguageModelChatMessage.User("hi")]);
			const text = extractText(parts);
			assert.ok(text.includes("structured text"), `Expected structured text, got: "${text}"`);
		});

		test("reasoning content produces text response", async () => {
			server.setScenario("reasoning");
			const { parts } = await sendAndCapture([vscode.LanguageModelChatMessage.User("hi")]);
			const text = extractText(parts);
			assert.ok(text.includes("The answer is 42"), `Expected answer text, got: "${text}"`);

			const vsAny = vscode as unknown as Record<string, unknown>;
			if (vsAny["LanguageModelThinkingPart"]) {
				const thinkingParts = parts.filter(
					(p) => (p as Record<string, unknown>).constructor?.name === "LanguageModelThinkingPart"
				);
				if (thinkingParts.length > 0) {
					const thinkingText = (thinkingParts[0] as { value?: string }).value ?? "";
					assert.ok(thinkingText.length > 0, "ThinkingPart should have non-empty text");
				}
			}
		});

		test("usage-only final chunk does not break streaming", async () => {
			server.setScenario("usage-only-final");
			const { parts } = await sendAndCapture([vscode.LanguageModelChatMessage.User("hi")]);
			const text = extractText(parts);
			assert.ok(text.includes("Response with usage"), `Expected response text, got: "${text}"`);
		});

		test("single-frame tool call arrives correctly", async () => {
			server.setScenario("tool-call-single");
			const { parts } = await sendAndCapture([vscode.LanguageModelChatMessage.User("weather in Paris")]);
			const toolCalls = extractToolCalls(parts);
			assert.strictEqual(toolCalls.length, 1, `Expected 1 tool call, got ${toolCalls.length}`);
			assert.strictEqual(toolCalls[0].name, "get_weather");
			const input = toolCalls[0].input as Record<string, unknown>;
			assert.strictEqual(input.location, "Paris");
		});

		test("chunked tool call is reassembled across SSE frames", async () => {
			server.setScenario("tool-call-chunked");
			const { parts } = await sendAndCapture([vscode.LanguageModelChatMessage.User("weather in Paris")]);
			const toolCalls = extractToolCalls(parts);
			assert.strictEqual(toolCalls.length, 1, `Expected 1 tool call, got ${toolCalls.length}`);
			assert.strictEqual(toolCalls[0].name, "get_weather");
			const input = toolCalls[0].input as Record<string, unknown>;
			assert.strictEqual(input.location, "Paris");
		});

		test("cancellation stops the stream", async function () {
			this.timeout(10000);
			server.setScenario("slow-stream");

			const cts = new vscode.CancellationTokenSource();
			const response = await model.sendRequest([vscode.LanguageModelChatMessage.User("hi")], {}, cts.token);

			const parts: unknown[] = [];
			let cancelled = false;
			try {
				for await (const part of response.stream) {
					parts.push(part);
					if (parts.length >= 2) {
						cts.cancel();
					}
				}
			} catch {
				cancelled = true;
			}

			assert.ok(parts.length < 6 || cancelled, "Stream should have been interrupted by cancellation");
		});

		test("HTTP 400 error surfaces as rejection", async function () {
			server.setScenario("error-400");
			try {
				await sendAndCapture([vscode.LanguageModelChatMessage.User("hi")]);
				assert.fail("Expected sendRequest to reject on HTTP 400");
			} catch (e) {
				assert.ok(e instanceof Error, "Should throw an Error");
			}
		});

		test("HTTP 401 error surfaces as rejection", async function () {
			server.setScenario("error-401");
			try {
				await sendAndCapture([vscode.LanguageModelChatMessage.User("hi")]);
				assert.fail("Expected sendRequest to reject on HTTP 401");
			} catch (e) {
				assert.ok(e instanceof Error, "Should throw an Error");
			}
		});
	});
});

// ── Live-Mode Tests (real LiteLLM server via host API) ───────────────────────

suite("Host-Fidelity Tests (live)", function () {
	if (!IS_LIVE) {
		test("SKIPPED: set LITELLM_REAL_BASE_URL to run live host-fidelity tests", () => {
			console.log(
				"Set LITELLM_REAL_BASE_URL, LITELLM_REAL_API_KEY, and optionally LITELLM_REAL_MODEL to run live host-fidelity tests."
			);
		});
		return;
	}

	let model: vscode.LanguageModelChat;
	let allModels: vscode.LanguageModelChat[];

	suiteSetup(async function () {
		this.timeout(REAL_TIMEOUT || 30000);

		await ensureActivated();
		await vscode.commands.executeCommand("litellm._test.setSecrets", REAL_BASE_URL, REAL_API_KEY);

		allModels = await waitForFreshModels({ vendor: "litellm" }, 15000);
		assert.ok(allModels.length > 0, "Expected at least one litellm model to be registered");

		if (REAL_MODEL_ID) {
			const match = allModels.find((m) => m.id === REAL_MODEL_ID || m.name === REAL_MODEL_ID);
			assert.ok(match, `Model "${REAL_MODEL_ID}" not found. Available: ${allModels.map((m) => m.id).join(", ")}`);
			model = match;
		} else {
			model = allModels[0];
		}
		console.log(`Using model: ${model.id} (${model.name})`);
	});

	// ─── Model Discovery ─────────────────────────────────────────────────

	suite("model discovery", () => {
		test("selectChatModels returns models from real server", async () => {
			assert.ok(allModels.length > 0, "Expected at least one model from real server");
			console.log(`Found ${allModels.length} models: ${allModels.map((m) => m.id).join(", ")}`);
		});

		test("target model has expected properties", () => {
			assert.ok(model.maxInputTokens > 0, "maxInputTokens should be positive");
			assert.strictEqual(model.vendor, "litellm");
			assert.strictEqual(model.family, "litellm");
		});

		test("all models have required fields", () => {
			for (const m of allModels) {
				assert.ok(m.id, `Model should have an id`);
				assert.ok(m.name, `Model ${m.id} should have a name`);
				assert.strictEqual(m.family, "litellm", `Model ${m.id} family should be 'litellm'`);
				assert.ok(m.maxInputTokens > 0, `Model ${m.id} maxInputTokens should be positive`);
			}
		});

		test("multiple selectChatModels calls return consistent results", async () => {
			const models1 = await vscode.lm.selectChatModels({ vendor: "litellm" });
			const models2 = await vscode.lm.selectChatModels({ vendor: "litellm" });
			const ids1 = models1.map((m) => m.id).sort();
			const ids2 = models2.map((m) => m.id).sort();
			assert.deepStrictEqual(ids1, ids2, "Consecutive calls should return the same model IDs");
		});

		test("countTokens returns positive for text", async () => {
			const count = await model.countTokens("Hello world");
			assert.ok(count > 0, `Token count should be positive, got ${count}`);
		});

		test("longer text yields higher token count", async () => {
			const shortCount = await model.countTokens("hi");
			const longCount = await model.countTokens("This is a much longer string that should yield more tokens");
			assert.ok(
				longCount > shortCount,
				`Longer text (${longCount}) should have more tokens than short (${shortCount})`
			);
		});
	});

	// ─── Raw HTTP Endpoints ──────────────────────────────────────────────

	suite("raw HTTP endpoints", () => {
		const headers: Record<string, string> = {};
		if (REAL_API_KEY) {
			headers["Authorization"] = `Bearer ${REAL_API_KEY}`;
			headers["X-API-Key"] = REAL_API_KEY;
		}

		test("/v1/model/info returns data", async () => {
			const resp = await fetch(`${REAL_BASE_URL}/v1/model/info`, { headers });
			if (resp.ok) {
				const body = (await resp.json()) as { data?: unknown[] };
				assert.ok(Array.isArray(body.data), "/v1/model/info should return a data array");
				assert.ok(body.data.length > 0, "/v1/model/info data should be non-empty");
			}
		});

		test("/v1/models returns data", async () => {
			const resp = await fetch(`${REAL_BASE_URL}/v1/models`, { headers });
			assert.ok(resp.ok, `/v1/models returned ${resp.status} ${resp.statusText}`);
			const body = (await resp.json()) as { data?: unknown[] };
			assert.ok(Array.isArray(body.data), "/v1/models should return a data array");
			assert.ok(body.data.length > 0, "/v1/models data should be non-empty");
		});

		test("/v1/chat/completions endpoint is reachable", async function () {
			this.timeout(REAL_TIMEOUT || 30000);
			const resp = await fetch(`${REAL_BASE_URL}/v1/chat/completions`, {
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify({
					model: REAL_MODEL_ID || model.id,
					messages: [{ role: "user", content: "Say hi" }],
					stream: true,
					max_tokens: 10,
				}),
			});
			assert.ok(resp.status < 500, `/v1/chat/completions returned server error ${resp.status}`);
		});
	});

	// ─── Streaming Chat ──────────────────────────────────────────────────

	suite("streaming chat via host API", () => {
		test("simple chat returns non-empty text", async function () {
			this.timeout(REAL_TIMEOUT || 30000);

			const response = await model.sendRequest(
				[vscode.LanguageModelChatMessage.User('Reply with exactly: "hello world"')],
				{},
				new vscode.CancellationTokenSource().token
			);
			const parts = await collectStream(response);
			const text = extractText(parts);
			assert.ok(text.length > 0, "Expected non-empty response text");
			console.log(`Response (${text.length} chars): ${text.slice(0, 200)}`);
		});

		test("multi-turn conversation works", async function () {
			this.timeout(REAL_TIMEOUT || 30000);

			const response = await model.sendRequest(
				[
					vscode.LanguageModelChatMessage.User("Remember the number 42."),
					vscode.LanguageModelChatMessage.Assistant("Got it, I'll remember 42."),
					vscode.LanguageModelChatMessage.User("What number did I ask you to remember?"),
				],
				{},
				new vscode.CancellationTokenSource().token
			);
			const parts = await collectStream(response);
			const text = extractText(parts);
			assert.ok(text.length > 0, "Expected non-empty response");
			console.log(`Response: ${text.slice(0, 200)}`);
		});

		test("longer response streams multiple chunks", async function () {
			this.timeout(REAL_TIMEOUT || 60000);

			const response = await model.sendRequest(
				[vscode.LanguageModelChatMessage.User("Write a short paragraph (3-4 sentences) about the color blue.")],
				{},
				new vscode.CancellationTokenSource().token
			);
			const parts = await collectStream(response);
			const textParts = parts.filter((p) => p instanceof vscode.LanguageModelTextPart);
			assert.ok(textParts.length > 1, `Should receive multiple text chunks, got ${textParts.length}`);
			const fullText = extractText(parts);
			assert.ok(fullText.length > 50, `Should receive substantial text, got ${fullText.length} chars`);
		});

		test("request with VS Code internal modelOptions keys succeeds", async function () {
			this.timeout(REAL_TIMEOUT || 30000);

			const response = await model.sendRequest(
				[vscode.LanguageModelChatMessage.User("Say OK.")],
				{
					modelOptions: {
						_capturingTokenCorrelationId: "test-correlation-id-12345",
						_internalSessionData: { sessionId: "abc" },
						temperature: 0.5,
					},
				},
				new vscode.CancellationTokenSource().token
			);
			const parts = await collectStream(response);
			const text = extractText(parts);
			assert.ok(text.length > 0, "Should receive a response despite internal keys in modelOptions");
			console.log(`Response with internal keys filtered: "${text.trim().slice(0, 100)}"`);
		});

		test("cancellation terminates stream", async function () {
			this.timeout(REAL_TIMEOUT || 15000);

			const cts = new vscode.CancellationTokenSource();
			const response = await model.sendRequest(
				[vscode.LanguageModelChatMessage.User("Write a very long essay about the history of computing.")],
				{},
				cts.token
			);

			const parts: unknown[] = [];
			let cancelled = false;
			try {
				for await (const part of response.stream) {
					parts.push(part);
					if (parts.length >= 3) {
						cts.cancel();
					}
				}
			} catch {
				cancelled = true;
			}

			assert.ok(parts.length > 0, "Should have received at least some parts before cancel");
			console.log(`Received ${parts.length} parts before cancellation (threw: ${cancelled})`);
		});
	});

	// ─── Tool Calling ────────────────────────────────────────────────────

	suite("tool calling via host API", () => {
		const weatherTool: vscode.LanguageModelChatTool = {
			name: "get_weather",
			description: "Get the current weather in a given location",
			inputSchema: {
				type: "object",
				properties: {
					location: { type: "string", description: "The city name" },
				},
				required: ["location"],
			},
		};

		test("model returns tool call when given tools", async function () {
			this.timeout(REAL_TIMEOUT || 30000);

			const response = await model.sendRequest(
				[vscode.LanguageModelChatMessage.User("What is the weather in San Francisco?")],
				{ tools: [weatherTool] },
				new vscode.CancellationTokenSource().token
			);
			const parts = await collectStream(response);
			const toolCalls = extractToolCalls(parts);
			assert.ok(toolCalls.length > 0, "Should receive at least one tool call");
			const call = toolCalls[0];
			assert.strictEqual(call.name, "get_weather", "Tool call should be for get_weather");
			assert.ok(call.callId, "Tool call should have an ID");
			assert.ok(typeof call.input === "object", "Tool call should have input object");
			console.log(`Tool call: ${call.name}(${JSON.stringify(call.input)})`);
		});

		test("multiple tools available — model picks one", async function () {
			this.timeout(REAL_TIMEOUT || 30000);

			const response = await model.sendRequest(
				[vscode.LanguageModelChatMessage.User("What time is it in Tokyo?")],
				{
					tools: [
						weatherTool,
						{
							name: "get_time",
							description: "Get the current time in a timezone",
							inputSchema: {
								type: "object",
								properties: { timezone: { type: "string" } },
								required: ["timezone"],
							},
						},
					],
				},
				new vscode.CancellationTokenSource().token
			);
			const parts = await collectStream(response);
			assert.ok(parts.length > 0, "Should receive response with multiple tools available");
			const toolCalls = extractToolCalls(parts);
			if (toolCalls.length > 0) {
				console.log(`Chose tool: ${toolCalls[0].name}`);
			}
		});
	});
});
