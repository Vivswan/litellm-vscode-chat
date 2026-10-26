/**
 * parseChunk over shaped and unshaped input. Every slot of the shaped records is drawn from fuzzValue:
 * JSON-representable values plus fast-check's wider default value pool, still prototype-ordinary like JSON.parse
 * output.
 */
import { describe, test } from "bun:test";
import * as assert from "node:assert";
import * as fc from "fast-check";
import {
	type ChatCompletionChunk,
	type ChunkAnnotation,
	type ChunkAudio,
	type ChunkChoice,
	type ChunkDelta,
	type ChunkImage,
	type ChunkSearchResult,
	parseChunk,
	type StreamedToolCall,
	type ThinkingBlock,
	type ThinkingBlockDelta,
} from "../../../../provider/transport/wire";
import { resolveFuzzSeed } from "../../../fuzzStream";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 200;
const SEED = resolveFuzzSeed();

function isPlainRecord(value: unknown): boolean {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOptionalString(value: unknown, label: string): void {
	assert.ok(value === undefined || typeof value === "string", `${label} must be string | undefined`);
}

function assertThinking(value: string | ThinkingBlock | undefined, label: string): void {
	if (value === undefined || typeof value === "string") {
		return;
	}
	assert.ok(isPlainRecord(value), `${label} must be a string, a record, or undefined`);
	assertOptionalString(value.text, `${label}.text`);
	assertOptionalString(value.id, `${label}.id`);
}

function assertToolCall(call: StreamedToolCall, label: string): void {
	assert.ok(isPlainRecord(call), `${label} must be a record`);
	assert.ok(
		call.index === undefined || typeof call.index === "number" || typeof call.index === "string",
		`${label}.index must be number | string | undefined`
	);
	assertOptionalString(call.id, `${label}.id`);
	assertOptionalString(call.type, `${label}.type`);
	if (call.function !== undefined) {
		assert.ok(isPlainRecord(call.function), `${label}.function must be a record or undefined`);
		assertOptionalString(call.function.name, `${label}.function.name`);
		assertOptionalString(call.function.arguments, `${label}.function.arguments`);
	}
}

function assertThinkingBlockDelta(block: ThinkingBlockDelta, label: string): void {
	assert.ok(isPlainRecord(block), `${label} must be a record`);
	assertOptionalString(block.type, `${label}.type`);
	assertOptionalString(block.thinking, `${label}.thinking`);
	assertOptionalString(block.signature, `${label}.signature`);
	assertOptionalString(block.data, `${label}.data`);
}

function assertAnnotation(annotation: ChunkAnnotation, label: string): void {
	assert.ok(isPlainRecord(annotation), `${label} must be a record`);
	assertOptionalString(annotation.type, `${label}.type`);
	if (annotation.url_citation !== undefined) {
		assert.ok(isPlainRecord(annotation.url_citation), `${label}.url_citation must be a record or undefined`);
		assertOptionalString(annotation.url_citation.url, `${label}.url_citation.url`);
		assertOptionalString(annotation.url_citation.title, `${label}.url_citation.title`);
	}
}

function assertSearchResults(results: ChunkSearchResult[] | undefined, label: string): void {
	if (results === undefined) {
		return;
	}
	assert.ok(Array.isArray(results), `${label} must be an array or undefined`);
	for (const [i, result] of results.entries()) {
		assert.ok(isPlainRecord(result), `${label}[${i}] must be a record`);
		assertOptionalString(result.url, `${label}[${i}].url`);
		assertOptionalString(result.title, `${label}[${i}].title`);
	}
}

function assertImage(image: ChunkImage, label: string): void {
	assert.ok(isPlainRecord(image), `${label} must be a record`);
	assertOptionalString(image.type, `${label}.type`);
	if (image.image_url !== undefined) {
		assert.ok(isPlainRecord(image.image_url), `${label}.image_url must be a record or undefined`);
		assertOptionalString(image.image_url.url, `${label}.image_url.url`);
	}
}

function assertAudio(audio: ChunkAudio, label: string): void {
	assert.ok(isPlainRecord(audio), `${label} must be a record`);
	assertOptionalString(audio.id, `${label}.id`);
	assertOptionalString(audio.data, `${label}.data`);
	assertOptionalString(audio.transcript, `${label}.transcript`);
}

/** Asserts `items` is an array or undefined, then runs `assertItem` over each element under its indexed label. */
function assertOptionalList<T>(
	items: readonly T[] | undefined,
	label: string,
	assertItem: (item: T, label: string) => void
): void {
	if (items === undefined) {
		return;
	}
	assert.ok(Array.isArray(items), `${label} must be an array or undefined`);
	for (const [i, item] of items.entries()) {
		assertItem(item, `${label}[${i}]`);
	}
}

/** Asserts a delta's content is a string, null, undefined, or a list of text blocks with string fields. */
function assertContent(content: ChunkDelta["content"], label: string): void {
	if (content === undefined || content === null || typeof content === "string") {
		return;
	}
	assert.ok(Array.isArray(content), `${label} must be string | blocks | null | undefined`);
	for (const [i, block] of content.entries()) {
		assert.ok(isPlainRecord(block), `${label}[${i}] must be a record`);
		assertOptionalString(block.type, `${label}[${i}].type`);
		assertOptionalString(block.text, `${label}[${i}].text`);
	}
}

function assertDelta(delta: ChunkDelta, label: string): void {
	assert.ok(isPlainRecord(delta), `${label} must be a record`);
	assertOptionalString(delta.role, `${label}.role`);
	assertContent(delta.content, `${label}.content`);
	assertOptionalList(delta.tool_calls, `${label}.tool_calls`, assertToolCall);
	assertThinking(delta.thinking, `${label}.thinking`);
	assertOptionalList(delta.thinking_blocks, `${label}.thinking_blocks`, assertThinkingBlockDelta);
	assertOptionalString(delta.reasoning_content, `${label}.reasoning_content`);
	assertOptionalString(delta.reasoning, `${label}.reasoning`);
	assertOptionalString(delta.refusal, `${label}.refusal`);
	assertOptionalList(delta.annotations, `${label}.annotations`, assertAnnotation);
	assertSearchResults(delta.search_results, `${label}.search_results`);
	assertOptionalList(delta.images, `${label}.images`, assertImage);
	if (delta.audio !== undefined) {
		assertAudio(delta.audio, `${label}.audio`);
	}
}

function assertChoice(choice: ChunkChoice, label: string): void {
	assert.ok(isPlainRecord(choice), `${label} must be a record`);
	assert.ok(
		choice.index === undefined || typeof choice.index === "number",
		`${label}.index must be number | undefined`
	);
	if (choice.delta !== undefined) {
		assertDelta(choice.delta, `${label}.delta`);
	}
	assertThinking(choice.thinking, `${label}.thinking`);
	assert.ok(
		choice.finish_reason === undefined || typeof choice.finish_reason === "string",
		`${label}.finish_reason must be string | undefined (a wire null parses to undefined)`
	);
}

function assertChunkInvariants(chunk: ChatCompletionChunk): void {
	assert.ok(isPlainRecord(chunk), "parseChunk must return a record for record input");
	assertOptionalString(chunk.id, "chunk.id");
	assertOptionalString(chunk.object, "chunk.object");
	assert.ok(
		chunk.created === undefined || typeof chunk.created === "number",
		"chunk.created must be number | undefined"
	);
	assertOptionalString(chunk.model, "chunk.model");
	if (chunk.citations !== undefined) {
		assert.ok(Array.isArray(chunk.citations), "chunk.citations must be an array or undefined");
		for (const [i, citation] of chunk.citations.entries()) {
			assert.ok(typeof citation === "string", `chunk.citations[${i}] must be a string (non-strings drop alone)`);
		}
	}
	assertSearchResults(chunk.search_results, "chunk.search_results");
	assert.ok(
		chunk.usage === undefined || isPlainRecord(chunk.usage),
		"chunk.usage must be a record or undefined (a wire null parses to undefined)"
	);
	assert.ok(
		chunk.error === undefined || isPlainRecord(chunk.error),
		"chunk.error must be a record or undefined (non-record error values stay junk)"
	);
	if (chunk.choices !== undefined) {
		assert.ok(Array.isArray(chunk.choices), "chunk.choices must be an array or undefined");
		for (const [i, choice] of chunk.choices.entries()) {
			assertChoice(choice, `chunk.choices[${i}]`);
		}
	}
}

const fuzzValue = fc.oneof(fc.jsonValue({ maxDepth: 2 }), fc.anything({ maxDepth: 2, maxKeys: 5 }));

const toolCallShaped = fc.record(
	{
		index: fuzzValue,
		id: fuzzValue,
		type: fuzzValue,
		function: fc.oneof(fuzzValue, fc.record({ name: fuzzValue, arguments: fuzzValue }, { requiredKeys: [] })),
	},
	{ requiredKeys: [] }
);

const searchResultsShaped = fc.array(
	fc.oneof(fuzzValue, fc.record({ url: fuzzValue, title: fuzzValue }, { requiredKeys: [] })),
	{ maxLength: 3 }
);

const deltaShaped = fc.record(
	{
		role: fuzzValue,
		content: fuzzValue,
		tool_calls: fc.oneof(fuzzValue, fc.array(fc.oneof(fuzzValue, toolCallShaped), { maxLength: 3 })),
		thinking: fuzzValue,
		thinking_blocks: fc.oneof(
			fuzzValue,
			fc.array(
				fc.oneof(
					fuzzValue,
					fc.record(
						{ type: fuzzValue, thinking: fuzzValue, signature: fuzzValue, data: fuzzValue },
						{ requiredKeys: [] }
					)
				),
				{ maxLength: 3 }
			)
		),
		reasoning_content: fuzzValue,
		reasoning: fuzzValue,
		refusal: fuzzValue,
		annotations: fc.oneof(
			fuzzValue,
			fc.array(
				fc.oneof(
					fuzzValue,
					fc.record(
						{
							type: fuzzValue,
							url_citation: fc.oneof(fuzzValue, fc.record({ url: fuzzValue, title: fuzzValue }, { requiredKeys: [] })),
						},
						{ requiredKeys: [] }
					)
				),
				{ maxLength: 3 }
			)
		),
		provider_specific_fields: fc.oneof(
			fuzzValue,
			fc.record({ search_results: fc.oneof(fuzzValue, searchResultsShaped) }, { requiredKeys: [] })
		),
		images: fc.oneof(
			fuzzValue,
			fc.array(
				fc.oneof(
					fuzzValue,
					fc.record(
						{ type: fuzzValue, image_url: fc.oneof(fuzzValue, fc.record({ url: fuzzValue }, { requiredKeys: [] })) },
						{ requiredKeys: [] }
					)
				),
				{ maxLength: 3 }
			)
		),
		audio: fc.oneof(
			fuzzValue,
			fc.record({ id: fuzzValue, data: fuzzValue, transcript: fuzzValue }, { requiredKeys: [] })
		),
	},
	{ requiredKeys: [] }
);

const choiceShaped = fc.record(
	{
		index: fuzzValue,
		delta: fc.oneof(fuzzValue, deltaShaped),
		thinking: fuzzValue,
		finish_reason: fuzzValue,
	},
	{ requiredKeys: [] }
);

const chunkShaped = fc.record(
	{
		id: fuzzValue,
		object: fuzzValue,
		created: fuzzValue,
		model: fuzzValue,
		choices: fc.oneof(fuzzValue, fc.array(fc.oneof(fuzzValue, choiceShaped), { maxLength: 3 })),
		citations: fc.oneof(fuzzValue, fc.array(fuzzValue, { maxLength: 3 })),
		search_results: fc.oneof(fuzzValue, searchResultsShaped),
		usage: fuzzValue,
	},
	{ requiredKeys: [] }
);

describe("provider/wire parseChunk totality properties", () => {
	test("never throws and returns undefined exactly for non-record input", () => {
		fc.assert(
			fc.property(fc.oneof(fc.anything({}), fc.jsonValue()), (raw) => {
				const result = parseChunk(raw);
				assert.equal(
					result !== undefined,
					isPlainRecord(raw),
					"parseChunk must be defined exactly for plain-object input"
				);
				if (result !== undefined) {
					assertChunkInvariants(result);
				}
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("chunk-shaped records with fuzzed field values always narrow to the chunk contract", () => {
		fc.assert(
			fc.property(chunkShaped, (raw) => {
				const result = parseChunk(raw);
				assert.ok(result !== undefined, "record input must produce a chunk");
				assertChunkInvariants(result);
			}),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});

	test("a content object with a non-callable toString narrows to absent instead of throwing", () => {
		// Fuzz-found at seed 20260726, run 16804: String() on this shape throws, and the pre-fix coercion streamed
		// "[object Object]" as output text.
		const result = parseChunk({ choices: [{ delta: { content: { toString: 0 } } }] });
		assert.ok(result !== undefined);
		const delta = result.choices?.[0]?.delta;
		assert.ok(delta !== undefined, "the chunk keeps its choice; only the junk content drops");
		assert.strictEqual(delta.content, undefined);
	});
});
