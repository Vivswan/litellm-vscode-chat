import { expect, test } from "bun:test";
import path from "node:path";
import ts from "typescript";
import { testFilesUnder } from "../runtimeImportGraph";
import { shippedSources } from "../sourceScan";
import { REPO_ROOT } from "../util/repoRoot";
import { baseName, calleeRoot, importStatements, isFile, parsedSource, unwrapped } from "./syntaxWalk";

const SRC = path.join(REPO_ROOT, "src");
const TEST_TREE = path.join(SRC, "test");
const BUN_TREE = path.join(TEST_TREE, "bun");
const SLEEP_MODULE = path.join(SRC, "shared", "util", "timer.ts");
const SLEEP_NAME = "sleepUnlessAborted";
const TEST_NAMES = new Set(["test", "it"]);
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

/** One runtime import binding; `imported` is the exported name, `default`, or `*` for a namespace import. */
interface ValueImport {
	readonly specifier: string;
	readonly target: string | undefined;
	readonly imported: string;
}

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

/** Every exported declaration of a module by name: a function or class itself, a variable through its initializer. */
function exportedDeclarations(sf: ts.SourceFile): [string, ts.Node][] {
	const found: [string, ts.Node][] = [];
	for (const statement of sf.statements) {
		if (
			(ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
			statement.name !== undefined &&
			hasExportModifier(statement)
		) {
			found.push([statement.name.text, statement]);
			continue;
		}
		if (!ts.isVariableStatement(statement) || !hasExportModifier(statement)) {
			continue;
		}
		for (const declaration of statement.declarationList.declarations) {
			if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
				found.push([declaration.name.text, unwrapped(declaration.initializer)]);
			}
		}
	}
	return found;
}

/**
 * An exported declaration judged as a sleeper: `declaration` is the node `file` exports as `name`, and `sleepLocal`
 * is the name that file imports sleepUnlessAborted under.
 */
interface SleeperCandidate {
	readonly file: string;
	readonly name: string;
	readonly declaration: ts.Node;
	readonly sleepLocal: string;
}

/** The sleeper a declaration mentioning the sleep import is; its zero-sleep slot is the parameter defaulting to it. */
function sleeperOf({ file, name, declaration, sleepLocal }: SleeperCandidate): Sleeper | undefined {
	if (!mentions(declaration, sleepLocal)) {
		return undefined;
	}
	const index = parametersOf(declaration).findIndex(
		(parameter) => parameter.initializer !== undefined && baseName(parameter.initializer) === sleepLocal
	);
	return { file, name, sleepParameter: index === -1 ? undefined : index };
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
	for (const [name, declaration] of exportedDeclarations(sf)) {
		const sleeper = sleeperOf({ file, name, declaration, sleepLocal });
		if (sleeper !== undefined) {
			sleepers.push(sleeper);
		}
	}
	return sleepers;
}

function productionSleepers(): Map<string, Sleeper[]> {
	const sleepers = new Map<string, Sleeper[]>();
	const production = shippedSources()
		.map((source) => path.join(REPO_ROOT, source.file))
		.sort();
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

/** Binds `name` in `scope`: an identifier to `declaration`, each element of a destructuring pattern as opaque. */
function declare(scope: Map<string, Declaration>, name: ts.BindingName, declaration: Declaration): void {
	if (ts.isIdentifier(name)) {
		scope.set(name.text, declaration);
		return;
	}
	for (const element of name.elements) {
		if (ts.isBindingElement(element)) {
			declare(scope, element.name, OPAQUE);
		}
	}
}

/** What a variable stands for: the function its initializer is, or the variable itself as a value. */
function variableDeclaration(declaration: ts.VariableDeclaration): Declaration {
	const initializer = declaration.initializer === undefined ? undefined : unwrapped(declaration.initializer);
	if (initializer !== undefined && isFunctionNode(initializer)) {
		return { kind: "function", node: initializer };
	}
	return { kind: "value", node: declaration };
}

/** Binds what one statement declares: a function or class by its name, a variable statement's every declarator. */
function declareStatement(scope: Map<string, Declaration>, statement: ts.Statement): void {
	if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
		scope.set(statement.name.text, { kind: "function", node: statement });
		return;
	}
	if (ts.isClassDeclaration(statement) && statement.name !== undefined) {
		scope.set(statement.name.text, OPAQUE);
		return;
	}
	if (!ts.isVariableStatement(statement)) {
		return;
	}
	for (const declaration of statement.declarationList.declarations) {
		declare(scope, declaration.name, variableDeclaration(declaration));
	}
}

