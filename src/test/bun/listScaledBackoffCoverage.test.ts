import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { BUN_TEST_FILE } from "../runtimeImportGraph";
import { REPO_ROOT } from "../util/repoRoot";
import { baseName, calleeRoot, importStatements, isFile, parsedSource, unwrapped } from "./syntaxWalk";

const SRC = path.join(REPO_ROOT, "src");
const TEST_TREE = path.join(SRC, "test");
const BUN_TREE = path.join(TEST_TREE, "bun");
const SLEEP_MODULE = path.join(SRC, "shared", "util", "timer.ts");
const SLEEP_NAME = "sleepUnlessAborted";
const PRODUCTION_EXTENSIONS = new Set([".ts", ".tsx"]);
const TEST_NAMES = new Set(["test", "it"]);
/** Array methods whose callback runs once per entry. */
const PER_ENTRY_METHODS = new Set([
	"forEach",
	"map",
	"flatMap",
	"reduce",
	"reduceRight",
	"filter",
	"some",
	"every",
	"find",
	"findIndex",
	"findLast",
	"findLastIndex",
]);
/** Methods that hand back a view of the list they were called on, so a loop over the result still runs per entry. */
const LIST_VIEW_METHODS = new Set([
	"entries",
	"keys",
	"values",
	"slice",
	"filter",
	"map",
	"reverse",
	"toReversed",
	"sort",
	"toSorted",
	"concat",
	"flat",
]);
/** `Object.<name>(record)` and `Array.from(list)` enumerate their argument. */
const ENUMERATING_STATICS = new Set(["Object.entries", "Object.keys", "Object.values", "Array.from"]);

const rel = (file: string): string => path.relative(REPO_ROOT, file).split(path.sep).join("/");

/** Something a bun test can drive that sleeps real time; `sleepParameter` is the position a zero sleep goes in. */
interface Sleeper {
	readonly file: string;
	readonly name: string;
	readonly sleepParameter: number | undefined;
}

function resolveRelative(from: string, specifier: string): string | undefined {
	if (!specifier.startsWith(".")) {
		return undefined;
	}
	const base = path.resolve(path.dirname(from), specifier);
	return [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")].find(isFile);
}

interface ValueImport {
	readonly specifier: string;
	readonly target: string | undefined;
	/** The exported name, `default`, or `*` for a namespace import. */
	readonly imported: string;
}

/** Every runtime binding a module imports, by local name. */
function valueImports(sf: ts.SourceFile): Map<string, ValueImport> {
	const imports = new Map<string, ValueImport>();
	for (const { specifier, bindings } of importStatements(sf)) {
		const target = resolveRelative(path.resolve(sf.fileName), specifier);
		for (const { local, imported } of bindings) {
			imports.set(local.text, { specifier, target, imported });
		}
	}
	return imports;
}

function mentions(node: ts.Node, name: string): boolean {
	let found = false;
	const visit = (child: ts.Node): void => {
		if (found) {
			return;
		}
		if (ts.isIdentifier(child) && child.text === name) {
			found = true;
			return;
		}
		ts.forEachChild(child, visit);
	};
	visit(node);
	return found;
}

const hasExportModifier = (node: ts.HasModifiers): boolean =>
	ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;

function parametersOf(node: ts.Node): readonly ts.ParameterDeclaration[] {
	if (ts.isFunctionLike(node)) {
		return node.parameters;
	}
	if (ts.isClassLike(node)) {
		return node.members.find(ts.isConstructorDeclaration)?.parameters ?? [];
	}
	return [];
}

function sleepersOf(file: string): Sleeper[] {
	const sf = parsedSource(file);
	if (file === SLEEP_MODULE) {
		return [{ file, name: SLEEP_NAME, sleepParameter: undefined }];
	}
	const sleepLocal = [...valueImports(sf)].find(
		([, binding]) => binding.target === SLEEP_MODULE && binding.imported === SLEEP_NAME
	)?.[0];
	if (sleepLocal === undefined) {
		return [];
	}
	const sleepers: Sleeper[] = [];
	const record = (name: string, declaration: ts.Node): void => {
		if (!mentions(declaration, sleepLocal)) {
			return;
		}
		const index = parametersOf(declaration).findIndex(
			(parameter) => parameter.initializer !== undefined && baseName(parameter.initializer) === sleepLocal
		);
		sleepers.push({ file, name, sleepParameter: index === -1 ? undefined : index });
	};
	for (const statement of sf.statements) {
		if (
			(ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
			statement.name !== undefined &&
			hasExportModifier(statement)
		) {
			record(statement.name.text, statement);
		} else if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
					record(declaration.name.text, unwrapped(declaration.initializer));
				}
			}
		}
	}
	return sleepers;
}

function walkFiles(root: string, keep: (file: string) => boolean): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
		const file = path.join(entry.parentPath, entry.name);
		if (entry.isFile() && keep(file)) {
			files.push(file);
		}
	}
	return files.sort();
}

