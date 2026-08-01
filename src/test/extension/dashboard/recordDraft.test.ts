import * as assert from "node:assert";
import type { GroupsParse, HeaderRowsParse } from "../../../extension/dashboard/recordDraft";
import { parseGroups, parseHeaderRows, toGroups, toHeaderRows } from "../../../extension/dashboard/recordDraft";

/** The ok arm's record; fails the test on a parse with problems. */
function parsedValue<P extends GroupsParse | HeaderRowsParse>(parse: P): Extract<P, { ok: true }>["value"] {
	if (!parse.ok) {
		assert.fail(`expected a clean parse, got problems: ${JSON.stringify(parse.problems)}`);
	}
	return parse.value;
}

/** The problems arm; fails the test on a parse that unexpectedly succeeded. */
function parsedProblems<P extends GroupsParse | HeaderRowsParse>(parse: P): Extract<P, { ok: false }>["problems"] {
	if (parse.ok) {
		assert.fail("expected a blocked parse, got a clean one");
	}
	return parse.problems;
}

suite("extension/dashboard/recordDraft", () => {
	suite("model parameter groups", () => {
		test("configured records round-trip through rows and back", () => {
			const value = { "gpt-4": { temperature: 0.2, stop: ["\n"] }, "http://host:4000/claude": { max_tokens: 100 } };

			assert.deepStrictEqual(parsedValue(parseGroups(toGroups(value))), value);
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

			const problems = parsedProblems(parseGroups(groups));
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

			const problems = parsedProblems(parseGroups(groups));
			assert.strictEqual(problems[0]?.params[0], undefined);
			assert.notStrictEqual(problems[0]?.params[1], undefined);
		});

		test("prototype-polluting prefixes and parameter names are rejected with a visible message", () => {
			const groups = [{ prefix: "__proto__", params: [{ key: "constructor", valueText: "1" }] }];

			const problems = parsedProblems(parseGroups(groups));
			assert.ok(problems[0]?.prefix?.includes("reserved"));
			assert.ok(problems[0]?.params[0]?.message.includes("reserved"));
		});

		test("hostile rows are refused without mutating a prototype", () => {
			const parse = parseGroups([{ prefix: "__proto__", params: [{ key: "polluted", valueText: "true" }] }]);

			assert.strictEqual(parse.ok, false, "reserved names never assemble");
			assert.strictEqual(({} as Record<string, unknown>).polluted, undefined, "Object.prototype stays clean");
		});

		test("keys and prefixes are trimmed on assembly, and the record's prototype is ordinary", () => {
			const assembled = parsedValue(
				parseGroups([{ prefix: " gpt-4 ", params: [{ key: " temperature ", valueText: "0.2" }] }])
			);

			assert.deepStrictEqual(assembled, { "gpt-4": { temperature: 0.2 } });
			assert.strictEqual(Object.getPrototypeOf(assembled), Object.prototype, "the prototype stays untouched");
		});
	});

	suite("header rows", () => {
		test("configured headers round-trip through rows and back, keeping scalar types", () => {
			const value = { "x-key": "abc", "x-count": 2, "x-flag": true, "x-word": "true" };

			assert.deepStrictEqual(parsedValue(parseHeaderRows(toHeaderRows(value))), value);
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

			const problems = parsedProblems(parseHeaderRows(rows));
			assert.notStrictEqual(problems[0], undefined, "empty name");
			assert.strictEqual(problems[1], undefined, "a clean row stays clean");
			assert.notStrictEqual(problems[2], undefined, "every occurrence of a duplicate is flagged");
			assert.notStrictEqual(problems[3], undefined, "duplicate name");
			assert.notStrictEqual(problems[4], undefined, "space is not a token char");
			assert.ok(problems[5]?.includes("reserved"));
		});

		test("values with line breaks are flagged: the request path would drop them silently", () => {
			const problems = parsedProblems(parseHeaderRows([{ name: "x-key", valueText: '"a\\nb"' }]));

			assert.notStrictEqual(problems[0], undefined);
		});

		test("hostile rows are refused without mutating a prototype; clean records get an ordinary one", () => {
			const hostile = parseHeaderRows([{ name: "__proto__", valueText: "v" }]);
			assert.strictEqual(hostile.ok, false, "reserved names never assemble");
			assert.strictEqual(({} as Record<string, unknown>).v, undefined, "Object.prototype stays clean");

			const clean = parsedValue(parseHeaderRows([{ name: "x-key", valueText: "v" }]));
			assert.strictEqual(Object.getPrototypeOf(clean), Object.prototype, "the prototype stays untouched");
		});
	});
});
