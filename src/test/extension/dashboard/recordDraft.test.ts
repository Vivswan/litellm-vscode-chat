import * as assert from "node:assert";
import type { CapabilityGroupsParse, GroupsParse, HeaderRowsParse } from "../../../extension/dashboard/recordDraft";
import {
	directiveEligible,
	directiveMarkedFields,
	parseCapabilityGroups,
	parseCatalogIdText,
	parseGroups,
	parseHeaderRows,
	toCapabilityGroups,
	toGroups,
	toggleDirectiveField,
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

		test("a _force row takes true, false, or a list of names; anything else blocks with the example", () => {
			const value = { "gpt-4": { temperature: 0.2, _force: ["temperature"] } };
			assert.deepStrictEqual(parsedValue(parseGroups(toGroups(value))), value, "list form round-trips");
			assert.deepStrictEqual(
				parsedValue(parseGroups([{ prefix: "gpt-4", params: [{ key: "_force", valueText: "true" }] }])),
				{ "gpt-4": { _force: true } },
				"a literal true assembles untouched"
			);

			const problems = parsedProblems(
				parseGroups([
					{
						prefix: "gpt-4",
						params: [
							{ key: "_force", valueText: '"temperature"' },
							{ key: "_other_underscore", valueText: '"kept"' },
						],
					},
				])
			);
			assert.strictEqual(problems[0]?.params[0]?.field, "value", "a bare string blocks the value input");
			assert.ok(problems[0]?.params[0]?.message.includes('["temperature"]'), "the message leads with the example");
			assert.strictEqual(problems[0]?.params[1], undefined, "other underscore keys stay open JSON");
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
				"my-model": { _future: true, _openrouter_model: "openai/gpt-4o" },
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

		test("a _fallback row takes true, false, or a list; a hand-written true round-trips unrewritten", () => {
			const value = {
				"gpt-4": { context_length: 128000, _fallback: ["context_length"] },
				"claude-3": { max_output_tokens: 8192, _fallback: true },
			};
			assert.deepStrictEqual(capsValue(parseCapabilityGroups(toCapabilityGroups(value))), value);

			const blocked = parseCapabilityGroups([{ prefix: "gpt-4", params: [{ key: "_fallback", valueText: "128000" }] }]);
			assert.strictEqual(blocked.ok, false);
			assert.strictEqual(blocked.issues[0]?.rows[0]?.problem?.field, "value");
			assert.ok(
				blocked.issues[0]?.rows[0]?.problem?.message.includes('["context_length"]'),
				"the message leads with the example"
			);
		});

		test("_fallback hints: list entries the prefix does not set", () => {
			const unknown = parseCapabilityGroups([
				{
					prefix: "gpt-4",
					params: [
						{ key: "context_length", valueText: "128000" },
						{ key: "_fallback", valueText: '["max_output_tokens"]' },
					],
				},
			]);
			assert.ok(unknown.ok);
			assert.ok(
				unknown.issues[0]?.rows[1]?.hint?.includes("max_output_tokens"),
				"a listed field the prefix does not set is named in the hint"
			);
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

	suite("directive checkboxes (_fallback / _force)", () => {
		test("eligibility: _fallback marks known capability fields, _force refuses owned and underscore keys", () => {
			assert.ok(directiveEligible("_fallback", "context_length"));
			assert.ok(!directiveEligible("_fallback", "supports_pdf_input"), "unknown fields carry no checkbox");
			assert.ok(!directiveEligible("_fallback", "_openrouter_model"), "directives carry no checkbox");
			assert.ok(directiveEligible("_force", "temperature"));
			assert.ok(!directiveEligible("_force", "model"), "provider-owned keys are unforceable");
			assert.ok(!directiveEligible("_force", "max_tokens"), "max_tokens is provider-owned on the wire");
			assert.ok(!directiveEligible("_force", "_meta"), "underscore keys are unforceable");
			assert.ok(!directiveEligible("_force", ""), "an unnamed row is unforceable");
		});

		test("marked fields read from the row: absent, false, and unreadable rows mark nothing", () => {
			const rows = (valueText: string) => ({
				prefix: "gpt-4",
				params: [{ key: "temperature", valueText: "0.2" }, ...(valueText === "" ? [] : [{ key: "_force", valueText }])],
			});
			assert.deepStrictEqual([...directiveMarkedFields(rows(""), "_force")], []);
			assert.deepStrictEqual([...directiveMarkedFields(rows("false"), "_force")], []);
			assert.deepStrictEqual([...directiveMarkedFields(rows("not json"), "_force")], []);
			assert.deepStrictEqual([...directiveMarkedFields(rows('["temperature"]'), "_force")], ["temperature"]);
			// A partly invalid list still marks its string entries: the resolver
			// salvages those (the row meanwhile blocks on the strict parse), so
			// the checkbox must not read a forced field as unmarked. Toggling
			// keeps the non-string junk in place for the user to fix.
			assert.deepStrictEqual([...directiveMarkedFields(rows('[42, "temperature"]'), "_force")], ["temperature"]);
			const salvaged = toggleDirectiveField(rows('[42, "temperature"]'), "_force", "temperature", false);
			assert.strictEqual(salvaged.params[1]?.valueText, "[42]", "unmarking preserves the junk entry, still flagged");
		});

		test("a literal true marks every eligible row key, capability directives and owned keys excluded", () => {
			const group = {
				prefix: "gpt-4",
				params: [
					{ key: "context_length", valueText: "128000" },
					{ key: "_openrouter_model", valueText: "openai/gpt-4o" },
					{ key: "_fallback", valueText: "true" },
				],
			};
			assert.deepStrictEqual([...directiveMarkedFields(group, "_fallback")], ["context_length"]);

			const params = {
				prefix: "gpt-4",
				params: [
					{ key: "temperature", valueText: "0.2" },
					{ key: "model", valueText: '"x"' },
					{ key: "_force", valueText: "true" },
				],
			};
			assert.deepStrictEqual([...directiveMarkedFields(params, "_force")], ["temperature"]);
		});

		test("toggling writes the explicit list, appends the row when absent, and drops it on the last unmark", () => {
			const bare = { prefix: "gpt-4", params: [{ key: "temperature", valueText: "0.2" }] };

			const marked = toggleDirectiveField(bare, "_force", "temperature", true);
			assert.deepStrictEqual(marked.params[1], { key: "_force", valueText: '["temperature"]' });

			const unmarked = toggleDirectiveField(marked, "_force", "temperature", false);
			assert.deepStrictEqual(unmarked.params, bare.params, "the last unmark removes the directive row");

			assert.strictEqual(toggleDirectiveField(bare, "_force", "temperature", false), bare, "no row, no change");
		});

		test("a hand-written true expands to the eligible keys on the first toggle; unknown entries are kept", () => {
			const group = {
				prefix: "gpt-4",
				params: [
					{ key: "context_length", valueText: "128000" },
					{ key: "max_output_tokens", valueText: "8192" },
					{ key: "_fallback", valueText: "true" },
				],
			};
			const toggled = toggleDirectiveField(group, "_fallback", "max_output_tokens", false);
			assert.strictEqual(toggled.params[2]?.valueText, '["context_length"]', "true becomes the explicit remainder");

			const withUnknown = {
				prefix: "gpt-4",
				params: [
					{ key: "temperature", valueText: "0.2" },
					{ key: "_force", valueText: '["typo_entry"]' },
				],
			};
			const kept = toggleDirectiveField(withUnknown, "_force", "temperature", true);
			assert.strictEqual(
				kept.params[1]?.valueText,
				'["typo_entry","temperature"]',
				"user-typed entries survive an unrelated toggle"
			);
		});

		test("toggle output round-trips through the parse and the marks it reads back", () => {
			const group = { prefix: "gpt-4", params: [{ key: "context_length", valueText: "128000" }] };
			const marked = toggleDirectiveField(group, "_fallback", "context_length", true);
			const parse = parseCapabilityGroups([marked]);
			assert.ok(parse.ok, "the rewritten row parses clean");
			assert.deepStrictEqual(parse.value, {
				"gpt-4": { context_length: 128000, _fallback: ["context_length"] },
			});
			assert.ok(directiveMarkedFields(marked, "_fallback").has("context_length"));
		});
	});
});
