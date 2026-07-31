import * as assert from "node:assert";
import { HttpResponse, http } from "msw";
import * as vscode from "vscode";
import { findLongestPrefixMatch, getModelParameters } from "../../provider/request";
import {
	CHAT_COMPLETIONS_URL,
	discoveryHandlers,
	mswServer,
	sseResponse,
	TEST_BASE_URL,
	useMsw,
} from "../mocks/handlers";
import {
	captureRequest,
	captureRequestBody,
	createConfiguredProvider,
	makeModelInfo,
	makeProvider,
	systemMessage,
	userMessage,
	withConfig,
} from "../testUtils";

const modelInfo = makeModelInfo();

function singleProviderListing(provider: Record<string, string | number | boolean | null>) {
	return {
		object: "list",
		data: [
			{
				id: "test-model",
				object: "model",
				created: 0,
				owned_by: "test",
				providers: [{ provider: "test-provider", status: "active", supports_tools: true, ...provider }],
			},
		],
	};
}

suite("provider/request contract", () => {
	useMsw();

	suite("token constraints", () => {
		test("uses token constraints from provider info when available", async () => {
			const provider = makeProvider(TEST_BASE_URL);
			mswServer.use(
				...discoveryHandlers(
					singleProviderListing({ context_length: 100000, max_output_tokens: 8000, max_input_tokens: 90000 })
				)
			);

			const infos = await provider.provideLanguageModelChatInformation(
				{ silent: true },
				new vscode.CancellationTokenSource().token
			);

			const providerEntry = infos.find((i) => i.id === "test-model:test-provider");
			assert.ok(providerEntry, "Provider entry should exist");
			assert.equal(providerEntry.maxOutputTokens, 8000);
			assert.equal(providerEntry.maxInputTokens, 90000);
		});

		test("registers models as selectable BYOK entries without the retired metadata bag", async () => {
			const provider = makeProvider(TEST_BASE_URL);
			mswServer.use(...discoveryHandlers(singleProviderListing({})));

			const infos = await provider.provideLanguageModelChatInformation(
				{ silent: true },
				new vscode.CancellationTokenSource().token
			);
			const providerEntry = infos.find((i) => i.id === "test-model:test-provider");
			assert.ok(providerEntry);

			assert.equal(
				providerEntry.isUserSelectable,
				true,
				"absent fails the truthy checks in the host's MCP sampling picker and local chat sessions"
			);
			assert.equal(providerEntry.isBYOK, true, "models run against the user's own LiteLLM credentials");
			assert.ok(!("metadata" in providerEntry), "the pre-1.120 metadata duplicate is retired");
		});

		test("uses workspace settings as fallback when provider fields absent", async () => {
			mswServer.use(...discoveryHandlers(singleProviderListing({})));
			const infos = await withConfig(
				{ defaultMaxOutputTokens: 20000, defaultContextLength: 200000, defaultMaxInputTokens: null },
				() =>
					makeProvider(TEST_BASE_URL).provideLanguageModelChatInformation(
						{ silent: true },
						new vscode.CancellationTokenSource().token
					)
			);
			const providerEntry = infos.find((i) => i.id === "test-model:test-provider");
			assert.ok(providerEntry);
			assert.equal(providerEntry.maxOutputTokens, 20000);
			assert.equal(providerEntry.maxInputTokens, 180000);
		});

		test("uses configured defaultMaxInputTokens as an explicit override", async () => {
			mswServer.use(
				...discoveryHandlers(
					singleProviderListing({ context_length: 100000, max_output_tokens: 8000, max_input_tokens: 90000 })
				)
			);
			const infos = await withConfig({ defaultMaxInputTokens: 50000 }, () =>
				makeProvider(TEST_BASE_URL).provideLanguageModelChatInformation(
					{ silent: true },
					new vscode.CancellationTokenSource().token
				)
			);
			const providerEntry = infos.find((i) => i.id === "test-model:test-provider");
			assert.ok(providerEntry);
			assert.equal(providerEntry.maxInputTokens, 50000);
		});

		test("treats null provider max_input_tokens as missing and falls back to workspace setting", async () => {
			mswServer.use(
				...discoveryHandlers(
					singleProviderListing({ context_length: 100000, max_output_tokens: 8000, max_input_tokens: null })
				)
			);
			const infos = await withConfig({ defaultMaxInputTokens: 48000 }, () =>
				makeProvider(TEST_BASE_URL).provideLanguageModelChatInformation(
					{ silent: true },
					new vscode.CancellationTokenSource().token
				)
			);
			const providerEntry = infos.find((i) => i.id === "test-model:test-provider");
			assert.ok(providerEntry);
			assert.equal(providerEntry.maxInputTokens, 48000);
		});

		test("uses hardcoded defaults when provider and settings absent", async () => {
			mswServer.use(...discoveryHandlers(singleProviderListing({})));
			const infos = await withConfig({}, () =>
				makeProvider(TEST_BASE_URL).provideLanguageModelChatInformation(
					{ silent: true },
					new vscode.CancellationTokenSource().token
				)
			);
			const providerEntry = infos.find((i) => i.id === "test-model:test-provider");
			assert.ok(providerEntry);
			assert.equal(providerEntry.maxOutputTokens, 16000);
			assert.equal(providerEntry.maxInputTokens, 112000);
		});

		test("aggregates collapse to the minimum standalone constraints for cheapest/fastest entries", async () => {
			// provider-a declares a max_input_tokens tighter than its context minus
			// output; the aggregate must respect it. The retired inline formula
			// (min context - min output = 46000) ignored declared input limits and
			// advertised more input than provider-a accepts.
			const provider = makeProvider(TEST_BASE_URL);
			mswServer.use(
				...discoveryHandlers({
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
									max_input_tokens: 30000,
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
				})
			);

			const infos = await provider.provideLanguageModelChatInformation(
				{ silent: true },
				new vscode.CancellationTokenSource().token
			);

			const cheapestEntry = infos.find((i) => i.id === "test-model:cheapest");
			const fastestEntry = infos.find((i) => i.id === "test-model:fastest");
			assert.ok(cheapestEntry);
			assert.ok(fastestEntry);
			assert.equal(cheapestEntry.maxOutputTokens, 4000);
			assert.equal(fastestEntry.maxOutputTokens, 4000);
			assert.equal(
				cheapestEntry.maxInputTokens,
				30000,
				"provider-a's declared input limit is the strictest standalone constraint and must cap the aggregate"
			);
			assert.equal(fastestEntry.maxInputTokens, 30000);
		});

		test("provider max_output_tokens takes priority over max_tokens", async () => {
			const provider = makeProvider(TEST_BASE_URL);
			mswServer.use(
				...discoveryHandlers(
					singleProviderListing({ context_length: 100000, max_tokens: 10000, max_output_tokens: 8000 })
				)
			);

			const infos = await provider.provideLanguageModelChatInformation(
				{ silent: true },
				new vscode.CancellationTokenSource().token
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

		test("a baseUrl server scope matches and wins over an unscoped entry", async () => {
			const params = await withConfig(
				{
					modelParameters: {
						"http://litellm.test/gpt-4": { temperature: 0.2 },
						"gpt-4": { temperature: 0.8 },
					},
				},
				() => getModelParameters("gpt-4-turbo", new Map(), ["http://litellm.test"])
			);
			assert.deepEqual(params, { temperature: 0.2 });
		});

		test("legacy label scopes match alongside the baseUrl scope", async () => {
			const params = await withConfig({ modelParameters: { "Production/gpt-4": { temperature: 0.4 } } }, () =>
				getModelParameters("gpt-4", new Map(), ["http://litellm.test", "Production"])
			);
			assert.deepEqual(params, { temperature: 0.4 });
		});

		test("the most specific model prefix wins across scopes", async () => {
			const params = await withConfig(
				{
					modelParameters: {
						"Production/gpt-4": { temperature: 0.4 },
						"http://litellm.test/gpt-4-turbo": { temperature: 0.6 },
					},
				},
				() => getModelParameters("gpt-4-turbo", new Map(), ["http://litellm.test", "Production"])
			);
			assert.deepEqual(params, { temperature: 0.6 });
		});

		test("a long scope with a vague model prefix never outranks a precise short-scoped key", async () => {
			const params = await withConfig(
				{
					modelParameters: {
						"http://very-long-server-url.example.com:4000/g": { temperature: 0.1 },
						"Prod/gpt-4-turbo": { temperature: 0.9 },
					},
				},
				() => getModelParameters("gpt-4-turbo", new Map(), ["http://very-long-server-url.example.com:4000", "Prod"])
			);
			assert.deepEqual(params, { temperature: 0.9 });
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
			mswServer.use(
				...discoveryHandlers({
					data: [{ model_name: "test-model", model_info: { id: "test-model", supports_function_calling: true } }],
				}),
				http.post(CHAT_COMPLETIONS_URL, ({ request }) => {
					chatUrl = request.url;
					return sseResponse("data: [DONE]\n\n");
				})
			);

			await provider.provideLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token);
			await provider.provideLanguageModelChatResponse(
				modelInfo,
				[userMessage("test")],
				{ toolMode: vscode.LanguageModelChatToolMode.Auto } as vscode.ProvideLanguageModelChatResponseOptions,
				{ report: () => {} },
				new vscode.CancellationTokenSource().token
			);
			assert.equal(chatUrl, `${TEST_BASE_URL}/v1/chat/completions`);
		});
	});

	suite("model picker configuration", () => {
		test("the picker's reasoning effort choice lands as reasoning_effort", async () => {
			const body = await captureRequestBody(createConfiguredProvider(), modelInfo, {
				toolMode: vscode.LanguageModelChatToolMode.Auto,
				modelConfiguration: { reasoningEffort: "high" },
			});
			assert.strictEqual(body.reasoning_effort, "high");
		});

		test("an unset picker sends no reasoning_effort key", async () => {
			// Unset arrives as the resolved schema default ("default", the
			// provider-default sentinel); a host without the schema sends no
			// modelConfiguration at all. Neither may put anything on the wire.
			const sentinel = await captureRequestBody(createConfiguredProvider(), modelInfo, {
				toolMode: vscode.LanguageModelChatToolMode.Auto,
				modelConfiguration: { reasoningEffort: "default" },
			});
			assert.ok(!("reasoning_effort" in sentinel), "picking Provider default (or never picking) sends nothing");

			const absent = await captureRequestBody(createConfiguredProvider(), modelInfo, {
				toolMode: vscode.LanguageModelChatToolMode.Auto,
			});
			assert.ok(!("reasoning_effort" in absent));
		});

		test("runtime modelOptions.reasoning_effort outranks the picker choice", async () => {
			const body = await captureRequestBody(createConfiguredProvider(), modelInfo, {
				toolMode: vscode.LanguageModelChatToolMode.Auto,
				modelOptions: { reasoning_effort: "low" },
				modelConfiguration: { reasoningEffort: "high" },
			});
			assert.strictEqual(body.reasoning_effort, "low");
		});

		test("the picker choice outranks configured modelParameters", async () => {
			const body = await withConfig({ modelParameters: { "test-model": { reasoning_effort: "low" } } }, () =>
				captureRequestBody(createConfiguredProvider(), modelInfo, {
					toolMode: vscode.LanguageModelChatToolMode.Auto,
					modelConfiguration: { reasoningEffort: "high" },
				})
			);
			assert.strictEqual(body.reasoning_effort, "high");
		});

		test("a malformed picker value drops and leaves lower-precedence sources intact", async () => {
			const configured = await withConfig({ modelParameters: { "test-model": { reasoning_effort: "medium" } } }, () =>
				captureRequestBody(createConfiguredProvider(), modelInfo, {
					toolMode: vscode.LanguageModelChatToolMode.Auto,
					modelConfiguration: { reasoningEffort: "extreme" },
				})
			);
			assert.strictEqual(configured.reasoning_effort, "medium", "the invalid choice must not shadow the config");

			const bare = await captureRequestBody(createConfiguredProvider(), modelInfo, {
				toolMode: vscode.LanguageModelChatToolMode.Auto,
				modelConfiguration: { reasoningEffort: 42 },
			});
			assert.ok(!("reasoning_effort" in bare), "an invalid choice with no other source sends nothing");
		});

		test("modelConfiguration properties outside the declared schema never reach the body", async () => {
			const body = await captureRequestBody(createConfiguredProvider(), modelInfo, {
				toolMode: vscode.LanguageModelChatToolMode.Auto,
				modelConfiguration: { reasoningEffort: "low", verbosity: "high", temperature: 0.9 },
			});
			assert.strictEqual(body.reasoning_effort, "low");
			assert.ok(!("verbosity" in body), "only schema-declared properties are mapped, never a blind spread");
			assert.ok(!("temperature" in body));
		});
	});

	suite("message conversion capability gates", () => {
		// Pins the chatClient wiring, not the conversion itself (shared/messages
		// tests own that): deleting either gate from the convertMessages call
		// site must fail here.
		const imageMessage = (): vscode.LanguageModelChatRequestMessage => ({
			role: vscode.LanguageModelChatMessageRole.User,
			content: [
				new vscode.LanguageModelTextPart("look:"),
				new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), "image/png"),
			],
			name: undefined,
		});
		const audioMessage = (): vscode.LanguageModelChatRequestMessage => ({
			role: vscode.LanguageModelChatMessageRole.User,
			content: [
				new vscode.LanguageModelTextPart("listen:"),
				new vscode.LanguageModelDataPart(new Uint8Array([4, 5, 6]), "audio/wav"),
			],
			name: undefined,
		});

		test("the model's imageInput capability gates image conversion on the wire", async () => {
			const withImageInput = await captureRequestBody(
				createConfiguredProvider(),
				makeModelInfo({ capabilities: { imageInput: true } }),
				{ toolMode: vscode.LanguageModelChatToolMode.Auto },
				{ messages: [imageMessage()] }
			);
			assert.ok(JSON.stringify(withImageInput.messages).includes("image_url"), "a vision model gets the image block");

			const withoutImageInput = await captureRequestBody(
				createConfiguredProvider(),
				makeModelInfo(),
				{ toolMode: vscode.LanguageModelChatToolMode.Auto },
				{ messages: [imageMessage()] }
			);
			assert.ok(
				!JSON.stringify(withoutImageInput.messages).includes("image_url"),
				"a non-vision model must never receive an image block"
			);
		});

		test("the model's audio metadata gates input_audio conversion on the wire", async () => {
			const withAudio = await captureRequestBody(
				createConfiguredProvider(),
				makeModelInfo({
					litellm: { supportsPromptCaching: false, outputLimitSource: "defaults", supportsAudioInput: true },
				}),
				{ toolMode: vscode.LanguageModelChatToolMode.Auto },
				{ messages: [audioMessage()] }
			);
			assert.ok(
				JSON.stringify(withAudio.messages).includes("input_audio"),
				"an audio model gets the input_audio block"
			);

			const withoutAudio = await captureRequestBody(
				createConfiguredProvider(),
				makeModelInfo(),
				{ toolMode: vscode.LanguageModelChatToolMode.Auto },
				{ messages: [audioMessage()] }
			);
			assert.ok(
				!JSON.stringify(withoutAudio.messages).includes("input_audio"),
				"a non-audio model must never receive an input_audio block"
			);
		});
	});

	suite("max_tokens precedence", () => {
		/** A /v1/model/info listing for one "test-model" entry with the given model_info fields. */
		const infoListing = (...modelInfos: Record<string, unknown>[]) => ({
			data: modelInfos.map((modelInfo) => ({
				model_name: "test-model",
				model_info: { supports_function_calling: true, max_input_tokens: 100000, ...modelInfo },
			})),
		});

		/** A /v1/models listing for one "test-model" with several tool-capable providers. */
		const providersListing = (...providers: Record<string, unknown>[]) => ({
			object: "list",
			data: [
				{
					id: "test-model",
					object: "model",
					created: 0,
					owned_by: "test",
					providers: providers.map((provider, i) => ({
						provider: `provider-${i}`,
						status: "active",
						supports_tools: true,
						context_length: 100000,
						...provider,
					})),
				},
			],
		});

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

		test("a server-declared output limit is sent uncapped", async () => {
			const body = await withConfig({ modelParameters: {} }, () =>
				captureRequestBody(
					createConfiguredProvider(),
					modelInfo,
					{ toolMode: vscode.LanguageModelChatToolMode.Auto },
					{ discoveryPayload: infoListing({ max_output_tokens: 32000 }), useDiscoveredModel: true }
				)
			);
			assert.strictEqual(body.max_tokens, 32000, "an admin's declared limit must not be clamped to 4096");
		});

		test("a defaults-derived output limit stays capped at 4096", async () => {
			const body = await withConfig({ modelParameters: {}, defaultMaxOutputTokens: 16000 }, () =>
				captureRequestBody(
					createConfiguredProvider(),
					modelInfo,
					{ toolMode: vscode.LanguageModelChatToolMode.Auto },
					{ discoveryPayload: infoListing({}), useDiscoveredModel: true }
				)
			);
			assert.strictEqual(body.max_tokens, 4096, "the defaultMaxOutputTokens guess must not escape the cap");
		});

		test("runtime and configured max_tokens still outrank a server-declared limit", async () => {
			const declared = { discoveryPayload: infoListing({ max_output_tokens: 32000 }), useDiscoveredModel: true };
			const runtime = await withConfig({ modelParameters: { "test-model": { max_tokens: 2222 } } }, () =>
				captureRequestBody(
					createConfiguredProvider(),
					modelInfo,
					{ toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions: { max_tokens: 1234 } },
					declared
				)
			);
			assert.strictEqual(runtime.max_tokens, 1234);

			const configured = await withConfig({ modelParameters: { "test-model": { max_tokens: 2222 } } }, () =>
				captureRequestBody(
					createConfiguredProvider(),
					modelInfo,
					{ toolMode: vscode.LanguageModelChatToolMode.Auto },
					declared
				)
			);
			assert.strictEqual(configured.max_tokens, 2222);
		});

		test("a merged load-balanced model keeps its declared minimum uncapped", async () => {
			const body = await withConfig({ modelParameters: {} }, () =>
				captureRequestBody(
					createConfiguredProvider(),
					modelInfo,
					{ toolMode: vscode.LanguageModelChatToolMode.Auto },
					{
						discoveryPayload: infoListing({ max_output_tokens: 32000 }, { max_output_tokens: 24000 }),
						useDiscoveredModel: true,
					}
				)
			);
			assert.strictEqual(body.max_tokens, 24000, "every deployment declared a limit, so the merged minimum is honored");
		});

		test("a merged model with an undeclared deployment falls back to the cap", async () => {
			const body = await withConfig({ modelParameters: {}, defaultMaxOutputTokens: 16000 }, () =>
				captureRequestBody(
					createConfiguredProvider(),
					modelInfo,
					{ toolMode: vscode.LanguageModelChatToolMode.Auto },
					{ discoveryPayload: infoListing({ max_output_tokens: 32000 }, {}), useDiscoveredModel: true }
				)
			);
			assert.strictEqual(body.max_tokens, 4096, "one defaults-filled deployment demotes the merged limit to a guess");
		});

		test("an aggregate entry keeps a fully declared minimum uncapped", async () => {
			const body = await withConfig({ modelParameters: {} }, () =>
				captureRequestBody(
					createConfiguredProvider(),
					makeModelInfo({ id: "test-model:cheapest" }),
					{ toolMode: vscode.LanguageModelChatToolMode.Auto },
					{
						discoveryPayload: providersListing({ max_output_tokens: 32000 }, { max_output_tokens: 24000 }),
						useDiscoveredModel: true,
					}
				)
			);
			assert.strictEqual(body.max_tokens, 24000);
		});

		test("an aggregate entry falls back to the cap when any provider left its limit to defaults", async () => {
			const body = await withConfig({ modelParameters: {}, defaultMaxOutputTokens: 16000 }, () =>
				captureRequestBody(
					createConfiguredProvider(),
					makeModelInfo({ id: "test-model:fastest" }),
					{ toolMode: vscode.LanguageModelChatToolMode.Auto },
					{ discoveryPayload: providersListing({ max_output_tokens: 32000 }, {}), useDiscoveredModel: true }
				)
			);
			assert.strictEqual(body.max_tokens, 4096);
		});

		test("a wire payload claiming provider provenance without a declared limit stays capped end-to-end", async () => {
			// The provider schema is a loose pass-through, so a server payload can
			// carry the merge's internal output_limit_source marker. Discovery,
			// registration, and the chat request together must treat the claim as
			// noise: with no declared limit, the request stays under the cap.
			const body = await withConfig({ modelParameters: {}, defaultMaxOutputTokens: 16000 }, () =>
				captureRequestBody(
					createConfiguredProvider(),
					makeModelInfo({ id: "test-model:provider-0" }),
					{ toolMode: vscode.LanguageModelChatToolMode.Auto },
					{ discoveryPayload: providersListing({ output_limit_source: "provider" }), useDiscoveredModel: true }
				)
			);
			assert.strictEqual(body.max_tokens, 4096, "a spoofed provenance claim must not lift the cap");
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

		function assistantMessage(text: string): vscode.LanguageModelChatRequestMessage {
			return {
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelTextPart(text)],
				name: undefined,
			};
		}

		const agentMessages = [
			systemMessage("You are helpful."),
			userMessage("Review the repository."),
			assistantMessage("Starting with the README."),
			userMessage("Now check the tests."),
		];

		const agentTools = [
			{ name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: {} } },
			{ name: "list_dir", description: "List a directory", inputSchema: { type: "object", properties: {} } },
		];

		function systemEntry(body: Record<string, unknown>): unknown {
			const messages = body.messages as Array<{ role: string; content: unknown }>;
			const system = messages.find((m) => m.role === "system");
			assert.ok(system, "Request must contain a system message");
			return system.content;
		}

		/** Every cache_control occurrence in the serialized request body. */
		function countMarkers(body: Record<string, unknown>): number {
			return JSON.stringify(body).split('"cache_control"').length - 1;
		}

		function cachedBlock(text: string) {
			return [{ type: "text", text, cache_control: { type: "ephemeral" } }];
		}

		test("system message carries cache_control when the model supports caching and the setting is on", async () => {
			const body = await withConfig({ "promptCaching.enabled": true }, () =>
				captureRequestBody(
					createConfiguredProvider(),
					modelInfo,
					{ toolMode: vscode.LanguageModelChatToolMode.Auto },
					{ messages: chatMessages, discoveryPayload: cachingDiscoveryPayload(true), useDiscoveredModel: true }
				)
			);
			const content = systemEntry(body);
			assert.ok(Array.isArray(content), "Cached system content must use the array form");
			assert.deepStrictEqual(content, cachedBlock("You are helpful."));
		});

		test("a tools + multi-turn request spends the full four-breakpoint budget", async () => {
			const body = await withConfig({ "promptCaching.enabled": true }, () =>
				captureRequestBody(
					createConfiguredProvider(),
					modelInfo,
					{ toolMode: vscode.LanguageModelChatToolMode.Auto, tools: agentTools },
					{ messages: agentMessages, discoveryPayload: cachingDiscoveryPayload(true), useDiscoveredModel: true }
				)
			);

			const tools = body.tools as Array<{ function: { name: string }; cache_control?: unknown }>;
			assert.strictEqual(tools[0]?.cache_control, undefined, "only the last tool is marked");
			assert.deepStrictEqual(tools[1]?.cache_control, { type: "ephemeral" }, "the last tool caches the tools block");

			const messages = body.messages as Array<{ role: string; content: unknown }>;
			assert.deepStrictEqual(messages[0]?.content, cachedBlock("You are helpful."), "system anchor");
			assert.deepStrictEqual(messages[1]?.content, cachedBlock("Review the repository."), "first-user anchor");
			assert.strictEqual(messages[2]?.content, "Starting with the README.", "mid-conversation stays a string");
			assert.deepStrictEqual(messages[3]?.content, cachedBlock("Now check the tests."), "rolling anchor");
			assert.strictEqual(countMarkers(body), 4, "exactly the four-breakpoint budget");
		});

		test("colliding anchors keep the request within budget", async () => {
			const body = await withConfig({ "promptCaching.enabled": true }, () =>
				captureRequestBody(
					createConfiguredProvider(),
					modelInfo,
					{ toolMode: vscode.LanguageModelChatToolMode.Auto },
					{ messages: chatMessages, discoveryPayload: cachingDiscoveryPayload(true), useDiscoveredModel: true }
				)
			);
			// "hi" is both the first user message and the last message; one marker.
			const messages = body.messages as Array<{ role: string; content: unknown }>;
			assert.deepStrictEqual(messages[1]?.content, cachedBlock("hi"));
			assert.strictEqual(countMarkers(body), 2, "system plus the deduplicated user anchor");
		});

		test("no cache_control when the model does not advertise prompt caching support", async () => {
			const body = await withConfig({ "promptCaching.enabled": true }, () =>
				captureRequestBody(
					createConfiguredProvider(),
					modelInfo,
					{ toolMode: vscode.LanguageModelChatToolMode.Auto, tools: agentTools },
					{ messages: agentMessages, discoveryPayload: cachingDiscoveryPayload(false), useDiscoveredModel: true }
				)
			);
			assert.strictEqual(systemEntry(body), "You are helpful.", "Unsupported models keep plain string content");
			assert.strictEqual(countMarkers(body), 0, "no marker anywhere in the request");
		});

		test("no cache_control when promptCaching.enabled is off, even for supporting models", async () => {
			const body = await withConfig({ "promptCaching.enabled": false }, () =>
				captureRequestBody(
					createConfiguredProvider(),
					modelInfo,
					{ toolMode: vscode.LanguageModelChatToolMode.Auto, tools: agentTools },
					{ messages: agentMessages, discoveryPayload: cachingDiscoveryPayload(true), useDiscoveredModel: true }
				)
			);
			assert.strictEqual(systemEntry(body), "You are helpful.", "Disabled setting keeps plain string content");
			assert.strictEqual(countMarkers(body), 0, "no marker anywhere in the request");
		});
	});

	suite("request limits", () => {
		/**
		 * Record any provider request that escapes to the network so tests can
		 * assert none did. Scoped to the unit-test host: the extension host runs
		 * with built-in extensions whose unrelated background HTTP must not
		 * pollute the recording.
		 */
		function trackUnexpectedRequests(): string[] {
			const urls: string[] = [];
			mswServer.use(
				http.all(`${TEST_BASE_URL}/*`, ({ request }) => {
					urls.push(request.url);
					return HttpResponse.error();
				})
			);
			return urls;
		}

		test("rejects when the estimated input exceeds the model token limit without sending a request", async () => {
			const provider = makeProvider(TEST_BASE_URL);
			const requests = trackUnexpectedRequests();
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
			assert.deepStrictEqual(requests, [], "Over-limit requests must be rejected before any network call");
		});

		test("rejects requests with more than 128 tools without sending a request", async () => {
			const provider = makeProvider(TEST_BASE_URL);
			const tools = Array.from({ length: 129 }, (_, i) => ({
				name: `tool_${i}`,
				description: "a tool",
				inputSchema: { type: "object", properties: {} },
			}));
			const requests = trackUnexpectedRequests();
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
			assert.deepStrictEqual(requests, [], "Requests over the tool limit must be rejected before any network call");
		});
	});
});
