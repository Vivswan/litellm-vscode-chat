import type { ExpectedToolCall, FuzzEvent } from "./fuzzCorpus";
import { fuzzSeedPrefix } from "./fuzzSeed";
import { expectDefined } from "./testUtils";

/**
 * Shared stream-fuzzing machinery: the event generators, the assembly oracle,
 * and the seed resolver. Two consumers drive it: the docker fuzzer
 * (docker-fuzz.test.ts) feeds generated streams through a real LiteLLM proxy,
 * and the in-process property suites (streaming.dedup.property.test.ts,
 * streaming.sse.property.test.ts) drive StreamProcessor directly. Keeping the
 * generators and the oracle in one place means a shape either suite finds is
 * expressible as a FuzzEvent[] corpus entry for the other.
 */

/**
 * The seed for fast-check property suites: FUZZ_SEED when set (so the nightly
 * workflow can explore fresh inputs and its issue carries the exact repro),
 * otherwise a pinned default so PR and pre-commit runs stay deterministic.
 * Logged once per process; the nightly failure report greps this line, whose
 * format is owned by fuzzSeed.ts and pinned by fuzzSeed.test.ts.
 */
let loggedSeed = false;
export function resolveFuzzSeed(): number {
	const raw = process.env.FUZZ_SEED?.trim() ?? "";
	const parsed = Number(raw);
	const seed = raw !== "" && Number.isFinite(parsed) ? parsed >>> 0 : 20260726;
	if (!loggedSeed) {
		loggedSeed = true;
		console.log(fuzzSeedPrefix(seed));
	}
	return seed;
}

/** Deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
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
export const UNICODE_WORDS = ["日本語", "café", "émoji✨", "مرحبا", "🚀🧠"];
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

export function chunkOf(delta: Record<string, unknown>, finishReason?: string): Record<string, unknown> {
	return {
		id: "chatcmpl-fuzz",
		object: "chat.completion.chunk",
		choices: [{ index: 0, delta, ...(finishReason ? { finish_reason: finishReason } : {}) }],
	};
}

// ── Event generators ─────────────────────────────────────────────────────────

export interface GeneratorState {
	random: () => number;
	toolIndex: number;
	citationIndex: number;
	/** Direct mode may split surrogate pairs across chunks; the proxy cannot take those. */
	allowSurrogateSplit: boolean;
}

