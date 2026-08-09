import * as assert from "node:assert";
import { HttpResponse, http } from "msw";
import * as vscode from "vscode";
import { entryModelParametersFor } from "../../../extension/servers/serverSync";
import { attachGroupServer } from "../../../provider/catalog/groupModels";
import { ChatClient } from "../../../provider/transport/chatClient";
import { resolveModelParameters } from "../../../shared/config/parameterResolution";
import { getModelParametersConfig } from "../../../shared/config/settings";
import { normalizeBaseUrl } from "../../../shared/util/baseUrl";
import {
	CHAT_COMPLETIONS_URL,
	discoveryHandlers,
	mswServer,
	sseResponse,
	TEST_BASE_URL,
	useMsw,
} from "../../mocks/handlers";
import {
	captureRequest,
	captureRequestBody,
	createConfiguredProvider,
	makeModelInfo,
	makeProvider,
	systemMessage,
	userMessage,
	withConfig,
} from "../../testUtils";

const modelInfo = makeModelInfo();

/**
 * The live-configuration read of the configured-parameters merge, exactly as
 * the request path composes it (getModelParametersConfig into the shared
 * resolver; requests read the same merge through the provider's memoized
 * ModelResolutionTable).
 */
function getModelParameters(
	rawModelId: string,
	entryParameters?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
) {
	return resolveModelParameters({ rawModelId, globalParameters: getModelParametersConfig(), entryParameters });
}

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

		test("treats null provider max_input_tokens as missing and derives context minus output", async () => {
			mswServer.use(
				...discoveryHandlers(
					singleProviderListing({ context_length: 100000, max_output_tokens: 8000, max_input_tokens: null })
				)
			);
			const infos = await makeProvider(TEST_BASE_URL).provideLanguageModelChatInformation(
				{ silent: true },
				new vscode.CancellationTokenSource().token
			);
			const providerEntry = infos.find((i) => i.id === "test-model:test-provider");
			assert.ok(providerEntry);
			assert.equal(providerEntry.maxInputTokens, 92000);
		});

		test("uses the built-in floors when the provider declares nothing", async () => {
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

	suite("models.parameters configuration", () => {
		test("exact model ID match returns parameters", async () => {
			const params = await withConfig(
				{ "models.parameters": { "gpt-4": { temperature: 0.8, max_tokens: 8000 } } },
				() => getModelParameters("gpt-4").params
			);
			assert.deepEqual(params, { temperature: 0.8, max_tokens: 8000 });
		});

		test("an exact key matches only its exact ID; a trailing glob matches the family", async () => {
			const exactOnly = await withConfig(
				{ "models.parameters": { "gpt-4": { temperature: 0.7 } } },
				() => getModelParameters("gpt-4-turbo:openai").params
			);
			assert.deepEqual(exactOnly, {}, "exact keys are no longer implicit prefixes");

			const viaGlob = await withConfig(
				{ "models.parameters": { "gpt-4*": { temperature: 0.7 } } },
				() => getModelParameters("gpt-4-turbo:openai").params
			);
			assert.deepEqual(viaGlob, { temperature: 0.7 });
		});

		test("the glob with the longest literal prefix takes precedence", async () => {
			const params = await withConfig(
				{
					"models.parameters": {
						"gpt*": { temperature: 0.5 },
						"gpt-4*": { temperature: 0.7 },
						"gpt-4-turbo*": { temperature: 0.9 },
					},
				},
				() => getModelParameters("gpt-4-turbo:fastest").params
			);
			assert.deepEqual(params, { temperature: 0.9 });
		});

		test("no match returns empty object", async () => {
			const params = await withConfig(
				{ "models.parameters": { "gpt-4": { temperature: 0.7 } } },
				() => getModelParameters("claude-opus").params
			);
			assert.deepEqual(params, {});
		});

		test("empty configuration returns empty object", async () => {
			const params = await withConfig({}, () => getModelParameters("gpt-4").params);
			assert.deepEqual(params, {});
		});

		test("models.parameters supports various parameter types", async () => {
			const params = await withConfig(
				{
					"models.parameters": {
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
				() => getModelParameters("test-model").params
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

		test("a pre-migration URL-scoped key is inert in the global record", async () => {
			// Server scoping is gone from the global records: a
			// "https://host/model" key can never match a model ID, so only the
			// plain matcher applies. The upgrade migration moves such keys into
			// the owning server entry.
			const params = await withConfig(
				{
					"models.parameters": {
						"http://litellm.test/gpt-4": { temperature: 0.2 },
						"gpt-4": { temperature: 0.8 },
					},
				},
				() => getModelParameters("gpt-4").params
			);
			assert.deepEqual(params, { temperature: 0.8 });
		});

		test("a pre-migration label scope no longer matches", async () => {
			const params = await withConfig(
				{
					"models.parameters": {
						"Production/gpt-4": { temperature: 0.4 },
						"gpt-4": { temperature: 0.8 },
					},
				},
				() => getModelParameters("gpt-4").params
			);
			assert.deepEqual(params, { temperature: 0.8 });
		});
	});

	suite("per-entry models.parameters", () => {
		/** A model whose attached group server carries the declared entry's label. */
		const labeledModel = (label: string) =>
			attachGroupServer(makeModelInfo(), { baseUrl: normalizeBaseUrl(TEST_BASE_URL), apiKey: "test-key", label });

		test("entry parameters override the global match key by key", async () => {
			const params = await withConfig(
				{ "models.parameters": { "gpt-4*": { temperature: 0.8, top_p: 0.9 } } },
				() => getModelParameters("gpt-4-turbo", { "gpt-4*": { temperature: 0.2 } }).params
			);
			assert.deepEqual(params, { temperature: 0.2, top_p: 0.9 });
		});

		test("the most specific matcher wins within the entry record; URL keys are inert there too", async () => {
			const params = await withConfig(
				{ "models.parameters": {} },
				() =>
					getModelParameters("gpt-4-turbo", {
						"gpt*": { temperature: 0.5 },
						"gpt-4*": { temperature: 0.7 },
						"http://litellm.test/gpt-4": { temperature: 0.3 },
					}).params
			);
			assert.deepEqual(params, { temperature: 0.7 }, "a URL-prefixed entry key is just a non-matching key");
		});

		test("two entries sharing a base URL and key each send their own entry parameters", async () => {
			// The headline scenario: base-URL scoping cannot tell these apart, the
			// entry label can. The resolver is the real extension-side contract
			// (entryModelParametersFor) over a declared setting, wired exactly as
			// activation wires it, so this also pins that the label-and-URL check
			// still resolves entries whose group sits at the declared URL.
			const setting = [
				{
					label: "team-a",
					baseUrl: TEST_BASE_URL,
					models: { parameters: { "test-model": { temperature: 0.1, top_p: 0.9 } } },
				},
				{ label: "team-b", baseUrl: TEST_BASE_URL, models: { parameters: { "test-model": { temperature: 0.6 } } } },
			];
			const provider = makeProvider(TEST_BASE_URL, "test-key", undefined, {
				getEntryModelParameters: (label, baseUrl) => entryModelParametersFor(setting, label, baseUrl),
			});
			const globalConfig = { "models.parameters": { "test-model": { temperature: 0.8, seed: 7 } } };

			const bodyA = await withConfig(globalConfig, () =>
				captureRequestBody(provider, labeledModel("team-a"), { toolMode: vscode.LanguageModelChatToolMode.Auto })
			);
			assert.strictEqual(bodyA.temperature, 0.1);
			assert.strictEqual(bodyA.top_p, 0.9);
			assert.strictEqual(bodyA.seed, 7, "the global setting still supplies keys the entry leaves unset");

			const bodyB = await withConfig(globalConfig, () =>
				captureRequestBody(provider, labeledModel("team-b"), { toolMode: vscode.LanguageModelChatToolMode.Auto })
			);
			assert.strictEqual(bodyB.temperature, 0.6);
			assert.strictEqual(bodyB.seed, 7);
		});

		test("a label match at a different base URL yields only the global setting", async () => {
			// A stale group can outlive a baseUrl edit, and an external group can
			// carry any label; neither may inherit a declared entry's parameters.
			// The declared entry lives at another URL, so the resolver refuses the
			// pair even though the label matches.
			const setting = [
				{
					label: "team-a",
					baseUrl: "http://elsewhere.test",
					models: { parameters: { "test-model": { temperature: 0.1 } } },
				},
			];
			const provider = makeProvider(TEST_BASE_URL, "test-key", undefined, {
				getEntryModelParameters: (label, baseUrl) => entryModelParametersFor(setting, label, baseUrl),
			});
			const body = await withConfig({ "models.parameters": { "test-model": { temperature: 0.8 } } }, () =>
				captureRequestBody(provider, labeledModel("team-a"), { toolMode: vscode.LanguageModelChatToolMode.Auto })
			);
			assert.strictEqual(body.temperature, 0.8, "only the global setting applies");
		});

		test("a base URL match under a different label yields only the global setting", async () => {
			const setting = [
				{ label: "team-a", baseUrl: TEST_BASE_URL, models: { parameters: { "test-model": { temperature: 0.1 } } } },
			];
			const provider = makeProvider(TEST_BASE_URL, "test-key", undefined, {
				getEntryModelParameters: (label, baseUrl) => entryModelParametersFor(setting, label, baseUrl),
			});
			const body = await withConfig({ "models.parameters": { "test-model": { temperature: 0.8 } } }, () =>
				captureRequestBody(provider, labeledModel("team-b"), { toolMode: vscode.LanguageModelChatToolMode.Auto })
			);
			assert.strictEqual(body.temperature, 0.8, "only the global setting applies");
		});

		test("runtime options and the picker configuration still outrank entry parameters", async () => {
			const provider = makeProvider(TEST_BASE_URL, "test-key", undefined, {
				getEntryModelParameters: () => ({
					"test-model": { temperature: 0.2, reasoning_effort: "low", max_tokens: 3333 },
				}),
			});
			const body = await withConfig({ "models.parameters": { "test-model": { max_tokens: 2222 } } }, () =>
				captureRequestBody(provider, labeledModel("team-a"), {
					toolMode: vscode.LanguageModelChatToolMode.Auto,
					modelOptions: { temperature: 0.9 },
					modelConfiguration: { reasoningEffort: "high" },
				})
			);
			assert.strictEqual(body.temperature, 0.9, "runtime options outrank the entry");
			assert.strictEqual(body.reasoning_effort, "high", "the picker outranks the entry");
			assert.strictEqual(body.max_tokens, 3333, "the entry's max_tokens outranks the global setting's");
		});

		test("_force'd parameters outrank runtime options and the picker on the wire", async () => {
			const provider = makeProvider(TEST_BASE_URL, "test-key", undefined, {
				getEntryModelParameters: () => ({
					"test-model": { temperature: 0.2, reasoning_effort: "low", max_tokens: 9999, _force: true },
				}),
			});
			const body = await withConfig({ "models.parameters": { "test-model": { seed: 7, _force: ["seed"] } } }, () =>
				captureRequestBody(provider, labeledModel("team-a"), {
					toolMode: vscode.LanguageModelChatToolMode.Auto,
					modelOptions: { temperature: 0.9, seed: 42, max_tokens: 1234 },
					modelConfiguration: { reasoningEffort: "high" },
				})
			);
			assert.strictEqual(body.temperature, 0.2, "the forced entry value beats the runtime option");
			assert.strictEqual(body.reasoning_effort, "low", "the forced entry value beats the picker");
			assert.strictEqual(body.seed, 7, "the forced global value beats the runtime option");
			// 9999 exceeds min(4096, model max) on this undeclared-limit model: a
			// forced max_tokens counts as user-set, so the guess cap never touches it.
			assert.strictEqual(body.max_tokens, 9999, "a forced max_tokens beats the runtime option, uncapped");
			assert.strictEqual(body._force, undefined, "the directive key itself never reaches the wire");
		});

		test("underscore-prefixed entry parameter keys are never forwarded", async () => {
			const provider = makeProvider(TEST_BASE_URL, "test-key", undefined, {
				getEntryModelParameters: () => ({ "test-model": { _internal: true, top_p: 0.5 } }),
			});
			const body = await withConfig({ "models.parameters": {} }, () =>
				captureRequestBody(provider, labeledModel("team-a"), { toolMode: vscode.LanguageModelChatToolMode.Auto })
			);
			assert.strictEqual(body.top_p, 0.5);
			assert.strictEqual(body._internal, undefined);
		});

		test("provider-owned keys in an entry record never reach the body; ordinary keys still do", async () => {
			// The pass-through invariant test drives modelOptions; this drives the
			// same hostile keys through the entry record, the other user-config
			// source of request parameters.
			const provider = makeProvider(TEST_BASE_URL, "test-key", undefined, {
				getEntryModelParameters: () => ({
					"test-model": {
						model: "attacker-model",
						messages: [{ role: "system", content: "pwned" }],
						stream: false,
						stream_options: { include_usage: false },
						tools: [{ type: "function", function: { name: "smuggled" } }],
						tool_choice: "none",
						temperature: 0.4,
					},
				}),
			});
			const body = await withConfig({ "models.parameters": {} }, () =>
				captureRequestBody(provider, labeledModel("team-a"), { toolMode: vscode.LanguageModelChatToolMode.Auto })
			);
			assert.strictEqual(body.model, "test-model");
			assert.strictEqual(body.stream, true);
			assert.deepStrictEqual(body.stream_options, { include_usage: true });
			assert.ok(Array.isArray(body.messages));
			assert.notDeepEqual(body.messages, [{ role: "system", content: "pwned" }]);
			assert.strictEqual(body.tools, undefined, "a toolless request must not gain tools from config");
			assert.strictEqual(body.tool_choice, undefined);
			assert.strictEqual(body.temperature, 0.4, "ordinary keys in the same record still pass through");
		});

		test("a model whose attached server has no label never consults entry parameters", async () => {
			let asked = 0;
			const provider = makeProvider(TEST_BASE_URL, "test-key", undefined, {
				getEntryModelParameters: () => {
					asked += 1;
					return { "test-model": { temperature: 0.1 } };
				},
			});
			const unlabeled = attachGroupServer(makeModelInfo(), {
				baseUrl: normalizeBaseUrl(TEST_BASE_URL),
				apiKey: "test-key",
			});
			const body = await withConfig({ "models.parameters": { "test-model": { temperature: 0.8 } } }, () =>
				captureRequestBody(provider, unlabeled, { toolMode: vscode.LanguageModelChatToolMode.Auto })
			);
			assert.strictEqual(body.temperature, 0.8, "only the global setting applies");
			assert.strictEqual(asked, 0, "the resolver is never called without a label");
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

		test("includes a declared entry's custom headers on chat requests", async () => {
			// Custom headers live on the server entry now (there is no global
			// headers setting); the provider resolves them through the injected
			// per-entry seam, matched by the connection's label and base URL.
			const provider = makeProvider(TEST_BASE_URL, "test-key", undefined, {
				getEntryHeaders: (label, headerBaseUrl) =>
					label === "Default" && headerBaseUrl === TEST_BASE_URL
						? {
								"x-litellm-api-key": "proxy-key",
								"x-routing-env": "prod",
								"Content-Type": "text/plain",
								"User-Agent": "spoofed-agent",
							}
						: undefined,
			});
			const { headers } = await withConfig({ "models.parameters": {} }, () =>
				captureRequest(provider, modelInfo, {
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
			const body = await withConfig({ "models.parameters": {} }, () =>
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

		test("underscore-prefixed keys in models.parameters are not forwarded", async () => {
			const body = await withConfig(
				{ "models.parameters": { "test-model": { _replaceDefaults: true, top_p: 0.9 } } },
				() =>
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

		test("the picker choice outranks configured models.parameters", async () => {
			const body = await withConfig({ "models.parameters": { "test-model": { reasoning_effort: "low" } } }, () =>
				captureRequestBody(createConfiguredProvider(), modelInfo, {
					toolMode: vscode.LanguageModelChatToolMode.Auto,
					modelConfiguration: { reasoningEffort: "high" },
				})
			);
			assert.strictEqual(body.reasoning_effort, "high");
		});

		test("a malformed picker value drops and leaves lower-precedence sources intact", async () => {
			const configured = await withConfig(
				{ "models.parameters": { "test-model": { reasoning_effort: "medium" } } },
				() =>
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
					litellm: {
						supportsPromptCaching: false,
						outputLimitSource: "defaults",
						supportsAudioInput: true,
						serverDeclared: { kind: "discovered", values: {}, outputDeclared: false },
					},
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

		test("runtime modelOptions.max_tokens wins over configured models.parameters", async () => {
			const body = await withConfig({ "models.parameters": { "test-model": { max_tokens: 2222 } } }, () =>
				captureRequestBody(createConfiguredProvider(), modelInfo, {
					toolMode: vscode.LanguageModelChatToolMode.Auto,
					modelOptions: { max_tokens: 1234 },
				})
			);
			assert.strictEqual(body.max_tokens, 1234);
		});

		test("runtime modelOptions.max_tokens wins over the fallback cap", async () => {
			const body = await withConfig({ "models.parameters": {} }, () =>
				captureRequestBody(createConfiguredProvider(), modelInfo, {
					toolMode: vscode.LanguageModelChatToolMode.Auto,
					modelOptions: { max_tokens: 1234 },
				})
			);
			assert.strictEqual(body.max_tokens, 1234);
		});

		test("configured models.parameters.max_tokens wins over the fallback cap", async () => {
			const body = await withConfig({ "models.parameters": { "test-model": { max_tokens: 2222 } } }, () =>
				captureRequestBody(createConfiguredProvider(), modelInfo, {
					toolMode: vscode.LanguageModelChatToolMode.Auto,
				})
			);
			assert.strictEqual(body.max_tokens, 2222);
		});

		test("without runtime or configured value, falls back to min(4096, model max output)", async () => {
			const bodyLargeModel = await withConfig({ "models.parameters": {} }, () =>
				captureRequestBody(createConfiguredProvider(), modelInfo, {
					toolMode: vscode.LanguageModelChatToolMode.Auto,
				})
			);
			assert.strictEqual(bodyLargeModel.max_tokens, 4096, "Cap applies when the model allows more");

			const bodySmallModel = await withConfig({ "models.parameters": {} }, () =>
				captureRequestBody(createConfiguredProvider(), makeModelInfo({ maxOutputTokens: 2000 }), {
					toolMode: vscode.LanguageModelChatToolMode.Auto,
				})
			);
			assert.strictEqual(bodySmallModel.max_tokens, 2000, "Model max wins when below the cap");
		});

		test("a server-declared output limit is sent uncapped", async () => {
			const body = await withConfig({ "models.parameters": {} }, () =>
				captureRequestBody(
					createConfiguredProvider(),
					modelInfo,
					{ toolMode: vscode.LanguageModelChatToolMode.Auto },
					{ discoveryPayload: infoListing({ max_output_tokens: 32000 }), useDiscoveredModel: true }
				)
			);
			assert.strictEqual(body.max_tokens, 32000, "an admin's declared limit must not be clamped to 4096");
		});

		test("a user-overridden output limit (modelCapabilities) is sent uncapped like a declared one", async () => {
			// The capability override path stamps outputLimitSource: "user" on the
			// model; the request path must honor it across the host round trip
			// exactly like "provider" - the user's number is not a guess.
			const body = await withConfig({ "models.parameters": {} }, () =>
				captureRequestBody(
					createConfiguredProvider(),
					makeModelInfo({
						maxOutputTokens: 32000,
						litellm: {
							supportsPromptCaching: false,
							outputLimitSource: "user",
							serverDeclared: { kind: "discovered", values: {}, outputDeclared: false },
						},
					}),
					{ toolMode: vscode.LanguageModelChatToolMode.Auto }
				)
			);
			assert.strictEqual(body.max_tokens, 32000, "a user-set limit must not be clamped to 4096");
		});

		test("a defaults-derived output limit stays capped at 4096", async () => {
			const body = await withConfig({ "models.parameters": {} }, () =>
				captureRequestBody(
					createConfiguredProvider(),
					modelInfo,
					{ toolMode: vscode.LanguageModelChatToolMode.Auto },
					{ discoveryPayload: infoListing({}), useDiscoveredModel: true }
				)
			);
			assert.strictEqual(body.max_tokens, 4096, "the floor-guessed output limit must not escape the cap");
		});

		test("runtime and configured max_tokens still outrank a server-declared limit", async () => {
			const declared = { discoveryPayload: infoListing({ max_output_tokens: 32000 }), useDiscoveredModel: true };
			const runtime = await withConfig({ "models.parameters": { "test-model": { max_tokens: 2222 } } }, () =>
				captureRequestBody(
					createConfiguredProvider(),
					modelInfo,
					{ toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions: { max_tokens: 1234 } },
					declared
				)
			);
			assert.strictEqual(runtime.max_tokens, 1234);

			const configured = await withConfig({ "models.parameters": { "test-model": { max_tokens: 2222 } } }, () =>
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
			const body = await withConfig({ "models.parameters": {} }, () =>
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
			const body = await withConfig({ "models.parameters": {} }, () =>
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
			const body = await withConfig({ "models.parameters": {} }, () =>
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
			const body = await withConfig({ "models.parameters": {} }, () =>
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
			const body = await withConfig({ "models.parameters": {} }, () =>
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
			const body = await withConfig({ "chat.promptCaching": true }, () =>
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
			const body = await withConfig({ "chat.promptCaching": true }, () =>
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
			const body = await withConfig({ "chat.promptCaching": true }, () =>
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
			const body = await withConfig({ "chat.promptCaching": true }, () =>
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

		test("no cache_control when chat.promptCaching is off, even for supporting models", async () => {
			const body = await withConfig({ "chat.promptCaching": false }, () =>
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
				/token limit exceeded before send/
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
				/Too many chat tools are enabled/
			);
			assert.deepStrictEqual(requests, [], "Requests over the tool limit must be rejected before any network call");
		});
	});

	suite("localized display / English mirror pairs", () => {
		// Every chatClient throw site pairs a localized display message with a
		// full English mirror (localizedError). Under the test host's English
		// fallback the two coincide, so these tests fail when a site's mirror
		// drifts from its t() literal - or when a site forgets the mirror.
		function expectMirroredRejection(promise: Promise<unknown>, expected: RegExp): Promise<void> {
			return assert.rejects(promise, (e: unknown) => {
				assert.ok(e instanceof Error, `expected an Error, got ${String(e)}`);
				assert.match(e.message, expected);
				assert.strictEqual(
					(e as Error & { englishMessage?: string }).englishMessage,
					e.message,
					"the English mirror must match the English display"
				);
				return true;
			});
		}

		function send(client: ChatClient, model: Parameters<ChatClient["send"]>[0]["model"]): Promise<void> {
			return client.send({
				model,
				messages: [userMessage("hi")],
				options: {
					toolMode: vscode.LanguageModelChatToolMode.Auto,
				} as vscode.ProvideLanguageModelChatResponseOptions,
				progress: { report: () => {} },
				token: new vscode.CancellationTokenSource().token,
			});
		}

		test("a route whose server disappeared rejects with the mirrored server-gone message", async () => {
			const client = new ChatClient({ userAgent: "test", getServers: () => Promise.resolve([]) });
			client.applyRegistration(
				new Map([["m1", { serverId: "s1", serverLabel: "Old Server", rawModelId: "m1" }]]),
				true
			);
			await expectMirroredRejection(
				send(client, makeModelInfo({ id: "m1" })),
				/^Server "Old Server" is no longer configured$/
			);
		});

		test("a model no source resolves rejects with the mirrored not-registered message", async () => {
			const client = new ChatClient({ userAgent: "test", getServers: () => Promise.resolve([]) });
			await expectMirroredRejection(
				send(client, makeModelInfo({ id: "ghost" })),
				/^Model "ghost" is not registered with any configured server\. Refresh the model list and try again\.$/
			);
		});

		test("more tools than the cap rejects with the mirrored tools-cap message", async () => {
			const client = new ChatClient({ userAgent: "test" });
			const model = attachGroupServer(makeModelInfo(), {
				baseUrl: normalizeBaseUrl(TEST_BASE_URL),
				apiKey: "test-key",
				label: "Mirror",
			});
			const tools = Array.from({ length: 129 }, (_, i) => ({ name: `tool_${i}`, description: "a tool" }));
			await assert.rejects(
				client.send({
					model,
					messages: [userMessage("hi")],
					options: {
						toolMode: vscode.LanguageModelChatToolMode.Auto,
						tools,
					} as unknown as vscode.ProvideLanguageModelChatResponseOptions,
					progress: { report: () => {} },
					token: new vscode.CancellationTokenSource().token,
				}),
				(e: unknown) => {
					assert.ok(e instanceof Error);
					assert.strictEqual(
						e.message,
						"Too many chat tools are enabled for this request. Disable some in the chat Tools picker, or turn off unused extensions or MCP servers, and try again.\n\nDetails: 129 tools requested; the limit is 128 (request not sent)"
					);
					assert.strictEqual((e as Error & { englishMessage?: string }).englishMessage, e.message);
					return true;
				}
			);
		});

		test("an over-limit prompt rejects with the mirrored token-limit message", async () => {
			const client = new ChatClient({ userAgent: "test" });
			const model = attachGroupServer(makeModelInfo({ maxInputTokens: 10 }), {
				baseUrl: normalizeBaseUrl(TEST_BASE_URL),
				apiKey: "test-key",
				label: "Mirror",
			});
			await assert.rejects(
				client.send({
					model,
					messages: [userMessage("x".repeat(4000))],
					options: {
						toolMode: vscode.LanguageModelChatToolMode.Auto,
					} as vscode.ProvideLanguageModelChatResponseOptions,
					progress: { report: () => {} },
					token: new vscode.CancellationTokenSource().token,
				}),
				(e: unknown) => {
					assert.ok(e instanceof Error);
					assert.match(
						e.message,
						/^This conversation looks too long for the model - trim messages or attachments, or raise the model's input limit in settings if it is wrong\.\n\nDetails: token limit exceeded before send: local estimate \d+ tokens \(messages \+ tools\), input limit 10$/
					);
					assert.strictEqual((e as Error & { englishMessage?: string }).englishMessage, e.message);
					return true;
				}
			);
		});

		test("an empty 200 body rejects with the mirrored no-response-body message", async () => {
			mswServer.use(http.post(CHAT_COMPLETIONS_URL, () => new HttpResponse(null, { status: 200 })));
			const client = new ChatClient({ userAgent: "test" });
			const model = attachGroupServer(makeModelInfo(), {
				baseUrl: normalizeBaseUrl(TEST_BASE_URL),
				apiKey: "test-key",
				label: "Mirror",
			});
			await expectMirroredRejection(
				send(client, model),
				/^The server accepted the request but sent nothing back\. Try again; if it keeps happening, check any proxy or gateway between VS Code and the LiteLLM server\.\n\nDetails: LiteLLM answered 200 with a missing response body \(http:\/\/litellm\.test\)$/
			);
		});
	});
});
