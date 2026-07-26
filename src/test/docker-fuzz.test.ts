import * as assert from "node:assert";
import * as vscode from "vscode";
import {
	addServer,
	clearServers,
	collectStream,
	ensureActivated,
	extractText,
	extractToolCalls,
	waitForHostModels,
} from "./hostApiHelpers";
import { expectDefined } from "./testUtils";

/**
 * Generative stream fuzzer for the docker LiteLLM stack.
 *
 * Each iteration builds a random-but-valid SSE chunk sequence, registers it on
 * the fake backend as a custom scenario, streams it through the real LiteLLM
 * proxy and the VS Code LM API, and checks liveness invariants: the request
 * completes, every generated text segment arrives in order, tool calls
 * reassemble exactly, and no duplicate tool-call IDs are emitted.
 *
 * Reproduction: every run logs its seed; rerun with
 * `FUZZ_SEED=<seed> FUZZ_ITERATIONS=<n> bun run test:docker`.
 */

const BASE_URL = process.env.LITELLM_DOCKER_BASE_URL || "";
const API_KEY = process.env.LITELLM_DOCKER_API_KEY || "sk-test-1234";
const FAKE_URL = process.env.LITELLM_DOCKER_FAKE_URL || "";
// Explicit seeds reproduce exactly, including 0; anything unset or invalid
// draws a fresh seed.
const seedEnv = Number(process.env.FUZZ_SEED ?? "");
const SEED = process.env.FUZZ_SEED?.trim() && Number.isFinite(seedEnv) ? seedEnv >>> 0 : (Date.now() >>> 4) % 1000000;
const ITERATIONS = Math.max(1, Math.floor(Number(process.env.FUZZ_ITERATIONS)) || 10);

/** Deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface GeneratedStream {
	chunks: unknown[];
	/** The exact text the extension must emit, including the single space hint it inserts between text and a following tool call. */
	expectedText: string;
	expectedToolCalls: Array<{ name: string; args: Record<string, unknown> }>;
}

const WORDS = ["alpha", "bravo", "delta", "echo", "lima", "oscar", "tango", "zulu"];
const TOOL_NAMES = ["get_weather", "search_docs", "run_query"];

function chunkOf(delta: Record<string, unknown>, finishReason?: string): Record<string, unknown> {
	return {
		id: "chatcmpl-fuzz",
		object: "chat.completion.chunk",
		choices: [{ index: 0, delta, ...(finishReason ? { finish_reason: finishReason } : {}) }],
	};
}

/** Split `text` into 1..3 random slices. */
function randomSlices(random: () => number, text: string): string[] {
	const cuts = Math.floor(random() * 3);
	const slices: string[] = [];
	let rest = text;
	for (let i = 0; i < cuts && rest.length > 1; i++) {
		const at = 1 + Math.floor(random() * (rest.length - 1));
		slices.push(rest.slice(0, at));
		rest = rest.slice(at);
	}
	slices.push(rest);
	return slices;
}

function generateStream(random: () => number): GeneratedStream {
	const chunks: unknown[] = [chunkOf({ role: "assistant" })];
	const expectedToolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
	let expectedText = "";
	let hintInserted = false;
	let toolIndex = 0;

	const eventCount = 1 + Math.floor(random() * 6);
	for (let i = 0; i < eventCount; i++) {
		const roll = random();
		if (roll < 0.4) {
			// Plain text, possibly split across chunks. No "<" so the inline
			// tool-call parser passes it through verbatim.
			const words = Array.from({ length: 1 + Math.floor(random() * 4) }, () =>
				expectDefined(WORDS[Math.floor(random() * WORDS.length)])
			);
			const text = `${words.join(" ")} `;
			expectedText += text;
			for (const slice of randomSlices(random, text)) {
				chunks.push(chunkOf({ content: slice }));
			}
		} else if (roll < 0.7) {
			// Delta-channel tool call with arguments split across frames. The
			// extension inserts a single space between already-emitted text and
			// the first tool call of the stream; mirror that in the expectation.
			if (expectedText.length > 0 && !hintInserted) {
				expectedText += " ";
				hintInserted = true;
			}
			const name = expectDefined(TOOL_NAMES[Math.floor(random() * TOOL_NAMES.length)]);
			const args: Record<string, unknown> = {
				[expectDefined(WORDS[Math.floor(random() * WORDS.length)])]: Math.floor(random() * 100),
			};
			// Identical name+args pairs collapse in the extension's cross-channel
			// dedup accounting only when they repeat across channels; on one
			// channel they all emit. Keep pairs unique to keep expectations exact.
			args.seq = toolIndex;
			expectedToolCalls.push({ name, args });
			const argText = JSON.stringify(args);
			const slices = randomSlices(random, argText);
			chunks.push(
				chunkOf({
					tool_calls: [
						{
							index: toolIndex,
							id: `call_fuzz_${toolIndex}`,
							type: "function",
							function: { name, arguments: slices[0] },
						},
					],
				})
			);
			for (const slice of slices.slice(1)) {
				chunks.push(chunkOf({ tool_calls: [{ index: toolIndex, function: { arguments: slice } }] }));
			}
			toolIndex++;
		} else if (roll < 0.85) {
			// Reasoning content; emits thinking parts, never text.
			chunks.push(chunkOf({ reasoning_content: "thinking about it..." }));
		} else {
			// Unknown extra fields on otherwise valid chunks. Structurally broken
			// chunks (choices as a string, no choices at all) are out of scope
			// here: LiteLLM itself aborts the stream on those before the
			// extension ever sees them; the wire property tests cover the
			// extension's own leniency.
			const chunk = chunkOf({ reasoning_content: "noise" }) as Record<string, unknown>;
			chunk.fuzz_extra = { nested: [1, 2, 3] };
			for (const choice of chunk.choices as Array<Record<string, unknown>>) {
				choice.fuzz_choice_extra = "x";
			}
			chunks.push(chunk);
		}
	}

	chunks.push(chunkOf({}, expectedToolCalls.length > 0 ? "tool_calls" : "stop"));
	if (random() < 0.3) {
		chunks.push({
			id: "chatcmpl-fuzz",
			object: "chat.completion.chunk",
			choices: [],
			usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
		});
	}
	return { chunks, expectedText, expectedToolCalls };
}

