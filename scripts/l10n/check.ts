/**
 * The l10n gate (pre-commit, and CI's format-check job inside the all-green
 * gate): fails when the committed English bundle is not byte-identical to a fresh
 * extraction, when one message is minted under two different bundle keys
 * (a forked comment form), when a localized string is resolved at module
 * scope, when the source localizes through vscode's l10n API instead of
 * @vscode/l10n's canonical import form, when a translation file's key set
 * drifts from its English reference, when a
 * translated value's {0}-style placeholders differ from the English value's,
 * when a translated value drops or rewrites a preserved token (a $(codicon),
 * a command:<id> occurrence, or a markdown link target),
 * when a translation file carries banned typography, when the bundle and
 * package.nls locale sets disagree, or when package.json's %key% references
 * and package.nls.json disagree. Every file is parsed through a zod schema
 * (nothing is cast), and one bad file records its failure and lets the rest
 * of the run continue.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
// The typography and placeholder helpers are shared with the guard suites
// under src/test; they live there because the extension-host tsconfig cannot
// compile imports from scripts/ (see src/test/util/l10n.ts).
import { bannedTypography, placeholderCounts } from "../../src/test/util/l10n";
import {
	BUNDLE_PATH,
	type BundleFile,
	bundleMessage,
	bundleSchema,
	extractBundle,
	LAZY_L10N_HELPERS,
	moduleScopeL10nOffenses,
	nlsSchema,
	readSourceFiles,
	type SourceFile,
	serializeBundle,
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
 * The guard's own teeth, proven before it judges real files: every fixture
 * is a pattern the AST walk must classify correctly, so a guard regression
 * fails the gate instead of silently passing frozen-English catalogs.
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
];

/** The lazy-catalog guard: no module-scope localization calls anywhere in the shipped source. */
function checkModuleScopeLocalization(sources: readonly SourceFile[]): void {
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
 * The one-API rule's own teeth, proven the same way as GUARD_FIXTURES: the
 * known laundering forms must flag (as regression proof that the default-deny
 * walk catches them), and the sanctioned forms must not.
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
 * probes for host chat-part constructors; that value use is deliberate and
 * carries no localization. Everything else in them stays under the rule.
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
 * Non-prose token families beyond the {N} placeholders that a translated
 * value must carry verbatim, compared as multisets against the English
 * source: $(icon) codicons (a dropped or fullwidth-parenthesized token ships
 * a status bar rendering literal text), command:<id> occurrences, and
 * markdown link TARGETS including percent-encoded ones like
 * %5B%22@ext:...%22%5D (a reworded target silently breaks walkthrough and
 * settings deep-links). The /g literals are consumed only through matchAll,
 * which iterates over a clone, so no lastIndex is shared between calls.
 */
const PRESERVED_TOKENS: readonly { readonly what: string; readonly pattern: RegExp }[] = [
	{ what: "$(codicon) tokens", pattern: /\$\(([a-z0-9~-]+)\)/g },
	{ what: "command IDs", pattern: /command:[A-Za-z0-9_.-]+/g },
	{ what: "markdown link targets", pattern: /\]\(([^()\s]+)\)/g },
];

/**
 * No two bundle keys may share one base message. The repo rule is that a
 * repeated message uses the identical t() form (plain, or {message, comment}
 * with the same comment) at every occurrence; editing the comment at only one
 * of a repeated message's call sites silently forks the key, and the fork
 * only surfaces as an untranslated string at runtime. This catches the fork
 * at the gate: a bare key plus a composite "message/comment" key, or two
 * composites with different comments, for the same message.
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
		if (keys.length > 1) {
			fail(
				`${rel(BUNDLE_PATH)}: message ${JSON.stringify(message)} is minted under ${keys.length} keys ` +
					`(${keys.map((key) => JSON.stringify(key)).join(", ")}); use the identical t() form ` +
					"(same comment, or none) at every occurrence of a repeated message."
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
		// value, so a {message, comment} object here would silently revert the
		// dashboard to English while the host stays translated.
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
