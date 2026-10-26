/**
 * The one-API rule: shipped source localizes through @vscode/l10n's canonical
 * import form and direct l10n.t calls, never through vscode's own l10n surface
 * or an aliased binding extraction cannot see.
 */
import ts from "typescript";
import { flagOffense, type OffenseScan, unwrapExpression } from "./lib";

interface VscodeL10nRuleOptions {
	/** Whether this file may read `vscode.l10n.bundle` (the two bundle-feeding sites). */
	readonly allowBundleReads: boolean;

	/** Whether a vscode binding may be used as a plain value (the Reflect probe files); .l10n access stays flagged. */
	readonly allowVscodeValueUse: boolean;
}

/** What pass 1 finds: the local names bound to the vscode module, and whether the canonical l10n import exists. */
interface TrackedBindings {
	readonly vscodeNamespaces: ReadonlySet<string>;
	readonly hasCanonicalL10n: boolean;
}

/** One file's scan: its options and the tracked bindings, on top of the source and offenses every scan records. */
interface RuleScan extends TrackedBindings, OffenseScan {
	readonly options: VscodeL10nRuleOptions;
}

function specifierOf(statement: ts.ImportDeclaration | ts.ExportDeclaration): string | undefined {
	return statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)
		? statement.moduleSpecifier.text
		: undefined;
}

/** `import * as l10n from "@vscode/l10n"`: the one import shape extraction follows. */
function isCanonicalL10nImport(statement: ts.ImportDeclaration): boolean {
	return (
		statement.importClause?.name === undefined &&
		statement.importClause?.namedBindings !== undefined &&
		ts.isNamespaceImport(statement.importClause.namedBindings) &&
		statement.importClause.namedBindings.name.text === "l10n"
	);
}

/**
 * The local names one statement binds the vscode module object to. Default and namespace imports both bind the whole
 * module object under Node16 interop, so both feed the member checks; `import x = require("vscode")` binds it too.
 */
function vscodeBindingsOf(statement: ts.Statement): string[] {
	if (ts.isImportDeclaration(statement)) {
		const clause = statement.importClause;
		if (clause === undefined || clause.isTypeOnly || specifierOf(statement) !== "vscode") {
			return [];
		}
		const names: string[] = [];
		if (clause.name !== undefined) {
			names.push(clause.name.text);
		}
		if (clause.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings)) {
			names.push(clause.namedBindings.name.text);
		}
		return names;
	}
	if (ts.isImportEqualsDeclaration(statement) && !statement.isTypeOnly) {
		const reference = statement.moduleReference;
		if (
			ts.isExternalModuleReference(reference) &&
			ts.isStringLiteral(reference.expression) &&
			reference.expression.text === "vscode"
		) {
			return [statement.name.text];
		}
	}
	return [];
}

/** Whether a statement is the canonical @vscode/l10n value import; a type-only clause binds no runtime name. */
function importsCanonicalL10n(statement: ts.Statement): boolean {
	if (!ts.isImportDeclaration(statement)) {
		return false;
	}
	const clause = statement.importClause;
	return (
		clause !== undefined &&
		!clause.isTypeOnly &&
		specifierOf(statement) === "@vscode/l10n" &&
		isCanonicalL10nImport(statement)
	);
}

/**
 * Pass 1: which local names bind the vscode module, and whether the canonical @vscode/l10n binding exists (its
 * laundering checks key off it).
 */
function trackedBindings(sourceFile: ts.SourceFile): TrackedBindings {
	const vscodeNamespaces = new Set<string>();
	let hasCanonicalL10n = false;
	for (const statement of sourceFile.statements) {
		for (const name of vscodeBindingsOf(statement)) {
			vscodeNamespaces.add(name);
		}
		if (importsCanonicalL10n(statement)) {
			hasCanonicalL10n = true;
		}
	}
	return { vscodeNamespaces, hasCanonicalL10n };
}

/** Flags each value specifier that binds `l10n` by its original name. */
function flagL10nSpecifiers(scan: RuleScan, elements: readonly (ts.ImportSpecifier | ts.ExportSpecifier)[]): void {
	for (const element of elements) {
		if (!element.isTypeOnly && (element.propertyName ?? element.name).text === "l10n") {
			flagOffense(scan, element);
		}
	}
}

/** Pass 2, one import: a named `l10n` import off vscode, or any non-canonical value import of @vscode/l10n. */
function judgeImport(scan: RuleScan, statement: ts.ImportDeclaration): void {
	const specifier = specifierOf(statement);
	const clause = statement.importClause;
	if (clause === undefined || clause.isTypeOnly) {
		return;
	}
	if (specifier === "vscode") {
		if (clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
			flagL10nSpecifiers(scan, clause.namedBindings.elements);
		}
		return;
	}
	if (specifier === "@vscode/l10n" && !isCanonicalL10nImport(statement)) {
		const bindings = clause.namedBindings;
		const typeOnlyElements =
			bindings !== undefined &&
			ts.isNamedImports(bindings) &&
			clause.name === undefined &&
			bindings.elements.every((element) => element.isTypeOnly);
		if (!typeOnlyElements) {
			flagOffense(scan, statement);
		}
	}
}