function declareStatements(scope: Map<string, Declaration>, statements: readonly ts.Statement[]): void {
	for (const statement of statements) {
		declareStatement(scope, statement);
	}
}

/** Binds what a function-like node declares for its body: its parameters, and a function expression's own name. */
function declareSignatureScope(scope: Map<string, Declaration>, node: ts.SignatureDeclaration): void {
	for (const parameter of node.parameters) {
		declare(scope, parameter.name, OPAQUE);
	}
	if (ts.isFunctionExpression(node) && node.name !== undefined) {
		scope.set(node.name.text, { kind: "function", node });
	}
}

/** Binds what a loop head declares for its body: the variables of its initializer, when it declares any. */
function declareLoopScope(
	scope: Map<string, Declaration>,
	node: ts.ForStatement | ts.ForOfStatement | ts.ForInStatement
): void {
	if (node.initializer === undefined || !ts.isVariableDeclarationList(node.initializer)) {
		return;
	}
	for (const declaration of node.initializer.declarations) {
		declare(scope, declaration.name, OPAQUE);
	}
}

/** The names a scope-opening node binds for everything inside it. */
function declarationsOf(node: ts.Node): Map<string, Declaration> {
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
		declareSignatureScope(scope, node);
	}
	if (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) {
		declareLoopScope(scope, node);
	}
	if (ts.isCatchClause(node) && node.variableDeclaration !== undefined) {
		declare(scope, node.variableDeclaration.name, OPAQUE);
	}
	if (ts.isClassLike(node) && node.name !== undefined) {
		scope.set(node.name.text, OPAQUE);
	}
	return scope;
}

