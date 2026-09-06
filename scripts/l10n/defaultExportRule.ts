/**
 * The default-export ban the census walks depend on.
 */
import ts from "typescript";

/**
 * Line numbers (1-based) of default exports (`export default ...`, `export =`,
 * `export { x as default }`). Both census walks follow call-site NAMES, and a
 * default export is the one shape that breaks that - every importer mints its
 * own name - so the gate keeps it out of shipped source entirely.
 */
export function defaultExportOffenses(contents: string, fileName: string): number[] {
	const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const sourceFile = ts.createSourceFile(fileName, contents, ts.ScriptTarget.Latest, false, kind);
	const offenses: number[] = [];
	const flag = (node: ts.Node): void => {
		offenses.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
	};
	for (const statement of sourceFile.statements) {
		if (ts.isExportAssignment(statement)) {
			// Covers both `export default expr` and `export = expr`.
			flag(statement);
		} else if (
			(ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
			(ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
		) {
			flag(statement);
		} else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.exportClause !== undefined) {
			if (ts.isNamedExports(statement.exportClause)) {
				for (const element of statement.exportClause.elements) {
					if (!element.isTypeOnly && element.name.text === "default") {
						flag(element);
					}
				}
			} else if (statement.exportClause.name.text === "default") {
				// `export * as default from "./m"`: a namespace export minting the
				// default name, which the named-specifier walk above cannot see.
				flag(statement.exportClause);
			}
		}
	}
	return offenses;
}
