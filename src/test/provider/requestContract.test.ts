import * as assert from "node:assert";
import * as vscode from "vscode";
import { findLongestPrefixMatch, getModelParameters } from "../../provider/request";
import {
	captureRequest,
	captureRequestBody,
	createConfiguredProvider,
	jsonResponse,
	makeModelInfo,
	makeProvider,
	systemMessage,
	userMessage,
	withConfig,
	withFetch,
} from "../testUtils";

const modelInfo = makeModelInfo();

suite("provider/request contract", () => {
	suite("token constraints", () => {
		test("uses token constraints from provider info when available", async () => {
			const provider = makeProvider("http://test");

			const infos = await withFetch(
				async () =>
					jsonResponse({
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
				() => provider.provideLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token)
			);

			const providerEntry = infos.find((i) => i.id === "test-model:test-provider");
			assert.ok(providerEntry, "Provider entry should exist");
			assert.equal(providerEntry.maxOutputTokens, 8000);
			assert.equal(providerEntry.maxInputTokens, 90000);
		});

		test("marks registered models as user-selectable for VS Code 1.120 picker compatibility", async () => {
			const provider = makeProvider("http://test");

			const infos = await withFetch(
				async () =>
					jsonResponse({
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
				() => provider.provideLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token)
			);
			const providerEntry = infos.find((i) => i.id === "test-model:test-provider");
			assert.ok(providerEntry);

			// VS Code 1.120+ requires isUserSelectable at top level
			const topLevel = providerEntry as unknown as { isUserSelectable?: boolean };
			assert.equal(topLevel.isUserSelectable, true, "isUserSelectable should be at top level for VS Code 1.120+");

			// Also keep it in metadata for backward compatibility
			const metadata = (providerEntry as unknown as { metadata?: { isUserSelectable?: boolean } }).metadata;
			assert.equal(metadata?.isUserSelectable, true, "isUserSelectable should also be in metadata");
		});

		test("uses workspace settings as fallback when provider fields absent", async () => {
			const infos = await withConfig(
				{ defaultMaxOutputTokens: 20000, defaultContextLength: 200000, defaultMaxInputTokens: null },
				() =>
					withFetch(
						async () =>
							jsonResponse({
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
						() =>
							makeProvider("http://test").provideLanguageModelChatInformation(
								{ silent: true },
								new vscode.CancellationTokenSource().token
							)
					)
			);
			const providerEntry = infos.find((i) => i.id === "test-model:test-provider");
			assert.ok(providerEntry);
			assert.equal(providerEntry.maxOutputTokens, 20000);
			assert.equal(providerEntry.maxInputTokens, 180000);
		});

		test("uses configured defaultMaxInputTokens as an explicit override", async () => {
			const infos = await withConfig({ defaultMaxInputTokens: 50000 }, () =>
				withFetch(
					async () =>
						jsonResponse({
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
					() =>
						makeProvider("http://test").provideLanguageModelChatInformation(
							{ silent: true },
							new vscode.CancellationTokenSource().token
						)
				)
			);
			const providerEntry = infos.find((i) => i.id === "test-model:test-provider");
			assert.ok(providerEntry);
			assert.equal(providerEntry.maxInputTokens, 50000);
		});

		test("treats null provider max_input_tokens as missing and falls back to workspace setting", async () => {
			const infos = await withConfig({ defaultMaxInputTokens: 48000 }, () =>
				withFetch(
					async () =>
						jsonResponse({
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
					() =>
						makeProvider("http://test").provideLanguageModelChatInformation(
							{ silent: true },
							new vscode.CancellationTokenSource().token
						)
				)
			);
			const providerEntry = infos.find((i) => i.id === "test-model:test-provider");
			assert.ok(providerEntry);
			assert.equal(providerEntry.maxInputTokens, 48000);
		});

		test("uses hardcoded defaults when provider and settings absent", async () => {
			const infos = await withConfig({}, () =>
				withFetch(
					async () =>
						jsonResponse({
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
					() =>
						makeProvider("http://test").provideLanguageModelChatInformation(
							{ silent: true },
							new vscode.CancellationTokenSource().token
						)
				)
			);
			const providerEntry = infos.find((i) => i.id === "test-model:test-provider");
			assert.ok(providerEntry);
			assert.equal(providerEntry.maxOutputTokens, 16000);
			assert.equal(providerEntry.maxInputTokens, 112000);
		});

		test("aggregates minimum token constraints for cheapest/fastest entries", async () => {
			const provider = makeProvider("http://test");

			const infos = await withFetch(
				async () =>
					jsonResponse({
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
				() => provider.provideLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token)
			);

			const cheapestEntry = infos.find((i) => i.id === "test-model:cheapest");
			const fastestEntry = infos.find((i) => i.id === "test-model:fastest");
			assert.ok(cheapestEntry);
			assert.ok(fastestEntry);
			assert.equal(cheapestEntry.maxOutputTokens, 4000);
			assert.equal(fastestEntry.maxOutputTokens, 4000);
			assert.equal(cheapestEntry.maxInputTokens, 46000);
		});

		test("provider max_output_tokens takes priority over max_tokens", async () => {
			const provider = makeProvider("http://test");

			const infos = await withFetch(
				async () =>
					jsonResponse({
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
				() => provider.provideLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token)
			);

			const providerEntry = infos.find((i) => i.id === "test-model:test-provider");
			assert.ok(providerEntry);
			assert.equal(providerEntry.maxOutputTokens, 8000);
		});
	});

	suite("modelParameters configuration", () => {
		test("findLongestPrefixMatch returns the longest matching prefix", () => {
			const entries = { "gpt-4": "short", "gpt-4-turbo": "long" };
			assert.strictEqual(findLongestPrefixMatch("gpt-4-turbo:openai", entries), "long");
			assert.strictEqual(findLongestPrefixMatch("gpt-4o", entries), "short");
		});

		test("findLongestPrefixMatch returns undefined without a match", () => {
			assert.strictEqual(findLongestPrefixMatch("claude-3", { "gpt-4": 1 }), undefined);
		});

		test("exact model ID match returns parameters", async () => {
			const params = await withConfig({ modelParameters: { "gpt-4": { temperature: 0.8, max_tokens: 8000 } } }, () =>
				getModelParameters("gpt-4", new Map())
			);
			assert.deepEqual(params, { temperature: 0.8, max_tokens: 8000 });
		});

		test("prefix match returns parameters", async () => {
			const params = await withConfig({ modelParameters: { "gpt-4": { temperature: 0.7 } } }, () =>
				getModelParameters("gpt-4-turbo:openai", new Map())
			);
			assert.deepEqual(params, { temperature: 0.7 });
		});

		test("longest prefix match takes precedence", async () => {
			const params = await withConfig(
				{
					modelParameters: {
						gpt: { temperature: 0.5 },
						"gpt-4": { temperature: 0.7 },
						"gpt-4-turbo": { temperature: 0.9 },
					},
				},
				() => getModelParameters("gpt-4-turbo:fastest", new Map())
			);
			assert.deepEqual(params, { temperature: 0.9 });
		});

		test("no match returns empty object", async () => {
			const params = await withConfig({ modelParameters: { "gpt-4": { temperature: 0.7 } } }, () =>
				getModelParameters("claude-opus", new Map())
			);
			assert.deepEqual(params, {});
		});

		test("empty configuration returns empty object", async () => {
			const params = await withConfig({}, () => getModelParameters("gpt-4", new Map()));
			assert.deepEqual(params, {});
		});

		test("modelParameters supports various parameter types", async () => {
			const params = await withConfig(
				{
					modelParameters: {
						"test-model": {
							temperature: 0.8,
							max_tokens: 4096,
							top_p: 0.9,
							frequency_penalty: 0.5,
							presence_penalty: 0.3,
							stop: ["END", "STOP"],
						},
					},
				},
				() => getModelParameters("test-model", new Map())
			);
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

		test("forwards unknown exotic keys through the transport untouched", async () => {
			const exotic = { nested: [1, "two", { three: null }], π: 0.1234567890123 };
			const body = await captureRequestBody(createConfiguredProvider(), modelInfo, {
				toolMode: vscode.LanguageModelChatToolMode.Auto,
				modelOptions: { "weird-key.π": exotic, guided_json: { type: "object" } },
			});
			assert.deepStrictEqual(body["weird-key.π"], exotic);
			assert.deepStrictEqual(body.guided_json, { type: "object" });
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

		test("includes configured custom headers on chat requests", async () => {
			const { headers } = await withConfig(
				{
					modelParameters: {},
					headers: {
						"x-litellm-api-key": "proxy-key",
						"x-routing-env": "prod",
						"Content-Type": "text/plain",
						"User-Agent": "spoofed-agent",
					},
				},
				() =>
					captureRequest(createConfiguredProvider(), modelInfo, {
						toolMode: vscode.LanguageModelChatToolMode.Auto,
					})
			);
			assert.equal(headers["x-litellm-api-key"], "proxy-key");
			assert.equal(headers["x-routing-env"], "prod");
			assert.equal(headers["content-type"], "application/json");
			assert.equal(headers["user-agent"], "GitHubCopilotChat/test VSCode/test");
			assert.equal(headers.authorization, "Bearer test-key");
			assert.equal(headers["x-api-key"], "test-key");
		});

		test("no parameters are injected when the user configures none", async () => {
			const body = await withConfig({ modelParameters: {} }, () =>
				captureRequestBody(createConfiguredProvider(), modelInfo, {
					toolMode: vscode.LanguageModelChatToolMode.Auto,
				})
			);
			assert.strictEqual(body.temperature, undefined, "No temperature may be injected");
			const allowed = new Set(["model", "messages", "stream", "stream_options", "max_tokens", "tools", "tool_choice"]);
			for (const key of Object.keys(body)) {
				assert.ok(allowed.has(key), `Unexpected injected request field: ${key}`);
			}
		});

		test("underscore-prefixed keys in modelParameters are not forwarded", async () => {
			const body = await withConfig({ modelParameters: { "test-model": { _replaceDefaults: true, top_p: 0.9 } } }, () =>
				captureRequestBody(createConfiguredProvider(), modelInfo, {
					toolMode: vscode.LanguageModelChatToolMode.Auto,
				})
			);
			assert.strictEqual(body.top_p, 0.9);
			assert.strictEqual(body._replaceDefaults, undefined, "Retired extension metadata must not reach the server");
			assert.strictEqual(body.temperature, undefined);
		});

		test("sends the chat request to /v1/chat/completions on the configured server", async () => {
			let chatUrl = "";
			const provider = createConfiguredProvider();
			await withFetch(
				async (url, init) => {
					const urlStr = url.toString();
					if ((init?.method ?? "GET") === "POST") {
						chatUrl = urlStr;
						return new Response(
							new ReadableStream({
								start(controller) {
									controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
									controller.close();
								},
							}),
							{ status: 200, headers: { "Content-Type": "text/event-stream" } }
						);
					}
					return jsonResponse({
						data: [{ model_name: "test-model", model_info: { id: "test-model", supports_function_calling: true } }],
					});
				},
				async () => {
					await provider.provideLanguageModelChatInformation(
						{ silent: true },
						new vscode.CancellationTokenSource().token
					);
					await provider.provideLanguageModelChatResponse(
						modelInfo,
						[userMessage("test")],
						{ toolMode: vscode.LanguageModelChatToolMode.Auto } as vscode.ProvideLanguageModelChatResponseOptions,
						{ report: () => {} },
						new vscode.CancellationTokenSource().token
					);
				}
			);
			assert.equal(chatUrl, "http://test/v1/chat/completions");
		});
	});

	suite("max_tokens precedence", () => {
		test("runtime modelOptions.max_tokens wins over configured modelParameters", async () => {
			const body = await withConfig({ modelParameters: { "test-model": { max_tokens: 2222 } } }, () =>
				captureRequestBody(createConfiguredProvider(), modelInfo, {
					toolMode: vscode.LanguageModelChatToolMode.Auto,
					modelOptions: { max_tokens: 1234 },
				})
			);
			assert.strictEqual(body.max_tokens, 1234);
		});

		test("runtime modelOptions.max_tokens wins over the fallback cap", async () => {
			const body = await withConfig({ modelParameters: {} }, () =>
				captureRequestBody(createConfiguredProvider(), modelInfo, {
					toolMode: vscode.LanguageModelChatToolMode.Auto,
					modelOptions: { max_tokens: 1234 },
				})
			);
			assert.strictEqual(body.max_tokens, 1234);
		});

		test("configured modelParameters.max_tokens wins over the fallback cap", async () => {
			const body = await withConfig({ modelParameters: { "test-model": { max_tokens: 2222 } } }, () =>
				captureRequestBody(createConfiguredProvider(), modelInfo, {
					toolMode: vscode.LanguageModelChatToolMode.Auto,
				})
			);
			assert.strictEqual(body.max_tokens, 2222);
		});

		test("without runtime or configured value, falls back to min(4096, model max output)", async () => {
			const bodyLargeModel = await withConfig({ modelParameters: {} }, () =>
				captureRequestBody(createConfiguredProvider(), modelInfo, {
					toolMode: vscode.LanguageModelChatToolMode.Auto,
				})
			);
			assert.strictEqual(bodyLargeModel.max_tokens, 4096, "Cap applies when the model allows more");

			const bodySmallModel = await withConfig({ modelParameters: {} }, () =>
				captureRequestBody(createConfiguredProvider(), makeModelInfo({ maxOutputTokens: 2000 }), {
					toolMode: vscode.LanguageModelChatToolMode.Auto,
				})
			);
			assert.strictEqual(bodySmallModel.max_tokens, 2000, "Model max wins when below the cap");
		});
	});

	suite("prompt caching", () => {
		const cachingDiscoveryPayload = (supportsPromptCaching: boolean) => ({
			data: [
				{
					model_name: "test-model",
					model_info: {
						id: "test-model",
						supports_function_calling: true,
						supports_prompt_caching: supportsPromptCaching,
						max_input_tokens: 100000,
						max_output_tokens: 8000,
					},
				},
			],
		});

		const chatMessages = [systemMessage("You are helpful."), userMessage("hi")];

		function systemEntry(body: Record<string, unknown>): unknown {
			const messages = body.messages as Array<{ role: string; content: unknown }>;
			const system = messages.find((m) => m.role === "system");
			assert.ok(system, "Request must contain a system message");
			return system.content;
		}

		test("system message carries cache_control when the model supports caching and the setting is on", async () => {
			const body = await withConfig({ "promptCaching.enabled": true }, () =>
				captureRequestBody(
					createConfiguredProvider(),
					modelInfo,
					{ toolMode: vscode.LanguageModelChatToolMode.Auto },
					{ messages: chatMessages, discoveryPayload: cachingDiscoveryPayload(true) }
				)
			);
			const content = systemEntry(body);
			assert.ok(Array.isArray(content), "Cached system content must use the array form");
			assert.deepStrictEqual(content, [
				{ type: "text", text: "You are helpful.", cache_control: { type: "ephemeral" } },
			]);
		});

		test("no cache_control when the model does not advertise prompt caching support", async () => {
			const body = await withConfig({ "promptCaching.enabled": true }, () =>
				captureRequestBody(
					createConfiguredProvider(),
					modelInfo,
					{ toolMode: vscode.LanguageModelChatToolMode.Auto },
					{ messages: chatMessages, discoveryPayload: cachingDiscoveryPayload(false) }
				)
			);
			const content = systemEntry(body);
			assert.strictEqual(content, "You are helpful.", "Unsupported models keep plain string system content");
		});

		test("no cache_control when promptCaching.enabled is off, even for supporting models", async () => {
			const body = await withConfig({ "promptCaching.enabled": false }, () =>
				captureRequestBody(
					createConfiguredProvider(),
					modelInfo,
					{ toolMode: vscode.LanguageModelChatToolMode.Auto },
					{ messages: chatMessages, discoveryPayload: cachingDiscoveryPayload(true) }
				)
			);
			const content = systemEntry(body);
			assert.strictEqual(content, "You are helpful.", "Disabled setting keeps plain string system content");
		});
	});

	suite("request limits", () => {
		test("rejects when the estimated input exceeds the model token limit without sending a request", async () => {
			const provider = makeProvider("http://test");
			let fetchCalled = false;
			await withFetch(
				async () => {
					fetchCalled = true;
					throw new Error("fetch must not be called");
				},
				async () => {
					await assert.rejects(
						provider.provideLanguageModelChatResponse(
							makeModelInfo({ maxInputTokens: 10 }),
							[userMessage("x".repeat(4000))],
							{ toolMode: vscode.LanguageModelChatToolMode.Auto } as vscode.ProvideLanguageModelChatResponseOptions,
							{ report: () => {} },
							new vscode.CancellationTokenSource().token
						),
						/exceeds token limit/
					);
				}
			);
			assert.strictEqual(fetchCalled, false, "Over-limit requests must be rejected before any network call");
		});

		test("rejects requests with more than 128 tools without sending a request", async () => {
			const provider = makeProvider("http://test");
			const tools = Array.from({ length: 129 }, (_, i) => ({
				name: `tool_${i}`,
				description: "a tool",
				inputSchema: { type: "object", properties: {} },
			}));
			let fetchCalled = false;
			await withFetch(
				async () => {
					fetchCalled = true;
					throw new Error("fetch must not be called");
				},
				async () => {
					await assert.rejects(
						provider.provideLanguageModelChatResponse(
							modelInfo,
							[userMessage("hi")],
							{
								toolMode: vscode.LanguageModelChatToolMode.Auto,
								tools,
							} as unknown as vscode.ProvideLanguageModelChatResponseOptions,
							{ report: () => {} },
							new vscode.CancellationTokenSource().token
						),
						/more than 128 tools/
					);
				}
			);
			assert.strictEqual(fetchCalled, false, "Requests over the tool limit must be rejected before any network call");
		});
	});
});