function productionSleepers(): Map<string, Sleeper[]> {
	const sleepers = new Map<string, Sleeper[]>();
	const production = walkFiles(
		SRC,
		(file) =>
			!file.startsWith(TEST_TREE + path.sep) && !file.endsWith(".d.ts") && PRODUCTION_EXTENSIONS.has(path.extname(file))
	);
	for (const file of production) {
		const found = sleepersOf(file);
		if (found.length > 0) {
			sleepers.set(file, found);
		}
	}
	return sleepers;
}

type FunctionNode = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;

const isFunctionNode = (node: ts.Node): node is FunctionNode =>
	ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node);

/** What a name stands for at one reference, by lexical scope. */
type Declaration =
	| { readonly kind: "import"; readonly local: string }
	| { readonly kind: "function"; readonly node: FunctionNode }
	| { readonly kind: "value"; readonly node: ts.VariableDeclaration }
	| { readonly kind: "parameter"; readonly node: ts.ParameterDeclaration }
	| { readonly kind: "opaque" };

const OPAQUE: Declaration = { kind: "opaque" };

const isScope = (node: ts.Node): boolean =>
	ts.isSourceFile(node) ||
	ts.isBlock(node) ||
	ts.isModuleBlock(node) ||
	ts.isCaseBlock(node) ||
	ts.isFunctionLike(node) ||
	ts.isForStatement(node) ||
	ts.isForOfStatement(node) ||
	ts.isForInStatement(node) ||
	ts.isCatchClause(node) ||
	ts.isClassLike(node);

/** Every identifier reference in `sf` resolved to its declaration; a name declared nowhere in reach is absent. */
function resolveReferences(
	sf: ts.SourceFile,
	imports: ReadonlyMap<string, ValueImport>
): Map<ts.Identifier, Declaration> {
	const resolved = new Map<ts.Identifier, Declaration>();
	const declare = (scope: Map<string, Declaration>, name: ts.BindingName, declaration: Declaration): void => {
		if (ts.isIdentifier(name)) {
			scope.set(name.text, declaration);
			return;
		}
		for (const element of name.elements) {
			if (ts.isBindingElement(element)) {
				declare(scope, element.name, OPAQUE);
			}
		}
	};
	const declareVariable = (scope: Map<string, Declaration>, declaration: ts.VariableDeclaration): void => {
		const initializer = declaration.initializer === undefined ? undefined : unwrapped(declaration.initializer);
		declare(
			scope,
			declaration.name,
			initializer !== undefined && isFunctionNode(initializer)
				? { kind: "function", node: initializer }
				: { kind: "value", node: declaration }
		);
	};
	const declareStatements = (scope: Map<string, Declaration>, statements: readonly ts.Statement[]): void => {
		for (const statement of statements) {
			if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
				scope.set(statement.name.text, { kind: "function", node: statement });
			} else if (ts.isClassDeclaration(statement) && statement.name !== undefined) {
				scope.set(statement.name.text, OPAQUE);
			} else if (ts.isVariableStatement(statement)) {
				for (const declaration of statement.declarationList.declarations) {
					declareVariable(scope, declaration);
				}
			}
		}
	};
	const declarationsOf = (node: ts.Node): Map<string, Declaration> => {
		const scope = new Map<string, Declaration>();
		if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)) {
			declareStatements(scope, node.statements);
		}
		if (ts.isCaseBlock(node)) {
			for (const clause of node.clauses) {
				declareStatements(scope, clause.statements);
			}
		}
		if (ts.isFunctionLike(node)) {
			for (const parameter of node.parameters) {
				declare(scope, parameter.name, { kind: "parameter", node: parameter });
			}
			if (ts.isFunctionExpression(node) && node.name !== undefined) {
				scope.set(node.name.text, { kind: "function", node });
			}
		}
		if (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) {
			if (node.initializer !== undefined && ts.isVariableDeclarationList(node.initializer)) {
				for (const declaration of node.initializer.declarations) {
					declare(scope, declaration.name, OPAQUE);
				}
			}
		}
		if (ts.isCatchClause(node) && node.variableDeclaration !== undefined) {
			declare(scope, node.variableDeclaration.name, OPAQUE);
		}
		if (ts.isClassLike(node) && node.name !== undefined) {
			scope.set(node.name.text, OPAQUE);
		}
		return scope;
	};
	const lookup = (chain: readonly Map<string, Declaration>[], name: string): Declaration | undefined => {
		for (let index = chain.length - 1; index >= 0; index -= 1) {
			const found = chain[index]?.get(name);
			if (found !== undefined) {
				return found;
			}
		}
		return imports.has(name) ? { kind: "import", local: name } : undefined;
	};
	const visit = (node: ts.Node, chain: readonly Map<string, Declaration>[]): void => {
		const inner = isScope(node) ? [...chain, declarationsOf(node)] : chain;
		if (ts.isIdentifier(node)) {
			const found = lookup(inner, node.text);
			if (found !== undefined) {
				resolved.set(node, found);
			}
			return;
		}
		ts.forEachChild(node, (child) => visit(child, inner));
	};
	visit(sf, []);
	return resolved;
}

