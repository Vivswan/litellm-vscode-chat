/**
 * The guard's own teeth, proven before it judges real files: each fixture is a
 * pattern the AST walk must classify correctly, so a guard regression fails the
 * gate instead of silently passing frozen-English catalogs.
 */
export const GUARD_FIXTURES: readonly { readonly name: string; readonly source: string; readonly flagged: boolean }[] =
	[
		{
			name: "module-level template interpolating a lazy helper",
			source: `const MSG = \`run "\${manageCommandTitle()}" to configure\`;\n`,
			flagged: true,
		},
		{
			name: "multiline object literal with a t() value",
			source: 'const CATALOG = {\n\tlabel: l10n.t("Label"),\n};\n',
			flagged: true,
		},
		{
			name: "eager IIFE",
			source: 'const X = (() => l10n.t("x"))();\n',
			flagged: true,
		},
		{
			name: "satisfies-wrapped object with t()",
			source: 'const Y = { a: vscode.l10n.t("a") } satisfies Record<string, string>;\n',
			flagged: true,
		},
		{
			name: "top-level expression statement call",
			source: 'l10n.t("side effect");\n',
			flagged: true,
		},
		{
			name: "lazy arrow",
			source: 'export const f = () => l10n.t("x");\n',
			flagged: false,
		},
		{
			name: "object-literal method (deferred body)",
			source: 'const OBJ = {\n\trun() {\n\t\treturn l10n.t("x");\n\t},\n};\n',
			flagged: false,
		},
		{
			name: "object-literal get accessor (deferred body)",
			source: 'const OBJ = {\n\tget label() {\n\t\treturn l10n.t("x");\n\t},\n};\n',
			flagged: false,
		},
		{
			name: "plain exported function",
			source: 'export function g(): string {\n\treturn l10n.t("y");\n}\n',
			flagged: false,
		},
		{
			name: "static class property initializer",
			source: 'class C {\n\tstatic label = l10n.t("x");\n}\n',
			flagged: true,
		},
		{
			name: "class static block",
			source: 'class C {\n\tstatic {\n\t\tregister(l10n.t("x"));\n\t}\n}\n',
			flagged: true,
		},
		{
			name: "heritage clause expression",
			source: 'class C extends mixin(l10n.t("x")) {}\n',
			flagged: true,
		},
		{
			name: "default export call",
			source: 'export default l10n.t("x");\n',
			flagged: true,
		},
		{
			name: "top-level control flow",
			source: 'if (flag) {\n\tregister(l10n.t("x"));\n}\n',
			flagged: true,
		},
		{
			name: "instance property initializer (deferred to construction)",
			source: 'class C {\n\tlabel = l10n.t("x");\n}\n',
			flagged: false,
		},
		{
			name: "class method (deferred body)",
			source: 'class C {\n\trun(): string {\n\t\treturn l10n.t("x");\n\t}\n}\n',
			flagged: false,
		},
		{
			name: "computed static member name",
			source: 'class C {\n\tstatic [l10n.t("x")] = 1;\n}\n',
			flagged: true,
		},
		{
			name: "computed instance member name (evaluates at class definition)",
			source: 'class C {\n\t[l10n.t("x")](): void {}\n}\n',
			flagged: true,
		},
		{
			name: "decorator argument",
			source: '@dec(l10n.t("x"))\nclass C {}\n',
			flagged: true,
		},
		{
			name: "type-wrapped lazy-helper call at module scope",
			source: "const TITLE = (manageCommandTitle as () => string)();\n",
			flagged: true,
		},
		{
			name: "parenthesized t call at module scope",
			source: 'const TITLE = (l10n.t)("x");\n',
			flagged: true,
		},
		{
			// Forwarding stripped: .call/.apply/.bind cannot launder a freeze past
			// the callee match (vscodeL10nOffenses bans this shape too).
			name: "t invoked through .call at module scope",
			source: 'const TITLE = l10n.t.call(undefined, "x");\n',
			flagged: true,
		},
		{
			name: "a lazy helper invoked through .call at module scope",
			source: "const TITLE = manageCommandTitle.call(undefined);\n",
			flagged: true,
		},
		{
			name: "a lazy helper invoked through .apply at module scope",
			source: "const TITLE = manageCommandTitle.apply(undefined, []);\n",
			flagged: true,
		},
		{
			name: "a lazy helper bound and invoked at module scope",
			source: "const TITLE = manageCommandTitle.bind(undefined)();\n",
			flagged: true,
		},
		{
			name: "a lazy helper invoked through a literal element-access .call at module scope",
			source: 'const TITLE = manageCommandTitle["call"](undefined);\n',
			flagged: true,
		},
		{
			name: "a lazy helper invoked through a computed member at module scope",
			source: "const TITLE = manageCommandTitle[member]();\n",
			flagged: true,
		},
		{
			name: "a lazy helper called through a local namespace import at module scope",
			source: 'import * as helpers from "./helpers";\nconst FROZEN = helpers.manageCommandTitle();\n',
			flagged: true,
		},
		{
			name: "a lazy member element-accessed off a local namespace import at module scope",
			source: 'import * as helpers from "./helpers";\nconst FROZEN = helpers["manageCommandTitle"]();\n',
			flagged: true,
		},
		{
			name: "a lazy member aliased off a local namespace import and called at module scope",
			source:
				'import * as helpers from "./helpers";\nconst alias = helpers.manageCommandTitle;\nconst FROZEN = alias();\n',
			flagged: true,
		},
		{
			name: "a local namespace member invoked through .call at module scope",
			source: 'import * as helpers from "./helpers";\nconst FROZEN = helpers.manageCommandTitle.call(undefined);\n',
			flagged: true,
		},
		{
			name: "a package namespace member call stays quiet (members are not census names)",
			source: 'import * as helpers from "helpers";\nconst OK = helpers.manageCommandTitle();\n',
			flagged: false,
		},
		{
			name: "a thunk-table property call stays outside the callee match (the documented limit)",
			source: "const OK = TABLE.manageCommandTitle();\n",
			flagged: false,
		},
		{
			name: "a lazy helper passed as an argument at module scope stays quiet (a reference, not an invocation)",
			source: "register(manageCommandTitle);\n",
			flagged: false,
		},
		{
			name: "a comma-expression callee resolves to its result",
			source: "const TITLE = (0, manageCommandTitle)();\n",
			flagged: true,
		},
		{
			name: "a ternary callee flags through either branch",
			source: "const TITLE = (enabled ? manageCommandTitle : plain)();\n",
			flagged: true,
		},
		{
			name: "a logical-fallback callee flags through either side",
			source: "const TITLE = (custom ?? manageCommandTitle)();\n",
			flagged: true,
		},
		{
			name: "a ternary callee of untracked names stays quiet",
			source: "const VALUE = (enabled ? firstThing : secondThing)();\n",
			flagged: false,
		},
		{
			name: "a function literal in one callee branch evaluates eagerly",
			source: 'const TITLE = (enabled ? () => l10n.t("x") : plain)();\n',
			flagged: true,
		},
		{
			// The composition: stripping exposes a fresh choosing shape underneath,
			// and the resolution re-flattens to a fixed point.
			name: "a ternary receiver behind .call flags through either branch",
			source: "const TITLE = (enabled ? manageCommandTitle : plain).call(undefined);\n",
			flagged: true,
		},
		{
			name: "a comma receiver behind .call resolves to its result",
			source: "const TITLE = (0, manageCommandTitle).call(undefined);\n",
			flagged: true,
		},
		{
			name: "a logical-fallback receiver behind .apply flags through either side",
			source: "const TITLE = (custom ?? manageCommandTitle).apply(undefined, []);\n",
			flagged: true,
		},
		{
			name: "a ternary receiver bound and invoked flags",
			source: "const TITLE = (enabled ? manageCommandTitle : plain).bind(undefined)();\n",
			flagged: true,
		},
		{
			name: "an inline function in a ternary receiver behind .call evaluates eagerly",
			source: 'const TITLE = (enabled ? () => l10n.t("a") : plain).call(undefined);\n',
			flagged: true,
		},
		{
			name: "a ternary receiver of untracked names behind .call stays quiet",
			source: "const VALUE = (enabled ? someThing : otherThing).call(undefined);\n",
			flagged: false,
		},
		{
			name: "a ternary receiver behind a computed member call flags through either branch",
			source: "const TITLE = (enabled ? manageCommandTitle : plain)[member]();\n",
			flagged: true,
		},
		{
			name: "an inline function in a ternary receiver behind a computed member call evaluates eagerly",
			source: 'const TITLE = (enabled ? () => l10n.t("a") : plain)[member]();\n',
			flagged: true,
		},
		{
			name: "a forwarder in a choosing receiver behind .call still forwards",
			source: "const TITLE = (enabled ? Reflect.apply : plain).call(Reflect, manageCommandTitle, undefined, []);\n",
			flagged: true,
		},
		{
			name: "a logical-assignment callee resolves to either side",
			source: "let held: (() => string) | undefined;\nconst TITLE = (held ||= manageCommandTitle)();\n",
			flagged: true,
		},
		{
			name: "an inline function constructed with new runs its body",
			source: 'const FROZEN = new (function () {\n\tregister(l10n.t("x"));\n})();\n',
			flagged: true,
		},
		{
			name: "a computed member call on an inline function evaluates it",
			source: 'const FROZEN = (() => l10n.t("x"))[member]();\n',
			flagged: true,
		},
		{
			name: "an inline class extending a lazy local namespace member",
			source:
				'import * as helpers from "./h";\nconst FROZEN = new (class extends helpers.DashboardController {})(context);\n',
			flagged: true,
		},
		{
			// bind evaluates nothing itself, but a module-scope bind of a lazy
			// helper only exists to be called; flagging it is deliberate.
			name: "a lazy helper bound without invocation still flags",
			source: "const HELD = manageCommandTitle.bind(undefined);\n",
			flagged: true,
		},
		{
			name: "an ordinary member call on a name sharing a census spelling stays quiet",
			source: "const ROWS = railSections.map((entry) => entry);\n",
			flagged: false,
		},
		{
			name: "toString on a lazy helper stays quiet (no localization runs)",
			source: "const SOURCE = manageCommandTitle.toString();\n",
			flagged: false,
		},
		{
			name: "Reflect.apply of a lazy helper at module scope",
			source: "const TITLE = Reflect.apply(manageCommandTitle, undefined, []);\n",
			flagged: true,
		},
		{
			name: "Reflect.construct of a lazy class at module scope",
			source: "const PANEL = Reflect.construct(DashboardController, [context]);\n",
			flagged: true,
		},
		{
			name: "Function.prototype.call.call of a lazy helper at module scope",
			source: "const TITLE = Function.prototype.call.call(manageCommandTitle, undefined);\n",
			flagged: true,
		},
		{
			name: "Reflect.apply of an untracked name stays quiet",
			source: "const VALUE = Reflect.apply(somethingElse, undefined, []);\n",
			flagged: false,
		},
		{
			// .call shifts the forwarder's target one slot right; every direct
			// argument of a recognized forwarder is checked.
			name: "Reflect.apply forwarded through .call still flags",
			source: "const TITLE = Reflect.apply.call(Reflect, manageCommandTitle, undefined, []);\n",
			flagged: true,
		},
		{
			name: "Reflect.apply of an inline function evaluates it",
			source: 'const TITLE = Reflect.apply(() => l10n.t("x"), undefined, []);\n',
			flagged: true,
		},
		{
			name: "Reflect.construct of an inline localizing class",
			source: 'const FROZEN = Reflect.construct(\n\tclass {\n\t\tlabel = l10n.t("x");\n\t},\n\t[]\n);\n',
			flagged: true,
		},
		{
			name: "a non-forwarder Reflect member keeps a tracked argument as a reference",
			source: "const KEYS = Reflect.ownKeys(manageCommandTitle);\n",
			flagged: false,
		},
		{
			// Text matching is the decision (see isCallerForwarder): a re-spelled
			// forwarder stays outside, like every custom wrapper.
			name: "a globalThis-spelled forwarder stays quiet (the documented boundary)",
			source: "const TITLE = globalThis.Reflect.apply(manageCommandTitle, undefined, []);\n",
			flagged: false,
		},
		{
			name: "a rebound Reflect forwarder stays quiet (the documented boundary)",
			source: "const R = Reflect;\nconst TITLE = R.apply(manageCommandTitle, undefined, []);\n",
			flagged: false,
		},
		{
			// A spread is a value in a structure - the documented data-flow boundary.
			name: "a spread argument to a forwarder stays quiet (the documented limit)",
			source: "const TITLE = Reflect.apply(...[manageCommandTitle]);\n",
			flagged: false,
		},
		{
			name: "an inline function invoked through .call evaluates eagerly",
			source: 'const FROZEN = (() => l10n.t("x")).call(undefined);\n',
			flagged: true,
		},
		{
			name: "an inline localizing class constructed from a callee branch",
			source: 'const FROZEN = new (enabled\n\t? class {\n\t\t\tlabel = l10n.t("x");\n\t\t}\n\t: Plain)();\n',
			flagged: true,
		},
		{
			name: "a computed member call on a lazy local namespace member",
			source: 'import * as helpers from "./h";\nconst FROZEN = helpers.manageCommandTitle[member]();\n',
			flagged: true,
		},
		{
			// The namespace's `call` export is a module member, not Function.prototype:
			// stripping must stop at the namespace read.
			name: "a local namespace member named call still resolves as a member",
			source: 'import * as helpers from "./h";\nconst call = () => l10n.t("x");\nconst FROZEN = helpers.call();\n',
			flagged: true,
		},
		{
			// Statics stay out of construction evidence, so the class is not lazy and
			// the member call is unreadable - the documented boundary, not a hole
			// this guard claims to cover.
			name: "a member call reaching a localizing class static stays quiet (the documented limit)",
			source: 'class C {\n\tstatic label(): string {\n\t\treturn l10n.t("x");\n\t}\n}\nconst TITLE = C.label();\n',
			flagged: false,
		},
		{
			name: "a constructor's destructured parameter default evaluates at new",
			source:
				'class C {\n\tconstructor({ text = l10n.t("x") } = {}) {\n\t\tthis.t = text;\n\t}\n}\nconst FROZEN = new C();\n',
			flagged: true,
		},
		{
			name: "the same class left uninstantiated",
			source: 'export class C {\n\tconstructor({ text = l10n.t("x") } = {}) {\n\t\tthis.t = text;\n\t}\n}\n',
			flagged: false,
		},
		{
			name: "a destructured parameter default evaluates with the call",
			source: 'const FROZEN = (({ text = l10n.t("x") }) => text)({});\n',
			flagged: true,
		},
		{
			// The SECOND parameter: a tag's first receives the strings array.
			name: "a template tag's parameter default evaluates with the tag",
			source: 'const FROZEN = ((strings, text = l10n.t("x")) => text)`y`;\n',
			flagged: true,
		},
		{
			name: "an invoked function's parameter default evaluates with the call",
			source: 'const FROZEN = ((text = l10n.t("x")) => text)();\n',
			flagged: true,
		},
		{
			name: "a parameter default binding a lazy helper, invoked at module scope",
			source: "function wrap(title = manageCommandTitle) {\n\treturn title();\n}\nconst FROZEN = wrap();\n",
			flagged: true,
		},
		{
			name: "the same parameter default left uninvoked",
			source: 'export const f = (text = l10n.t("x")) => text;\n',
			flagged: false,
		},
		{
			name: "eager IIFE laundering a helper through a local alias",
			source: "const FROZEN = (() => {\n\tconst alias = manageCommandTitle;\n\treturn alias();\n})();\n",
			flagged: true,
		},
		{
			name: "top-level alias of a helper called at module scope",
			source: "const alias = manageCommandTitle;\nconst FROZEN = alias();\n",
			flagged: true,
		},
		{
			name: "top-level reassignment alias called at module scope",
			source: 'let alias = () => "";\nalias = manageCommandTitle;\nconst FROZEN = alias();\n',
			flagged: true,
		},
		{
			name: "an alias of a non-lazy name stays quiet",
			source: "const alias = somethingElse;\nconst VALUE = alias();\n",
			flagged: false,
		},
		{
			name: "a module-scope loop calling before reassigning (evaluation order beats source order)",
			source: 'let alias = () => "";\nfor (let i = 0; i < 2; i += 1) {\n\talias();\n\talias = manageCommandTitle;\n}\n',
			flagged: true,
		},
		{
			name: "a helper constructed by assignment and called at module scope",
			source: 'let label: () => string;\nlabel = () => l10n.t("x");\nconst FROZEN = label();\n',
			flagged: true,
		},
		{
			name: "a locally declared lazy arrow called at module scope",
			source: 'const f = () => l10n.t("x");\nconst FROZEN = f();\n',
			flagged: true,
		},
		{
			name: "a locally declared lazy arrow merely referenced stays quiet",
			source: 'const f = () => l10n.t("x");\nexport const g = () => f();\n',
			flagged: false,
		},
		{
			name: "a function declared inside an eager IIFE and called there",
			source:
				'const X = (() => {\n\tfunction local(): string {\n\t\treturn l10n.t("x");\n\t}\n\treturn local();\n})();\n',
			flagged: true,
		},
		{
			name: "an alias buried inside an assigned function literal, called at module scope",
			source:
				"let label: () => string;\nlabel = () => {\n\tconst a = manageCommandTitle;\n\treturn a();\n};\nconst FROZEN = label();\n",
			flagged: true,
		},
		{
			name: "a lazy helper invoked as a template tag at module scope",
			source: "const FROZEN = manageCommandTitle`x`;\n",
			flagged: true,
		},
		{
			name: "a lazy helper invoked with new at module scope",
			source: "const FROZEN = new manageCommandTitle();\n",
			flagged: true,
		},
		{
			name: "a bare-name decorator runs at class definition",
			source: "@manageCommandTitle\nclass C {}\n",
			flagged: true,
		},
		{
			name: "constructing a class whose constructor localizes",
			source: 'class LazyCtor {\n\tconstructor() {\n\t\tl10n.t("x");\n\t}\n}\nconst FROZEN = new LazyCtor();\n',
			flagged: true,
		},
		{
			name: "constructing an inline class whose constructor localizes",
			source: 'const FROZEN = new (class {\n\tconstructor() {\n\t\tl10n.t("x");\n\t}\n})();\n',
			flagged: true,
		},
		{
			name: "constructing a class that localizes only in a method stays quiet",
			source: 'class Ok {\n\tlabel(): string {\n\t\treturn l10n.t("x");\n\t}\n}\nconst INSTANCE = new Ok();\n',
			flagged: false,
		},
		{
			name: "constructing a renamed import of a lazy class",
			source: 'import { DashboardController as Renamed } from "./panel";\nconst FROZEN = new Renamed(context);\n',
			flagged: true,
		},
		{
			name: "constructing an inline class whose constructor PARAMETER DEFAULT localizes",
			source: 'const FROZEN = new (class {\n\tconstructor(x = l10n.t("x")) {\n\t\tvoid x;\n\t}\n})();\n',
			flagged: true,
		},
		{
			name: "constructing an inline class extending a lazy base",
			source: "const FROZEN = new (class extends DashboardController {})(context);\n",
			flagged: true,
		},
		{
			name: "a ternary binding whose one branch is a lazy helper, called at module scope",
			source: "const title = enabled ? manageCommandTitle : plain;\nconst FROZEN = title();\n",
			flagged: true,
		},
		{
			name: "a logical-fallback binding of a lazy helper, called at module scope",
			source: "const title = custom ?? manageCommandTitle;\nconst FROZEN = title();\n",
			flagged: true,
		},
		{
			name: "a compound logical assignment of a lazy helper, called at module scope",
			source: 'let title: () => string = () => "";\ntitle ??= manageCommandTitle;\nconst FROZEN = title();\n',
			flagged: true,
		},
	];
