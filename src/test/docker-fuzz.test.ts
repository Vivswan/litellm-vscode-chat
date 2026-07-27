import * as assert from "node:assert";
import * as vscode from "vscode";
import type { ExpectedToolCall, FuzzEvent } from "./fuzzCorpus";
import { FUZZ_CORPUS } from "./fuzzCorpus";
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
 * Each iteration builds a random stream as a list of serializable events
 * (text, delta/inline/duplicated/interleaved tool calls, refusals, citations,
 * reasoning, junk), registers it on the fake backend, selects it by sending
 * /play:<name> as the user message, streams it through the VS Code LM API,
 * and asserts the exact expected outcome: text arrives verbatim (including
 * the space hint and citation trailer the extension adds), tool calls
 * reassemble exactly, and IDs stay unique.
 *
 * Two targets share the generator: through the LiteLLM proxy, and directly
 * against the fake backend. Direct mode additionally generates what the
 * proxy would reject (malformed chunks, multi-part refusals), fuzzing the
 * extension's leniency contract over a real socket. A random-cancellation
 * pass checks streams die promptly and silently when cancelled.
 *
 * Failures shrink to a minimal failing event list before reporting, and the
 * corpus in fuzzCorpus.ts replays past failures first. Reproduce any run
 * with `FUZZ_SEED=<seed> bun run test:docker` (the seed is always logged).
 */

const BASE_URL = process.env.LITELLM_DOCKER_BASE_URL || "";
const API_KEY = process.env.LITELLM_DOCKER_API_KEY || "sk-test-1234";
const FAKE_URL = process.env.LITELLM_DOCKER_FAKE_URL || "";
// Explicit seeds reproduce exactly, including 0; anything unset or invalid
// draws a fresh seed (pid- and shard-mixed so parallel CI shards diverge even
// when they start in the same instant).
const seedEnv = Number(process.env.FUZZ_SEED ?? "");
const shardSalt = (Number(process.env.FUZZ_SHARD) || 0) * 7919;
const SEED =
	process.env.FUZZ_SEED?.trim() && Number.isFinite(seedEnv)
		? seedEnv >>> 0
		: (((Date.now() >>> 4) ^ (process.pid << 8) ^ shardSalt) >>> 0) % 1000000;
const ITERATIONS = Math.max(1, Math.floor(Number(process.env.FUZZ_ITERATIONS)) || 10);
const MAX_SHRINK_RUNS = 32;

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

const WORDS = ["alpha", "bravo", "delta", "echo", "lima", "oscar", "tango", "zulu"];
const UNICODE_WORDS = ["日本語", "café", "émoji✨", "مرحبا", "🚀🧠"];
const TOOL_NAMES = ["get_weather", "search_docs", "run_query"];
/** Arg values that stress JSON escaping through two serialization hops. */
const TRICKY_ARG_VALUES = [
	'quo"te',
	"back\\slash",
	"new\nline",
	"tab\there",
	"日本語 🌊",
	'{"nested":"json-looking"}',
	"<|not_a_token",
	"trailing space ",
	"",
];

function chunkOf(delta: Record<string, unknown>, finishReason?: string): Record<string, unknown> {
	return {
		id: "chatcmpl-fuzz",
		object: "chat.completion.chunk",
		choices: [{ index: 0, delta, ...(finishReason ? { finish_reason: finishReason } : {}) }],
	};
}

// ── Event generators ─────────────────────────────────────────────────────────

interface GeneratorState {
	random: () => number;
	toolIndex: number;
	citationIndex: number;
	/** Direct mode may split surrogate pairs across chunks; the proxy cannot take those. */
	allowSurrogateSplit: boolean;
}

/**
 * Split `text` into 1..4 random slices, possibly mid-token. Cuts between the
 * halves of a surrogate pair only when the mode allows it: the extension
 * reunites lone halves fine (proven in direct mode), but LiteLLM 500s the
 * whole request when a tool-argument fragment carries a lone surrogate, and
 * real providers never emit one (they ASCII-escape unicode in arguments).
 */
