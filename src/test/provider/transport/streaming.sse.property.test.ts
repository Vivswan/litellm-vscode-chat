import * as assert from "node:assert";
import * as fc from "fast-check";
import * as vscode from "vscode";
import { StreamProcessor } from "../../../provider/transport/streaming";
import type { FuzzEvent } from "../../fuzzCorpus";
import {
	assemble,
	chunkOf,
	makePropertyEvent,
	newGeneratorState,
	PROPERTY_EVENT_KIND_WEIGHTS,
	resolveFuzzSeed,
	UNICODE_WORDS,
} from "../../fuzzStream";

/**
 * Byte-level fuzzing of the SSE transport in processStreamingResponse: line
 * splitting, [DONE] handling, and the log-and-skip contract for malformed
 * lines. The docker fuzzer cannot reach this layer (the LiteLLM proxy
 * re-frames SSE itself), so framing is fuzzed here, in-process, on every PR.
 *
 * A shrunk counterexample here is a byte layout, not a FuzzEvent[], so it
 * cannot go in fuzzCorpus.ts: pin regressions as example tests in the SSE
 * transport section of streaming.test.ts instead.
 */

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 200;
const SEED = resolveFuzzSeed();

function idSource(): { next(): number } {
	let count = 0;
	return { next: () => ++count };
}

function byteStream(byteChunks: Uint8Array[]): ReadableStream<Uint8Array> {
	let i = 0;
	return new ReadableStream({
		pull(controller) {
			if (i < byteChunks.length) {
				controller.enqueue(expectArrayItem(byteChunks, i++));
			} else {
				controller.close();
			}
		},
	});
}

function expectArrayItem(chunks: Uint8Array[], index: number): Uint8Array {
	const item = chunks[index];
	assert.ok(item !== undefined);
	return item;
}

interface RunResult {
	parts: vscode.LanguageModelResponsePart[];
	malformedLogs: number;
	/** The data payload of each malformed-line log, for the classification-only assertion. */
	malformedPayloads: unknown[];
}

