import * as assert from "node:assert";
import * as fc from "fast-check";
import { type TextParseEvent, TextToolCallParser } from "../../provider/textToolCallParser";
import { resolveFuzzSeed } from "../fuzzStream";

const BEGIN = "<|tool_call_begin|>";
const ARG_BEGIN = "<|tool_call_argument_begin|>";
const ARG_END = "<|tool_call_argument_end|>";
const END = "<|tool_call_end|>";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 200;
// Pinned by default; FUZZ_SEED overrides so the nightly explores fresh seeds.
const SEED = resolveFuzzSeed();

type TextSegment = { kind: "text"; text: string };
type CallSegment = {
	kind: "call";
	name: string;
	index: number | undefined;
	args: string | undefined;
	argEnd: boolean;
};
type NoiseSegment = { kind: "noise"; text: string };
type Segment = TextSegment | CallSegment | NoiseSegment;

/** Call event stripped of its seq counter; text events coalesced. Comparable across parser instances. */
type NormalizedEvent =
	| { type: "text"; text: string }
	| { type: "call"; name: string | undefined; index: number | undefined; args: string };

const nameChar = fc.constantFrom(..."abgtXZ049_-.");
const toolName = fc.string({ unit: nameChar, minLength: 1, maxLength: 8 });

// Plain-text pieces never contain ">", so text regions cannot accidentally
// assemble a complete control token; complete strippable tokens are generated
// deliberately as noise segments instead. Partial-token fragments are fair
// game in text: surviving arbitrary chunk boundaries is the point.
const plainPiece = fc.string({ maxLength: 12 }).map((s) => s.replace(/>/g, ""));
const tokenFragmentPiece = fc.constantFrom(
	"<",
	"|",
	"<|",
	"<|t",
	"<|tool_",
	"<|tool_call_",
	"<|tool_call_begin|",
	"<|tool_call_argument_begin|",
	"<|tool_call_argument_end|",
	"<|tool_call_end|",
	"<|calls_section_begin|",
	"_section_end|"
);
const textSegment: fc.Arbitrary<Segment> = fc
	.array(fc.oneof(plainPiece, tokenFragmentPiece), { maxLength: 6 })
	.map((pieces) => ({ kind: "text", text: pieces.join("") }));

// Complete tokens the parser strips from visible text: section markers and
// stray end/argument tokens outside a call. They must vanish identically
// whether they arrive whole or split across chunk boundaries.
const sectionChar = fc.constantFrom(..."abgtXZ049_-");
const sectionName = fc.string({ unit: sectionChar, minLength: 1, maxLength: 8 });
const noiseSegment: fc.Arbitrary<Segment> = fc
	.oneof(
		sectionName.map((n) => `<|${n}_section_begin|>`),
		sectionName.map((n) => `<|${n}_section_end|>`),
		fc.constant(END),
		fc.constant(ARG_BEGIN),
		fc.constant(ARG_END)
	)
	.map((text) => ({ kind: "noise", text }));

// Argument strings must not contain "<|", or a control token inside the JSON
// could terminate the call early and break the segment-level oracle below.
const jsonArgs = fc.jsonValue({ maxDepth: 2 }).map((value) => JSON.stringify(value).split("<|").join("< |"));

const callSegment: fc.Arbitrary<Segment> = fc
	.record({
		name: toolName,
		index: fc.option(fc.nat({ max: 99 }), { nil: undefined }),
		args: fc.option(jsonArgs, { nil: undefined }),
		argEnd: fc.boolean(),
	})
	.map(({ name, index, args, argEnd }) => ({ kind: "call", name, index, args, argEnd: argEnd && args !== undefined }));

function renderSegment(segment: Segment): string {
	if (segment.kind === "text" || segment.kind === "noise") {
		return segment.text;
	}
	const header = segment.index === undefined ? segment.name : `${segment.name}:${segment.index}`;
	if (segment.args === undefined) {
		return BEGIN + header + END;
	}
	return BEGIN + header + ARG_BEGIN + segment.args + (segment.argEnd ? ARG_END : "") + END;
}

/** A segment list plus arbitrary cut positions over its rendered length. Duplicate cuts yield empty chunks. */
const scenario = fc.array(fc.oneof(textSegment, callSegment, noiseSegment), { maxLength: 8 }).chain((segments) => {
	const full = segments.map(renderSegment).join("");
	return fc.record({
		segments: fc.constant(segments),
		cuts: fc.array(fc.integer({ min: 0, max: full.length }), { maxLength: 20 }),
	});
});

function toChunks(full: string, cuts: number[]): string[] {
	const sorted = [...cuts].sort((a, b) => a - b);
	const chunks: string[] = [];
	let previous = 0;
	for (const cut of sorted) {
		chunks.push(full.slice(previous, cut));
		previous = cut;
	}
	chunks.push(full.slice(previous));
	return chunks;
}

function parseAll(chunks: string[]): TextParseEvent[] {
	const parser = new TextToolCallParser();
	const events: TextParseEvent[] = [];
	for (const chunk of chunks) {
		events.push(...parser.push(chunk).events);
	}
	const flushed = parser.flush();
	events.push(...flushed.events);
	assert.equal(flushed.provisionalCall, undefined, "Every generated call is terminated, so flush must not be mid-call");
	return events;
}