function randomSlices(state: GeneratorState, text: string): string[] {
	const cuts = Math.floor(state.random() * 4);
	const slices: string[] = [];
	let rest = text;
	for (let i = 0; i < cuts && rest.length > 1; i++) {
		let at = 1 + Math.floor(state.random() * (rest.length - 1));
		const beforeCut = rest.charCodeAt(at - 1);
		if (!state.allowSurrogateSplit && beforeCut >= 0xd800 && beforeCut <= 0xdbff && at < rest.length) {
			at++;
		}
		if (at >= rest.length) {
			break;
		}
		slices.push(rest.slice(0, at));
		rest = rest.slice(at);
	}
	slices.push(rest);
	return slices;
}

function words(state: GeneratorState, count: number): string {
	return Array.from({ length: count }, () => expectDefined(WORDS[Math.floor(state.random() * WORDS.length)])).join(" ");
}

function toolCallSpec(state: GeneratorState): ExpectedToolCall {
	const name = expectDefined(TOOL_NAMES[Math.floor(state.random() * TOOL_NAMES.length)]);
	// The seq field keeps every generated name+args pair unique, so the
	// cross-channel dedup accounting never collapses two intended calls.
	const args: Record<string, unknown> = {
		[expectDefined(WORDS[Math.floor(state.random() * WORDS.length)])]: Math.floor(state.random() * 100),
		seq: state.toolIndex,
	};
	if (state.random() < 0.5) {
		args.tricky = expectDefined(TRICKY_ARG_VALUES[Math.floor(state.random() * TRICKY_ARG_VALUES.length)]);
	}
	if (state.random() < 0.25) {
		args.nested = { list: [1, "two", null], flag: state.random() < 0.5 };
	}
	return { name, args };
}

/** Frames of one delta-channel tool call, arguments split across 1..4 chunks. */
function deltaToolFrames(state: GeneratorState, call: ExpectedToolCall, index: number): unknown[] {
	const slices = randomSlices(state, JSON.stringify(call.args));
	const frames = [
		chunkOf({
			tool_calls: [
				{ index, id: `call_fuzz_${index}`, type: "function", function: { name: call.name, arguments: slices[0] } },
			],
		}),
	];
	for (const slice of slices.slice(1)) {
		frames.push(chunkOf({ tool_calls: [{ index, function: { arguments: slice } }] }));
	}
	return frames;
}

/** The full inline control-token sequence for one call. */
function inlineCallText(call: ExpectedToolCall, index: number): string {
	return `<|tool_call_begin|>${call.name}:${index}<|tool_call_argument_begin|>${JSON.stringify(call.args)}<|tool_call_end|>`;
}

function textEvent(state: GeneratorState): FuzzEvent {
	const roll = state.random();
	let text: string;
	if (roll < 0.15) {
		// Unicode: multi-byte characters must survive two serialization hops
		// and arbitrary slicing (slices can split surrogate pairs into lone
		// halves per chunk; the decoder must reunite them).
		text = `${expectDefined(UNICODE_WORDS[Math.floor(state.random() * UNICODE_WORDS.length)])} `;
	} else if (roll < 0.25) {
		// Long text: one big chunk plus slices, exercising the line buffer.
		text = `${words(state, 1)} `.repeat(50 + Math.floor(state.random() * 200));
	} else {
		text = `${words(state, 1 + Math.floor(state.random() * 4))} `;
	}
	return {
		label: "text",
		text,
		chunks: randomSlices(state, text).map((slice) => chunkOf({ content: slice })),
	};
}

function deltaToolEvent(state: GeneratorState): FuzzEvent {
	const call = toolCallSpec(state);
	const index = state.toolIndex++;
	return { label: "delta-tool", tools: [call], deltaToolChannel: true, chunks: deltaToolFrames(state, call, index) };
}

function inlineToolEvent(state: GeneratorState): FuzzEvent {
	const call = toolCallSpec(state);
	const index = state.toolIndex++;
	const pre = `${words(state, 1)} `;
	const post = ` ${words(state, 1)} `;
	// Sliced across chunks at arbitrary positions, including mid-token: the
	// hold-back logic in the inline parser is exactly what this fuzzes.
	const full = pre + inlineCallText(call, index) + post;
	return {
		label: "inline-tool",
		text: pre + post,
		tools: [call],
		chunks: randomSlices(state, full).map((slice) => chunkOf({ content: slice })),
	};
}

