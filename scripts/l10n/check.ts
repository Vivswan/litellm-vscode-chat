/**
 * The l10n gate (pre-commit, and CI's format-check job). Every file is parsed
 * through a zod schema (nothing is cast), and one bad file records its failure
 * and lets the rest of the run continue. It fails when:
 *
 * - the committed English bundle is not byte-identical to a fresh extraction;
 * - one message is minted under two different bundle keys (a forked comment);
 * - a localized string is resolved at module scope;
 * - a top-level helper or class reaching a localized string is missing from
 *   the lazy-helper census, or a census entry no longer names a declaration;
 * - shipped source default-exports anything (it breaks the census walks'
 *   name-following);
 * - the source localizes through vscode's l10n API instead of @vscode/l10n's
 *   canonical import form;
 * - a translation file's key set drifts from its English reference;
 * - a translated value's {0} placeholders differ from the English value's;
 * - a translated value drops or rewrites a preserved token (a $(codicon), a
 *   command:<id> occurrence, or a markdown link target);
 * - a translation file carries banned typography;
 * - the bundle and package.nls locale sets disagree;
 * - package.json's %key% references and package.nls.json disagree.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
// Shared with the guard suites; they live under src/test because the
// extension-host tsconfig cannot compile imports from scripts/.
import { bannedTypography, placeholderCounts } from "../../src/test/util/l10n";
import {
	BUNDLE_PATH,
	type BundleFile,
	bundleMessage,
	bundleSchema,
	declaredCensusNames,
	defaultExportOffenses,
	extractBundle,
	LAZY_L10N_HELPERS,
	moduleScopeL10nOffenses,
	nlsSchema,
	readSourceFiles,
	type SourceFile,
	serializeBundle,
	uncensusedLazyHelpers,
	vscodeL10nOffenses,
} from "./lib";

let failed = false;

function fail(message: string): void {
	failed = true;
	console.error(`l10n:check: ${message}`);
}

function rel(file: string): string {
	return path.relative(process.cwd(), file);
}

function describeParseError(error: unknown): string {
	if (error instanceof z.ZodError) {
		return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
	}
	return error instanceof Error ? error.message : String(error);
}

/** Parse one file's text through a schema; a failure records itself and returns undefined so the run continues. */
function parseTable<T>(file: string, text: string, schema: z.ZodType<T>): T | undefined {
	try {
		return schema.parse(JSON.parse(text));
	} catch (error) {
		fail(`${rel(file)}: ${describeParseError(error)}`);
		return undefined;
	}
}

/** Read and parse one file; undefined (with a recorded failure) on any read or shape problem. */
async function readTable<T>(file: string, schema: z.ZodType<T>): Promise<T | undefined> {
	let text: string;
	try {
		text = await fs.readFile(file, "utf8");
	} catch (error) {
		fail(`${rel(file)}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
	return parseTable(file, text, schema);
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.access(file);
		return true;
	} catch {
		return false;
	}
}

/** (a) The bundle is 100% generated, so drift is a byte comparison against a fresh extraction. */
async function checkExtractionDrift(): Promise<BundleFile | undefined> {
	if (!(await exists(BUNDLE_PATH))) {
		fail(`${rel(BUNDLE_PATH)} is missing; run \`bun run l10n:extract\` and commit the result.`);
		return undefined;
	}
	const committedText = await fs.readFile(BUNDLE_PATH, "utf8");
	const committed = parseTable(BUNDLE_PATH, committedText, bundleSchema);
	const extracted = await extractBundle();
	if (serializeBundle(extracted) !== committedText) {
		// Key-level hints before the verdict, so the failure reads without a manual diff.
		if (committed !== undefined) {
			for (const key of Object.keys(extracted)) {
				if (!(key in committed)) {
					fail(`${rel(BUNDLE_PATH)} drift: key ${JSON.stringify(key)} is in the source but not in the bundle.`);
				} else if (bundleMessage(extracted[key]) !== bundleMessage(committed[key])) {
					fail(`${rel(BUNDLE_PATH)} drift: key ${JSON.stringify(key)} has a different message in the source.`);
				}
			}
			for (const key of Object.keys(committed)) {
				if (!(key in extracted)) {
					fail(`${rel(BUNDLE_PATH)} drift: key ${JSON.stringify(key)} is in the bundle but no longer in the source.`);
				}
			}
		}
		fail(
			`${rel(BUNDLE_PATH)} is not byte-identical to a fresh extraction; ` +
				"run `bun run l10n:extract`, then review and commit the result."
		);
	}
	return committed;
}

