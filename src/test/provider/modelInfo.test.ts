import * as assert from "node:assert";
import { HttpResponse, http } from "msw";
import * as vscode from "vscode";
import { discoveryHandlers, MODEL_INFO_URL, MODELS_URL, mswServer, useMsw } from "../mocks/handlers";
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

		const provider = makeProvider("http://litellm.test");
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
			makeProvider("http://litellm.test").provideLanguageModelChatInformation(
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

		const provider = makeProvider("http://litellm.test");
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

		const provider = makeProvider("http://litellm.test");
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

		const provider = makeProvider("http://litellm.test");
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

		const provider = makeProvider("http://litellm.test");
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

		const infos = await makeProvider("http://litellm.test").provideLanguageModelChatInformation(
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

		const infos = await makeProvider("http://litellm.test").provideLanguageModelChatInformation(
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

		const infos = await makeProvider("http://litellm.test").provideLanguageModelChatInformation(
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

		const infos = await makeProvider("http://litellm.test").provideLanguageModelChatInformation(
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

		const infos = await makeProvider("http://litellm.test").provideLanguageModelChatInformation(
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
});