function duplicateToolEvent(state: GeneratorState): FuzzEvent {
	const call = toolCallSpec(state);
	const index = state.toolIndex++;
	// The same call on both channels must emit exactly once, in either order.
	const deltaFirst = state.random() < 0.5;
	const delta = deltaToolFrames(state, call, index);
	const inline = [chunkOf({ content: inlineCallText(call, index) })];
	return {
		label: "duplicate-tool",
		tools: [call],
		deltaToolChannel: true,
		chunks: deltaFirst ? [...delta, ...inline] : [...inline, ...delta],
	};
}

function interleavedToolsEvent(state: GeneratorState): FuzzEvent {
	const first = toolCallSpec(state);
	const firstIndex = state.toolIndex++;
	const second = toolCallSpec(state);
	const secondIndex = state.toolIndex++;
	const firstFrames = deltaToolFrames(state, first, firstIndex);
	const secondFrames = deltaToolFrames(state, second, secondIndex);
	const chunks: unknown[] = [];
	for (let i = 0; i < Math.max(firstFrames.length, secondFrames.length); i++) {
		if (i < firstFrames.length) {
			chunks.push(firstFrames[i]);
		}
		if (i < secondFrames.length) {
			chunks.push(secondFrames[i]);
		}
	}
	return { label: "interleaved-tools", tools: [first, second], deltaToolChannel: true, chunks };
}

function refusalEvent(state: GeneratorState): FuzzEvent {
	// Direct-mode only: LiteLLM v1.93 drops refusal deltas entirely once the
	// stream also carries regular content (pure-refusal streams forward fine;
	// the docker scenario suite pins that).
	const parts = 1 + Math.floor(state.random() * 3);
	const texts = Array.from({ length: parts }, () => `refused ${words(state, 1)} `);
	return {
		label: "refusal",
		text: texts.join(""),
		directOnly: true,
		chunks: texts.map((text) => chunkOf({ refusal: text })),
	};
}

function citationEvent(state: GeneratorState): FuzzEvent {
	const id = state.citationIndex++;
	const text = `cited ${words(state, 1)} `;
	const citation = { url: `https://fuzz.test/${id}`, title: `source-${id}` };
	return {
		label: "citation",
		text,
		citation,
		chunks: [chunkOf({ content: text, annotations: [{ type: "url_citation", url_citation: citation }] })],
	};
}

function reasoningEvent(state: GeneratorState): FuzzEvent {
	const roll = state.random();
	if (roll < 0.34) {
		return { label: "reasoning", chunks: [chunkOf({ reasoning_content: "thinking about it..." })] };
	}
	if (roll < 0.67) {
		return { label: "reasoning-field", chunks: [chunkOf({ reasoning: "pondering..." })] };
	}
	return {
		label: "thinking-blocks",
		chunks: [
			chunkOf({
				reasoning_content: "weighing options",
				thinking_blocks: [{ type: "thinking", thinking: "weighing options", signature: `sig-${state.toolIndex}` }],
			}),
		],
	};
}

function junkFieldsEvent(): FuzzEvent {
	// Unknown extra fields on otherwise valid chunks; both the proxy and the
	// extension must pass them through or ignore them.
	const chunk = chunkOf({ reasoning_content: "noise" }) as Record<string, unknown>;
	chunk.fuzz_extra = { nested: [1, 2, 3] };
	for (const choice of chunk.choices as Array<Record<string, unknown>>) {
		choice.fuzz_choice_extra = "x";
	}
	return { label: "junk-fields", chunks: [chunk, chunkOf({})] };
}

function malformedEvent(state: GeneratorState): FuzzEvent {
	// Structurally broken chunks the extension must skip. The proxy aborts the
	// whole stream on these, so they exist only in direct mode.
	const shapes: unknown[] = [
		{ fuzz: true },
		{ choices: "not-an-array" },
		{ choices: [null, 42, "x"] },
		{ choices: [{ delta: "not-an-object" }] },
		chunkOf({ content: null as unknown as string }),
	];
	return {
		label: "malformed",
		directOnly: true,
		chunks: [shapes[Math.floor(state.random() * shapes.length)]],
	};
}

