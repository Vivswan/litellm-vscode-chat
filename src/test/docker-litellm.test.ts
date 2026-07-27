import * as assert from "node:assert";
import * as vscode from "vscode";
import { REASONING_EFFORT_SCHEMA } from "../provider/modelConfiguration";
import {
	addServer,
	clearServers,
	collectStream,
	ensureActivated,
	extractText,
	extractThinkingParts,
	extractToolCalls,
	getThinkingPartClass,
	waitForHostModels,
} from "./hostApiHelpers";
import { SCENARIO_NAMES, SLOW_STREAM_CHUNK_COUNT } from "./scenarios";
import { expectDefined } from "./testUtils";

/**
 * Docker-stack test suite.
 *
 * Drives the extension through the real VS Code LM API against the dockerized
 * LiteLLM proxy (docker-compose.yml), which routes fake/<scenario> models to
 * the fake OpenAI backend. Compared to the in-process capture suite this adds
 * a real proxy hop: LiteLLM re-serializes requests and streams, so these
 * tests pin what survives the trip. Run via `bun run test:docker`.
 */

const BASE_URL = process.env.LITELLM_DOCKER_BASE_URL || "";
const API_KEY = process.env.LITELLM_DOCKER_API_KEY || "sk-test-1234";
const FAKE_URL = process.env.LITELLM_DOCKER_FAKE_URL || "";

/** Minimal 1x1 red PNG for multimodal request-shape tests. */
const PNG_DATA = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
	0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49,
	0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, 0x33,
	0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

/** A tiny but structurally valid PDF. */
const PDF_DATA = new TextEncoder().encode("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF");

interface ChatBody {
	model?: string;
	messages?: Array<{ role: string; content: unknown }>;
	tools?: Array<{ type: string; function: { name: string } }>;
	stream_options?: { include_usage?: boolean };
	[key: string]: unknown;
}

