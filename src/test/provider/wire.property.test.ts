import * as assert from "node:assert";
import * as fc from "fast-check";
import {
	type ChatCompletionChunk,
	type ChunkAnnotation,
	type ChunkAudio,
	type ChunkChoice,
	type ChunkDelta,
	type ChunkImage,
	parseChunk,
	type StreamedToolCall,
	type ThinkingBlock,
	type ThinkingBlockDelta,
} from "../../provider/wire";
import { resolveFuzzSeed } from "../fuzzStream";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 200;
// Pinned by default; FUZZ_SEED overrides so the nightly explores fresh seeds.
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

function assertDelta(delta: ChunkDelta, label: string): void {
	assert.ok(isPlainRecord(delta), `${label} must be a record`);
	assertOptionalString(delta.role, `${label}.role`);
	if (delta.content !== undefined && delta.content !== null && typeof delta.content !== "string") {
		assert.ok(Array.isArray(delta.content), `${label}.content must be string | blocks | null | undefined`);
		for (const [i, block] of delta.content.entries()) {
			assert.ok(isPlainRecord(block), `${label}.content[${i}] must be a record`);
			assertOptionalString(block.type, `${label}.content[${i}].type`);
			assertOptionalString(block.text, `${label}.content[${i}].text`);
		}
	}
	if (delta.tool_calls !== undefined) {
		assert.ok(Array.isArray(delta.tool_calls), `${label}.tool_calls must be an array or undefined`);
		for (const [i, call] of delta.tool_calls.entries()) {
			assertToolCall(call, `${label}.tool_calls[${i}]`);
		}
	}
	assertThinking(delta.thinking, `${label}.thinking`);
	if (delta.thinking_blocks !== undefined) {
		assert.ok(Array.isArray(delta.thinking_blocks), `${label}.thinking_blocks must be an array or undefined`);
		for (const [i, block] of delta.thinking_blocks.entries()) {
			assertThinkingBlockDelta(block, `${label}.thinking_blocks[${i}]`);
		}
	}
	assertOptionalString(delta.reasoning_content, `${label}.reasoning_content`);
	assertOptionalString(delta.reasoning, `${label}.reasoning`);
	assertOptionalString(delta.refusal, `${label}.refusal`);
	if (delta.annotations !== undefined) {
		assert.ok(Array.isArray(delta.annotations), `${label}.annotations must be an array or undefined`);
		for (const [i, annotation] of delta.annotations.entries()) {
			assertAnnotation(annotation, `${label}.annotations[${i}]`);
		}
	}
	if (delta.images !== undefined) {
		assert.ok(Array.isArray(delta.images), `${label}.images must be an array or undefined`);
		for (const [i, image] of delta.images.entries()) {
			assertImage(image, `${label}.images[${i}]`);
		}
	}
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
	assert.ok(
		chunk.usage === undefined || isPlainRecord(chunk.usage),
		"chunk.usage must be a record or undefined (a wire null parses to undefined)"
	);
	if (chunk.choices !== undefined) {
		assert.ok(Array.isArray(chunk.choices), "chunk.choices must be an array or undefined");
		for (const [i, choice] of chunk.choices.entries()) {
			assertChoice(choice, `chunk.choices[${i}]`);
		}
	}
}

/** JSON-representable values plus fast-check's wider default value pool (still prototype-ordinary, like JSON.parse output). */
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
		usage: fuzzValue,
	},
	{ requiredKeys: [] }
);

suite("provider/wire parseChunk totality properties", () => {
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
});
