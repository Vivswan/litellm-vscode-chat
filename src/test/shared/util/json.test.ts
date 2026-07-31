import * as assert from "node:assert";
import { tryParseJSONObject } from "../../../shared/util/json";

suite("shared/util/json", () => {
	test("tryParseJSONObject handles valid and invalid JSON", () => {
		assert.deepEqual(tryParseJSONObject('{"a":1}'), { ok: true, value: { a: 1 } });
		assert.deepEqual(tryParseJSONObject("[1,2,3]"), { ok: false });
		assert.deepEqual(tryParseJSONObject("not json"), { ok: false });
	});
});
