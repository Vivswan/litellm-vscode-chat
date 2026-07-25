import * as assert from "node:assert";
import * as vscode from "vscode";
import { jsonResponse, makeProvider, toHeaderMap, withConfig, withFetch } from "../testUtils";

suite("provider/model info and fallback", () => {
	test("fallback from /v1/model/info to /v1/models on error", async () => {
		let modelInfoAttempted = false;
		let modelsAttempted = false;

		const provider = makeProvider("http://test");
		const infos = await withFetch(
			async (url) => {
				const urlStr = url.toString();
				if (urlStr.includes("/v1/model/info")) {
					modelInfoAttempted = true;
					throw new Error("model/info endpoint failed");
				}
				if (urlStr.includes("/v1/models")) {
					modelsAttempted = true;
					return jsonResponse({
						object: "list",
						data: [{ id: "test-model", object: "model", created: 0, owned_by: "test" }],
					});
				}
				throw new Error("Unexpected URL");
			},
			() => provider.provideLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token)
		);

		assert.ok(modelInfoAttempted);
		assert.ok(modelsAttempted);
		assert.ok(infos.length > 0);
	});

	test("sends configured custom headers during model discovery", async () => {
		let firstCallHeaders: Record<string, string> = {};
		await withConfig({ headers: { "x-litellm-api-key": "proxy-key", "User-Agent": "spoofed-agent" } }, () =>
			withFetch(
				async (_url, init) => {
					firstCallHeaders = toHeaderMap(init?.headers);
					return jsonResponse({ data: [] });
				},
				() =>
					makeProvider("http://test").provideLanguageModelChatInformation(
						{ silent: true },
						new vscode.CancellationTokenSource().token
					)
			)
		);

		assert.equal(firstCallHeaders["x-litellm-api-key"], "proxy-key");
		assert.equal(firstCallHeaders["user-agent"], "GitHubCopilotChat/test VSCode/test");
		assert.equal(firstCallHeaders.authorization, "Bearer test-key");
		assert.equal(firstCallHeaders["x-api-key"], "test-key");
	});

	test("model/info numeric string token limits are parsed and max_output_tokens wins", async () => {
		const provider = makeProvider("http://test");
		const infos = await withFetch(
			async () =>
				jsonResponse({
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
			() => provider.provideLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token)
		);

		const modelEntry = infos.find((i) => i.id === "gpt-5.3-codex-spark");
		assert.ok(modelEntry);
		assert.equal(modelEntry.maxOutputTokens, 32000);
		assert.equal(modelEntry.maxInputTokens, 128000);
	});

	test("model/info malformed numeric strings are ignored", async () => {
		const provider = makeProvider("http://test");
		const infos = await withFetch(
			async () =>
				jsonResponse({
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
			() => provider.provideLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token)
		);

		const modelEntry = infos.find((i) => i.id === "gpt-5-bad-metadata");
		assert.ok(modelEntry);
		assert.equal(modelEntry.maxOutputTokens, 16000);
		assert.equal(modelEntry.maxInputTokens, 112000);
	});

	test("model ID extracted with fallback priority", async () => {
		const provider = makeProvider("http://test");
		const infos = await withFetch(
			async () =>
				jsonResponse({
					data: [
						{
							model_name: "preferred-name",
							litellm_params: { model: "fallback-name" },
							model_info: { key: "third-choice", id: "last-resort" },
						},
					],
				}),
			() => provider.provideLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token)
		);

		assert.ok(infos.find((i) => i.id === "preferred-name"));
	});

	test("extended model metadata captured from model/info", async () => {
		const provider = makeProvider("http://test");
		const infos = await withFetch(
			async () =>
				jsonResponse({
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
			() => provider.provideLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token)
		);

		assert.ok(infos.length > 0);
		const modelEntry = infos.find((i) => i.id === "gpt-4o");
		assert.ok(modelEntry);
		assert.equal(modelEntry.capabilities.imageInput, true);
	});
});