/**
 * The guard's own teeth, proven before it judges real files: each fixture is a
 * pattern the AST walk must classify correctly, so a guard regression fails the
 * gate instead of silently passing frozen-English catalogs.
 */
const GUARD_FIXTURES: readonly { readonly name: string; readonly source: string; readonly flagged: boolean }[] = [
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

/**
 * The reverse census walk's own teeth: each fixture's expected findings are the
 * exact set the walk must produce. expectedLines pins WHERE a finding points,
 * in the same name-sorted order as expected.
 */
const REVERSE_CENSUS_FIXTURES: readonly {
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

/** The default-export ban's own teeth: every shape that mints an importer-named binding must flag. */
const DEFAULT_EXPORT_FIXTURES: readonly {
	readonly name: string;
	readonly source: string;
	readonly flagged: boolean;
}[] = [
	{ name: "export default expression", source: "const label = () => 1;\nexport default label;\n", flagged: true },
	{
		name: "export default function",
		source: "export default function label(): number {\n\treturn 1;\n}\n",
		flagged: true,
	},
	{ name: "export-equals", source: "const api = {};\nexport = api;\n", flagged: true },
	{
		name: "aliased default export specifier",
		source: "const label = () => 1;\nexport { label as default };\n",
		flagged: true,
	},
	{
		name: "namespace export named default",
		source: 'export * as default from "./foo";\n',
		flagged: true,
	},
	{ name: "namespace export under another name", source: 'export * as helpers from "./foo";\n', flagged: false },
	{ name: "named export", source: "export const label = () => 1;\n", flagged: false },
	{
		name: "type-only default-named export",
		source: "type T = number;\nexport { type T as default };\n",
		flagged: false,
	},
];

/** Code-unit order by name - what `[...expected].sort()` does to a fixture's own list, so the two line up. */
function byName(left: { readonly name: string }, right: { readonly name: string }): number {
	if (left.name < right.name) {
		return -1;
	}
	return left.name > right.name ? 1 : 0;
}

/** The lazy-catalog guard: no module-scope localization call the census's name-following walks can see. */
function checkModuleScopeLocalization(sources: readonly SourceFile[]): void {
	// The census only guards what it can find: an entry naming a deleted or
	// renamed helper is a silently disarmed guard, so every entry must still
	// resolve to a top-level declaration through the AST - a name in a comment
	// or a string is not a declaration.
	const declared = new Set<string>();
	for (const { file, contents } of sources) {
		// A substring pre-filter keeps the parse off files that cannot declare a
		// census name; the AST decides for the candidates.
		if (!LAZY_L10N_HELPERS.some((helper) => contents.includes(helper))) {
			continue;
		}
		for (const name of declaredCensusNames(contents, file, LAZY_L10N_HELPERS)) {
			declared.add(name);
		}
	}
	for (const helper of LAZY_L10N_HELPERS) {
		if (!declared.has(helper)) {
			fail(`LAZY_L10N_HELPERS names "${helper}", which no shipped source declares; rename or remove the entry.`);
		}
	}
	// The reverse direction: a top-level helper resolving l10n.t at call time
	// that never joined the census leaves its module-scope call sites unguarded.
	for (const fixture of REVERSE_CENSUS_FIXTURES) {
		const findings = [...uncensusedLazyHelpers(fixture.sources, fixture.census)].sort(byName);
		const found = findings.map((finding) => finding.name);
		if (JSON.stringify(found) !== JSON.stringify([...fixture.expected].sort())) {
			fail(
				`guard self-check: reverse census fixture "${fixture.name}" found [${found.join(", ")}], ` +
					`expected [${fixture.expected.join(", ")}].`
			);
			continue;
		}
		const lines = findings.map((finding) => finding.line);
		if (fixture.expectedLines !== undefined && JSON.stringify(lines) !== JSON.stringify([...fixture.expectedLines])) {
			fail(
				`guard self-check: reverse census fixture "${fixture.name}" reported lines [${lines.join(", ")}], ` +
					`expected [${fixture.expectedLines.join(", ")}].`
			);
		}
	}
	for (const finding of uncensusedLazyHelpers(sources, LAZY_L10N_HELPERS)) {
		fail(
			`${rel(finding.file)}:${finding.line}: "${finding.name}" resolves l10n.t at call time but is not in ` +
				"LAZY_L10N_HELPERS (scripts/l10n/lib.ts); add it so the module-scope guard covers its call sites."
		);
	}
	// Default exports break both walks' name-following, so the gate keeps the
	// shape out of shipped source - its own teeth first.
	for (const fixture of DEFAULT_EXPORT_FIXTURES) {
		const flagged = defaultExportOffenses(fixture.source, "fixture.ts").length > 0;
		if (flagged !== fixture.flagged) {
			fail(`guard self-check: default-export fixture "${fixture.name}" should ${fixture.flagged ? "" : "not "}flag.`);
		}
	}
	for (const { file, contents } of sources) {
		for (const line of defaultExportOffenses(contents, file)) {
			fail(
				`${rel(file)}:${line}: default export; the lazy-helper census follows call-site names, and a default ` +
					"export lets every importer rename a helper out from under both guards - export it by name."
			);
		}
	}
	for (const fixture of GUARD_FIXTURES) {
		const flagged = moduleScopeL10nOffenses(fixture.source, "fixture.ts").length > 0;
		if (flagged !== fixture.flagged) {
			fail(`guard self-check: "${fixture.name}" should ${fixture.flagged ? "" : "not "}be flagged.`);
		}
	}
	for (const { file, contents } of sources) {
		for (const line of moduleScopeL10nOffenses(contents, file)) {
			fail(
				`${rel(file)}:${line}: module-scope localization call (l10n.t, vscode.l10n.t, or ` +
					`${LAZY_L10N_HELPERS.join("/")}); it evaluates before l10n.config and freezes English. ` +
					"Resolve at call time (a zero-arg function)."
			);
		}
	}
}

/**
 * The one-API rule's own teeth, proven like GUARD_FIXTURES: the known
 * laundering forms must flag, and the sanctioned forms must not.
 */
const VSCODE_L10N_FIXTURES: readonly {
	readonly name: string;
	readonly source: string;
	readonly flagged: boolean;
	readonly allowBundleReads?: boolean;
	readonly allowVscodeValueUse?: boolean;
	/** Fixture file name; ".tsx" exercises the JSX branch of the walk. */
	readonly fileName?: string;
}[] = [
	{
		name: "vscode.l10n.t call inside a function",
		source: 'import * as vscode from "vscode";\nexport function f(): string {\n\treturn vscode.l10n.t("x");\n}\n',
		flagged: true,
	},
	{
		name: "vscode.l10n.t via a renamed namespace import",
		source: 'import * as vs from "vscode";\nexport const f = () => vs.l10n.t("x");\n',
		flagged: true,
	},
	{
		name: "named l10n import from vscode",
		source: 'import { l10n } from "vscode";\nexport const f = () => l10n.t("x");\n',
		flagged: true,
	},
	{
		name: "aliased named l10n import from vscode",
		source: 'import { l10n as hostL10n } from "vscode";\nexport const f = () => hostL10n.t("x");\n',
		flagged: true,
	},
	{
		name: "import-equals of vscode reaching l10n",
		source: 'import vscode = require("vscode");\nexport const f = () => vscode.l10n.t("x");\n',
		flagged: true,
	},
	{
		name: "default import of vscode reaching l10n",
		source: 'import vscode from "vscode";\nexport const f = () => vscode.l10n.t("x");\n',
		flagged: true,
	},
	{
		name: "default import of vscode without touching l10n",
		source: 'import vscode from "vscode";\nexport const f = () => vscode.window.activeTextEditor;\n',
		flagged: false,
	},
	{
		name: "import-equals of vscode without touching l10n",
		source: 'import vscode = require("vscode");\nexport const f = () => vscode.window.activeTextEditor;\n',
		flagged: false,
	},
	{
		name: "vscode module object passed as a value (fail-closed by default)",
		source: 'import * as vscode from "vscode";\nexport const probe = inspect(vscode);\n',
		flagged: true,
	},
	{
		name: "vscode module object passed as a value in an allowlisted probe file",
		source: 'import * as vscode from "vscode";\nexport const probe = inspect(vscode);\n',
		flagged: false,
		allowVscodeValueUse: true,
	},
	{
		name: "vscode.l10n.t in an allowlisted probe file",
		source: 'import * as vscode from "vscode";\nexport const f = () => vscode.l10n.t("x");\n',
		flagged: true,
		allowVscodeValueUse: true,
	},
	{
		name: "element access on vscode in an allowlisted probe file",
		source: 'import * as vscode from "vscode";\nexport const f = () => vscode["l10n"];\n',
		flagged: true,
		allowVscodeValueUse: true,
	},
	{
		name: "bare vscode.l10n reference",
		source: 'import * as vscode from "vscode";\nexport function f(): unknown {\n\treturn vscode.l10n;\n}\n',
		flagged: true,
	},
	{
		name: "l10n destructured off the vscode namespace",
		source: 'import * as vscode from "vscode";\nconst { l10n } = vscode;\nexport const f = () => l10n.t("x");\n',
		flagged: true,
	},
	{
		name: "element access on vscode.l10n",
		source: 'import * as vscode from "vscode";\nexport const f = () => vscode.l10n["t"]("x");\n',
		flagged: true,
	},
	{
		name: "element access reaching l10n off the namespace",
		source: 'import * as vscode from "vscode";\nexport const f = () => vscode["l10n"];\n',
		flagged: true,
	},
	{
		name: "l10n re-export from vscode",
		source: 'export { l10n } from "vscode";\n',
		flagged: true,
	},
	{
		name: "star re-export from vscode",
		source: 'export * from "vscode";\n',
		flagged: true,
	},
	{
		name: "named t import from @vscode/l10n (extraction-invisible)",
		source: 'import { t } from "@vscode/l10n";\nexport const f = () => t("x");\n',
		flagged: true,
	},
	{
		name: "renamed namespace import of @vscode/l10n (breaks the one canonical shape)",
		source: 'import * as loc from "@vscode/l10n";\nexport const f = () => loc.t("x");\n',
		flagged: true,
	},
	{
		name: "element access on the canonical binding (extraction-invisible)",
		source: 'import * as l10n from "@vscode/l10n";\nexport const f = () => l10n["t"]("x");\n',
		flagged: true,
	},
	{
		name: "t destructured off the canonical binding (extraction-invisible)",
		source: 'import * as l10n from "@vscode/l10n";\nconst { t } = l10n;\nexport const f = () => t("x");\n',
		flagged: true,
	},
	{
		name: "canonical binding aliased into a variable",
		source: 'import * as l10n from "@vscode/l10n";\nconst loc = l10n;\nexport const f = () => loc.t("x");\n',
		flagged: true,
	},
	{
		name: "canonical binding aliased through parentheses",
		source: 'import * as l10n from "@vscode/l10n";\nconst loc = (l10n);\nexport const f = () => loc.t("x");\n',
		flagged: true,
	},
	{
		name: "canonical binding aliased through an angle-bracket assertion",
		source:
			'import * as l10n from "@vscode/l10n";\nconst loc = <typeof l10n>l10n;\nexport const f = () => loc.t("x");\n',
		flagged: true,
	},
	{
		name: "t aliased off the canonical binding (extraction-invisible)",
		source: 'import * as l10n from "@vscode/l10n";\nconst t = l10n.t;\nexport const f = () => t("x");\n',
		flagged: true,
	},
	{
		name: "t wrapped into an object literal (extraction-invisible)",
		source: 'import * as l10n from "@vscode/l10n";\nexport const L = { t: l10n.t };\n',
		flagged: true,
	},
	{
		name: "t invoked through .call (extraction-invisible)",
		source: 'import * as l10n from "@vscode/l10n";\nexport const f = () => l10n.t.call(undefined, "x");\n',
		flagged: true,
	},
	{
		name: "parenthesized t callee (extraction-invisible)",
		source: 'import * as l10n from "@vscode/l10n";\nexport const f = () => (l10n.t)("x");\n',
		flagged: true,
	},
	{
		name: "parenthesized binding in the callee (extraction-invisible)",
		source: 'import * as l10n from "@vscode/l10n";\nexport const f = () => (l10n).t("x");\n',
		flagged: true,
	},
	{
		name: "optional-chained t call (extraction-unsafe)",
		source: 'import * as l10n from "@vscode/l10n";\nexport const f = () => l10n.t?.("x");\n',
		flagged: true,
	},
	{
		name: "heritage clause consuming the canonical binding",
		source: 'import * as l10n from "@vscode/l10n";\nexport class C extends mixin(l10n) {}\n',
		flagged: true,
	},
	{
		name: "dynamic import of vscode",
		source: 'export const f = async () => (await import("vscode")).l10n.t("x");\n',
		flagged: true,
	},
	{
		name: "dynamic import of @vscode/l10n",
		source: 'export const f = async () => (await import("@vscode/l10n")).t("x");\n',
		flagged: true,
	},
	{
		name: "parenthesized dynamic import specifier",
		source: 'export const f = async () => (await import(("@vscode/l10n"))).t("x");\n',
		flagged: true,
	},
	{
		name: "CommonJS require of vscode",
		source: 'const host = require("vscode");\nexport const f = () => host.l10n.t("x");\n',
		flagged: true,
	},
	{
		name: "CommonJS require of @vscode/l10n",
		source: 'const { t } = require("@vscode/l10n");\nexport const f = () => t("x");\n',
		flagged: true,
	},
	{
		name: "import-equals alias of the canonical binding",
		source: 'import * as l10n from "@vscode/l10n";\nimport t = l10n.t;\nexport const f = () => t("x");\n',
		flagged: true,
	},
	{
		name: "import-equals alias of the vscode namespace",
		source: 'import * as vscode from "vscode";\nimport vs = vscode;\nexport const f = () => vs.l10n.t("x");\n',
		flagged: true,
	},
	{
		name: "import-equals alias reaching through vscode.l10n",
		source: 'import * as vscode from "vscode";\nimport t = vscode.l10n.t;\nexport const f = () => t("x");\n',
		flagged: true,
	},
	{
		name: "import-equals alias of a non-l10n vscode member",
		source: 'import * as vscode from "vscode";\nimport Uri = vscode.Uri;\nexport const f = () => Uri.file("/x");\n',
		flagged: false,
	},
	{
		name: "canonical binding passed as an argument",
		source: 'import * as l10n from "@vscode/l10n";\nregister(l10n);\n',
		flagged: true,
	},
	{
		name: "local declaration shadowing the canonical binding",
		source:
			'import * as l10n from "@vscode/l10n";\nexport function f(l10n: { t(m: string): string }): string {\n\treturn l10n.t("x");\n}\n',
		flagged: true,
	},
	{
		name: "vscode.l10n.t through a parenthesized namespace",
		source: 'import * as vscode from "vscode";\nexport const f = () => (vscode).l10n.t("x");\n',
		flagged: true,
	},
	{
		name: "destructure off a parenthesized vscode namespace",
		source:
			'import * as vscode from "vscode";\nconst { l10n: host } = (vscode);\nexport const f = () => host.t("x");\n',
		flagged: true,
	},
	{
		name: "facade re-export of the canonical binding",
		source: 'import * as l10n from "@vscode/l10n";\nexport { l10n };\n',
		flagged: true,
	},
	{
		name: "aliased facade re-export of the canonical binding",
		source: 'import * as l10n from "@vscode/l10n";\nexport { l10n as loc };\n',
		flagged: true,
	},
	{
		name: "default export of the canonical binding",
		source: 'import * as l10n from "@vscode/l10n";\nexport default l10n;\n',
		flagged: true,
	},
	{
		name: "re-export from @vscode/l10n",
		source: 'export { t } from "@vscode/l10n";\n',
		flagged: true,
	},
	{
		name: "vscode.l10n.bundle read outside the bundle-feeding files",
		source: 'import * as vscode from "vscode";\nexport function f(): unknown {\n\treturn vscode.l10n.bundle;\n}\n',
		flagged: true,
	},
	{
		name: "vscode.l10n.bundle read in a bundle-feeding file",
		source: 'import * as vscode from "vscode";\nexport function f(): unknown {\n\treturn vscode.l10n.bundle;\n}\n',
		flagged: false,
		allowBundleReads: true,
	},
	{
		name: "vscode.l10n.t in a bundle-feeding file",
		source: 'import * as vscode from "vscode";\nexport const f = () => vscode.l10n.t("x");\n',
		flagged: true,
		allowBundleReads: true,
	},
	{
		name: "@vscode/l10n namespace t call",
		source: 'import * as l10n from "@vscode/l10n";\nexport const f = () => l10n.t("x");\n',
		flagged: false,
	},
	{
		name: "type-only l10n import from vscode",
		source: 'import type { l10n } from "vscode";\nexport type Bundle = typeof l10n.bundle;\n',
		flagged: false,
	},
	{
		name: "type-only import from @vscode/l10n",
		source: 'import type { L10nReplacement } from "@vscode/l10n";\nexport type R = L10nReplacement;\n',
		flagged: false,
	},
	{
		name: "type-only import-equals of @vscode/l10n",
		source: 'import type l10n = require("@vscode/l10n");\nexport type Bundle = typeof l10n.bundle;\n',
		flagged: false,
	},
	{
		name: "type-only re-export from @vscode/l10n",
		source: 'export { type L10nReplacement } from "@vscode/l10n";\n',
		flagged: false,
	},
	{
		name: "type-only vscode namespace beside a value binding of the same name",
		source: 'import type * as vscode from "vscode";\nexport const f = (vscode: number) => vscode + 1;\n',
		flagged: false,
	},
	{
		name: "JSX attribute named l10n (a key, not a reference)",
		source:
			'import * as l10n from "@vscode/l10n";\nexport const view = () => <section l10n={l10n.t("x")}>{l10n.t("y")}</section>;\n',
		flagged: false,
		fileName: "fixture.tsx",
	},
	{
		name: "unrelated export beside the canonical binding",
		source: 'import * as l10n from "@vscode/l10n";\nconst label = () => l10n.t("x");\nexport { label };\n',
		flagged: false,
	},
	{
		name: "l10n.config call (the bundle-feeding API)",
		source:
			'import * as l10n from "@vscode/l10n";\nexport function f(contents: Record<string, string>): void {\n\tl10n.config({ contents });\n}\n',
		flagged: false,
	},
	{
		name: "property key named l10n on an unrelated object",
		source: 'import * as l10n from "@vscode/l10n";\nexport const f = (s: { l10n: string }) => s.l10n + l10n.t("x");\n',
		flagged: false,
	},
	{
		name: "unrelated named import from vscode",
		source: 'import { window } from "vscode";\nexport const f = () => window.activeTextEditor;\n',
		flagged: false,
	},
];

/** The two files that feed vscode.l10n.bundle onward: l10n.config at activate(), and the webview's injected copy. */
const BUNDLE_READ_FILES = new Set(
	["src/extension/l10nConfig.ts", "src/extension/dashboard/panel.ts"].map((file) => path.join(process.cwd(), file))
);

/**
 * The constructor-probe files pass the vscode module object into Reflect
 * probes; that value use carries no localization. Everything else in them stays
 * under the rule.
 */
const VSCODE_VALUE_USE_FILES = new Set(
	["src/shared/conversion/dataPart.ts", "src/shared/conversion/thinkingPart.ts"].map((file) =>
		path.join(process.cwd(), file)
	)
);

/** The one-API rule: the shipped source localizes through @vscode/l10n's canonical import form only. */
function checkVscodeL10nUsage(sources: readonly SourceFile[]): void {
	for (const fixture of VSCODE_L10N_FIXTURES) {
		const options = {
			allowBundleReads: fixture.allowBundleReads === true,
			allowVscodeValueUse: fixture.allowVscodeValueUse === true,
		};
		const flagged = vscodeL10nOffenses(fixture.source, fixture.fileName ?? "fixture.ts", options).length > 0;
		if (flagged !== fixture.flagged) {
			fail(`guard self-check: "${fixture.name}" should ${fixture.flagged ? "" : "not "}be flagged.`);
		}
	}
	for (const { file, contents } of sources) {
		const options = {
			allowBundleReads: BUNDLE_READ_FILES.has(file),
			allowVscodeValueUse: VSCODE_VALUE_USE_FILES.has(file),
		};
		for (const line of vscodeL10nOffenses(contents, file, options)) {
			fail(
				`${rel(file)}:${line}: vscode's l10n surface or a non-canonical @vscode/l10n form; localize with ` +
					'`import * as l10n from "@vscode/l10n"` and direct l10n.t calls so one API serves every runtime ' +
					"(vscode.l10n.bundle reads pass only in l10nConfig.ts and dashboard/panel.ts)."
			);
		}
	}
}

/**
 * Non-prose token families beyond the {N} placeholders that a translated value
 * must carry verbatim, compared as multisets: $(icon) codicons, command:<id>
 * occurrences, and markdown link TARGETS including percent-encoded ones (a
 * reworded target breaks deep-links). The /g literals are consumed only through
 * matchAll, which iterates over a clone.
 */
const PRESERVED_TOKENS: readonly { readonly what: string; readonly pattern: RegExp }[] = [
	{ what: "$(codicon) tokens", pattern: /\$\(([a-z0-9~-]+)\)/g },
	{ what: "command IDs", pattern: /command:[A-Za-z0-9_.-]+/g },
	{ what: "markdown link targets", pattern: /\]\(([^()\s]+)\)/g },
];

/**
 * A bare key may never coexist with composite keys for the same base message: a
 * repeated message either uses the identical plain t() form everywhere (one
 * bare key) or carries a distinguishing comment at every call site. The mix
 * forks a key silently, surfacing only as an untranslated string at runtime.
 */
function checkBaseMessageCollisions(bundle: BundleFile): void {
	const keysByMessage = new Map<string, string[]>();
	for (const [key, value] of Object.entries(bundle)) {
		const message = bundleMessage(value);
		const keys = keysByMessage.get(message);
		if (keys === undefined) {
			keysByMessage.set(message, [key]);
		} else {
			keys.push(key);
		}
	}
	for (const [message, keys] of keysByMessage) {
		if (keys.length > 1 && keys.includes(message)) {
			fail(
				`${rel(BUNDLE_PATH)}: message ${JSON.stringify(message)} is minted under ${keys.length} keys ` +
					`(${keys.map((key) => JSON.stringify(key)).join(", ")}); use the identical t() form at every ` +
					"occurrence of a repeated message, or give every occurrence a distinguishing comment."
			);
		}
	}
}

/** The multiset of one token family's occurrences in one message. */
function tokenCounts(message: string, pattern: RegExp): Map<string, number> {
	const counts = new Map<string, number>();
	for (const match of message.matchAll(pattern)) {
		counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
	}
	return counts;
}

/** (b) + (c) One translation file against its English reference: equal key sets, matching placeholders and preserved tokens. */
function checkAgainstReference(
	file: string,
	translated: Record<string, string>,
	english: Record<string, string>
): void {
	for (const key of Object.keys(translated)) {
		if (!(key in english)) {
			fail(`${rel(file)}: key ${JSON.stringify(key)} does not exist in the English file.`);
		}
	}
	for (const key of Object.keys(english)) {
		if (!(key in translated)) {
			fail(`${rel(file)}: key ${JSON.stringify(key)} is missing.`);
			continue;
		}
		const families = [
			{ what: "placeholders", wanted: placeholderCounts(english[key]), got: placeholderCounts(translated[key]) },
			...PRESERVED_TOKENS.map(({ what, pattern }) => ({
				what,
				wanted: tokenCounts(english[key], pattern),
				got: tokenCounts(translated[key], pattern),
			})),
		];
		for (const { what, wanted, got } of families) {
			const same = wanted.size === got.size && [...wanted].every(([token, count]) => got.get(token) === count);
			if (!same) {
				fail(
					`${rel(file)}: key ${JSON.stringify(key)} must carry exactly the English value's ${what} ` +
						`(${[...wanted.keys()].join(" ") || "none"}).`
				);
			}
		}
	}
}

/** (d) Scan decoded keys and values (raw-JSON scans miss \u-escaped offenders); report each offending key. */
function checkTypography(file: string, table: Record<string, string>): void {
	for (const [key, value] of Object.entries(table)) {
		const offenders = new Set<string>();
		for (const match of `${key}\n${value}`.matchAll(bannedTypography())) {
			offenders.add(match[0]);
		}
		for (const offender of offenders) {
			const code = (offender.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
			fail(`${rel(file)}: key ${JSON.stringify(key)} carries banned typography U+${code}; use ASCII punctuation.`);
		}
	}
}

/** Message texts of a bundle file, for reference comparisons. */
function bundleMessages(bundle: BundleFile): Record<string, string> {
	return Object.fromEntries(Object.entries(bundle).map(([key, value]) => [key, bundleMessage(value)]));
}

/** The locale of a translation file name, per the family's pattern. */
function localesOf(names: readonly string[], pattern: RegExp): Set<string> {
	const locales = new Set<string>();
	for (const name of names) {
		const match = pattern.exec(name);
		if (match?.[1] !== undefined) {
			locales.add(match[1]);
		}
	}
	return locales;
}

async function checkTranslationFiles(
	englishBundle: BundleFile | undefined,
	englishNls: Readonly<Record<string, string>> | undefined
): Promise<void> {
	const root = process.cwd();
	const l10nDir = path.dirname(BUNDLE_PATH);
	const bundleFiles = (await exists(l10nDir))
		? (await fs.readdir(l10nDir)).filter((name) => /^bundle\.l10n\.[\w-]+\.json$/.test(name)).sort()
		: [];
	for (const name of bundleFiles) {
		const file = path.join(l10nDir, name);
		// Strings only: the webview bootstrap drops a bundle with any non-string
		// value, so a {message, comment} object here would revert the dashboard to
		// English while the host stays translated.
		const translated = await readTable(file, nlsSchema);
		if (translated === undefined) {
			continue;
		}
		if (englishBundle !== undefined) {
			checkAgainstReference(file, translated, bundleMessages(englishBundle));
		}
		checkTypography(file, translated);
	}

	const nlsFiles = (await fs.readdir(root)).filter((name) => /^package\.nls\.[\w-]+\.json$/.test(name)).sort();
	if (englishNls !== undefined) {
		checkTypography(path.join(root, "package.nls.json"), englishNls);
	}
	for (const name of nlsFiles) {
		const file = path.join(root, name);
		const translated = await readTable(file, nlsSchema);
		if (translated === undefined) {
			continue;
		}
		if (englishNls !== undefined) {
			checkAgainstReference(file, translated, englishNls);
		}
		checkTypography(file, translated);
	}

	// Cross-family locale parity: a locale ships both files or neither.
	const bundleLocales = localesOf(bundleFiles, /^bundle\.l10n\.([\w-]+)\.json$/);
	const nlsLocales = localesOf(nlsFiles, /^package\.nls\.([\w-]+)\.json$/);
	for (const locale of bundleLocales) {
		if (!nlsLocales.has(locale)) {
			fail(`locale ${locale}: l10n/bundle.l10n.${locale}.json exists but package.nls.${locale}.json is missing.`);
		}
	}
	for (const locale of nlsLocales) {
		if (!bundleLocales.has(locale)) {
			fail(`locale ${locale}: package.nls.${locale}.json exists but l10n/bundle.l10n.${locale}.json is missing.`);
		}
	}
}

/** Every string value of the form %key% anywhere in the manifest. */
function collectNlsReferences(node: unknown, into: Set<string>): void {
	if (typeof node === "string") {
		const match = /^%(.+)%$/.exec(node);
		if (match !== null) {
			into.add(match[1]);
		}
	} else if (Array.isArray(node)) {
		for (const item of node) {
			collectNlsReferences(item, into);
		}
	} else if (typeof node === "object" && node !== null) {
		for (const value of Object.values(node)) {
			collectNlsReferences(value, into);
		}
	}
}

/** How the manifest and package.nls.json relate; references are parsed first so a missing file cannot mask them. */
type ManifestNlsState =
	| { readonly kind: "not-externalized" }
	| { readonly kind: "missing-nls"; readonly references: ReadonlySet<string> }
	| {
			readonly kind: "externalized";
			readonly references: ReadonlySet<string>;
			readonly nls: Readonly<Record<string, string>>;
	  };

/** Resolved once; checkTranslationFiles and checkManifestCoverage both consume it (one package.nls.json read). */
async function resolveManifestNlsState(): Promise<ManifestNlsState> {
	const root = process.cwd();
	const references = new Set<string>();
	const manifest = await readTable(path.join(root, "package.json"), z.unknown());
	collectNlsReferences(manifest, references);
	const nlsPath = path.join(root, "package.nls.json");
	if (!(await exists(nlsPath))) {
		return references.size === 0 ? { kind: "not-externalized" } : { kind: "missing-nls", references };
	}
	const nls = await readTable(nlsPath, nlsSchema);
	if (nls === undefined) {
		// Unreadable counts as missing for coverage purposes; the parse failure is already recorded.
		return references.size === 0 ? { kind: "not-externalized" } : { kind: "missing-nls", references };
	}
	return { kind: "externalized", references, nls };
}

/** (e) package.json's %key% references and package.nls.json must name the same key set. */
function checkManifestCoverage(state: ManifestNlsState): void {
	switch (state.kind) {
		case "not-externalized":
			return;
		case "missing-nls":
			fail(
				`package.json references ${state.references.size} %key% placeholder(s) but package.nls.json does not exist.`
			);
			return;
		case "externalized":
			for (const key of state.references) {
				if (!(key in state.nls)) {
					fail(`package.json references %${key}% but package.nls.json does not define it.`);
				}
			}
			for (const key of Object.keys(state.nls)) {
				if (!state.references.has(key)) {
					fail(`package.nls.json defines ${JSON.stringify(key)} but package.json never references %${key}%.`);
				}
			}
			return;
	}
}

async function main(): Promise<void> {
	const englishBundle = await checkExtractionDrift();
	if (englishBundle !== undefined) {
		checkBaseMessageCollisions(englishBundle);
	}
	const sources = await readSourceFiles();
	checkModuleScopeLocalization(sources);
	checkVscodeL10nUsage(sources);
	const manifestState = await resolveManifestNlsState();
	await checkTranslationFiles(englishBundle, manifestState.kind === "externalized" ? manifestState.nls : undefined);
	checkManifestCoverage(manifestState);
	if (failed) {
		process.exitCode = 1;
		return;
	}
	console.log("l10n:check passed.");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
