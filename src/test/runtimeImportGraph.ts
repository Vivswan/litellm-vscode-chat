/**
 * The runtime import graph of the test trees, shared by the bun-tree purity guard (stackDrift.test.ts) and the
 * pre-commit test selection (scripts/dev/changedBunTests.ts): both answer "which files does this suite load", so one
 * scanner keeps their answers identical. Type-only forms are erased by tsc and bun alike, so they are no edge; a
 * relative specifier no candidate file matches throws, since a pruned subtree hides edges while every guard stays green.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

export interface RuntimeImports {
	/** Every runtime specifier as written, packages included. */
	readonly specs: readonly string[];

	/** The module loads something by a specifier the scanner cannot read, so its edges are incomplete. */
	readonly opaque: boolean;
}

/** What one dynamic import() or require() call loads: its literal specifier, or `opaque` for a non-literal argument. */
type DynamicLoad = { readonly spec: string } | { readonly opaque: true };

/** The specifier an `export ... from` loads; undefined when type-only in either spelling or without a source. */
function reexportSpecifier(node: ts.ExportDeclaration): string | undefined {
	const namedTypeOnly =
		node.exportClause !== undefined &&
		ts.isNamedExports(node.exportClause) &&
		node.exportClause.elements.length > 0 &&
		node.exportClause.elements.every((element) => element.isTypeOnly);
	if (node.isTypeOnly || namedTypeOnly || node.moduleSpecifier === undefined) {
		return undefined;
	}
	return ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
}

/** The specifier a static import, re-export, or import-equals form loads at runtime; undefined for type-only forms. */
function staticSpecifier(node: ts.Node): string | undefined {
	if (ts.isImportDeclaration(node)) {
		const loads = !importClauseIsTypeOnly(node.importClause) && ts.isStringLiteral(node.moduleSpecifier);
		return loads ? node.moduleSpecifier.text : undefined;
	}
	if (ts.isExportDeclaration(node)) {
		return reexportSpecifier(node);
	}
	if (ts.isImportEqualsDeclaration(node)) {
		const reference = node.moduleReference;
		const loads =
			!node.isTypeOnly && ts.isExternalModuleReference(reference) && ts.isStringLiteral(reference.expression);
		return loads ? reference.expression.text : undefined;
	}
	return undefined;
}

/**
 * What a call loads, or undefined for a call that is neither import() nor require(). The type-position import("...")
 * form is an ImportTypeNode, never a CallExpression.
 */
function dynamicLoad(node: ts.CallExpression): DynamicLoad | undefined {
	const callee = node.expression;
	const isImportCall = callee.kind === ts.SyntaxKind.ImportKeyword;
	const isRequireCall = ts.isIdentifier(callee) && callee.text === "require";
	if (!isImportCall && !isRequireCall) {
		return undefined;
	}
	const argument = node.arguments[0];
	if (argument !== undefined && ts.isStringLiteralLike(argument)) {
		return { spec: argument.text };
	}
	return { opaque: true };
}

export function runtimeImports(fileName: string, source: string): RuntimeImports {
	const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
	const specs: string[] = [];
	let opaque = false;
	const visit = (node: ts.Node): void => {
		const spec = staticSpecifier(node);
		if (spec !== undefined) {
			specs.push(spec);
		}
		const load = ts.isCallExpression(node) ? dynamicLoad(node) : undefined;
		if (load !== undefined && "spec" in load) {
			specs.push(load.spec);
		} else if (load !== undefined) {
			opaque = true;
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return { specs, opaque };
}

function importClauseIsTypeOnly(clause: ts.ImportClause | undefined): boolean {
	if (clause === undefined) {
		return false;
	}
	if (clause.isTypeOnly) {
		return true;
	}
	return (
		clause.name === undefined &&
		clause.namedBindings !== undefined &&
		ts.isNamedImports(clause.namedBindings) &&
		clause.namedBindings.elements.length > 0 &&
		clause.namedBindings.elements.every((element) => element.isTypeOnly)
	);
}

function resolveRelative(fromFile: string, spec: string): string {
	const base = path.resolve(path.dirname(fromFile), spec);
	for (const candidate of [
		base,
		`${base}.ts`,
		`${base}.tsx`,
		path.join(base, "index.ts"),
		path.join(base, "index.tsx"),
	]) {
		if (fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
			return candidate;
		}
	}
	throw new Error(
		`${fromFile} imports "${spec}", which resolves to no file this scanner knows; teach resolveRelative the new shape`
	);
}

export interface ModuleEdges extends RuntimeImports {
	/** The relative specifiers, resolved to absolute files. */
	readonly imports: readonly string[];
}

/**
 * Parses each file once for every walk that starts from it. The entries of one tree overlap on src/shared and
 * src/provider almost completely, so a parse per visit redid the same files for every entry and overran the purity
 * guard's budget on a loaded runner.
 */
export class RuntimeImportGraph {
	private readonly edges = new Map<string, ModuleEdges>();

	edgesOf(file: string): ModuleEdges {
		let edges = this.edges.get(file);
		if (edges === undefined) {
			const scanned = runtimeImports(file, fs.readFileSync(file, "utf8"));
			edges = {
				...scanned,
				imports: scanned.specs.filter((spec) => spec.startsWith(".")).map((spec) => resolveRelative(file, spec)),
			};
			this.edges.set(file, edges);
		}
		return edges;
	}

	/** Every file `entryFile` loads at runtime, itself first, in breadth-first order. */
	closureOf(entryFile: string): Set<string> {
		const seen = new Set<string>([entryFile]);
		const queue = [entryFile];
		for (let index = 0; index < queue.length; index++) {
			for (const next of this.edgesOf(queue[index] as string).imports) {
				if (!seen.has(next)) {
					seen.add(next);
					queue.push(next);
				}
			}
		}
		return seen;
	}
}

/** The names `bun test` runs. One definition only: a second spelling could leave a suite unselected or unaudited. */
export const BUN_TEST_FILE = /[._](?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/;

/** Absolute paths of every test file under `root`, skipping the listed absolute directories. */
export function testFilesUnder(root: string, skipDirs: readonly string[] = []): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!skipDirs.includes(full)) {
					walk(full);
				}
			} else if (BUN_TEST_FILE.test(entry.name)) {
				found.push(full);
			}
		}
	};
	walk(root);
	return found;
}