/** Numeric-string index plus id/name arriving only in later frames (leniency paths). */
function lenientDeltaToolEvent(state: GeneratorState): FuzzEvent {
	const call = toolCallSpec(state);
	const index = state.toolIndex++;
	const slices = randomSlices(state, JSON.stringify(call.args));
	const variant = Math.floor(state.random() * 3);
	const chunks: unknown[] = [];
	if (variant === 0) {
		// Index as a numeric string, mixed with numeric on continuations.
		chunks.push(
			chunkOf({
				tool_calls: [
					{
						index: String(index),
						id: `call_fuzz_${index}`,
						type: "function",
						function: { name: call.name, arguments: slices[0] },
					},
				],
			})
		);
		for (const slice of slices.slice(1)) {
			chunks.push(chunkOf({ tool_calls: [{ index, function: { arguments: slice } }] }));
		}
	} else if (variant === 1) {
		// No id anywhere; the extension mints one.
		chunks.push(
			chunkOf({ tool_calls: [{ index, type: "function", function: { name: call.name, arguments: slices[0] } }] })
		);
		for (const slice of slices.slice(1)) {
			chunks.push(chunkOf({ tool_calls: [{ index, function: { arguments: slice } }] }));
		}
	} else {
		// The name arrives only on the second frame.
		chunks.push(chunkOf({ tool_calls: [{ index, id: `call_fuzz_${index}`, function: { arguments: slices[0] } }] }));
		chunks.push(
			chunkOf({ tool_calls: [{ index, function: { name: call.name, arguments: slices.slice(1).join("") } }] })
		);
	}
	return { label: `lenient-delta-tool-${variant}`, tools: [call], deltaToolChannel: true, chunks, directOnly: true };
}

/** Two byte-identical calls on the delta channel: the max(N, M) rule says both emit. */
function sameChannelTwinsEvent(state: GeneratorState): FuzzEvent {
	const call = toolCallSpec(state);
	const firstIndex = state.toolIndex++;
	const secondIndex = state.toolIndex++;
	const argText = JSON.stringify(call.args);
	return {
		label: "same-channel-twins",
		tools: [call, call],
		deltaToolChannel: true,
		chunks: [
			chunkOf({
				tool_calls: [
					{
						index: firstIndex,
						id: `call_fuzz_${firstIndex}`,
						type: "function",
						function: { name: call.name, arguments: argText },
					},
					{
						index: secondIndex,
						id: `call_fuzz_${secondIndex}`,
						type: "function",
						function: { name: call.name, arguments: argText },
					},
				],
			}),
		],
	};
}

/** Inline call without the ":index" header suffix (content-key dedup path). */
function inlineNoIndexEvent(state: GeneratorState): FuzzEvent {
	const call = toolCallSpec(state);
	state.toolIndex++;
	const pre = `${words(state, 1)} `;
	const full = `${pre}<|tool_call_begin|>${call.name}<|tool_call_argument_begin|>${JSON.stringify(call.args)}<|tool_call_end|>`;
	return {
		label: "inline-no-index",
		text: pre,
		tools: [call],
		chunks: randomSlices(state, full).map((slice) => chunkOf({ content: slice })),
	};
}

/** Structured content arrays; the proxy rejects arrays, so direct only. */
function structuredContentEvent(state: GeneratorState): FuzzEvent {
	const text = `${words(state, 2)} `;
	return {
		label: "structured-content",
		text,
		directOnly: true,
		chunks: [
			chunkOf({
				content: [
					{ type: "text", text },
					{ type: "mystery_block", payload: { deep: true } },
				],
			}),
		],
	};
}

/**
 * Stream-tail events: shapes whose contract is defined by end-of-stream
 * handling, so they must come last and nothing may follow them.
 */
function unterminatedInlineTail(state: GeneratorState): FuzzEvent {
	// A valid-JSON inline call whose end token never arrives: the flush path
	// must still emit it exactly once.
	const call = toolCallSpec(state);
	const index = state.toolIndex++;
	const pre = `${words(state, 1)} `;
	const full = `${pre}<|tool_call_begin|>${call.name}:${index}<|tool_call_argument_begin|>${JSON.stringify(call.args)}`;
	return {
		label: "unterminated-inline-tail",
		text: pre,
		tools: [call],
		chunks: randomSlices(state, full).map((slice) => chunkOf({ content: slice })),
	};
}

