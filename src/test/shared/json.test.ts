import * as assert from "assert";
import { tryParseJSONObject } from "../../shared/json";

suite("shared/json", () => {
	test("tryParseJSONObject handles valid and invalid JSON", () => {
		assert.deepEqual(tryParseJSONObject('{"a":1}'), { ok: true, value: { a: 1 } });
		assert.deepEqual(tryParseJSONObject("[1,2,3]"), { ok: false });
		assert.deepEqual(tryParseJSONObject("not json"), { ok: false });
	});
});
