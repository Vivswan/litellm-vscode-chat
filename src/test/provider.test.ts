import * as assert from "node:assert";
import * as vscode from "vscode";
import { LiteLLMChatModelProvider } from "../provider";
import { makeModelInfo, makeProvider, userMessage, withFetch } from "./testUtils";

suite("provider", () => {
	test("provideLanguageModelChatInformation returns empty array with no configured servers", async () => {
		const provider = makeProvider();

		const infos = await provider.provideLanguageModelChatInformation(
			{ silent: true },
			new vscode.CancellationTokenSource().token
		);
		assert.deepStrictEqual(infos, []);
	});

	test("provideTokenCount counts simple string", async () => {
		const provider = makeProvider();

		const est = await provider.provideTokenCount(
			makeModelInfo({ id: "m", name: "m", maxInputTokens: 1000, maxOutputTokens: 1000 }),
			"hello world",
			new vscode.CancellationTokenSource().token
		);
		assert.equal(typeof est, "number");
		assert.ok(est > 0);
	});

	test("provideTokenCount counts message parts", async () => {
		const provider = makeProvider();

		const est = await provider.provideTokenCount(
			makeModelInfo({ id: "m", name: "m", maxInputTokens: 1000, maxOutputTokens: 1000 }),
			userMessage("hello world"),
			new vscode.CancellationTokenSource().token
		);
		assert.equal(typeof est, "number");
		assert.ok(est > 0);
	});

	test("provideTokenCount estimates tokens for image parts", async () => {
		const provider = makeProvider();
		const imageData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
		const msg: vscode.LanguageModelChatMessage = {
			role: vscode.LanguageModelChatMessageRole.User,
			content: [new vscode.LanguageModelTextPart("describe"), new vscode.LanguageModelDataPart(imageData, "image/png")],
			name: undefined,
		};
		const est = await provider.provideTokenCount(
			makeModelInfo({ id: "m", name: "m", maxOutputTokens: 1000 }),
			msg,
			new vscode.CancellationTokenSource().token
		);
		assert.ok(est >= 765, `Should estimate at least 765 tokens for the image, got ${est}`);
	});

	test("provideLanguageModelChatResponse throws without configuration", async () => {
		const provider = makeProvider();

		let error: unknown;
		try {
			await provider.provideLanguageModelChatResponse(
				makeModelInfo({ id: "m", name: "m", maxInputTokens: 1000, maxOutputTokens: 1000 }),
				[],
				{} as unknown as vscode.ProvideLanguageModelChatResponseOptions,
				{ report: () => {} },
				new vscode.CancellationTokenSource().token
			);
		} catch (e) {
			error = e;
		}
		assert.ok(error instanceof Error);
		assert.ok(
			error.message.includes('Model "m" is not registered with any configured server'),
			`Unexpected error message: ${error.message}`
		);
	});

	test("user cancellation rejects with CancellationError and is not logged as an error", async () => {
		const lines: string[] = [];
		const channel = { appendLine: (line: string) => lines.push(line) } as unknown as vscode.OutputChannel;
		const provider = makeProvider("http://test", "test-key", channel);

		const cts = new vscode.CancellationTokenSource();
		await withFetch(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						reject(new DOMException("The operation was aborted.", "AbortError"));
					});
				}),
			async () => {
				const pending = provider.provideLanguageModelChatResponse(
					makeModelInfo({ id: "m", name: "m", maxInputTokens: 1000, maxOutputTokens: 1000 }),
					[userMessage("hi")],
					{} as unknown as vscode.ProvideLanguageModelChatResponseOptions,
					{ report: () => {} },
					cts.token
				);
				setTimeout(() => cts.cancel(), 20);
				await assert.rejects(pending, (err: unknown) => err instanceof vscode.CancellationError);
				assert.ok(
					!lines.some((l) => l.includes("ERROR:")),
					`Cancellation must not produce an error log. Lines: ${lines.join(" | ")}`
				);
			}
		);
	});

	test("provideLanguageModelChatResponse throws for unregistered model when multiple servers are configured", async () => {
		const provider = new LiteLLMChatModelProvider("GitHubCopilotChat/test VSCode/test");
		provider.setServerProvider(() =>
			Promise.resolve([
				{ id: "srv1", label: "One", baseUrl: "http://one.test", apiKey: "k1" },
				{ id: "srv2", label: "Two", baseUrl: "http://two.test", apiKey: "k2" },
			])
		);

		let fetchCalled = false;
		await withFetch(
			async () => {
				fetchCalled = true;
				throw new Error("fetch must not be called");
			},
			async () => {
				await assert.rejects(
					provider.provideLanguageModelChatResponse(
						makeModelInfo({ id: "m", name: "m", maxInputTokens: 1000, maxOutputTokens: 1000 }),
						[],
						{} as unknown as vscode.ProvideLanguageModelChatResponseOptions,
						{ report: () => {} },
						new vscode.CancellationTokenSource().token
					),
					/not registered with any configured server/
				);
				assert.strictEqual(fetchCalled, false, "No request may be sent when the model has no route");
			}
		);
	});
});
