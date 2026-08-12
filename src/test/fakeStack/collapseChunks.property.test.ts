import * as assert from "node:assert";
import * as fc from "fast-check";
import type { FuzzEvent } from "../fuzzCorpus";
import {
	makePropertyEvent,
	makeTailEvent,
	newGeneratorState,
	PROPERTY_EVENT_KIND_WEIGHTS,
	resolveFuzzSeed,
	TAIL_EVENT_KINDS,
} from "../fuzzStream";
import { expectDefined } from "../pureHelpers";
import { collapseChunks } from "../scenarios";

/**
 * Property coverage for collapseChunks, the fake stack's own non-streaming
 * collapse: fake-openai-server.ts answers stream:false requests with it, and
 * no docker suite exercises that path. These properties keep it honest, so a
 * future docker test of stream:false can trust the fake backend's answer
 * instead of re-deriving it. Inputs come from the same fuzz generators the
 * stream suites use (fuzzStream.ts), so the collapse sees the exact chunk
 * shapes the fake stack streams.
 */

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 200;
const SEED = resolveFuzzSeed();

const seedArb = fc.integer({ min: 0, max: 0x7fffffff });
// Kind frequencies mirror the docker fuzzer's weights, matching the stream property suites.
const kindArb = fc.oneof(
	{ withCrossShrink: true },
	...PROPERTY_EVENT_KIND_WEIGHTS.map((entry) => ({ arbitrary: fc.constant(entry.kind), weight: entry.weight }))
);
const eventSpecArb = fc.tuple(kindArb, seedArb);
const tailSpecArb = fc.option(fc.tuple(fc.constantFrom(...TAIL_EVENT_KINDS), seedArb), { nil: undefined });

/** A whole stream as (kind, seed) coordinates, rebuilt deterministically per run. */
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
 * Streams built only from kinds whose tool calls ride the delta channel with
 * sequential numeric indices (text events are inert padding). For these,
 * every flattened ExpectedToolCall maps 1:1 onto a collapsed tool_calls entry
 * whose id is `call_fuzz_<position>`, because the generators assign indices
 * from one shared counter in tools[] order. Inline-channel kinds are excluded
 * on purpose: collapseChunks does not parse control tokens out of content, so
 * inline calls stay in the text (the text property covers them there).
 */
const deltaToolEventsArb: fc.Arbitrary<FuzzEvent[]> = fc
	.tuple(
		fc.array(fc.tuple(fc.constantFrom("text" as const, "delta-tool" as const, "interleaved-tools" as const), seedArb), {
			maxLength: 6,
		}),
		seedArb
	)
	.map(([specs, lastSeed]) => {
		const state = newGeneratorState(true);
		const events = specs.map(([kind, kindSeed]) => makePropertyEvent(kind, kindSeed, state));
		events.push(makePropertyEvent("delta-tool", lastSeed, state));
		return events;
	});

interface CollapsedChoice {
	index: number;
	message: {
		role: string;
		content: string;
		refusal?: string;
		tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
	};
	finish_reason: string;
}

/** Pin the envelope (a chat.completion body with exactly one choice) and hand back that choice. */
function soleChoiceOf(collapsed: Record<string, unknown>): CollapsedChoice {
	assert.strictEqual(collapsed.object, "chat.completion", "collapsed body is not a chat.completion");
	const choices = collapsed.choices as CollapsedChoice[];
	assert.ok(Array.isArray(choices), "collapsed body has no choices array");
	assert.strictEqual(choices.length, 1, "collapsed body must carry exactly one choice");
	return expectDefined(choices[0]);
}

/**
 * The content oracle: the in-order concatenation of every string delta.content
 * across all chunks and choices. Deliberately re-derived from the raw chunks
 * (not from FuzzEvent.text) because collapseChunks must keep inline tool
 * control tokens and skip non-string content like structured arrays.
 */
function concatenatedContentOf(chunks: unknown[]): string {
	let content = "";
	for (const chunk of chunks) {
		if (typeof chunk !== "object" || chunk === null) {
			continue;
		}
		const choices = (chunk as Record<string, unknown>).choices;
		if (!Array.isArray(choices)) {
			continue;
		}
		for (const choice of choices) {
			if (typeof choice !== "object" || choice === null) {
				continue;
			}
			const delta = (choice as Record<string, unknown>).delta;
			if (typeof delta !== "object" || delta === null) {
				continue;
			}
			const value = (delta as Record<string, unknown>).content;
			if (typeof value === "string") {
				content += value;
			}
		}
	}
	return content;
}

