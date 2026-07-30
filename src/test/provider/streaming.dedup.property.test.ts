import * as assert from "node:assert";
import * as fc from "fast-check";
import * as vscode from "vscode";
import { StreamProcessor } from "../../provider/streaming";
import { parseChunk } from "../../provider/wire";
import type { FuzzEvent } from "../fuzzCorpus";
import {
	assemble,
	chunkOf,
	makePropertyEvent,
	makeTailEvent,
	newGeneratorState,
	PROPERTY_EVENT_KIND_WEIGHTS,
	resolveFuzzSeed,
	TAIL_EVENT_KINDS,
} from "../fuzzStream";

/**
 * In-process property fuzzing of StreamProcessor's tool-call accounting: the
 * cross-channel max(N, M) dedup, inline-replay suppression, and index
 * normalization. The docker fuzzer covers the same states through a real
 * socket but only runs where docker does; this suite runs on every PR.
 *
 * Chunks are narrowed through parseChunk first, so the input is exactly what
 * the SSE transport would deliver; framing itself is fuzzed separately in
 * streaming.sse.property.test.ts. A shrunk counterexample here is a
 * serializable FuzzEvent[]: pin it in fuzzCorpus.ts when it reproduces
 * through the docker direct target, otherwise as an example test.
 */

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 200;
const SEED = resolveFuzzSeed();

function idSource(): { next(): number } {
	let count = 0;
	return { next: () => ++count };
}

interface RunResult {
	parts: vscode.LanguageModelResponsePart[];
}

/**
 * Drive every assembled chunk through parseChunk and processDelta, mirroring
 * the transport loop's delta handling (its in-band error-frame guard sits a
 * layer above and is covered by unit and docker tests, not here).
 */
function runChunks(chunks: unknown[]): RunResult {
	const processor = new StreamProcessor(idSource(), () => {});
	const parts: vscode.LanguageModelResponsePart[] = [];
	const progress = { report: (p: vscode.LanguageModelResponsePart) => parts.push(p) };
	for (const raw of chunks) {
		const chunk = parseChunk(raw);
		if (chunk) {
			processor.processDelta(chunk, progress);
		}
	}
	return { parts };
}

function visibleTextOf(parts: vscode.LanguageModelResponsePart[]): string {
	return parts
		.filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart)
		.map((p) => p.value)
		.join("");
}

function toolCallsOf(parts: vscode.LanguageModelResponsePart[]): vscode.LanguageModelToolCallPart[] {
	return parts.filter(
		(p): p is vscode.LanguageModelToolCallPart => p instanceof vscode.LanguageModelToolCallPart
	) as vscode.LanguageModelToolCallPart[];
}

/** Comparable rendering of a part list; ids stay in (fresh processors mint them deterministically). */
function descriptorsOf(parts: vscode.LanguageModelResponsePart[]): unknown[] {
	return parts.map((p) => {
		if (p instanceof vscode.LanguageModelTextPart) {
			return { t: "text", v: p.value };
		}
		if (p instanceof vscode.LanguageModelToolCallPart) {
			return { t: "tool", id: p.callId, name: p.name, input: p.input };
		}
		return { t: "other", v: JSON.stringify(p) };
	});
}

const seedArb = fc.integer({ min: 0, max: 0x7fffffff });
// Kind frequencies mirror the docker fuzzer's weights, so both fuzzers explore the same shape mix;
// cross-shrink lets counterexamples collapse toward the first (simplest) kind.
const kindArb = fc.oneof(
	{ withCrossShrink: true },
	...PROPERTY_EVENT_KIND_WEIGHTS.map((entry) => ({ arbitrary: fc.constant(entry.kind), weight: entry.weight }))
);
const eventSpecArb = fc.tuple(kindArb, seedArb);
const tailSpecArb = fc.option(fc.tuple(fc.constantFrom(...TAIL_EVENT_KINDS), seedArb), { nil: undefined });

/**
 * A whole stream as (kind, seed) coordinates: fast-check shrinks by dropping
 * events and simplifying seeds, and each list rebuilds deterministically.
 */
const eventsArb: fc.Arbitrary<FuzzEvent[]> = fc
	.tuple(fc.array(eventSpecArb, { minLength: 1, maxLength: 8 }), tailSpecArb)
	.map(([specs, tail]) => {
		const state = newGeneratorState(true);
		const events = specs.map(([kind, kindSeed]) => makePropertyEvent(kind, kindSeed, state));
		if (tail) {
			events.push(makeTailEvent(tail[0], tail[1], state));
		}
		return events;
	});

/**
 * Streams that always end in one delta-channel tool call (and never a tail),
 * so the index-invariance property has a numeric index to rewrite in every
 * run instead of comparing two byte-identical streams.
 */
const eventsWithDeltaArb: fc.Arbitrary<FuzzEvent[]> = fc
	.tuple(fc.array(eventSpecArb, { maxLength: 7 }), seedArb)
	.map(([specs, deltaSeed]) => {
		const state = newGeneratorState(true);
		const events = specs.map(([kind, kindSeed]) => makePropertyEvent(kind, kindSeed, state));
		events.push(makePropertyEvent("delta-tool", deltaSeed, state));
		return events;
	});

function inlineCallChunk(name: string, index: number, argText: string): Record<string, unknown> {
	return chunkOf({
		content: `<|tool_call_begin|>${name}:${index}<|tool_call_argument_begin|>${argText}<|tool_call_end|>`,
	});
}

