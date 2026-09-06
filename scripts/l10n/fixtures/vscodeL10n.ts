/**
 * The one-API rule's own teeth, proven like GUARD_FIXTURES: the known
 * laundering forms must flag, and the sanctioned forms must not.
 */
export const VSCODE_L10N_FIXTURES: readonly {
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
