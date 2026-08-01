/**
 * Shared machinery for the l10n scripts: the deterministic source walk and
 * extraction behind `l10n:extract`, the module-scope localization guard, and
 * the zod schemas `l10n:check` parses every translation file with. Scripts
 * run from the repo root (package.json invokes them there), so paths anchor
 * on process.cwd() like the other scripts in this tree.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getL10nJson, type l10nJsonFormat } from "@vscode/l10n-dev";
import ts from "typescript";
import { z } from "zod";

/** The English reference bundle: what extract writes and check re-derives. */
export const BUNDLE_PATH = path.join(process.cwd(), "l10n", "bundle.l10n.json");

/**
 * The generated English bundle's values: a message, optionally wrapped with
 * translator comments (l10n.t({message, comment}) mints those). Translated
 * bundles are NOT allowed the wrapped shape; check.ts parses them with
 * nlsSchema because the webview bootstrap drops non-string values wholesale.
 */
export const bundleSchema = z.record(
	z.string(),
	z.union([z.string(), z.object({ message: z.string(), comment: z.array(z.string()) })])
);
export type BundleFile = z.infer<typeof bundleSchema>;

/** Flat key-to-string tables: package.nls*.json and translated bundle.l10n.<locale>.json. */
export const nlsSchema = z.record(z.string(), z.string());

/** The message text of one bundle value, whichever shape it uses. */
export function bundleMessage(value: BundleFile[string]): string {
	return typeof value === "string" ? value : value.message;
}

export interface SourceFile {
	readonly file: string;
	readonly contents: string;
}

/** Every src/**\/*.ts|tsx outside src/test with its contents, sorted so extraction order is stable. */
export async function readSourceFiles(): Promise<SourceFile[]> {
	const srcRoot = path.join(process.cwd(), "src");
	const entries = await fs.readdir(srcRoot, { recursive: true, withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !/\.(ts|tsx)$/.test(entry.name)) {
			continue;
		}
		const full = path.join(entry.parentPath, entry.name);
		const [head] = path.relative(srcRoot, full).split(path.sep);
		if (head === "test") {
			continue;
		}
		files.push(full);
	}
	files.sort();
	return Promise.all(files.map(async (file) => ({ file, contents: await fs.readFile(file, "utf8") })));
}

/** Extract every l10n.t()/vscode.l10n.t() literal from the source tree, key-sorted. */
export async function extractBundle(): Promise<l10nJsonFormat> {
	const files = await readSourceFiles();
	const extracted = await getL10nJson(files.map(({ file, contents }) => ({ extension: path.extname(file), contents })));
	const sorted: l10nJsonFormat = {};
	for (const key of Object.keys(extracted).sort()) {
		sorted[key] = extracted[key];
	}
	return sorted;
}

/** The bundle's on-disk form; one serializer so extract and check cannot disagree. */
export function serializeBundle(bundle: l10nJsonFormat): string {
	return `${JSON.stringify(bundle, null, "\t")}\n`;
}

/**
 * Lazy localization helpers (zero-arg or key-selecting): calling one at
 * module scope defeats its laziness exactly like a direct t() call, so the
 * guard bans these names alongside l10n.t and vscode.l10n.t. Parsers and
 * presenters that resolve l10n.t transitively count too. New helpers minted
 * by later work packages (help text, catalog presenters) belong on this list.
 */
