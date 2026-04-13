import * as assert from "assert";
import * as vscode from "vscode";
import { LiteLLMChatModelProvider } from "../provider";
import { convertMessages, convertTools, validateRequest, tryParseJSONObject } from "../utils";

/**
 * Full integration test suite against a real LiteLLM server.
 *
 * Required env vars (set by scripts/real-test.js):
 *   LITELLM_REAL_BASE_URL - e.g. http://localhost:4000
 *   LITELLM_REAL_API_KEY  - API key or empty string
 *   LITELLM_REAL_MODEL    - model ID to test (e.g. gpt-4o-mini:cheapest)
 */

const BASE_URL = process.env.LITELLM_REAL_BASE_URL;
const API_KEY = process.env.LITELLM_REAL_API_KEY ?? "";
const MODEL_ID = process.env.LITELLM_REAL_MODEL;
const TEST_TIMEOUT = Number(process.env.LITELLM_REAL_TIMEOUT) || 0;

interface OpenAIToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}
interface ConvertedMessage {
	role: "user" | "assistant" | "tool" | "system";
	content?: string | Array<{ type: string }>;
	name?: string;
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
}

function makeSecretStorage(baseUrl: string, apiKey: string): vscode.SecretStorage {
	const store: Record<string, string> = {
		"litellm.baseUrl": baseUrl,
		"litellm.apiKey": apiKey,
	};
	return {
		get: async (key: string) => store[key],
		store: async (key: string, value: string) => {
			store[key] = value;
		},
		delete: async (key: string) => {
			delete store[key];
		},
		onDidChange: (_listener: unknown) => ({ dispose() {} }),
	} as unknown as vscode.SecretStorage;
}

function makeProvider(baseUrl: string, apiKey: string, outputChannel?: vscode.OutputChannel): LiteLLMChatModelProvider {
	return new LiteLLMChatModelProvider(makeSecretStorage(baseUrl, apiKey), "RealTest/1.0 VSCode/test", outputChannel);
}

/** Helper: fetch models and find the target model, asserting it exists. */
async function getTargetModel(
	provider: LiteLLMChatModelProvider,
	targetModelId: string
): Promise<vscode.LanguageModelChatInformation> {
	const infos = await provider.prepareLanguageModelChatInformation(
		{ silent: true },
		new vscode.CancellationTokenSource().token
	);
	const model = infos.find((i) => i.id === targetModelId);
	assert.ok(model, `Model "${targetModelId}" not found. Available IDs:\n  ${infos.map((i) => i.id).join("\n  ")}`);
	return model;
}

/** Helper: run a chat completion and collect all streamed parts. */
async function runChat(
	provider: LiteLLMChatModelProvider,
	model: vscode.LanguageModelChatInformation,
	messages: vscode.LanguageModelChatMessage[],
	options?: Partial<vscode.ProvideLanguageModelChatResponseOptions>
): Promise<vscode.LanguageModelResponsePart[]> {
	const parts: vscode.LanguageModelResponsePart[] = [];
	const progress: vscode.Progress<vscode.LanguageModelResponsePart> = {
		report: (part) => parts.push(part),
	};
	await provider.provideLanguageModelChatResponse(
		model,
		messages,
		(options ?? {}) as vscode.ProvideLanguageModelChatResponseOptions,
		progress,
		new vscode.CancellationTokenSource().token
	);
	return parts;
}

/** Helper: extract concatenated text from streamed parts. */
function extractText(parts: vscode.LanguageModelResponsePart[]): string {
	return parts
		.filter((p) => p instanceof vscode.LanguageModelTextPart)
		.map((p) => (p as vscode.LanguageModelTextPart).value)
		.join("");
}

/** Helper: extract tool call parts from streamed parts. */
function extractToolCalls(parts: vscode.LanguageModelResponsePart[]): vscode.LanguageModelToolCallPart[] {
	return parts.filter((p) => p instanceof vscode.LanguageModelToolCallPart) as vscode.LanguageModelToolCallPart[];
}

