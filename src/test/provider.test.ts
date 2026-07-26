import * as assert from "node:assert";
import * as vscode from "vscode";
import { LiteLLMChatModelProvider } from "../provider";
import { buildModelInfos } from "../provider/registration";
import { discoveryHandlers, mswServer, useMsw } from "./mocks/handlers";
import { expectDefined, makeModelInfo, makeProvider, userMessage, withFetch } from "./testUtils";

suite("provider", () => {
	test("provideLanguageModelChatInformation returns empty array with no configured servers", async () => {
		const provider = makeProvider();

		const infos = await provider.provideLanguageModelChatInformation(
			{ silent: true },
			new vscode.CancellationTokenSource().token
		);
		assert.deepStrictEqual(infos, []);
	});

	test("a zero-server refresh prunes every cached server client", async () => {
		const provider = makeProvider();
		const internals = provider as unknown as { _client: { pruneClients(ids: Iterable<string>): void } };
		const pruneCalls: string[][] = [];
		const originalPrune = internals._client.pruneClients.bind(internals._client);
		internals._client.pruneClients = (ids) => {
			pruneCalls.push([...ids]);
			originalPrune(ids);
		};

		await provider.provideLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token);
		assert.deepStrictEqual(pruneCalls, [[]], "The no-servers path must prune the client cache to empty");
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
		const channel = {
			info: (line: string) => lines.push(line),
			error: (line: string) => lines.push(`ERROR: ${line}`),
		} as unknown as vscode.LogOutputChannel;
		const provider = makeProvider("http://litellm.test", "test-key", channel);

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

	// This nested suite mocks the network with msw; it stays after the withFetch
	// tests above so the interceptor never overlaps their fetch swaps.
	suite("registered model shape", () => {
		useMsw();

		test("providers-array models register per-provider families, aggregates keep litellm", async () => {
			mswServer.use(
				...discoveryHandlers({
					object: "list",
					data: [
						{
							id: "multi-model",
							object: "model",
							created: 0,
							owned_by: "test",
							providers: [
								{ provider: "groq", status: "active", supports_tools: true },
								{ provider: "together", status: "active", supports_tools: true },
							],
						},
					],
				})
			);

			const infos = await makeProvider("http://litellm.test").provideLanguageModelChatInformation(
				{ silent: true },
				new vscode.CancellationTokenSource().token
			);

			const familyOf = (id: string) =>
				expectDefined(
					infos.find((i) => i.id === id),
					`missing entry ${id}`
				).family;
			assert.strictEqual(familyOf("multi-model:cheapest"), "litellm", "aggregates keep the generic family");
			assert.strictEqual(familyOf("multi-model:fastest"), "litellm", "aggregates keep the generic family");
			assert.strictEqual(familyOf("multi-model:groq"), "groq");
			assert.strictEqual(familyOf("multi-model:together"), "together");
			for (const info of infos) {
				assert.strictEqual(info.isBYOK, true, `${info.id} runs on the user's own credentials`);
				assert.strictEqual(info.isUserSelectable, true, `${info.id} must be selectable in the model picker`);
				assert.ok(!("metadata" in info), `${info.id} must not carry the retired metadata duplicate`);
			}
		});

		test("a model whose providers all lack tools registers once with its first provider's family", async () => {
			mswServer.use(
				...discoveryHandlers({
					object: "list",
					data: [
						{
							id: "no-tools-model",
							object: "model",
							created: 0,
							owned_by: "test",
							providers: [
								{ provider: "perplexity", status: "active", supports_tools: false },
								{ provider: "other", status: "active", supports_tools: false },
							],
						},
					],
				})
			);

			const infos = await makeProvider("http://litellm.test").provideLanguageModelChatInformation(
				{ silent: true },
				new vscode.CancellationTokenSource().token
			);

			assert.strictEqual(infos.length, 1, "no aggregates or per-provider entries without tool support");
			const info = expectDefined(infos[0]);
			assert.strictEqual(info.id, "no-tools-model");
			assert.strictEqual(info.family, "perplexity", "the base entry takes its first provider's family");
			assert.strictEqual(info.capabilities.toolCalling, false);
		});

		test("every entry flavor emits exactly the registered field set", () => {
			const { infos } = buildModelInfos(
				[
					{ id: "sole", providers: [{ provider: "openai", status: "ok", source: "model_info" }] },
					{ id: "bare", providers: [] },
					{
						id: "multi",
						providers: [
							{ provider: "groq", status: "active", supports_tools: true },
							{ provider: "together", status: "active", supports_tools: true },
						],
					},
					{ id: "no-tools", providers: [{ provider: "perplexity", status: "active", supports_tools: false }] },
				],
				{ id: "srv1", label: "Default", baseUrl: "http://litellm.test", apiKey: "k" },
				1,
				() => {},
				{ maxOutputTokens: 4096, contextLength: 128000, maxInputTokens: undefined }
			);

			assert.deepStrictEqual(
				infos.map((i) => i.id),
				["sole", "bare", "multi:cheapest", "multi:fastest", "multi:groq", "multi:together", "no-tools"],
				"all five entry flavors must be exercised"
			);
			const expectedKeys = [
				"capabilities",
				"detail",
				"family",
				"id",
				"isBYOK",
				"isUserSelectable",
				"litellm",
				"maxInputTokens",
				"maxOutputTokens",
				"name",
				"tooltip",
				"version",
			];
			for (const info of infos) {
				assert.deepStrictEqual(Object.keys(info).sort(), expectedKeys, `unexpected field set on ${info.id}`);
			}
		});
	});
});