function truncatedTokenTail(state: GeneratorState): FuzzEvent {
	// A partial control token at end of stream is protocol residue and must be
	// dropped, while the text before it survives.
	const partials = ["<|tool_call_beg", "<|tool_call_argument_", "<|tool_c"];
	const text = `${words(state, 1)} `;
	const partial = expectDefined(partials[Math.floor(state.random() * partials.length)]);
	return {
		label: "truncated-token-tail",
		text,
		chunks: randomSlices(state, text + partial).map((slice) => chunkOf({ content: slice })),
	};
}

function generateEvents(random: () => number, directMode: boolean): FuzzEvent[] {
	const state: GeneratorState = { random, toolIndex: 0, citationIndex: 0, allowSurrogateSplit: directMode };
	const generators: Array<{ weight: number; make: () => FuzzEvent }> = [
		{ weight: 26, make: () => textEvent(state) },
		{ weight: 12, make: () => deltaToolEvent(state) },
		{ weight: 9, make: () => inlineToolEvent(state) },
		{ weight: 6, make: () => duplicateToolEvent(state) },
		{ weight: 6, make: () => interleavedToolsEvent(state) },
		{ weight: 5, make: () => sameChannelTwinsEvent(state) },
		{ weight: 5, make: () => inlineNoIndexEvent(state) },
		{ weight: 6, make: () => citationEvent(state) },
		{ weight: 9, make: () => reasoningEvent(state) },
		{ weight: 4, make: () => junkFieldsEvent() },
		...(directMode
			? [
					{ weight: 5, make: () => refusalEvent(state) },
					{ weight: 5, make: () => malformedEvent(state) },
					{ weight: 5, make: () => lenientDeltaToolEvent(state) },
					{ weight: 4, make: () => structuredContentEvent(state) },
				]
			: []),
	];
	const totalWeight = generators.reduce((sum, g) => sum + g.weight, 0);

	const eventCount = 1 + Math.floor(random() * 7);
	const events: FuzzEvent[] = [];
	for (let i = 0; i < eventCount; i++) {
		let roll = random() * totalWeight;
		for (const generator of generators) {
			roll -= generator.weight;
			if (roll <= 0) {
				events.push(generator.make());
				break;
			}
		}
	}

	// One optional tail whose behavior is defined by end-of-stream handling.
	const tailRoll = random();
	if (tailRoll < 0.15) {
		events.push(unterminatedInlineTail(state));
	} else if (tailRoll < 0.3) {
		events.push(truncatedTokenTail(state));
	}
	return events;
}

// ── Assembly: events to chunks plus the exact expected outcome ───────────────

interface AssembledStream {
	chunks: unknown[];
	expectedText: string;
	expectedToolCalls: ExpectedToolCall[];
}

function assemble(events: FuzzEvent[]): AssembledStream {
	const chunks: unknown[] = [chunkOf({ role: "assistant" })];
	const expectedToolCalls: ExpectedToolCall[] = [];
	const citations = new Map<string, string>();
	let expectedText = "";
	let hintInserted = false;

	for (const event of events) {
		// The extension inserts a single space between already-emitted text and
		// the first delta-channel tool call of the stream.
		if (event.deltaToolChannel && expectedText.length > 0 && !hintInserted) {
			expectedText += " ";
			hintInserted = true;
		}
		if (event.text) {
			expectedText += event.text;
		}
		if (event.tools) {
			expectedToolCalls.push(...event.tools);
		}
		if (event.citation && !citations.has(event.citation.url)) {
			citations.set(event.citation.url, event.citation.title);
		}
		chunks.push(...event.chunks);
	}

	chunks.push(chunkOf({}, expectedToolCalls.length > 0 ? "tool_calls" : "stop"));
	if (citations.size > 0) {
		const lines = Array.from(citations.entries()).map(([url, title]) => `- [${title}](${url})`);
		expectedText += `\n\nSources:\n${lines.join("\n")}`;
	}
	return { chunks, expectedText, expectedToolCalls };
}

