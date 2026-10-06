/**
 * Importing src/test/util/repoRoot.ts declares that a suite reads the repository as data, and the pre-commit selection
 * (scripts/dev/changedBunTests.ts) runs every suite whose imports reach it on any staged change. A suite deriving a
 * repository path from __dirname or import.meta.dir instead reads the repository undeclared: a staged edit to a file it
 * reads commits with the hook green while the suite is red. The scan catches that accidental derivation; a path hidden
 * behind an alias or computed indirectly is out of scope.
 */
import ts from "typescript";

export const MARKER_FILE = "src/test/util/repoRoot.ts";
export const TEST_TREE = "src/test";

/** Every extension bun runs (BUN_TEST_FILE in src/test/runtimeImportGraph.ts), helpers included, not only suites. */
export const SCANNED_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

export interface RepositoryPathDerivation {
	/** Repository-relative, forward slashes. */
	readonly file: string;
	readonly line: number;
	readonly column: number;
	readonly expression: "__dirname" | "import.meta.dir";
}

function derivationAt(node: ts.Node): RepositoryPathDerivation["expression"] | undefined {
	if (ts.isIdentifier(node) && node.text === "__dirname") {
		return "__dirname";
	}
	if (
		ts.isPropertyAccessExpression(node) &&
		ts.isMetaProperty(node.expression) &&
		node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
		node.name.text === "dir"
	) {
		return "import.meta.dir";
	}
	return undefined;
}

/** `file` is repository-relative with forward slashes, the form MARKER_FILE is compared against. */
export function scanRepositoryPathDerivations(file: string, source: string): RepositoryPathDerivation[] {
	if (file === MARKER_FILE) {
		return [];
	}
	const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	const found: RepositoryPathDerivation[] = [];
	const visit = (node: ts.Node): void => {
		const expression = derivationAt(node);
		if (expression !== undefined) {
			const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
			found.push({ file, line: line + 1, column: character + 1, expression });
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return found;
}

export function reportLines(found: readonly RepositoryPathDerivation[]): string[] {
	if (found.length === 0) {
		return [];
	}
	return [
		...found.map(
			(derivation) =>
				`${derivation.file}:${derivation.line}:${derivation.column}: ${derivation.expression} derives a repository ` +
				"path outside the marker"
		),
		`Repository paths under ${TEST_TREE} come from REPO_ROOT: import it from ${MARKER_FILE} and path.join(REPO_ROOT, ` +
			"...). Importing the marker is what makes the pre-commit selection run the suite on any staged change.",
	];
}
