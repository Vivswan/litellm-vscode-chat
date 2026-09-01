import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { tryParseJSONObject } from "../../../../shared/util/json";

describe("shared/util/json", () => {
	test("tryParseJSONObject handles valid and invalid JSON", () => {
		assert.deepEqual(tryParseJSONObject('{"a":1}'), { ok: true, value: { a: 1 } });
		assert.deepEqual(tryParseJSONObject("[1,2,3]"), { ok: false });
		assert.deepEqual(tryParseJSONObject("not json"), { ok: false });
	});

	test("empty text is not an object: the flush-time empty-args rule lives in the stream processor, not here", () => {
		assert.deepEqual(tryParseJSONObject(""), { ok: false });
		assert.deepEqual(tryParseJSONObject("   "), { ok: false });
		assert.deepEqual(tryParseJSONObject("{}"), { ok: true, value: {} });
	});
});
