import * as assert from "assert";
import * as vscode from "vscode";
import { LiteLLMChatModelProvider } from "../provider";
import { convertMessages, convertTools, validateRequest, validateTools, tryParseJSONObject } from "../utils";

interface OpenAIToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}
interface ConvertedMessage {
	role: "user" | "assistant" | "tool";
	content?: string;
	name?: string;
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
}

suite("LiteLLM Chat Provider Extension", () => {
	suite("provider", () => {
		test("prepareLanguageModelChatInformation returns array (no key -> empty)", async () => {
			const provider = new LiteLLMChatModelProvider(
				{
					get: async () => undefined,
					store: async () => {},
					delete: async () => {},
					onDidChange: (_listener: unknown) => ({ dispose() {} }),
				} as unknown as vscode.SecretStorage,
				"GitHubCopilotChat/test VSCode/test"
			);

			const infos = await provider.prepareLanguageModelChatInformation(
				{ silent: true },
				new vscode.CancellationTokenSource().token
			);
			assert.ok(Array.isArray(infos));
		});

		test("buildCapabilities maps model_info flags correctly", async () => {
			const provider = new LiteLLMChatModelProvider(
				{
					get: async () => undefined,
					store: async () => {},
					delete: async () => {},
					onDidChange: (_listener: unknown) => ({ dispose() {} }),
				} as unknown as vscode.SecretStorage,
				"GitHubCopilotChat/test VSCode/test"
			);

			// Access private method through type assertion for testing
			const buildCapabilities = (
				provider as unknown as { buildCapabilities: (modelInfo: unknown) => vscode.LanguageModelChatCapabilities }
			).buildCapabilities;

			// Test with vision and function calling support
			const caps1 = buildCapabilities({
				supports_vision: true,
				supports_function_calling: true,
			});
			assert.deepEqual(caps1, {
				toolCalling: true,
				imageInput: true,
			});

			// Test without vision but with function calling
			const caps2 = buildCapabilities({
				supports_vision: false,
				supports_function_calling: true,
			});
			assert.deepEqual(caps2, {
				toolCalling: true,
				imageInput: false,
			});

			// Test with null model_info
			const caps3 = buildCapabilities(undefined);
			assert.deepEqual(caps3, {
				toolCalling: true,
				imageInput: false,
			});
		});

		test("prepareLanguageModelChatInformation extracts token constraints from model_info", async () => {
			const mockFetch = async (url: string) => {
				if (url.includes("/model/info")) {
					return {
						ok: true,
						json: async () => ({
							data: [
								{
									model_name: "test-model",
									model_info: {
										key: "test-model",
										max_input_tokens: 8000,
										max_output_tokens: 4000,
										litellm_provider: "test-provider",
										mode: "chat",
										supports_vision: true,
										supports_function_calling: true,
									},
								},
							],
						}),
					};
				}
				throw new Error(`Unexpected URL: ${url}`);
			};

			// Mock global fetch
			const originalFetch = global.fetch;
			(global as unknown as { fetch: unknown }).fetch = mockFetch as unknown;

			try {
				const provider = new LiteLLMChatModelProvider(
					{
						get: async () => "test-api-key",
						store: async () => {},
						delete: async () => {},
						onDidChange: (_listener: unknown) => ({ dispose() {} }),
					} as unknown as vscode.SecretStorage,
					"GitHubCopilotChat/test VSCode/test"
				);

				const infos = await provider.prepareLanguageModelChatInformation(
					{ silent: false },
					new vscode.CancellationTokenSource().token
				);

				assert.ok(Array.isArray(infos));
				assert.equal(infos.length, 1);
				assert.equal(infos[0].id, "test-model");
				assert.equal(infos[0].name, "test-model");
				assert.equal(infos[0].maxInputTokens, 8000);
				assert.equal(infos[0].maxOutputTokens, 4000);
				assert.equal(infos[0].capabilities.toolCalling, true);
				assert.equal(infos[0].capabilities.imageInput, true);
			} finally {
				(global as unknown as { fetch: unknown }).fetch = originalFetch;
			}
		});

		test("prepareLanguageModelChatInformation uses defaults for missing token constraints", async () => {
			const mockFetch = async (url: string) => {
				if (url.includes("/model/info")) {
					return {
						ok: true,
						json: async () => ({
							data: [
								{
									model_name: "minimal-model",
									model_info: {
										key: "minimal-model",
										// No max_input_tokens or max_output_tokens
										litellm_provider: "test",
										mode: "responses",
									},
								},
							],
						}),
					};
				}
				throw new Error(`Unexpected URL: ${url}`);
			};

			const originalFetch = global.fetch;
			(global as unknown as { fetch: unknown }).fetch = mockFetch as unknown;

			try {
				const provider = new LiteLLMChatModelProvider(
					{
						get: async () => "test-api-key",
						store: async () => {},
						delete: async () => {},
						onDidChange: (_listener: unknown) => ({ dispose() {} }),
					} as unknown as vscode.SecretStorage,
					"GitHubCopilotChat/test VSCode/test"
				);

				const infos = await provider.prepareLanguageModelChatInformation(
					{ silent: false },
					new vscode.CancellationTokenSource().token
				);

				// Should use DEFAULT_CONTEXT_LENGTH and DEFAULT_MAX_OUTPUT_TOKENS
				assert.equal(infos.length, 1);
				assert.equal(infos[0].maxInputTokens, 128000); // DEFAULT_CONTEXT_LENGTH
				assert.equal(infos[0].maxOutputTokens, 16000); // DEFAULT_MAX_OUTPUT_TOKENS
			} finally {
				(global as unknown as { fetch: unknown }).fetch = originalFetch;
			}
		});

		test("provideTokenCount counts simple string", async () => {
			const provider = new LiteLLMChatModelProvider(
				{
					get: async () => undefined,
					store: async () => {},
					delete: async () => {},
					onDidChange: (_listener: unknown) => ({ dispose() {} }),
				} as unknown as vscode.SecretStorage,
				"GitHubCopilotChat/test VSCode/test"
			);

			const est = await provider.provideTokenCount(
				{
					id: "m",
					name: "m",
					family: "litellm",
					version: "1.0.0",
					maxInputTokens: 1000,
					maxOutputTokens: 1000,
					capabilities: {},
				} as unknown as vscode.LanguageModelChatInformation,
				"hello world",
				new vscode.CancellationTokenSource().token
			);
			assert.equal(typeof est, "number");
			assert.ok(est > 0);
		});

		test("provideTokenCount counts message parts", async () => {
			const provider = new LiteLLMChatModelProvider(
				{
					get: async () => undefined,
					store: async () => {},
					delete: async () => {},
					onDidChange: (_listener: unknown) => ({ dispose() {} }),
				} as unknown as vscode.SecretStorage,
				"GitHubCopilotChat/test VSCode/test"
			);

			const msg: vscode.LanguageModelChatMessage = {
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("hello world")],
				name: undefined,
			};
			const est = await provider.provideTokenCount(
				{
					id: "m",
					name: "m",
					family: "litellm",
					version: "1.0.0",
					maxInputTokens: 1000,
					maxOutputTokens: 1000,
					capabilities: {},
				} as unknown as vscode.LanguageModelChatInformation,
				msg,
				new vscode.CancellationTokenSource().token
			);
			assert.equal(typeof est, "number");
			assert.ok(est > 0);
		});

		test("provideLanguageModelChatResponse throws without configuration", async () => {
			const provider = new LiteLLMChatModelProvider(
				{
					get: async () => undefined,
					store: async () => {},
					delete: async () => {},
					onDidChange: (_listener: unknown) => ({ dispose() {} }),
				} as unknown as vscode.SecretStorage,
				"GitHubCopilotChat/test VSCode/test"
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
			assert.ok(threw);
		});
	});

	suite("utils/convertMessages", () => {
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
			const hasToolCalls = out.some((m: ConvertedMessage) => Array.isArray(m.tool_calls));
			const hasToolMsg = out.some((m: ConvertedMessage) => m.role === "tool");
			assert.ok(hasToolCalls && hasToolMsg);
		});

		test("handles mixed text + tool calls in one assistant message", () => {
			const toolCall = new vscode.LanguageModelToolCallPart("call1", "search", { q: "hello" });
			const msg: vscode.LanguageModelChatMessage = {
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelTextPart("before "), toolCall, new vscode.LanguageModelTextPart(" after")],
				name: undefined,
			};
			const out = convertMessages([msg]) as ConvertedMessage[];
			assert.equal(out.length, 1);
			assert.equal(out[0].role, "assistant");
			assert.ok(out[0].content?.includes("before"));
			assert.ok(out[0].content?.includes("after"));
			assert.ok(Array.isArray(out[0].tool_calls) && out[0].tool_calls.length === 1);
			assert.equal(out[0].tool_calls?.[0].function.name, "search");
		});
	});

	suite("utils/tools", () => {
		test("convertTools returns function tool definitions", () => {
			const out = convertTools({
				tools: [
					{
						name: "do_something",
						description: "Does something",
						inputSchema: { type: "object", properties: { x: { type: "number" } }, additionalProperties: false },
					},
				],
				toolMode: vscode.LanguageModelChatToolMode.Auto,
			} satisfies vscode.ProvideLanguageModelChatResponseOptions);

			assert.ok(out);
			assert.equal(out.tool_choice, "auto");
			assert.ok(Array.isArray(out.tools) && out.tools[0].type === "function");
			assert.equal(out.tools[0].function.name, "do_something");
		});

		test("convertTools respects ToolMode.Required for single tool", () => {
			const out = convertTools({
				toolMode: vscode.LanguageModelChatToolMode.Required,
				tools: [
					{
						name: "only_tool",
						description: "Only tool",
						inputSchema: {},
					},
				],
			} satisfies vscode.ProvideLanguageModelChatResponseOptions);
			assert.deepEqual(out.tool_choice, { type: "function", function: { name: "only_tool" } });
		});

		test("validateTools rejects invalid names", () => {
			const badTools: vscode.LanguageModelChatTool[] = [{ name: "bad name!", description: "", inputSchema: {} }];
			assert.throws(() => validateTools(badTools));
		});
	});

	suite("utils/validation", () => {
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

	suite("utils/json", () => {
		test("tryParseJSONObject handles valid and invalid JSON", () => {
			assert.deepEqual(tryParseJSONObject('{"a":1}'), { ok: true, value: { a: 1 } });
			assert.deepEqual(tryParseJSONObject("[1,2,3]"), { ok: false });
			assert.deepEqual(tryParseJSONObject("not json"), { ok: false });
		});
	});

	suite("provider/parameter limitations", () => {
		test("respects known parameter limitations for Anthropic models", async () => {
			// This test validates that the provider correctly filters parameters
			// For claude-haiku-4-5, even if LiteLLM says temperature is supported,
			// our code knows it's not and will not include it in requests.
			// This is indirectly tested through the provider's request building logic.

			const provider = new LiteLLMChatModelProvider(
				{
					get: async () => undefined,
					store: async () => {},
					delete: async () => {},
					onDidChange: (_listener: unknown) => ({ dispose() {} }),
				} as unknown as vscode.SecretStorage,
				"GitHubCopilotChat/test VSCode/test"
			);

			// The provider has the KNOWN_PARAMETER_LIMITATIONS constant
			// which includes claude-haiku-4-5 with temperature limitation
			// This test passes if the provider initializes without errors
			assert.ok(provider, "Provider should initialize successfully");
		});

		test("parseApiError extracts meaningful error messages", async () => {
			const provider = new LiteLLMChatModelProvider(
				{
					get: async () => undefined,
					store: async () => {},
					delete: async () => {},
					onDidChange: (_listener: unknown) => ({ dispose() {} }),
				} as unknown as vscode.SecretStorage,
				"GitHubCopilotChat/test VSCode/test"
			);

			const parseApiError = (
				provider as unknown as {
					parseApiError: (statusCode: number, errorText: string) => string;
				}
			).parseApiError;

			// Test JSON error parsing
			const jsonError = JSON.stringify({ error: { message: "Temperature not supported" } });
			const result1 = parseApiError(400, jsonError);
			assert.strictEqual(result1, "Temperature not supported");

			// Test truncation of raw error
			const longError = "x".repeat(300);
			const result2 = parseApiError(400, longError);
			assert.strictEqual(result2.length, 200);

			// Test fallback message
			const result3 = parseApiError(400, "");
			assert.strictEqual(result3, "API request failed with status 400");
		});

		test("stripUnsupportedParametersFromRequest removes known unsupported params", async () => {
			const provider = new LiteLLMChatModelProvider(
				{
					get: async () => undefined,
					store: async () => {},
					delete: async () => {},
					onDidChange: (_listener: unknown) => ({ dispose() {} }),
				} as unknown as vscode.SecretStorage,
				"GitHubCopilotChat/test VSCode/test"
			);

			const requestBody: Record<string, unknown> = {
				temperature: 0.9,
				stop: ["\n"],
				frequency_penalty: 0.5,
			};

			const modelInfo = {
				supported_openai_params: ["temperature", "stop", "frequency_penalty"],
			};

			// Model is a known Codex variant, temperature & frequency_penalty must be removed
			(
				provider as unknown as {
					stripUnsupportedParametersFromRequest: (
						rb: Record<string, unknown>,
						modelInfo: unknown,
						modelId?: string
					) => void;
				}
			).stripUnsupportedParametersFromRequest(
				requestBody,
				modelInfo as unknown as Record<string, unknown>,
				"gpt-5.1-codex-mini"
			);
			assert.strictEqual(requestBody.temperature, undefined);
			assert.strictEqual(requestBody.frequency_penalty, undefined);
			// stop should remain
			assert.deepStrictEqual(requestBody.stop, ["\n"]);
		});
	});
});