/** Chunks a generated event stream would send, without assemble()'s role/finish framing. */
function chunksOf(events: FuzzEvent[]): unknown[] {
	return events.flatMap((event) => event.chunks);
}

suite("fakeStack/collapseChunks properties", () => {
	test("collapsed content is the in-order concatenation of every string delta.content", function () {
		this.timeout(Math.max(120000, NUM_RUNS * 50));
		fc.assert(
			fc.property(eventsArb, (events) => {
				const chunks = chunksOf(events);
				const choice = soleChoiceOf(collapseChunks(chunks));
				assert.strictEqual(choice.message.role, "assistant");
				assert.strictEqual(choice.message.content, concatenatedContentOf(chunks), "content diverged");
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("delta-channel tool calls reassemble in index order with ids kept and arguments concatenated", function () {
		this.timeout(Math.max(120000, NUM_RUNS * 50));
		fc.assert(
			fc.property(deltaToolEventsArb, (events) => {
				// This expectation leans on a generator guarantee: every event kind
				// used here emits its first call's frames before its second's, so
				// collapseChunks's Map insertion order matches both the numeric
				// index order and the flattened tools[] position. A generator that
				// ever emits a higher index first breaks this oracle, not the code.
				const expected = events
					.flatMap((event) => event.tools ?? [])
					.map((call, position) => ({
						id: `call_fuzz_${position}`,
						type: "function",
						function: { name: call.name, arguments: JSON.stringify(call.args) },
					}));
				const choice = soleChoiceOf(collapseChunks(chunksOf(events)));
				assert.deepStrictEqual(choice.message.tool_calls, expected, "tool calls diverged");
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("last string finish_reason and last non-null usage win", function () {
		this.timeout(Math.max(120000, NUM_RUNS * 50));
		const usageArb = fc.oneof(
			fc.constant(undefined),
			fc.constant(null),
			fc.record({ prompt_tokens: fc.nat({ max: 1000 }), completion_tokens: fc.nat({ max: 1000 }) })
		);
		const finishArb = fc.option(fc.constantFrom("stop", "length", "tool_calls", "content_filter"), { nil: null });
		fc.assert(
			fc.property(fc.array(fc.tuple(finishArb, usageArb), { maxLength: 10 }), (trailers) => {
				const chunks = trailers.map(([finish, usage]) => ({
					id: "chatcmpl-fuzz",
					object: "chat.completion.chunk",
					choices: [{ index: 0, delta: {}, finish_reason: finish }],
					...(usage !== undefined ? { usage } : {}),
				}));
				const collapsed = collapseChunks(chunks);
				const choice = soleChoiceOf(collapsed);

				// Pinning what the code does: every *string* finish_reason overwrites the
				// previous one (so the last string wins), nulls are ignored, and the
				// default with no string at all is "stop".
				const strings = trailers.flatMap(([finish]) => (finish === null ? [] : [finish]));
				assert.strictEqual(choice.finish_reason, strings[strings.length - 1] ?? "stop", "finish_reason diverged");

				// Usage: the last value that is neither undefined nor null wins; a chunk
				// with usage: null is ignored, and with no usage at all the key is absent.
				const usages = trailers.map(([, usage]) => usage).filter((usage) => usage !== undefined && usage !== null);
				if (usages.length > 0) {
					assert.deepStrictEqual(collapsed.usage, usages[usages.length - 1], "usage diverged");
				} else {
					assert.ok(!("usage" in collapsed), "usage key must be absent when no chunk carried one");
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("never throws on arbitrary JSON chunk lists and always returns the one-choice envelope", function () {
		this.timeout(Math.max(120000, NUM_RUNS * 50));
		fc.assert(
			fc.property(fc.array(fc.jsonValue({ maxDepth: 3 }), { maxLength: 12 }), (junk) => {
				const collapsed = collapseChunks(junk);
				const choice = soleChoiceOf(collapsed);
				assert.strictEqual(typeof choice.message.content, "string");
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});
