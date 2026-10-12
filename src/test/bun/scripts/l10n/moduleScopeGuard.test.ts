import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { inferLazyL10nNames, moduleScopeL10nOffenses } from "../../../../../scripts/l10n/lib";

/**
 * The inference and the guard composed over a tree, which the per-file fixtures in scripts/l10n/fixtures cannot
 * express: a helper is inferred lazy from its own declaration, and a module-scope call to it in ANOTHER file is refused
 * with nothing registered anywhere.
 */
describe("l10n module-scope guard over a tree", () => {
	// One case per shape of lazy helper the old hand-kept list carried. `helpers.ts` declares what the call reaches;
	// `inner.ts` holds the other file where the shape has one.
	const HELPERS: readonly {
		readonly shape: string;
		readonly helpers: string;
		readonly inner?: string;
		readonly call: string;
	}[] = [
		{
			shape: "a helper resolving l10n.t directly",
			helpers: 'export function label(): string {\n\treturn l10n.t("x");\n}\n',
			call: "label()",
		},
		{
			shape: "a helper reaching l10n.t through another file's helper",
			helpers: 'import { inner } from "./inner";\nexport function label(): string {\n\treturn inner();\n}\n',
			inner: 'export function inner(): string {\n\treturn l10n.t("x");\n}\n',
			call: "label()",
		},
		{
			shape: "a class whose constructor localizes",
			helpers: 'export class Label {\n\tconstructor() {\n\t\tl10n.t("x");\n\t}\n}\n',
			call: "new Label()",
		},
		{
			shape: "a class whose constructor calls an instance method that localizes",
			helpers:
				"export class Label {\n\tconstructor() {\n\t\tthis.render();\n\t}\n" +
				'\tprivate render(): string {\n\t\treturn l10n.t("x");\n\t}\n}\n',
			call: "new Label()",
		},
		{
			shape: "a resolver reading a thunk table by computed key",
			helpers:
				'const TEXTS = {\n\ta: () => l10n.t("x"),\n};\n' +
				"export function label(key: string): string {\n\treturn TEXTS[key]();\n}\n",
			call: 'label("a")',
		},
		{
			shape: "a resolver calling a member of a thunk-table row",
			helpers:
				'const ROWS = {\n\ta: { surface: () => l10n.t("x") },\n};\n' +
				"export function label(key: string): string {\n\treturn ROWS[key].surface();\n}\n",
			call: 'label("a")',
		},
		{
			shape: "a helper calling an aliased import of another file's lazy helper",
			helpers:
				'import { inner as renamed } from "./inner";\nexport function label(): string {\n\treturn renamed();\n}\n',
			inner: 'export function inner(): string {\n\treturn l10n.t("x");\n}\n',
			call: "label()",
		},
	];

	for (const { shape, helpers, inner, call } of HELPERS) {
		test(`${shape}: a module-scope call in another file is refused, a deferred one accepted, nothing registered`, () => {
			const frozen = { file: "frozen.ts", contents: `import * as h from "./helpers";\n\nconst FROZEN = ${call};\n` };
			const deferred = { file: "deferred.ts", contents: `export const text = () => ${call};\n` };
			const lazy = inferLazyL10nNames([
				{ file: "helpers.ts", contents: helpers },
				...(inner === undefined ? [] : [{ file: "inner.ts", contents: inner }]),
				frozen,
				deferred,
			]);
			assert.deepStrictEqual(moduleScopeL10nOffenses(frozen.contents, frozen.file, lazy), [3]);
			assert.deepStrictEqual(moduleScopeL10nOffenses(deferred.contents, deferred.file, lazy), []);
			// The control: with nothing inferred, the same call site is invisible, so the refusal above is the
			// inference's work and not the file's own text.
			assert.deepStrictEqual(moduleScopeL10nOffenses(frozen.contents, frozen.file, new Map()), []);
		});
	}

	test("a helper with no localization path is accepted at module scope, however it is spelled", () => {
		const helpers = {
			file: "helpers.ts",
			contents: "export function showMessage(message: string): string {\n\treturn message.trim();\n}\n",
		};
		const caller = { file: "caller.ts", contents: 'const SHOWN = showMessage("x");\n' };
		const lazy = inferLazyL10nNames([helpers, caller]);
		assert.deepStrictEqual([...lazy.keys()], []);
		assert.deepStrictEqual(moduleScopeL10nOffenses(caller.contents, caller.file, lazy), []);
	});
});