function normalize(events: TextParseEvent[]): NormalizedEvent[] {
	const normalized: NormalizedEvent[] = [];
	for (const event of events) {
		if (event.type === "text") {
			const last = normalized[normalized.length - 1];
			if (last?.type === "text") {
				last.text += event.text;
			} else if (event.text) {
				normalized.push({ type: "text", text: event.text });
			}
		} else {
			normalized.push({ type: "call", name: event.call.name, index: event.call.index, args: event.call.args });
		}
	}
	return normalized;
}

suite("provider/textToolCallParser chunking invariance properties", () => {
	test("arbitrary chunking yields the same event sequence as one-shot parsing", () => {
		fc.assert(
			fc.property(scenario, ({ segments, cuts }) => {
				const full = segments.map(renderSegment).join("");
				const whole = normalize(parseAll([full]));
				const chunked = normalize(parseAll(toChunks(full, cuts)));

				assert.deepStrictEqual(chunked, whole, `Chunked parse diverged for ${JSON.stringify({ full, cuts })}`);

				const calls = whole.filter((event) => event.type === "call");
				const expected = segments.filter((segment): segment is CallSegment => segment.kind === "call");
				assert.equal(calls.length, expected.length, "Every generated call must be recovered exactly once");
				for (let i = 0; i < expected.length; i++) {
					const call = calls[i];
					const source = expected[i];
					assert.ok(call?.type === "call" && source, "call/segment pairing");
					assert.equal(call.name, source.name);
					assert.equal(call.index, source.index);
					assert.equal(call.args, source.args ?? "{}");
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("strippable tokens split across chunk boundaries never leak into visible text", () => {
		const cases: Array<[string, string]> = [
			["a<|x_sec", "tion_begin|>b"],
			["a<|tool_call_e", "nd|>b"],
			["a<|tool_call_argument_e", "nd|>b"],
			["a<|tool_call_argument_end|", ">b"],
		];
		{
			const parser = new TextToolCallParser();
			const events = [
				...parser.push('<|tool_call_begin|>t<|tool_call_argument_begin|>{"x":1}<|tool_call_argument_e').events,
				...parser.push("nd|><|tool_call_end|>").events,
				...parser.flush().events,
			];
			const calls = events.filter((event) => event.type === "call");
			assert.strictEqual(calls.length, 1, "The call must survive an explicit argument-end token");
			assert.strictEqual(calls[0]?.type === "call" ? calls[0].call.args : "", '{"x":1}');
		}
		for (const [first, second] of cases) {
			const parser = new TextToolCallParser();
			const events = [...parser.push(first).events, ...parser.push(second).events, ...parser.flush().events];
			const text = events.map((event) => (event.type === "text" ? event.text : "")).join("");
			assert.strictEqual(text, "ab", `Split token leaked for ${JSON.stringify([first, second])}`);
			assert.ok(
				events.every((event) => event.type === "text"),
				"No call events expected"
			);
		}
	});

	test("truncated streams parse identically chunked and one-shot, including the provisional call", () => {
		const truncatedScenario = fc
			.array(fc.oneof(textSegment, callSegment, noiseSegment), { maxLength: 6 })
			.chain((segments) => {
				const full = segments.map(renderSegment).join("");
				return fc.record({
					full: fc.constant(full),
					cutOff: fc.integer({ min: 0, max: full.length }),
					cuts: fc.array(fc.integer({ min: 0, max: full.length }), { maxLength: 12 }),
				});
			});

		fc.assert(
			fc.property(truncatedScenario, ({ full, cutOff, cuts }) => {
				const truncated = full.slice(0, cutOff);
				const boundedCuts = cuts.map((c) => Math.min(c, truncated.length));

				const wholeParser = new TextToolCallParser();
				const wholeEvents = [...wholeParser.push(truncated).events];
				const wholeFlush = wholeParser.flush();
				wholeEvents.push(...wholeFlush.events);

				const chunkedParser = new TextToolCallParser();
				const chunkedEvents: TextParseEvent[] = [];
				for (const chunk of toChunks(truncated, boundedCuts)) {
					chunkedEvents.push(...chunkedParser.push(chunk).events);
				}
				const chunkedFlush = chunkedParser.flush();
				chunkedEvents.push(...chunkedFlush.events);

				assert.deepStrictEqual(
					normalize(chunkedEvents),
					normalize(wholeEvents),
					`Truncated parse diverged for ${JSON.stringify({ truncated, boundedCuts })}`
				);
				assert.deepStrictEqual(
					chunkedFlush.provisionalCall && { ...chunkedFlush.provisionalCall, seq: 0 },
					wholeFlush.provisionalCall && { ...wholeFlush.provisionalCall, seq: 0 },
					"Provisional call must not depend on chunking"
				);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("plain text free of complete control tokens round-trips byte-for-byte under arbitrary chunking", () => {
		const textScenario = fc.array(textSegment, { maxLength: 8 }).chain((segments) => {
			const full = segments.map(renderSegment).join("");
			return fc.record({
				full: fc.constant(full),
				cuts: fc.array(fc.integer({ min: 0, max: full.length }), { maxLength: 20 }),
			});
		});

		fc.assert(
			fc.property(textScenario, ({ full, cuts }) => {
				const events = parseAll(toChunks(full, cuts));
				assert.ok(
					events.every((event) => event.type === "text"),
					"Token-free text must never produce call events"
				);
				const reconstructed = events.map((event) => (event.type === "text" ? event.text : "")).join("");
				assert.equal(reconstructed, full);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});
