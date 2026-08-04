import * as assert from "node:assert";
import type { CapabilityGroupsParse, GroupsParse, HeaderRowsParse } from "../../../extension/dashboard/recordDraft";
import {
	parseCapabilityGroups,
	parseCatalogIdText,
	parseGroups,
	parseHeaderRows,
	toCapabilityGroups,
	toGroups,
	toggleExpectedFailure,
	toHeaderRows,
} from "../../../extension/dashboard/recordDraft";

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

	suite("model capability groups", () => {
		/** The ok arm's record; fails the test on a blocked capability parse. */
		function capsValue(parse: CapabilityGroupsParse): Record<string, Record<string, unknown>> {
			if (!parse.ok) {
				assert.fail(`expected a clean parse, got issues: ${JSON.stringify(parse.issues)}`);
			}
			return parse.value;
		}

		test("configured records round-trip through rows and back, catalog IDs rendered bare", () => {
			const value = {
				"gpt-4": { context_length: 128000, supports_vision: true },
				"my-model": { _declare: true, _openrouter_model: "openai/gpt-4o" },
			};
			const groups = toCapabilityGroups(value);
			assert.strictEqual(
				groups[1]?.params.find((param) => param.key === "_openrouter_model")?.valueText,
				"openai/gpt-4o",
				"catalog IDs render bare, not JSON-quoted"
			);
			assert.deepStrictEqual(capsValue(parseCapabilityGroups(groups)), value);
		});

		test("typed vocabulary: number fields take positive integers, flags take true/false", () => {
			const bad = parseCapabilityGroups([
				{
					prefix: "gpt-4",
					params: [
						{ key: "context_length", valueText: "-5" },
						{ key: "supports_vision", valueText: "yes" },
						{ key: "_declare", valueText: "1" },
						{ key: "_openrouter_model", valueText: "  " },
					],
				},
			]);
			assert.strictEqual(bad.ok, false);
			const rows = bad.issues[0]?.rows ?? [];
			for (const [index, row] of rows.entries()) {
				assert.strictEqual(row?.problem?.field, "value", `row ${index} must block on its value`);
			}
		});

		test("unknown keys hint without blocking; underscore keys pass silently as JSON", () => {
			const parse = parseCapabilityGroups([
				{
					prefix: "gpt-4",
					params: [
						{ key: "supports_pdf_input", valueText: "true" },
						{ key: "_future_directive", valueText: '"x"' },
					],
				},
			]);
			assert.ok(parse.ok);
			assert.notStrictEqual(parse.issues[0]?.rows[0]?.hint, undefined, "unknown keys carry the hint");
			assert.strictEqual(parse.issues[0]?.rows[1]?.hint, undefined, "underscore keys are reserved, not unknown");
			assert.deepStrictEqual(parse.value, { "gpt-4": { supports_pdf_input: true, _future_directive: "x" } });
		});

		test("empty, reserved, and duplicate keys are flagged like the parameter editor flags them", () => {
			const parse = parseCapabilityGroups([
				{
					prefix: "gpt-4",
					params: [
						{ key: "", valueText: "1" },
						{ key: "__proto__", valueText: "1" },
						{ key: "context_length", valueText: "1" },
						{ key: "context_length", valueText: "2" },
					],
				},
				{ prefix: "", params: [] },
			]);
			assert.strictEqual(parse.ok, false);
			assert.notStrictEqual(parse.issues[0]?.rows[0]?.problem, undefined, "empty key");
			assert.notStrictEqual(parse.issues[0]?.rows[1]?.problem, undefined, "reserved key");
			assert.notStrictEqual(parse.issues[0]?.rows[3]?.problem, undefined, "duplicate key");
			assert.notStrictEqual(parse.issues[1]?.prefix, undefined, "empty prefix");
			assert.strictEqual(({} as Record<string, unknown>).context_length, undefined, "Object.prototype stays clean");
		});

		test("a quoted catalog ID unquotes on parse, so formatJsonValue output round-trips", () => {
			assert.strictEqual(parseCatalogIdText('"openai/gpt-4o"'), "openai/gpt-4o");
			assert.strictEqual(parseCatalogIdText("openai/gpt-4o"), "openai/gpt-4o");
			assert.strictEqual(parseCatalogIdText('""'), undefined);
			assert.strictEqual(parseCatalogIdText("  "), undefined);
		});
	});

	suite("toggleExpectedFailure", () => {
		test("toggling keeps the canonical category order regardless of insertion order", () => {
			assert.deepStrictEqual(toggleExpectedFailure([], "modelInfo", true), ["modelInfo"]);
			assert.deepStrictEqual(toggleExpectedFailure(["modelInfo"], "modelListing", true), ["modelListing", "modelInfo"]);
			assert.deepStrictEqual(toggleExpectedFailure(["modelListing", "modelInfo"], "modelListing", false), [
				"modelInfo",
			]);
			assert.deepStrictEqual(toggleExpectedFailure(["modelInfo"], "modelInfo", false), []);
		});
	});
});