suite("Docker LiteLLM stack", () => {
	if (!BASE_URL) {
		test("SKIPPED: LITELLM_DOCKER_BASE_URL not set; run via `bun run test:docker`", () => {});
		return;
	}

	const modelsByName = new Map<string, vscode.LanguageModelChat>();
	let registeredModelIds: string[] = [];

	function fakeModel(name: string): vscode.LanguageModelChat {
		return expectDefined(modelsByName.get(name), `model fake/${name} not registered with the host`);
	}

	async function send(
		scenario: string,
		messages: vscode.LanguageModelChatMessage[] = [vscode.LanguageModelChatMessage.User("hi")],
		options: vscode.LanguageModelChatRequestOptions = {}
	): Promise<unknown[]> {
		const response = await fakeModel(scenario).sendRequest(
			messages,
			options,
			new vscode.CancellationTokenSource().token
		);
		return collectStream(response);
	}

	/** The chat body LiteLLM forwarded to the fake backend for the last request. */
	async function lastForwardedRequest(): Promise<ChatBody> {
		const response = await fetch(`${FAKE_URL}/_test/last-request`);
		assert.ok(response.ok, `GET /_test/last-request failed: ${response.status}`);
		return (await response.json()) as ChatBody;
	}

	async function setDynamicScenario(name: string): Promise<void> {
		const response = await fetch(`${FAKE_URL}/_test/scenario`, { method: "PUT", body: name });
		assert.ok(response.ok, `PUT /_test/scenario ${name} failed: ${response.status}`);
	}

	suiteSetup(async function () {
		this.timeout(90000);

		await ensureActivated();
		await clearServers();
		const { modelIds } = await addServer("Docker", BASE_URL, API_KEY);
		registeredModelIds = modelIds;
		const expectedFakeIds = SCENARIO_NAMES.map((name) => `fake/${name}`);
		for (const id of expectedFakeIds) {
			assert.ok(modelIds.includes(id), `LiteLLM did not register ${id}; check the generated proxy config`);
		}

		const models = await waitForHostModels(
			60000,
			(candidates) => expectedFakeIds.every((id) => candidates.some((m) => m.id === id)),
			"host to expose every fake/<scenario> model"
		);
		for (const model of models) {
			if (model.id.startsWith("fake/")) {
				modelsByName.set(model.id.slice("fake/".length), model);
			}
		}
	});

	// ── Scenario coverage: the config can never silently drift ────────────────

	suite("scenario registry", () => {
		test("every scenario in src/test/scenarios.ts has a registered fake model", () => {
			const missing = SCENARIO_NAMES.filter((name) => !modelsByName.has(name));
			assert.deepStrictEqual(missing, [], `Missing fake models for: ${missing.join(", ")}`);
		});

		test("the dynamic passthrough model is registered", () => {
			assert.ok(modelsByName.has("dynamic"), "fake/dynamic missing from the host model list");
		});

		test("fake models carry the generated token limits", () => {
			assert.strictEqual(fakeModel("text-only").maxInputTokens, 128000);
		});

		test("fake/reasoning advertises the reasoning-effort picker schema through real discovery", async () => {
			const infos = (await vscode.commands.executeCommand(
				"litellm._test.refreshModelInfos"
			)) as vscode.LanguageModelChatInformation[];
			const reasoning = expectDefined(infos.find((info) => info.id === "fake/reasoning"));
			assert.deepStrictEqual(
				reasoning.configurationSchema,
				REASONING_EFFORT_SCHEMA,
				"the generated supports_reasoning: true must surface the picker control"
			);
			const textOnly = expectDefined(infos.find((info) => info.id === "fake/text-only"));
			assert.ok(!("configurationSchema" in textOnly), "non-reasoning fake models must not grow the control");
		});
	});

	// -- Load-balanced model group (two deployments, one model_name) ------------

	suite("load-balanced model group", () => {
		test("the two deployments register as a single model", () => {
			const occurrences = registeredModelIds.filter((id) => id === "fake/load-balanced");
			assert.strictEqual(occurrences.length, 1, "one registration per model_name, not one per deployment");
			assert.ok(
				registeredModelIds.every((id) => !id.startsWith("fake/load-balanced:")),
				"no :cheapest/:fastest/:provider ids; the proxy 404s on those"
			);
		});

		test("the merged model advertises the smaller deployment's limits", () => {
			assert.strictEqual(fakeModel("load-balanced").maxInputTokens, 64000);
		});

		test("chatting with the merged model routes the raw model_name through the proxy", async () => {
			assert.strictEqual(extractText(await send("load-balanced")), "Balanced across deployments");
			const body = await lastForwardedRequest();
			// LiteLLM strips the openai/ prefix and forwards whichever deployment
			// the group picked; seeing one of the two upstream names proves the
			// raw model_name routed through the load-balancing group.
			assert.ok(
				body.model === "load-balanced" || body.model === "load-balanced-b",
				`expected an upstream deployment model, got "${body.model}"`
			);
		});

		test("the merged declared output limit reaches the backend uncapped", async () => {
			await send("load-balanced");
			const body = await lastForwardedRequest();
			assert.strictEqual(
				body.max_tokens,
				8000,
				"both deployments declare limits, so the merged minimum must pass through, not the 4096 cap"
			);
		});
	});

	// ── Text and stream-shape scenarios ────────────────────────────────────────

	suite("text scenarios through the proxy", () => {
		test("text-only", async () => {
			assert.strictEqual(extractText(await send("text-only")), "Hello from capture server");
		});

		test("the declared max_output_tokens reaches the backend uncapped through a real proxy", async () => {
			await send("text-only");
			const body = await lastForwardedRequest();
			assert.strictEqual(
				body.max_tokens,
				16000,
				"the generated model_info declares 16000; the 4096 cap must not apply"
			);
		});

		// LiteLLM v1.93 rejects array content deltas outright with a 500; only
		// that specific failure is tolerated (the capture-mode host-fidelity
		// suite covers the shape without a proxy). Anything else must fail.
		const KNOWN_ARRAY_DELTA_REJECTION = /LiteLLM API error: 500[\s\S]*can only concatenate str/;

		test("structured-content renders array text blocks when the proxy forwards them", async () => {
			const outcome = await send("structured-content").then(
				(parts) => ({ parts }),
				(error: unknown) => ({ error })
			);
			if ("error" in outcome) {
				assert.match(String(outcome.error), KNOWN_ARRAY_DELTA_REJECTION);
				console.log("[docker] structured-content: proxy still rejects array deltas");
				return;
			}
			assert.strictEqual(extractText(outcome.parts), "structured text");
		});

		test("structured-content-mixed never leaks non-text blocks when the proxy forwards them", async () => {
			const outcome = await send("structured-content-mixed").then(
				(parts) => ({ parts }),
				(error: unknown) => ({ error })
			);
			if ("error" in outcome) {
				assert.match(String(outcome.error), KNOWN_ARRAY_DELTA_REJECTION);
				console.log("[docker] structured-content-mixed: proxy still rejects array deltas");
				return;
			}
			const text = extractText(outcome.parts);
			assert.ok(text.includes("visible text"), `non-text blocks must not erase text, got "${text}"`);
			assert.ok(!text.includes("example.test/image"), "image block content must not leak into text");
		});

		test("control-token-sections strips section markers split across chunks", async () => {
			assert.strictEqual(extractText(await send("control-token-sections")), "Hello world");
		});

		test("finish-length delivers the truncated text", async () => {
			assert.strictEqual(extractText(await send("finish-length")), "This answer was cut sho");
		});

		test("finish-content-filter delivers the partial text", async () => {
			assert.strictEqual(extractText(await send("finish-content-filter")), "Partial answer");
		});

		test("audio-output is skipped without dropping surrounding text", async () => {
			assert.strictEqual(extractText(await send("audio-output")), "Text alongside audio.");
		});

		test("usage trailers do not disturb the text", async () => {
			assert.strictEqual(extractText(await send("usage-only-final")), "Response with usage");
			assert.strictEqual(extractText(await send("usage-with-cache-tokens")), "Cached response");
			assert.strictEqual(extractText(await send("usage-token-details")), "Detailed usage");
		});
	});

	// ── Tool-call scenarios ────────────────────────────────────────────────────

	suite("tool-call scenarios through the proxy", () => {
		test("tool-call-single reassembles with parsed args", async () => {
			const calls = extractToolCalls(await send("tool-call-single"));
			assert.strictEqual(calls.length, 1);
			const call = expectDefined(calls[0]);
			assert.strictEqual(call.name, "get_weather");
			assert.deepStrictEqual(call.input, { location: "Paris" });
		});

		test("tool-call-chunked reassembles args split across frames", async () => {
			const calls = extractToolCalls(await send("tool-call-chunked"));
			assert.strictEqual(calls.length, 1);
			assert.deepStrictEqual(expectDefined(calls[0]).input, { location: "Paris" });
		});

		test("text-then-tool emits text before the call", async () => {
			const parts = await send("text-then-tool");
			assert.ok(extractText(parts).includes("Let me check that for you."));
			assert.strictEqual(extractToolCalls(parts).length, 1);
		});

		test("parallel-tool-calls emits both calls", async () => {
			const calls = extractToolCalls(await send("parallel-tool-calls"));
			assert.strictEqual(calls.length, 2);
			const locations = calls.map((c) => (c.input as { location: string }).location).sort();
			assert.deepStrictEqual(locations, ["Paris", "Tokyo"]);
		});

		test("inline-tool-call-tokens parses the call and keeps the surrounding text clean", async () => {
			const parts = await send("inline-tool-call-tokens");
			const calls = extractToolCalls(parts);
			assert.strictEqual(calls.length, 1);
			assert.strictEqual(expectDefined(calls[0]).name, "get_weather");
			assert.deepStrictEqual(expectDefined(calls[0]).input, { location: "Paris" });
			const text = extractText(parts);
			assert.ok(!text.includes("<|"), `control tokens must not leak into text, got "${text}"`);
			assert.ok(text.includes("Checking the weather."), "surrounding text must survive");
		});

		test("duplicate-tool-calls collapses the cross-channel duplicate", async () => {
			const calls = extractToolCalls(await send("duplicate-tool-calls"));
			assert.strictEqual(calls.length, 1, "the same call on the delta and inline channels must emit once");
		});

		test("tool-call-invalid-json rejects on completion", async () => {
			await assert.rejects(() => send("tool-call-invalid-json"));
		});
	});

	// ── Reasoning and modern stream fields ─────────────────────────────────────

	suite("reasoning scenarios through the proxy", () => {
		// Calibrated against LiteLLM v1.93: reasoning_content, reasoning, and
		// thinking_blocks survive the proxy; the nonstandard delta.thinking
		// object does not. "proxy-dependent" scenarios only log, so a LiteLLM
		// upgrade that starts forwarding them shows up without failing.
		const thinkingSurvival: Record<string, "survives" | "proxy-dependent"> = {
			reasoning: "survives",
			"reasoning-field": "survives",
			"thinking-blocks": "survives",
			"thinking-structured": "proxy-dependent",
		};

		for (const [scenario, expectation] of Object.entries(thinkingSurvival)) {
			test(`${scenario} still delivers the final answer text`, async () => {
				const parts = await send(scenario);
				const text = extractText(parts);
				assert.ok(text.length > 0, `expected answer text after thinking, got none`);
				const thinkingParts = extractThinkingParts(parts);
				if (expectation === "survives" && getThinkingPartClass()) {
					assert.ok(thinkingParts.length > 0, `${scenario}: thinking parts must survive the proxy`);
				} else {
					console.log(`[docker] ${scenario}: ${thinkingParts.length} thinking part(s) survived the proxy`);
				}
			});
		}

		test("redacted-thinking never leaks the opaque payload into text", async () => {
			const text = extractText(await send("redacted-thinking"));
			assert.strictEqual(text, "Answer after redacted thinking.");
		});
	});

	suite("modern stream fields through the proxy", () => {
		test("refusal deltas surface as response text", async () => {
			const text = extractText(await send("refusal"));
			// LiteLLM forwards the first refusal delta and drops the rest.
			assert.ok(text.startsWith("I cannot help"), `refusal must not vanish, got "${text}"`);
		});

		test("url citations surface as a sources trailer", async () => {
			const text = extractText(await send("annotations"));
			assert.ok(text.includes("The sky is blue."), "content text must survive");
			// codeql[js/incomplete-url-substring-sanitization] -- asserts the citation URL surfaces in output text
			assert.ok(text.includes("https://example.test/sky"), `citation URL must surface, got "${text}"`);
		});
	});

	// ── Error scenarios ────────────────────────────────────────────────────────

	suite("error scenarios through the proxy", () => {
		for (const scenario of ["error-400", "error-401", "error-429"]) {
			test(`${scenario} rejects the request`, async () => {
				await assert.rejects(() => send(scenario));
			});
		}
	});

	// ── Cancellation ───────────────────────────────────────────────────────────

	suite("cancellation", () => {
		test("cancelling mid-stream stops the slow stream early", async function () {
			this.timeout(30000);
			const source = new vscode.CancellationTokenSource();
			const response = await fakeModel("slow-stream").sendRequest(
				[vscode.LanguageModelChatMessage.User("hi")],
				{},
				source.token
			);
			const parts: unknown[] = [];
			try {
				for await (const part of response.stream) {
					parts.push(part);
					if (parts.length === 3) {
						source.cancel();
					}
				}
			} catch (e) {
				// The extension throws vscode.CancellationError; the host may
				// re-wrap it as its own "Canceled" error before it reaches us.
				assert.ok(
					e instanceof vscode.CancellationError || /cancel/i.test(String(e)),
					`expected a cancellation error, got ${String(e)}`
				);
			}
			assert.ok(
				parts.length < SLOW_STREAM_CHUNK_COUNT / 2,
				`cancellation should stop the stream early: collected ${parts.length} of ${SLOW_STREAM_CHUNK_COUNT}`
			);
		});
	});

	// ── Request shapes after the proxy hop ─────────────────────────────────────

	suite("request shapes forwarded to the backend", () => {
		test("modern request params survive LiteLLM", async () => {
			await send("text-only", [vscode.LanguageModelChatMessage.User("hi")], {
				modelOptions: {
					temperature: 0.3,
					seed: 42,
					reasoning_effort: "high",
					response_format: { type: "json_object" },
				},
			});
			const body = await lastForwardedRequest();
			assert.strictEqual(body.temperature, 0.3);
			assert.strictEqual(body.seed, 42);
			assert.strictEqual(body.reasoning_effort, "high");
			assert.deepStrictEqual(body.response_format, { type: "json_object" });
		});

		test("stream_options requests the usage trailer", async () => {
			await send("text-only");
			const body = await lastForwardedRequest();
			assert.deepStrictEqual(body.stream_options, { include_usage: true });
		});

		test("reasoning_effort reaches the backend through a reasoning-capable model", async () => {
			// fake/reasoning is generated with supports_reasoning: true, the same
			// capability data that puts the Reasoning Effort control in the model
			// picker; a resolved picker choice travels as this exact wire key.
			await send("reasoning", [vscode.LanguageModelChatMessage.User("hi")], {
				modelOptions: { reasoning_effort: "high" },
			});
			const body = await lastForwardedRequest();
			assert.strictEqual(body.reasoning_effort, "high", "the proxy must forward the effort level to the backend");
		});

		test("image parts arrive as image_url blocks", async () => {
			const message = new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [
				new vscode.LanguageModelTextPart("Describe this image."),
				new vscode.LanguageModelDataPart(PNG_DATA, "image/png"),
			]);
			await send("text-only", [message]);
			const body = await lastForwardedRequest();
			const userMessage = body.messages?.find((m) => m.role === "user" && Array.isArray(m.content));
			const content = expectDefined(userMessage, "user message with array content").content as Array<{
				type: string;
				image_url?: { url: string };
			}>;
			const imageBlock = expectDefined(
				content.find((block) => block.type === "image_url"),
				"image_url block survived the proxy"
			);
			assert.ok(imageBlock.image_url?.url.startsWith("data:image/png;base64,"), "base64 data URL preserved");
		});

		test("pdf parts arrive as file blocks", async () => {
			const message = new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [
				new vscode.LanguageModelTextPart("Summarize this file."),
				new vscode.LanguageModelDataPart(PDF_DATA, "application/pdf"),
			]);
			await send("text-only", [message]);
			const body = await lastForwardedRequest();
			const userMessage = body.messages?.find((m) => m.role === "user" && Array.isArray(m.content));
			const content = expectDefined(userMessage, "user message with array content").content as Array<{
				type: string;
			}>;
			assert.ok(
				content.some((block) => block.type === "file"),
				`file block survived the proxy; got types ${content.map((b) => b.type).join(", ")}`
			);
		});

		test("tool definitions arrive as function schemas", async () => {
			await send("tool-call-single", [vscode.LanguageModelChatMessage.User("weather?")], {
				tools: [
					{
						name: "get_weather",
						description: "Get the weather",
						inputSchema: { type: "object", properties: { location: { type: "string" } } },
					},
				],
			});
			const body = await lastForwardedRequest();
			const tools = expectDefined(body.tools, "tools survived the proxy");
			assert.strictEqual(tools.length, 1);
			assert.strictEqual(expectDefined(tools[0]).function.name, "get_weather");
		});

		test("prompt-cache breakpoints on tools and messages survive the proxy", async () => {
			// fake/usage-with-cache-tokens is generated with
			// supports_prompt_caching: true, so the extension places its cache
			// breakpoints. LiteLLM must accept the request and forward the markers:
			// last tool, first user message, and rolling last message (no system
			// message reaches the provider from a plain sendRequest). This
			// validates marker survival on the OpenAI path only; the proxy's
			// Anthropic translation never runs against the fake backend.
			const messages = [
				vscode.LanguageModelChatMessage.User("Task: audit the repository."),
				vscode.LanguageModelChatMessage.Assistant("Starting with the README."),
				vscode.LanguageModelChatMessage.User("Now check the tests."),
			];
			const tools = [
				{ name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: {} } },
				{ name: "list_dir", description: "List a directory", inputSchema: { type: "object", properties: {} } },
			];
			assert.strictEqual(extractText(await send("usage-with-cache-tokens", messages, { tools })), "Cached response");

			const body = await lastForwardedRequest();
			const markerCount = JSON.stringify(body).split('"cache_control"').length - 1;
			assert.strictEqual(markerCount, 3, "tools + first user + rolling anchors, nothing else");

			const forwardedTools = expectDefined(body.tools, "tools survived the proxy") as Array<{
				function: { name: string };
				cache_control?: unknown;
			}>;
			assert.strictEqual(forwardedTools[0]?.cache_control, undefined, "only the last tool is marked");
			assert.deepStrictEqual(forwardedTools[1]?.cache_control, { type: "ephemeral" });

			const userMessages = (body.messages ?? []).filter((m) => m.role === "user");
			assert.deepStrictEqual(userMessages[0]?.content, [
				{ type: "text", text: "Task: audit the repository.", cache_control: { type: "ephemeral" } },
			]);
			assert.deepStrictEqual(userMessages[1]?.content, [
				{ type: "text", text: "Now check the tests.", cache_control: { type: "ephemeral" } },
			]);
			const assistant = expectDefined((body.messages ?? []).find((m) => m.role === "assistant"));
			assert.strictEqual(assistant.content, "Starting with the README.", "non-anchor turns keep string content");
		});

		test("no cache markers reach the backend for a model without caching support", async () => {
			await send("tool-call-single", [vscode.LanguageModelChatMessage.User("weather?")], {
				tools: [
					{
						name: "get_weather",
						description: "Get the weather",
						inputSchema: { type: "object", properties: { location: { type: "string" } } },
					},
				],
			});
			const body = await lastForwardedRequest();
			assert.ok(!JSON.stringify(body).includes("cache_control"), "fake/tool-call-single advertises no caching");
		});
	});

	// ── Dynamic scenario selection ─────────────────────────────────────────────

	suite("dynamic scenario switching", () => {
		test("the control endpoint redirects fake/dynamic between scenarios", async () => {
			await setDynamicScenario("parallel-tool-calls");
			const calls = extractToolCalls(await send("dynamic"));
			assert.strictEqual(calls.length, 2);

			await setDynamicScenario("text-only");
			assert.strictEqual(extractText(await send("dynamic")), "Hello from capture server");
		});

		test("custom scenarios registered at runtime play through the proxy", async () => {
			const config = {
				type: "sse",
				chunks: [
					{ choices: [{ index: 0, delta: { role: "assistant", content: "custom scenario text" } }] },
					{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
				],
			};
			const response = await fetch(`${FAKE_URL}/_test/custom-scenario`, {
				method: "PUT",
				body: JSON.stringify({ name: "docker-test-custom", config }),
			});
			assert.ok(response.ok, `PUT /_test/custom-scenario failed: ${response.status}`);

			await setDynamicScenario("docker-test-custom");
			assert.strictEqual(extractText(await send("dynamic")), "custom scenario text");
		});
	});

	// --- Provider-group chat path -------------------------------------------
	// Everything above drives the legacy registry transport. This suite pins
	// the VS Code-managed provider-group path end to end against a proxy that
	// REQUIRES the master key: group creation through the host command, model
	// resolution through the per-group provider call, and a chat whose
	// credentials ride the model's litellm metadata across the host round
	// trip. The registry is cleared first, so a chat that loses the group
	// credentials anywhere along that path fails here (as a 401 if the key is
	// dropped from the request, or as a routing error if the metadata is
	// stripped) instead of silently falling back. Deliberately LAST in the
	// file: the created group cannot be removed programmatically and serves
	// models for the rest of the host's lifetime.
	suite("provider-group chat path", () => {
		suiteSetup(async function () {
			this.timeout(90000);
			await clearServers();
			await vscode.commands.executeCommand("lm.addLanguageModelsProviderGroup", {
				name: "Docker Group Path",
				vendor: "litellm",
				baseUrl: BASE_URL,
				apiKey: API_KEY,
			});
		});

		test("a group model chats with the group's own credentials", async function () {
			this.timeout(60000);
			const models = await waitForHostModels(
				60000,
				(candidates) => candidates.some((m) => m.id === "fake/text-only"),
				"the provider group to expose fake/text-only"
			);
			const model = expectDefined(models.find((m) => m.id === "fake/text-only"));
			const response = await model.sendRequest(
				[vscode.LanguageModelChatMessage.User("hi")],
				{},
				new vscode.CancellationTokenSource().token
			);
			assert.strictEqual(extractText(await collectStream(response)), "Hello from capture server");
		});
	});
});
