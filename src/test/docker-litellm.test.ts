import * as assert from "node:assert";
import { createHash } from "node:crypto";
import * as vscode from "vscode";
import { REASONING_EFFORT_SCHEMA } from "../provider/modelConfiguration";
import { COMMANDS, FALLBACK_TEXT } from "./fakeStack/commands";
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
import { expectDefined } from "./testUtils";

/**
 * Docker-stack test suite.
 *
 * Drives the extension through the real VS Code LM API against the dockerized
 * LiteLLM proxy (docker-compose.yml). The consolidated fake models (realistic
 * aliases over fake- upstreams, src/test/fakeStack/models.ts) are the primary
 * surface: response shapes are selected with the /play command against
 * gpt-5.2-mini, and every other command drives its own behavior.
 * Compared to the in-process capture suite this adds a real proxy hop:
 * LiteLLM re-serializes requests and streams, so these tests pin what
 * survives the trip. Run via `bun run test:docker`.
 */

const BASE_URL = process.env.LITELLM_DOCKER_BASE_URL || "";
const API_KEY = process.env.LITELLM_DOCKER_API_KEY || "sk-test-1234";
const FAKE_URL = process.env.LITELLM_DOCKER_FAKE_URL || "";

/** The six host-visible consolidated survivors; gpt-4-turbo is blocked and must never appear. */
const SURVIVOR_IDS = ["claude-opus-4-5", "deepseek-r2", "gpt-5.2", "gpt-5.2-mini", "gpt-5.2-omni", "llama-4-scout"];