/**
 * Visits what runs when `node` runs, in source order: a nested function only where a call receives it (so a thunk
 * built for later is skipped), never a type, never a declaration's or member's name. `visit` returns false to keep
 * the walk out of a node's children.
 */
function eachExecuted(
	node: ts.Node,
	asCallback: boolean,
	visit: (child: ts.Node, asCallback: boolean) => boolean
): void {
	const walk = (child: ts.Node, asCallbackHere: boolean): void => {
		if (ts.isTypeNode(child) || ts.isTypeAliasDeclaration(child) || ts.isInterfaceDeclaration(child)) {
			return;
		}
		if (ts.isExpression(child) && unwrapped(child) !== child) {
			walk(unwrapped(child), asCallbackHere);
			return;
		}
		if (ts.isFunctionLike(child) && !asCallbackHere) {
			return;
		}
		if (!visit(child, asCallbackHere)) {
			return;
		}
		if (ts.isVariableDeclaration(child) || ts.isParameter(child) || ts.isPropertyAssignment(child)) {
			if (child.initializer !== undefined) {
				walk(child.initializer, false);
			}
			return;
		}
		if (ts.isPropertyAccessExpression(child)) {
			walk(child.expression, false);
			return;
		}
		if (ts.isCallExpression(child) || ts.isNewExpression(child)) {
			walk(child.expression, ts.isFunctionLike(unwrapped(child.expression)));
			for (const argument of child.arguments ?? []) {
				walk(argument, true);
			}
			return;
		}
		ts.forEachChild(child, (grandchild) => walk(grandchild, false));
	};
	walk(node, asCallback);
}

/** The first uninjected sleeper site a loop body reaches, and whether the body drives any sleeper at all. */
interface Drive {
	readonly site: { readonly description: string; readonly sleeper: Sleeper } | undefined;
	readonly drives: boolean;
}

interface Audit {
	readonly problems: string[];
	readonly testFiles: number;
	/** Loops over an import inside a test, whether or not the body sleeps. */
	readonly listLoops: number;
	/** Loops over an import whose body drives a sleeper, injected or not. */
	readonly drives: number;
}

