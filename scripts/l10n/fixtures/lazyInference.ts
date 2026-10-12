/**
 * The inference's own teeth: each fixture's expected names are the exact set inferLazyL10nNames must mark lazy over
 * its sources. `lazyElsewhere` names helpers the sources call into without showing; the self-check declares each in a
 * file of its own (a plain l10n.t helper) and expects it alongside.
 */
export const LAZY_INFERENCE_FIXTURES: readonly {
	readonly name: string;
	readonly sources: readonly { readonly file: string; readonly contents: string }[];
	readonly lazyElsewhere?: readonly string[];
	readonly expected: readonly string[];
}[] = [
	{
		name: "an overload set is one name",
		sources: [
			{
				file: "a.ts",
				contents:
					"export function label(value: number): string;\n" +
					"export function label(value: string): string;\n" +
					'export function label(value: unknown): string {\n\treturn l10n.t("x", String(value));\n}\n',
			},
		],
		expected: ["label"],
	},
	{
		name: "a direct l10n.t caller is inferred",
		sources: [{ file: "a.ts", contents: 'export function label(): string {\n\treturn l10n.t("x");\n}\n' }],
		expected: ["label"],
	},
	{
		name: "vscode.l10n.t counts as direct",
		sources: [{ file: "a.ts", contents: 'export const label = () => vscode.l10n.t("x");\n' }],
		expected: ["label"],
	},
	{
		name: "transitive through a lazy name",
		sources: [{ file: "a.ts", contents: "export function wrap(): string {\n\treturn lazyHelper();\n}\n" }],
		lazyElsewhere: ["lazyHelper"],
		expected: ["wrap"],
	},
	{
		name: "transitive chain across files, both links reported",
		sources: [
			{ file: "a.ts", contents: "export function outer(): string {\n\treturn inner();\n}\n" },
			{ file: "b.ts", contents: 'export function inner(): string {\n\treturn l10n.t("x");\n}\n' },
		],
		expected: ["inner", "outer"],
	},
	{
		name: "a default parameter resolves l10n.t",
		sources: [{ file: "a.ts", contents: 'export function f(text = l10n.t("d")): string {\n\treturn text;\n}\n' }],
		expected: ["f"],
	},
	{
		name: "an arrow-function variable is a helper too",
		sources: [{ file: "a.ts", contents: 'export const g = () => l10n.t("x");\n' }],
		expected: ["g"],
	},
	{
		name: "an uppercase component is lazy like any helper, and carries its edge",
		sources: [
			{
				file: "a.tsx",
				contents:
					'export function Banner(): string {\n\treturn l10n.t("x");\n}\n' +
					"export function callsComponent(): string {\n\treturn Banner();\n}\n",
			},
		],
		expected: ["Banner", "callsComponent"],
	},
	{
		name: "a helper with no l10n path raises nothing",
		sources: [{ file: "a.ts", contents: "export function plain(): number {\n\treturn 1 + 1;\n}\n" }],
		expected: [],
	},
	{
		// The parameter name `title` still binds a value in flight and is never followed; the ARGUMENT reference is the
		// binding's own edge now.
		name: "an argument-position helper taints the binding it feeds (the parameter name stays unfollowed)",
		sources: [{ file: "a.ts", contents: "export const wraps = ((title) => () => title())(manageCommandTitle);\n" }],
		lazyElsewhere: ["manageCommandTitle"],
		expected: ["wraps"],
	},
	{
		name: "a helper passing a lazy helper as a direct argument is inferred",
		sources: [{ file: "a.ts", contents: "export function wires(): void {\n\tregister(manageCommandTitle);\n}\n" }],
		lazyElsewhere: ["manageCommandTitle"],
		expected: ["wires"],
	},
	{
		name: "a helper passing a lazy helper behind a ternary argument is inferred",
		sources: [
			{
				file: "a.ts",
				contents: "export function wires(): void {\n\tregister(enabled ? manageCommandTitle : plain);\n}\n",
			},
		],
		lazyElsewhere: ["manageCommandTitle"],
		expected: ["wires"],
	},
	{
		name: "a helper nested inside an array-literal argument stays invisible (the documented limit)",
		sources: [{ file: "a.ts", contents: "export function wires(): void {\n\tregister([manageCommandTitle]);\n}\n" }],
		lazyElsewhere: ["manageCommandTitle"],
		expected: [],
	},
	{
		name: "a spread argument stays invisible (the documented limit)",
		sources: [{ file: "a.ts", contents: "export function wires(): void {\n\tregister(...[manageCommandTitle]);\n}\n" }],
		lazyElsewhere: ["manageCommandTitle"],
		expected: [],
	},
	{
		name: "a helper forwarding a lazy helper through .call is inferred",
		sources: [
			{
				file: "a.ts",
				contents: "export function wraps(): string {\n\treturn manageCommandTitle.call(undefined);\n}\n",
			},
		],
		lazyElsewhere: ["manageCommandTitle"],
		expected: ["wraps"],
	},
	{
		name: "l10n.t forwarded through .call still reads as direct",
		sources: [
			{ file: "a.ts", contents: 'export function wraps(): string {\n\treturn l10n.t.call(undefined, "x");\n}\n' },
		],
		expected: ["wraps"],
	},
	{
		name: "a member call through a local namespace import resolves by member name",
		sources: [
			{
				file: "a.ts",
				contents:
					'import * as helpers from "./titles";\nexport function wraps(): string {\n\treturn helpers.title();\n}\n',
			},
			{ file: "titles.ts", contents: 'export function title(): string {\n\treturn l10n.t("x");\n}\n' },
		],
		expected: ["title", "wraps"],
	},
	{
		name: "a lazy member called through a local namespace import is inferred",
		sources: [
			{
				file: "a.ts",
				contents:
					'import * as helpers from "./titles";\nexport function wraps(): string {\n\treturn helpers.title();\n}\n',
			},
		],
		lazyElsewhere: ["title"],
		expected: ["wraps"],
	},
	{
		name: "a local namespace member passed as a direct argument is the caller's edge",
		sources: [
			{
				file: "a.ts",
				contents:
					'import * as helpers from "./titles";\nexport function wires(): void {\n\tregister(helpers.title);\n}\n',
			},
		],
		lazyElsewhere: ["title"],
		expected: ["wires"],
	},
	{
		name: "a local namespace member bound to an alias is inferred under the alias",
		sources: [
			{
				file: "a.ts",
				contents:
					'import * as helpers from "./titles";\nconst alias = helpers.title;\nexport const wraps = () => alias();\n',
			},
		],
		lazyElsewhere: ["title"],
		expected: ["alias", "wraps"],
	},
	{
		name: "a lazy member element-accessed through a local namespace import is inferred",
		sources: [
			{
				file: "a.ts",
				contents:
					'import * as helpers from "./titles";\nexport function wraps(): string {\n\treturn helpers["title"]();\n}\n',
			},
		],
		lazyElsewhere: ["title"],
		expected: ["wraps"],
	},
	{
		name: "a package namespace member call stays invisible (members are not lazy names)",
		sources: [
			{
				file: "a.ts",
				contents:
					'import * as path from "node:path";\nexport function wraps(): string {\n\treturn path.join("a", "b");\n}\n',
			},
		],
		lazyElsewhere: ["join"],
		expected: [],
	},
	{
		name: "a deeper namespace chain stays invisible (the documented limit)",
		sources: [
			{
				file: "a.ts",
				contents:
					'import * as helpers from "./titles";\nexport function wraps(): string {\n\treturn helpers.sub.title();\n}\n',
			},
		],
		lazyElsewhere: ["title"],
		expected: [],
	},
	{
		name: "a computed member call edges its receiver",
		sources: [
			{
				file: "a.ts",
				contents: "export function wraps(): string {\n\treturn manageCommandTitle[member]();\n}\n",
			},
		],
		lazyElsewhere: ["manageCommandTitle"],
		expected: ["wraps"],
	},
	{
		name: "a computed member call on a lazy local namespace member edges that member",
		sources: [
			{
				file: "a.ts",
				contents:
					'import * as helpers from "./t";\nexport function wraps(): string {\n\treturn helpers.title[member]();\n}\n',
			},
		],
		lazyElsewhere: ["title"],
		expected: ["wraps"],
	},
	{
		name: "a literal element-access call into an undeclared table stays invisible",
		sources: [{ file: "a.ts", contents: 'export function via(): string {\n\treturn TABLE["surface"]();\n}\n' }],
		expected: [],
	},
	{
		name: "a local namespace export named call resolves as a member, not Function.prototype",
		sources: [
			{
				file: "a.ts",
				contents: 'import * as helpers from "./t";\nexport function wraps(): string {\n\treturn helpers.call();\n}\n',
			},
		],
		lazyElsewhere: ["call"],
		expected: ["wraps"],
	},
	{
		name: "a ternary callee marks its helper through either branch",
		sources: [
			{
				file: "a.ts",
				contents: "export const wraps = () => (enabled ? manageCommandTitle : plain)();\n",
			},
		],
		lazyElsewhere: ["manageCommandTitle"],
		expected: ["wraps"],
	},
	{
		name: "a ternary receiver behind .call marks its helper (the composition re-flattens)",
		sources: [
			{
				file: "a.ts",
				contents: "export const wraps = () => (enabled ? manageCommandTitle : plain).call(undefined);\n",
			},
		],
		lazyElsewhere: ["manageCommandTitle"],
		expected: ["wraps"],
	},
	{
		name: "a ternary receiver behind a computed member call marks its helper",
		sources: [
			{
				file: "a.ts",
				contents: "export const wraps = () => (enabled ? manageCommandTitle : plain)[member]();\n",
			},
		],
		lazyElsewhere: ["manageCommandTitle"],
		expected: ["wraps"],
	},
	{
		name: "a logical-assignment callee marks its helper through either side",
		sources: [
			{
				file: "a.ts",
				contents:
					"export function wraps(): string {\n\tlet held: (() => string) | undefined;\n\treturn (held ??= manageCommandTitle)();\n}\n",
			},
		],
		lazyElsewhere: ["manageCommandTitle"],
		expected: ["wraps"],
	},
	{
		name: "a binding to a forwarding member aliases its receiver",
		sources: [
			{
				file: "a.ts",
				contents: "const grab = manageCommandTitle.call;\nexport const wraps = () => grab(undefined);\n",
			},
		],
		lazyElsewhere: ["manageCommandTitle"],
		expected: ["grab", "wraps"],
	},
	{
		name: "a class extending a lazy local namespace member is inferred",
		sources: [
			{
				file: "a.ts",
				contents: 'import * as helpers from "./t";\nexport class Derived extends helpers.Base {}\n',
			},
		],
		lazyElsewhere: ["Base"],
		expected: ["Derived"],
	},
	{
		// Matching is by spelling, the guard's own rule: a scalar parameter sharing a lazy name taints its helper.
		// Deliberate over-inclusion.
		name: "an argument sharing a lazy spelling taints its helper (syntactic matching, pinned intentional)",
		sources: [
			{
				file: "a.ts",
				contents: "export function sends(formatValue: number): string {\n\treturn String(formatValue);\n}\n",
			},
		],
		lazyElsewhere: ["formatValue"],
		expected: ["sends"],
	},
	{
		name: "Reflect.apply of a lazy helper taints the caller through the argument edge",
		sources: [
			{
				file: "a.ts",
				contents: "export function wires(): void {\n\tReflect.apply(manageCommandTitle, undefined, []);\n}\n",
			},
		],
		lazyElsewhere: ["manageCommandTitle"],
		expected: ["wires"],
	},
	{
		name: "a class localizing only in a STATIC method is not inferred (the documented limit)",
		sources: [
			{
				file: "a.ts",
				contents: 'export class Statics {\n\tstatic label(): string {\n\t\treturn l10n.t("x");\n\t}\n}\n',
			},
		],
		expected: [],
	},
	{
		name: "a for-of binding stays invisible (the documented limit)",
		sources: [
			{
				file: "a.ts",
				contents:
					"export function wrap(): void {\n\tfor (const title of [manageCommandTitle]) {\n\t\ttitle();\n\t}\n}\n",
			},
		],
		lazyElsewhere: ["manageCommandTitle"],
		expected: [],
	},
	{
		name: "a call into a table the sources never declare stays invisible (no declaration, no evidence)",
		sources: [{ file: "a.ts", contents: "export function viaTable(): string {\n\treturn TABLE.entry.surface();\n}\n" }],
		expected: [],
	},
	// The thunk-table shapes shipped source resolves localized text through: a literal of l10n.t closures is a lazy
	// structure, and reading into it (by computed key, by row member, or handed back whole) is the resolver's edge.
	{
		name: "a resolver calling a thunk table by computed key is inferred (SERVER_FORM_FIELDS[field]())",
		sources: [
			{
				file: "a.ts",
				contents:
					'const FIELDS = {\n\tapiKey: () => l10n.t("API key"),\n\tbaseUrl: () => l10n.t("Base URL"),\n};\n' +
					"export function fieldLabel(field: string): string {\n\treturn FIELDS[field]();\n}\n",
			},
		],
		expected: ["FIELDS", "fieldLabel"],
	},
	{
		name: "a resolver calling a member of a table row is inferred (PRESENTATION[notice].surface())",
		sources: [
			{
				file: "a.ts",
				contents:
					'const PRESENTATION = {\n\tparams: { surface: () => l10n.t("parameters"), docs: "a" },\n};\n' +
					"export function surfaces(notices: string[]): string {\n" +
					'\treturn notices.map((notice) => PRESENTATION[notice].surface()).join(", ");\n}\n',
			},
		],
		expected: ["PRESENTATION", "surfaces"],
	},
	{
		name: "a function handing back a member of a thunk table is inferred, and so is its caller (surfaceCopy)",
		sources: [
			{
				file: "a.ts",
				contents:
					'const COPY = {\n\tchat: { timeout: (ms: number) => l10n.t("Timed out after {0} ms", ms) },\n};\n' +
					"export function surfaceCopy(surface: string) {\n\treturn COPY[surface] ?? COPY.chat;\n}\n",
			},
			{
				file: "b.ts",
				contents:
					'export function timeoutMessage(ms: number): string {\n\treturn surfaceCopy("chat").timeout(ms);\n}\n',
			},
		],
		expected: ["COPY", "surfaceCopy", "timeoutMessage"],
	},
	{
		name: "an array table of thunks is a lazy structure, and a method chain on it is the resolver's edge",
		sources: [
			{
				file: "a.ts",
				contents:
					'const FLAGS = [["vision", () => l10n.t("vision")], ["tools", () => l10n.t("tools")]] as const;\n' +
					'export function labels(): string[] {\n\treturn FLAGS.filter(([key]) => key !== "x").map(([, label]) => label());\n}\n',
			},
		],
		expected: ["FLAGS", "labels"],
	},
	{
		name: "a thunk table calling a lazy helper is lazy transitively",
		sources: [
			{
				file: "a.ts",
				contents:
					"const ROWS = {\n\tfirst: () => manageCommandTitle(),\n};\n" +
					"export function row(key: string): string {\n\treturn ROWS[key]();\n}\n",
			},
		],
		lazyElsewhere: ["manageCommandTitle"],
		expected: ["ROWS", "row"],
	},
	{
		name: "an alias of a thunk table is a table: reading into it is the same edge",
		sources: [
			{
				file: "a.ts",
				contents:
					'const TEXTS = {\n\ta: () => l10n.t("a"),\n};\nconst alias = TEXTS;\n' +
					"export function pick(key: string) {\n\treturn alias[key];\n}\n",
			},
		],
		expected: ["TEXTS", "alias", "pick"],
	},
	{
		name: "a table of plain strings is not lazy, and neither is its reader",
		sources: [
			{
				file: "a.ts",
				contents:
					'const DOCS = {\n\ta: "https://example.com/a",\n};\n' +
					"export function doc(key: string): string {\n\treturn DOCS[key];\n}\n",
			},
		],
		expected: [],
	},
	{
		name: "a member read of a lazy FUNCTION hands out no thunk, so the reader is not inferred",
		sources: [
			{
				file: "a.ts",
				contents:
					'export function label(): string {\n\treturn l10n.t("x");\n}\n' +
					"export function nameOf(): string {\n\treturn label.name;\n}\n",
			},
		],
		expected: ["label"],
	},
	{
		name: "a table embedding another table by reference stays invisible (the data-flow boundary)",
		sources: [
			{
				file: "a.ts",
				contents:
					'const INNER = {\n\ta: () => l10n.t("a"),\n};\nconst OUTER = { inner: INNER };\n' +
					"export function viaOuter(): string {\n\treturn OUTER.inner.a();\n}\n",
			},
		],
		expected: ["INNER"],
	},
	{
		name: "an IIFE-assigned variable handing back a closure over l10n.t",
		sources: [
			{
				file: "a.ts",
				contents: 'export const label = (() => {\n\treturn () => l10n.t("x");\n})();\n',
			},
		],
		expected: ["label"],
	},
	{
		name: "an import alias of a lazy helper, and the helper calling through it",
		sources: [
			{
				file: "a.ts",
				contents:
					'import { manageCommandTitle as mct } from "./titles";\n' +
					"export function wraps(): string {\n\treturn mct();\n}\n",
			},
		],
		lazyElsewhere: ["manageCommandTitle"],
		expected: ["mct", "wraps"],
	},
	{
		name: "an export alias mints a second lazy name for a helper",
		sources: [
			{
				file: "a.ts",
				contents: 'function label(): string {\n\treturn l10n.t("x");\n}\nexport { label as fancyLabel };\n',
			},
		],
		expected: ["fancyLabel", "label"],
	},
	{
		name: "a local identifier alias of a lazy helper, and the helper calling through it",
		sources: [
			{
				file: "a.ts",
				contents: "const alias = manageCommandTitle;\nexport const wraps = () => alias();\n",
			},
		],
		lazyElsewhere: ["manageCommandTitle"],
		expected: ["alias", "wraps"],
	},
	{
		name: "a FUNCTION-LOCAL alias of a lazy helper marks the enclosing helper",
		sources: [
			{
				file: "a.ts",
				contents: "export function wraps(): string {\n\tconst alias = manageCommandTitle;\n\treturn alias();\n}\n",
			},
		],
		lazyElsewhere: ["manageCommandTitle"],
		expected: ["wraps"],
	},
	{
		name: "a function-local reassignment alias marks the enclosing helper too",
		sources: [
			{
				file: "a.ts",
				contents:
					'export function wraps(): string {\n\tlet alias: () => string = () => "";\n\talias = manageCommandTitle;\n\treturn alias();\n}\n',
			},
		],
		lazyElsewhere: ["manageCommandTitle"],
		expected: ["wraps"],
	},
	{
		name: "a top-level reassignment alias is inferred in its own name",
		sources: [
			{
				file: "a.ts",
				contents:
					'let alias: () => string = () => "";\nalias = manageCommandTitle;\nexport const wraps = () => alias();\n',
			},
		],
		lazyElsewhere: ["manageCommandTitle"],
		expected: ["alias", "wraps"],
	},
	{
		name: "a helper constructed by a top-level assignment of a function literal",
		sources: [
			{
				file: "a.ts",
				contents: 'let label: () => string;\nlabel = () => l10n.t("x");\nexport const wraps = () => label();\n',
			},
		],
		expected: ["label", "wraps"],
	},
	{
		name: "a parenthesized direct call still counts as direct",
		sources: [{ file: "a.ts", contents: 'export function wrapped(): string {\n\treturn (l10n.t)("x");\n}\n' }],
		expected: ["wrapped"],
	},
	{
		name: "a parenthesized transitive callee still carries the edge",
		sources: [
			{
				file: "a.ts",
				contents: "export function missed(): string {\n\treturn (manageCommandTitle as () => string)();\n}\n",
			},
		],
		lazyElsewhere: ["manageCommandTitle"],
		expected: ["missed"],
	},
	{
		name: "a factory whose returned closure resolves l10n.t is included (the inference's over-inclusion rule)",
		sources: [
			{ file: "a.ts", contents: 'export function factory(): () => string {\n\treturn () => l10n.t("x");\n}\n' },
		],
		expected: ["factory"],
	},
	{
		name: "a parameter shadowing a lazy name marks its function (syntactic matching, the forward guard's own rule)",
		sources: [
			{
				file: "a.ts",
				contents:
					"export function callsShadow(manageCommandTitle: () => string): string {\n\treturn manageCommandTitle();\n}\n",
			},
		],
		lazyElsewhere: ["manageCommandTitle"],
		expected: ["callsShadow"],
	},
	{
		name: "a helper invoking a lazy name as a template tag",
		sources: [
			{
				file: "a.ts",
				contents: "export function tagged(): string {\n\treturn manageCommandTitle`x`;\n}\n",
			},
		],
		lazyElsewhere: ["manageCommandTitle"],
		expected: ["tagged"],
	},
	{
		name: "a helper reassigned inside module-level control flow",
		sources: [
			{
				file: "a.ts",
				contents:
					'let label: () => string = () => "";\nif (enabled) {\n\tlabel = () => l10n.t("x");\n}\nexport const wraps = () => label();\n',
			},
		],
		expected: ["label", "wraps"],
	},
	{
		name: "an alias minted in a for-initializer",
		sources: [
			{
				file: "a.ts",
				contents:
					'let alias: () => string = () => "";\nfor (alias = manageCommandTitle; keepGoing(); ) {\n\tstep();\n}\nexport const wraps = () => alias();\n',
			},
		],
		lazyElsewhere: ["manageCommandTitle"],
		expected: ["alias", "wraps"],
	},
	{
		name: "a class whose constructor localizes is inferred at any case",
		sources: [
			{
				file: "a.ts",
				contents: 'export class Notifier {\n\tconstructor() {\n\t\tl10n.t("x");\n\t}\n}\n',
			},
		],
		expected: ["Notifier"],
	},
	{
		name: "a class whose constructor calls an instance method that localizes is inferred (StatusBarManager)",
		sources: [
			{
				file: "a.ts",
				contents:
					"export class Manager {\n\tconstructor() {\n\t\tvoid this.render();\n\t}\n" +
					'\tprivate render(): string {\n\t\treturn l10n.t("x");\n\t}\n}\n',
			},
		],
		expected: ["Manager"],
	},
	{
		name: "a class whose constructor reaches localization through a chain of instance members is inferred",
		sources: [
			{
				file: "a.ts",
				contents:
					"export class Manager {\n\tconstructor() {\n\t\tthis.refresh();\n\t}\n" +
					"\tprivate refresh(): void {\n\t\tthis.label;\n\t}\n" +
					'\tprivate get label(): string {\n\t\treturn l10n.t("x");\n\t}\n}\n',
			},
		],
		expected: ["Manager"],
	},
	{
		name: "a class whose constructor hands an instance method out as a callback is inferred (the over-inclusion rule)",
		sources: [
			{
				file: "a.ts",
				contents:
					"export class Manager {\n\tconstructor(register: (render: () => string) => void) {\n" +
					"\t\tregister(() => this.render());\n\t}\n" +
					'\tprivate render(): string {\n\t\treturn l10n.t("x");\n\t}\n}\n',
			},
		],
		expected: ["Manager"],
	},
	{
		name: "a class whose constructor reaches a method declared under a literal computed name is inferred",
		sources: [
			{
				file: "a.ts",
				contents:
					'export class Manager {\n\tconstructor() {\n\t\tthis["render"]();\n\t}\n' +
					'\t["render"](): string {\n\t\treturn l10n.t("x");\n\t}\n}\n',
			},
		],
		expected: ["Manager"],
	},
	{
		name: "a class whose constructor reaches a method by numeric key is inferred",
		sources: [
			{
				file: "a.ts",
				contents:
					"export class Manager {\n\tconstructor() {\n\t\tthis[0]();\n\t}\n" +
					'\t0(): string {\n\t\treturn l10n.t("x");\n\t}\n}\n',
			},
		],
		expected: ["Manager"],
	},
	{
		name: "a class whose constructor calls a method that only calls a plain helper is not inferred",
		sources: [
			{
				file: "a.ts",
				contents:
					"export class Manager {\n\tconstructor() {\n\t\tthis.render();\n\t}\n" +
					"\tprivate render(): number {\n\t\treturn plain();\n\t}\n}\n",
			},
		],
		expected: [],
	},
	{
		name: "a class localizing only in a method is not inferred",
		sources: [
			{
				file: "a.ts",
				contents: 'export class Quiet {\n\tlabel(): string {\n\t\treturn l10n.t("x");\n\t}\n}\n',
			},
		],
		expected: [],
	},
	// The construction walk follows `this` into the class's OWN members only. A member inherited from a base is out of
	// reach, and the heritage edge covers a base that is lazy by its own construction, not one that merely declares the
	// method. A known boundary: no shipped class localizes through an inherited member at `new`.
	{
		name: "a class whose constructor reaches localization through a BASE class member is not inferred (the documented limit)",
		sources: [
			{
				file: "a.ts",
				contents:
					'export class Base {\n\trender(): string {\n\t\treturn l10n.t("x");\n\t}\n}\n' +
					"export class Derived extends Base {\n\tconstructor() {\n\t\tsuper();\n\t\tthis.render();\n\t}\n}\n",
			},
		],
		expected: [],
	},
	// Two shipped shapes (DashboardController, UsageAlerts): neither runs l10n.t at `new`, and both are inferred because
	// the roots `new` DOES evaluate are walked whole, nested function literals included.
	{
		name: "a class whose only evidence is a deferred thunk-table property is inferred",
		sources: [
			{
				file: "a.ts",
				contents:
					"export class Runner {\n" +
					"\tprivate readonly runners = {\n" +
					"\t\tgo: (payload) => executeDashboardIntent(payload),\n" +
					"\t};\n" +
					"}\n",
			},
		],
		lazyElsewhere: ["executeDashboardIntent"],
		expected: ["Runner"],
	},
	{
		name: "a class whose only evidence is a callback registered in the constructor is inferred",
		sources: [
			{
				file: "a.ts",
				contents:
					"export class Alerts {\n" +
					"\tconstructor(store: Store) {\n" +
					"\t\tstore.onDidChange(() => {\n" +
					'\t\t\tthis.show(l10n.t("x"));\n' +
					"\t\t});\n" +
					"\t}\n" +
					"}\n",
			},
		],
		expected: ["Alerts"],
	},
	{
		name: "an import alias of a lazy class is inferred under the alias",
		sources: [
			{
				file: "a.ts",
				contents:
					'import { DashboardController as RenamedBase } from "./panel";\nexport const boots = () => new RenamedBase(ctx);\n',
			},
		],
		lazyElsewhere: ["DashboardController"],
		expected: ["RenamedBase", "boots"],
	},
	// Case is no exemption: a component is a helper that localizes, and every alias shape of one is inferred.
	{
		name: "an import alias of a component is inferred",
		sources: [
			{
				file: "a.tsx",
				contents: 'import { Banner as Renamed } from "./banner";\nexport const boots = () => Renamed();\n',
			},
			{ file: "banner.tsx", contents: 'export function Banner(): string {\n\treturn l10n.t("x");\n}\n' },
		],
		expected: ["Banner", "Renamed", "boots"],
	},
	{
		name: "an export alias of a component is inferred",
		sources: [
			{
				file: "a.tsx",
				contents: 'export function Banner(): string {\n\treturn l10n.t("x");\n}\nexport { Banner as FancyBanner };\n',
			},
		],
		expected: ["Banner", "FancyBanner"],
	},
	{
		name: "an identifier alias of a component is inferred",
		sources: [
			{
				file: "a.tsx",
				contents:
					'export function Banner(): string {\n\treturn l10n.t("x");\n}\n' +
					"const Alias = Banner;\nexport const boots = () => Alias();\n",
			},
		],
		expected: ["Alias", "Banner", "boots"],
	},
	{
		name: "an import-equals entity alias of a lazy helper",
		sources: [
			{ file: "a.ts", contents: "import title = labels.manageCommandTitle;\nexport const wraps = () => title();\n" },
		],
		lazyElsewhere: ["manageCommandTitle"],
		expected: ["title", "wraps"],
	},
	{
		name: "a destructuring default is inferred in its own name",
		sources: [
			{ file: "a.ts", contents: "const { title = manageCommandTitle } = {};\nexport const wraps = () => title();\n" },
		],
		lazyElsewhere: ["manageCommandTitle"],
		expected: ["title", "wraps"],
	},
	{
		name: "a destructured parameter default marks its function",
		sources: [
			{
				file: "a.ts",
				contents: "export function wrap({ title = manageCommandTitle } = {}): string {\n\treturn title();\n}\n",
			},
		],
		lazyElsewhere: ["manageCommandTitle"],
		expected: ["wrap"],
	},
	{
		name: "a parameter default aliasing a lazy helper marks its function",
		sources: [
			{
				file: "a.ts",
				contents: "export function wrap(title = manageCommandTitle): string {\n\treturn title();\n}\n",
			},
		],
		lazyElsewhere: ["manageCommandTitle"],
		expected: ["wrap"],
	},
	{
		name: "a string-literal export specifier still mints its alias",
		sources: [
			{ file: "m.ts", contents: 'function ab(): string {\n\treturn l10n.t("x");\n}\nexport { ab as "a-b" };\n' },
			{ file: "a.ts", contents: 'export { "a-b" as title } from "./m";\nexport const wraps = () => title();\n' },
		],
		expected: ["a-b", "ab", "title", "wraps"],
	},
	{
		name: "a ternary binding is inferred through either branch",
		sources: [
			{
				file: "a.ts",
				contents: "const title = enabled ? manageCommandTitle : plain;\nexport const wraps = () => title();\n",
			},
		],
		lazyElsewhere: ["manageCommandTitle"],
		expected: ["title", "wraps"],
	},
	{
		name: "a FUNCTION-LOCAL ternary alias marks the enclosing helper",
		sources: [
			{
				file: "a.ts",
				contents:
					"export function wraps(): string {\n\tconst pick = enabled ? manageCommandTitle : plain;\n\treturn pick();\n}\n",
			},
		],
		lazyElsewhere: ["manageCommandTitle"],
		expected: ["wraps"],
	},
];
