import * as assert from "node:assert";
import type { Scenario } from "./scenarios";
import { isScenario, MAX_SCENARIO_ITEMS, MAX_STALL_MS } from "./scenarios";

/**
 * Boundary pins for the PUT /_test/custom-scenario validator: every cap and
 * enum here is what keeps a runtime registration from wedging the fake
 * backend, so each boundary gets an accept on one side and a reject on the
 * other.
 */

const validRaw = {
	type: "raw",
	statusCode: 200,
	headers: { "Content-Type": "text/event-stream" },
	frames: ["data: {}\n\n", "data: [DONE]\n\n"],
	tail: "end",
};

const validAbort = { type: "sse-abort", chunks: [{}], tail: "destroy" };

suite("scenarios: isScenario boundaries", () => {
	test("the valid baseline of every type is accepted", () => {
		const accepted: unknown[] = [
			{ type: "sse", chunks: [] },
			{ type: "sse-delayed", chunks: [{}], delayMs: 40 },
			{ type: "error", statusCode: 429 },
			validAbort,
			{ ...validAbort, tail: "stall", stallMs: MAX_STALL_MS, delayMs: 0 },
			validRaw,
			{ ...validRaw, tail: "stall", stallMs: 500, frameDelayMs: 50, statusCode: 599 },
		];
		for (const value of accepted) {
			assert.ok(isScenario(value), `must accept ${JSON.stringify(value).slice(0, 120)}`);
		}
	});

	test("non-objects and unknown types are rejected", () => {
		for (const value of [null, undefined, 42, "sse", [], { type: "sse2", chunks: [] }]) {
			assert.strictEqual(isScenario(value), false, `must reject ${JSON.stringify(value)}`);
		}
	});

	test("chunk and frame lists are rejected past the item cap", () => {
		const atCap = new Array(MAX_SCENARIO_ITEMS).fill({});
		const overCap = new Array(MAX_SCENARIO_ITEMS + 1).fill({});
		assert.ok(isScenario({ type: "sse", chunks: atCap }));
		assert.strictEqual(isScenario({ type: "sse", chunks: overCap }), false);
		assert.strictEqual(isScenario({ ...validAbort, chunks: overCap }), false);
		assert.strictEqual(isScenario({ ...validRaw, frames: new Array(MAX_SCENARIO_ITEMS + 1).fill("x") }), false);
	});

	test("durations must be finite numbers inside [0, MAX_STALL_MS]", () => {
		for (const bad of [-1, MAX_STALL_MS + 1, Number.NaN, Number.POSITIVE_INFINITY, "40"]) {
			assert.strictEqual(isScenario({ type: "sse-delayed", chunks: [], delayMs: bad }), false, `delayMs ${bad}`);
			assert.strictEqual(isScenario({ ...validAbort, tail: "stall", stallMs: bad }), false, `stallMs ${bad}`);
			assert.strictEqual(isScenario({ ...validRaw, frameDelayMs: bad }), false, `frameDelayMs ${bad}`);
		}
		assert.strictEqual(isScenario({ type: "sse-delayed", chunks: [] }), false, "sse-delayed requires its delay");
	});

	test("status codes must be integers in 200-599 for raw and error alike", () => {
		for (const bad of [199, 600, 429.5, Number.NaN, "503"]) {
			assert.strictEqual(isScenario({ ...validRaw, statusCode: bad }), false, `raw status ${bad}`);
			assert.strictEqual(isScenario({ type: "error", statusCode: bad }), false, `error status ${bad}`);
		}
		assert.ok(isScenario({ type: "error", statusCode: 200 }));
	});

	test("tails outside each type's enum are rejected", () => {
		assert.strictEqual(isScenario({ ...validAbort, tail: "end" }), false, "sse-abort has no clean end tail");
		assert.strictEqual(isScenario({ ...validRaw, tail: "no-done" }), false, "raw spells its ending in frames");
		assert.strictEqual(isScenario({ ...validAbort, tail: "hangup" }), false);
	});

	test("raw headers must be a string-to-string record", () => {
		for (const bad of [undefined, null, ["Content-Type"], { "Content-Type": 7 }, "text/html"]) {
			assert.strictEqual(isScenario({ ...validRaw, headers: bad }), false, `headers ${JSON.stringify(bad)}`);
		}
	});

	test("raw frames must be byte strings: entries with code points above 0xFF are rejected at registration", () => {
		// Frames are written as latin1 (one char, one byte); a code point above
		// 0xFF cannot be a byte and would silently mojibake on the wire. Authors
		// pre-encode: Buffer.from(utf8).toString("latin1") passes.
		assert.strictEqual(isScenario({ ...validRaw, frames: ["caf\u00e9"] }), true, "0xFF and below are bytes");
		assert.strictEqual(isScenario({ ...validRaw, frames: ["caf\u0113"] }), false, "U+0113 is not a byte");
		assert.strictEqual(isScenario({ ...validRaw, frames: ["ok", 42] }), false, "non-strings are rejected");
	});

	test("the type guard narrows for the compiler", () => {
		const value: unknown = validRaw;
		if (isScenario(value)) {
			const scenario: Scenario = value;
			assert.strictEqual(scenario.type, "raw");
		} else {
			assert.fail("validRaw must validate");
		}
	});
});