/**
 * Pass 2, one import-equals. `import x = require("@vscode/l10n")` is a laundering route. Off a vscode binding a
 * non-l10n member alias is fine; the whole namespace or anything through .l10n is not. Off the canonical binding, every
 * alias breaks the one canonical call shape.
 */
function judgeImportEquals(scan: RuleScan, statement: ts.ImportEqualsDeclaration): void {
	if (statement.isTypeOnly) {
		return;
	}
	const reference = statement.moduleReference;
	if (ts.isExternalModuleReference(reference)) {
		if (ts.isStringLiteral(reference.expression) && reference.expression.text === "@vscode/l10n") {
			flagOffense(scan, statement);
		}
		return;
	}
	const segments: string[] = [];
	let root: ts.EntityName = reference;
	while (ts.isQualifiedName(root)) {
		segments.unshift(root.right.text);
		root = root.left;
	}
	if (scan.hasCanonicalL10n && root.text === "l10n") {
		flagOffense(scan, statement);
		return;
	}
	if (scan.vscodeNamespaces.has(root.text) && (segments.length === 0 || segments.includes("l10n"))) {
		flagOffense(scan, statement);
	}
}

/** A local export of any tracked binding is a facade. */
function flagLocalFacades(scan: RuleScan, elements: readonly ts.ExportSpecifier[]): void {
	for (const element of elements) {
		const local = (element.propertyName ?? element.name).text;
		if (!element.isTypeOnly && (scan.vscodeNamespaces.has(local) || (scan.hasCanonicalL10n && local === "l10n"))) {
			flagOffense(scan, element);
		}
	}
}

/**
 * Pass 2, one export: a value re-export of @vscode/l10n, of vscode's l10n (or of vscode whole), or a local export of
 * any tracked binding.
 */
function judgeExport(scan: RuleScan, statement: ts.ExportDeclaration): void {
	if (statement.isTypeOnly) {
		return;
	}
	const specifier = specifierOf(statement);
	const clause = statement.exportClause;
	if (specifier === "@vscode/l10n") {
		// A clause naming only types binds no runtime name.
		const typeOnlyElements =
			clause !== undefined && ts.isNamedExports(clause) && clause.elements.every((element) => element.isTypeOnly);
		if (!typeOnlyElements) {
			flagOffense(scan, statement);
		}
		return;
	}
	if (specifier === "vscode") {
		if (clause === undefined || !ts.isNamedExports(clause)) {
			flagOffense(scan, statement);
			return;
		}
		flagL10nSpecifiers(scan, clause.elements);
		return;
	}
	if (specifier === undefined && clause !== undefined && ts.isNamedExports(clause)) {
		flagLocalFacades(scan, clause.elements);
	}
}

/** Pass 2: the import and export statements themselves. */
function judgeModuleStatements(scan: RuleScan): void {
	for (const statement of scan.sourceFile.statements) {
		if (ts.isImportDeclaration(statement)) {
			judgeImport(scan, statement);
		} else if (ts.isImportEqualsDeclaration(statement)) {
			judgeImportEquals(scan, statement);
		} else if (ts.isExportDeclaration(statement)) {
			judgeExport(scan, statement);
		}
	}
}

function isVscodeBinding(scan: RuleScan, node: ts.Expression): boolean {
	const inner = unwrapExpression(node);
	return ts.isIdentifier(inner) && scan.vscodeNamespaces.has(inner.text);
}

function isCanonicalBinding(scan: RuleScan, node: ts.Expression): boolean {
	const inner = unwrapExpression(node);
	return scan.hasCanonicalL10n && ts.isIdentifier(inner) && inner.text === "l10n";
}

/**
 * A dynamic import or CommonJS require of either module: a laundering route the walk cannot follow; nothing sanctioned
 * needs one.
 */
function isModuleLoadOf(node: ts.Node): node is ts.CallExpression {
	if (!ts.isCallExpression(node) || node.arguments[0] === undefined) {
		return false;
	}
	const loader =
		node.expression.kind === ts.SyntaxKind.ImportKeyword ||
		(ts.isIdentifier(node.expression) && node.expression.text === "require");
	if (!loader) {
		return false;
	}
	const argument = unwrapExpression(node.arguments[0]);
	return ts.isStringLiteralLike(argument) && (argument.text === "vscode" || argument.text === "@vscode/l10n");
}

/**
 * The exact canonical call shape, l10n.t(...) or l10n.config(...), unwrapped and unchained: extraction follows nothing
 * looser, so a wrapped or optional variant is not sanctioned.
 */
function isCanonicalCall(scan: RuleScan, node: ts.Node): node is ts.CallExpression {
	if (!ts.isCallExpression(node) || node.questionDotToken !== undefined) {
		return false;
	}
	const callee = node.expression;
	return (
		ts.isPropertyAccessExpression(callee) &&
		callee.questionDotToken === undefined &&
		scan.hasCanonicalL10n &&
		ts.isIdentifier(callee.expression) &&
		callee.expression.text === "l10n" &&
		(callee.name.text === "t" || callee.name.text === "config")
	);
}