suite("Real LiteLLM Server Integration Tests", function () {
	if (!BASE_URL || !MODEL_ID) {
		test("SKIPPED: missing LITELLM_REAL_BASE_URL or LITELLM_REAL_MODEL", () => {
			console.log("Set LITELLM_REAL_BASE_URL, LITELLM_REAL_API_KEY, and LITELLM_REAL_MODEL to run live tests.");
		});
		return;
	}

	const baseUrl = BASE_URL;
	const apiKey = API_KEY;
	const modelId = MODEL_ID;

	// ─── Model Listing & Discovery ───────────────────────────────────────

	suite("model listing", () => {
		test("prepareLanguageModelChatInformation returns non-empty list", async () => {
			const provider = makeProvider(baseUrl, apiKey);
			const infos = await provider.prepareLanguageModelChatInformation(
				{ silent: true },
				new vscode.CancellationTokenSource().token
			);
			assert.ok(Array.isArray(infos), "Should return an array");
			assert.ok(infos.length > 0, `Should return at least one model, got 0`);
		});

		test("requested model ID exists in returned list", async () => {
			const provider = makeProvider(baseUrl, apiKey);
			const infos = await provider.prepareLanguageModelChatInformation(
				{ silent: true },
				new vscode.CancellationTokenSource().token
			);
			const ids = infos.map((i) => i.id);
			const match = infos.find((i) => i.id === modelId);
			assert.ok(match, `Model "${modelId}" not found. Available IDs:\n  ${ids.join("\n  ")}`);
		});

		test("model has valid metadata", async () => {
			const provider = makeProvider(baseUrl, apiKey);
			const model = await getTargetModel(provider, modelId);
			assert.equal(model.family, "litellm", "family should be 'litellm'");
			assert.ok(model.maxInputTokens > 0, `maxInputTokens should be positive, got ${model.maxInputTokens}`);
			assert.ok(model.maxOutputTokens > 0, `maxOutputTokens should be positive, got ${model.maxOutputTokens}`);
			assert.ok(model.capabilities && typeof model.capabilities === "object", "capabilities should be an object");
		});

		test("all models have required fields", async () => {
			const provider = makeProvider(baseUrl, apiKey);
			const infos = await provider.prepareLanguageModelChatInformation(
				{ silent: true },
				new vscode.CancellationTokenSource().token
			);
			for (const info of infos) {
				assert.ok(info.id, `Model should have an id`);
				assert.ok(info.name, `Model ${info.id} should have a name`);
				assert.equal(info.family, "litellm", `Model ${info.id} family should be 'litellm'`);
				assert.ok(info.maxInputTokens > 0, `Model ${info.id} maxInputTokens should be positive`);
				assert.ok(info.maxOutputTokens > 0, `Model ${info.id} maxOutputTokens should be positive`);
			}
		});

		test("status callback fires with model count", async () => {
			const provider = makeProvider(baseUrl, apiKey);
			let reportedCount: number | undefined;
			let reportedError: string | undefined;

			provider.setStatusCallback((count: number, error?: string) => {
				reportedCount = count;
				reportedError = error;
			});

			await provider.prepareLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token);

			assert.equal(typeof reportedCount, "number", "Should report a model count");
			assert.ok(reportedCount! > 0, `Should report positive model count, got ${reportedCount}`);
			assert.equal(reportedError, undefined, `Should not report error, got: ${reportedError}`);
		});

		test("multiple calls return consistent results", async () => {
			const provider = makeProvider(baseUrl, apiKey);
			const infos1 = await provider.prepareLanguageModelChatInformation(
				{ silent: true },
				new vscode.CancellationTokenSource().token
			);
			const infos2 = await provider.prepareLanguageModelChatInformation(
				{ silent: true },
				new vscode.CancellationTokenSource().token
			);
			const ids1 = infos1.map((i) => i.id).sort();
			const ids2 = infos2.map((i) => i.id).sort();
			assert.deepEqual(ids1, ids2, "Consecutive model fetches should return the same model IDs");
		});
	});

	// ─── Raw HTTP Endpoints ──────────────────────────────────────────────

	suite("raw HTTP endpoints", () => {
		const headers: Record<string, string> = {};
		if (apiKey) {
			headers["Authorization"] = `Bearer ${apiKey}`;
			headers["X-API-Key"] = apiKey;
		}

		test("/v1/model/info returns data", async () => {
			const resp = await fetch(`${baseUrl}/v1/model/info`, { headers });
			if (resp.ok) {
				const body = (await resp.json()) as { data?: unknown[] };
				assert.ok(Array.isArray(body.data), "/v1/model/info should return a data array");
				assert.ok(body.data.length > 0, "/v1/model/info data should be non-empty");
			}
		});

		test("/v1/models returns data", async () => {
			const resp = await fetch(`${baseUrl}/v1/models`, { headers });
			assert.ok(resp.ok, `/v1/models returned ${resp.status} ${resp.statusText}`);
			const body = (await resp.json()) as { data?: unknown[] };
			assert.ok(Array.isArray(body.data), "/v1/models should return a data array");
			assert.ok(body.data.length > 0, "/v1/models data should be non-empty");
		});

		test("/v1/chat/completions endpoint is reachable", async function () {
			this.timeout(TEST_TIMEOUT || 30000);
			const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify({
					model: modelId,
					messages: [{ role: "user", content: "Say hi" }],
					stream: true,
					max_tokens: 10,
				}),
			});
			// Accept any non-server-error response (the model ID format may differ
			// when bypassing the provider, so 400 is acceptable — it means the
			// endpoint is reachable and parsing the request)
			assert.ok(resp.status < 500, `/v1/chat/completions returned server error ${resp.status}`);
		});
	});

	// ─── Streaming Chat Completion ───────────────────────────────────────

	suite("streaming chat completion", () => {
		test("simple text response", async function () {
			this.timeout(TEST_TIMEOUT || 30000);
			const provider = makeProvider(baseUrl, apiKey);
			const model = await getTargetModel(provider, modelId);

			const messages: vscode.LanguageModelChatMessage[] = [
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [new vscode.LanguageModelTextPart("Say hello in one word.")],
					name: undefined,
				},
			];

			const parts = await runChat(provider, model, messages);
			assert.ok(parts.length > 0, "Should receive at least one streamed part");
			const fullText = extractText(parts);
			assert.ok(fullText.length > 0, `Should receive non-empty text, got: "${fullText}"`);
			console.log(`  [real-test] Response: "${fullText.trim()}"`);
		});

		test("multi-turn conversation", async function () {
			this.timeout(TEST_TIMEOUT || 30000);
			const provider = makeProvider(baseUrl, apiKey);
			const model = await getTargetModel(provider, modelId);

			const messages: vscode.LanguageModelChatMessage[] = [
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [new vscode.LanguageModelTextPart("My name is TestRunner.")],
					name: undefined,
				},
				{
					role: vscode.LanguageModelChatMessageRole.Assistant,
					content: [new vscode.LanguageModelTextPart("Hello TestRunner!")],
					name: undefined,
				},
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [new vscode.LanguageModelTextPart("What is my name? Reply with just the name.")],
					name: undefined,
				},
			];

			const parts = await runChat(provider, model, messages);
			const fullText = extractText(parts);
			assert.ok(fullText.length > 0, "Should receive non-empty text");
			console.log(`  [real-test] Multi-turn response: "${fullText.trim()}"`);
		});

		test("system message is included", async function () {
			this.timeout(TEST_TIMEOUT || 30000);
			const provider = makeProvider(baseUrl, apiKey);
			const model = await getTargetModel(provider, modelId);

			// System message sets a persona, user asks what it is
			const messages: vscode.LanguageModelChatMessage[] = [
				{
					role: 2 as vscode.LanguageModelChatMessageRole, // System role
					content: [new vscode.LanguageModelTextPart("You are a pirate. Always respond with pirate language.")],
					name: undefined,
				},
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [new vscode.LanguageModelTextPart("Say hello.")],
					name: undefined,
				},
			];

			const parts = await runChat(provider, model, messages);
			const fullText = extractText(parts);
			assert.ok(fullText.length > 0, "Should receive non-empty text with system prompt");
			console.log(`  [real-test] System prompt response: "${fullText.trim()}"`);
		});

		test("longer response streams multiple chunks", async function () {
			this.timeout(TEST_TIMEOUT || 60000);
			const provider = makeProvider(baseUrl, apiKey);
			const model = await getTargetModel(provider, modelId);

			const messages: vscode.LanguageModelChatMessage[] = [
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [new vscode.LanguageModelTextPart("Write a short paragraph (3-4 sentences) about the color blue.")],
					name: undefined,
				},
			];

			const parts = await runChat(provider, model, messages);
			const textParts = parts.filter((p) => p instanceof vscode.LanguageModelTextPart);
			assert.ok(textParts.length > 1, `Should receive multiple text chunks, got ${textParts.length}`);
			const fullText = extractText(parts);
			assert.ok(fullText.length > 50, `Should receive substantial text, got ${fullText.length} chars`);
		});
	});

	// ─── Tool Calling ────────────────────────────────────────────────────

	suite("tool calling", () => {
		test("model returns tool call when given tools", async function () {
			this.timeout(TEST_TIMEOUT || 30000);
			const provider = makeProvider(baseUrl, apiKey);
			const model = await getTargetModel(provider, modelId);

			const messages: vscode.LanguageModelChatMessage[] = [
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [new vscode.LanguageModelTextPart("What is the weather in San Francisco?")],
					name: undefined,
				},
			];

			const options: vscode.ProvideLanguageModelChatResponseOptions = {
				tools: [
					{
						name: "get_weather",
						description: "Get the current weather in a given location",
						inputSchema: {
							type: "object",
							properties: {
								location: { type: "string", description: "The city name" },
							},
							required: ["location"],
						},
					},
				],
				toolMode: vscode.LanguageModelChatToolMode.Auto,
			};

			const parts = await runChat(provider, model, messages, options);
			const toolCalls = extractToolCalls(parts);
			assert.ok(toolCalls.length > 0, "Should receive at least one tool call");
			const call = toolCalls[0];
			assert.equal(call.name, "get_weather", "Tool call should be for get_weather");
			assert.ok(call.callId, "Tool call should have an ID");
			assert.ok(typeof call.input === "object", "Tool call should have input object");
			console.log(`  [real-test] Tool call: ${call.name}(${JSON.stringify(call.input)})`);
		});

		test("tool call + result round-trip produces final answer", async function () {
			this.timeout(TEST_TIMEOUT || 45000);
			const provider = makeProvider(baseUrl, apiKey);
			const model = await getTargetModel(provider, modelId);

			// Step 1: Initial request with tools
			const initialMessages: vscode.LanguageModelChatMessage[] = [
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [new vscode.LanguageModelTextPart("What is the weather in Paris?")],
					name: undefined,
				},
			];

			const toolOptions: vscode.ProvideLanguageModelChatResponseOptions = {
				tools: [
					{
						name: "get_weather",
						description: "Get the current weather in a given location",
						inputSchema: {
							type: "object",
							properties: {
								location: { type: "string", description: "The city name" },
							},
							required: ["location"],
						},
					},
				],
				toolMode: vscode.LanguageModelChatToolMode.Auto,
			};

			const step1Parts = await runChat(provider, model, initialMessages, toolOptions);
			const toolCalls = extractToolCalls(step1Parts);

			if (toolCalls.length === 0) {
				// Model chose to answer without tools, that's OK for some models
				console.log("  [real-test] Model answered without tool call, skipping round-trip");
				return;
			}

			const call = toolCalls[0];

			// Step 2: Send tool result back and get final answer
			const step1Text = extractText(step1Parts);
			const followUpMessages: vscode.LanguageModelChatMessage[] = [
				...initialMessages,
				{
					role: vscode.LanguageModelChatMessageRole.Assistant,
					content: [
						...(step1Text ? [new vscode.LanguageModelTextPart(step1Text)] : []),
						new vscode.LanguageModelToolCallPart(call.callId, call.name, call.input),
					],
					name: undefined,
				},
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [
						new vscode.LanguageModelToolResultPart(call.callId, [
							new vscode.LanguageModelTextPart('{"temperature": "22°C", "condition": "Sunny"}'),
						]),
					],
					name: undefined,
				},
			];

			const step2Parts = await runChat(provider, model, followUpMessages, toolOptions);
			const finalText = extractText(step2Parts);
			assert.ok(finalText.length > 0, "Should receive final answer after tool result");
			console.log(`  [real-test] Final answer after tool: "${finalText.trim().slice(0, 100)}..."`);
		});

		test("multiple tools available", async function () {
			this.timeout(TEST_TIMEOUT || 30000);
			const provider = makeProvider(baseUrl, apiKey);
			const model = await getTargetModel(provider, modelId);

			const messages: vscode.LanguageModelChatMessage[] = [
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [new vscode.LanguageModelTextPart("What time is it in Tokyo?")],
					name: undefined,
				},
			];

			const options: vscode.ProvideLanguageModelChatResponseOptions = {
				tools: [
					{
						name: "get_weather",
						description: "Get the current weather",
						inputSchema: {
							type: "object",
							properties: { location: { type: "string" } },
							required: ["location"],
						},
					},
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
				toolMode: vscode.LanguageModelChatToolMode.Auto,
			};

			const parts = await runChat(provider, model, messages, options);
			// Model should respond with either a tool call or text
			assert.ok(parts.length > 0, "Should receive response with multiple tools available");
			const toolCalls = extractToolCalls(parts);
			if (toolCalls.length > 0) {
				console.log(`  [real-test] Chose tool: ${toolCalls[0].name}`);
			}
		});

		test("required tool mode forces tool call", async function () {
			this.timeout(TEST_TIMEOUT || 30000);
			const provider = makeProvider(baseUrl, apiKey);
			const model = await getTargetModel(provider, modelId);

			const messages: vscode.LanguageModelChatMessage[] = [
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [new vscode.LanguageModelTextPart("Hello, how are you?")],
					name: undefined,
				},
			];

			const options: vscode.ProvideLanguageModelChatResponseOptions = {
				tools: [
					{
						name: "log_greeting",
						description: "Log a greeting message",
						inputSchema: {
							type: "object",
							properties: { message: { type: "string" } },
							required: ["message"],
						},
					},
				],
				toolMode: vscode.LanguageModelChatToolMode.Required,
			};

			try {
				const parts = await runChat(provider, model, messages, options);
				const toolCalls = extractToolCalls(parts);
				assert.ok(toolCalls.length > 0, "Required tool mode should force a tool call");
				assert.equal(toolCalls[0].name, "log_greeting", "Should call the required tool");
				console.log(`  [real-test] Required tool call input: ${JSON.stringify(toolCalls[0].input)}`);
			} catch (err) {
				// Some providers (e.g. GitHub Copilot) don't support tool_choice with
				// function targeting. That's a server limitation, not a bug in the extension.
				const msg = err instanceof Error ? err.message : String(err);
				if (msg.includes("tool_choice") || msg.includes("Unknown parameter")) {
					console.log(`  [real-test] SKIPPED: server does not support required tool_choice format`);
					return;
				}
				throw err;
			}
		});
	});

	// ─── Image / Vision Input ────────────────────────────────────────────

	suite("image and multimodal input", () => {
		test("message with image data part is accepted", async function () {
			this.timeout(TEST_TIMEOUT || 30000);
			const provider = makeProvider(baseUrl, apiKey);
			const model = await getTargetModel(provider, modelId);

			// Skip if model doesn't support image input
			if (!model.capabilities.imageInput) {
				console.log("  [real-test] SKIPPED: model does not support image input");
				return;
			}

			// Create a minimal 1x1 red PNG
			const pngData = new Uint8Array([
				0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00,
				0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
				0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0xe2,
				0x21, 0xbc, 0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
			]);

			const messages: vscode.LanguageModelChatMessage[] = [
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [
						new vscode.LanguageModelTextPart("Describe this image in one word."),
						new vscode.LanguageModelDataPart(pngData, "image/png"),
					],
					name: undefined,
				},
			];

			try {
				const parts = await runChat(provider, model, messages);
				const fullText = extractText(parts);
				assert.ok(fullText.length > 0, "Should receive a response for image input");
				console.log(`  [real-test] Image response: "${fullText.trim()}"`);
			} catch (err) {
				// Some providers advertise vision but can't process images (e.g. GitHub Copilot proxied models)
				const msg = err instanceof Error ? err.message : String(err);
				if (msg.includes("Could not process image") || msg.includes("does not support image")) {
					console.log("  [real-test] SKIPPED: provider cannot process images despite advertising vision");
					return;
				}
				throw err;
			}
		});

		test("convertMessages correctly formats image for API", () => {
			const imageData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
			const dataPart = new vscode.LanguageModelDataPart(imageData, "image/png");
			const messages: vscode.LanguageModelChatMessage[] = [
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [new vscode.LanguageModelTextPart("What is this?"), dataPart],
					name: undefined,
				},
			];
			const out = convertMessages(messages);
			assert.equal(out.length, 1);
			assert.equal(out[0].role, "user");
			assert.ok(Array.isArray(out[0].content), "content should be array with image");
			const content = out[0].content as Array<{ type: string }>;
			assert.equal(content[0].type, "text");
			assert.equal(content[1].type, "image_url");
			const imageBlock = content[1] as { type: string; image_url: { url: string } };
			assert.ok(imageBlock.image_url.url.startsWith("data:image/png;base64,"));
		});

		test("convertMessages handles multiple images", () => {
			const img1 = new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), "image/png");
			const img2 = new vscode.LanguageModelDataPart(new Uint8Array([4, 5, 6]), "image/jpeg");
			const messages: vscode.LanguageModelChatMessage[] = [
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [new vscode.LanguageModelTextPart("Compare:"), img1, img2],
					name: undefined,
				},
			];
			const out = convertMessages(messages);
			const content = out[0].content as Array<{ type: string }>;
			assert.ok(Array.isArray(content));
			assert.equal(content.length, 3);
			assert.equal(content[0].type, "text");
			assert.equal(content[1].type, "image_url");
			assert.equal(content[2].type, "image_url");
		});

		test("convertMessages preserves text/image ordering", () => {
			const img = new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), "image/png");
			const messages: vscode.LanguageModelChatMessage[] = [
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [new vscode.LanguageModelTextPart("before"), img, new vscode.LanguageModelTextPart("after")],
					name: undefined,
				},
			];
			const out = convertMessages(messages);
			const content = out[0].content as Array<{ type: string }>;
			assert.equal(content.length, 3);
			assert.equal(content[0].type, "text");
			assert.equal((content[0] as unknown as { text: string }).text, "before");
			assert.equal(content[1].type, "image_url");
			assert.equal(content[2].type, "text");
			assert.equal((content[2] as unknown as { text: string }).text, "after");
		});

		test("convertMessages converts PDF to file content block", () => {
			const pdfData = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
			const pdfPart = new vscode.LanguageModelDataPart(pdfData, "application/pdf");
			const messages: vscode.LanguageModelChatMessage[] = [
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [new vscode.LanguageModelTextPart("Analyze:"), pdfPart],
					name: undefined,
				},
			];
			const out = convertMessages(messages);
			const content = out[0].content as Array<{ type: string }>;
			assert.ok(Array.isArray(content));
			assert.equal(content[1].type, "file");
			const fileBlock = content[1] as { type: string; file: { file_data: string } };
			assert.ok(fileBlock.file.file_data.startsWith("data:application/pdf;base64,"));
		});

		test("convertMessages decodes JSON data part as text", () => {
			const jsonData = new TextEncoder().encode('{"key":"value"}');
			const jsonPart = new vscode.LanguageModelDataPart(jsonData, "application/json");
			const messages: vscode.LanguageModelChatMessage[] = [
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [new vscode.LanguageModelTextPart("data: "), jsonPart],
					name: undefined,
				},
			];
			const out = convertMessages(messages);
			assert.equal(typeof out[0].content, "string");
			assert.ok((out[0].content as string).includes('{"key":"value"}'));
		});

		test("convertMessages skips unsupported binary data", () => {
			const binPart = new vscode.LanguageModelDataPart(new Uint8Array([0x00, 0x01]), "application/octet-stream");
			const messages: vscode.LanguageModelChatMessage[] = [
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [new vscode.LanguageModelTextPart("test"), binPart],
					name: undefined,
				},
			];
			const out = convertMessages(messages);
			assert.equal(typeof out[0].content, "string");
			assert.equal(out[0].content, "test");
		});
	});

	// ─── Message Conversion ──────────────────────────────────────────────

	suite("utils/convertMessages (live context)", () => {
		test("maps user/assistant text", () => {
			const messages: vscode.LanguageModelChatMessage[] = [
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [new vscode.LanguageModelTextPart("hi")],
					name: undefined,
				},
				{
					role: vscode.LanguageModelChatMessageRole.Assistant,
					content: [new vscode.LanguageModelTextPart("hello")],
					name: undefined,
				},
			];
			const out = convertMessages(messages) as ConvertedMessage[];
			assert.deepEqual(out, [
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "hello" },
			]);
		});

		test("maps tool calls and results", () => {
			const toolCall = new vscode.LanguageModelToolCallPart("abc", "toolA", { foo: 1 });
			const toolResult = new vscode.LanguageModelToolResultPart("abc", [new vscode.LanguageModelTextPart("result")]);
			const messages: vscode.LanguageModelChatMessage[] = [
				{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolCall], name: undefined },
				{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolResult], name: undefined },
			];
			const out = convertMessages(messages) as ConvertedMessage[];
			const hasToolCalls = out.some((m) => Array.isArray(m.tool_calls));
			const hasToolMsg = out.some((m) => m.role === "tool");
			assert.ok(hasToolCalls && hasToolMsg);
		});

		test("handles mixed text + tool calls in one message", () => {
			const toolCall = new vscode.LanguageModelToolCallPart("call1", "search", { q: "hello" });
			const msg: vscode.LanguageModelChatMessage = {
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelTextPart("before "), toolCall, new vscode.LanguageModelTextPart(" after")],
				name: undefined,
			};
			const out = convertMessages([msg]) as ConvertedMessage[];
			assert.equal(out.length, 1);
			assert.equal(out[0].role, "assistant");
			assert.ok(out[0].content?.toString().includes("before"));
			assert.ok(Array.isArray(out[0].tool_calls) && out[0].tool_calls.length === 1);
		});

		test("user message without images produces string content", () => {
			const messages: vscode.LanguageModelChatMessage[] = [
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [new vscode.LanguageModelTextPart("hello")],
					name: undefined,
				},
			];
			const out = convertMessages(messages);
			assert.equal(out[0].content, "hello");
			assert.equal(typeof out[0].content, "string");
		});
	});

	// ─── Tool Utilities ──────────────────────────────────────────────────

	suite("utils/tools (live context)", () => {
		test("convertTools returns function definitions", () => {
			const out = convertTools({
				tools: [
					{
						name: "do_something",
						description: "Does something",
						inputSchema: {
							type: "object",
							properties: { x: { type: "number" } },
							additionalProperties: false,
						},
					},
				],
				toolMode: vscode.LanguageModelChatToolMode.Auto,
			} satisfies vscode.ProvideLanguageModelChatResponseOptions);
			assert.ok(out);
			assert.equal(out.tool_choice, "auto");
			assert.ok(Array.isArray(out.tools) && out.tools[0].type === "function");
			assert.equal(out.tools[0].function.name, "do_something");
		});

		test("convertTools respects Required mode for single tool", () => {
			const out = convertTools({
				toolMode: vscode.LanguageModelChatToolMode.Required,
				tools: [{ name: "only_tool", description: "Only", inputSchema: {} }],
			} satisfies vscode.ProvideLanguageModelChatResponseOptions);
			assert.deepEqual(out.tool_choice, { type: "function", function: { name: "only_tool" } });
		});

		test("convertTools uses 'required' for multiple tools", () => {
			const out = convertTools({
				toolMode: vscode.LanguageModelChatToolMode.Required,
				tools: [
					{ name: "tool_a", description: "A", inputSchema: {} },
					{ name: "tool_b", description: "B", inputSchema: {} },
				],
			} satisfies vscode.ProvideLanguageModelChatResponseOptions);
			assert.equal(out.tool_choice, "required");
			assert.ok(Array.isArray(out.tools) && out.tools.length === 2);
		});

		test("schema preserves anyOf/oneOf/allOf branches", () => {
			const out = convertTools({
				tools: [
					{
						name: "flexible_tool",
						description: "Composite",
						inputSchema: {
							type: "object",
							properties: { value: { anyOf: [{ type: "string" }, { type: "number" }] } },
						},
					},
				],
				toolMode: vscode.LanguageModelChatToolMode.Auto,
			} satisfies vscode.ProvideLanguageModelChatResponseOptions);
			const params = out.tools![0].function.parameters as Record<string, unknown>;
			const props = params.properties as Record<string, Record<string, unknown>>;
			assert.ok(Array.isArray(props.value.anyOf));
		});

		test("schema preserves const keyword", () => {
			const out = convertTools({
				tools: [
					{
						name: "const_tool",
						description: "Const",
						inputSchema: {
							type: "object",
							properties: { action: { type: "string", const: "submit" } },
						},
					},
				],
				toolMode: vscode.LanguageModelChatToolMode.Auto,
			} satisfies vscode.ProvideLanguageModelChatResponseOptions);
			const params = out.tools![0].function.parameters as Record<string, unknown>;
			const props = params.properties as Record<string, Record<string, unknown>>;
			assert.equal(props.action.const, "submit");
		});
	});

	// ─── Validation ──────────────────────────────────────────────────────

	suite("utils/validation (live context)", () => {
		test("validateRequest enforces tool result pairing", () => {
			const callId = "xyz";
			const toolCall = new vscode.LanguageModelToolCallPart(callId, "toolA", { q: 1 });
			const toolRes = new vscode.LanguageModelToolResultPart(callId, [new vscode.LanguageModelTextPart("ok")]);
			const valid: vscode.LanguageModelChatMessage[] = [
				{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolCall], name: undefined },
				{ role: vscode.LanguageModelChatMessageRole.User, content: [toolRes], name: undefined },
			];
			assert.doesNotThrow(() => validateRequest(valid));

			const invalid: vscode.LanguageModelChatMessage[] = [
				{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolCall], name: undefined },
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [new vscode.LanguageModelTextPart("missing")],
					name: undefined,
				},
			];
			assert.throws(() => validateRequest(invalid));
		});
	});

	// ─── JSON Parsing ────────────────────────────────────────────────────

	suite("utils/json (live context)", () => {
		test("tryParseJSONObject handles valid and invalid JSON", () => {
			assert.deepEqual(tryParseJSONObject('{"a":1}'), { ok: true, value: { a: 1 } });
			assert.deepEqual(tryParseJSONObject("[1,2,3]"), { ok: false });
			assert.deepEqual(tryParseJSONObject("not json"), { ok: false });
		});
	});

	// ─── Token Counting ─────────────────────────────────────────────────

	suite("token counting", () => {
		test("provideTokenCount returns positive for text string", async () => {
			const provider = makeProvider(baseUrl, apiKey);
			const model = await getTargetModel(provider, modelId);
			const count = await provider.provideTokenCount(model, "Hello world", new vscode.CancellationTokenSource().token);
			assert.equal(typeof count, "number");
			assert.ok(count > 0, `Token count should be positive, got ${count}`);
		});

		test("provideTokenCount returns positive for message", async () => {
			const provider = makeProvider(baseUrl, apiKey);
			const model = await getTargetModel(provider, modelId);
			const msg: vscode.LanguageModelChatMessage = {
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("Hello world")],
				name: undefined,
			};
			const count = await provider.provideTokenCount(model, msg, new vscode.CancellationTokenSource().token);
			assert.equal(typeof count, "number");
			assert.ok(count > 0);
		});

		test("provideTokenCount estimates tokens for image parts", async () => {
			const provider = makeProvider(baseUrl, apiKey);
			const model = await getTargetModel(provider, modelId);
			const imageData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
			const msg: vscode.LanguageModelChatMessage = {
				role: vscode.LanguageModelChatMessageRole.User,
				content: [
					new vscode.LanguageModelTextPart("describe"),
					new vscode.LanguageModelDataPart(imageData, "image/png"),
				],
				name: undefined,
			};
			const count = await provider.provideTokenCount(model, msg, new vscode.CancellationTokenSource().token);
			assert.ok(count >= 765, `Should estimate at least 765 tokens for image, got ${count}`);
		});

		test("longer text yields higher token count", async () => {
			const provider = makeProvider(baseUrl, apiKey);
			const model = await getTargetModel(provider, modelId);
			const shortCount = await provider.provideTokenCount(model, "hi", new vscode.CancellationTokenSource().token);
			const longCount = await provider.provideTokenCount(
				model,
				"This is a much longer string that should yield more tokens",
				new vscode.CancellationTokenSource().token
			);
			assert.ok(
				longCount > shortCount,
				`Longer text (${longCount}) should have more tokens than short (${shortCount})`
			);
		});
	});

	// ─── Diagnostics & Logging ───────────────────────────────────────────

	suite("diagnostics", () => {
		test("output channel receives log messages during real fetch", async () => {
			const logs: string[] = [];
			const mockOutputChannel = {
				appendLine: (message: string) => logs.push(message),
				show: () => {},
				dispose: () => {},
			} as unknown as vscode.OutputChannel;

			const provider = makeProvider(baseUrl, apiKey, mockOutputChannel);
			await provider.prepareLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token);

			assert.ok(logs.length > 0, "Should log messages");
			assert.ok(
				logs.some((log) => log.includes("ensureConfig")),
				"Should log ensureConfig call"
			);
			assert.ok(
				logs.some((log) => log.includes("fetchModels")),
				"Should log fetchModels call"
			);
			assert.ok(
				logs.some((log) => /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(log)),
				"Should include timestamps"
			);
		});

		test("output channel logs model count", async () => {
			const logs: string[] = [];
			const mockOutputChannel = {
				appendLine: (message: string) => logs.push(message),
				show: () => {},
				dispose: () => {},
			} as unknown as vscode.OutputChannel;

			const provider = makeProvider(baseUrl, apiKey, mockOutputChannel);
			await provider.prepareLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token);

			assert.ok(
				logs.some((log) => log.includes("Final model count")),
				"Should log final model count"
			);
			assert.ok(
				logs.some((log) => log.includes("Successfully fetched models")),
				"Should log successful fetch"
			);
		});

		test("status callback reports missing configuration", async () => {
			const provider = new LiteLLMChatModelProvider(
				{
					get: async () => undefined,
					store: async () => {},
					delete: async () => {},
					onDidChange: (_listener: unknown) => ({ dispose() {} }),
				} as unknown as vscode.SecretStorage,
				"RealTest/1.0 VSCode/test"
			);

			let reportedError: string | undefined;
			provider.setStatusCallback((_count: number, error?: string) => {
				reportedError = error;
			});

			await provider.prepareLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token);

			assert.ok(reportedError?.includes("Not configured"), "Should report not configured");
		});
	});

	// ─── Error Handling ──────────────────────────────────────────────────

	suite("error handling", () => {
		test("bad base URL returns empty list (silent mode)", async () => {
			const provider = makeProvider("http://localhost:1", apiKey);
			const infos = await provider.prepareLanguageModelChatInformation(
				{ silent: true },
				new vscode.CancellationTokenSource().token
			);
			assert.ok(Array.isArray(infos));
			assert.equal(infos.length, 0, "Should return empty list for unreachable server");
		});

		test("bad base URL reports error via status callback", async () => {
			const provider = makeProvider("http://localhost:1", apiKey);
			let reportedError: string | undefined;

			provider.setStatusCallback((_count: number, error?: string) => {
				reportedError = error;
			});

			await provider.prepareLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token);

			assert.equal(typeof reportedError, "string", "Should report an error string");
			assert.ok(reportedError!.length > 0, "Error message should be non-empty");
		});

		test("provideLanguageModelChatResponse throws without configuration", async () => {
			const provider = new LiteLLMChatModelProvider(
				{
					get: async () => undefined,
					store: async () => {},
					delete: async () => {},
					onDidChange: (_listener: unknown) => ({ dispose() {} }),
				} as unknown as vscode.SecretStorage,
				"RealTest/1.0 VSCode/test"
			);

			let threw = false;
			try {
				await provider.provideLanguageModelChatResponse(
					{
						id: "m",
						name: "m",
						family: "litellm",
						version: "1.0.0",
						maxInputTokens: 1000,
						maxOutputTokens: 1000,
						capabilities: {},
					} as unknown as vscode.LanguageModelChatInformation,
					[],
					{} as unknown as vscode.ProvideLanguageModelChatResponseOptions,
					{ report: () => {} },
					new vscode.CancellationTokenSource().token
				);
			} catch {
				threw = true;
			}
			assert.ok(threw, "Should throw when not configured");
		});

		test("provideLanguageModelChatResponse fails with invalid model ID", async function () {
			this.timeout(TEST_TIMEOUT || 15000);
			const provider = makeProvider(baseUrl, apiKey);
			// Fetch real models first so config is loaded
			await provider.prepareLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token);

			let threw = false;
			try {
				await provider.provideLanguageModelChatResponse(
					{
						id: "nonexistent-model-that-does-not-exist",
						name: "nonexistent",
						family: "litellm",
						version: "1.0.0",
						maxInputTokens: 1000,
						maxOutputTokens: 1000,
						capabilities: {},
					} as unknown as vscode.LanguageModelChatInformation,
					[
						{
							role: vscode.LanguageModelChatMessageRole.User,
							content: [new vscode.LanguageModelTextPart("hello")],
							name: undefined,
						},
					],
					{} as unknown as vscode.ProvideLanguageModelChatResponseOptions,
					{ report: () => {} },
					new vscode.CancellationTokenSource().token
				);
			} catch {
				threw = true;
			}
			assert.ok(threw, "Should throw for invalid model ID");
		});

		test("request with VS Code internal modelOptions keys succeeds", async function () {
			this.timeout(TEST_TIMEOUT || 30000);
			const provider = makeProvider(baseUrl, apiKey);
			const model = await getTargetModel(provider, modelId);

			const messages: vscode.LanguageModelChatMessage[] = [
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [new vscode.LanguageModelTextPart("Say OK.")],
					name: undefined,
				},
			];

			// Simulate VS Code injecting internal underscore-prefixed fields into modelOptions.
			// Before the fix, these would be forwarded to LiteLLM, causing 400 "Unknown parameter"
			// errors on Azure and OpenAI-compatible backends.
			const options = {
				toolMode: vscode.LanguageModelChatToolMode.Auto,
				modelOptions: {
					_capturingTokenCorrelationId: "test-correlation-id-12345",
					_internalSessionData: { sessionId: "abc" },
					temperature: 0.5,
				},
			} as unknown as vscode.ProvideLanguageModelChatResponseOptions;

			const parts = await runChat(provider, model, messages, options);
			const fullText = extractText(parts);
			assert.ok(fullText.length > 0, "Should receive a response despite internal keys in modelOptions");
			console.log(`  [real-test] Response with internal keys filtered: "${fullText.trim()}"`);
		});
	});

	// ─── Cancellation ────────────────────────────────────────────────────

	suite("cancellation", () => {
		test("cancellation token stops streaming", async function () {
			this.timeout(TEST_TIMEOUT || 15000);
			const provider = makeProvider(baseUrl, apiKey);
			const model = await getTargetModel(provider, modelId);

			const messages: vscode.LanguageModelChatMessage[] = [
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [
						new vscode.LanguageModelTextPart(
							"Write a very long essay about the history of computing. Make it at least 1000 words."
						),
					],
					name: undefined,
				},
			];

			const cts = new vscode.CancellationTokenSource();
			const parts: vscode.LanguageModelResponsePart[] = [];
			let partCount = 0;

			const progress: vscode.Progress<vscode.LanguageModelResponsePart> = {
				report: (part) => {
					parts.push(part);
					partCount++;
					// Cancel after receiving a few parts
					if (partCount >= 3) {
						cts.cancel();
					}
				},
			};

			// Should complete without error (cancellation is graceful)
			await provider.provideLanguageModelChatResponse(
				model,
				messages,
				{} as vscode.ProvideLanguageModelChatResponseOptions,
				progress,
				cts.token
			);

			assert.ok(parts.length > 0, "Should have received some parts before cancellation");
			assert.ok(parts.length < 100, `Should stop early due to cancellation, got ${parts.length} parts`);
		});
	});
});