export const LAZY_L10N_HELPERS: readonly string[] = [
	"configureNowLabel",
	"hubItems",
	"manageCommandTitle",
	"secretPaletteLabel",
	"numberSettingPresentation",
	"booleanSettingPresentation",
	"settingScopeLabel",
	"serverFormFieldLabel",
	"serverFieldHelp",
	"settingRowHelp",
	"helpServersSection",
	"helpModelsSection",
	"helpParamsInspector",
	"helpSettingsSection",
	"helpModelParametersSection",
	"helpCustomHeadersSection",
	"helpSecretStorage",
	"helpModelParameterPrefix",
	"helpEntryModelParameterPrefix",
	"helpModelParameterName",
	"helpModelParameterValue",
	"parseNumberDraft",
	"defaultDisplay",
	"equivalence",
	"parseJsonValue",
	"formatDuration",
	"keyProblem",
	"firstGroupProblem",
	"recordFromJsonText",
	"parseGroups",
	"parseHeaderRows",
	"parseHeaderRowsDetailed",
	"groupsFromJsonText",
	"headerRowsFromJsonText",
	"parseServerForm",
	"parseServerFormForTest",
	"validateAdoptLabel",
	"sectionFailureText",
	"authMessage",
	"reasoningOnlyResponseMessage",
	"timeoutMessage",
	"timeoutRequestError",
	"upstreamAuthMessage",
	"statusErrorTexts",
	// WP4: webview component presenters that resolve l10n.t at call time.
	"relativeTime",
	"formatPricing",
	"pricingDetail",
	"capabilities",
	"externalTip",
	"locationName",
	"sectionLabel",
	"toastText",
	"overallState",
	"lastCheckedText",
	"rowChecked",
	"diagnosticsReportText",
	"modelParametersTitle",
	"headersTitle",
	"sourceName",
	"skipReasonText",
	"cachePricing",
	"longContextPricing",
	"maxTokensParts",
];

/**
 * Line numbers (1-based) of module-scope localization calls: l10n.t,
 * vscode.l10n.t, or a LAZY_L10N_HELPERS name evaluated while the module
 * loads, before l10n.config has run, freezing the English text. A real parse
 * of the top-level statements (no deep scope analysis): variable
 * initializers are searched through object/array literals, templates,
 * as/satisfies wrappers, and immediately-invoked functions, while a
 * function-valued initializer defers its body and passes; top-level
 * expression statements are searched the same way.
 */
export function moduleScopeL10nOffenses(contents: string, fileName: string): number[] {
	const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const sourceFile = ts.createSourceFile(fileName, contents, ts.ScriptTarget.Latest, false, kind);
	const offenses: number[] = [];

	const unwrap = (node: ts.Expression): ts.Expression => {
		let current = node;
		while (
			ts.isParenthesizedExpression(current) ||
			ts.isAsExpression(current) ||
			ts.isSatisfiesExpression(current) ||
			ts.isNonNullExpression(current)
		) {
			current = current.expression;
		}
		return current;
	};

	const isDeferred = (node: ts.Expression): boolean => {
		const inner = unwrap(node);
		return ts.isArrowFunction(inner) || ts.isFunctionExpression(inner);
	};

	// Walk everything that evaluates at module load. Function bodies are
	// skipped (their calls run later) unless the function is invoked on the
	// spot: an IIFE's callee body evaluates eagerly, so it is walked too.
	const scan = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) {
			const callee = node.expression.getText(sourceFile);
			if (callee === "l10n.t" || callee === "vscode.l10n.t" || LAZY_L10N_HELPERS.includes(callee)) {
				offenses.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
			}
			const invoked = unwrap(node.expression);
			if (ts.isArrowFunction(invoked) || ts.isFunctionExpression(invoked)) {
				scan(invoked.body);
			} else {
				scan(node.expression);
			}
			for (const argument of node.arguments) {
				scan(argument);
			}
			return;
		}
		if (
			ts.isArrowFunction(node) ||
			ts.isFunctionExpression(node) ||
			ts.isFunctionDeclaration(node) ||
			ts.isClassDeclaration(node) ||
			ts.isClassExpression(node)
		) {
			return;
		}
		ts.forEachChild(node, scan);
	};

	for (const statement of sourceFile.statements) {
		if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				if (declaration.initializer !== undefined && !isDeferred(declaration.initializer)) {
					scan(declaration.initializer);
				}
			}
		} else if (ts.isExpressionStatement(statement)) {
			scan(statement.expression);
		}
	}
	return offenses;
}