function deltaCallChunk(name: string, index: number, argText: string): Record<string, unknown> {
	return chunkOf({
		tool_calls: [{ index, id: `call_fuzz_${index}`, type: "function", function: { name, arguments: argText } }],
	});
}

suite("provider/streaming dedup properties", () => {
	test("generated streams match the oracle: text verbatim, each call exactly once, ids unique", function () {
		this.timeout(Math.max(120000, NUM_RUNS * 50));
		fc.assert(
			fc.property(eventsArb, (events) => {
				const assembled = assemble(events);
				const { parts } = runChunks(assembled.chunks);

				assert.strictEqual(visibleTextOf(parts), assembled.expectedText, "text diverged");

				const calls = toolCallsOf(parts);
				assert.strictEqual(calls.length, assembled.expectedToolCalls.length, "tool call count diverged");
				const actualSorted = calls
					.map((c) => ({ name: c.name, args: c.input as Record<string, unknown> }))
					.sort((a, b) => Number(a.args.seq) - Number(b.args.seq));
				assert.deepStrictEqual(actualSorted, assembled.expectedToolCalls, "tool calls diverged");

				const ids = calls.map((c) => c.callId);
				assert.strictEqual(new Set(ids).size, ids.length, `duplicate tool call IDs: ${ids.join(", ")}`);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("N delta plus M inline copies of one call emit exactly max(N, M) in any interleaving", function () {
		this.timeout(Math.max(120000, NUM_RUNS * 50));
		const copiesArb = fc.tuple(fc.integer({ min: 1, max: 3 }), fc.integer({ min: 0, max: 3 })).chain(([n, m]) => {
			const argText = JSON.stringify({ seq: 0, city: "berlin" });
			const deltas = Array.from({ length: n }, (_, i) => deltaCallChunk("get_weather", i, argText));
			// Distinct inline index headers, so inline-replay dedup stays out of
			// the way and the pure cross-channel rule is what gets measured.
			const inlines = Array.from({ length: m }, (_, j) => inlineCallChunk("get_weather", 100 + j, argText));
			const all = [...deltas, ...inlines];
			return fc
				.shuffledSubarray(all, { minLength: all.length, maxLength: all.length })
				.map((shuffled) => ({ n, m, chunks: shuffled }));
		});
		fc.assert(
			fc.property(copiesArb, ({ n, m, chunks }) => {
				const { parts } = runChunks([chunkOf({ role: "assistant" }), ...chunks, chunkOf({}, "tool_calls")]);
				const calls = toolCallsOf(parts);
				assert.strictEqual(calls.length, Math.max(n, m), `expected max(${n}, ${m}) calls, got ${calls.length}`);
				for (const call of calls) {
					assert.strictEqual(call.name, "get_weather");
				}
				const ids = calls.map((c) => c.callId);
				assert.strictEqual(new Set(ids).size, ids.length, "duplicate tool call IDs");
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("inline replays of one indexed call collapse, so N delta copies plus R replays emit max(N, 1)", function () {
		this.timeout(Math.max(120000, NUM_RUNS * 50));
		const replaysArb = fc.tuple(fc.integer({ min: 0, max: 3 }), fc.integer({ min: 1, max: 3 })).chain(([n, r]) => {
			const argText = JSON.stringify({ seq: 0, city: "oslo" });
			const deltas = Array.from({ length: n }, (_, i) => deltaCallChunk("search_docs", i, argText));
			// All replays carry the same ":42" header: only the first counts.
			const replays = Array.from({ length: r }, () => inlineCallChunk("search_docs", 42, argText));
			const all = [...deltas, ...replays];
			return fc
				.shuffledSubarray(all, { minLength: all.length, maxLength: all.length })
				.map((shuffled) => ({ n, chunks: shuffled }));
		});
		fc.assert(
			fc.property(replaysArb, ({ n, chunks }) => {
				const { parts } = runChunks([chunkOf({ role: "assistant" }), ...chunks, chunkOf({}, "tool_calls")]);
				const calls = toolCallsOf(parts);
				assert.strictEqual(calls.length, Math.max(n, 1), `expected max(${n}, 1) calls, got ${calls.length}`);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("numeric and numeric-string tool-call indices produce identical output", function () {
		this.timeout(Math.max(120000, NUM_RUNS * 50));
		fc.assert(
			fc.property(eventsWithDeltaArb, (events) => {
				const assembled = assemble(events);
				const baseline = runChunks(assembled.chunks);
				const stringified = runChunks(withStringIndices(assembled.chunks));
				assert.deepStrictEqual(
					descriptorsOf(stringified.parts),
					descriptorsOf(baseline.parts),
					"string indices diverged from numeric"
				);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});

/** The same chunks with every numeric tool_calls[].index rendered as a string (normalizeToolCallIndex law). */
function withStringIndices(chunks: unknown[]): unknown[] {
	return chunks.map((chunk) => {
		const cloned = structuredClone(chunk) as Record<string, unknown>;
		const choices = cloned?.choices;
		if (!Array.isArray(choices)) {
			return cloned;
		}
		for (const choice of choices) {
			const delta = (choice as Record<string, unknown>)?.delta as Record<string, unknown> | undefined;
			const toolCalls = delta?.tool_calls;
			if (!Array.isArray(toolCalls)) {
				continue;
			}
			for (const tc of toolCalls) {
				const record = tc as Record<string, unknown>;
				if (typeof record.index === "number") {
					record.index = String(record.index);
				}
			}
		}
		return cloned;
	});
}