suite("Docker LiteLLM stream fuzzer", () => {
	if (!BASE_URL) {
		test("SKIPPED: LITELLM_DOCKER_BASE_URL not set; run via `bun run test:docker`", () => {});
		return;
	}

	let dynamicModel: vscode.LanguageModelChat;

	suiteSetup(async function () {
		this.timeout(90000);
		await ensureActivated();
		await clearServers();
		await addServer("Docker", BASE_URL, API_KEY);
		const models = await waitForHostModels(
			60000,
			(candidates) => candidates.some((m) => m.id === "fake/dynamic"),
			"host to expose fake/dynamic"
		);
		dynamicModel = expectDefined(models.find((m) => m.id === "fake/dynamic"));
	});

	test(`fuzzes ${ITERATIONS} generated streams (seed ${SEED})`, async function () {
		this.timeout(Math.max(120000, ITERATIONS * 10000));
		console.log(`[fuzz] seed=${SEED} iterations=${ITERATIONS}`);
		const random = mulberry32(SEED);

		for (let iteration = 0; iteration < ITERATIONS; iteration++) {
			const generated = generateStream(random);
			const label = `seed=${SEED} iteration=${iteration}`;
			const context = () => `${label} chunks=${JSON.stringify(generated.chunks).slice(0, 1200)}`;

			const name = `fuzz-${SEED}-${iteration}`;
			const registered = await fetch(`${FAKE_URL}/_test/custom-scenario`, {
				method: "PUT",
				body: JSON.stringify({ name, config: { type: "sse", chunks: generated.chunks } }),
			});
			assert.ok(registered.ok, `custom-scenario registration failed (${label})`);
			const selected = await fetch(`${FAKE_URL}/_test/scenario`, { method: "PUT", body: name });
			assert.ok(selected.ok, `scenario selection failed (${label})`);

			const response = await dynamicModel.sendRequest(
				[vscode.LanguageModelChatMessage.User("fuzz")],
				{},
				new vscode.CancellationTokenSource().token
			);
			const parts = await collectStream(response);

			// Invariant: text arrives exactly, nothing extra, nothing lost.
			const text = extractText(parts);
			assert.strictEqual(text, generated.expectedText, `text diverged (${context()})`);

			// Invariant: tool calls reassemble exactly, with unique IDs.
			const calls = extractToolCalls(parts);
			assert.strictEqual(calls.length, generated.expectedToolCalls.length, `tool call count diverged (${context()})`);
			const actualSorted = calls
				.map((c) => ({ name: c.name, args: c.input as Record<string, unknown> }))
				.sort((a, b) => Number(a.args.seq) - Number(b.args.seq));
			assert.deepStrictEqual(actualSorted, generated.expectedToolCalls, `tool calls diverged (${context()})`);
			const ids = calls.map((c) => c.callId);
			assert.strictEqual(new Set(ids).size, ids.length, `duplicate tool call IDs: ${ids.join(", ")} (${context()})`);
		}
	});
});
