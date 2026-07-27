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

		test("pricing converts per-token costs to per-million and appears only where the route pins the cost", () => {
			const { infos } = buildModelInfos(
				[
					{
						id: "sole",
						providers: [
							{
								provider: "openai",
								status: "ok",
								source: "model_info",
								input_cost_per_token: 0.000003,
								output_cost_per_token: 0.000015,
								cache_read_input_token_cost: 0.0000003,
								cache_creation_input_token_cost: 0.00000375,
							},
						],
					},
					{ id: "bare", providers: [] },
					{
						id: "free",
						providers: [
							{
								provider: "openai",
								status: "ok",
								source: "model_info",
								input_cost_per_token: 0,
								output_cost_per_token: 1e308,
							},
						],
					},
					{
						id: "multi",
						providers: [
							{
								provider: "groq",
								status: "active",
								supports_tools: true,
								input_cost_per_token: 0.000001,
								output_cost_per_token: "0.000002" as unknown as number,
							},
							{ provider: "together", status: "active", supports_tools: true, input_cost_per_token: 0.000002 },
						],
					},
				],
				{ id: "srv1", label: "Default", baseUrl: "http://litellm.test", apiKey: "k" },
				1,
				() => {},
				{ maxOutputTokens: 4096, contextLength: 128000, maxInputTokens: undefined }
			);
			const byId = new Map(infos.map((i) => [i.id, i]));

			const sole = expectDefined(byId.get("sole"));
			assert.strictEqual(sole.inputCost, 3, "0.000003 per token must convert to exactly 3 per million, not 2.999...");
			assert.strictEqual(sole.outputCost, 15);
			assert.strictEqual(sole.cacheCost, 0.3);
			assert.strictEqual(sole.cacheWriteCost, 3.75);
			assert.strictEqual(sole.pricing, undefined, "the display label stays unset; the numeric fields already render");
			assert.deepStrictEqual(
				Object.keys(sole).sort(),
				[
					"cacheCost",
					"cacheWriteCost",
					"capabilities",
					"detail",
					"family",
					"id",
					"inputCost",
					"isBYOK",
					"isUserSelectable",
					"litellm",
					"maxInputTokens",
					"maxOutputTokens",
					"name",
					"outputCost",
					"tooltip",
					"version",
				],
				"a priced sole entry adds exactly the cost keys to the registered field set"
			);

			const free = expectDefined(byId.get("free"));
			assert.strictEqual(free.inputCost, 0, "a zero cost registers as 0, not as absence");
			assert.ok(!("outputCost" in free), "a cost that overflows the per-million conversion is omitted, not Infinity");

			assert.strictEqual(expectDefined(byId.get("multi:groq")).inputCost, 1, "per-provider entries use their own cost");
			assert.strictEqual(expectDefined(byId.get("multi:together")).inputCost, 2);
			assert.ok(
				!("outputCost" in expectDefined(byId.get("multi:groq"))),
				"a malformed string cost on a providers-array entry degrades to absent"
			);

			for (const id of ["bare", "multi:cheapest", "multi:fastest"]) {
				const info = expectDefined(byId.get(id), `missing entry ${id}`);
				for (const key of ["inputCost", "outputCost", "cacheCost", "cacheWriteCost"] as const) {
					assert.ok(!(key in info), `${id} must not advertise a ${key} its routing does not pin`);
				}
			}
		});

		test("long-context pricing converts per-million, needs its base field, and drops when identical to it", () => {
			const { infos } = buildModelInfos(
				[
					{
						id: "tiered",
						providers: [
							{
								provider: "anthropic",
								status: "ok",
								source: "model_info",
								input_cost_per_token: 0.000003,
								output_cost_per_token: 0.000015,
								cache_read_input_token_cost: 0.0000003,
								long_context_input_cost_per_token: 0.000006,
								long_context_output_cost_per_token: 0.0000225,
								long_context_cache_read_input_token_cost: 0.0000003,
								long_context_cache_creation_input_token_cost: 0.00000375,
							},
						],
					},
					{
						id: "overflow",
						providers: [
							{
								provider: "openai",
								status: "ok",
								source: "model_info",
								input_cost_per_token: 0.000003,
								long_context_input_cost_per_token: 1e308,
							},
						],
					},
					{
						id: "multi",
						providers: [
							{
								provider: "groq",
								status: "active",
								supports_tools: true,
								input_cost_per_token: 0.000001,
								long_context_input_cost_per_token: 0.000002,
							},
							{
								provider: "together",
								status: "active",
								supports_tools: true,
								input_cost_per_token: 0.000001,
								long_context_input_cost_per_token: 0.000002,
							},
						],
					},
				],
				{ id: "srv1", label: "Default", baseUrl: "http://litellm.test", apiKey: "k" },
				1,
				() => {},
				{ maxOutputTokens: 4096, contextLength: 128000, maxInputTokens: undefined }
			);
			const byId = new Map(infos.map((i) => [i.id, i]));

			const tiered = expectDefined(byId.get("tiered"));
			assert.strictEqual(tiered.longContextInputCost, 6, "0.000006 per token must convert to exactly 6 per million");
			assert.strictEqual(tiered.longContextOutputCost, 22.5);
			assert.ok(
				!("longContextCacheCost" in tiered),
				"a tier cost identical to its base cost is omitted: the host declares longContext* as present only when it differs"
			);
			assert.ok(
				!("longContextCacheWriteCost" in tiered),
				"a tier cost without its base cost is omitted: the picker would render it beside an empty Default cell"
			);
			assert.deepStrictEqual(
				Object.keys(tiered).sort(),
				[
					"cacheCost",
					"capabilities",
					"detail",
					"family",
					"id",
					"inputCost",
					"isBYOK",
					"isUserSelectable",
					"litellm",
					"longContextInputCost",
					"longContextOutputCost",
					"maxInputTokens",
					"maxOutputTokens",
					"name",
					"outputCost",
					"tooltip",
					"version",
				],
				"a tier-priced sole entry adds exactly the differing, base-backed longContext keys"
			);

			const overflow = expectDefined(byId.get("overflow"));
			assert.strictEqual(overflow.inputCost, 3);
			assert.ok(
				!("longContextInputCost" in overflow),
				"a tier cost that overflows the per-million conversion is omitted, not Infinity"
			);

			assert.strictEqual(
				expectDefined(byId.get("multi:groq")).longContextInputCost,
				2,
				"per-provider entries carry their own tier cost"
			);
			assert.strictEqual(expectDefined(byId.get("multi:together")).longContextInputCost, 2);

			for (const id of ["multi:cheapest", "multi:fastest"]) {
				const info = expectDefined(byId.get(id), `missing entry ${id}`);
				for (const key of [
					"longContextInputCost",
					"longContextOutputCost",
					"longContextCacheCost",
					"longContextCacheWriteCost",
				] as const) {
					assert.ok(!(key in info), `${id} must not advertise a ${key} its routing does not pin`);
				}
			}
		});
	});
});