async function runBytes(byteChunks: Uint8Array[]): Promise<RunResult> {
	let malformedLogs = 0;
	const malformedPayloads: unknown[] = [];
	const processor = new StreamProcessor(idSource(), (message, data) => {
		if (message === "Skipping malformed SSE line") {
			malformedLogs++;
			malformedPayloads.push(data);
		}
	});
	const parts: vscode.LanguageModelResponsePart[] = [];
	const progress = { report: (p: vscode.LanguageModelResponsePart) => parts.push(p) };
	await processor.processStreamingResponse(
		byteStream(byteChunks),
		progress,
		new vscode.CancellationTokenSource().token
	);
	return { parts, malformedLogs, malformedPayloads };
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

/** One `data: <json>` line per chunk; the terminator is appended by the caller so tails can vary. */
function renderLines(chunks: unknown[]): string[] {
	return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`);
}

function encode(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

/** Cut the byte array at the given offsets, which may fall inside multi-byte UTF-8 sequences. */
function cutAt(bytes: Uint8Array, offsets: number[]): Uint8Array[] {
	const sorted = Array.from(new Set(offsets.map((o) => (bytes.length > 1 ? 1 + (o % (bytes.length - 1)) : 0)))).sort(
		(a, b) => a - b
	);
	const pieces: Uint8Array[] = [];
	let start = 0;
	for (const offset of sorted) {
		if (offset > start) {
			pieces.push(bytes.slice(start, offset));
			start = offset;
		}
	}
	pieces.push(bytes.slice(start));
	return pieces;
}

const seedArb = fc.integer({ min: 0, max: 0x7fffffff });

/**
 * Streams for framing properties: generated events with a fixed multi-byte
 * unicode text event up front, so every byte layout contains UTF-8 sequences
 * a cut can split. Tails are omitted here on purpose - their contract is
 * end-of-stream handling, and the framing properties re-terminate streams in
 * ways that would change what "end of stream" means for a tail event.
 */
const framingEventsArb: fc.Arbitrary<FuzzEvent[]> = fc
	.array(
		fc.tuple(
			// Kind frequencies mirror the docker fuzzer's weights, so both fuzzers explore the same shape mix;
			// cross-shrink lets counterexamples collapse toward the first (simplest) kind.
			fc.oneof(
				{ withCrossShrink: true },
				...PROPERTY_EVENT_KIND_WEIGHTS.map((entry) => ({ arbitrary: fc.constant(entry.kind), weight: entry.weight }))
			),
			seedArb
		),
		{ minLength: 1, maxLength: 6 }
	)
	.map((specs) => {
		const state = newGeneratorState(true);
		const unicodeText = `${UNICODE_WORDS.join(" ")} `;
		const lead: FuzzEvent = { label: "text", text: unicodeText, chunks: [chunkOf({ content: unicodeText })] };
		return [lead, ...specs.map(([kind, kindSeed]) => makePropertyEvent(kind, kindSeed, state))];
	});

/** Lines the splitter must ignore or log-and-skip; none may parse into a chunk or read as [DONE]. */
const INERT_LINES = [": comment", "event: message", "id: 7", "retry: 100", "", 'data:{"no":"space"}'];
const MALFORMED_DATA_LINES = ["data: {oops", "data: null", "data: [1,2", "data: 42", 'data: "text"', "data: [DONE ]"];

suite("provider/streaming SSE framing properties", () => {
	test("a well-framed stream matches the oracle: text verbatim, each call exactly once, ids unique", async function () {
		this.timeout(Math.max(120000, NUM_RUNS * 50));
		await fc.assert(
			fc.asyncProperty(framingEventsArb, async (events) => {
				const assembled = assemble(events);
				const rendered = `${[...renderLines(assembled.chunks), "data: [DONE]"].join("\n")}\n`;
				const { parts } = await runBytes([encode(rendered)]);

				const text = parts
					.filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart)
					.map((p) => p.value)
					.join("");
				assert.strictEqual(text, assembled.expectedText, "text diverged");

				const calls = parts.filter(
					(p): p is vscode.LanguageModelToolCallPart => p instanceof vscode.LanguageModelToolCallPart
				);
				assert.strictEqual(calls.length, assembled.expectedToolCalls.length, "tool call count diverged");
				const actualSorted = calls
					.map((c) => ({ name: c.name, args: c.input as Record<string, unknown> }))
					.sort((a, b) => Number(a.args.seq) - Number(b.args.seq));
				assert.deepStrictEqual(actualSorted, assembled.expectedToolCalls, "tool calls diverged");
				const ids = calls.map((c) => c.callId);
				assert.strictEqual(new Set(ids).size, ids.length, "duplicate tool call IDs");
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("re-chunking the bytes anywhere, including inside UTF-8 sequences, changes nothing", async function () {
		this.timeout(Math.max(120000, NUM_RUNS * 50));
		await fc.assert(
			fc.asyncProperty(
				framingEventsArb,
				fc.array(fc.nat({ max: 0xffff }), { maxLength: 12 }),
				async (events, offsets) => {
					const assembled = assemble(events);
					const rendered = `${[...renderLines(assembled.chunks), "data: [DONE]"].join("\n")}\n`;
					const bytes = encode(rendered);
					const oneShot = await runBytes([bytes]);
					const chunked = await runBytes(cutAt(bytes, offsets));
					assert.deepStrictEqual(
						descriptorsOf(chunked.parts),
						descriptorsOf(oneShot.parts),
						"re-chunked stream diverged"
					);
				}
			),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("CRLF line endings produce the same parts as LF", async function () {
		this.timeout(Math.max(120000, NUM_RUNS * 50));
		await fc.assert(
			fc.asyncProperty(framingEventsArb, async (events) => {
				const assembled = assemble(events);
				const lines = [...renderLines(assembled.chunks), "data: [DONE]"];
				const lf = await runBytes([encode(`${lines.join("\n")}\n`)]);
				const crlf = await runBytes([encode(`${lines.join("\r\n")}\r\n`)]);
				assert.deepStrictEqual(descriptorsOf(crlf.parts), descriptorsOf(lf.parts), "CRLF diverged from LF");
				assert.strictEqual(crlf.malformedLogs, lf.malformedLogs, "CRLF framing must not add malformed-line logs");
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("injected junk lines never change the parts, and each bad data line logs exactly one skip", async function () {
		this.timeout(Math.max(120000, NUM_RUNS * 50));
		const junkArb = fc.array(
			fc.tuple(fc.constantFrom(...INERT_LINES, ...MALFORMED_DATA_LINES), fc.nat({ max: 0xffff })),
			{ minLength: 1, maxLength: 6 }
		);
		await fc.assert(
			fc.asyncProperty(framingEventsArb, junkArb, async (events, junk) => {
				const assembled = assemble(events);
				const lines = [...renderLines(assembled.chunks), "data: [DONE]"];
				const base = await runBytes([encode(`${lines.join("\n")}\n`)]);

				const injected = [...lines];
				for (const [line, position] of junk) {
					injected.splice(position % (injected.length + 1), 0, line);
				}
				const withJunk = await runBytes([encode(`${injected.join("\n")}\n`)]);

				assert.deepStrictEqual(descriptorsOf(withJunk.parts), descriptorsOf(base.parts), "junk changed the parts");
				const injectedDataLines = junk.filter(([line]) => line.startsWith("data: ")).length;
				assert.strictEqual(
					withJunk.malformedLogs - base.malformedLogs,
					injectedDataLines,
					"each injected bad data line must log exactly one skip"
				);
				// The log buffer feeds public issue reports: malformed-line logs must
				// carry classifications only, never the line or a parser message that
				// embeds an excerpt of it.
				for (const payload of withJunk.malformedPayloads) {
					const record = payload as Record<string, unknown>;
					assert.ok(record !== null && typeof record === "object", "malformed-line logs carry a data record");
					for (const [key, value] of Object.entries(record)) {
						assert.ok(key === "length" || key === "errorClass", `unexpected malformed-log field: ${key}`);
						if (key === "length") {
							assert.strictEqual(typeof value, "number");
						} else {
							assert.match(String(value), /^[A-Za-z$_][A-Za-z0-9$_]*$/, "errorClass must be a bare class name");
						}
					}
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("a truncated final frame is dropped without corrupting what came before it", async function () {
		this.timeout(Math.max(120000, NUM_RUNS * 50));
		await fc.assert(
			fc.asyncProperty(framingEventsArb, fc.nat({ max: 12 }), async (events, cutBack) => {
				const assembled = assemble(events);
				const lines = [...renderLines(assembled.chunks), "data: [DONE]"];
				const full = await runBytes([encode(`${lines.join("\n")}\n`)]);
				// Drop the trailing newline plus up to the whole "data: [DONE]" line:
				// the incomplete line stays in the buffer and EOF finishes the stream.
				const rendered = lines.join("\n");
				const truncated = rendered.slice(0, rendered.length - (cutBack % ("data: [DONE]".length + 1)));
				const partial = await runBytes([encode(truncated)]);
				assert.deepStrictEqual(descriptorsOf(partial.parts), descriptorsOf(full.parts), "truncated tail diverged");
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("extra [DONE] frames after the end are idempotent", async function () {
		this.timeout(Math.max(120000, NUM_RUNS * 50));
		await fc.assert(
			fc.asyncProperty(framingEventsArb, fc.integer({ min: 1, max: 3 }), async (events, extras) => {
				const assembled = assemble(events);
				const lines = [...renderLines(assembled.chunks), "data: [DONE]"];
				const base = await runBytes([encode(`${lines.join("\n")}\n`)]);
				const padded = [...lines, ...Array.from({ length: extras }, () => "data: [DONE]")];
				const repeated = await runBytes([encode(`${padded.join("\n")}\n`)]);
				assert.deepStrictEqual(descriptorsOf(repeated.parts), descriptorsOf(base.parts), "extra [DONE] diverged");
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("arbitrary bytes never wedge the transport", async function () {
		this.timeout(Math.max(120000, NUM_RUNS * 50));
		const garbageArb = fc.array(
			fc.oneof(
				fc.uint8Array({ maxLength: 64 }),
				fc.string({ maxLength: 64 }).map(encode),
				fc.constantFrom(...INERT_LINES, ...MALFORMED_DATA_LINES).map((line) => encode(`${line}\n`))
			),
			{ maxLength: 10 }
		);
		await fc.assert(
			fc.asyncProperty(garbageArb, async (byteChunks) => {
				try {
					await runBytes(byteChunks);
				} catch (e) {
					// The one legitimate rejection: end-of-stream leftovers that were a
					// tool call with unparseable arguments.
					assert.match(String(e), /The model sent a broken tool call/, `unexpected rejection: ${String(e)}`);
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});