// ── Suite plumbing ────────────────────────────────────────────────────────────

async function registerScenario(name: string, config: Record<string, unknown>): Promise<void> {
	const registered = await fetch(`${FAKE_URL}/_test/custom-scenario`, {
		method: "PUT",
		body: JSON.stringify({ name, config }),
	});
	assert.ok(registered.ok, `custom-scenario registration failed (${name}): ${registered.status}`);
}

/** Run one assembled stream and assert the exact expected outcome. */
async function runStream(model: vscode.LanguageModelChat, name: string, events: FuzzEvent[]): Promise<void> {
	const assembled = assemble(events);
	await registerScenario(name, { type: "sse", chunks: assembled.chunks });
	const response = await model.sendRequest(
		[vscode.LanguageModelChatMessage.User(`/play:${name}`)],
		{},
		new vscode.CancellationTokenSource().token
	);
	const parts = await collectStream(response);

	const text = extractText(parts);
	assert.strictEqual(text, assembled.expectedText, "text diverged");

	const calls = extractToolCalls(parts);
	assert.strictEqual(calls.length, assembled.expectedToolCalls.length, "tool call count diverged");
	const actualSorted = calls
		.map((c) => ({ name: c.name, args: c.input as Record<string, unknown> }))
		.sort((a, b) => Number(a.args.seq) - Number(b.args.seq));
	assert.deepStrictEqual(actualSorted, assembled.expectedToolCalls, "tool calls diverged");
	const ids = calls.map((c) => c.callId);
	assert.strictEqual(new Set(ids).size, ids.length, `duplicate tool call IDs: ${ids.join(", ")}`);
}

/**
 * Shrink a failing event list to a minimal one that still fails: try removing
 * spans, halving the span size down to single events, bounded by
 * MAX_SHRINK_RUNS extra runs. A transient infrastructure failure during a
 * candidate run counts as a reproduction, so the bound also limits how far a
 * flake can distort the minimized output.
 */
async function shrinkFailure(
	model: vscode.LanguageModelChat,
	namePrefix: string,
	events: FuzzEvent[]
): Promise<FuzzEvent[]> {
	let current = events;
	let budget = MAX_SHRINK_RUNS;
	let step = Math.max(1, Math.floor(current.length / 2));
	while (budget > 0) {
		let shrunk = false;
		for (let start = 0; start < current.length && budget > 0; start += step) {
			const candidate = [...current.slice(0, start), ...current.slice(start + step)];
			if (candidate.length === 0) {
				continue;
			}
			budget--;
			try {
				await runStream(model, `${namePrefix}-shrink-${budget}`, candidate);
			} catch {
				current = candidate;
				shrunk = true;
				break;
			}
		}
		if (shrunk) {
			step = Math.min(step, Math.max(1, Math.floor(current.length / 2)));
		} else if (step > 1) {
			step = Math.max(1, Math.floor(step / 2));
		} else {
			break;
		}
	}
	return current;
}

async function fuzzIteration(
	model: vscode.LanguageModelChat,
	name: string,
	events: FuzzEvent[],
	label: string,
	mode: "proxy" | "direct"
): Promise<void> {
	try {
		await runStream(model, name, events);
	} catch (error) {
		const minimal = await shrinkFailure(model, name, events);
		const entry = { name: `<issue-ref>`, mode, events: minimal };
		const serialized = JSON.stringify(entry, null, 1);
		const detail =
			serialized.length > 12000
				? `${serialized.slice(0, 12000)}\n... (truncated; full repro via the seed)`
				: serialized;
		throw new Error(`${label}: ${String(error)}\nMinimal failing corpus entry (add to fuzzCorpus.ts):\n${detail}`, {
			cause: error,
		});
	}
}

