import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { applyContributes } from "../../../../../scripts/dev/manifest/write";

/**
 * The in-place replacement: only the generated blocks change, every other key keeps its position and value, and the
 * output is the repository's manifest formatting regardless of the input's.
 */
describe("manifest write", () => {
	test("replaces only the generated blocks, keeping key order and odd values elsewhere", () => {
		const input = JSON.stringify(
			{
				name: "fixture",
				engines: { vscode: "^1.0.0" },
				contributes: {
					commands: [{ command: "x", title: "%x%" }],
					configuration: [{ title: "old", properties: {} }],
					menus: { "scm/title": [] },
				},
				scripts: { odd: 'a\tb "quoted" \\ end' },
				trailing: null,
			},
			null,
			2
		);
		const { next, drifted } = applyContributes(input, { configuration: [{ title: "new", properties: { a: 1 } }] });
		assert.deepStrictEqual(drifted, ["configuration"]);
		assert.ok(next.endsWith("\n"));
		assert.ok(!next.endsWith("\n\n"));
		const parsed = JSON.parse(next) as Record<string, unknown>;
		assert.deepStrictEqual(Object.keys(parsed), ["name", "engines", "contributes", "scripts", "trailing"]);
		assert.deepStrictEqual(Object.keys(parsed.contributes as object), ["commands", "configuration", "menus"]);
		assert.deepStrictEqual(parsed.scripts, { odd: 'a\tb "quoted" \\ end' });
		assert.deepStrictEqual((parsed.contributes as Record<string, unknown>).configuration, [
			{ title: "new", properties: { a: 1 } },
		]);
		// Tabs, not the input's two spaces.
		assert.ok(next.includes('\n\t"contributes": {\n\t\t"commands"'));
	});

	test("a reordered key inside a block counts as drift even though the value is equal", () => {
		const input = JSON.stringify({ contributes: { configuration: [{ properties: {}, title: "t" }] } });
		const { drifted } = applyContributes(input, { configuration: [{ title: "t", properties: {} }] });
		assert.deepStrictEqual(drifted, ["configuration"]);
	});

	test("an identical block is not drift", () => {
		const input = JSON.stringify({ contributes: { configuration: [{ title: "t", properties: {} }] } });
		assert.deepStrictEqual(applyContributes(input, { configuration: [{ title: "t", properties: {} }] }).drifted, []);
	});

	test("a block the manifest does not contribute is an error, not an insertion", () => {
		const input = JSON.stringify({ contributes: { commands: [] } });
		assert.throws(() => applyContributes(input, { configuration: [] }), /contributes no configuration block/);
		assert.throws(() => applyContributes(JSON.stringify({ name: "x" }), { configuration: [] }), /no contributes/);
	});
});
