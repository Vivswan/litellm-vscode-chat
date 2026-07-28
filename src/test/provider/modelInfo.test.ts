import * as assert from "node:assert";
import { HttpResponse, http } from "msw";
import * as vscode from "vscode";
import { REASONING_EFFORT_SCHEMA } from "../../provider/modelConfiguration";
import { discoveryHandlers, MODEL_INFO_URL, MODELS_URL, mswServer, TEST_BASE_URL, useMsw } from "../mocks/handlers";
import { expectDefined, makeProvider, toHeaderMap, withConfig } from "../testUtils";

suite("provider/model info and fallback", () => {
	useMsw();

	test("fallback from /v1/model/info to /v1/models on error", async () => {
		let modelInfoAttempted = false;
		let modelsAttempted = false;
		mswServer.use(
			http.get(MODEL_INFO_URL, () => {
				modelInfoAttempted = true;
				return HttpResponse.error();
			}),
			http.get(MODELS_URL, () => {
				modelsAttempted = true;
				return HttpResponse.json({
					object: "list",
					data: [{ id: "test-model", object: "model", created: 0, owned_by: "test" }],
				});
			})
		);

		const provider = makeProvider(TEST_BASE_URL);
		const infos = await provider.provideLanguageModelChatInformation(
			{ silent: true },
			new vscode.CancellationTokenSource().token
		);

		assert.ok(modelInfoAttempted);
		assert.ok(modelsAttempted);
		assert.ok(infos.length > 0);
		assert.strictEqual(
			expectDefined(infos[0]).family,
			"litellm",
			"bare /v1/models entries carry no provider, so they keep the generic family"
		);
	});

	test("sends configured custom headers during model discovery", async () => {
		let firstCallHeaders: Record<string, string> | undefined;
		const captureHeaders = ({ request }: { request: Request }) => {
			firstCallHeaders ??= toHeaderMap(request.headers);
			return HttpResponse.json({ data: [] });
		};
		mswServer.use(http.get(MODEL_INFO_URL, captureHeaders), http.get(MODELS_URL, captureHeaders));

		await withConfig({ headers: { "x-litellm-api-key": "proxy-key", "User-Agent": "spoofed-agent" } }, () =>
			makeProvider(TEST_BASE_URL).provideLanguageModelChatInformation(
				{ silent: true },
				new vscode.CancellationTokenSource().token
			)
		);

		const headers = firstCallHeaders ?? {};
		assert.equal(headers["x-litellm-api-key"], "proxy-key");
		assert.equal(headers["user-agent"], "GitHubCopilotChat/test VSCode/test");
		assert.equal(headers.authorization, "Bearer test-key");
		assert.equal(headers["x-api-key"], "test-key");
	});

	test("model/info numeric string token limits are parsed and max_output_tokens wins", async () => {
		mswServer.use(
			...discoveryHandlers({
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
			})
		);

		const provider = makeProvider(TEST_BASE_URL);
		const infos = await provider.provideLanguageModelChatInformation(
			{ silent: true },
			new vscode.CancellationTokenSource().token
		);

		const modelEntry = infos.find((i) => i.id === "gpt-5.3-codex-spark");
		assert.ok(modelEntry);
		assert.equal(modelEntry.maxOutputTokens, 32000);
		assert.equal(modelEntry.maxInputTokens, 128000);
	});

	test("model/info malformed numeric strings are ignored", async () => {
		mswServer.use(
			...discoveryHandlers({
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
			})
		);

		const provider = makeProvider(TEST_BASE_URL);
		const infos = await provider.provideLanguageModelChatInformation(
			{ silent: true },
			new vscode.CancellationTokenSource().token
		);

		const modelEntry = infos.find((i) => i.id === "gpt-5-bad-metadata");
		assert.ok(modelEntry);
		assert.equal(modelEntry.maxOutputTokens, 16000);
		assert.equal(modelEntry.maxInputTokens, 112000);
	});

	test("model ID extracted with fallback priority", async () => {
		mswServer.use(
			...discoveryHandlers({
				data: [
					{
						model_name: "preferred-name",
						litellm_params: { model: "fallback-name" },
						model_info: { key: "third-choice", id: "last-resort" },
					},
				],
			})
		);

		const provider = makeProvider(TEST_BASE_URL);
		const infos = await provider.provideLanguageModelChatInformation(
			{ silent: true },
			new vscode.CancellationTokenSource().token
		);

		assert.ok(infos.find((i) => i.id === "preferred-name"));
	});

	test("extended model metadata captured from model/info", async () => {
		mswServer.use(
			...discoveryHandlers({
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
			})
		);

		const provider = makeProvider(TEST_BASE_URL);
		const infos = await provider.provideLanguageModelChatInformation(
			{ silent: true },
			new vscode.CancellationTokenSource().token
		);

		assert.ok(infos.length > 0);
		const modelEntry = infos.find((i) => i.id === "gpt-4o");
		assert.ok(modelEntry);
		assert.equal(modelEntry.capabilities.imageInput, true);
	});

	test("family follows litellm_provider from model/info and falls back to litellm without it", async () => {
		mswServer.use(
			...discoveryHandlers({
				data: [
					{
						model_name: "claude-4-sonnet",
						model_info: { id: "claude-4-sonnet", litellm_provider: "anthropic", supports_function_calling: true },
					},
					{
						model_name: "unrouted-model",
						model_info: { id: "unrouted-model", supports_function_calling: true },
					},
				],
			})
		);

		const infos = await makeProvider(TEST_BASE_URL).provideLanguageModelChatInformation(
			{ silent: true },
			new vscode.CancellationTokenSource().token
		);

		assert.strictEqual(expectDefined(infos.find((i) => i.id === "claude-4-sonnet")).family, "anthropic");
		assert.strictEqual(
			expectDefined(infos.find((i) => i.id === "unrouted-model")).family,
			"litellm",
			"entries without a litellm_provider keep the generic family"
		);
	});

	test("empty or non-string litellm_provider falls back to the litellm family", async () => {
		mswServer.use(
			...discoveryHandlers({
				data: [
					{
						model_name: "blank-provider-model",
						model_info: { id: "blank-provider-model", litellm_provider: "", supports_function_calling: true },
					},
					{
						model_name: "array-provider-model",
						model_info: { id: "array-provider-model", litellm_provider: ["openai"], supports_function_calling: true },
					},
				],
			})
		);

		const infos = await makeProvider(TEST_BASE_URL).provideLanguageModelChatInformation(
			{ silent: true },
			new vscode.CancellationTokenSource().token
		);

		assert.strictEqual(
			expectDefined(infos.find((i) => i.id === "blank-provider-model")).family,
			"litellm",
			"an empty provider name must not register as the family"
		);
		assert.strictEqual(
			expectDefined(infos.find((i) => i.id === "array-provider-model")).family,
			"litellm",
			"a non-string litellm_provider must never reach the host as the family"
		);
	});

	test("every registered model is a selectable BYOK entry without the legacy metadata bag", async () => {
		mswServer.use(
			...discoveryHandlers({
				data: [
					{
						model_name: "gpt-4o",
						model_info: { id: "gpt-4o", litellm_provider: "openai", supports_function_calling: true },
					},
				],
			})
		);

		const infos = await makeProvider(TEST_BASE_URL).provideLanguageModelChatInformation(
			{ silent: true },
			new vscode.CancellationTokenSource().token
		);

		assert.ok(infos.length > 0);
		for (const info of infos) {
			assert.strictEqual(info.isBYOK, true, `${info.id} runs on the user's own credentials`);
			assert.strictEqual(info.isUserSelectable, true, `${info.id} must be selectable in the model picker`);
			assert.ok(!("metadata" in info), `${info.id} must not carry the retired metadata duplicate`);
		}
	});

	test("blocked models are not registered", async () => {
		mswServer.use(
			...discoveryHandlers({
				data: [
					{ model_name: "paused-model", model_info: { blocked: true, supports_function_calling: true } },
					{ model_name: "active-model", model_info: { supports_function_calling: true } },
				],
			})
		);

		const infos = await makeProvider(TEST_BASE_URL).provideLanguageModelChatInformation(
			{ silent: true },
			new vscode.CancellationTokenSource().token
		);

		assert.deepStrictEqual(
			infos.map((i) => i.id),
			["active-model"]
		);
	});

	test("load-balanced deployments register as one model with the conservative intersection", async () => {
		mswServer.use(
			...discoveryHandlers({
				data: [
					{
						model_name: "balanced-model",
						model_info: {
							litellm_provider: "azure",
							supports_function_calling: true,
							supports_vision: true,
							max_input_tokens: 128000,
							max_output_tokens: 16000,
						},
					},
					{
						model_name: "balanced-model",
						model_info: {
							litellm_provider: "openai",
							supports_function_calling: false,
							supports_vision: false,
							max_input_tokens: 64000,
							max_output_tokens: 8000,
						},
					},
				],
			})
		);

		const infos = await makeProvider(TEST_BASE_URL).provideLanguageModelChatInformation(
			{ silent: true },
			new vscode.CancellationTokenSource().token
		);

		const matching = infos.filter((i) => i.id === "balanced-model");
		assert.strictEqual(matching.length, 1, "one LanguageModelChatInformation per load-balanced model_name");
		assert.ok(
			infos.every((i) => !i.id.startsWith("balanced-model:")),
			"deployment merging must never take the :cheapest/:fastest aggregate path; a proxy 404s on those ids"
		);
		const info = expectDefined(matching[0]);
		assert.strictEqual(info.maxInputTokens, 64000);
		assert.strictEqual(info.maxOutputTokens, 8000);
		assert.strictEqual(info.capabilities.toolCalling, false, "tools only when every deployment supports them");
		assert.strictEqual(info.capabilities.imageInput, false, "vision only when every deployment supports it");
		assert.strictEqual(info.family, "azure", "the merged model's family follows the first deployment's provider");
	});

	suite("reasoning-effort configuration schema", () => {
		const discover = async () =>
			makeProvider(TEST_BASE_URL).provideLanguageModelChatInformation(
				{ silent: true },
				new vscode.CancellationTokenSource().token
			);

		const findInfo = async (id: string) => expectDefined((await discover()).find((i) => i.id === id));

		/** A /v1/model/info entry for one deployment of `name` with extra model_info fields. */
		const infoEntry = (name: string, modelInfo: Record<string, unknown>) => ({
			model_name: name,
			model_info: { supports_function_calling: true, ...modelInfo },
		});

		/** A /v1/models providers-array listing for one model. */
		const providersListing = (providers: Record<string, unknown>[]) => ({
			object: "list",
			data: [
				{
					id: "multi-model",
					object: "model",
					created: 0,
					owned_by: "test",
					providers: providers.map((provider, i) => ({ provider: `provider-${i}`, status: "active", ...provider })),
				},
			],
		});

		test("a model_info entry with supports_reasoning gets the picker schema", async () => {
			mswServer.use(...discoveryHandlers({ data: [infoEntry("o3", { supports_reasoning: true })] }));
			assert.deepStrictEqual((await findInfo("o3")).configurationSchema, REASONING_EFFORT_SCHEMA);
		});

		test("reasoning_effort among supported_openai_params also gets the schema", async () => {
			mswServer.use(
				...discoveryHandlers({
					data: [infoEntry("gpt-5", { supported_openai_params: ["temperature", "reasoning_effort"] })],
				})
			);
			assert.deepStrictEqual((await findInfo("gpt-5")).configurationSchema, REASONING_EFFORT_SCHEMA);
		});

		test("a model without reasoning support carries no schema", async () => {
			mswServer.use(
				...discoveryHandlers({
					data: [infoEntry("gpt-4o", { supports_reasoning: false, supported_openai_params: ["temperature"] })],
				})
			);
			assert.ok(!("configurationSchema" in (await findInfo("gpt-4o"))), "no picker control without capability data");
		});

		test("a bare /v1/models entry has no capability data, so no schema", async () => {
			mswServer.use(
				http.get(MODEL_INFO_URL, () => HttpResponse.error()),
				http.get(MODELS_URL, () =>
					HttpResponse.json({ object: "list", data: [{ id: "opaque-model", object: "model" }] })
				)
			);
			assert.ok(!("configurationSchema" in (await findInfo("opaque-model"))));
		});

		test("merged deployments advertise the schema only when every deployment supports reasoning", async () => {
			mswServer.use(
				...discoveryHandlers({
					data: [
						infoEntry("all-reasoning", { supports_reasoning: true }),
						infoEntry("all-reasoning", { supports_reasoning: true }),
						infoEntry("mixed", { supports_reasoning: true }),
						infoEntry("mixed", {}),
					],
				})
			);
			assert.deepStrictEqual((await findInfo("all-reasoning")).configurationSchema, REASONING_EFFORT_SCHEMA);
			assert.ok(
				!("configurationSchema" in (await findInfo("mixed"))),
				"one deployment without the flag demotes the merged capability"
			);
		});

		test("an explicit supports_reasoning: false survives the merge even when the params intersect", async () => {
			// The merge ANDs supports_reasoning to false but the intersected
			// supported_openai_params still lists reasoning_effort; the veto must
			// keep the disclaimed capability from being resurrected.
			mswServer.use(
				...discoveryHandlers({
					data: [
						infoEntry("veto", { supports_reasoning: true, supported_openai_params: ["reasoning_effort"] }),
						infoEntry("veto", { supports_reasoning: false, supported_openai_params: ["reasoning_effort"] }),
					],
				})
			);
			assert.ok(!("configurationSchema" in (await findInfo("veto"))));
		});

		test("per-provider entries follow their own provider; aggregates need every provider", async () => {
			mswServer.use(
				...discoveryHandlers(
					providersListing([
						{ supports_tools: true, supports_reasoning: true },
						{ supports_tools: true, supported_openai_params: ["temperature"] },
					])
				)
			);
			const infos = await discover();
			const reasoningEntry = expectDefined(infos.find((i) => i.id === "multi-model:provider-0"));
			const plainEntry = expectDefined(infos.find((i) => i.id === "multi-model:provider-1"));
			const cheapest = expectDefined(infos.find((i) => i.id === "multi-model:cheapest"));
			assert.deepStrictEqual(reasoningEntry.configurationSchema, REASONING_EFFORT_SCHEMA);
			assert.ok(!("configurationSchema" in plainEntry));
			assert.ok(
				!("configurationSchema" in cheapest),
				"the proxy may route an aggregate to the non-reasoning provider, so no schema"
			);
		});

		test("aggregates get the schema when every tool-capable provider supports reasoning", async () => {
			mswServer.use(
				...discoveryHandlers(
					providersListing([
						{ supports_tools: true, supports_reasoning: true },
						{ supports_tools: true, supported_openai_params: ["reasoning_effort"] },
					])
				)
			);
			const infos = await discover();
			for (const id of ["multi-model:cheapest", "multi-model:fastest"]) {
				assert.deepStrictEqual(
					expectDefined(infos.find((i) => i.id === id)).configurationSchema,
					REASONING_EFFORT_SCHEMA
				);
			}
		});

		test("an untooled base entry needs every backing provider to support reasoning", async () => {
			mswServer.use(...discoveryHandlers(providersListing([{ supports_tools: false, supports_reasoning: true }])));
			assert.deepStrictEqual((await findInfo("multi-model")).configurationSchema, REASONING_EFFORT_SCHEMA);

			mswServer.use(
				...discoveryHandlers(
					providersListing([{ supports_tools: false, supports_reasoning: true }, { supports_tools: false }])
				)
			);
			assert.ok(
				!("configurationSchema" in (await findInfo("multi-model"))),
				"the proxy may route the base id to the non-reasoning provider, so a mixed group gets no schema"
			);
		});
	});
});
