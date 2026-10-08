/**
 * The syntactic reads the bun-tree audits share (childProcessTimeoutCoverage.test.ts, listScaledBackoffCoverage.test.ts).
 * Everything here is parser-only: no type checker, no program, so a read never depends on how a symbol resolves.
 */
import { readFileSync, statSync } from "node:fs";
import ts from "typescript";

const parsed = new Map<string, ts.SourceFile>();

/** One parse per module for every audit in the process; JSDoc and parent pointers are skipped since nothing reads them. */
export function parsedSource(file: string): ts.SourceFile {
	let sourceFile = parsed.get(file);
	if (sourceFile === undefined) {
		sourceFile = ts.createSourceFile(
			file,
			readFileSync(file, "utf8"),
			{ languageVersion: ts.ScriptTarget.Latest, jsDocParsingMode: ts.JSDocParsingMode.ParseNone },
			false
		);
		parsed.set(file, sourceFile);
	}
	return sourceFile;
}

const fileKinds = new Map<string, boolean>();

/** One stat per candidate path: discovery, the import table, and every dynamic load resolve the same specifiers. */
export function isFile(candidate: string): boolean {
	let known = fileKinds.get(candidate);
	if (known === undefined) {
		known = statSync(candidate, { throwIfNoEntry: false })?.isFile() ?? false;
		fileKinds.set(candidate, known);
	}
	return known;
}

/** An expression with its casts and parentheses removed, so `(Bun as typeof Bun).spawn` reads as written. */
export function unwrapped(expression: ts.Expression): ts.Expression {
	let current = expression;
	while (
		ts.isAsExpression(current) ||
		ts.isSatisfiesExpression(current) ||
		ts.isParenthesizedExpression(current) ||
		ts.isNonNullExpression(current) ||
		ts.isTypeAssertionExpression(current)
	) {
		current = current.expression;
	}
	return current;
}

export const baseName = (expression: ts.Expression): string | undefined => {
	const inner = unwrapped(expression);
	return ts.isIdentifier(inner) ? inner.text : undefined;
};

/**
 * The identifier a callee chain hangs off and the member read directly off it: `test.each(rows)` and `it.skipIf(flag)`
 * both root at their first name, and `bt.test(...)` off a namespace import roots at `bt` with member `test`.
 */
export function calleeRoot(
	node: ts.Expression
): { readonly root: ts.Identifier; readonly member: string | undefined } | undefined {
	let current: ts.Expression = unwrapped(node);
	let member: string | undefined;
	for (;;) {
		if (ts.isIdentifier(current)) {
			return { root: current, member };
		}
		if (ts.isPropertyAccessExpression(current)) {
			member = current.name.text;
			current = unwrapped(current.expression);
		} else if (ts.isCallExpression(current)) {
			member = undefined;
			current = unwrapped(current.expression);
		} else {
			return undefined;
		}
	}
}

/**
 * An import whose every binding is a type loads nothing at runtime: the transpiler erases it whole, so it is not an
 * edge. `import defer` still loads.
 */
export const isTypeOnlyImport = (clause: ts.ImportClause | undefined): boolean =>
	clause !== undefined &&
	(clause.phaseModifier === ts.SyntaxKind.TypeKeyword ||
		(clause.name === undefined &&
			clause.namedBindings !== undefined &&
			ts.isNamedImports(clause.namedBindings) &&
			clause.namedBindings.elements.length > 0 &&
			clause.namedBindings.elements.every((element) => element.isTypeOnly)));

export interface ImportStatement {
	readonly statement: ts.ImportDeclaration;
	readonly specifier: string;
	/** `imported` is the exported name, `default`, or `*` for a namespace; a side-effect import has no bindings. */
	readonly bindings: readonly { readonly local: ts.Identifier; readonly imported: string }[];
}

/** Every import statement that loads at runtime, with its runtime bindings; type-only forms are erased and absent. */
export function importStatements(sf: ts.SourceFile): ImportStatement[] {
	const statements: ImportStatement[] = [];
	for (const statement of sf.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) {
			continue;
		}
		const clause = statement.importClause;
		if (isTypeOnlyImport(clause)) {
			continue;
		}
		const bindings: { local: ts.Identifier; imported: string }[] = [];
		if (clause?.name !== undefined) {
			bindings.push({ local: clause.name, imported: "default" });
		}
		const named = clause?.namedBindings;
		if (named !== undefined && ts.isNamespaceImport(named)) {
			bindings.push({ local: named.name, imported: "*" });
		} else if (named !== undefined) {
			for (const element of named.elements) {
				if (!element.isTypeOnly) {
					bindings.push({ local: element.name, imported: (element.propertyName ?? element.name).text });
				}
			}
		}
		statements.push({ statement, specifier: statement.moduleSpecifier.text, bindings });
	}
	return statements;
}