function fuzzSuite(title: string, directMode: boolean, serverUrl: string, serverKey: string): void {
	suite(title, () => {
		let fuzzModel: vscode.LanguageModelChat;

		suiteSetup(async function () {
			this.timeout(90000);
			await ensureActivated();
			await clearServers();
			await addServer(title, serverUrl, serverKey);
			// Single-deployment on purpose: responses cannot vary by routing.
			const wantedId = directMode ? "fake-mini" : "gpt-5.2-mini";
			const models = await waitForHostModels(
				60000,
				(candidates) => candidates.some((m) => m.id === wantedId),
				`host to expose ${wantedId}`
			);
			fuzzModel = expectDefined(models.find((m) => m.id === wantedId));
		});

		test("replays the regression corpus", async function () {
			this.timeout(Math.max(60000, FUZZ_CORPUS.length * 5000));
			const mode = directMode ? "direct" : "proxy";
			for (const entry of FUZZ_CORPUS) {
				if (entry.mode !== "both" && entry.mode !== mode) {
					continue;
				}
				await fuzzIteration(fuzzModel, `corpus-${entry.name}`, entry.events, `corpus entry "${entry.name}"`, mode);
			}
		});

		test(`fuzzes ${ITERATIONS} generated streams (seed ${SEED})`, async function () {
			this.timeout(Math.max(120000, ITERATIONS * 10000));
			const mode = directMode ? "direct" : "proxy";
			console.log(`[fuzz] seed=${SEED} iterations=${ITERATIONS} mode=${mode}`);
			const random = mulberry32(directMode ? SEED ^ 0x5f375a86 : SEED);

			for (let iteration = 0; iteration < ITERATIONS; iteration++) {
				const events = generateEvents(random, directMode);
				await fuzzIteration(
					fuzzModel,
					`fuzz-${SEED}-${iteration}`,
					events,
					`seed=${SEED} iteration=${iteration} mode=${mode}`,
					mode
				);
			}
		});

		test("cancellation mid-stream stops promptly and emits nothing afterward", async function () {
			this.timeout(60000);
			const random = mulberry32(SEED ^ 0x9e3779b9);
			const texts = Array.from({ length: 30 }, (_, i) => `slow${i} `);
			const name = `fuzz-cancel-${SEED}`;
			await registerScenario(name, {
				type: "sse-delayed",
				delayMs: 40,
				chunks: [
					chunkOf({ role: "assistant" }),
					...texts.map((text) => chunkOf({ content: text })),
					chunkOf({}, "stop"),
				],
			});

			const cancelAfter = 1 + Math.floor(random() * 5);
			const source = new vscode.CancellationTokenSource();
			const request = await fuzzModel.sendRequest(
				[vscode.LanguageModelChatMessage.User(`/play:${name}`)],
				{},
				source.token
			);
			const parts: unknown[] = [];
			const startedWaiting = Date.now();
			let partsWhenCancelled = 0;
			try {
				for await (const part of request.stream) {
					parts.push(part);
					if (parts.length === cancelAfter) {
						partsWhenCancelled = parts.length;
						source.cancel();
					}
				}
			} catch (e) {
				assert.ok(
					e instanceof vscode.CancellationError || /cancel/i.test(String(e)),
					`expected a cancellation error, got ${String(e)}`
				);
			}
			const elapsed = Date.now() - startedWaiting;
			assert.ok(parts.length < texts.length / 2, `stream must stop early: got ${parts.length} of ${texts.length}`);
			// A couple of parts may already be in flight when the cancel lands;
			// a stream that keeps delivering beyond that ignored it.
			assert.ok(
				parts.length - partsWhenCancelled <= 3,
				`stream kept emitting after cancel: ${parts.length - partsWhenCancelled} extra parts`
			);
			assert.ok(elapsed < 20000, `stream must terminate promptly after cancel, took ${elapsed}ms`);
		});
	});
}

if (!BASE_URL) {
	suite("Docker LiteLLM stream fuzzer", () => {
		test("SKIPPED: LITELLM_DOCKER_BASE_URL not set; run via `bun run test:docker`", () => {});
	});
} else {
	// Through the proxy: LiteLLM re-serializes everything, so only shapes it
	// forwards faithfully are generated.
	fuzzSuite("Docker LiteLLM stream fuzzer (proxy)", false, BASE_URL, API_KEY);
	// Directly against the fake backend (the extension treats it as a LiteLLM
	// server via the /v1/models discovery fallback): adds the shapes the proxy
	// rejects, fuzzing the extension's leniency contract over a real socket.
	fuzzSuite("Docker LiteLLM stream fuzzer (direct)", true, FAKE_URL, "fake-key");
}
