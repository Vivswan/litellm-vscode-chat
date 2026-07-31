import * as assert from "node:assert";
import * as fc from "fast-check";
import { HttpResponse, http } from "msw";
import * as vscode from "vscode";
import { LiteLLMChatModelProvider } from "../../provider";
import { buildModelInfos } from "../../provider/catalog/registration";
import { RequestError } from "../../provider/transport/errorMapping";
import { resolveFuzzSeed } from "../fuzzStream";
import { discoveryHandlers, MODEL_INFO_URL, MODELS_URL, mswServer, TEST_BASE_URL, useMsw } from "../mocks/handlers";
import { expectDefined, makeModelInfo, makeProvider, userMessage, withFetch } from "../testUtils";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 100;
const SEED = resolveFuzzSeed();

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
		const provider = makeProvider(TEST_BASE_URL, "test-key", channel);

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
		const provider = new LiteLLMChatModelProvider({
			userAgent: "GitHubCopilotChat/test VSCode/test",
			getServers: () =>
				Promise.resolve([
					{ id: "srv1", label: "One", baseUrl: "http://one.test", apiKey: "k1" },
					{ id: "srv2", label: "Two", baseUrl: "http://two.test", apiKey: "k2" },
				]),
		});

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
	suite("all servers failing", () => {
		useMsw();

		test("a non-silent refresh rethrows the ORIGINAL classified error, never one rebuilt from the display string", async () => {
			// 400 responses are not retried, so the failure is immediate; the body
			// carries a marker that must survive to the USER-FACING message while
			// the classification keeps it out of anything that logs the throw.
			mswServer.use(
				http.get(MODEL_INFO_URL, () => HttpResponse.json({ error: "internal-billing-host-MARKER" }, { status: 400 })),
				http.get(MODELS_URL, () => HttpResponse.json({ error: "internal-billing-host-MARKER" }, { status: 400 }))
			);
			const provider = makeProvider(TEST_BASE_URL);

			await assert.rejects(
				provider.provideLanguageModelChatInformation({ silent: false }, new vscode.CancellationTokenSource().token),
				(error: unknown) => {
					assert.ok(error instanceof RequestError, `expected the original RequestError, got ${String(error)}`);
					assert.strictEqual(error.logClassification, "RequestError(http, status 400)");
					assert.ok(error.message.includes("internal-billing-host-MARKER"), "the display message keeps the body");
					return true;
				}
			);
		});
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

			const infos = await makeProvider(TEST_BASE_URL).provideLanguageModelChatInformation(
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

			const infos = await makeProvider(TEST_BASE_URL).provideLanguageModelChatInformation(
				{ silent: true },
				new vscode.CancellationTokenSource().token
			);

			assert.strictEqual(infos.length, 1, "no aggregates or per-provider entries without tool support");
			const info = expectDefined(infos[0]);
			assert.strictEqual(info.id, "no-tools-model");
			assert.strictEqual(info.family, "perplexity", "the base entry takes its first provider's family");
			assert.strictEqual(info.capabilities.toolCalling, false);
		});

		test("an untooled group's base entry collapses limits and caching across every provider", () => {
			const { infos } = buildModelInfos(
				[
					{
						id: "no-tools",
						shape: {
							kind: "group",
							providers: [
								{
									provider: "perplexity",
									status: "active",
									supports_tools: false,
									max_input_tokens: 128000,
									max_output_tokens: 16000,
									supports_prompt_caching: true,
								},
								{
									provider: "other",
									status: "active",
									supports_tools: false,
									max_input_tokens: 64000,
									max_output_tokens: 8000,
								},
							],
						},
					},
				],
				{ id: "srv1", label: "Default", baseUrl: TEST_BASE_URL, apiKey: "k" },
				1,
				() => {},
				{ maxOutputTokens: 4096, contextLength: 128000, maxInputTokens: undefined }
			);

			assert.strictEqual(infos.length, 1, "an untooled group registers exactly its base entry");
			const info = expectDefined(infos[0]);
			assert.strictEqual(info.family, "perplexity", "display identity still follows the first provider");
			assert.strictEqual(info.maxOutputTokens, 8000, "the base entry stands for the whole group, so limits collapse");
			assert.strictEqual(info.maxInputTokens, 64000);
			assert.strictEqual(info.litellm.outputLimitSource, "provider", "every provider declared its output limit");
			assert.strictEqual(
				info.litellm.supportsPromptCaching,
				false,
				"caching holds only when every provider advertises it, not just the first"
			);
		});

		test("every entry flavor emits exactly the registered field set", () => {
			const { infos } = buildModelInfos(
				[
					{ id: "sole", shape: { kind: "deployment", provider: { provider: "openai", status: "ok" } } },
					{ id: "bare", shape: { kind: "bare" } },
					{
						id: "multi",
						shape: {
							kind: "group",
							providers: [
								{ provider: "groq", status: "active", supports_tools: true },
								{ provider: "together", status: "active", supports_tools: true },
							],
						},
					},
					{
						id: "no-tools",
						shape: { kind: "group", providers: [{ provider: "perplexity", status: "active", supports_tools: false }] },
					},
				],
				{ id: "srv1", label: "Default", baseUrl: TEST_BASE_URL, apiKey: "k" },
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
						shape: {
							kind: "deployment",
							provider: {
								provider: "openai",
								status: "ok",
								input_cost_per_token: 0.000003,
								output_cost_per_token: 0.000015,
								cache_read_input_token_cost: 0.0000003,
								cache_creation_input_token_cost: 0.00000375,
							},
						},
					},
					{ id: "bare", shape: { kind: "bare" } },
					{
						id: "free",
						shape: {
							kind: "deployment",
							provider: {
								provider: "openai",
								status: "ok",
								input_cost_per_token: 0,
								output_cost_per_token: 1e308,
							},
						},
					},
					{
						id: "stamped",
						shape: {
							kind: "deployment",
							provider: {
								provider: "openai",
								status: "ok",
								input_cost_per_token: 0,
								output_cost_per_token: 0,
								cache_read_input_token_cost: 0.0000003,
								long_context_input_cost_per_token: 0.00001,
							},
						},
					},
					{
						id: "multi",
						shape: {
							kind: "group",
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
					},
				],
				{ id: "srv1", label: "Default", baseUrl: TEST_BASE_URL, apiKey: "k" },
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
			assert.strictEqual(
				sole.pricing,
				"$3 in / $15 out per 1M tokens",
				"the compact label is the picker hover's only cost line without usage-based billing"
			);
			assert.strictEqual(sole.priceCategory, "medium", "blended (3*3+15)/4 = 6 lands in the medium band");
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
					"priceCategory",
					"pricing",
					"tooltip",
					"version",
				],
				"a priced sole entry adds exactly the cost keys to the registered field set"
			);

			const free = expectDefined(byId.get("free"));
			assert.strictEqual(free.inputCost, 0, "a zero cost NOT paired with a zero output registers as 0");
			assert.ok(!("outputCost" in free), "a cost that overflows the per-million conversion is omitted, not Infinity");
			assert.ok(!("priceCategory" in free), "one-sided pricing is an incomplete signal and derives no category");

			// LiteLLM stamps 0/0 onto undeclared pricing (observed on v1.93), so
			// the zero PAIR reads as undeclared and drops the whole block - even
			// stray cache or long-context costs riding beside the stamp.
			const stamped = expectDefined(byId.get("stamped"));
			for (const key of [
				"inputCost",
				"outputCost",
				"cacheCost",
				"cacheWriteCost",
				"longContextInputCost",
				"longContextOutputCost",
				"longContextCacheCost",
				"longContextCacheWriteCost",
				"priceCategory",
				"pricing",
			] as const) {
				assert.ok(!(key in stamped), `a zero input/output pair must register with no ${key}`);
			}

			assert.strictEqual(expectDefined(byId.get("multi:groq")).inputCost, 1, "per-provider entries use their own cost");
			assert.strictEqual(expectDefined(byId.get("multi:together")).inputCost, 2);
			assert.ok(
				!("outputCost" in expectDefined(byId.get("multi:groq"))),
				"a malformed string cost on a providers-array entry degrades to absent"
			);
			assert.ok(!("priceCategory" in expectDefined(byId.get("multi:groq"))), "input-only pricing derives no category");
			assert.ok(!("pricing" in expectDefined(byId.get("multi:groq"))), "input-only pricing derives no label");

			for (const id of ["bare", "multi:cheapest", "multi:fastest"]) {
				const info = expectDefined(byId.get(id), `missing entry ${id}`);
				for (const key of [
					"inputCost",
					"outputCost",
					"cacheCost",
					"cacheWriteCost",
					"priceCategory",
					"pricing",
				] as const) {
					assert.ok(!(key in info), `${id} must not advertise a ${key} its routing does not pin`);
				}
			}
		});

		test("long-context pricing converts per-million, needs its base field, and drops when identical to it", () => {
			const { infos } = buildModelInfos(
				[
					{
						id: "tiered",
						shape: {
							kind: "deployment",
							provider: {
								provider: "anthropic",
								status: "ok",
								input_cost_per_token: 0.000003,
								output_cost_per_token: 0.000015,
								cache_read_input_token_cost: 0.0000003,
								long_context_input_cost_per_token: 0.000006,
								long_context_output_cost_per_token: 0.0000225,
								long_context_cache_read_input_token_cost: 0.0000003,
								long_context_cache_creation_input_token_cost: 0.00000375,
							},
						},
					},
					{
						id: "overflow",
						shape: {
							kind: "deployment",
							provider: {
								provider: "openai",
								status: "ok",
								input_cost_per_token: 0.000003,
								long_context_input_cost_per_token: 1e308,
							},
						},
					},
					{
						id: "multi",
						shape: {
							kind: "group",
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
					},
				],
				{ id: "srv1", label: "Default", baseUrl: TEST_BASE_URL, apiKey: "k" },
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
					"priceCategory",
					"pricing",
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

		test("priceCategory bands follow the blended base cost, unmoved by long-context tiers", () => {
			// Symmetric input/output costs make the blend equal the per-million
			// cost itself ((3x + x) / 4 = x), so each case pins one band boundary
			// exactly after the per-million conversion.
			const boundaries: ReadonlyArray<[number, string]> = [
				[0.99, "low"],
				[1, "medium"],
				[7.99, "medium"],
				[8, "high"],
				[39.99, "high"],
				[40, "very_high"],
			];
			const { infos } = buildModelInfos(
				boundaries.map(([perMillion]) => ({
					id: `m-${perMillion}`,
					shape: {
						kind: "deployment" as const,
						provider: {
							provider: "openai",
							status: "ok",
							input_cost_per_token: perMillion / 1_000_000,
							output_cost_per_token: perMillion / 1_000_000,
							// The tier price describes an opt-in regime; it must not move the band.
							long_context_input_cost_per_token: 1,
							long_context_output_cost_per_token: 1,
						},
					},
				})),
				{ id: "srv1", label: "Default", baseUrl: TEST_BASE_URL, apiKey: "k" },
				1,
				() => {},
				{ maxOutputTokens: 4096, contextLength: 128000, maxInputTokens: undefined }
			);
			const byId = new Map(infos.map((i) => [i.id, i]));
			for (const [perMillion, category] of boundaries) {
				assert.strictEqual(
					expectDefined(byId.get(`m-${perMillion}`)).priceCategory,
					category,
					`blended ${perMillion} per million`
				);
			}
		});

		test("the blend weights input 3:1 over output, and sub-unit costs render as the numeric field's 0", () => {
			const { infos } = buildModelInfos(
				[
					// Asymmetric pairs pin the 3:1 weighting: equal-cost boundary
					// tests cannot tell (3x + y) / 4 from any other mix.
					{
						id: "output-heavy",
						shape: {
							kind: "deployment",
							provider: {
								provider: "openai",
								status: "ok",
								input_cost_per_token: 0,
								output_cost_per_token: 3.9 / 1_000_000,
							},
						},
					},
					{
						id: "input-heavy",
						shape: {
							kind: "deployment",
							provider: {
								provider: "openai",
								status: "ok",
								input_cost_per_token: 3.9 / 1_000_000,
								output_cost_per_token: 0,
							},
						},
					},
					{
						id: "sub-unit",
						shape: {
							kind: "deployment",
							provider: {
								provider: "openai",
								status: "ok",
								// Rounds to 0 in the six-decimal per-million unit.
								input_cost_per_token: 1e-13,
								output_cost_per_token: 0.000003,
							},
						},
					},
					{
						id: "dust",
						shape: {
							kind: "deployment",
							provider: {
								provider: "openai",
								status: "ok",
								// BOTH sides are sub-unit dust: positive raw costs that slip
								// the 0/0 undeclared check but round to 0/0.
								input_cost_per_token: 1e-15,
								output_cost_per_token: 1e-15,
							},
						},
					},
				],
				{ id: "srv1", label: "Default", baseUrl: TEST_BASE_URL, apiKey: "k" },
				1,
				() => {},
				{ maxOutputTokens: 4096, contextLength: 128000, maxInputTokens: undefined }
			);
			const byId = new Map(infos.map((i) => [i.id, i]));

			const outputHeavy = expectDefined(byId.get("output-heavy"));
			assert.strictEqual(outputHeavy.priceCategory, "low", "blended (3*0 + 3.9)/4 = 0.975 stays low");
			const inputHeavy = expectDefined(byId.get("input-heavy"));
			assert.strictEqual(inputHeavy.priceCategory, "medium", "blended (3*3.9 + 0)/4 = 2.925 is medium");

			const subUnit = expectDefined(byId.get("sub-unit"));
			assert.strictEqual(subUnit.inputCost, 0, "a positive per-token cost below the unit rounds to 0");
			assert.strictEqual(
				subUnit.pricing,
				"$0 in / $3 out per 1M tokens",
				"the label mirrors the numeric field's 0 instead of inventing a smaller unit"
			);
			assert.strictEqual(subUnit.priceCategory, "low");

			const dust = expectDefined(byId.get("dust"));
			assert.strictEqual(dust.inputCost, 0);
			assert.strictEqual(dust.outputCost, 0);
			assert.ok(!("pricing" in dust), "a pair that BOTH rounded to 0 must not advertise itself as free");
			assert.ok(!("priceCategory" in dust), "nor earn a low-cost badge");
		});

		test("priceCategory is always one of the four literals the host renders", () => {
			// The host renders any other string through a capitalized "<Foo> cost"
			// fallback, so the derivation may only ever emit the known four.
			const KNOWN = ["low", "medium", "high", "very_high"];
			const costArb = fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true });
			fc.assert(
				fc.property(costArb, costArb, (inputPerToken, outputPerToken) => {
					const { infos } = buildModelInfos(
						[
							{
								id: "m",
								shape: {
									kind: "deployment",
									provider: {
										provider: "openai",
										status: "ok",
										input_cost_per_token: inputPerToken,
										output_cost_per_token: outputPerToken,
									},
								},
							},
						],
						{ id: "srv1", label: "Default", baseUrl: TEST_BASE_URL, apiKey: "k" },
						1,
						() => {},
						{ maxOutputTokens: 4096, contextLength: 128000, maxInputTokens: undefined }
					);
					const info = expectDefined(infos[0]);
					if (info.priceCategory !== undefined) {
						assert.ok(KNOWN.includes(info.priceCategory), `unknown category ${info.priceCategory}`);
					}
					if (info.inputCost !== undefined && info.outputCost !== undefined) {
						if (info.inputCost > 0 || info.outputCost > 0) {
							assert.ok(info.priceCategory !== undefined, "a nonzero two-sided price always derives a category");
						} else {
							// Both sides rounded to 0: sub-unit dust that slipped the raw
							// 0/0 undeclared check must not present the model as free.
							assert.ok(!("priceCategory" in info), "a rounded-0/0 pair derives no category");
							assert.ok(!("pricing" in info), "a rounded-0/0 pair derives no label");
						}
					} else {
						assert.ok(!("priceCategory" in info), "no category without both base costs");
					}
				}),
				{ numRuns: NUM_RUNS, seed: SEED }
			);
		});
	});
});