/**
 * A member read. Ordinary vscode API use is sanctioned, but not its l10n member; the bundle read is sanctioned in the
 * bundle-feeding files only; every member of the canonical binding is flagged. A member name is a key, not a
 * reference, so only the object side is walked further.
 */
function scanPropertyAccess(scan: RuleScan, node: ts.PropertyAccessExpression): void {
	const object = unwrapExpression(node.expression);
	if (isVscodeBinding(scan, object)) {
		if (node.name.text === "l10n") {
			flagOffense(scan, node);
		}
		return;
	}
	if (
		ts.isPropertyAccessExpression(object) &&
		isVscodeBinding(scan, object.expression) &&
		object.name.text === "l10n"
	) {
		if (!(scan.options.allowBundleReads && node.name.text === "bundle")) {
			flagOffense(scan, node);
		}
		return;
	}
	if (isCanonicalBinding(scan, object)) {
		flagOffense(scan, node);
		return;
	}
	scanNode(scan, node.expression);
}

/** The fail-closed catch-all: any other appearance of a tracked binding. */
function isTrackedIdentifier(scan: RuleScan, node: ts.Node): boolean {
	if (!ts.isIdentifier(node)) {
		return false;
	}
	if (scan.vscodeNamespaces.has(node.text) && !scan.options.allowVscodeValueUse) {
		return true;
	}
	return scan.hasCanonicalL10n && node.text === "l10n";
}

/**
 * A property KEY spells a name without referencing a binding: a member's non-computed name (a JSX attribute's always),
 * or a binding element's property name. Initializers, bodies, and computed names still walk.
 */
function propertyKeyOf(node: ts.Node): ts.Node | undefined {
	const named = node as { readonly name?: ts.Node; readonly propertyName?: ts.Node };
	if (ts.isBindingElement(node) && node.propertyName !== undefined && !ts.isComputedPropertyName(node.propertyName)) {
		return named.propertyName;
	}
	if (ts.isJsxAttribute(node)) {
		return named.name;
	}
	const member = ts.isClassElement(node) || ts.isObjectLiteralElementLike(node) || ts.isEnumMember(node);
	if (
		member &&
		!ts.isShorthandPropertyAssignment(node) &&
		named.name !== undefined &&
		!ts.isComputedPropertyName(named.name)
	) {
		return named.name;
	}
	return undefined;
}

/** The node's children, its property key skipped. */
function scanChildren(scan: RuleScan, node: ts.Node): void {
	const key = propertyKeyOf(node);
	ts.forEachChild(node, (child) => {
		if (child !== key) {
			scanNode(scan, child);
		}
	});
}

/**
 * The walk allows the sanctioned forms and flags every other appearance of a tracked binding, so unknown shapes fail
 * closed. A heritage clause's expression evaluates when the class does, even though its node counts as a type node, so
 * it is walked before the type skip. Element access on a vscode binding stays banned even where passing the module
 * object as a value is allowed.
 */
function scanNode(scan: RuleScan, node: ts.Node): void {
	if (ts.isExpressionWithTypeArguments(node)) {
		scanNode(scan, node.expression);
		return;
	}
	// Type positions are erased at runtime and cannot ship a string.
	if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
		return;
	}
	// Import and export statements were judged in pass 2; walking into them would flag their own binding identifiers.
	if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isExportDeclaration(node)) {
		return;
	}
	if (isModuleLoadOf(node)) {
		flagOffense(scan, node);
		return;
	}
	if (isCanonicalCall(scan, node)) {
		for (const argument of node.arguments) {
			scanNode(scan, argument);
		}
		return;
	}
	if (ts.isPropertyAccessExpression(node)) {
		scanPropertyAccess(scan, node);
		return;
	}
	if (ts.isElementAccessExpression(node) && isVscodeBinding(scan, unwrapExpression(node.expression))) {
		flagOffense(scan, node);
		scanNode(scan, node.argumentExpression);
		return;
	}
	if (isTrackedIdentifier(scan, node)) {
		flagOffense(scan, node);
		return;
	}
	scanChildren(scan, node);
}

/**
 * An allowlist that fails closed, not a catalog of escapes, so a novel laundering form fails the gate instead of
 * shipping untranslated. Matching is syntactic, so a local binding shadowing a tracked name flags too; rename it or add
 * a deliberate allowlist entry here.
 */
export function vscodeL10nOffenses(contents: string, fileName: string, options: VscodeL10nRuleOptions): number[] {
	const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const sourceFile = ts.createSourceFile(fileName, contents, ts.ScriptTarget.Latest, false, kind);
	const scan: RuleScan = { sourceFile, options, offenses: [], ...trackedBindings(sourceFile) };
	judgeModuleStatements(scan);
	scanNode(scan, sourceFile);
	return scan.offenses;
}