function resolveReferences(
	sf: ts.SourceFile,
	imports: ReadonlyMap<string, ValueImport>
): Map<ts.Identifier, Declaration> {
	const resolved = new Map<ts.Identifier, Declaration>();
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

type ExecutedVisit = (child: ts.Node, asCallback: boolean) => boolean;

/**
 * The walk below a visited node: an initializer as code, a property access's object, a call's callee (as a callback
 * when it is a function written in place) and its arguments as callbacks, anything else child by child.
 */
function descendExecuted(child: ts.Node, visit: ExecutedVisit): void {
	if (ts.isVariableDeclaration(child) || ts.isParameter(child) || ts.isPropertyAssignment(child)) {
		if (child.initializer !== undefined) {
			eachExecuted(child.initializer, false, visit);
		}
		return;
	}
	if (ts.isPropertyAccessExpression(child)) {
		eachExecuted(child.expression, false, visit);
		return;
	}
	if (ts.isCallExpression(child) || ts.isNewExpression(child)) {
		eachExecuted(child.expression, ts.isFunctionLike(unwrapped(child.expression)), visit);
		for (const argument of child.arguments ?? []) {
			eachExecuted(argument, true, visit);
		}
		return;
	}
	ts.forEachChild(child, (grandchild) => eachExecuted(grandchild, false, visit));
}

/**
 * Calls `visit` on `node` and on everything under it that runs when `node` runs, type positions skipped; a false from
 * `visit` stops the walk below that node. `asCallback` says a call receives `node`, which is the one place a nested
 * function is followed: a thunk built for later never runs in the loop.
 */
function eachExecuted(node: ts.Node, asCallback: boolean, visit: ExecutedVisit): void {
	if (ts.isTypeNode(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) {
		return;
	}
	if (ts.isExpression(node) && unwrapped(node) !== node) {
		eachExecuted(unwrapped(node), asCallback, visit);
		return;
	}
	if (ts.isFunctionLike(node) && !asCallback) {
		return;
	}
	if (!visit(node, asCallback)) {
		return;
	}
	descendExecuted(node, visit);
}

/** The first uninjected sleeper site a loop body reaches, and whether the body drives any sleeper at all. */
interface Drive {
	readonly site: { readonly description: string; readonly sleeper: Sleeper } | undefined;
	readonly drives: boolean;
}

/** A Drive while the walk is still filling it in. */
interface DriveState {
	site: Drive["site"];
	drives: boolean;
}

/**
 * What the walk found in one test file. `loops` counts loops inside tests, whether or not the body sleeps; `drives`
 * counts loops whose body drives a sleeper, injected or not.
 */
interface Audit {
	readonly problems: string[];
	readonly testFiles: number;
	readonly loops: number;
	readonly drives: number;
}

function analyzeTest(sf: ts.SourceFile, sleepers: Map<string, Sleeper[]>, exemplar: Sleeper | undefined): Audit {
	const file = path.resolve(sf.fileName);
	const imports = valueImports(sf);
	const resolved = resolveReferences(sf, imports);
	const problems: string[] = [];
	let loops = 0;
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

	const calledBodies = (declaration: Declaration, args: readonly ts.Expression[]): ts.Node[] => {
		if (declaration.kind !== "function") {
			return [];
		}
		const defaulted = declaration.node.parameters.flatMap((parameter, position) => {
			const argument = args[position];
			const takesDefault = parameter.initializer !== undefined && (argument === undefined || isUndefined(argument));
			return takesDefault ? [parameter.initializer] : [];
		});
		return declaration.node.body === undefined ? defaulted : [...defaulted, declaration.node.body];
	};

	const initializerOf = (declaration: Declaration): ts.Node[] =>
		declaration.kind === "value" && declaration.node.initializer !== undefined ? [declaration.node.initializer] : [];

	const aliasTarget = (declaration: Declaration): Declaration =>
		declaration.kind === "value" && declaration.node.initializer !== undefined
			? (declarationOf(declaration.node.initializer) ?? declaration)
			: declaration;

	/**
	 * Follows a declaration's bodies, each once per walk, until one reaches a site, which is then described through
	 * the step that led there: a call for a function, a hold for a value. driveOf below recurses back here.
	 */
	const follow = (
		drive: DriveState,
		visited: Set<ts.Node>,
		declaration: Declaration,
		bodies: readonly ts.Node[],
		name: string,
		asCallbackThere: boolean
	): void => {
		for (const body of bodies) {
			if (drive.site !== undefined) {
				return;
			}
			if (visited.has(body)) {
				continue;
			}
			visited.add(body);
			const inner = driveOf(body, visited, asCallbackThere);
			drive.drives ||= inner.drives;
			if (inner.site !== undefined) {
				drive.site = {
					sleeper: inner.site.sleeper,
					description:
						declaration.kind === "function"
							? `${inner.site.description}, through ${name}()`
							: `${inner.site.description}, held by "${name}"`,
				};
			}
		}
	};

	/** The site a driven sleeper is, when its sleep is not injected; undefined when a zero sleep was passed. */
	const uninjectedSite = (
		call: ts.CallExpression | ts.NewExpression,
		found: Sleeper,
		args: readonly ts.Expression[]
	): Drive["site"] => {
		if (injected(found, args)) {
			return undefined;
		}
		const prefix = ts.isNewExpression(call) ? "new " : "";
		return { sleeper: found, description: `${prefix}${found.name} at line ${lineOf(call)}` };
	};

	/** Follows a call into its callee: a function's defaulted parameters and body, or a value's initializer. */
	const followCallee = (
		drive: DriveState,
		visited: Set<ts.Node>,
		callee: ts.Expression,
		args: readonly ts.Expression[]
	): void => {
		const inner = unwrapped(callee);
		if (!ts.isIdentifier(inner)) {
			return;
		}
		const declaration = resolved.get(inner);
		if (declaration === undefined) {
			return;
		}
		const target = aliasTarget(declaration);
		const bodies = target.kind === "function" ? calledBodies(target, args) : initializerOf(target);
		follow(drive, visited, target, bodies, inner.text, true);
	};

	/** Reads a call: a driven sleeper first, then the callee; false stops the walk below a reported site. */
	const visitCall = (drive: DriveState, visited: Set<ts.Node>, call: ts.CallExpression | ts.NewExpression): boolean => {
		const found = sleeperFor(call.expression);
		const args = call.arguments ?? [];
		if (found !== undefined) {
			drive.drives = true;
			const site = uninjectedSite(call, found, args);
			if (site !== undefined) {
				drive.site = site;
				return false;
			}
		}
		followCallee(drive, visited, call.expression, args);
		return true;
	};

	/** Reads a bare identifier: a value's initializer runs where it is read, a function's body only as a callback. */
	const visitIdentifier = (
		drive: DriveState,
		visited: Set<ts.Node>,
		identifier: ts.Identifier,
		asCallbackHere: boolean
	): void => {
		const declaration = resolved.get(identifier);
		if (declaration?.kind === "value") {
			follow(drive, visited, declaration, initializerOf(declaration), identifier.text, asCallbackHere);
		} else if (declaration?.kind === "function" && asCallbackHere) {
			follow(drive, visited, declaration, calledBodies(declaration, []), identifier.text, true);
		}
	};

	const driveOf = (node: ts.Node, visited: Set<ts.Node>, asCallback: boolean): Drive => {
		const drive: DriveState = { site: undefined, drives: false };
		eachExecuted(node, asCallback, (child, asCallbackHere) => {
			if (drive.site !== undefined) {
				return false;
			}
			if (ts.isNewExpression(child) || ts.isCallExpression(child)) {
				return visitCall(drive, visited, child);
			}
			if (ts.isIdentifier(child)) {
				visitIdentifier(drive, visited, child, asCallbackHere);
				return false;
			}
			return true;
		});
		return { site: drive.site, drives: drive.drives };
	};

	interface Loop {
		readonly node: ts.Node;
		readonly subject: string;
		readonly bodies: readonly ts.Node[];
	}

	const loopOf = (node: ts.Node): Loop | undefined => {
		if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
			return { node, subject: node.expression.getText(sf), bodies: [node.statement] };
		}
		if (ts.isForStatement(node)) {
			return { node, subject: node.condition?.getText(sf) ?? "", bodies: [node.statement] };
		}
		if (ts.isWhileStatement(node) || ts.isDoStatement(node)) {
			return { node, subject: node.expression.getText(sf), bodies: [node.statement] };
		}
		if (ts.isCallExpression(node)) {
			const callee = unwrapped(node.expression);
			if (ts.isPropertyAccessExpression(callee) && PER_ENTRY_METHODS.has(callee.name.text)) {
				return { node, subject: callee.expression.getText(sf), bodies: node.arguments };
			}
		}
		return undefined;
	};

	const reachableBodies = (callback: ts.Node): ts.Node[] => {
		const bodies = [callback];
		const seen = new Set<ts.Node>([callback]);
		const reach = (declaration: Declaration | undefined, args: readonly ts.Expression[]): void => {
			const target = declaration === undefined ? undefined : aliasTarget(declaration);
			if (target?.kind !== "function") {
				return;
			}
			for (const body of calledBodies(target, args)) {
				if (!seen.has(body)) {
					seen.add(body);
					bodies.push(body);
				}
			}
		};
		for (let index = 0; index < bodies.length; index += 1) {
			eachExecuted(bodies[index] as ts.Node, true, (child, asCallback) => {
				if (ts.isCallExpression(child) || ts.isNewExpression(child)) {
					reach(declarationOf(child.expression), child.arguments ?? []);
				} else if (ts.isIdentifier(child) && asCallback) {
					reach(resolved.get(child), []);
				}
				return true;
			});
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

	/** The drive of a loop's bodies taken together: the first uninjected site, and whether any body drives a sleeper. */
	const driveOfBodies = (bodies: readonly ts.Node[]): Drive => {
		const visited = new Set<ts.Node>();
		let drives = false;
		for (const part of bodies) {
			const next = driveOf(part, visited, true);
			drives ||= next.drives;
			if (next.site !== undefined) {
				return { site: next.site, drives };
			}
		}
		return { site: undefined, drives };
	};

	/** Counts one loop a test reaches, and reports it when its bodies drive a sleeper whose sleep is not injected. */
	const auditLoop = (loop: Loop, registration: ts.CallExpression, subject: string): void => {
		loops += 1;
		const drive = driveOfBodies(loop.bodies);
		if (drive.drives) {
			drives += 1;
		}
		if (drive.site === undefined) {
			return;
		}
		problems.push(
			`${rel(file)}:${lineOf(registration)} test "${subject}" drives ${drive.site.description} inside a loop ` +
				`(line ${lineOf(loop.node)}) over ${loop.subject}, paying the retry backoff once per entry; ` +
				remedy(drive.site.sleeper)
		);
	};

	/** Audits one test registration: every loop its callback, and the functions the callback calls, reach. */
	const auditRegistration = (registration: ts.CallExpression): void => {
		const [label, second] = registration.arguments;
		const callback = callbackBody(second);
		if (callback === undefined) {
			return;
		}
		const subject =
			label !== undefined && ts.isStringLiteralLike(label) ? label.text : registration.expression.getText(sf);
		for (const body of reachableBodies(callback)) {
			eachExecuted(body, true, (child) => {
				const loop = loopOf(child);
				if (loop !== undefined) {
					auditLoop(loop, registration, subject);
				}
				return true;
			});
		}
	};

	const visitTests = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && registersTest(node.expression)) {
			auditRegistration(node);
		}
		ts.forEachChild(node, visitTests);
	};
	visitTests(sf);
	return { problems, testFiles: 1, loops, drives };
}

function sum(audits: readonly Audit[]): Audit {
	return audits.reduce(
		(total, audit) => ({
			problems: [...total.problems, ...audit.problems],
			testFiles: total.testFiles + audit.testFiles,
			loops: total.loops + audit.loops,
			drives: total.drives + audit.drives,
		}),
		{ problems: [], testFiles: 0, loops: 0, drives: 0 }
	);
}

const exemplarOf = (sleepers: Map<string, Sleeper[]>): Sleeper | undefined =>
	[...sleepers.values()].flat().find((sleeper) => sleeper.sleepParameter !== undefined);

function audit(sleepers: Map<string, Sleeper[]>): Audit {
	const exemplar = exemplarOf(sleepers);
	const testFiles = testFilesUnder(BUN_TREE).sort();
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
	readonly loops: number;
	readonly drives: number;
	readonly names?: string;
}

/** Every shape the detector names, red or green, as the fixture that proves it. Line 10 is `exchange`'s default source. */
const SHAPES: Shape[] = [
	{
		shape: "for..of over the import, the sleeper built in a same-file helper",
		source: `test("sweep", async () => { for (const surface of TRANSPORT_ERROR_SURFACES) { await exchange(surface); } });`,
		problems: 1,
		loops: 1,
		drives: 1,
		names:
			'test "sweep" drives new OAuthTokenSource at line 10, through exchange() inside a loop (line 14) over TRANSPORT_ERROR_SURFACES',
	},
	{
		shape: "the same loop with a zero sleep injected",
		source: `test("sweep", async () => { for (const surface of TRANSPORT_ERROR_SURFACES) { await exchange(surface, new OAuthTokenSource(noBackoff)); } });`,
		problems: 0,
		loops: 1,
		drives: 1,
	},
	{
		shape: "a loop over a local literal pays the same cost",
		source: `test("sweep", async () => { for (const surface of ["chat", "discovery"]) { await exchange(surface); } });`,
		problems: 1,
		loops: 1,
		drives: 1,
	},
	{
		shape: "a loop over a spread copy of the list",
		source: `test("sweep", async () => { for (const surface of [...TRANSPORT_ERROR_SURFACES]) { await exchange(surface); } });`,
		problems: 1,
		loops: 1,
		drives: 1,
	},
	{
		shape: "forEach with an async callback",
		source: `test("sweep", () => { TRANSPORT_ERROR_SURFACES.forEach(async (surface) => { await exchange(surface); }); });`,
		problems: 1,
		loops: 1,
		drives: 1,
	},
	{
		shape: "a named function handed to map",
		source: `test("sweep", async () => { await Promise.all(TRANSPORT_ERROR_SURFACES.map(exchange)); });`,
		problems: 1,
		loops: 1,
		drives: 1,
	},
	{
		shape: "a classic for over the import's length",
		source: `test("sweep", async () => { for (let i = 0; i < TRANSPORT_ERROR_SURFACES.length; i += 1) { await exchange(TRANSPORT_ERROR_SURFACES[i]); } });`,
		problems: 1,
		loops: 1,
		drives: 1,
	},
	{
		shape: "the loop inside a helper the test calls",
		source: `async function sweep(surfaces: readonly string[]) { for (const surface of surfaces) { await exchange(surface); } }
test("sweep", async () => { await sweep(TRANSPORT_ERROR_SURFACES); });`,
		problems: 1,
		loops: 1,
		drives: 1,
	},
	{
		shape: "an explicit undefined that lets the helper's default sleeper run",
		source: `test("sweep", async () => { for (const surface of TRANSPORT_ERROR_SURFACES) { await exchange(surface, undefined); } });`,
		problems: 1,
		loops: 1,
		drives: 1,
	},
	{
		shape: "an instance built outside the test and driven inside the loop",
		source: `const source = new OAuthTokenSource();
test("sweep", async () => { for (const surface of TRANSPORT_ERROR_SURFACES) { await source.getToken(CONFIG, surface, BUDGET); } });`,
		problems: 1,
		loops: 1,
		drives: 1,
		names: 'drives new OAuthTokenSource at line 14, held by "source"',
	},
	{
		shape: "a named function registered as the callback",
		source: `async function sweep() { for (const surface of TRANSPORT_ERROR_SURFACES) { await exchange(surface); } }
test("sweep", sweep);`,
		problems: 1,
		loops: 1,
		drives: 1,
	},
	{
		shape: "the real sleep handed back in through a namespace import",
		source: `test("sweep", async () => { for (const surface of TRANSPORT_ERROR_SURFACES) { await exchange(surface, new OAuthTokenSource(timers.sleepUnlessAborted)); } });`,
		problems: 1,
		loops: 1,
		drives: 1,
	},
	{
		shape: "the real sleep handed back in through a local",
		source: `const sleep = timers.sleepUnlessAborted;
test("sweep", async () => { for (const surface of TRANSPORT_ERROR_SURFACES) { await exchange(surface, new OAuthTokenSource(sleep)); } });`,
		problems: 1,
		loops: 1,
		drives: 1,
	},
	{
		shape: "a sleeper with no sleep parameter",
		source: `test("sweep", async () => { for (const surface of TRANSPORT_ERROR_SURFACES) { await retryIdempotent(() => Promise.reject(new Error(surface)), { maxRetries: 2, signal: new AbortController().signal }); } });`,
		problems: 1,
		loops: 1,
		drives: 1,
		names:
			"retryIdempotent (src/provider/transport/retry.ts) takes no sleep: give it a sleep parameter defaulting to sleepUnlessAborted, as OAuthTokenSource (src/provider/transport/auth.ts) has, and pass a zero sleep here",
	},
	{
		shape: "the same local name in two tests resolves to its own declaration",
		source: `test("first", async () => { const source = new OAuthTokenSource(); for (const surface of TRANSPORT_ERROR_SURFACES) { await source.getToken(CONFIG, surface, BUDGET); } });
test("second", async () => { const source = new OAuthTokenSource(noBackoff); for (const surface of TRANSPORT_ERROR_SURFACES) { await source.getToken(CONFIG, surface, BUDGET); } });`,
		problems: 1,
		loops: 2,
		drives: 2,
		names: 'test "first"',
	},
	{
		shape: "an immediately invoked function inside the loop body",
		source: `test("sweep", async () => { for (const surface of TRANSPORT_ERROR_SURFACES) { await (async () => { await exchange(surface); })(); } });`,
		problems: 1,
		loops: 1,
		drives: 1,
	},
	{
		shape: "a helper's alias called in the loop",
		source: `const run = exchange;
test("sweep", async () => { for (const surface of TRANSPORT_ERROR_SURFACES) { await run(surface); } });`,
		problems: 1,
		loops: 1,
		drives: 1,
	},
	{
		shape: "a helper's alias called with a zero sleep",
		source: `const run = exchange;
test("sweep", async () => { for (const surface of TRANSPORT_ERROR_SURFACES) { await run(surface, new OAuthTokenSource(noBackoff)); } });`,
		problems: 0,
		loops: 1,
		drives: 1,
	},
	{
		shape: "a helper only mentioned, never called",
		source: `test("sweep", () => { const jobs = TRANSPORT_ERROR_SURFACES.map(() => exchange); if (jobs.length === 0) { throw new Error("empty"); } });`,
		problems: 0,
		loops: 1,
		drives: 0,
	},
	{
		shape: "a helper's alias only mentioned, never called",
		source: `const run = exchange;
test("sweep", () => { const jobs = TRANSPORT_ERROR_SURFACES.map(() => run); if (jobs.length === 0) { throw new Error("empty"); } });`,
		problems: 0,
		loops: 1,
		drives: 0,
	},
	{
		shape: "thunks built per entry for later",
		source: `test("sweep", () => { const jobs = TRANSPORT_ERROR_SURFACES.map((surface) => () => exchange(surface)); if (jobs.length === 0) { throw new Error("empty"); } });`,
		problems: 0,
		loops: 1,
		drives: 0,
	},
	{
		shape: "a looping helper built but never called",
		source: `async function sweep() { for (const surface of TRANSPORT_ERROR_SURFACES) { await exchange(surface); } }
test("factory", () => { const job = () => sweep(); if (typeof job !== "function") { throw new Error("bad job"); } });`,
		problems: 0,
		loops: 0,
		drives: 0,
	},
	{
		shape: "a sleeper named only in a type position",
		source: `const source = new OAuthTokenSource();
test("sweep", () => { for (const surface of TRANSPORT_ERROR_SURFACES) { type Source = typeof source; const label: Source | string = surface; if (label === "") { throw new Error("empty"); } } });`,
		problems: 0,
		loops: 1,
		drives: 0,
	},
];

/** The production sleepers every shape fixture is judged against. */
const sleepers = productionSleepers();

test.each(SHAPES)("the detector reads the shape: $shape", ({ source, problems, loops, drives, names }) => {
	const result = analyzeTest(fixture(`${FIXTURE_HEADER}\n${source}\n`), sleepers, exemplarOf(sleepers));
	expect({ problems: result.problems.length, loops: result.loops, drives: result.drives }).toEqual({
		problems,
		loops,
		drives,
	});
	if (names !== undefined) {
		expect(result.problems[0]).toContain(names);
	}
});

test("every bun test that drives a backoff sleeper once per loop entry injects a zero sleep", () => {
	expect([...sleepers.values()].flat().length).toBeGreaterThan(0);
	const result = audit(sleepers);
	expect(result.problems).toEqual([]);
	expect(result.testFiles).toBeGreaterThan(0);
});
