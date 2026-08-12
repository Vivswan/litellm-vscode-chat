import * as assert from "node:assert";
import type { PrefixGroup } from "../../dashboard/recordDraft";
import {
	capabilityGroupsFromJsonText,
	directiveEligible,
	directiveRowAbsorbed,
	inheritFromChoice,
	parseCapabilityGroups,
	parseGroups,
	setInheritFromChoice,
} from "../../dashboard/recordDraft";

function group(prefix: string, params: readonly [string, string][]): PrefixGroup {
	return { prefix, params: params.map(([key, valueText]) => ({ key, valueText })) };
}

suite("dashboard/recordDraft inheritance directives", () => {
	suite("the _inheritable row", () => {
		test("true and a list of own fields parse clean in both editors", () => {
			const parameters = parseGroups([
				group("gpt*", [
					["temperature", "0.5"],
					["_inheritable", "true"],
				]),
			]);
			assert.ok(parameters.ok);
			assert.deepStrictEqual(parameters.value, { "gpt*": { temperature: 0.5, _inheritable: true } });
			assert.deepStrictEqual(parameters.hints, [{ params: [undefined, undefined] }]);

			const capabilities = parseCapabilityGroups([
				group("gpt*", [
					["context_length", "128000"],
					["_inheritable", '["context_length"]'],
				]),
			]);
			assert.ok(capabilities.ok);
			assert.deepStrictEqual(capabilities.value, {
				"gpt*": { context_length: 128000, _inheritable: ["context_length"] },
			});
		});

		test("a listed name the record does not set hints without blocking", () => {
			const parse = parseGroups([
				group("gpt*", [
					["temperature", "0.5"],
					["_inheritable", '["top_p"]'],
				]),
			]);
			assert.ok(parse.ok, "the setting keeps the row; resolution diagnoses it");
			assert.deepStrictEqual(parse.value["gpt*"]?._inheritable, ["top_p"]);
			assert.match(parse.hints[0]?.params[1] ?? "", /"top_p" is not a field this record sets/);

			const capabilities = parseCapabilityGroups([
				group("gpt*", [
					["context_length", "128000"],
					["_inheritable", '["max_output_tokens"]'],
				]),
			]);
			assert.ok(capabilities.ok);
			assert.match(capabilities.issues[0]?.rows[1]?.hint ?? "", /"max_output_tokens" is not a field/);
		});

		test("junk that reads as neither boolean nor string list blocks the row", () => {
			const parse = parseGroups([group("gpt*", [["_inheritable", "42"]])]);
			assert.ok(!parse.ok);
			assert.strictEqual(parse.problems[0]?.params[0]?.field, "value");

			const capabilities = parseCapabilityGroups([group("gpt*", [["_inheritable", '[1, "a"]']])]);
			assert.ok(!capabilities.ok);
			assert.strictEqual(capabilities.issues[0]?.rows[0]?.problem?.field, "value");
		});
	});

	suite("the _inherit_from row", () => {
		test("true, false, and a list of the draft's own record keys parse clean", () => {
			const parse = parseGroups([
				group("*", [["seed", "1"]]),
				group("gpt*", [
					["temperature", "0.5"],
					["_inherit_from", '["*"]'],
				]),
				group("gpt-4", [
					["top_p", "1"],
					["_inherit_from", "false"],
				]),
			]);
			assert.ok(parse.ok);
			assert.deepStrictEqual(parse.value["gpt*"]?._inherit_from, ["*"]);
			assert.strictEqual(parse.value["gpt-4"]?._inherit_from, false);
		});

		test("a named key that is no record here hints (skipped, rest applies) without blocking", () => {
			const parse = parseGroups([
				group("gpt*", [
					["temperature", "0.5"],
					["_inherit_from", '["defaults"]'],
				]),
			]);
			assert.ok(parse.ok);
			assert.match(parse.hints[0]?.params[1] ?? "", /"defaults" is not a record key here/);

			const capabilities = parseCapabilityGroups([
				group("gpt*", [
					["context_length", "128000"],
					["_inherit_from", '["defaults"]'],
				]),
			]);
			assert.ok(capabilities.ok);
			assert.match(capabilities.issues[0]?.rows[1]?.hint ?? "", /"defaults" is not a record key here/);
		});

		test("junk blocks the row with the directive's own grammar message", () => {
			const parse = parseGroups([group("gpt*", [["_inherit_from", '{"a": 1}']])]);
			assert.ok(!parse.ok);
			assert.match(parse.problems[0]?.params[0]?.message ?? "", /true, false, or a list of record keys/);
		});
	});

	suite("inheritFromChoice / setInheritFromChoice", () => {
		const base = group("gpt*", [["temperature", "0.5"]]);

		test("reads default, all, none (false and the empty list), keys, and unreadable", () => {
			assert.deepStrictEqual(inheritFromChoice(base), { kind: "default" });
			assert.deepStrictEqual(inheritFromChoice(group("g", [["_inherit_from", "true"]])), { kind: "all" });
			assert.deepStrictEqual(inheritFromChoice(group("g", [["_inherit_from", "false"]])), { kind: "none" });
			assert.deepStrictEqual(inheritFromChoice(group("g", [["_inherit_from", "[]"]])), { kind: "none" });
			assert.deepStrictEqual(inheritFromChoice(group("g", [["_inherit_from", '["a", "b"]']])), {
				kind: "keys",
				keysText: "a, b",
			});
			assert.deepStrictEqual(inheritFromChoice(group("g", [["_inherit_from", "{broken"]])), { kind: "unreadable" });
		});

		test("a list the comma-joined keys input cannot reproduce reads unreadable: the select must not rewrite it", () => {
			for (const value of ['["base,blue"]', '[" padded"]', '[""]']) {
				assert.deepStrictEqual(
					inheritFromChoice(group("g", [["_inherit_from", value]])),
					{ kind: "unreadable" },
					value
				);
			}
		});

		test("every choice written round-trips back through inheritFromChoice", () => {
			assert.deepStrictEqual(inheritFromChoice(setInheritFromChoice(base, "all")), { kind: "all" });
			assert.deepStrictEqual(inheritFromChoice(setInheritFromChoice(base, "none")), { kind: "none" });
			assert.deepStrictEqual(inheritFromChoice(setInheritFromChoice(base, { keysText: "a, ,b" })), {
				kind: "keys",
				keysText: "a, b",
			});
			assert.deepStrictEqual(
				inheritFromChoice(setInheritFromChoice(setInheritFromChoice(base, "all"), "default")),
				{ kind: "default" },
				"default removes the row again"
			);
		});

		test("an all-empty keys text writes the empty list: the barrier, read back as none", () => {
			const written = setInheritFromChoice(base, { keysText: " , " });
			assert.strictEqual(written.params.at(-1)?.valueText, "[]");
			assert.deepStrictEqual(inheritFromChoice(written), { kind: "none" });
		});

		test("writes replace the existing directive row in place instead of appending a duplicate", () => {
			const existing = group("gpt*", [
				["_inherit_from", "true"],
				["temperature", "0.5"],
			]);
			const written = setInheritFromChoice(existing, { keysText: "claude*" });
			assert.deepStrictEqual(
				written.params.map((param) => param.key),
				["_inherit_from", "temperature"]
			);
			assert.strictEqual(written.params[0]?.valueText, '["claude*"]');
		});

		test("default on a group without the row returns the group untouched", () => {
			assert.strictEqual(setInheritFromChoice(base, "default"), base);
		});
	});

	test("directiveEligible: _inheritable marks any own non-directive field, in both editors", () => {
		assert.strictEqual(directiveEligible("_inheritable", "temperature"), true);
		assert.strictEqual(directiveEligible("_inheritable", "context_length"), true);
		assert.strictEqual(directiveEligible("_inheritable", "_inherit_from"), false, "directives never mark directives");
		assert.strictEqual(directiveEligible("_inheritable", "_force"), false);
		assert.strictEqual(directiveEligible("_inheritable", ""), false);
	});

	suite("directiveRowAbsorbed", () => {
		const flags = ["_force", "_inheritable"] as const;

		test("absorbs booleans, lists of eligible row keys, and round-trippable _inherit_from shapes", () => {
			const boolTrue = group("g", [
				["temperature", "0.5"],
				["_force", "true"],
			]);
			assert.strictEqual(directiveRowAbsorbed(boolTrue, 1, flags), true);
			const list = group("g", [
				["temperature", "0.5"],
				["_inheritable", '["temperature"]'],
			]);
			assert.strictEqual(directiveRowAbsorbed(list, 1, flags), true);
			for (const value of ["true", "false", "[]", '["not-a-record-key-here"]']) {
				const inheritFrom = group("g", [["_inherit_from", value]]);
				assert.strictEqual(directiveRowAbsorbed(inheritFrom, 0, flags), true, `_inherit_from ${value}`);
			}
		});

		test("keeps rows the controls cannot fully show: unreadable values, stranded entries, duplicates", () => {
			const unreadable = group("g", [["_force", "42"]]);
			assert.strictEqual(directiveRowAbsorbed(unreadable, 0, flags), false);
			const stranded = group("g", [
				["temperature", "0.5"],
				["_force", '["ghost"]'],
			]);
			assert.strictEqual(directiveRowAbsorbed(stranded, 1, flags), false, "no row's checkbox can display ghost");
			const unforceable = group("g", [
				["model", '"other"'],
				["_force", '["model"]'],
			]);
			assert.strictEqual(directiveRowAbsorbed(unforceable, 1, flags), false);
			const duplicated = group("g", [
				["_inherit_from", "true"],
				["_inherit_from", "false"],
			]);
			assert.strictEqual(directiveRowAbsorbed(duplicated, 0, flags), false);
			assert.strictEqual(directiveRowAbsorbed(duplicated, 1, flags), false);
		});

		test("keeps checkbox directives in a group with no eligible row: there is no box to carry the state", () => {
			// A bare `_force: true` absorbed here would vanish entirely - and
			// silently arm itself for the next added row.
			for (const value of ["true", "false", "[]"]) {
				const alone = group("g", [["_force", value]]);
				assert.strictEqual(directiveRowAbsorbed(alone, 0, flags), false, `_force ${value}`);
			}
			const withDirectivesOnly = group("g", [
				["_inherit_from", "false"],
				["_inheritable", "true"],
			]);
			assert.strictEqual(directiveRowAbsorbed(withDirectivesOnly, 1, flags), false, "directives are not eligible rows");
		});

		test("keeps _inherit_from lists the control's comma-joined keys input cannot round-trip", () => {
			for (const value of ['["base,blue"]', '[" padded"]', '[""]']) {
				const lossy = group("g", [["_inherit_from", value]]);
				assert.strictEqual(directiveRowAbsorbed(lossy, 0, flags), false, `_inherit_from ${value}`);
			}
		});

		test("never absorbs plain rows or directives outside the caller's flag set", () => {
			const plain = group("g", [["supports_vision", "true"]]);
			assert.strictEqual(directiveRowAbsorbed(plain, 0, flags), false, "a boolean value is not a directive");
			const fallback = group("g", [
				["context_length", "128000"],
				["_fallback", "true"],
			]);
			assert.strictEqual(directiveRowAbsorbed(fallback, 1, flags), false, "_fallback is not this editor's flag");
			assert.strictEqual(directiveRowAbsorbed(fallback, 1, ["_fallback", "_inheritable"]), true);
			assert.strictEqual(directiveRowAbsorbed(plain, 5, flags), false, "out of range");
		});
	});

	suite("capabilityGroupsFromJsonText", () => {
		test("a valid record round-trips into rows the grid parse accepts", () => {
			const parse = capabilityGroupsFromJsonText(
				'{"gpt-4": {"context_length": 128000, "_inherit_from": false, "supports_vision": true}}'
			);
			assert.ok(parse.ok);
			assert.deepStrictEqual(parse.rows, [
				group("gpt-4", [
					["context_length", "128000"],
					["_inherit_from", "false"],
					["supports_vision", "true"],
				]),
			]);
			const reparsed = parseCapabilityGroups(parse.rows);
			assert.ok(reparsed.ok);
			assert.deepStrictEqual(reparsed.value, {
				"gpt-4": { context_length: 128000, _inherit_from: false, supports_vision: true },
			});
		});

		test("non-objects and non-record field values are one problem, keyed to the offender", () => {
			assert.deepStrictEqual(capabilityGroupsFromJsonText("[1, 2]"), {
				ok: false,
				problem: 'Must be a JSON object, e.g. {"gpt-4": {"context_length": 128000}}.',
			});
			const scalarField = capabilityGroupsFromJsonText('{"gpt-4": 128000}');
			assert.ok(!scalarField.ok);
			assert.match(scalarField.problem, /^"gpt-4": Expected an object of capability fields/);
		});

		test("a blocking row problem surfaces as the single side-door message; hints alone stay ok", () => {
			const blocked = capabilityGroupsFromJsonText('{"gpt-4": {"context_length": "lots"}}');
			assert.ok(!blocked.ok);
			assert.match(blocked.problem, /^"context_length": Enter a positive whole number of tokens/);

			const hinted = capabilityGroupsFromJsonText('{"gpt-4": {"supports_levitation": true}}');
			assert.ok(hinted.ok, "an unknown capability field is kept and hinted, never a side-door refusal");
		});
	});
});