/** Cancellation drives this command; the expected chunk count is read from its argument. */
const CANCEL_STREAM_COMMAND = "/stream:50:100";
const CANCEL_STREAM_COUNT = Number(CANCEL_STREAM_COMMAND.split(":")[1]);

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

	function chatModel(name: string): vscode.LanguageModelChat {
		return expectDefined(modelsByName.get(name), `model ${name} not registered with the host`);
	}

	async function send(
		name: string,
		messages: vscode.LanguageModelChatMessage[] = [vscode.LanguageModelChatMessage.User("hi")],
		options: vscode.LanguageModelChatRequestOptions = {}
	): Promise<unknown[]> {
		const response = await chatModel(name).sendRequest(messages, options, new vscode.CancellationTokenSource().token);
		return collectStream(response);
	}

	/** One text turn to a model; the workhorse for command-driven tests. */
	const say = (name: string, text: string, options: vscode.LanguageModelChatRequestOptions = {}) =>
		send(name, [vscode.LanguageModelChatMessage.User(text)], options);

	/** Plays a canned scenario through the default playback target. */
	const play = (scenario: string, options: vscode.LanguageModelChatRequestOptions = {}) =>
		say("gpt-5.2-mini", `/play:${scenario}`, options);

	/** The chat body LiteLLM forwarded to the fake backend for the last request. */
	async function lastForwardedRequest(): Promise<ChatBody> {
		const response = await fetch(`${FAKE_URL}/_test/last-request`);
		assert.ok(response.ok, `GET /_test/last-request failed: ${response.status}`);
		return (await response.json()) as ChatBody;
	}

	suiteSetup(async function () {
		this.timeout(90000);

		await ensureActivated();
		await clearServers();
		const { modelIds } = await addServer("Docker", BASE_URL, API_KEY);
		registeredModelIds = modelIds;
		for (const id of SURVIVOR_IDS) {
			assert.ok(modelIds.includes(id), `LiteLLM did not register ${id}; check the generated proxy config`);
		}

		const models = await waitForHostModels(
			60000,
			(candidates) => SURVIVOR_IDS.every((id) => candidates.some((m) => m.id === id)),
			"host to expose the consolidated survivors"
		);
		for (const model of models) {
			modelsByName.set(model.id, model);
		}
	});

	// ── Consolidated registry: the config and the tests share one table ───────

	suite("consolidated registry", () => {
		test("the registered models are exactly the six survivors", () => {
			// Deterministic because the test orchestrator always generates the
			// config without real-provider wildcard routes.
			assert.deepStrictEqual([...registeredModelIds].sort(), SURVIVOR_IDS);
		});

		test("the HOST model list is exactly the six survivors", () => {
			// The polled wait accepts supersets; this pins exact equality on what
			// vscode.lm actually exposes, not only on the provider refresh result.
			assert.deepStrictEqual([...modelsByName.keys()].sort(), SURVIVOR_IDS);
		});

		test("the blocked gpt-4-turbo never registers", () => {
			assert.ok(!registeredModelIds.includes("gpt-4-turbo"), "blocked models must not register");
			assert.ok(!modelsByName.has("gpt-4-turbo"), "blocked models must not reach the host");
		});

		test("the fake backend's own /v1/models excludes the blocked upstream", async () => {
			// Direct-mode discovery reads this list; a blocked deployment must be
			// invisible there exactly as it is through the proxy.
			const response = await fetch(`${FAKE_URL}/v1/models`);
			assert.ok(response.ok, `GET /v1/models failed: ${response.status}`);
			const ids = ((await response.json()) as { data: Array<{ id: string }> }).data.map((m) => m.id);
			assert.ok(!ids.includes("fake-blocked"), "fake-blocked must not be listed for direct-mode discovery");
			assert.ok(ids.includes("fake-mini"), "non-blocked upstream ids are listed");
		});

		test("declared token limits reach the host", () => {
			assert.strictEqual(chatModel("gpt-5.2-mini").maxInputTokens, 128000);
			assert.strictEqual(chatModel("claude-opus-4-5").maxInputTokens, 1000000);
		});

		test("the reasoning-effort picker schema follows supports_reasoning through real discovery", async () => {
			const infos = (await vscode.commands.executeCommand(
				"litellm._test.refreshModelInfos"
			)) as vscode.LanguageModelChatInformation[];
			const byId = new Map(infos.map((info) => [info.id, info]));
			for (const id of ["claude-opus-4-5", "deepseek-r2", "gpt-5.2-mini"]) {
				assert.deepStrictEqual(
					expectDefined(byId.get(id), `${id} in refreshModelInfos`).configurationSchema,
					REASONING_EFFORT_SCHEMA,
					`${id} advertises reasoning and must surface the picker control`
				);
			}
			for (const id of ["gpt-5.2", "llama-4-scout"]) {
				assert.ok(
					!("configurationSchema" in expectDefined(byId.get(id), `${id} in refreshModelInfos`)),
					`${id} does not advertise reasoning and must not grow the control`
				);
			}
		});
	});

	// -- Load-balanced model group (two deployments, one model_name) ------------

	suite("load-balanced model group", () => {
		test("the two deployments register as a single model", () => {
			const occurrences = registeredModelIds.filter((id) => id === "gpt-5.2");
			assert.strictEqual(occurrences.length, 1, "one registration per model_name, not one per deployment");
			assert.ok(
				registeredModelIds.every((id) => !id.startsWith("gpt-5.2:")),
				"no :cheapest/:fastest/:provider ids; the proxy 404s on those"
			);
		});

		test("the merged model advertises the smaller deployment's limits", () => {
			assert.strictEqual(chatModel("gpt-5.2").maxInputTokens, 64000);
		});

		test("chatting with the merged model routes the raw model_name through the proxy", async () => {
			// The /deployment command reports the upstream id the group picked;
			// the oracle is relational - either declared deployment is correct.
			const text = extractText(await say("gpt-5.2", "/deployment"));
			assert.match(text, /^deployment: fake-balanced-(a|b)$/);
			const body = await lastForwardedRequest();
			assert.ok(
				body.model === "fake-balanced-a" || body.model === "fake-balanced-b",
				`expected an upstream deployment model, got "${body.model}"`
			);
			// Both reads see the same forwarded request, so this cannot catch a
			// lying reporter; what it guards is the command answering from a
			// DIFFERENT routing attempt (e.g. a retry landing on the other
			// deployment between the two reads).
			assert.strictEqual(text, `deployment: ${body.model}`);
		});

		test("the merged declared output limit reaches the backend uncapped", async () => {
			await say("gpt-5.2", "/echo:limit probe");
			const body = await lastForwardedRequest();
			assert.strictEqual(
				body.max_tokens,
				8000,
				"both deployments declare limits, so the merged minimum must pass through, not the 4096 cap"
			);
		});
	});

	// ── Stream shapes: canned scenarios played through the default target ─────

	suite("played text scenarios through the proxy", () => {
		test("text-only", async () => {
			assert.strictEqual(extractText(await play("text-only")), "Hello from capture server");
		});

		test("the declared max_output_tokens reaches the backend uncapped through a real proxy", async () => {
			await play("text-only");
			const body = await lastForwardedRequest();
			assert.strictEqual(body.max_tokens, 16000, "gpt-5.2-mini declares 16000; the 4096 cap must not apply");
			assert.strictEqual(body.model, "fake-mini", "the playback target routes through its own upstream");
		});

		// LiteLLM v1.93 rejects array content deltas outright with a 500; only
		// that specific failure is tolerated (the capture-mode host-fidelity
		// suite covers the shape without a proxy). Anything else must fail.
		const KNOWN_ARRAY_DELTA_REJECTION = /LiteLLM API error: 500[\s\S]*can only concatenate str/;

		test("structured-content renders array text blocks when the proxy forwards them", async () => {
			const outcome = await play("structured-content").then(
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
			const outcome = await play("structured-content-mixed").then(
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
			assert.strictEqual(extractText(await play("control-token-sections")), "Hello world");
		});

		test("finish-length delivers the truncated text", async () => {
			assert.strictEqual(extractText(await play("finish-length")), "This answer was cut sho");
		});

		test("finish-content-filter delivers the partial text", async () => {
			assert.strictEqual(extractText(await play("finish-content-filter")), "Partial answer");
		});

		test("audio-output is skipped without dropping surrounding text", async () => {
			assert.strictEqual(extractText(await play("audio-output")), "Text alongside audio.");
		});

		test("usage trailers do not disturb the text", async () => {
			assert.strictEqual(extractText(await play("usage-only-final")), "Response with usage");
			assert.strictEqual(extractText(await play("usage-with-cache-tokens")), "Cached response");
			assert.strictEqual(extractText(await play("usage-token-details")), "Detailed usage");
		});
	});

	// ── Tool-call scenarios ────────────────────────────────────────────────────

	suite("played tool-call scenarios through the proxy", () => {
		test("tool-call-single reassembles with parsed args", async () => {
			const calls = extractToolCalls(await play("tool-call-single"));
			assert.strictEqual(calls.length, 1);
			const call = expectDefined(calls[0]);
			assert.strictEqual(call.name, "get_weather");
			assert.deepStrictEqual(call.input, { location: "Paris" });
		});

		test("tool-call-chunked reassembles args split across frames", async () => {
			const calls = extractToolCalls(await play("tool-call-chunked"));
			assert.strictEqual(calls.length, 1);
			assert.deepStrictEqual(expectDefined(calls[0]).input, { location: "Paris" });
		});

		test("text-then-tool emits text before the call", async () => {
			const parts = await play("text-then-tool");
			assert.ok(extractText(parts).includes("Let me check that for you."));
			assert.strictEqual(extractToolCalls(parts).length, 1);
		});

		test("parallel-tool-calls emits both calls", async () => {
			const calls = extractToolCalls(await play("parallel-tool-calls"));
			assert.strictEqual(calls.length, 2);
			const locations = calls.map((c) => (c.input as { location: string }).location).sort();
			assert.deepStrictEqual(locations, ["Paris", "Tokyo"]);
		});

		test("inline-tool-call-tokens parses the call and keeps the surrounding text clean", async () => {
			const parts = await play("inline-tool-call-tokens");
			const calls = extractToolCalls(parts);
			assert.strictEqual(calls.length, 1);
			assert.strictEqual(expectDefined(calls[0]).name, "get_weather");
			assert.deepStrictEqual(expectDefined(calls[0]).input, { location: "Paris" });
			const text = extractText(parts);
			assert.ok(!text.includes("<|"), `control tokens must not leak into text, got "${text}"`);
			assert.ok(text.includes("Checking the weather."), "surrounding text must survive");
		});

		test("duplicate-tool-calls collapses the cross-channel duplicate", async () => {
			const calls = extractToolCalls(await play("duplicate-tool-calls"));
			assert.strictEqual(calls.length, 1, "the same call on the delta and inline channels must emit once");
		});

		test("tool-call-invalid-json rejects on completion", async () => {
			await assert.rejects(() => play("tool-call-invalid-json"));
		});
	});

	// ── Reasoning and modern stream fields ─────────────────────────────────────

	suite("played reasoning scenarios through the proxy", () => {
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
				const parts = await play(scenario);
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
			const text = extractText(await play("redacted-thinking"));
			assert.strictEqual(text, "Answer after redacted thinking.");
		});
	});

	suite("played modern stream fields through the proxy", () => {
		test("refusal deltas surface as response text", async () => {
			const text = extractText(await play("refusal"));
			// LiteLLM forwards the first refusal delta and drops the rest.
			assert.ok(text.startsWith("I cannot help"), `refusal must not vanish, got "${text}"`);
		});

		test("url citations surface as a sources trailer", async () => {
			const text = extractText(await play("annotations"));
			assert.ok(text.includes("The sky is blue."), "content text must survive");
			// codeql[js/incomplete-url-substring-sanitization] -- asserts the citation URL surfaces in output text
			assert.ok(text.includes("https://example.test/sky"), `citation URL must surface, got "${text}"`);
		});
	});

	// ── Error scenarios ────────────────────────────────────────────────────────

	suite("error command through the proxy", () => {
		for (const status of [400, 401, 429]) {
			test(`/error:${status} rejects the request`, async () => {
				await assert.rejects(() => say("gpt-5.2-mini", `/error:${status}`));
			});
		}

		test("deliberate errors never cool the deployment down: the model answers immediately after", async () => {
			// The exact failure the router_settings block exists for: without
			// allowed_fails/cooldown_time, three failures sideline the single
			// deployment ("No deployments available... Try again in 5 seconds")
			// and poison every later test that touches the model.
			for (let i = 0; i < 3; i++) {
				await assert.rejects(() => say("gpt-5.2-mini", "/error:429"));
			}
			assert.strictEqual(extractText(await say("gpt-5.2-mini", "/echo:recovered")), "recovered");
		});
	});

	// ── Cancellation ───────────────────────────────────────────────────────────

	suite("cancellation", () => {
		test("cancelling mid-stream stops the slow stream early", async function () {
			this.timeout(30000);
			const source = new vscode.CancellationTokenSource();
			const response = await chatModel("gpt-5.2-mini").sendRequest(
				[vscode.LanguageModelChatMessage.User(CANCEL_STREAM_COMMAND)],
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
				parts.length < CANCEL_STREAM_COUNT / 2,
				`cancellation should stop the stream early: collected ${parts.length} of ${CANCEL_STREAM_COUNT}`
			);
		});
	});

	// ── Request shapes after the proxy hop ─────────────────────────────────────

	suite("request shapes forwarded to the backend", () => {
		test("modern request params survive LiteLLM", async () => {
			await say("gpt-5.2-mini", "/echo:params probe", {
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
			await say("gpt-5.2-mini", "/echo:usage probe");
			const body = await lastForwardedRequest();
			assert.deepStrictEqual(body.stream_options, { include_usage: true });
		});

		test("reasoning_effort reaches the backend through a reasoning-capable model", async () => {
			// deepseek-r2 advertises supports_reasoning: true, the same capability
			// data that puts the Reasoning Effort control in the model picker; a
			// resolved picker choice travels as this exact wire key.
			await say("deepseek-r2", "/echo:effort probe", { modelOptions: { reasoning_effort: "high" } });
			const body = await lastForwardedRequest();
			assert.strictEqual(body.reasoning_effort, "high", "the proxy must forward the effort level to the backend");
			assert.strictEqual(body.model, "fake-reasoner");
		});

		test("image parts arrive as image_url blocks", async () => {
			const message = new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [
				new vscode.LanguageModelTextPart("Describe this image."),
				new vscode.LanguageModelDataPart(PNG_DATA, "image/png"),
			]);
			await send("gpt-5.2-mini", [message]);
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
			await send("gpt-5.2-mini", [message]);
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
			await say("gpt-5.2-mini", "weather?", {
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
			// claude-opus-4-5 advertises supports_prompt_caching: true, so the
			// extension places its cache breakpoints. LiteLLM must accept the
			// request and forward the markers: last tool, first user message, and
			// rolling last message (no system message reaches the provider from a
			// plain sendRequest). This validates marker survival on the OpenAI
			// path only; the proxy's Anthropic translation never runs against the
			// fake backend.
			const messages = [
				vscode.LanguageModelChatMessage.User("Task: audit the repository."),
				vscode.LanguageModelChatMessage.Assistant("Starting with the README."),
				vscode.LanguageModelChatMessage.User("Now check the tests."),
			];
			const tools = [
				{ name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: {} } },
				{ name: "list_dir", description: "List a directory", inputSchema: { type: "object", properties: {} } },
			];
			const parts = await send("claude-opus-4-5", messages, { tools });
			assert.strictEqual(extractText(parts), FALLBACK_TEXT, "the request completed with the no-command reply");

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
			// gpt-5.2 carries tools but not prompt caching: the tools-bearing
			// caching-negative, so tool definitions flow while markers must not.
			await say("gpt-5.2", "weather?", {
				tools: [
					{
						name: "get_weather",
						description: "Get the weather",
						inputSchema: { type: "object", properties: { location: { type: "string" } } },
					},
				],
			});
			const body = await lastForwardedRequest();
			assert.ok(!JSON.stringify(body).includes("cache_control"), "gpt-5.2 advertises no caching");
		});
	});

	// ── Phase-4 coverage: caps, pricing tiers, introspection, tools, media ─────

	const sha256Hex = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");

	suite("default output cap", () => {
		test("llama-4-scout's undeclared limits fall back to the min(4096, default) cap", async () => {
			await say("llama-4-scout", "/echo:cap probe");
			const body = await lastForwardedRequest();
			assert.strictEqual(body.model, "fake-minimal");
			assert.strictEqual(
				body.max_tokens,
				4096,
				"no declared max output means the defaultMaxOutputTokens-derived min(4096, ...) cap applies"
			);
		});
	});

	suite("pricing through real discovery", () => {
		test("tier and cache costs surface on the flagship and stay absent on the pair", async () => {
			const infos = (await vscode.commands.executeCommand(
				"litellm._test.refreshModelInfos"
			)) as vscode.LanguageModelChatInformation[];
			const byId = new Map(infos.map((info) => [info.id, info]));

			const opus = expectDefined(byId.get("claude-opus-4-5"));
			// Host pricing is per million tokens; the config declares per-token.
			assert.strictEqual(opus.inputCost, 5);
			assert.strictEqual(opus.outputCost, 25);
			assert.strictEqual(opus.cacheCost, 0.5);
			assert.strictEqual(opus.cacheWriteCost, 6.25);
			assert.strictEqual(opus.longContextInputCost, 10);
			assert.strictEqual(opus.longContextOutputCost, 37.5);
			assert.strictEqual(opus.longContextCacheCost, 1);
			assert.strictEqual(opus.longContextCacheWriteCost, 12.5);

			const pair = expectDefined(byId.get("gpt-5.2"));
			assert.strictEqual(pair.inputCost, 1.25);
			assert.strictEqual(pair.outputCost, 10);
			// Flat pricing without caching means ALL six optional fields stay
			// absent, not just a sample of them.
			assert.strictEqual(pair.cacheCost, undefined, "no cache read cost without advertised caching");
			assert.strictEqual(pair.cacheWriteCost, undefined, "no cache write cost without advertised caching");
			assert.strictEqual(pair.longContextInputCost, undefined, "flat pricing must not grow the input tier");
			assert.strictEqual(pair.longContextOutputCost, undefined, "flat pricing must not grow the output tier");
			assert.strictEqual(pair.longContextCacheCost, undefined, "no long-context cache read tier");
			assert.strictEqual(pair.longContextCacheWriteCost, undefined, "no long-context cache write tier");

			// The spike's zero-stamp finding, pinned at host level: undeclared
			// pricing arrives from v1.93 as zero costs, not absent ones.
			const scout = expectDefined(byId.get("llama-4-scout"));
			assert.strictEqual(scout.inputCost, 0);
			assert.strictEqual(scout.outputCost, 0);
		});
	});

	suite("introspection commands", () => {
		const weatherTool = {
			name: "get_weather",
			description: "Get the weather",
			inputSchema: { type: "object", properties: { location: { type: "string" } } },
		};

		test("/tools lists offered tools with descriptions, and reports none honestly", async () => {
			const withTools = extractText(await say("gpt-5.2-mini", "/tools", { tools: [weatherTool] }));
			assert.ok(withTools.includes("get_weather: Get the weather"), `got: ${withTools}`);
			assert.strictEqual(extractText(await say("gpt-5.2-mini", "/tools")), "no tools offered");
		});

		test("/messages reports roles and shapes, never content", async () => {
			const text = extractText(
				await send("gpt-5.2-mini", [
					vscode.LanguageModelChatMessage.User("first question"),
					vscode.LanguageModelChatMessage.Assistant("an answer"),
					vscode.LanguageModelChatMessage.User("/messages"),
				])
			);
			assert.match(text, /message\[0\] user: text\(14\)/);
			assert.match(text, /message\[1\] assistant: text\(9\)/);
			assert.ok(!text.includes("first question"), "content never appears");
		});

		test("/cache reports the zero-marker sentence on a non-caching model", async () => {
			const text = extractText(await say("gpt-5.2-mini", "/cache", { tools: [weatherTool] }));
			assert.strictEqual(text, "no cache_control markers received (none sent, or stripped by the proxy)");
		});

		test("/cache reports exact marker positions on the caching flagship", async () => {
			const text = extractText(
				await send(
					"claude-opus-4-5",
					[
						vscode.LanguageModelChatMessage.User("Task: audit the repository."),
						vscode.LanguageModelChatMessage.Assistant("Starting."),
						vscode.LanguageModelChatMessage.User("/cache"),
					],
					{ tools: [weatherTool] }
				)
			);
			assert.ok(text.includes("tools[0]: cache_control"), `the last (only) tool is marked; got: ${text}`);
			assert.ok(text.includes("messages[0].content[0]: cache_control"), `first user anchor; got: ${text}`);
			assert.ok(text.includes("messages[2].content[0]: cache_control"), `rolling last anchor; got: ${text}`);
			assert.ok(text.includes("total: 3"), `tools + first user + rolling last, nothing else; got: ${text}`);
		});

		test("/deployment on a single-deployment model names its only upstream", async () => {
			assert.strictEqual(extractText(await say("gpt-5.2-mini", "/deployment")), "deployment: fake-mini");
		});
	});

	suite("tool command: the two-turn agent flow", () => {
		const tools = [
			{
				name: "get_weather",
				description: "Get the weather",
				inputSchema: { type: "object", properties: { location: { type: "string" } } },
			},
		];

		test("call turn then summary turn", async () => {
			const callTurn = await say("gpt-5.2-mini", '/tool:get_weather {"location":"Paris"}', { tools });
			const calls = extractToolCalls(callTurn);
			assert.strictEqual(calls.length, 1);
			const call = expectDefined(calls[0]);
			assert.strictEqual(call.name, "get_weather");
			assert.deepStrictEqual(call.input, { location: "Paris" });
			assert.strictEqual(call.callId, "call_fake_0", "the id counts prior tool turns deterministically");

			const summaryTurn = await send(
				"gpt-5.2-mini",
				[
					vscode.LanguageModelChatMessage.User('/tool:get_weather {"location":"Paris"}'),
					new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, [
						new vscode.LanguageModelToolCallPart(call.callId, "get_weather", { location: "Paris" }),
					]),
					new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [
						new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart("sunny, 21C")]),
					]),
				],
				{ tools }
			);
			assert.strictEqual(extractText(summaryTurn), "tool get_weather returned: sunny, 21C");
		});
	});

	suite("four-anchor cache markers", () => {
		test("a system message adds the fourth anchor when the host accepts role 3", async function () {
			this.timeout(30000);
			// Probe first: nothing in this repo had pushed a role-3 message
			// through model.sendRequest before, so whether the HOST accepts it
			// across marshalling is measured, not assumed.
			const systemMessage = new vscode.LanguageModelChatMessage(3 as vscode.LanguageModelChatMessageRole, [
				new vscode.LanguageModelTextPart("System rules for the audit."),
			]);
			const messages = [
				systemMessage,
				vscode.LanguageModelChatMessage.User("Task: audit the repository."),
				vscode.LanguageModelChatMessage.Assistant("Starting with the README."),
				vscode.LanguageModelChatMessage.User("Now check the tests."),
			];
			const tools = [
				{ name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: {} } },
			];
			const outcome = await send("claude-opus-4-5", messages, { tools }).then(
				(parts) => ({ parts }),
				(error: unknown) => ({ error })
			);
			if ("error" in outcome) {
				// PROBE RESULT (contingency per plan): the host REJECTS role 3 for
				// extensions without the languageModelSystem API proposal - the
				// throw happens in host marshalling, before anything reaches the
				// wire. Pin that exact rejection so a future host or manifest
				// change that starts accepting system messages fails this test
				// loudly and upgrades it to the four-anchor branch. Until then the
				// docker suite pins three anchors (the plain-sendRequest test) and
				// the four-anchor invariant stays covered by
				// src/test/shared/promptCache.test.ts.
				assert.match(
					String(outcome.error),
					/languageModelSystem/,
					"role 3 must fail only for the missing API proposal, nothing else"
				);
				console.log("[docker] role-3 system message rejected by host marshalling; three anchors stay pinned");
				return;
			}
			const body = await lastForwardedRequest();
			const markerCount = JSON.stringify(body).split('"cache_control"').length - 1;
			assert.ok(
				(body.messages ?? []).some((m) => m.role === "system"),
				"an accepted role-3 message must arrive as role system"
			);
			assert.strictEqual(markerCount, 4, "system + tools + first user + rolling anchors");
		});
	});

	suite("generated media", () => {
		const PNG_SHA256 = "57c5b0ba802ba3aa9c4ebd11a8ef32d173abc6dd5b3deabb7cd540b66e14edc5";
		const WAV_SHA256 = "08662970568d4e2cf49988067bee006f7e8ded8c4cd93f4aa6ef4211b891d8af";

		test("/image and /audio degrade gracefully at the LM API level", async () => {
			// The extension's wire parser discards media fields it does not map;
			// the pinned contract is the chat completing with the hash line
			// verbatim and nothing thrown.
			assert.strictEqual(
				extractText(await say("gpt-5.2-mini", "/image")),
				`Generated a PNG image, 69 bytes, sha256=${PNG_SHA256}.`
			);
			assert.strictEqual(
				extractText(await say("gpt-5.2-mini", "/audio")),
				`Generated a WAV clip, 52 bytes, sha256=${WAV_SHA256}.`
			);
		});

		/** Raw SSE through the LiteLLM proxy; media byte integrity is only observable beneath the LM API. */
		async function rawProxyStream(command: string): Promise<string> {
			const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
				method: "POST",
				headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gpt-5.2-mini",
					stream: true,
					messages: [{ role: "user", content: command }],
				}),
			});
			assert.ok(response.ok, `raw stream failed: ${response.status}`);
			return await response.text();
		}

		function deltasOf(sse: string): Array<Record<string, unknown>> {
			return sse
				.split("\n")
				.filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
				.map((line) => JSON.parse(line.slice("data: ".length)) as { choices?: Array<{ delta?: unknown }> })
				.flatMap((chunk) => (chunk.choices ?? []).map((choice) => (choice.delta ?? {}) as Record<string, unknown>));
		}

		test("the emitted PNG bytes survive the proxy verbatim (raw SSE observation)", async () => {
			const deltas = deltasOf(await rawProxyStream("/image"));
			const images = deltas.find((delta) => Array.isArray(delta.images))?.images as
				| Array<{ image_url?: { url?: string } }>
				| undefined;
			const url = expectDefined(images?.[0]?.image_url?.url, "delta.images transits the proxy");
			const base64 = expectDefined(url.split("base64,")[1], "data URL payload");
			assert.strictEqual(sha256Hex(Buffer.from(base64, "base64")), PNG_SHA256, "payload bytes are lossless");
		});

		test("the emitted WAV bytes survive the proxy verbatim (raw SSE observation)", async () => {
			const deltas = deltasOf(await rawProxyStream("/audio"));
			const audio = deltas.find((delta) => typeof delta.audio === "object" && delta.audio !== null)?.audio as
				| { data?: string }
				| undefined;
			const data = expectDefined(audio?.data, "delta.audio transits the proxy");
			assert.strictEqual(sha256Hex(Buffer.from(data, "base64")), WAV_SHA256, "payload bytes are lossless");
		});
	});

	suite("attachment wire fidelity", () => {
		test("image and pdf attachments arrive byte-lossless on the vision+pdf flagship", async () => {
			// The fixtures are the real bytes checked into this file; the test
			// hashes the SOURCE bytes and compares against what the backend
			// decoded from the wire - envelope re-encoding cannot fail this,
			// payload corruption always does.
			const message = new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [
				new vscode.LanguageModelDataPart(PNG_DATA, "image/png"),
				new vscode.LanguageModelDataPart(PDF_DATA, "application/pdf"),
				new vscode.LanguageModelTextPart("/attachments"),
			]);
			const text = extractText(await send("claude-opus-4-5", [message]));
			assert.ok(
				text.includes(`kind=image_url mime=image/png bytes=${PNG_DATA.length} sha256=${sha256Hex(PNG_DATA)}`),
				`image fidelity line missing; got: ${text}`
			);
			assert.ok(
				text.includes(`kind=file mime=application/pdf bytes=${PDF_DATA.length} sha256=${sha256Hex(PDF_DATA)}`),
				`pdf fidelity line missing; got: ${text}`
			);
		});

		test("the conversion contract for an image on a non-vision model is pinned", async () => {
			const message = new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [
				new vscode.LanguageModelDataPart(PNG_DATA, "image/png"),
				new vscode.LanguageModelTextPart("/attachments"),
			]);
			const text = extractText(await send("gpt-5.2", [message]));
			// Pinned from observation: the extension forwards data parts based on
			// the request content, not the capability flags - capability gating
			// is the HOST's job (the picker hides attachment affordances), so the
			// wire still carries the image_url block.
			assert.ok(
				text.includes(`kind=image_url mime=image/png bytes=${PNG_DATA.length}`),
				`observed contract changed; got: ${text}`
			);
		});
	});

	// ── Runtime-registered scenarios ───────────────────────────────────────────

	suite("custom scenario registration", () => {
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

			assert.strictEqual(extractText(await play("docker-test-custom")), "custom scenario text");
		});
	});

	// ── Command grammar through the real proxy ─────────────────────────────────

	suite("command grammar", () => {
		test("/help lists every command and the play targets", async () => {
			const text = extractText(await say("gpt-5.2-mini", "/help"));
			for (const command of COMMANDS) {
				assert.ok(text.includes(command.usage), `help must list ${command.usage}`);
			}
			assert.ok(text.includes("Play targets:"), "help lists play targets");
		});

		test("only the last non-empty line dispatches: mid-message commands are ignored", async () => {
			assert.strictEqual(extractText(await say("gpt-5.2-mini", "/echo:not this\ntrailing prose")), FALLBACK_TEXT);
		});

		test("command-looking lines inside pasted context are ignored", async () => {
			assert.strictEqual(
				extractText(await say("gpt-5.2-mini", "```\n/error:500\n```\nwhat does this do?")),
				FALLBACK_TEXT
			);
		});

		test("with multiple command lines, the final one wins", async () => {
			assert.strictEqual(extractText(await say("gpt-5.2-mini", "/echo:first\n/echo:second")), "second");
		});

		test("slashless verbs are plain text", async () => {
			assert.strictEqual(extractText(await say("gpt-5.2-mini", "help")), FALLBACK_TEXT);
		});

		test("/echo preserves argument case and inner spacing through the proxy", async () => {
			assert.strictEqual(extractText(await say("gpt-5.2-mini", "/EcHo:CaSe  Kept")), "CaSe  Kept");
		});

		test("/params echoes runtime generation parameters", async () => {
			const text = extractText(await say("gpt-5.2-mini", "/params", { modelOptions: { temperature: 0.4, seed: 11 } }));
			assert.ok(text.includes("temperature: 0.4"), `got: ${text}`);
			assert.ok(text.includes("seed: 11"), `got: ${text}`);
			assert.ok(text.includes(`model: "fake-mini"`), "the routed upstream model appears");
		});

		test("/play routes any model to a named scenario", async () => {
			// Not just the playback default: the LB pair plays scenarios too.
			const calls = extractToolCalls(await say("gpt-5.2", "/play:parallel-tool-calls"));
			assert.strictEqual(calls.length, 2);
		});

		test("/stream delivers the requested chunk count", async () => {
			const text = extractText(await say("gpt-5.2-mini", "/stream:5:50"));
			assert.strictEqual(text, "chunk1 chunk2 chunk3 chunk4 chunk5 ");
		});

		test("a recognized verb with bad arguments yields the diagnostic text, not an error", async () => {
			const text = extractText(await say("gpt-5.2-mini", "/stream:0"));
			assert.ok(text.startsWith("Bad arguments for /stream"), `got: ${text}`);
		});

		test("/text streams a deterministic paragraph of the requested length", async () => {
			const first = extractText(await say("gpt-5.2-mini", "/text:60:9"));
			const second = extractText(await say("gpt-5.2-mini", "/text:60:9"));
			assert.strictEqual(first, second, "same seed, same bytes");
			assert.strictEqual(first.trim().split(/\s+/).length, 60);
		});

		test("/finish:length surfaces the truncated text", async () => {
			assert.strictEqual(extractText(await say("gpt-5.2-mini", "/finish:length")), "This reply stops early on purpose");
		});

		test("a plain prompt to a consolidated model gets the fixed fallback reply", async () => {
			// The consolidated upstreams have no scenario of their own, so a
			// command-less turn lands on the dispatch chain's final arm.
			const text = extractText(await say("gpt-5.2-mini", "What color is the sky?"));
			assert.strictEqual(text, FALLBACK_TEXT);
			assert.ok(FALLBACK_TEXT.length > 50, "the live suite's substantial-text smoke depends on this");
		});

		test("an unknown model with no command gets the fixed fallback reply", async () => {
			// No proxy alias routes to an unknown upstream, so this pins the
			// backend's arm 4 directly over raw HTTP (non-streaming collapse).
			const response = await fetch(`${FAKE_URL}/v1/chat/completions`, {
				method: "POST",
				body: JSON.stringify({ model: "no-such-model", messages: [{ role: "user", content: "hello there" }] }),
			});
			assert.ok(response.ok, `arm 4 must answer 200, got ${response.status}`);
			const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
			assert.strictEqual(body.choices[0]?.message.content, FALLBACK_TEXT);
		});

		test("custom-scenario registration rejects bodies over 1 MiB with 413", async () => {
			const oversized = JSON.stringify({
				name: "too-big",
				config: { type: "sse", chunks: [{ pad: "x".repeat(1024 * 1024) }] },
			});
			const response = await fetch(`${FAKE_URL}/_test/custom-scenario`, { method: "PUT", body: oversized });
			assert.strictEqual(response.status, 413);
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
				(candidates) => candidates.some((m) => m.id === "gpt-5.2-mini"),
				"the provider group to expose gpt-5.2-mini"
			);
			const model = expectDefined(models.find((m) => m.id === "gpt-5.2-mini"));
			const response = await model.sendRequest(
				[vscode.LanguageModelChatMessage.User("hi")],
				{},
				new vscode.CancellationTokenSource().token
			);
			assert.strictEqual(extractText(await collectStream(response)), FALLBACK_TEXT);
		});
	});
});