function analyzeTest(sf: ts.SourceFile, sleepers: Map<string, Sleeper[]>, exemplar: Sleeper | undefined): Audit {
	const file = path.resolve(sf.fileName);
	const imports = valueImports(sf);
	const resolved = resolveReferences(sf, imports);
	const problems: string[] = [];
	let listLoops = 0;
	let drives = 0;
	const lineOf = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
	const declarationOf = (expression: ts.Expression): Declaration | undefined => {
		const inner = unwrapped(expression);
		return ts.isIdentifier(inner) ? resolved.get(inner) : undefined;
	};
	const importOf = (expression: ts.Expression): ValueImport | undefined => {
		const found = declarationOf(expression);
		return found?.kind === "import" ? imports.get(found.local) : undefined;
	};

	const sleeperFor = (expression: ts.Expression): Sleeper | undefined => {
		const inner = unwrapped(expression);
		if (ts.isPropertyAccessExpression(inner)) {
			const binding = importOf(inner.expression);
			return binding?.target === undefined || binding.imported !== "*"
				? undefined
				: sleepers.get(binding.target)?.find((sleeper) => sleeper.name === inner.name.text);
		}
		const binding = importOf(inner);
		return binding?.target === undefined
			? undefined
			: sleepers.get(binding.target)?.find((sleeper) => sleeper.name === binding.imported);
	};

	/** The expression is the real sleep, imported directly, through a namespace, or stored in a local. */
	const isRealSleep = (expression: ts.Expression, visited: Set<ts.Node>): boolean => {
		if (sleeperFor(expression)?.name === SLEEP_NAME) {
			return true;
		}
		const declaration = declarationOf(expression);
		if (declaration?.kind !== "value" || declaration.node.initializer === undefined || visited.has(declaration.node)) {
			return false;
		}
		visited.add(declaration.node);
		return isRealSleep(declaration.node.initializer, visited);
	};

	const isUndefined = (expression: ts.Expression): boolean => {
		const inner = unwrapped(expression);
		return ts.isIdentifier(inner) && inner.text === "undefined";
	};

	/** The sleep argument is present and is neither `undefined` nor the real sleep handed back in. */
	const injected = (sleeper: Sleeper, args: readonly ts.Expression[]): boolean => {
		if (sleeper.sleepParameter === undefined) {
			return false;
		}
		if (args.slice(0, sleeper.sleepParameter + 1).some(ts.isSpreadElement)) {
			return true;
		}
		const argument = args[sleeper.sleepParameter];
		return argument !== undefined && !isUndefined(argument) && !isRealSleep(argument, new Set());
	};

	/** What a call runs in the callee: the defaults of the parameters it leaves out or passes `undefined`, then the body. */
	const calledBodies = (declaration: Declaration, args: readonly ts.Expression[]): ts.Node[] =>
		declaration.kind !== "function"
			? []
			: [
					...declaration.node.parameters.flatMap((parameter, position) => {
						const argument = args[position];
						return parameter.initializer !== undefined && (argument === undefined || isUndefined(argument))
							? [parameter.initializer]
							: [];
					}),
					...(declaration.node.body === undefined ? [] : [declaration.node.body]),
				];

	const initializerOf = (declaration: Declaration): ts.Node[] =>
		declaration.kind === "value" && declaration.node.initializer !== undefined ? [declaration.node.initializer] : [];

	/** A value whose initializer names another declaration stands for it, one level deep (`const run = exchange`). */
	const aliasTarget = (declaration: Declaration): Declaration =>
		declaration.kind === "value" && declaration.node.initializer !== undefined
			? (declarationOf(declaration.node.initializer) ?? declaration)
			: declaration;

	const driveOf = (node: ts.Node, visited: Set<ts.Node>, asCallback: boolean): Drive => {
		let site: Drive["site"];
		let drives = false;
		const follow = (
			declaration: Declaration,
			bodies: readonly ts.Node[],
			name: string,
			asCallbackThere: boolean
		): void => {
			for (const body of bodies) {
				if (site !== undefined) {
					return;
				}
				if (visited.has(body)) {
					continue;
				}
				visited.add(body);
				const inner = driveOf(body, visited, asCallbackThere);
				drives ||= inner.drives;
				if (inner.site !== undefined) {
					site = {
						sleeper: inner.site.sleeper,
						description:
							declaration.kind === "function"
								? `${inner.site.description}, through ${name}()`
								: `${inner.site.description}, held by "${name}"`,
					};
				}
			}
		};
		eachExecuted(node, asCallback, (child, asCallbackHere) => {
			if (site !== undefined) {
				return false;
			}
			if (ts.isNewExpression(child) || ts.isCallExpression(child)) {
				const found = sleeperFor(child.expression);
				const args = child.arguments ?? [];
				if (found !== undefined) {
					drives = true;
					if (!injected(found, args)) {
						site = {
							sleeper: found,
							description: `${ts.isNewExpression(child) ? "new " : ""}${found.name} at line ${lineOf(child)}`,
						};
						return false;
					}
				}
				const callee = unwrapped(child.expression);
				const declaration = ts.isIdentifier(callee) ? resolved.get(callee) : undefined;
				if (declaration !== undefined && ts.isIdentifier(callee)) {
					const target = aliasTarget(declaration);
					follow(
						target,
						target.kind === "function" ? calledBodies(target, args) : initializerOf(target),
						callee.text,
						true
					);
				}
				return true;
			}
			if (ts.isIdentifier(child)) {
				const declaration = resolved.get(child);
				if (declaration?.kind === "value") {
					follow(declaration, initializerOf(declaration), child.text, asCallbackHere);
				} else if (declaration?.kind === "function" && asCallbackHere) {
					follow(declaration, calledBodies(declaration, []), child.text, true);
				}
				return false;
			}
			return true;
		});
		return { site, drives };
	};

	/** Per test: the imported lists each helper parameter receives, and the parameters some call leaves to their default. */
	let parameterLists = new Map<ts.ParameterDeclaration, Set<string>>();
	let defaultedParameters = new Set<ts.ParameterDeclaration>();

	const stripAwait = (expression: ts.Expression): ts.Expression => {
		const inner = unwrapped(expression);
		return ts.isAwaitExpression(inner) ? unwrapped(inner.expression) : inner;
	};

	/** The imported binding a loop subject enumerates, through views, spreads, members, aliases, and parameters. */
	const listRoot = (expression: ts.Expression, visited: Set<ts.Node>): string | undefined => {
		const inner = stripAwait(expression);
		if (ts.isIdentifier(inner)) {
			const declaration = resolved.get(inner);
			if (declaration?.kind === "import") {
				return declaration.local;
			}
			if (declaration?.kind === "parameter") {
				const passed = parameterLists.get(declaration.node)?.values().next().value;
				if (
					passed !== undefined ||
					!defaultedParameters.has(declaration.node) ||
					declaration.node.initializer === undefined ||
					visited.has(declaration.node)
				) {
					return passed;
				}
				visited.add(declaration.node);
				return listRoot(declaration.node.initializer, visited);
			}
			if (
				declaration?.kind === "value" &&
				declaration.node.initializer !== undefined &&
				!visited.has(declaration.node)
			) {
				visited.add(declaration.node);
				return listRoot(declaration.node.initializer, visited);
			}
			return undefined;
		}
		if (ts.isArrayLiteralExpression(inner)) {
			for (const element of inner.elements) {
				if (ts.isSpreadElement(element)) {
					const root = listRoot(element.expression, visited);
					if (root !== undefined) {
						return root;
					}
				}
			}
			return undefined;
		}
		if (ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner)) {
			return listRoot(inner.expression, visited);
		}
		if (ts.isCallExpression(inner)) {
			const callee = unwrapped(inner.expression);
			if (!ts.isPropertyAccessExpression(callee)) {
				return undefined;
			}
			const base = baseName(callee.expression);
			const [first] = inner.arguments;
			if (base !== undefined && ENUMERATING_STATICS.has(`${base}.${callee.name.text}`) && first !== undefined) {
				return listRoot(first, visited);
			}
			return LIST_VIEW_METHODS.has(callee.name.text) ? listRoot(callee.expression, visited) : undefined;
		}
		return undefined;
	};

	interface Loop {
		readonly node: ts.Node;
		readonly list: string;
		readonly bodies: readonly ts.Node[];
	}

	const loopOf = (node: ts.Node): Loop | undefined => {
		if (ts.isForOfStatement(node)) {
			const list = listRoot(node.expression, new Set());
			return list === undefined ? undefined : { node, list, bodies: [node.statement] };
		}
		if (ts.isForStatement(node) && node.condition !== undefined) {
			let list: string | undefined;
			const scan = (child: ts.Node): void => {
				if (list === undefined && ts.isPropertyAccessExpression(child) && child.name.text === "length") {
					list = listRoot(child.expression, new Set());
				}
				ts.forEachChild(child, scan);
			};
			scan(node.condition);
			return list === undefined ? undefined : { node, list, bodies: [node.statement] };
		}
		if (ts.isCallExpression(node)) {
			const callee = unwrapped(node.expression);
			if (ts.isPropertyAccessExpression(callee) && PER_ENTRY_METHODS.has(callee.name.text)) {
				const list = listRoot(callee.expression, new Set());
				return list === undefined ? undefined : { node, list, bodies: node.arguments };
			}
		}
		return undefined;
	};

	/**
	 * The test callback plus every same-file function it calls or hands to a call, to a fixpoint, binding each helper
	 * parameter to the imported lists its call sites pass so a loop inside the helper still names the list.
	 */
	const reachableBodies = (callback: ts.Node): ts.Node[] => {
		parameterLists = new Map();
		defaultedParameters = new Set();
		const bodies = [callback];
		const seen = new Set<ts.Node>([callback]);
		for (let grew = true; grew; ) {
			grew = false;
			const reach = (
				declaration: Declaration | undefined,
				args: readonly ts.Expression[]
			): FunctionNode | undefined => {
				const target = declaration === undefined ? undefined : aliasTarget(declaration);
				if (target?.kind !== "function") {
					return undefined;
				}
				for (const body of calledBodies(target, args)) {
					if (!seen.has(body)) {
						seen.add(body);
						bodies.push(body);
						grew = true;
					}
				}
				return target.node;
			};
			for (let index = 0; index < bodies.length; index += 1) {
				eachExecuted(bodies[index] as ts.Node, true, (child, asCallback) => {
					if (ts.isCallExpression(child) || ts.isNewExpression(child)) {
						const args = child.arguments ?? [];
						const called = reach(declarationOf(child.expression), args);
						called?.parameters.forEach((parameter, position) => {
							const argument = args[position];
							if (argument === undefined || isUndefined(argument)) {
								if (!defaultedParameters.has(parameter)) {
									defaultedParameters.add(parameter);
									grew = true;
								}
								return;
							}
							const list = listRoot(argument, new Set());
							if (list !== undefined && !parameterLists.get(parameter)?.has(list)) {
								parameterLists.set(parameter, new Set([...(parameterLists.get(parameter) ?? []), list]));
								grew = true;
							}
						});
					} else if (ts.isIdentifier(child) && asCallback) {
						reach(resolved.get(child), []);
					}
					return true;
				});
			}
		}
		return bodies;
	};

	const remedy = (sleeper: Sleeper): string => {
		if (sleeper.name === SLEEP_NAME) {
			return `${SLEEP_NAME} is the sleep itself, so take it out of the loop`;
		}
		if (sleeper.sleepParameter !== undefined) {
			return `pass a zero sleep (const noBackoff = () => Promise.resolve()) as argument ${sleeper.sleepParameter + 1} of ${sleeper.name}`;
		}
		const model = exemplar === undefined ? "" : `, as ${exemplar.name} (${rel(exemplar.file)}) has,`;
		return `${sleeper.name} (${rel(sleeper.file)}) takes no sleep: give it a sleep parameter defaulting to ${SLEEP_NAME}${model} and pass a zero sleep here`;
	};

	const runnerNamespaces = new Set(
		[...imports]
			.filter(([, binding]) => binding.specifier === "bun:test" && binding.imported === "*")
			.map(([local]) => local)
	);
	const testLocals = new Set(
		[...imports]
			.filter(([, binding]) => binding.specifier === "bun:test" && TEST_NAMES.has(binding.imported))
			.map(([local]) => local)
	);
	const registersTest = (callee: ts.Expression): boolean => {
		const found = calleeRoot(callee);
		if (found === undefined) {
			return false;
		}
		return runnerNamespaces.has(found.root.text)
			? found.member !== undefined && TEST_NAMES.has(found.member)
			: testLocals.has(found.root.text);
	};
	const callbackBody = (argument: ts.Expression | undefined): ts.Node | undefined => {
		if (argument === undefined) {
			return undefined;
		}
		const inner = unwrapped(argument);
		if (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) {
			return inner;
		}
		const declaration = declarationOf(inner);
		return declaration?.kind === "function" ? declaration.node.body : undefined;
	};

	const visitTests = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && registersTest(node.expression)) {
			const [label, second] = node.arguments;
			const callback = callbackBody(second);
			if (callback !== undefined) {
				const subject = label !== undefined && ts.isStringLiteralLike(label) ? label.text : node.expression.getText(sf);
				for (const body of reachableBodies(callback)) {
					eachExecuted(body, true, (child) => {
						const loop = loopOf(child);
						if (loop === undefined) {
							return true;
						}
						listLoops += 1;
						const visited = new Set<ts.Node>();
						const drive = loop.bodies.reduce<Drive>(
							(found, part) => {
								if (found.site !== undefined) {
									return found;
								}
								const next = driveOf(part, visited, true);
								return { site: next.site, drives: found.drives || next.drives };
							},
							{ site: undefined, drives: false }
						);
						if (drive.drives) {
							drives += 1;
						}
						if (drive.site !== undefined) {
							const binding = imports.get(loop.list);
							problems.push(
								`${rel(file)}:${lineOf(node)} test "${subject}" drives ${drive.site.description} inside a loop (line ${lineOf(loop.node)}) over ${loop.list} imported from "${binding?.specifier ?? "?"}", paying the retry backoff once per entry; ${remedy(drive.site.sleeper)}`
							);
						}
						return true;
					});
				}
			}
		}
		ts.forEachChild(node, visitTests);
	};
	visitTests(sf);
	return { problems, testFiles: 1, listLoops, drives };
}

