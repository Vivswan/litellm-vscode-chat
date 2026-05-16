import * as assert from "assert";
import * as vscode from "vscode";
import { LiteLLMChatModelProvider } from "../provider";
import type { AggregatedStatus } from "../provider";
import { getModelParameters } from "../provider/request";

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
			content: [new vscode.LanguageModelTextPart("describe"), new vscode.LanguageModelDataPart(imageData, "image/png")],
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

	suite("token constraints", () => {
		test("uses token constraints from provider info when available", async () => {
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

			const providerEntry = infos.find((i) => i.id === "test-model:test-provider");
			assert.ok(providerEntry, "Provider entry should exist");
			assert.equal(providerEntry.maxOutputTokens, 8000);
			assert.equal(providerEntry.maxInputTokens, 90000);
		});

		test("marks registered models as user-selectable for VS Code 1.120 picker compatibility", async () => {
			const originalFetch = global.fetch;
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
									providers: [{ provider: "test-provider", status: "active", supports_tools: true }],
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
				const providerEntry = infos.find((i) => i.id === "test-model:test-provider");
				assert.ok(providerEntry);

				const metadata = (providerEntry as unknown as { metadata?: { isUserSelectable?: boolean } }).metadata;
				assert.equal(metadata?.isUserSelectable, true);
			} finally {
				global.fetch = originalFetch;
			}
		});

		test("uses workspace settings as fallback when provider fields absent", async () => {
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
									providers: [{ provider: "test-provider", status: "active", supports_tools: true }],
								},
							],
						}),
					}) as unknown as Response;

				vscode.workspace.getConfiguration = ((section?: string) => {
					if (section === "litellm-vscode-chat") {
						return {
							get: (key: string, defaultValue?: unknown) => {
								if (key === "defaultMaxOutputTokens") return 20000;
								if (key === "defaultContextLength") return 200000;
								if (key === "defaultMaxInputTokens") return null;
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
				assert.ok(providerEntry);
				assert.equal(providerEntry.maxOutputTokens, 20000);
				assert.equal(providerEntry.maxInputTokens, 180000);
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
								if (key === "defaultMaxInputTokens") return 50000;
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
				assert.ok(providerEntry);
				assert.equal(providerEntry.maxInputTokens, 50000);
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
								if (key === "defaultMaxInputTokens") return 48000;
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
				assert.ok(providerEntry);
				assert.equal(providerEntry.maxInputTokens, 48000);
			} finally {
				global.fetch = originalFetch;
				vscode.workspace.getConfiguration = originalGetConfiguration;
			}
		});

		test("uses hardcoded defaults when provider and settings absent", async () => {
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
									providers: [{ provider: "test-provider", status: "active", supports_tools: true }],
								},
							],
						}),
					}) as unknown as Response;

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
				const providerEntry = infos.find((i) => i.id === "test-model:test-provider");
				assert.ok(providerEntry);
				assert.equal(providerEntry.maxOutputTokens, 16000);
				assert.equal(providerEntry.maxInputTokens, 112000);
			} finally {
				global.fetch = originalFetch;
				vscode.workspace.getConfiguration = originalGetConfiguration;
			}
		});

		test("aggregates minimum token constraints for cheapest/fastest entries", async () => {
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

			const cheapestEntry = infos.find((i) => i.id === "test-model:cheapest");
			const fastestEntry = infos.find((i) => i.id === "test-model:fastest");
			assert.ok(cheapestEntry);
			assert.ok(fastestEntry);
			assert.equal(cheapestEntry.maxOutputTokens, 4000);
			assert.equal(fastestEntry.maxOutputTokens, 4000);
			assert.equal(cheapestEntry.maxInputTokens, 46000);
		});

		test("provider max_output_tokens takes priority over max_tokens", async () => {
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

			const providerEntry = infos.find((i) => i.id === "test-model:test-provider");
			assert.ok(providerEntry);
			assert.equal(providerEntry.maxOutputTokens, 8000);
		});
	});

	suite("modelParameters configuration", () => {
		test("exact model ID match returns parameters", () => {
			const originalGetConfiguration = vscode.workspace.getConfiguration;
			vscode.workspace.getConfiguration = ((section?: string) => {
				if (section === "litellm-vscode-chat")
					return {
						get: (key: string, defaultValue?: unknown) => {
							if (key === "modelParameters") return { "gpt-4": { temperature: 0.8, max_tokens: 8000 } };
							return defaultValue;
						},
					} as unknown as vscode.WorkspaceConfiguration;
				return originalGetConfiguration(section);
			}) as unknown as typeof vscode.workspace.getConfiguration;

			const params = getModelParameters("gpt-4", new Map());
			vscode.workspace.getConfiguration = originalGetConfiguration;
			assert.deepEqual(params, { temperature: 0.8, max_tokens: 8000 });
		});

		test("prefix match returns parameters", () => {
			const originalGetConfiguration = vscode.workspace.getConfiguration;
			vscode.workspace.getConfiguration = ((section?: string) => {
				if (section === "litellm-vscode-chat")
					return {
						get: (key: string, defaultValue?: unknown) => {
							if (key === "modelParameters") return { "gpt-4": { temperature: 0.7 } };
							return defaultValue;
						},
					} as unknown as vscode.WorkspaceConfiguration;
				return originalGetConfiguration(section);
			}) as unknown as typeof vscode.workspace.getConfiguration;

			const params = getModelParameters("gpt-4-turbo:openai", new Map());
			vscode.workspace.getConfiguration = originalGetConfiguration;
			assert.deepEqual(params, { temperature: 0.7 });
		});

		test("longest prefix match takes precedence", () => {
			const originalGetConfiguration = vscode.workspace.getConfiguration;
			vscode.workspace.getConfiguration = ((section?: string) => {
				if (section === "litellm-vscode-chat")
					return {
						get: (key: string, defaultValue?: unknown) => {
							if (key === "modelParameters")
								return {
									gpt: { temperature: 0.5 },
									"gpt-4": { temperature: 0.7 },
									"gpt-4-turbo": { temperature: 0.9 },
								};
							return defaultValue;
						},
					} as unknown as vscode.WorkspaceConfiguration;
				return originalGetConfiguration(section);
			}) as unknown as typeof vscode.workspace.getConfiguration;

			const params = getModelParameters("gpt-4-turbo:fastest", new Map());
			vscode.workspace.getConfiguration = originalGetConfiguration;
			assert.deepEqual(params, { temperature: 0.9 });
		});

		test("no match returns empty object", () => {
			const originalGetConfiguration = vscode.workspace.getConfiguration;
			vscode.workspace.getConfiguration = ((section?: string) => {
				if (section === "litellm-vscode-chat")
					return {
						get: (key: string, defaultValue?: unknown) => {
							if (key === "modelParameters") return { "gpt-4": { temperature: 0.7 } };
							return defaultValue;
						},
					} as unknown as vscode.WorkspaceConfiguration;
				return originalGetConfiguration(section);
			}) as unknown as typeof vscode.workspace.getConfiguration;

			const params = getModelParameters("claude-opus", new Map());
			vscode.workspace.getConfiguration = originalGetConfiguration;
			assert.deepEqual(params, {});
		});

		test("empty configuration returns empty object", () => {
			const originalGetConfiguration = vscode.workspace.getConfiguration;
			vscode.workspace.getConfiguration = ((section?: string) => {
				if (section === "litellm-vscode-chat")
					return {
						get: (key: string, defaultValue?: unknown) => defaultValue,
					} as unknown as vscode.WorkspaceConfiguration;
				return originalGetConfiguration(section);
			}) as unknown as typeof vscode.workspace.getConfiguration;

			const params = getModelParameters("gpt-4", new Map());
			vscode.workspace.getConfiguration = originalGetConfiguration;
			assert.deepEqual(params, {});
		});

		test("modelParameters supports various parameter types", () => {
			const originalGetConfiguration = vscode.workspace.getConfiguration;
			vscode.workspace.getConfiguration = ((section?: string) => {
				if (section === "litellm-vscode-chat")
					return {
						get: (key: string, defaultValue?: unknown) => {
							if (key === "modelParameters")
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
							return defaultValue;
						},
					} as unknown as vscode.WorkspaceConfiguration;
				return originalGetConfiguration(section);
			}) as unknown as typeof vscode.workspace.getConfiguration;

			const params = getModelParameters("test-model", new Map());
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
			const chunk = `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
			return new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(chunk));
					controller.close();
				},
			});
		}

		async function captureRequestBody(
			provider: LiteLLMChatModelProvider,
			model: vscode.LanguageModelChatInformation,
			opts: unknown
		): Promise<Record<string, unknown>> {
			const originalFetch = global.fetch;
			let capturedBody: Record<string, unknown> = {};
			global.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
				capturedBody = JSON.parse(init?.body as string);
				return { ok: true, body: sseStream("ok") } as unknown as Response;
			};
			await provider.prepareLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token);
			await provider.provideLanguageModelChatResponse(
				model,
				[
					{
						role: vscode.LanguageModelChatMessageRole.User,
						content: [new vscode.LanguageModelTextPart("test")],
						name: undefined,
					},
				],
				opts as vscode.ProvideLanguageModelChatResponseOptions,
				{ report: () => {} },
				new vscode.CancellationTokenSource().token
			);
			global.fetch = originalFetch;
			return capturedBody;
		}

		test("filters underscore-prefixed internal keys from modelOptions", async () => {
			const body = await captureRequestBody(createConfiguredProvider(), modelInfo, {
				toolMode: vscode.LanguageModelChatToolMode.Auto,
				modelOptions: {
					temperature: 0.5,
					seed: 42,
					_capturingTokenCorrelationId: "some-internal-id",
					_otherInternalField: true,
				},
			});
			assert.equal(body.temperature, 0.5);
			assert.equal(body.seed, 42);
			assert.equal(body._capturingTokenCorrelationId, undefined);
			assert.equal(body._otherInternalField, undefined);
		});

		test("forwards valid modelOptions like response_format and reasoning_effort", async () => {
			const body = await captureRequestBody(createConfiguredProvider(), modelInfo, {
				toolMode: vscode.LanguageModelChatToolMode.Auto,
				modelOptions: { response_format: { type: "json_object" }, reasoning_effort: "high", top_k: 50 },
			});
			assert.deepEqual(body.response_format, { type: "json_object" });
			assert.equal(body.reasoning_effort, "high");
			assert.equal(body.top_k, 50);
		});

		test("does not overwrite provider-owned fields from modelOptions", async () => {
			const body = await captureRequestBody(createConfiguredProvider(), modelInfo, {
				toolMode: vscode.LanguageModelChatToolMode.Auto,
				modelOptions: { model: "attacker-model", messages: [{ role: "system", content: "pwned" }], stream: false },
			});
			assert.equal(body.model, "test-model");
			assert.equal(body.stream, true);
			assert.ok(Array.isArray(body.messages));
			assert.notDeepEqual(body.messages, [{ role: "system", content: "pwned" }]);
		});

		test("includes stream_options with include_usage by default", async () => {
			const body = await captureRequestBody(createConfiguredProvider(), modelInfo, {
				toolMode: vscode.LanguageModelChatToolMode.Auto,
			});
			assert.deepEqual(body.stream_options, { include_usage: true });
		});

		test("unmatched model gets built-in fallback defaults (temperature 0.7)", async () => {
			const originalGetConfig = vscode.workspace.getConfiguration;
			vscode.workspace.getConfiguration = ((section?: string) => {
				if (section === "litellm-vscode-chat")
					return {
						get: (key: string) => {
							if (key === "modelParameters") return {};
							return undefined;
						},
					};
				return originalGetConfig(section!);
			}) as typeof vscode.workspace.getConfiguration;
			try {
				const body = await captureRequestBody(createConfiguredProvider(), modelInfo, {
					toolMode: vscode.LanguageModelChatToolMode.Auto,
				});
				assert.strictEqual(body.temperature, 0.7);
			} finally {
				vscode.workspace.getConfiguration = originalGetConfig;
			}
		});

		test("gpt-5.5 model gets no built-in temperature", async () => {
			const originalGetConfig = vscode.workspace.getConfiguration;
			vscode.workspace.getConfiguration = ((section?: string) => {
				if (section === "litellm-vscode-chat")
					return {
						get: (key: string) => {
							if (key === "modelParameters") return {};
							return undefined;
						},
					};
				return originalGetConfig(section!);
			}) as typeof vscode.workspace.getConfiguration;
			try {
				const body = await captureRequestBody(
					createConfiguredProvider(),
					{ ...modelInfo, id: "gpt-5.5:openai" },
					{ toolMode: vscode.LanguageModelChatToolMode.Auto }
				);
				assert.strictEqual(body.temperature, undefined);
			} finally {
				vscode.workspace.getConfiguration = originalGetConfig;
			}
		});

		test("_replaceDefaults: true skips codebase defaults", async () => {
			const originalGetConfig = vscode.workspace.getConfiguration;
			vscode.workspace.getConfiguration = ((section?: string) => {
				if (section === "litellm-vscode-chat")
					return {
						get: (key: string) => {
							if (key === "modelParameters") return { "test-model": { _replaceDefaults: true, top_p: 0.9 } };
							return undefined;
						},
					};
				return originalGetConfig(section!);
			}) as typeof vscode.workspace.getConfiguration;
			try {
				const body = await captureRequestBody(createConfiguredProvider(), modelInfo, {
					toolMode: vscode.LanguageModelChatToolMode.Auto,
				});
				assert.strictEqual(body.temperature, undefined);
				assert.strictEqual(body.top_p, 0.9);
				assert.strictEqual(body._replaceDefaults, undefined);
			} finally {
				vscode.workspace.getConfiguration = originalGetConfig;
			}
		});

		test("user config without _replaceDefaults merges onto codebase defaults", async () => {
			const originalGetConfig = vscode.workspace.getConfiguration;
			vscode.workspace.getConfiguration = ((section?: string) => {
				if (section === "litellm-vscode-chat")
					return {
						get: (key: string) => {
							if (key === "modelParameters") return { "test-model": { top_p: 0.8 } };
							return undefined;
						},
					};
				return originalGetConfig(section!);
			}) as typeof vscode.workspace.getConfiguration;
			try {
				const body = await captureRequestBody(createConfiguredProvider(), modelInfo, {
					toolMode: vscode.LanguageModelChatToolMode.Auto,
				});
				assert.strictEqual(body.temperature, 0.7);
				assert.strictEqual(body.top_p, 0.8);
			} finally {
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
								providers: [{ provider: "test-provider", status: "active", supports_tools: true }],
							},
							{
								id: "model-2",
								object: "model",
								created: 0,
								owned_by: "test",
								providers: [{ provider: "test-provider", status: "active", supports_tools: true }],
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
			await provider.prepareLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token);
			global.fetch = originalFetch;

			assert.ok(callbackStatus);
			assert.ok(callbackStatus!.totalModels > 0);
			assert.ok(callbackStatus!.serverStatuses.every((s) => s.state === "ok"));
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
			await provider.prepareLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token);
			global.fetch = originalFetch;

			assert.ok(callbackStatus);
			assert.equal(callbackStatus!.totalModels, 0);
			assert.ok(callbackStatus!.serverStatuses.some((s) => s.state === "error"));
			assert.ok(callbackStatus!.serverStatuses.some((s) => s.error?.includes("Network")));
		});

		test("status callback reports empty model list", async () => {
			const originalFetch = global.fetch;
			global.fetch = async () =>
				({ ok: true, json: async () => ({ object: "list", data: [] }) }) as unknown as Response;

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
			await provider.prepareLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token);
			global.fetch = originalFetch;

			assert.ok(callbackStatus);
			assert.equal(callbackStatus!.totalModels, 0);
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
			await provider.prepareLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token);

			assert.ok(callbackStatus);
			assert.equal(callbackStatus!.totalModels, 0);
			assert.equal(callbackStatus!.serverStatuses.length, 0);
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
			await provider.prepareLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token);

			assert.ok(logs.length > 0);
			assert.ok(logs.some((log) => log.includes("prepareLanguageModelChatInformation")));
			assert.ok(logs.some((log) => log.includes("No") && (log.includes("config") || log.includes("servers"))));
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
			await provider.prepareLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token);
			global.fetch = originalFetch;

			assert.ok(logs.length > 0);
			assert.ok(logs.some((log) => log.includes("ERROR")));
			assert.ok(logs.some((log) => log.includes("Test error")));
			assert.ok(logs.some((log) => /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(log)));
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
							data: [{ id: "test-model", object: "model", created: 0, owned_by: "test" }],
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

			assert.ok(modelInfoAttempted);
			assert.ok(modelsAttempted);
			assert.ok(infos.length > 0);
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

			assert.ok(infos.length > 0);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			assert.equal((provider as any)._promptCachingSupport.get("claude-3-5-sonnet-20241022"), true);
		});

		test("model/info numeric string token limits are parsed and max_output_tokens wins", async () => {
			const originalFetch = global.fetch;
			try {
				global.fetch = async () =>
					({
						ok: true,
						json: async () => ({
							data: [
								{
									model_name: "gpt-5.3-codex-spark",
									model_info: {
										id: "gpt-5.3-codex-spark",
										supports_function_calling: true,
										max_tokens: "128000",
										max_input_tokens: "128000",
										max_output_tokens: "32000",
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

				const modelEntry = infos.find((i) => i.id === "gpt-5.3-codex-spark");
				assert.ok(modelEntry);
				assert.equal(modelEntry.maxOutputTokens, 32000);
				assert.equal(modelEntry.maxInputTokens, 128000);
			} finally {
				global.fetch = originalFetch;
			}
		});

		test("model/info malformed numeric strings are ignored", async () => {
			const originalFetch = global.fetch;
			try {
				global.fetch = async () =>
					({
						ok: true,
						json: async () => ({
							data: [
								{
									model_name: "gpt-5-bad-metadata",
									model_info: {
										id: "gpt-5-bad-metadata",
										supports_function_calling: true,
										max_tokens: "128000abc",
										max_input_tokens: "128000abc",
										max_output_tokens: "32000abc",
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

				const modelEntry = infos.find((i) => i.id === "gpt-5-bad-metadata");
				assert.ok(modelEntry);
				assert.equal(modelEntry.maxOutputTokens, 16000);
				assert.equal(modelEntry.maxInputTokens, 112000);
			} finally {
				global.fetch = originalFetch;
			}
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
			assert.equal((provider as any)._promptCachingSupport.get("gpt-4"), false);
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
								model_info: { key: "third-choice", id: "last-resort" },
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

			assert.ok(infos.find((i) => i.id === "preferred-name"));
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

			assert.ok(infos.length > 0);
			const modelEntry = infos.find((i) => i.id === "gpt-4o");
			assert.ok(modelEntry);
			assert.equal(modelEntry.capabilities.imageInput, true);
		});
	});
});
