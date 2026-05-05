import * as assert from "assert";
import * as vscode from "vscode";
import { LiteLLMChatModelProvider } from "../provider";
import type { AggregatedStatus } from "../provider";
import { convertMessages, convertTools, validateRequest, tryParseJSONObject } from "../utils";
import { findLongestPrefixMatch, getModelDefaults } from "../modelDefaults";
import { IssueReporter, redactSecrets } from "../issueReporter";
import type { DiagnosticsSnapshot } from "../issueReporter";

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

		test("provideTokenCount estimates tokens for image parts", async () => {
			const provider = new LiteLLMChatModelProvider(
				{
					get: async () => undefined,
					store: async () => {},
					delete: async () => {},
					onDidChange: (_listener: unknown) => ({ dispose() {} }),
				} as unknown as vscode.SecretStorage,
				"GitHubCopilotChat/test VSCode/test"
			);
			const imageData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
			const msg: vscode.LanguageModelChatMessage = {
				role: vscode.LanguageModelChatMessageRole.User,
				content: [
					new vscode.LanguageModelTextPart("describe"),
					new vscode.LanguageModelDataPart(imageData, "image/png"),
				],
				name: undefined,
			};
			const est = await provider.provideTokenCount(
				{
					id: "m",
					name: "m",
					family: "litellm",
					version: "1.0.0",
					maxInputTokens: 100000,
					maxOutputTokens: 1000,
					capabilities: {},
				} as unknown as vscode.LanguageModelChatInformation,
				msg,
				new vscode.CancellationTokenSource().token
			);
			// Should include both text tokens (~2) and image tokens (765)
			assert.ok(est >= 765, `Should estimate at least 765 tokens for the image, got ${est}`);
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
			const originalGetConfiguration = vscode.workspace.getConfiguration;
			try {
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

				// Find the per-provider entry
				const providerEntry = infos.find((i) => i.id === "test-model:test-provider");
				assert.ok(providerEntry, "Provider entry should exist");
				assert.equal(providerEntry.maxOutputTokens, 20000, "Should use workspace setting for max output tokens");
				assert.equal(providerEntry.maxInputTokens, 180000, "Should calculate max input as context - output");
			} finally {
				global.fetch = originalFetch;
				vscode.workspace.getConfiguration = originalGetConfiguration;
			}
		});

		test("uses configured defaultMaxInputTokens as an explicit override", async () => {
			const originalFetch = global.fetch;
			const originalGetConfiguration = vscode.workspace.getConfiguration;
			try {
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

				const providerEntry = infos.find((i) => i.id === "test-model:test-provider");
				assert.ok(providerEntry, "Provider entry should exist");
				assert.equal(providerEntry.maxInputTokens, 50000, "Should use configured max input token override");
			} finally {
				global.fetch = originalFetch;
				vscode.workspace.getConfiguration = originalGetConfiguration;
			}
		});

		test("treats null provider max_input_tokens as missing and falls back to workspace setting", async () => {
			const originalFetch = global.fetch;
			const originalGetConfiguration = vscode.workspace.getConfiguration;
			try {
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

				const providerEntry = infos.find((i) => i.id === "test-model:test-provider");
				assert.ok(providerEntry, "Provider entry should exist");
				assert.equal(providerEntry.maxInputTokens, 48000, "Should ignore null provider max_input_tokens");
			} finally {
				global.fetch = originalFetch;
				vscode.workspace.getConfiguration = originalGetConfiguration;
			}
		});

		test("uses hardcoded defaults when provider and settings absent", async () => {
			const originalFetch = global.fetch;
			const originalGetConfiguration = vscode.workspace.getConfiguration;
			try {
				// Mock fetch to return model without token constraints
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
				vscode.workspace.getConfiguration = ((section?: string) => {
					if (section === "litellm-vscode-chat") {
						return {
							get: (_key: string, defaultValue?: unknown) => defaultValue,
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

				// Find the per-provider entry
				const providerEntry = infos.find((i) => i.id === "test-model:test-provider");
				assert.ok(providerEntry, "Provider entry should exist");
				assert.equal(providerEntry.maxOutputTokens, 16000, "Should use hardcoded default for max output tokens");
				assert.equal(providerEntry.maxInputTokens, 112000, "Should calculate with hardcoded defaults (128000 - 16000)");
			} finally {
				global.fetch = originalFetch;
				vscode.workspace.getConfiguration = originalGetConfiguration;
			}
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

		suite("request body construction", () => {
			function createConfiguredProvider(): LiteLLMChatModelProvider {
				return new LiteLLMChatModelProvider(
					{
						get: async (key: string) => (key === "litellm.baseUrl" ? "http://test" : "test-key"),
						store: async () => {},
						delete: async () => {},
						onDidChange: (_listener: unknown) => ({ dispose() {} }),
					} as unknown as vscode.SecretStorage,
					"GitHubCopilotChat/test VSCode/test"
				);
			}

			const modelInfo = {
				id: "test-model",
				name: "test-model",
				family: "litellm",
				version: "1.0.0",
				maxInputTokens: 100000,
				maxOutputTokens: 8000,
				capabilities: {},
			} as unknown as vscode.LanguageModelChatInformation;

			function sseStream(text: string): ReadableStream<Uint8Array> {
				const chunk = `data: ${JSON.stringify({
					choices: [{ delta: { content: text }, finish_reason: "stop" }],
				})}\n\ndata: [DONE]\n\n`;
				return new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(chunk));
						controller.close();
					},
				});
			}

			test("filters underscore-prefixed internal keys from modelOptions", async () => {
				const originalFetch = global.fetch;
				let capturedBody: Record<string, unknown> | undefined;

				global.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
					capturedBody = JSON.parse(init?.body as string);
					return {
						ok: true,
						body: sseStream("hello"),
					} as unknown as Response;
				};

				const provider = createConfiguredProvider();
				// Force config to be loaded
				await provider.prepareLanguageModelChatInformation(
					{ silent: true },
					new vscode.CancellationTokenSource().token
				);

				await provider.provideLanguageModelChatResponse(
					modelInfo,
					[
						{
							role: vscode.LanguageModelChatMessageRole.User,
							content: [new vscode.LanguageModelTextPart("hello")],
							name: undefined,
						},
					],
					{
						toolMode: vscode.LanguageModelChatToolMode.Auto,
						modelOptions: {
							temperature: 0.5,
							seed: 42,
							_capturingTokenCorrelationId: "some-internal-id",
							_otherInternalField: true,
						},
					} as unknown as vscode.ProvideLanguageModelChatResponseOptions,
					{ report: () => {} },
					new vscode.CancellationTokenSource().token
				);

				global.fetch = originalFetch;

				assert.ok(capturedBody, "Should have captured request body");
				assert.equal(capturedBody!.temperature, 0.5, "Should forward temperature");
				assert.equal(capturedBody!.seed, 42, "Should forward seed");
				assert.equal(
					capturedBody!._capturingTokenCorrelationId,
					undefined,
					"Should NOT forward _capturingTokenCorrelationId"
				);
				assert.equal(capturedBody!._otherInternalField, undefined, "Should NOT forward _otherInternalField");
			});

			test("forwards valid modelOptions like response_format and reasoning_effort", async () => {
				const originalFetch = global.fetch;
				let capturedBody: Record<string, unknown> | undefined;

				global.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
					capturedBody = JSON.parse(init?.body as string);
					return {
						ok: true,
						body: sseStream("ok"),
					} as unknown as Response;
				};

				const provider = createConfiguredProvider();
				await provider.prepareLanguageModelChatInformation(
					{ silent: true },
					new vscode.CancellationTokenSource().token
				);

				await provider.provideLanguageModelChatResponse(
					modelInfo,
					[
						{
							role: vscode.LanguageModelChatMessageRole.User,
							content: [new vscode.LanguageModelTextPart("test")],
							name: undefined,
						},
					],
					{
						toolMode: vscode.LanguageModelChatToolMode.Auto,
						modelOptions: {
							response_format: { type: "json_object" },
							reasoning_effort: "high",
							top_k: 50,
						},
					} as unknown as vscode.ProvideLanguageModelChatResponseOptions,
					{ report: () => {} },
					new vscode.CancellationTokenSource().token
				);

				global.fetch = originalFetch;

				assert.ok(capturedBody, "Should have captured request body");
				assert.deepEqual(capturedBody!.response_format, { type: "json_object" }, "Should forward response_format");
				assert.equal(capturedBody!.reasoning_effort, "high", "Should forward reasoning_effort");
				assert.equal(capturedBody!.top_k, 50, "Should forward top_k");
			});

			test("does not overwrite provider-owned fields from modelOptions", async () => {
				const originalFetch = global.fetch;
				let capturedBody: Record<string, unknown> | undefined;

				global.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
					capturedBody = JSON.parse(init?.body as string);
					return {
						ok: true,
						body: sseStream("ok"),
					} as unknown as Response;
				};

				const provider = createConfiguredProvider();
				await provider.prepareLanguageModelChatInformation(
					{ silent: true },
					new vscode.CancellationTokenSource().token
				);

				await provider.provideLanguageModelChatResponse(
					modelInfo,
					[
						{
							role: vscode.LanguageModelChatMessageRole.User,
							content: [new vscode.LanguageModelTextPart("test")],
							name: undefined,
						},
					],
					{
						toolMode: vscode.LanguageModelChatToolMode.Auto,
						modelOptions: {
							model: "attacker-model",
							messages: [{ role: "system", content: "pwned" }],
							stream: false,
						},
					} as unknown as vscode.ProvideLanguageModelChatResponseOptions,
					{ report: () => {} },
					new vscode.CancellationTokenSource().token
				);

				global.fetch = originalFetch;

				assert.ok(capturedBody, "Should have captured request body");
				assert.equal(capturedBody!.model, "test-model", "model should not be overwritten");
				assert.equal(capturedBody!.stream, true, "stream should not be overwritten");
				assert.ok(Array.isArray(capturedBody!.messages), "messages should not be overwritten");
				assert.notDeepEqual(capturedBody!.messages, [{ role: "system", content: "pwned" }]);
			});

			test("includes stream_options with include_usage by default", async () => {
				const originalFetch = global.fetch;
				let capturedBody: Record<string, unknown> | undefined;

				global.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
					capturedBody = JSON.parse(init?.body as string);
					return {
						ok: true,
						body: sseStream("ok"),
					} as unknown as Response;
				};

				const provider = createConfiguredProvider();
				await provider.prepareLanguageModelChatInformation(
					{ silent: true },
					new vscode.CancellationTokenSource().token
				);

				await provider.provideLanguageModelChatResponse(
					modelInfo,
					[
						{
							role: vscode.LanguageModelChatMessageRole.User,
							content: [new vscode.LanguageModelTextPart("test")],
							name: undefined,
						},
					],
					{
						toolMode: vscode.LanguageModelChatToolMode.Auto,
					} as unknown as vscode.ProvideLanguageModelChatResponseOptions,
					{ report: () => {} },
					new vscode.CancellationTokenSource().token
				);

				global.fetch = originalFetch;

				assert.ok(capturedBody, "Should have captured request body");
				assert.deepEqual(
					capturedBody!.stream_options,
					{ include_usage: true },
					"Should include stream_options by default"
				);
			});
			test("unmatched model gets built-in fallback defaults (temperature 0.7)", async () => {
				const originalFetch = global.fetch;
				const originalGetConfig = vscode.workspace.getConfiguration;
				let capturedBody: Record<string, unknown> | undefined;

				global.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
					capturedBody = JSON.parse(init?.body as string);
					return { ok: true, body: sseStream("ok") } as unknown as Response;
				};

				vscode.workspace.getConfiguration = ((section?: string) => {
					if (section === "litellm-vscode-chat") {
						return {
							get: (key: string) => {
								if (key === "modelParameters") {
									return {};
								}
								return undefined;
							},
						};
					}
					return originalGetConfig(section!);
				}) as typeof vscode.workspace.getConfiguration;

				try {
					const provider = createConfiguredProvider();
					await provider.prepareLanguageModelChatInformation(
						{ silent: true },
						new vscode.CancellationTokenSource().token
					);
					await provider.provideLanguageModelChatResponse(
						modelInfo,
						[
							{
								role: vscode.LanguageModelChatMessageRole.User,
								content: [new vscode.LanguageModelTextPart("test")],
								name: undefined,
							},
						],
						{
							toolMode: vscode.LanguageModelChatToolMode.Auto,
						} as unknown as vscode.ProvideLanguageModelChatResponseOptions,
						{ report: () => {} },
						new vscode.CancellationTokenSource().token
					);
					assert.ok(capturedBody, "Should have captured request body");
					assert.strictEqual(capturedBody!.temperature, 0.7, "Should include default temperature 0.7");
				} finally {
					global.fetch = originalFetch;
					vscode.workspace.getConfiguration = originalGetConfig;
				}
			});

			test("gpt-5.5 model gets no built-in temperature", async () => {
				const originalFetch = global.fetch;
				const originalGetConfig = vscode.workspace.getConfiguration;
				let capturedBody: Record<string, unknown> | undefined;

				global.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
					capturedBody = JSON.parse(init?.body as string);
					return { ok: true, body: sseStream("ok") } as unknown as Response;
				};

				vscode.workspace.getConfiguration = ((section?: string) => {
					if (section === "litellm-vscode-chat") {
						return {
							get: (key: string) => {
								if (key === "modelParameters") {
									return {};
								}
								return undefined;
							},
						};
					}
					return originalGetConfig(section!);
				}) as typeof vscode.workspace.getConfiguration;

				const gpt55Model = { ...modelInfo, id: "gpt-5.5:openai" };

				try {
					const provider = createConfiguredProvider();
					await provider.prepareLanguageModelChatInformation(
						{ silent: true },
						new vscode.CancellationTokenSource().token
					);
					await provider.provideLanguageModelChatResponse(
						gpt55Model,
						[
							{
								role: vscode.LanguageModelChatMessageRole.User,
								content: [new vscode.LanguageModelTextPart("test")],
								name: undefined,
							},
						],
						{
							toolMode: vscode.LanguageModelChatToolMode.Auto,
						} as unknown as vscode.ProvideLanguageModelChatResponseOptions,
						{ report: () => {} },
						new vscode.CancellationTokenSource().token
					);
					assert.ok(capturedBody, "Should have captured request body");
					assert.strictEqual(capturedBody!.temperature, undefined, "gpt-5.5 should not have temperature");
				} finally {
					global.fetch = originalFetch;
					vscode.workspace.getConfiguration = originalGetConfig;
				}
			});

			test("_replaceDefaults: true skips codebase defaults", async () => {
				const originalFetch = global.fetch;
				const originalGetConfig = vscode.workspace.getConfiguration;
				let capturedBody: Record<string, unknown> | undefined;

				global.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
					capturedBody = JSON.parse(init?.body as string);
					return { ok: true, body: sseStream("ok") } as unknown as Response;
				};

				vscode.workspace.getConfiguration = ((section?: string) => {
					if (section === "litellm-vscode-chat") {
						return {
							get: (key: string) => {
								if (key === "modelParameters") {
									return { "test-model": { _replaceDefaults: true, top_p: 0.9 } };
								}
								return undefined;
							},
						};
					}
					return originalGetConfig(section!);
				}) as typeof vscode.workspace.getConfiguration;

				try {
					const provider = createConfiguredProvider();
					await provider.prepareLanguageModelChatInformation(
						{ silent: true },
						new vscode.CancellationTokenSource().token
					);
					await provider.provideLanguageModelChatResponse(
						modelInfo,
						[
							{
								role: vscode.LanguageModelChatMessageRole.User,
								content: [new vscode.LanguageModelTextPart("test")],
								name: undefined,
							},
						],
						{
							toolMode: vscode.LanguageModelChatToolMode.Auto,
						} as unknown as vscode.ProvideLanguageModelChatResponseOptions,
						{ report: () => {} },
						new vscode.CancellationTokenSource().token
					);
					assert.ok(capturedBody, "Should have captured request body");
					assert.strictEqual(
						capturedBody!.temperature,
						undefined,
						"Should not have default temperature when _replaceDefaults is true"
					);
					assert.strictEqual(capturedBody!.top_p, 0.9, "Should have user-specified top_p");
					assert.strictEqual(capturedBody!._replaceDefaults, undefined, "_replaceDefaults must not appear in request");
				} finally {
					global.fetch = originalFetch;
					vscode.workspace.getConfiguration = originalGetConfig;
				}
			});

			test("user config without _replaceDefaults merges onto codebase defaults", async () => {
				const originalFetch = global.fetch;
				const originalGetConfig = vscode.workspace.getConfiguration;
				let capturedBody: Record<string, unknown> | undefined;

				global.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
					capturedBody = JSON.parse(init?.body as string);
					return { ok: true, body: sseStream("ok") } as unknown as Response;
				};

				vscode.workspace.getConfiguration = ((section?: string) => {
					if (section === "litellm-vscode-chat") {
						return {
							get: (key: string) => {
								if (key === "modelParameters") {
									return { "test-model": { top_p: 0.8 } };
								}
								return undefined;
							},
						};
					}
					return originalGetConfig(section!);
				}) as typeof vscode.workspace.getConfiguration;

				try {
					const provider = createConfiguredProvider();
					await provider.prepareLanguageModelChatInformation(
						{ silent: true },
						new vscode.CancellationTokenSource().token
					);
					await provider.provideLanguageModelChatResponse(
						modelInfo,
						[
							{
								role: vscode.LanguageModelChatMessageRole.User,
								content: [new vscode.LanguageModelTextPart("test")],
								name: undefined,
							},
						],
						{
							toolMode: vscode.LanguageModelChatToolMode.Auto,
						} as unknown as vscode.ProvideLanguageModelChatResponseOptions,
						{ report: () => {} },
						new vscode.CancellationTokenSource().token
					);
					assert.ok(capturedBody, "Should have captured request body");
					assert.strictEqual(capturedBody!.temperature, 0.7, "Should keep default temperature when merging");
					assert.strictEqual(capturedBody!.top_p, 0.8, "Should have user-specified top_p");
				} finally {
					global.fetch = originalFetch;
					vscode.workspace.getConfiguration = originalGetConfig;
				}
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

				let callbackStatus: AggregatedStatus | undefined;

				provider.setStatusCallback((status: AggregatedStatus) => {
					callbackStatus = status;
				});

				await provider.prepareLanguageModelChatInformation(
					{ silent: true },
					new vscode.CancellationTokenSource().token
				);

				global.fetch = originalFetch;

				// Should report success with 6 model entries (2 models × 3 entries each: cheapest, fastest, provider-specific)
				assert.ok(callbackStatus, "Should have received status callback");
				assert.ok(callbackStatus!.totalModels > 0, "Should report positive model count");
				assert.ok(
					callbackStatus!.serverStatuses.every((s) => s.state === "ok"),
					"All servers should be ok"
				);
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

				let callbackStatus: AggregatedStatus | undefined;

				provider.setStatusCallback((status: AggregatedStatus) => {
					callbackStatus = status;
				});

				await provider.prepareLanguageModelChatInformation(
					{ silent: true },
					new vscode.CancellationTokenSource().token
				);

				global.fetch = originalFetch;

				assert.ok(callbackStatus, "Should have received status callback");
				assert.equal(callbackStatus!.totalModels, 0, "Should report 0 models on error");
				assert.ok(
					callbackStatus!.serverStatuses.some((s) => s.state === "error"),
					"Should have error status"
				);
				assert.ok(
					callbackStatus!.serverStatuses.some((s) => s.error?.includes("Network")),
					"Error message should mention network"
				);
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

				let callbackStatus: AggregatedStatus | undefined;

				provider.setStatusCallback((status: AggregatedStatus) => {
					callbackStatus = status;
				});

				await provider.prepareLanguageModelChatInformation(
					{ silent: true },
					new vscode.CancellationTokenSource().token
				);

				global.fetch = originalFetch;

				assert.ok(callbackStatus, "Should have received status callback");
				assert.equal(callbackStatus!.totalModels, 0, "Should report 0 models");
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

				let callbackStatus: AggregatedStatus | undefined;

				provider.setStatusCallback((status: AggregatedStatus) => {
					callbackStatus = status;
				});

				await provider.prepareLanguageModelChatInformation(
					{ silent: true },
					new vscode.CancellationTokenSource().token
				);

				assert.ok(callbackStatus, "Should have received status callback");
				assert.equal(callbackStatus!.totalModels, 0, "Should report 0 models");
				assert.equal(callbackStatus!.serverStatuses.length, 0, "Should have no server statuses");
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
					logs.some((log) => log.includes("No") && (log.includes("config") || log.includes("servers"))),
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

		test("converts user message with image to array content", () => {
			const imageData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
			const dataPart = new vscode.LanguageModelDataPart(imageData, "image/png");
			const messages: vscode.LanguageModelChatMessage[] = [
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [new vscode.LanguageModelTextPart("What is in this image?"), dataPart],
					name: undefined,
				},
			];
			const out = convertMessages(messages);
			assert.equal(out.length, 1);
			assert.equal(out[0].role, "user");
			assert.ok(Array.isArray(out[0].content), "content should be an array when images present");
			const content = out[0].content as Array<{ type: string }>;
			assert.equal(content.length, 2);
			assert.equal(content[0].type, "text");
			assert.equal(content[1].type, "image_url");
			const imageBlock = content[1] as { type: string; image_url: { url: string } };
			assert.ok(imageBlock.image_url.url.startsWith("data:image/png;base64,"));
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

		test("image-only user message produces array content", () => {
			const imageData = new Uint8Array([0xff, 0xd8, 0xff]);
			const dataPart = new vscode.LanguageModelDataPart(imageData, "image/jpeg");
			const messages: vscode.LanguageModelChatMessage[] = [
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [dataPart],
					name: undefined,
				},
			];
			const out = convertMessages(messages);
			assert.equal(out.length, 1);
			const content = out[0].content as Array<{ type: string }>;
			assert.ok(Array.isArray(content));
			assert.equal(content.length, 1);
			assert.equal(content[0].type, "image_url");
		});

		test("handles multiple images in a single user message", () => {
			const img1 = new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), "image/png");
			const img2 = new vscode.LanguageModelDataPart(new Uint8Array([4, 5, 6]), "image/jpeg");
			const messages: vscode.LanguageModelChatMessage[] = [
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [new vscode.LanguageModelTextPart("Compare these:"), img1, img2],
					name: undefined,
				},
			];
			const out = convertMessages(messages);
			const content = out[0].content as Array<{ type: string }>;
			assert.ok(Array.isArray(content));
			assert.equal(content.length, 3); // 1 text + 2 images
			assert.equal(content[0].type, "text");
			assert.equal(content[1].type, "image_url");
			assert.equal(content[2].type, "image_url");
		});

		test("preserves ordering of text and image parts", () => {
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
			assert.ok(Array.isArray(content));
			assert.equal(content.length, 3);
			assert.equal(content[0].type, "text");
			assert.equal((content[0] as unknown as { text: string }).text, "before");
			assert.equal(content[1].type, "image_url");
			assert.equal(content[2].type, "text");
			assert.equal((content[2] as unknown as { text: string }).text, "after");
		});

		test("decodes text/json LanguageModelDataPart as text", () => {
			const jsonData = new TextEncoder().encode('{"key":"value"}');
			const jsonPart = new vscode.LanguageModelDataPart(jsonData, "application/json");
			const messages: vscode.LanguageModelChatMessage[] = [
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [new vscode.LanguageModelTextPart("here is data: "), jsonPart],
					name: undefined,
				},
			];
			const out = convertMessages(messages);
			assert.equal(typeof out[0].content, "string");
			assert.ok((out[0].content as string).includes('{"key":"value"}'));
		});

		test("converts PDF LanguageModelDataPart to file content block", () => {
			const pdfData = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF magic
			const pdfPart = new vscode.LanguageModelDataPart(pdfData, "application/pdf");
			const messages: vscode.LanguageModelChatMessage[] = [
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [new vscode.LanguageModelTextPart("Analyze this:"), pdfPart],
					name: undefined,
				},
			];
			const out = convertMessages(messages);
			const content = out[0].content as Array<{ type: string }>;
			assert.ok(Array.isArray(content));
			assert.equal(content.length, 2);
			assert.equal(content[0].type, "text");
			assert.equal(content[1].type, "file");
			const fileBlock = content[1] as { type: string; file: { file_data: string } };
			assert.ok(fileBlock.file.file_data.startsWith("data:application/pdf;base64,"));
		});

		test("skips unsupported binary LanguageModelDataPart without crash", () => {
			const binPart = new vscode.LanguageModelDataPart(new Uint8Array([0x00, 0x01]), "application/octet-stream");
			const messages: vscode.LanguageModelChatMessage[] = [
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [new vscode.LanguageModelTextPart("test"), binPart],
					name: undefined,
				},
			];
			const out = convertMessages(messages);
			// Should produce string content since the binary part is skipped
			assert.equal(typeof out[0].content, "string");
			assert.equal(out[0].content, "test");
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

		test("convertTools uses 'required' for ToolMode.Required with multiple tools", () => {
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
						description: "Tool with composite schema",
						inputSchema: {
							type: "object",
							properties: {
								value: {
									anyOf: [{ type: "string" }, { type: "number" }],
								},
							},
						},
					},
				],
				toolMode: vscode.LanguageModelChatToolMode.Auto,
			} satisfies vscode.ProvideLanguageModelChatResponseOptions);
			assert.ok(out.tools);
			const params = out.tools![0].function.parameters as Record<string, unknown>;
			const props = params.properties as Record<string, Record<string, unknown>>;
			assert.ok(Array.isArray(props.value.anyOf), "anyOf should be preserved");
			assert.equal((props.value.anyOf as unknown[]).length, 2);
		});

		test("schema preserves const keyword", () => {
			const out = convertTools({
				tools: [
					{
						name: "const_tool",
						description: "Tool with const",
						inputSchema: {
							type: "object",
							properties: {
								action: { type: "string", const: "submit" },
							},
						},
					},
				],
				toolMode: vscode.LanguageModelChatToolMode.Auto,
			} satisfies vscode.ProvideLanguageModelChatResponseOptions);
			assert.ok(out.tools);
			const params = out.tools![0].function.parameters as Record<string, unknown>;
			const props = params.properties as Record<string, Record<string, unknown>>;
			assert.equal(props.action.const, "submit", "const keyword should be preserved");
		});

		test("schema does not force type on const-only nodes", () => {
			const out = convertTools({
				tools: [
					{
						name: "const_only_tool",
						description: "Tool with const-only property",
						inputSchema: {
							type: "object",
							properties: {
								action: { const: "submit" },
							},
						},
					},
				],
				toolMode: vscode.LanguageModelChatToolMode.Auto,
			} satisfies vscode.ProvideLanguageModelChatResponseOptions);
			assert.ok(out.tools);
			const params = out.tools![0].function.parameters as Record<string, unknown>;
			const props = params.properties as Record<string, Record<string, unknown>>;
			assert.equal(props.action.const, "submit", "const should be preserved");
			assert.equal(props.action.type, undefined, "type should not be forced on const-only node");
			assert.equal(props.action.properties, undefined, "properties should not be added to const-only node");
		});

		test("schema does not force type on $ref-only nodes", () => {
			const out = convertTools({
				tools: [
					{
						name: "ref_tool",
						description: "Tool with $ref",
						inputSchema: {
							type: "object",
							properties: {
								item: { $ref: "#/$defs/Item" },
							},
							$defs: {
								Item: { type: "string" },
							},
						},
					},
				],
				toolMode: vscode.LanguageModelChatToolMode.Auto,
			} satisfies vscode.ProvideLanguageModelChatResponseOptions);
			assert.ok(out.tools);
			const params = out.tools![0].function.parameters as Record<string, unknown>;
			const props = params.properties as Record<string, Record<string, unknown>>;
			assert.equal(props.item["$ref"], "#/$defs/Item", "$ref should be preserved");
			assert.equal(props.item.type, undefined, "type should not be forced on $ref node");
			assert.equal(props.item.properties, undefined, "properties should not be added to $ref node");
		});

		test("schema does not force type on type-less anyOf nodes", () => {
			const out = convertTools({
				tools: [
					{
						name: "union_tool",
						description: "Tool with typeless anyOf",
						inputSchema: {
							type: "object",
							properties: {
								value: {
									anyOf: [{ type: "string" }, { type: "number" }],
									description: "A string or number",
								},
							},
						},
					},
				],
				toolMode: vscode.LanguageModelChatToolMode.Auto,
			} satisfies vscode.ProvideLanguageModelChatResponseOptions);
			assert.ok(out.tools);
			const params = out.tools![0].function.parameters as Record<string, unknown>;
			const props = params.properties as Record<string, Record<string, unknown>>;
			assert.ok(Array.isArray(props.value.anyOf), "anyOf should be preserved");
			assert.equal(props.value.type, undefined, "type should not be forced on anyOf node");
			assert.equal(props.value.properties, undefined, "properties should not be added to anyOf node");
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

		test("extended model metadata captured from model/info", async () => {
			const originalFetch = global.fetch;
			global.fetch = async () =>
				({
					ok: true,
					json: async () => ({
						data: [
							{
								model_name: "gpt-4o",
								model_info: {
									id: "gpt-4o",
									supports_function_calling: true,
									supports_vision: true,
									supports_response_schema: true,
									supports_reasoning: false,
									supports_pdf_input: true,
									max_tokens: 16384,
									max_input_tokens: 128000,
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
			const modelEntry = infos.find((i) => i.id === "gpt-4o");
			assert.ok(modelEntry, "Should have gpt-4o entry");
			assert.equal(modelEntry.capabilities.imageInput, true, "Should detect vision support");
		});
	});

	suite("streaming response processing", () => {
		test("processDelta emits text content from string delta", async () => {
			const provider = new LiteLLMChatModelProvider(
				{
					get: async () => undefined,
					store: async () => {},
					delete: async () => {},
					onDidChange: (_listener: unknown) => ({ dispose() {} }),
				} as unknown as vscode.SecretStorage,
				"GitHubCopilotChat/test VSCode/test"
			);

			const parts: vscode.LanguageModelResponsePart[] = [];
			const progress = { report: (p: vscode.LanguageModelResponsePart) => parts.push(p) };

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const emitted = await (provider as any).processDelta(
				{
					choices: [{ delta: { content: "Hello world" } }],
				},
				progress
			);

			assert.ok(emitted, "Should report emitted = true");
			assert.ok(parts.length > 0, "Should emit at least one part");
			const textPart = parts.find((p) => p instanceof vscode.LanguageModelTextPart) as vscode.LanguageModelTextPart;
			assert.ok(textPart, "Should emit a text part");
			assert.ok(textPart.value.includes("Hello world"), "Text should contain the content");
		});

		test("processDelta handles tool calls in delta", async () => {
			const provider = new LiteLLMChatModelProvider(
				{
					get: async () => undefined,
					store: async () => {},
					delete: async () => {},
					onDidChange: (_listener: unknown) => ({ dispose() {} }),
				} as unknown as vscode.SecretStorage,
				"GitHubCopilotChat/test VSCode/test"
			);

			const parts: vscode.LanguageModelResponsePart[] = [];
			const progress = { report: (p: vscode.LanguageModelResponsePart) => parts.push(p) };

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			await (provider as any).processDelta(
				{
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: "call_123",
										function: { name: "test_tool", arguments: '{"key":"value"}' },
									},
								],
							},
						},
					],
				},
				progress
			);

			assert.ok(parts.length > 0, "Should emit tool call part");
			const toolPart = parts.find(
				(p) => p instanceof vscode.LanguageModelToolCallPart
			) as vscode.LanguageModelToolCallPart;
			assert.ok(toolPart, "Should emit a LanguageModelToolCallPart");
			assert.equal(toolPart.name, "test_tool");
		});

		test("processDelta logs token usage", async () => {
			const logs: string[] = [];
			const mockOutput = {
				appendLine: (msg: string) => logs.push(msg),
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
				mockOutput
			);

			const parts: vscode.LanguageModelResponsePart[] = [];
			const progress = { report: (p: vscode.LanguageModelResponsePart) => parts.push(p) };

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			await (provider as any).processDelta(
				{
					choices: [],
					usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
				},
				progress
			);

			assert.ok(
				logs.some((l) => l.includes("Token usage")),
				"Should log token usage"
			);
		});

		test("processTextContent strips control tokens", async () => {
			const provider = new LiteLLMChatModelProvider(
				{
					get: async () => undefined,
					store: async () => {},
					delete: async () => {},
					onDidChange: (_listener: unknown) => ({ dispose() {} }),
				} as unknown as vscode.SecretStorage,
				"GitHubCopilotChat/test VSCode/test"
			);

			const parts: vscode.LanguageModelResponsePart[] = [];
			const progress = { report: (p: vscode.LanguageModelResponsePart) => parts.push(p) };

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const result = (provider as any).processTextContent(
				"Hello <|tool_calls_section_begin|>world<|tool_calls_section_end|>",
				progress
			);

			assert.ok(result.emittedText, "Should emit text");
			const textPart = parts.find((p) => p instanceof vscode.LanguageModelTextPart) as vscode.LanguageModelTextPart;
			assert.ok(textPart, "Should emit a text part");
			assert.ok(!textPart.value.includes("<|"), "Should not contain control tokens");
			assert.ok(textPart.value.includes("Hello"), "Should preserve visible text");
			assert.ok(textPart.value.includes("world"), "Should preserve visible text");
		});

		test("processTextContent parses inline tool calls", async () => {
			const provider = new LiteLLMChatModelProvider(
				{
					get: async () => undefined,
					store: async () => {},
					delete: async () => {},
					onDidChange: (_listener: unknown) => ({ dispose() {} }),
				} as unknown as vscode.SecretStorage,
				"GitHubCopilotChat/test VSCode/test"
			);

			const parts: vscode.LanguageModelResponsePart[] = [];
			const progress = { report: (p: vscode.LanguageModelResponsePart) => parts.push(p) };

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(provider as any).processTextContent(
				'<|tool_call_begin|>my_tool<|tool_call_argument_begin|>{"arg":"val"}<|tool_call_end|>',
				progress
			);

			const toolPart = parts.find(
				(p) => p instanceof vscode.LanguageModelToolCallPart
			) as vscode.LanguageModelToolCallPart;
			assert.ok(toolPart, "Should emit a tool call from inline control tokens");
			assert.equal(toolPart.name, "my_tool");
		});
	});

	suite("modelDefaults", () => {
		test("findLongestPrefixMatch returns longest match", () => {
			const entries = { gpt: "a", "gpt-4": "b", "gpt-4-turbo": "c" };
			assert.strictEqual(findLongestPrefixMatch("gpt-4-turbo:fastest", entries), "c");
			assert.strictEqual(findLongestPrefixMatch("gpt-4:openai", entries), "b");
			assert.strictEqual(findLongestPrefixMatch("gpt-3.5", entries), "a");
		});

		test("findLongestPrefixMatch returns undefined for no match", () => {
			assert.strictEqual(findLongestPrefixMatch("claude-3", { gpt: "a" }), undefined);
		});

		test("getModelDefaults returns temperature 0.7 for unmatched model", () => {
			const defaults = getModelDefaults("claude-3-opus");
			assert.strictEqual(defaults.temperature, 0.7);
		});

		test("getModelDefaults returns no temperature for gpt-5.5", () => {
			const defaults = getModelDefaults("gpt-5.5");
			assert.strictEqual(defaults.temperature, undefined);
		});

		test("getModelDefaults returns no temperature for gpt-5.5 with suffix", () => {
			const defaults = getModelDefaults("gpt-5.5:openai");
			assert.strictEqual(defaults.temperature, undefined);
		});
	});

	suite("helpAndFeedback command", () => {
		interface QuickPickItem {
			label: string;
			id: string;
		}

		function mockHelpFeedback(pickId: string | undefined, onOpen: (uri: string) => void): { restore: () => void } {
			const origPick = vscode.window.showQuickPick;
			const origOpen = vscode.env.openExternal;

			(vscode.window as Record<string, unknown>).showQuickPick = async (items: QuickPickItem[]) => {
				return pickId ? items.find((i) => i.id === pickId) : undefined;
			};
			(vscode.env as Record<string, unknown>).openExternal = async (uri: vscode.Uri) => {
				onOpen(uri.toString());
				return true;
			};

			return {
				restore() {
					(vscode.window as Record<string, unknown>).showQuickPick = origPick;
					(vscode.env as Record<string, unknown>).openExternal = origOpen;
				},
			};
		}

		test("helpAndFeedback delegates to reportIssue when Report Bug selected", async () => {
			let openedUri: string | undefined;
			const mock = mockHelpFeedback("bug", (uri) => (openedUri = uri));
			try {
				await vscode.commands.executeCommand("litellm.helpAndFeedback");
				// "Report Bug" now delegates to litellm.reportIssue which opens a prefilled URL
				assert.ok(openedUri, "Should open a URL via reportIssue");
				assert.ok(openedUri!.includes("issues/new"), "Should open new issue page");
				assert.ok(openedUri!.includes("bug"), "Should include bug label");
			} finally {
				mock.restore();
			}
		});

		test("helpAndFeedback opens feature request URL when Request Feature selected", async () => {
			let openedUri: string | undefined;
			const mock = mockHelpFeedback("feature", (uri) => (openedUri = uri));
			try {
				await vscode.commands.executeCommand("litellm.helpAndFeedback");
				assert.ok(openedUri, "Should open a URL");
				assert.ok(openedUri!.includes("issues/new"), "Should open new issue page");
				assert.ok(openedUri!.includes("enhancement"), "Should include enhancement label");
			} finally {
				mock.restore();
			}
		});

		test("helpAndFeedback opens docs URL when Documentation selected", async () => {
			let openedUri: string | undefined;
			const mock = mockHelpFeedback("docs", (uri) => (openedUri = uri));
			try {
				await vscode.commands.executeCommand("litellm.helpAndFeedback");
				assert.ok(openedUri, "Should open a URL");
				assert.ok(openedUri!.includes("quick-start"), "Should open docs URL");
			} finally {
				mock.restore();
			}
		});

		test("helpAndFeedback does nothing when user cancels", async () => {
			let openedUri: string | undefined;
			const mock = mockHelpFeedback(undefined, (uri) => (openedUri = uri));
			try {
				await vscode.commands.executeCommand("litellm.helpAndFeedback");
				assert.equal(openedUri, undefined, "Should not open any URL when cancelled");
			} finally {
				mock.restore();
			}
		});
	});

	suite("IssueReporter", () => {
		function makeSnapshot(overrides?: Partial<DiagnosticsSnapshot>): DiagnosticsSnapshot {
			return {
				extensionVersion: "0.2.3",
				vscodeVersion: "1.118.0",
				platform: "darwin arm64",
				connectionState: "connected",
				modelCount: 5,
				apiKeyConfigured: true,
				baseUrlConfigured: true,
				recentLogs: [],
				...overrides,
			};
		}

		test("buildIssueUrl produces valid GitHub URL with query params", () => {
			const reporter = new IssueReporter();
			const url = reporter.buildIssueUrl(makeSnapshot());
			assert.ok(url.startsWith("https://github.com/Vivswan/litellm-vscode-chat/issues/new?"));
			assert.ok(url.includes("labels=bug"));
			assert.ok(url.includes("title="));
			assert.ok(url.includes("body="));
		});

		test("buildTitle sanitizes error message secrets", () => {
			const reporter = new IssueReporter();
			const snapshot = makeSnapshot({
				latestError: {
					source: "fetchModels",
					message: "Failed to connect to https://internal.corp.com:4000/v1/models",
					timestamp: "2026-01-01T00:00:00.000Z",
				},
			});
			const title = reporter.buildTitle(snapshot);
			assert.ok(title.includes("[Bug]"));
			assert.ok(title.includes("fetchModels"));
			assert.ok(!title.includes("internal.corp.com"), "Should not leak hostname");
			assert.ok(title.includes("[REDACTED_HOST]"));
		});

		test("buildTitle includes error source and message when error exists", () => {
			const reporter = new IssueReporter();
			const snapshot = makeSnapshot({
				latestError: {
					source: "fetchModels",
					message: "Connection refused\nsome detail",
					timestamp: "2026-01-01T00:00:00.000Z",
				},
			});
			const title = reporter.buildTitle(snapshot);
			assert.ok(title.includes("[Bug]"));
			assert.ok(title.includes("fetchModels"));
			assert.ok(title.includes("Connection refused"));
			assert.ok(!title.includes("some detail"));
		});

		test("buildTitle returns generic title when no error", () => {
			const reporter = new IssueReporter();
			const title = reporter.buildTitle(makeSnapshot());
			assert.ok(title.includes("[Bug]"));
			assert.ok(title.includes("diagnostics"));
		});

		test("buildBody includes environment and diagnostics sections", () => {
			const reporter = new IssueReporter();
			const body = reporter.buildBody(makeSnapshot());
			assert.ok(body.includes("## Environment"));
			assert.ok(body.includes("0.2.3"));
			assert.ok(body.includes("## Diagnostics"));
			assert.ok(body.includes("API key configured: yes"));
			assert.ok(body.includes("Model count: 5"));
		});

		test("buildBody includes error details and stack trace", () => {
			const reporter = new IssueReporter();
			const body = reporter.buildBody(
				makeSnapshot({
					latestError: {
						source: "chat",
						message: "timeout",
						stack: "Error: timeout\n    at foo.ts:1",
						timestamp: "2026-01-01T00:00:00.000Z",
					},
				})
			);
			assert.ok(body.includes("### Latest error"));
			assert.ok(body.includes("timeout"));
			assert.ok(body.includes("Stack trace"));
		});

		test("buildBody includes recent logs", () => {
			const reporter = new IssueReporter();
			const body = reporter.buildBody(
				makeSnapshot({
					recentLogs: ["[2026-01-01] Fetching models", "[2026-01-01] Got 5 models"],
				})
			);
			assert.ok(body.includes("## Recent logs"));
			assert.ok(body.includes("Fetching models"));
		});

		test("appendLog maintains rolling buffer", () => {
			const reporter = new IssueReporter();
			for (let i = 0; i < 60; i++) {
				reporter.appendLog(`line ${i}`);
			}
			const logs = reporter.getRecentLogs();
			assert.equal(logs.length, 50);
			assert.ok(logs[0].includes("line 10"));
			assert.ok(logs[49].includes("line 59"));
		});

		test("recordError captures message and stack", () => {
			const reporter = new IssueReporter();
			const err = new Error("test failure");
			reporter.recordError("testSource", err);
			const latest = reporter.getLatestError();
			assert.ok(latest);
			assert.equal(latest.source, "testSource");
			assert.equal(latest.message, "test failure");
			assert.ok(latest.stack?.includes("test failure"));
			assert.ok(latest.timestamp);
		});

		test("recordError handles string errors", () => {
			const reporter = new IssueReporter();
			reporter.recordError("src", "plain string error");
			const latest = reporter.getLatestError();
			assert.ok(latest);
			assert.equal(latest.message, "plain string error");
			assert.equal(latest.stack, undefined);
		});

		test("redactSecrets removes Bearer tokens", () => {
			assert.equal(redactSecrets("Bearer sk-abc123xyz"), "Bearer [REDACTED]");
		});

		test("redactSecrets removes X-API-Key values", () => {
			assert.equal(redactSecrets("X-API-Key: my-secret-key"), "X-API-Key: [REDACTED]");
		});

		test("redactSecrets removes sk- prefixed keys", () => {
			const result = redactSecrets("key is sk-abcd1234567890");
			assert.ok(result.includes("sk-abcd[REDACTED]"));
			assert.ok(!result.includes("1234567890"));
		});

		test("redactSecrets removes credentials from URLs", () => {
			const result = redactSecrets("https://user:pass@example.com/api");
			assert.ok(!result.includes("pass"));
		});

		test("redactSecrets preserves non-secret text", () => {
			assert.equal(redactSecrets("Connection refused to localhost:4000"), "Connection refused to localhost:4000");
		});

		test("redactSecrets redacts full non-localhost URLs", () => {
			const result = redactSecrets("Fetching from: https://my-litellm.internal.corp.com:4000/v1/models");
			assert.ok(!result.includes("my-litellm.internal.corp.com"), "Should not leak hostname");
			assert.ok(result.includes("[REDACTED_HOST]"));
			assert.ok(result.includes("/v1/models"), "Should preserve path");
		});

		test("redactSecrets preserves localhost URLs", () => {
			const result = redactSecrets("Fetching from: http://localhost:4000/v1/models");
			assert.ok(result.includes("http://localhost:4000/v1/models"));
		});

		test("redactSecrets handles JSON-encoded auth headers", () => {
			const json = '{"Authorization": "Bearer sk-abc123", "X-API-Key": "secret-key-value"}';
			const result = redactSecrets(json);
			assert.ok(!result.includes("sk-abc123"), "Should not leak Bearer token");
			assert.ok(!result.includes("secret-key-value"), "Should not leak API key");
			assert.ok(result.includes("[REDACTED]"));
		});
	});
});
