import * as assert from "node:assert";
import { HttpResponse, http } from "msw";
import * as vscode from "vscode";
import { discoveryHandlers, MODEL_INFO_URL, MODELS_URL, mswServer, useMsw } from "../mocks/handlers";
import { makeProvider, toHeaderMap, withConfig } from "../testUtils";

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
});
