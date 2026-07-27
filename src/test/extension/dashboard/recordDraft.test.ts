import * as assert from "node:assert";
import {
	assembleGroups,
	assembleHeaderRows,
	hasGroupProblems,
	toGroups,
	toHeaderRows,
	validateGroups,
	validateHeaderRows,
} from "../../../extension/dashboard/recordDraft";

suite("extension/dashboard/recordDraft", () => {
	suite("model parameter groups", () => {
		test("configured records round-trip through rows and back", () => {
			const value = { "gpt-4": { temperature: 0.2, stop: ["\n"] }, "http://host:4000/claude": { max_tokens: 100 } };

			const groups = toGroups(value);
			assert.strictEqual(hasGroupProblems(validateGroups(groups)), false);
			assert.deepStrictEqual(assembleGroups(groups), value);
		});

		test("empty and duplicate prefixes and parameter names are flagged", () => {
			const groups = [
				{ prefix: "", params: [{ key: "temperature", valueText: "0.2" }] },
				{
					prefix: "gpt-4",
					params: [
						{ key: "a", valueText: "1" },
						{ key: "a", valueText: "2" },
					],
				},
				{ prefix: "gpt-4", params: [] },
			];

			const problems = validateGroups(groups);
			assert.ok(hasGroupProblems(problems));
			assert.notStrictEqual(problems[0]?.prefix, undefined, "empty prefix");
			assert.notStrictEqual(problems[1]?.params[1], undefined, "duplicate parameter");
			assert.notStrictEqual(problems[2]?.prefix, undefined, "duplicate prefix");
		});

		test("invalid JSON values carry the parse error; valid rows stay clean", () => {
			const groups = [
				{
					prefix: "gpt-4",
					params: [
						{ key: "temperature", valueText: "0.2" },
						{ key: "stop", valueText: "not json" },
					],
				},
			];

			const problems = validateGroups(groups);
			assert.strictEqual(problems[0]?.params[0], undefined);
			assert.notStrictEqual(problems[0]?.params[1], undefined);
		});

		test("prototype-polluting prefixes and parameter names are rejected with a visible message", () => {
			const groups = [{ prefix: "__proto__", params: [{ key: "constructor", valueText: "1" }] }];

			const problems = validateGroups(groups);
			assert.ok(problems[0]?.prefix?.includes("reserved"));
			assert.ok(problems[0]?.params[0]?.includes("reserved"));
		});

		test("assembled records never mutate a prototype even from hostile rows", () => {
			const assembled = assembleGroups([{ prefix: "__proto__", params: [{ key: "polluted", valueText: "true" }] }]);

			assert.strictEqual(({} as Record<string, unknown>).polluted, undefined, "Object.prototype stays clean");
			assert.strictEqual(Object.getPrototypeOf(assembled), Object.prototype, "the prototype stays untouched");
		});

		test("keys and prefixes are trimmed on assembly", () => {
			const assembled = assembleGroups([{ prefix: " gpt-4 ", params: [{ key: " temperature ", valueText: "0.2" }] }]);

			assert.deepStrictEqual(assembled, { "gpt-4": { temperature: 0.2 } });
		});
	});

	suite("header rows", () => {
		test("configured headers round-trip through rows and back, keeping scalar types", () => {
			const value = { "x-key": "abc", "x-count": 2, "x-flag": true, "x-word": "true" };

			const rows = toHeaderRows(value);
			assert.deepStrictEqual(
				validateHeaderRows(rows).filter((p) => p !== undefined),
				[]
			);
			assert.deepStrictEqual(assembleHeaderRows(rows), value);
		});

		test("empty, duplicate, non-token, and reserved names are flagged", () => {
			const rows = [
				{ name: "", valueText: "v" },
				{ name: "x-ok", valueText: "v" },
				{ name: "x-a", valueText: "v" },
				{ name: "x-a", valueText: "w" },
				{ name: "bad name", valueText: "v" },
				{ name: "__proto__", valueText: "v" },
			];

			const problems = validateHeaderRows(rows);
			assert.notStrictEqual(problems[0], undefined, "empty name");
			assert.strictEqual(problems[1], undefined, "a clean row stays clean");
			assert.notStrictEqual(problems[2], undefined, "every occurrence of a duplicate is flagged");
			assert.notStrictEqual(problems[3], undefined, "duplicate name");
			assert.notStrictEqual(problems[4], undefined, "space is not a token char");
			assert.ok(problems[5]?.includes("reserved"));
		});

		test("values with line breaks are flagged: the request path would drop them silently", () => {
			const problems = validateHeaderRows([{ name: "x-key", valueText: '"a\\nb"' }]);

			assert.notStrictEqual(problems[0], undefined);
		});

		test("assembled headers never mutate a prototype even from hostile rows", () => {
			const assembled = assembleHeaderRows([{ name: "__proto__", valueText: "v" }]);

			assert.strictEqual(Object.getPrototypeOf(assembled), Object.prototype, "the prototype stays untouched");
			assert.strictEqual(({} as Record<string, unknown>).v, undefined, "Object.prototype stays clean");
		});
	});
});