export function newGeneratorState(allowSurrogateSplit: boolean): GeneratorState {
	return {
		// Loudly unseeded: every construction path must install its own PRNG
		// (makePropertyEvent/makeTailEvent reseed per event; generateEvents
		// builds its own state), so a silent fixed stream cannot slip in.
		random: () => {
			throw new Error("GeneratorState.random is unseeded; build events via makePropertyEvent/makeTailEvent");
		},
		toolIndex: 0,
		citationIndex: 0,
		allowSurrogateSplit,
	};
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

/**
 * Reasoning-only streams are legitimate generator output: every fuzz consumer
 * runs in the pinned extension-host build, which exposes
 * LanguageModelThinkingPart, so reasoning emits as thinking parts instead of
 * hitting the reasoning-only empty-response error a ctor-less host throws.
 */
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

export function generateEvents(random: () => number, directMode: boolean): FuzzEvent[] {
	const state: GeneratorState = { random, toolIndex: 0, citationIndex: 0, allowSurrogateSplit: directMode };
	const table = PROPERTY_EVENT_KIND_WEIGHTS.filter((entry) => directMode || !entry.directOnly);
	const totalWeight = table.reduce((sum, entry) => sum + entry.weight, 0);

	const eventCount = 1 + Math.floor(random() * 7);
	const events: FuzzEvent[] = [];
	for (let i = 0; i < eventCount; i++) {
		let roll = random() * totalWeight;
		for (const entry of table) {
			roll -= entry.weight;
			if (roll <= 0) {
				events.push(buildEvent(entry.kind, state));
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

// ── Deterministic per-kind construction for the fast-check property suites ───

/**
 * The single source of event kinds and their weights: generateEvents draws
 * from it (direct mode admits the directOnly rows, matching the docker
 * fuzzer's historical distribution exactly), the property suites mirror it
 * through fc.oneof, and the PropertyEventKind union derives from it so a new
 * kind cannot exist without a weight row. Everything the direct docker
 * target generates is valid in-process too: StreamProcessor is the same code
 * with no proxy in front to reject lenient or malformed shapes.
 */
export const PROPERTY_EVENT_KIND_WEIGHTS = [
	{ kind: "text", weight: 26, directOnly: false },
	{ kind: "delta-tool", weight: 12, directOnly: false },
	{ kind: "inline-tool", weight: 9, directOnly: false },
	{ kind: "duplicate-tool", weight: 6, directOnly: false },
	{ kind: "interleaved-tools", weight: 6, directOnly: false },
	{ kind: "same-channel-twins", weight: 5, directOnly: false },
	{ kind: "inline-no-index", weight: 5, directOnly: false },
	{ kind: "citation", weight: 6, directOnly: false },
	{ kind: "reasoning", weight: 9, directOnly: false },
	{ kind: "junk-fields", weight: 4, directOnly: false },
	{ kind: "refusal", weight: 5, directOnly: true },
	{ kind: "malformed", weight: 5, directOnly: true },
	{ kind: "lenient-delta-tool", weight: 5, directOnly: true },
	{ kind: "structured-content", weight: 4, directOnly: true },
] as const;
export type PropertyEventKind = (typeof PROPERTY_EVENT_KIND_WEIGHTS)[number]["kind"];

export const TAIL_EVENT_KINDS = ["unterminated-inline-tail", "truncated-token-tail"] as const;
export type TailEventKind = (typeof TAIL_EVENT_KINDS)[number];

function buildEvent(kind: PropertyEventKind, state: GeneratorState): FuzzEvent {
	switch (kind) {
		case "text":
			return textEvent(state);
		case "delta-tool":
			return deltaToolEvent(state);
		case "inline-tool":
			return inlineToolEvent(state);
		case "duplicate-tool":
			return duplicateToolEvent(state);
		case "interleaved-tools":
			return interleavedToolsEvent(state);
		case "same-channel-twins":
			return sameChannelTwinsEvent(state);
		case "inline-no-index":
			return inlineNoIndexEvent(state);
		case "citation":
			return citationEvent(state);
		case "reasoning":
			return reasoningEvent(state);
		case "junk-fields":
			return junkFieldsEvent();
		case "refusal":
			return refusalEvent(state);
		case "malformed":
			return malformedEvent(state);
		case "lenient-delta-tool":
			return lenientDeltaToolEvent(state);
		case "structured-content":
			return structuredContentEvent(state);
	}
}

/**
 * Build one event of the given kind from its own seed, sharing `state` so
 * tool and citation indices stay sequential across the whole stream. Kind and
 * seed are the shrinkable coordinates: fast-check drops whole events and
 * simplifies seeds while this stays a pure function of (kind, seed, position).
 */
export function makePropertyEvent(kind: PropertyEventKind, seed: number, state: GeneratorState): FuzzEvent {
	state.random = mulberry32(seed);
	return buildEvent(kind, state);
}

export function makeTailEvent(kind: TailEventKind, seed: number, state: GeneratorState): FuzzEvent {
	state.random = mulberry32(seed);
	return kind === "unterminated-inline-tail" ? unterminatedInlineTail(state) : truncatedTokenTail(state);
}

// ── Assembly: events to chunks plus the exact expected outcome ───────────────

export interface AssembledStream {
	chunks: unknown[];
	expectedText: string;
	expectedToolCalls: ExpectedToolCall[];
	/**
	 * Thinking text the stream must surface as thinking parts, joined in
	 * stream order. Empty when no event declares an expectation, in which case
	 * the oracle skips the thinking assertion (the random generators do not
	 * declare one; deterministic corpus entries do, so deleting reasoning
	 * extraction fails their replay instead of resolving quietly empty).
	 */
	expectedThinking: string;
}

export function assemble(events: FuzzEvent[]): AssembledStream {
	const chunks: unknown[] = [chunkOf({ role: "assistant" })];
	const expectedToolCalls: ExpectedToolCall[] = [];
	const citations = new Map<string, string>();
	let expectedText = "";
	let expectedThinking = "";
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
		if (event.thinking) {
			expectedThinking += event.thinking;
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
	return { chunks, expectedText, expectedToolCalls, expectedThinking };
}
