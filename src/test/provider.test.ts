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

		test("uses token constraints from provider info when available", async () => {
			// Mock fetch to return model with token constraints
			const originalFetch = global.fetch;
			global.fetch = async () =>
				({
					ok: true,
					json: async () => ({
						object: "list",
						data: [
							{
								id: "test-model",
								object: "model",
								created: 0,
								owned_by: "test",
								providers: [
									{
										provider: "test-provider",
										status: "active",
										supports_tools: true,
										context_length: 100000,
										max_output_tokens: 8000,
										max_input_tokens: 90000,
									},
								],
							},
						],
					}),
				}) as unknown as Response;

			const provider = new LiteLLMChatModelProvider(
				{
					get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
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

			global.fetch = originalFetch;

			// Find the per-provider entry
			const providerEntry = infos.find((i) => i.id === "test-model:test-provider");
			assert.ok(providerEntry, "Provider entry should exist");
			assert.equal(providerEntry.maxOutputTokens, 8000, "Should use max_output_tokens from provider");
			assert.equal(providerEntry.maxInputTokens, 90000, "Should use max_input_tokens from provider");
		});

		test("uses workspace settings as fallback when provider fields absent", async () => {
			// Mock fetch to return model without token constraints
			const originalFetch = global.fetch;
			global.fetch = async () =>
				({
					ok: true,
					json: async () => ({
						object: "list",
						data: [
							{
								id: "test-model",
								object: "model",
								created: 0,
								owned_by: "test",
								providers: [
									{
										provider: "test-provider",
										status: "active",
										supports_tools: true,
									},
								],
							},
						],
					}),
				}) as unknown as Response;

			// Mock workspace configuration
			const originalGetConfiguration = vscode.workspace.getConfiguration;
			vscode.workspace.getConfiguration = ((section?: string) => {
				if (section === "litellm-vscode-chat") {
					return {
						get: (key: string, defaultValue?: unknown) => {
							if (key === "defaultMaxOutputTokens") {
								return 20000;
							}
							if (key === "defaultContextLength") {
								return 200000;
							}
							if (key === "defaultMaxInputTokens") {
								return null;
							}
							return defaultValue;
						},
					} as unknown as vscode.WorkspaceConfiguration;
				}
				return originalGetConfiguration(section);
			}) as unknown as typeof vscode.workspace.getConfiguration;

			const provider = new LiteLLMChatModelProvider(
				{
					get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
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

			global.fetch = originalFetch;
			vscode.workspace.getConfiguration = originalGetConfiguration;

			// Find the per-provider entry
			const providerEntry = infos.find((i) => i.id === "test-model:test-provider");
			assert.ok(providerEntry, "Provider entry should exist");
			assert.equal(providerEntry.maxOutputTokens, 20000, "Should use workspace setting for max output tokens");
			assert.equal(providerEntry.maxInputTokens, 180000, "Should calculate max input as context - output");
		});

		test("uses configured defaultMaxInputTokens as an explicit override", async () => {
			const originalFetch = global.fetch;
			global.fetch = async () =>
				({
					ok: true,
					json: async () => ({
						object: "list",
						data: [
							{
								id: "test-model",
								object: "model",
								created: 0,
								owned_by: "test",
								providers: [
									{
										provider: "test-provider",
										status: "active",
										supports_tools: true,
										context_length: 100000,
										max_output_tokens: 8000,
										max_input_tokens: 90000,
									},
								],
							},
						],
					}),
				}) as unknown as Response;

			const originalGetConfiguration = vscode.workspace.getConfiguration;
			vscode.workspace.getConfiguration = ((section?: string) => {
				if (section === "litellm-vscode-chat") {
					return {
						get: (key: string, defaultValue?: unknown) => {
							if (key === "defaultMaxInputTokens") {
								return 50000;
							}
							return defaultValue;
						},
					} as unknown as vscode.WorkspaceConfiguration;
				}
				return originalGetConfiguration(section);
			}) as unknown as typeof vscode.workspace.getConfiguration;

			const provider = new LiteLLMChatModelProvider(
				{
					get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
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

			global.fetch = originalFetch;
			vscode.workspace.getConfiguration = originalGetConfiguration;

			const providerEntry = infos.find((i) => i.id === "test-model:test-provider");
			assert.ok(providerEntry, "Provider entry should exist");
			assert.equal(providerEntry.maxInputTokens, 50000, "Should use configured max input token override");
		});

		test("treats null provider max_input_tokens as missing and falls back to workspace setting", async () => {
			const originalFetch = global.fetch;
			global.fetch = async () =>
				({
					ok: true,
					json: async () => ({
						object: "list",
						data: [
							{
								id: "test-model",
								object: "model",
								created: 0,
								owned_by: "test",
								providers: [
									{
										provider: "test-provider",
										status: "active",
										supports_tools: true,
										context_length: 100000,
										max_output_tokens: 8000,
										max_input_tokens: null,
									},
								],
							},
						],
					}),
				}) as unknown as Response;

			const originalGetConfiguration = vscode.workspace.getConfiguration;
			vscode.workspace.getConfiguration = ((section?: string) => {
				if (section === "litellm-vscode-chat") {
					return {
						get: (key: string, defaultValue?: unknown) => {
							if (key === "defaultMaxInputTokens") {
								return 48000;
							}
							return defaultValue;
						},
					} as unknown as vscode.WorkspaceConfiguration;
				}
				return originalGetConfiguration(section);
			}) as unknown as typeof vscode.workspace.getConfiguration;

			const provider = new LiteLLMChatModelProvider(
				{
					get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
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

			global.fetch = originalFetch;
			vscode.workspace.getConfiguration = originalGetConfiguration;

			const providerEntry = infos.find((i) => i.id === "test-model:test-provider");
			assert.ok(providerEntry, "Provider entry should exist");
			assert.equal(providerEntry.maxInputTokens, 48000, "Should ignore null provider max_input_tokens");
		});

		test("uses hardcoded defaults when provider and settings absent", async () => {
			// Mock fetch to return model without token constraints
			const originalFetch = global.fetch;
			global.fetch = async () =>
				({
					ok: true,
					json: async () => ({
						object: "list",
						data: [
							{
								id: "test-model",
								object: "model",
								created: 0,
								owned_by: "test",
								providers: [
									{
										provider: "test-provider",
										status: "active",
										supports_tools: true,
									},
								],
							},
						],
					}),
				}) as unknown as Response;

			// Mock workspace configuration to return defaults
			const originalGetConfiguration = vscode.workspace.getConfiguration;
			vscode.workspace.getConfiguration = ((section?: string) => {
				if (section === "litellm-vscode-chat") {
					return {
						get: (key: string, defaultValue?: unknown) => defaultValue,
					} as unknown as vscode.WorkspaceConfiguration;
				}
				return originalGetConfiguration(section);
			}) as unknown as typeof vscode.workspace.getConfiguration;

			const provider = new LiteLLMChatModelProvider(
				{
					get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
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

			global.fetch = originalFetch;
			vscode.workspace.getConfiguration = originalGetConfiguration;

			// Find the per-provider entry
			const providerEntry = infos.find((i) => i.id === "test-model:test-provider");
			assert.ok(providerEntry, "Provider entry should exist");
			assert.equal(providerEntry.maxOutputTokens, 16000, "Should use hardcoded default for max output tokens");
			assert.equal(providerEntry.maxInputTokens, 112000, "Should calculate with hardcoded defaults (128000 - 16000)");
		});

		test("aggregates minimum token constraints for cheapest/fastest entries", async () => {
			// Mock fetch to return model with multiple providers
			const originalFetch = global.fetch;
			global.fetch = async () =>
				({
					ok: true,
					json: async () => ({
						object: "list",
						data: [
							{
								id: "test-model",
								object: "model",
								created: 0,
								owned_by: "test",
								providers: [
									{
										provider: "provider-a",
										status: "active",
										supports_tools: true,
										context_length: 100000,
										max_output_tokens: 8000,
									},
									{
										provider: "provider-b",
										status: "active",
										supports_tools: true,
										context_length: 50000,
										max_output_tokens: 4000,
									},
								],
							},
						],
					}),
				}) as unknown as Response;

			const provider = new LiteLLMChatModelProvider(
				{
					get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
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

			global.fetch = originalFetch;

			// Find the cheapest/fastest entries
			const cheapestEntry = infos.find((i) => i.id === "test-model:cheapest");
			const fastestEntry = infos.find((i) => i.id === "test-model:fastest");

			assert.ok(cheapestEntry, "Cheapest entry should exist");
			assert.ok(fastestEntry, "Fastest entry should exist");

			// Should use minimum of both providers
			assert.equal(cheapestEntry.maxOutputTokens, 4000, "Should use minimum max_output_tokens");
			assert.equal(fastestEntry.maxOutputTokens, 4000, "Should use minimum max_output_tokens");
			assert.equal(cheapestEntry.maxInputTokens, 46000, "Should calculate with minimum context (50000 - 4000)");
		});

		test("provider max_output_tokens takes priority over max_tokens", async () => {
			// Mock fetch to return model with both max_output_tokens and max_tokens
			const originalFetch = global.fetch;
			global.fetch = async () =>
				({
					ok: true,
					json: async () => ({
						object: "list",
						data: [
							{
								id: "test-model",
								object: "model",
								created: 0,
								owned_by: "test",
								providers: [
									{
										provider: "test-provider",
										status: "active",
										supports_tools: true,
										context_length: 100000,
										max_tokens: 10000,
										max_output_tokens: 8000,
									},
								],
							},
						],
					}),
				}) as unknown as Response;

			const provider = new LiteLLMChatModelProvider(
				{
					get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
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

			global.fetch = originalFetch;

			// Find the per-provider entry
			const providerEntry = infos.find((i) => i.id === "test-model:test-provider");
			assert.ok(providerEntry, "Provider entry should exist");
			assert.equal(providerEntry.maxOutputTokens, 8000, "Should prefer max_output_tokens over max_tokens");
		});

		suite("modelParameters configuration", () => {
			test("exact model ID match returns parameters", async () => {
				const originalGetConfiguration = vscode.workspace.getConfiguration;
				vscode.workspace.getConfiguration = ((section?: string) => {
					if (section === "litellm-vscode-chat") {
						return {
							get: (key: string, defaultValue?: unknown) => {
								if (key === "modelParameters") {
									return {
										"gpt-4": {
											temperature: 0.8,
											max_tokens: 8000,
										},
									};
								}
								return defaultValue;
							},
						} as unknown as vscode.WorkspaceConfiguration;
					}
					return originalGetConfiguration(section);
				}) as unknown as typeof vscode.workspace.getConfiguration;

				// Access the private method through type assertion
				const provider = new LiteLLMChatModelProvider(
					{
						get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
						store: async () => {},
						delete: async () => {},
						onDidChange: (_listener: unknown) => ({ dispose() {} }),
					} as unknown as vscode.SecretStorage,
					"GitHubCopilotChat/test VSCode/test"
				);

				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const params = (provider as any).getModelParameters("gpt-4");

				vscode.workspace.getConfiguration = originalGetConfiguration;

				assert.deepEqual(params, { temperature: 0.8, max_tokens: 8000 });
			});

			test("prefix match returns parameters", async () => {
				const originalGetConfiguration = vscode.workspace.getConfiguration;
				vscode.workspace.getConfiguration = ((section?: string) => {
					if (section === "litellm-vscode-chat") {
						return {
							get: (key: string, defaultValue?: unknown) => {
								if (key === "modelParameters") {
									return {
										"gpt-4": {
											temperature: 0.7,
										},
									};
								}
								return defaultValue;
							},
						} as unknown as vscode.WorkspaceConfiguration;
					}
					return originalGetConfiguration(section);
				}) as unknown as typeof vscode.workspace.getConfiguration;

				const provider = new LiteLLMChatModelProvider(
					{
						get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
						store: async () => {},
						delete: async () => {},
						onDidChange: (_listener: unknown) => ({ dispose() {} }),
					} as unknown as vscode.SecretStorage,
					"GitHubCopilotChat/test VSCode/test"
				);

				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const params = (provider as any).getModelParameters("gpt-4-turbo:openai");

				vscode.workspace.getConfiguration = originalGetConfiguration;

				assert.deepEqual(params, { temperature: 0.7 });
			});

			test("longest prefix match takes precedence", async () => {
				const originalGetConfiguration = vscode.workspace.getConfiguration;
				vscode.workspace.getConfiguration = ((section?: string) => {
					if (section === "litellm-vscode-chat") {
						return {
							get: (key: string, defaultValue?: unknown) => {
								if (key === "modelParameters") {
									return {
										gpt: {
											temperature: 0.5,
										},
										"gpt-4": {
											temperature: 0.7,
										},
										"gpt-4-turbo": {
											temperature: 0.9,
										},
									};
								}
								return defaultValue;
							},
						} as unknown as vscode.WorkspaceConfiguration;
					}
					return originalGetConfiguration(section);
				}) as unknown as typeof vscode.workspace.getConfiguration;

				const provider = new LiteLLMChatModelProvider(
					{
						get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
						store: async () => {},
						delete: async () => {},
						onDidChange: (_listener: unknown) => ({ dispose() {} }),
					} as unknown as vscode.SecretStorage,
					"GitHubCopilotChat/test VSCode/test"
				);

				// Should match "gpt-4-turbo" (length 12) over "gpt-4" (length 5) and "gpt" (length 3)
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const params = (provider as any).getModelParameters("gpt-4-turbo:fastest");

				vscode.workspace.getConfiguration = originalGetConfiguration;

				assert.deepEqual(params, { temperature: 0.9 });
			});

			test("no match returns empty object", async () => {
				const originalGetConfiguration = vscode.workspace.getConfiguration;
				vscode.workspace.getConfiguration = ((section?: string) => {
					if (section === "litellm-vscode-chat") {
						return {
							get: (key: string, defaultValue?: unknown) => {
								if (key === "modelParameters") {
									return {
										"gpt-4": {
											temperature: 0.7,
										},
									};
								}
								return defaultValue;
							},
						} as unknown as vscode.WorkspaceConfiguration;
					}
					return originalGetConfiguration(section);
				}) as unknown as typeof vscode.workspace.getConfiguration;

				const provider = new LiteLLMChatModelProvider(
					{
						get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
						store: async () => {},
						delete: async () => {},
						onDidChange: (_listener: unknown) => ({ dispose() {} }),
					} as unknown as vscode.SecretStorage,
					"GitHubCopilotChat/test VSCode/test"
				);

				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const params = (provider as any).getModelParameters("claude-opus");

				vscode.workspace.getConfiguration = originalGetConfiguration;

				assert.deepEqual(params, {});
			});

			test("empty configuration returns empty object", async () => {
				const originalGetConfiguration = vscode.workspace.getConfiguration;
				vscode.workspace.getConfiguration = ((section?: string) => {
					if (section === "litellm-vscode-chat") {
						return {
							get: (key: string, defaultValue?: unknown) => defaultValue,
						} as unknown as vscode.WorkspaceConfiguration;
					}
					return originalGetConfiguration(section);
				}) as unknown as typeof vscode.workspace.getConfiguration;

				const provider = new LiteLLMChatModelProvider(
					{
						get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
						store: async () => {},
						delete: async () => {},
						onDidChange: (_listener: unknown) => ({ dispose() {} }),
					} as unknown as vscode.SecretStorage,
					"GitHubCopilotChat/test VSCode/test"
				);

				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const params = (provider as any).getModelParameters("gpt-4");

				vscode.workspace.getConfiguration = originalGetConfiguration;

				assert.deepEqual(params, {});
			});

			test("modelParameters supports various parameter types", async () => {
				const originalGetConfiguration = vscode.workspace.getConfiguration;
				vscode.workspace.getConfiguration = ((section?: string) => {
					if (section === "litellm-vscode-chat") {
						return {
							get: (key: string, defaultValue?: unknown) => {
								if (key === "modelParameters") {
									return {
										"test-model": {
											temperature: 0.8,
											max_tokens: 4096,
											top_p: 0.9,
											frequency_penalty: 0.5,
											presence_penalty: 0.3,
											stop: ["END", "STOP"],
										},
									};
								}
								return defaultValue;
							},
						} as unknown as vscode.WorkspaceConfiguration;
					}
					return originalGetConfiguration(section);
				}) as unknown as typeof vscode.workspace.getConfiguration;

				const provider = new LiteLLMChatModelProvider(
					{
						get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
						store: async () => {},
						delete: async () => {},
						onDidChange: (_listener: unknown) => ({ dispose() {} }),
					} as unknown as vscode.SecretStorage,
					"GitHubCopilotChat/test VSCode/test"
				);

				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const params = (provider as any).getModelParameters("test-model");

				vscode.workspace.getConfiguration = originalGetConfiguration;

				assert.deepEqual(params, {
					temperature: 0.8,
					max_tokens: 4096,
					top_p: 0.9,
					frequency_penalty: 0.5,
					presence_penalty: 0.3,
					stop: ["END", "STOP"],
				});
			});
		});

		suite("diagnostics", () => {
			test("status callback reports successful fetch with model count", async () => {
				const originalFetch = global.fetch;
				global.fetch = async () =>
					({
						ok: true,
						json: async () => ({
							object: "list",
							data: [
								{
									id: "model-1",
									object: "model",
									created: 0,
									owned_by: "test",
									providers: [
										{
											provider: "test-provider",
											status: "active",
											supports_tools: true,
										},
									],
								},
								{
									id: "model-2",
									object: "model",
									created: 0,
									owned_by: "test",
									providers: [
										{
											provider: "test-provider",
											status: "active",
											supports_tools: true,
										},
									],
								},
							],
						}),
					}) as unknown as Response;

				const provider = new LiteLLMChatModelProvider(
					{
						get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
						store: async () => {},
						delete: async () => {},
						onDidChange: (_listener: unknown) => ({ dispose() {} }),
					} as unknown as vscode.SecretStorage,
					"GitHubCopilotChat/test VSCode/test"
				);

				let callbackModelCount: number | undefined;
				let callbackError: string | undefined;

				provider.setStatusCallback((modelCount: number, error?: string) => {
					callbackModelCount = modelCount;
					callbackError = error;
				});

				await provider.prepareLanguageModelChatInformation(
					{ silent: true },
					new vscode.CancellationTokenSource().token
				);

				global.fetch = originalFetch;

				// Should report success with 6 model entries (2 models × 3 entries each: cheapest, fastest, provider-specific)
				assert.equal(typeof callbackModelCount, "number");
				assert.ok(callbackModelCount && callbackModelCount > 0, "Should report positive model count");
				assert.equal(callbackError, undefined, "Should not report error on success");
			});

			test("status callback reports error on fetch failure", async () => {
				const originalFetch = global.fetch;
				global.fetch = async () => {
					throw new Error("Network error");
				};

				const provider = new LiteLLMChatModelProvider(
					{
						get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
						store: async () => {},
						delete: async () => {},
						onDidChange: (_listener: unknown) => ({ dispose() {} }),
					} as unknown as vscode.SecretStorage,
					"GitHubCopilotChat/test VSCode/test"
				);

				let callbackModelCount: number | undefined;
				let callbackError: string | undefined;

				provider.setStatusCallback((modelCount: number, error?: string) => {
					callbackModelCount = modelCount;
					callbackError = error;
				});

				await provider.prepareLanguageModelChatInformation(
					{ silent: true },
					new vscode.CancellationTokenSource().token
				);

				global.fetch = originalFetch;

				assert.equal(callbackModelCount, 0, "Should report 0 models on error");
				assert.equal(typeof callbackError, "string", "Should report error message");
				assert.ok(callbackError && callbackError.includes("Network"), "Error message should mention network");
			});

			test("status callback reports empty model list", async () => {
				const originalFetch = global.fetch;
				global.fetch = async () =>
					({
						ok: true,
						json: async () => ({
							object: "list",
							data: [],
						}),
					}) as unknown as Response;

				const provider = new LiteLLMChatModelProvider(
					{
						get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
						store: async () => {},
						delete: async () => {},
						onDidChange: (_listener: unknown) => ({ dispose() {} }),
					} as unknown as vscode.SecretStorage,
					"GitHubCopilotChat/test VSCode/test"
				);

				let callbackModelCount: number | undefined;
				let callbackError: string | undefined;

				provider.setStatusCallback((modelCount: number, error?: string) => {
					callbackModelCount = modelCount;
					callbackError = error;
				});

				await provider.prepareLanguageModelChatInformation(
					{ silent: true },
					new vscode.CancellationTokenSource().token
				);

				global.fetch = originalFetch;

				assert.equal(callbackModelCount, 0, "Should report 0 models");
				assert.equal(typeof callbackError, "string", "Should report error for empty list");
				assert.ok(callbackError && callbackError.includes("0 models"), "Error should mention 0 models");
			});

			test("status callback reports missing configuration", async () => {
				const provider = new LiteLLMChatModelProvider(
					{
						get: async () => undefined,
						store: async () => {},
						delete: async () => {},
						onDidChange: (_listener: unknown) => ({ dispose() {} }),
					} as unknown as vscode.SecretStorage,
					"GitHubCopilotChat/test VSCode/test"
				);

				let callbackModelCount: number | undefined;
				let callbackError: string | undefined;

				provider.setStatusCallback((modelCount: number, error?: string) => {
					callbackModelCount = modelCount;
					callbackError = error;
				});

				await provider.prepareLanguageModelChatInformation(
					{ silent: true },
					new vscode.CancellationTokenSource().token
				);

				assert.equal(callbackModelCount, 0, "Should report 0 models");
				assert.equal(typeof callbackError, "string", "Should report error");
				assert.ok(callbackError && callbackError.includes("Not configured"), "Error should mention not configured");
			});

			test("output channel receives log messages", async () => {
				const logs: string[] = [];
				const mockOutputChannel = {
					appendLine: (message: string) => logs.push(message),
					show: () => {},
					dispose: () => {},
				} as unknown as vscode.OutputChannel;

				const provider = new LiteLLMChatModelProvider(
					{
						get: async () => undefined,
						store: async () => {},
						delete: async () => {},
						onDidChange: (_listener: unknown) => ({ dispose() {} }),
					} as unknown as vscode.SecretStorage,
					"GitHubCopilotChat/test VSCode/test",
					mockOutputChannel
				);

				await provider.prepareLanguageModelChatInformation(
					{ silent: true },
					new vscode.CancellationTokenSource().token
				);

				assert.ok(logs.length > 0, "Should log messages");
				assert.ok(
					logs.some((log) => log.includes("ensureConfig")),
					"Should log ensureConfig call"
				);
				assert.ok(
					logs.some((log) => log.includes("No config found")),
					"Should log missing config"
				);
			});

			test("output channel receives error logs with timestamps", async () => {
				const originalFetch = global.fetch;
				global.fetch = async () => {
					throw new Error("Test error");
				};

				const logs: string[] = [];
				const mockOutputChannel = {
					appendLine: (message: string) => logs.push(message),
					show: () => {},
					dispose: () => {},
				} as unknown as vscode.OutputChannel;

				const provider = new LiteLLMChatModelProvider(
					{
						get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
						store: async () => {},
						delete: async () => {},
						onDidChange: (_listener: unknown) => ({ dispose() {} }),
					} as unknown as vscode.SecretStorage,
					"GitHubCopilotChat/test VSCode/test",
					mockOutputChannel
				);

				await provider.prepareLanguageModelChatInformation(
					{ silent: true },
					new vscode.CancellationTokenSource().token
				);

				global.fetch = originalFetch;

				assert.ok(logs.length > 0, "Should log messages");
				assert.ok(
					logs.some((log) => log.includes("ERROR")),
					"Should log error"
				);
				assert.ok(
					logs.some((log) => log.includes("Test error")),
					"Should include error message"
				);
				assert.ok(
					logs.some((log) => /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(log)),
					"Should include timestamps"
				);
			});
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

	suite("model info and fallback", () => {
		test("fallback from /v1/model/info to /v1/models on error", async () => {
			const originalFetch = global.fetch;
			let modelInfoAttempted = false;
			let modelsAttempted = false;

			global.fetch = async (url: string | URL | Request) => {
				const urlStr = url.toString();
				if (urlStr.includes("/v1/model/info")) {
					modelInfoAttempted = true;
					throw new Error("model/info endpoint failed");
				}
				if (urlStr.includes("/v1/models")) {
					modelsAttempted = true;
					return {
						ok: true,
						json: async () => ({
							object: "list",
							data: [
								{
									id: "test-model",
									object: "model",
									created: 0,
									owned_by: "test",
								},
							],
						}),
					} as unknown as Response;
				}
				throw new Error("Unexpected URL");
			};

			const provider = new LiteLLMChatModelProvider(
				{
					get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
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

			global.fetch = originalFetch;

			assert.ok(modelInfoAttempted, "Should attempt /v1/model/info first");
			assert.ok(modelsAttempted, "Should fallback to /v1/models on error");
			assert.ok(infos.length > 0, "Should still return models from fallback");
		});

		test("prompt caching support detected from model/info", async () => {
			const originalFetch = global.fetch;
			global.fetch = async () =>
				({
					ok: true,
					json: async () => ({
						data: [
							{
								model_name: "claude-3-5-sonnet-20241022",
								model_info: {
									id: "claude-3-5-sonnet-20241022",
									supports_function_calling: true,
									supports_prompt_caching: true,
									max_tokens: 8192,
									max_input_tokens: 200000,
								},
							},
						],
					}),
				}) as unknown as Response;

			const provider = new LiteLLMChatModelProvider(
				{
					get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
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

			global.fetch = originalFetch;

			assert.ok(infos.length > 0, "Should return models");
			// Access private _promptCachingSupport to verify
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const cachingSupport = (provider as any)._promptCachingSupport;
			assert.equal(cachingSupport.get("claude-3-5-sonnet-20241022"), true, "Should detect prompt caching support");
		});

		test("prompt caching disabled for models without support", async () => {
			const originalFetch = global.fetch;
			global.fetch = async () =>
				({
					ok: true,
					json: async () => ({
						data: [
							{
								model_name: "gpt-4",
								model_info: {
									id: "gpt-4",
									supports_function_calling: true,
									supports_prompt_caching: false,
									max_tokens: 8192,
								},
							},
						],
					}),
				}) as unknown as Response;

			const provider = new LiteLLMChatModelProvider(
				{
					get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
					store: async () => {},
					delete: async () => {},
					onDidChange: (_listener: unknown) => ({ dispose() {} }),
				} as unknown as vscode.SecretStorage,
				"GitHubCopilotChat/test VSCode/test"
			);

			await provider.prepareLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token);

			global.fetch = originalFetch;

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const cachingSupport = (provider as any)._promptCachingSupport;
			assert.equal(cachingSupport.get("gpt-4"), false, "Should mark as not supporting prompt caching");
		});

		test("model ID extracted with fallback priority", async () => {
			const originalFetch = global.fetch;
			global.fetch = async () =>
				({
					ok: true,
					json: async () => ({
						data: [
							{
								model_name: "preferred-name",
								litellm_params: { model: "fallback-name" },
								model_info: {
									key: "third-choice",
									id: "last-resort",
								},
							},
						],
					}),
				}) as unknown as Response;

			const provider = new LiteLLMChatModelProvider(
				{
					get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
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

			global.fetch = originalFetch;

			const modelEntry = infos.find((i) => i.id === "preferred-name");
			assert.ok(modelEntry, "Should use model_name as first priority");
		});
	});
});