function sum(audits: readonly Audit[]): Audit {
	return audits.reduce(
		(total, audit) => ({
			problems: [...total.problems, ...audit.problems],
			testFiles: total.testFiles + audit.testFiles,
			listLoops: total.listLoops + audit.listLoops,
			drives: total.drives + audit.drives,
		}),
		{ problems: [], testFiles: 0, listLoops: 0, drives: 0 }
	);
}

const exemplarOf = (sleepers: Map<string, Sleeper[]>): Sleeper | undefined =>
	[...sleepers.values()].flat().find((sleeper) => sleeper.sleepParameter !== undefined);

function audit(sleepers: Map<string, Sleeper[]>): Audit {
	const exemplar = exemplarOf(sleepers);
	const testFiles = walkFiles(BUN_TREE, (file) => BUN_TEST_FILE.test(path.basename(file)));
	return sum(testFiles.map((file) => analyzeTest(parsedSource(file), sleepers, exemplar)));
}

/** A fixture parsed as if it sat in the bun tree, so its relative imports resolve to the real production modules. */
function fixture(source: string): ts.SourceFile {
	return ts.createSourceFile(
		path.join(BUN_TREE, "provider", "transport", "listScaledFixture.test.ts"),
		source,
		ts.ScriptTarget.Latest,
		false
	);
}

