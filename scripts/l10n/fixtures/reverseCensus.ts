/**
 * The reverse census walk's own teeth: each fixture's expected findings are the
 * exact set the walk must produce. expectedLines pins WHERE a finding points,
 * in the same name-sorted order as expected.
 */
export const REVERSE_CENSUS_FIXTURES: readonly {
	readonly name: string;
	readonly sources: readonly { readonly file: string; readonly contents: string }[];
	readonly census: readonly string[];
	readonly expected: readonly string[];
	readonly expectedLines?: readonly number[];
}[] = [
	{
		name: "an overload set points the finding at the implementation, not the first signature",
		sources: [
			{
				file: "a.ts",
				contents:
					"export function label(value: number): string;\n" +
					"export function label(value: string): string;\n" +
					'export function label(value: unknown): string {\n\treturn l10n.t("x", String(value));\n}\n',
			},
		],
		census: [],
		expected: ["label"],
		expectedLines: [3],
	},
	{
		name: "direct l10n.t caller missing from the census",
		sources: [{ file: "a.ts", contents: 'export function label(): string {\n\treturn l10n.t("x");\n}\n' }],
		census: [],
		expected: ["label"],
	},
	{
		name: "vscode.l10n.t counts as direct",
		sources: [{ file: "a.ts", contents: 'export const label = () => vscode.l10n.t("x");\n' }],
		census: [],
		expected: ["label"],
	},
	{
		name: "transitive through a censused name",
		sources: [{ file: "a.ts", contents: "export function wrap(): string {\n\treturn censusedHelper();\n}\n" }],
		census: ["censusedHelper"],
		expected: ["wrap"],
	},
	{
		name: "transitive chain across files, both links reported",
		sources: [
			{ file: "a.ts", contents: "export function outer(): string {\n\treturn inner();\n}\n" },
			{ file: "b.ts", contents: 'export function inner(): string {\n\treturn l10n.t("x");\n}\n' },
		],
		census: [],
		expected: ["inner", "outer"],
	},
	{
		name: "a default parameter resolves l10n.t",
		sources: [{ file: "a.ts", contents: 'export function f(text = l10n.t("d")): string {\n\treturn text;\n}\n' }],
		census: [],
		expected: ["f"],
	},
	{
		name: "an arrow-function variable is a helper too",
		sources: [{ file: "a.ts", contents: 'export const g = () => l10n.t("x");\n' }],
		census: [],
		expected: ["g"],
	},
	{
		name: "a censused helper raises nothing",
		sources: [{ file: "a.ts", contents: 'export function label(): string {\n\treturn l10n.t("x");\n}\n' }],
		census: ["label"],
		expected: [],
	},
	{
		name: "an uppercase component is not reported but still carries edges",
		sources: [
			{
				file: "a.tsx",
				contents:
					'export function Banner(): string {\n\treturn l10n.t("x");\n}\n' +
					"export function callsComponent(): string {\n\treturn Banner();\n}\n",
			},
		],
		census: [],
		expected: ["callsComponent"],
	},
	{
		name: "a helper with no l10n path raises nothing",
		sources: [{ file: "a.ts", contents: "export function plain(): number {\n\treturn 1 + 1;\n}\n" }],
		census: [],
		expected: [],
	},
	{
		// The parameter name `title` still binds a value in flight and is never
		// followed; the ARGUMENT reference is the binding's own edge now.
		name: "an argument-position helper taints the binding it feeds (the parameter name stays unfollowed)",
		sources: [{ file: "a.ts", contents: "export const wraps = ((title) => () => title())(manageCommandTitle);\n" }],
		census: ["manageCommandTitle"],
		expected: ["wraps"],
	},
	{
		name: "a helper passing a censused helper as a direct argument is an obligation",
		sources: [{ file: "a.ts", contents: "export function wires(): void {\n\tregister(manageCommandTitle);\n}\n" }],
		census: ["manageCommandTitle"],
		expected: ["wires"],
	},
	{
		name: "a helper passing a censused helper behind a ternary argument is an obligation",
		sources: [
			{
				file: "a.ts",
				contents: "export function wires(): void {\n\tregister(enabled ? manageCommandTitle : plain);\n}\n",
			},
		],
		census: ["manageCommandTitle"],
		expected: ["wires"],
	},
	{
		name: "a helper nested inside an array-literal argument stays invisible (the documented limit)",
		sources: [{ file: "a.ts", contents: "export function wires(): void {\n\tregister([manageCommandTitle]);\n}\n" }],
		census: ["manageCommandTitle"],
		expected: [],
	},
	{
		name: "a spread argument stays invisible (the documented limit)",
		sources: [{ file: "a.ts", contents: "export function wires(): void {\n\tregister(...[manageCommandTitle]);\n}\n" }],
		census: ["manageCommandTitle"],
		expected: [],
	},
	{
		name: "a helper forwarding a censused helper through .call is an obligation",
		sources: [
			{
				file: "a.ts",
				contents: "export function wraps(): string {\n\treturn manageCommandTitle.call(undefined);\n}\n",
			},
		],
		census: ["manageCommandTitle"],
		expected: ["wraps"],
	},
	{
		name: "l10n.t forwarded through .call still reads as direct",
		sources: [
			{ file: "a.ts", contents: 'export function wraps(): string {\n\treturn l10n.t.call(undefined, "x");\n}\n' },
		],
		census: [],
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
		census: [],
		expected: ["title", "wraps"],
	},
	{
		name: "a censused member called through a local namespace import is an obligation",
		sources: [
			{
				file: "a.ts",
				contents:
					'import * as helpers from "./titles";\nexport function wraps(): string {\n\treturn helpers.title();\n}\n',
			},
		],
		census: ["title"],
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
		census: ["title"],
		expected: ["wires"],
	},
	{
		name: "a local namespace member bound to an alias is a member-named obligation",
		sources: [
			{
				file: "a.ts",
				contents:
					'import * as helpers from "./titles";\nconst alias = helpers.title;\nexport const wraps = () => alias();\n',
			},
		],
		census: ["title"],
		expected: ["alias", "wraps"],
	},
	{
		name: "a censused member element-accessed through a local namespace import is an obligation",
		sources: [
			{
				file: "a.ts",
				contents:
					'import * as helpers from "./titles";\nexport function wraps(): string {\n\treturn helpers["title"]();\n}\n',
			},
		],
		census: ["title"],
		expected: ["wraps"],
	},
	{
		name: "a package namespace member call stays invisible (members are not census names)",
		sources: [
			{
				file: "a.ts",
				contents:
					'import * as path from "node:path";\nexport function wraps(): string {\n\treturn path.join("a", "b");\n}\n',
			},
		],
		census: ["join"],
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
		census: ["title"],
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
		census: ["manageCommandTitle"],
		expected: ["wraps"],
	},
	{
		name: "a computed member call on a censused local namespace member edges that member",
		sources: [
			{
				file: "a.ts",
				contents:
					'import * as helpers from "./t";\nexport function wraps(): string {\n\treturn helpers.title[member]();\n}\n',
			},
		],
		census: ["title"],
		expected: ["wraps"],
	},
	{
		name: "a literal element-access thunk-table call stays invisible (the documented limit)",
		sources: [{ file: "a.ts", contents: 'export function via(): string {\n\treturn TABLE["surface"]();\n}\n' }],
		census: [],
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
		census: ["call"],
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
		census: ["manageCommandTitle"],
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
		census: ["manageCommandTitle"],
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
		census: ["manageCommandTitle"],
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
		census: ["manageCommandTitle"],
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
		census: ["manageCommandTitle"],
		expected: ["grab", "wraps"],
	},
	{
		name: "a class extending a censused local namespace member is an obligation",
		sources: [
			{
				file: "a.ts",
				contents: 'import * as helpers from "./t";\nexport class Derived extends helpers.Base {}\n',
			},
		],
		census: ["Base"],
		expected: ["Derived"],
	},
	{
		// Matching is by spelling, the guard's own rule: a scalar parameter
		// sharing a census name taints its helper. Deliberate over-inclusion.
		name: "an argument sharing a census spelling taints its helper (syntactic matching, pinned intentional)",
		sources: [
			{
				file: "a.ts",
				contents: "export function sends(formatValue: number): string {\n\treturn String(formatValue);\n}\n",
			},
		],
		census: ["formatValue"],
		expected: ["sends"],
	},
	{
		name: "Reflect.apply of a censused helper taints the caller through the argument edge",
		sources: [
			{
				file: "a.ts",
				contents: "export function wires(): void {\n\tReflect.apply(manageCommandTitle, undefined, []);\n}\n",
			},
		],
		census: ["manageCommandTitle"],
		expected: ["wires"],
	},
	{
		name: "a class localizing only in a STATIC method stays out of the census (the documented limit)",
		sources: [
			{
				file: "a.ts",
				contents: 'export class Statics {\n\tstatic label(): string {\n\t\treturn l10n.t("x");\n\t}\n}\n',
			},
		],
		census: [],
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
		census: ["manageCommandTitle"],
		expected: [],
	},
	{
		name: "a thunk-table property call stays invisible (the documented census limit)",
		sources: [{ file: "a.ts", contents: "export function viaTable(): string {\n\treturn TABLE.entry.surface();\n}\n" }],
		census: [],
		expected: [],
	},
	{
		name: "an IIFE-assigned variable handing back a closure over l10n.t",
		sources: [
			{
				file: "a.ts",
				contents: 'export const label = (() => {\n\treturn () => l10n.t("x");\n})();\n',
			},
		],
		census: [],
		expected: ["label"],
	},
	{
		name: "an import alias of a censused helper, and the helper calling through it",
		sources: [
			{
				file: "a.ts",
				contents:
					'import { manageCommandTitle as mct } from "./titles";\n' +
					"export function wraps(): string {\n\treturn mct();\n}\n",
			},
		],
		census: ["manageCommandTitle"],
		expected: ["mct", "wraps"],
	},
	{
		name: "an export alias mints a second census obligation for a lazy helper",
		sources: [
			{
				file: "a.ts",
				contents: 'function label(): string {\n\treturn l10n.t("x");\n}\nexport { label as fancyLabel };\n',
			},
		],
		census: [],
		expected: ["fancyLabel", "label"],
	},
	{
		name: "a local identifier alias of a censused helper, and the helper calling through it",
		sources: [
			{
				file: "a.ts",
				contents: "const alias = manageCommandTitle;\nexport const wraps = () => alias();\n",
			},
		],
		census: ["manageCommandTitle"],
		expected: ["alias", "wraps"],
	},
	{
		name: "a FUNCTION-LOCAL alias of a censused helper marks the enclosing helper",
		sources: [
			{
				file: "a.ts",
				contents: "export function wraps(): string {\n\tconst alias = manageCommandTitle;\n\treturn alias();\n}\n",
			},
		],
		census: ["manageCommandTitle"],
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
		census: ["manageCommandTitle"],
		expected: ["wraps"],
	},
	{
		name: "a top-level reassignment alias is its own census obligation",
		sources: [
			{
				file: "a.ts",
				contents:
					'let alias: () => string = () => "";\nalias = manageCommandTitle;\nexport const wraps = () => alias();\n',
			},
		],
		census: ["manageCommandTitle"],
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
		census: [],
		expected: ["label", "wraps"],
	},
	{
		name: "a parenthesized direct call still counts as direct",
		sources: [{ file: "a.ts", contents: 'export function wrapped(): string {\n\treturn (l10n.t)("x");\n}\n' }],
		census: [],
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
		census: ["manageCommandTitle"],
		expected: ["missed"],
	},
	{
		name: "a factory whose returned closure resolves l10n.t is included (the census's over-inclusion rule)",
		sources: [
			{ file: "a.ts", contents: 'export function factory(): () => string {\n\treturn () => l10n.t("x");\n}\n' },
		],
		census: [],
		expected: ["factory"],
	},
	{
		name: "a parameter shadowing a censused name marks its function (syntactic matching, the forward guard's own rule)",
		sources: [
			{
				file: "a.ts",
				contents:
					"export function callsShadow(manageCommandTitle: () => string): string {\n\treturn manageCommandTitle();\n}\n",
			},
		],
		census: ["manageCommandTitle"],
		expected: ["callsShadow"],
	},
	{
		name: "a helper invoking a censused name as a template tag",
		sources: [
			{
				file: "a.ts",
				contents: "export function tagged(): string {\n\treturn manageCommandTitle`x`;\n}\n",
			},
		],
		census: ["manageCommandTitle"],
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
		census: [],
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
		census: ["manageCommandTitle"],
		expected: ["alias", "wraps"],
	},
	{
		name: "a class whose constructor localizes is a census obligation at any case",
		sources: [
			{
				file: "a.ts",
				contents: 'export class Notifier {\n\tconstructor() {\n\t\tl10n.t("x");\n\t}\n}\n',
			},
		],
		census: [],
		expected: ["Notifier"],
	},
	{
		name: "a class localizing only in a method stays out of the census",
		sources: [
			{
				file: "a.ts",
				contents: 'export class Quiet {\n\tlabel(): string {\n\t\treturn l10n.t("x");\n\t}\n}\n',
			},
		],
		census: [],
		expected: [],
	},
	// The two shapes the real registered classes have: neither runs l10n.t at
	// `new`, and both are obligations because the roots `new` DOES evaluate are
	// walked whole. Tightening that walk to skip nested function literals would
	// drop DashboardController and UsageAlerts with no other fixture noticing.
	{
		name: "a class whose only evidence is a deferred thunk-table property is an obligation",
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
		census: ["executeDashboardIntent"],
		expected: ["Runner"],
	},
	{
		name: "a class whose only evidence is a callback registered in the constructor is an obligation",
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
		census: [],
		expected: ["Alerts"],
	},
	{
		name: "an UPPERCASE import alias of an unresolvable lazy name reports (alias resolution fails closed)",
		sources: [
			{
				file: "a.ts",
				contents:
					'import { DashboardController as RenamedBase } from "./panel";\nexport const boots = () => new RenamedBase(ctx);\n',
			},
		],
		census: ["DashboardController"],
		expected: ["RenamedBase", "boots"],
	},
	// An alias is exempt only where its own spelling AND its target agree.
	// Every direction, for each of the three aliasing shapes.
	{
		name: "an UPPERCASE import alias of an uppercase component inherits its exemption",
		sources: [
			{
				file: "a.tsx",
				contents: 'import { Banner as Renamed } from "./banner";\nexport const boots = () => Renamed();\n',
			},
			{ file: "banner.tsx", contents: 'export function Banner(): string {\n\treturn l10n.t("x");\n}\n' },
		],
		census: [],
		expected: ["boots"],
	},
	{
		name: "an UPPERCASE export alias of an uppercase component inherits its exemption",
		sources: [
			{
				file: "a.tsx",
				contents: 'export function Banner(): string {\n\treturn l10n.t("x");\n}\nexport { Banner as FancyBanner };\n',
			},
		],
		census: [],
		expected: [],
	},
	{
		name: "an UPPERCASE identifier alias of an uppercase component inherits its exemption",
		sources: [
			{
				file: "a.tsx",
				contents:
					'export function Banner(): string {\n\treturn l10n.t("x");\n}\n' +
					"const Alias = Banner;\nexport const boots = () => Alias();\n",
			},
		],
		census: [],
		expected: ["boots"],
	},
	{
		name: "an import-equals entity alias of a censused helper",
		sources: [
			{ file: "a.ts", contents: "import title = labels.manageCommandTitle;\nexport const wraps = () => title();\n" },
		],
		census: ["manageCommandTitle"],
		expected: ["title", "wraps"],
	},
	{
		name: "a destructuring default is its own census obligation",
		sources: [
			{ file: "a.ts", contents: "const { title = manageCommandTitle } = {};\nexport const wraps = () => title();\n" },
		],
		census: ["manageCommandTitle"],
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
		census: ["manageCommandTitle"],
		expected: ["wrap"],
	},
	{
		name: "a parameter default aliasing a censused helper marks its function",
		sources: [
			{
				file: "a.ts",
				contents: "export function wrap(title = manageCommandTitle): string {\n\treturn title();\n}\n",
			},
		],
		census: ["manageCommandTitle"],
		expected: ["wrap"],
	},
	{
		name: "a string-literal export specifier still mints its alias",
		sources: [
			{ file: "a.ts", contents: 'export { "a-b" as title } from "./m";\nexport const wraps = () => title();\n' },
		],
		census: ["a-b"],
		expected: ["title", "wraps"],
	},
	{
		name: "a LOWERCASE alias of an uppercase component is an obligation (the exemption is the convention, not the code)",
		sources: [
			{
				file: "a.tsx",
				contents: 'export function Banner(): string {\n\treturn l10n.t("x");\n}\nexport { Banner as label };\n',
			},
			{ file: "b.ts", contents: 'import { label } from "./a";\nexport const FROZEN = label();\n' },
		],
		census: [],
		expected: ["label"],
	},
	{
		name: "an UPPERCASE import alias of a lowercase lazy helper is still an obligation",
		sources: [
			{ file: "a.ts", contents: 'import { label as Label } from "./labels";\nexport const wraps = () => Label();\n' },
			{ file: "labels.ts", contents: 'export function label(): string {\n\treturn l10n.t("x");\n}\n' },
		],
		census: [],
		expected: ["Label", "label", "wraps"],
	},
	{
		name: "an UPPERCASE export alias of a lowercase lazy helper is still an obligation",
		sources: [
			{ file: "a.ts", contents: 'function label(): string {\n\treturn l10n.t("x");\n}\nexport { label as Label };\n' },
		],
		census: [],
		expected: ["Label", "label"],
	},
	{
		name: "an UPPERCASE identifier alias of a lowercase lazy helper is still an obligation",
		sources: [
			{
				file: "a.ts",
				contents:
					'function label(): string {\n\treturn l10n.t("x");\n}\n' +
					"const Alias = label;\nexport const wraps = () => Alias();\n",
			},
		],
		census: [],
		expected: ["Alias", "label", "wraps"],
	},
	{
		name: "a ternary binding reaches the census through either branch",
		sources: [
			{
				file: "a.ts",
				contents: "const title = enabled ? manageCommandTitle : plain;\nexport const wraps = () => title();\n",
			},
		],
		census: ["manageCommandTitle"],
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
		census: ["manageCommandTitle"],
		expected: ["wraps"],
	},
];