const FIXTURE_HEADER = `
import { test } from "bun:test";
import { OAuthTokenSource } from "../../../../provider/transport/auth";
import { retryIdempotent } from "../../../../provider/transport/retry";
import * as timers from "../../../../shared/util/timer";
import { TRANSPORT_ERROR_SURFACES } from "../../../../provider/transport/transportErrors";
const noBackoff = () => Promise.resolve();
const CONFIG = { tokenUrl: "http://litellm.test", clientId: "c", clientSecret: "s" };
const BUDGET = { ms: 1, setting: undefined };
async function exchange(surface: string, source = new OAuthTokenSource()): Promise<void> {
	await source.getToken(CONFIG, surface, BUDGET);
}
`;

interface Shape {
	readonly shape: string;
	readonly source: string;
	readonly problems: number;
	readonly listLoops: number;
	readonly drives: number;
	readonly names?: string;
}

/** Every shape the detector names, red or green, as the fixture that proves it. Line 10 is `exchange`'s default source. */
const SHAPES: Shape[] = [
	{
		shape: "for..of over the import, the sleeper built in a same-file helper",
		source: `test("sweep", async () => { for (const surface of TRANSPORT_ERROR_SURFACES) { await exchange(surface); } });`,
		problems: 1,
		listLoops: 1,
		drives: 1,
		names: 'test "sweep" drives new OAuthTokenSource at line 10, through exchange() inside a loop (line 14)',
	},
	{
		shape: "the same loop with a zero sleep injected",
		source: `test("sweep", async () => { for (const surface of TRANSPORT_ERROR_SURFACES) { await exchange(surface, new OAuthTokenSource(noBackoff)); } });`,
		problems: 0,
		listLoops: 1,
		drives: 1,
	},
	{
		shape: "forEach with an async callback",
		source: `test("sweep", () => { TRANSPORT_ERROR_SURFACES.forEach(async (surface) => { await exchange(surface); }); });`,
		problems: 1,
		listLoops: 1,
		drives: 1,
	},
	{
		shape: "a named function handed to map",
		source: `test("sweep", async () => { await Promise.all(TRANSPORT_ERROR_SURFACES.map(exchange)); });`,
		problems: 1,
		listLoops: 1,
		drives: 1,
	},
	{
		shape: "a classic for over the import's length",
		source: `test("sweep", async () => { for (let i = 0; i < TRANSPORT_ERROR_SURFACES.length; i += 1) { await exchange(TRANSPORT_ERROR_SURFACES[i]); } });`,
		problems: 1,
		listLoops: 1,
		drives: 1,
	},
	{
		shape: "the import handed to a helper whose parameter is looped",
		source: `async function sweep(surfaces: readonly string[]) { for (const surface of surfaces) { await exchange(surface); } }
test("sweep", async () => { await sweep(TRANSPORT_ERROR_SURFACES); });`,
		problems: 1,
		listLoops: 1,
		drives: 1,
	},
	{
		shape: "the import as a helper parameter's default",
		source: `async function sweep(surfaces = TRANSPORT_ERROR_SURFACES) { for (const surface of surfaces) { await exchange(surface); } }
test("sweep", async () => { await sweep(); });`,
		problems: 1,
		listLoops: 1,
		drives: 1,
	},
	{
		shape: "an explicit undefined that lets the helper's default sleeper run",
		source: `test("sweep", async () => { for (const surface of TRANSPORT_ERROR_SURFACES) { await exchange(surface, undefined); } });`,
		problems: 1,
		listLoops: 1,
		drives: 1,
	},
	{
		shape: "an instance built outside the test and driven inside the loop",
		source: `const source = new OAuthTokenSource();
test("sweep", async () => { for (const surface of TRANSPORT_ERROR_SURFACES) { await source.getToken(CONFIG, surface, BUDGET); } });`,
		problems: 1,
		listLoops: 1,
		drives: 1,
		names: 'drives new OAuthTokenSource at line 14, held by "source"',
	},
	{
		shape: "a named function registered as the callback",
		source: `async function sweep() { for (const surface of TRANSPORT_ERROR_SURFACES) { await exchange(surface); } }
test("sweep", sweep);`,
		problems: 1,
		listLoops: 1,
		drives: 1,
	},
	{
		shape: "the real sleep handed back in through a namespace import",
		source: `test("sweep", async () => { for (const surface of TRANSPORT_ERROR_SURFACES) { await exchange(surface, new OAuthTokenSource(timers.sleepUnlessAborted)); } });`,
		problems: 1,
		listLoops: 1,
		drives: 1,
	},
	{
		shape: "the real sleep handed back in through a local",
		source: `const sleep = timers.sleepUnlessAborted;
test("sweep", async () => { for (const surface of TRANSPORT_ERROR_SURFACES) { await exchange(surface, new OAuthTokenSource(sleep)); } });`,
		problems: 1,
		listLoops: 1,
		drives: 1,
	},
	{
		shape: "a sleeper with no sleep parameter",
		source: `test("sweep", async () => { for (const surface of TRANSPORT_ERROR_SURFACES) { await retryIdempotent(() => Promise.reject(new Error(surface)), { maxRetries: 2, signal: new AbortController().signal }); } });`,
		problems: 1,
		listLoops: 1,
		drives: 1,
		names:
			"retryIdempotent (src/provider/transport/retry.ts) takes no sleep: give it a sleep parameter defaulting to sleepUnlessAborted, as OAuthTokenSource (src/provider/transport/auth.ts) has, and pass a zero sleep here",
	},
	{
		shape: "the same local name in two tests resolves to its own declaration",
		source: `test("first", async () => { const source = new OAuthTokenSource(); for (const surface of TRANSPORT_ERROR_SURFACES) { await source.getToken(CONFIG, surface, BUDGET); } });
test("second", async () => { const source = new OAuthTokenSource(noBackoff); for (const surface of TRANSPORT_ERROR_SURFACES) { await source.getToken(CONFIG, surface, BUDGET); } });`,
		problems: 1,
		listLoops: 2,
		drives: 2,
		names: 'test "first"',
	},
	{
		shape: "an immediately invoked function inside the loop body",
		source: `test("sweep", async () => { for (const surface of TRANSPORT_ERROR_SURFACES) { await (async () => { await exchange(surface); })(); } });`,
		problems: 1,
		listLoops: 1,
		drives: 1,
	},
	{
		shape: "a local list named like another test's alias of the import",
		source: `test("first", () => { const rows = TRANSPORT_ERROR_SURFACES; if (rows.length === 0) { throw new Error("empty"); } });
test("second", async () => { const rows = ["chat", "discovery"]; for (const row of rows) { await exchange(row); } });`,
		problems: 0,
		listLoops: 0,
		drives: 0,
	},
	{
		shape: "a helper only mentioned, never called",
		source: `test("sweep", () => { const jobs = TRANSPORT_ERROR_SURFACES.map(() => exchange); if (jobs.length === 0) { throw new Error("empty"); } });`,
		problems: 0,
		listLoops: 1,
		drives: 0,
	},
	{
		shape: "a helper's alias only mentioned, never called",
		source: `const run = exchange;
test("sweep", () => { const jobs = TRANSPORT_ERROR_SURFACES.map(() => run); if (jobs.length === 0) { throw new Error("empty"); } });`,
		problems: 0,
		listLoops: 1,
		drives: 0,
	},
	{
		shape: "a helper's alias called in the loop",
		source: `const run = exchange;
test("sweep", async () => { for (const surface of TRANSPORT_ERROR_SURFACES) { await run(surface); } });`,
		problems: 1,
		listLoops: 1,
		drives: 1,
	},
	{
		shape: "a helper's alias called with a zero sleep",
		source: `const run = exchange;
test("sweep", async () => { for (const surface of TRANSPORT_ERROR_SURFACES) { await run(surface, new OAuthTokenSource(noBackoff)); } });`,
		problems: 0,
		listLoops: 1,
		drives: 1,
	},
	{
		shape: "a helper called once with a local list and once left to its import default",
		source: `async function sweep(surfaces = TRANSPORT_ERROR_SURFACES) { for (const surface of surfaces) { await exchange(surface); } }
test("both", async () => { await sweep(["chat"]); await sweep(); });`,
		problems: 1,
		listLoops: 1,
		drives: 1,
	},
	{
		shape: "a local list passed where the helper's default is the import",
		source: `async function sweep(surfaces = TRANSPORT_ERROR_SURFACES) { for (const surface of surfaces) { await exchange(surface); } }
test("local", async () => { await sweep(["chat"]); });`,
		problems: 0,
		listLoops: 0,
		drives: 0,
	},
	{
		shape: "one helper, one test passing the import and one a local list",
		source: `async function sweep(surfaces: readonly string[]) { for (const surface of surfaces) { await exchange(surface); } }
test("local", async () => { await sweep(["chat"]); });
test("imported", async () => { await sweep(TRANSPORT_ERROR_SURFACES); });`,
		problems: 1,
		listLoops: 1,
		drives: 1,
		names: 'test "imported"',
	},
	{
		shape: "thunks built per entry for later",
		source: `test("sweep", () => { const jobs = TRANSPORT_ERROR_SURFACES.map((surface) => () => exchange(surface)); if (jobs.length === 0) { throw new Error("empty"); } });`,
		problems: 0,
		listLoops: 1,
		drives: 0,
	},
	{
		shape: "a looping helper built but never called",
		source: `async function sweep() { for (const surface of TRANSPORT_ERROR_SURFACES) { await exchange(surface); } }
test("factory", () => { const job = () => sweep(); if (typeof job !== "function") { throw new Error("bad job"); } });`,
		problems: 0,
		listLoops: 0,
		drives: 0,
	},
	{
		shape: "a loop over a local literal",
		source: `test("sweep", async () => { for (const surface of ["chat", "discovery"]) { await exchange(surface); } });`,
		problems: 0,
		listLoops: 0,
		drives: 0,
	},
	{
		shape: "a sleeper named only in a type position",
		source: `const source = new OAuthTokenSource();
test("sweep", () => { for (const surface of TRANSPORT_ERROR_SURFACES) { type Source = typeof source; const label: Source | string = surface; if (label === "") { throw new Error("empty"); } } });`,
		problems: 0,
		listLoops: 1,
		drives: 0,
	},
];

const sleepers = productionSleepers();

test.each(SHAPES)("the detector reads the shape: $shape", ({ source, problems, listLoops, drives, names }) => {
	const result = analyzeTest(fixture(`${FIXTURE_HEADER}\n${source}\n`), sleepers, exemplarOf(sleepers));
	expect({ problems: result.problems.length, listLoops: result.listLoops, drives: result.drives }).toEqual({
		problems,
		listLoops,
		drives,
	});
	if (names !== undefined) {
		expect(result.problems[0]).toContain(names);
	}
});

test("every bun test that drives a backoff sleeper once per entry of an imported list injects a zero sleep", () => {
	expect([...sleepers.values()].flat().length).toBeGreaterThan(0);
	const result = audit(sleepers);
	expect(result.problems).toEqual([]);
	expect(result.testFiles).toBeGreaterThan(0);
});
