/**
 * Every bun-tree test or lifecycle hook whose body reaches a child-process spawn, through any chain of same-file
 * helpers and relative imports, must carry a load-proof deadline (CHILD_PROCESS_TIMEOUT_MS, or a literal at least that
 * large), and every one that carries the constant must reach a spawn. A spawn is expensive for environmental reasons
 * the assertion cannot see (see childProcessTimeout.ts), so a new spawning test flakes under load instead of failing
 * here unless something reads the code, and this reads the code: the TypeScript parser, not a regex, over the runtime
 * import closure of the tree (relative value imports anywhere in the repository; a type-only import loads nothing).
 * Scope: this catches an author who forgets the deadline or reaches a spawn through a helper they did not think of,
 * and it fails on anything the walk cannot read; an author who deliberately hides a spawn from the walk is out of
 * scope.
 * Spawns are node:child_process, the Bun surface's process-starting members (spawn, spawnSync, $, openInEditor,
 * WebView), XMLHttpRequest (happy-dom's synchronous form runs in a node child), and `new Worker` from a literal
 * relative path (a second runtime; its module is followed too). Every other external module is either in
 * KNOWN_SAFE_MODULES, with the reason it starts no process, or a failure, because the walk cannot see into a package.
 * Reach is over-approximated: any
 * identifier a body mentions that names a spawning declaration counts, so a false positive is loud and names its site.
 * Every gap in the analysis is a failure rather than a pass: a parse error, an import or export the walk cannot follow,
 * a dynamic import or require without a literal specifier, code the parser never sees (eval, the Function constructor,
 * node:vm, the by-name loaders on process, createRequire, a Worker from anything but a literal relative path or with
 * eval, a computed member of Bun, process, globalThis, require, or Reflect), `Bun` or `require` stored anywhere instead
 * of read as a member base or called, a test callback it cannot see into, any export of the test runner itself,
 * load-time code in any module reaching a spawn, an exception entry matching anything but exactly one registration,
 * a known-safe entry nothing imports or without a reason, a detector that found no spawn anywhere, and a top-level
 * declaration the parser lists that the walk never registered (the control that turns a silently skipped registration
 * step into one loud line instead of hundreds of downstream misses).
 */
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { CHILD_PROCESS_TIMEOUT_MS } from "./childProcessTimeout";

const BUN_TREE = path.resolve(import.meta.dir);
const REPO_ROOT = path.resolve(BUN_TREE, "../../..");
/** The file names `bun test` runs, per its discovery rules. */
const TEST_FILE = /[._](?:test|spec)\.[cm]?[jt]sx?$/;
const DEADLINE_MODULE = path.join(BUN_TREE, "childProcessTimeout.ts");
const DEADLINE_PATH = path.relative(REPO_ROOT, DEADLINE_MODULE).split(path.sep).join("/");
const DEADLINE_NAME = "CHILD_PROCESS_TIMEOUT_MS";

/**
 * Registrations that reach a spawn and may run without any deadline argument, each with the reason (a wrong deadline
 * is never excused). An entry must match exactly one registration: none means a fixed member left its exception
 * behind, two means a new member is hiding under an old one.
 */
const EXCEPTIONS: readonly { readonly file: string; readonly subject: string; readonly reason: string }[] = [];

const PARSED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx"]);
/** Relative imports that load data, not code; anything else the parser does not read (a .node addon) fails. */
const INERT_ASSET_EXTENSIONS = new Set([".json", ".css"]);
/**
 * Modules whose JSX the transpiler compiles against an injected import; those imports are classified like written
 * ones.
 */
const JSX_EXTENSIONS = new Set([".tsx", ".jsx"]);
const CHILD_PROCESS_SPECIFIER = /^(?:node:)?child_process$/;
/** Member names that spawn wherever they appear: Bun.spawn and node:child_process share this vocabulary. */
const SPAWN_MEMBERS = new Set(["spawn", "spawnSync", "execSync", "execFile", "execFileSync", "fork"]);
/** `exec` only counts in a module that names child_process, since RegExp.prototype.exec is everywhere. */
const CHILD_PROCESS_ONLY_MEMBERS = new Set(["exec"]);
/** The Bun surface's process-starting members, as `Bun.<name>` and as named exports of "bun". */
const BUN_SPAWN_EXPORTS = new Set(["spawn", "spawnSync", "$", "openInEditor", "WebView"]);
/**
 * Globals a known-safe module installs whose implementation spawns: happy-dom's synchronous XMLHttpRequest runs the
 * request in a node child, and the asynchronous form shares the constructor, so any use counts.
 */
const SPAWNING_GLOBALS = new Set(["XMLHttpRequest"]);
/** The only members of `require` the walk follows; `require.call` or `.main.require` would hide a load. */
const REQUIRE_MEMBERS = new Set(["cache", "resolve"]);
const TEST_NAMES = new Set(["test", "it", "xtest", "xit"]);
const HOOK_NAMES = new Set(["beforeAll", "beforeEach", "afterAll", "afterEach", "onTestFinished"]);

/** Whether importing `name` from a non-relative `specifier` hands the importer a spawn. */
const spawnsFromExternal = (specifier: string, name: string): boolean =>
	CHILD_PROCESS_SPECIFIER.test(specifier) || (specifier === "bun" && (name === "*" || BUN_SPAWN_EXPORTS.has(name)));

/**
 * External modules the bun tree loads at runtime that start no process, by exact specifier (a subpath is its own
 * entry: typescript/lib/tsserver spawns while typescript does not), each with the reason. The walk cannot see into a
 * package, so an import from a specifier missing here is unclassified and fails until it is added here or recognized
 * as a spawner; an entry nothing imports any more, or one without a reason, fails.
 */
const KNOWN_SAFE_MODULES: ReadonlyMap<string, string> = new Map([
	["@happy-dom/global-registrator", "installs the DOM shim in-process"],
	["@radix-ui/react-dialog", "React components"],
	["@vscode/l10n", "string-table lookup"],
	["bun:test", "the test runner itself"],
	["class-variance-authority", "class-name composition"],
	["clsx", "class-name composition"],
	["fast-check", "in-process property generators"],
	["gpt-tokenizer/encoding/cl100k_base", "in-process tokenizer tables"],
	["gpt-tokenizer/encoding/o200k_base", "in-process tokenizer tables"],
	["node:assert", "assertions"],
	["node:crypto", "hashing"],
	["node:fs", "file system calls"],
	["node:os", "reads host facts"],
	["node:path", "string arithmetic"],
	["react", "component runtime"],
	["react-dom/client", "component runtime"],
	["react/jsx-dev-runtime", "the JSX transform's injected runtime, development form"],
	["react/jsx-runtime", "the JSX transform's injected runtime"],
	["tailwind-merge", "class-name composition"],
	["typescript", "in-process compiler API"],
	["zod", "schema validation"],
]);
/** Modules, globals, and members that run source the parser never sees or load modules past the classifier. */
const DYNAMIC_CODE_MODULES = new Set(["node:vm", "vm"]);
const DYNAMIC_CODE_IDENTIFIERS = new Set(["eval", "Function", "getBuiltinModule", "createRequire", "dlopen"]);
const PROCESS_LOADER_MEMBERS = new Set(["binding", "_linkedBinding", "dlopen", "getBuiltinModule"]);
/**
 * A computed member of one of these reaches a slot by a name the walk cannot read, whether written as `base[key]` or
 * destructured out with `const { [key]: x } = base`.
 */
const COMPUTED_MEMBER_BANNED_BASES = new Set(["Bun", "process", "globalThis", "require", "Reflect"]);

type ExternalKind = "spawner" | "safe" | "dynamic-code" | "unclassified";

/** What loading `name` from a non-relative `specifier` means to the walk; "bun" itself is the Bun global's surface. */
function classifyExternal(specifier: string, name: string): ExternalKind {
	if (spawnsFromExternal(specifier, name)) {
		return "spawner";
	}
	if (DYNAMIC_CODE_MODULES.has(specifier)) {
		return "dynamic-code";
	}
	if (specifier === "bun" || KNOWN_SAFE_MODULES.has(specifier)) {
		return "safe";
	}
	return "unclassified";
}

/**
 * An import or export whose every binding is a type loads nothing at runtime: the transpiler erases it whole, so it is
 * not an edge, and an unlisted package behind one is not a load to classify. `import defer` still loads.
 */
const isTypeOnlyImport = (clause: ts.ImportClause | undefined): boolean =>
	clause !== undefined &&
	(clause.phaseModifier === ts.SyntaxKind.TypeKeyword ||
		(clause.name === undefined &&
			clause.namedBindings !== undefined &&
			ts.isNamedImports(clause.namedBindings) &&
			clause.namedBindings.elements.length > 0 &&
			clause.namedBindings.elements.every((element) => element.isTypeOnly)));
const isTypeOnlyExport = (node: ts.ExportDeclaration): boolean =>
	node.isTypeOnly ||
	(node.exportClause !== undefined &&
		ts.isNamedExports(node.exportClause) &&
		node.exportClause.elements.length > 0 &&
		node.exportClause.elements.every((element) => element.isTypeOnly));

type Binding =
	| { readonly kind: "internal"; readonly target: string; readonly name: string }
	| { readonly kind: "external"; readonly specifier: string; readonly name: string };

interface Scope {
	/** Runs when the module loads (top-level code, a variable initializer) rather than when something calls it. */
	readonly eager: boolean;
	readonly refs: Set<string>;
	/** Modules a dynamic import, require, or Worker inside this scope loads: every declaration of each counts. */
	readonly moduleRefs: string[];
	readonly sites: string[];
}

const newScope = (eager = false): Scope => ({ eager, refs: new Set(), moduleRefs: [], sites: [] });

interface Registration extends Scope {
	readonly kind: "test" | "hook";
	readonly subject: string;
	readonly line: number;
	readonly deadline: ts.Expression | undefined;
}

interface Module {
	readonly file: string;
	readonly rel: string;
	readonly imports: Map<string, Binding>;
	readonly exports: Map<string, Binding | { readonly kind: "local"; readonly name: string }>;
	readonly exportStars: string[];
	readonly decls: Map<string, Scope[]>;
	readonly registrations: Registration[];
	/** Top-level code: every identifier and site outside any declaration or registration, which runs at load. */
	readonly moduleScope: Scope;
}

interface Context {
	readonly problems: string[];
	readonly usedSafe: Set<string>;
	readonly jsxRuntimes: readonly string[];
}

const rel = (file: string): string => path.relative(BUN_TREE, file).split(path.sep).join("/");

/** An expression with its casts and parentheses removed, so `(Bun as typeof Bun).spawn` reads as written. */
function unwrapped(expression: ts.Expression): ts.Expression {
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

/** The identifier an expression is, casts aside. */
const baseName = (expression: ts.Expression): string | undefined => {
	const inner = unwrapped(expression);
	return ts.isIdentifier(inner) ? inner.text : undefined;
};

/** `expression` is `process`, or a member chain ending in `.process` (globalThis.process), casts aside. */
const namesProcess = (expression: ts.Expression): boolean => {
	const inner = unwrapped(expression);
	return baseName(inner) === "process" || (ts.isPropertyAccessExpression(inner) && inner.name.text === "process");
};

/** The modules the JSX transform injects into every .tsx/.jsx module, from bunfig's pinned jsxImportSource. */
function jsxRuntimeModules(problems: string[]): string[] {
	const bunfig = readFileSync(path.join(REPO_ROOT, "bunfig.toml"), "utf8");
	const source = /^jsxImportSource\s*=\s*["']([^"']+)["']/m.exec(bunfig)?.[1];
	if (source === undefined) {
		problems.push("bunfig.toml declares no jsxImportSource the walk can read");
		return [];
	}
	return [`${source}/jsx-runtime`, `${source}/jsx-dev-runtime`];
}

/** Every file bun test loads: the test files under the tree plus bunfig's preload list, which runs before them. */
function listRoots(problems: string[]): string[] {
	const roots: string[] = [];
	for (const entry of readdirSync(BUN_TREE, { recursive: true, withFileTypes: true })) {
		if (entry.isFile() && TEST_FILE.test(entry.name)) {
			roots.push(path.join(entry.parentPath, entry.name));
		}
	}
	const bunfig = readFileSync(path.join(REPO_ROOT, "bunfig.toml"), "utf8");
	const preload = /^preload\s*=\s*\[([^\]]*)\]/m.exec(bunfig);
	if (preload === null) {
		problems.push("bunfig.toml declares no preload list the walk can read");
	} else {
		for (const [, quoted] of preload[1]?.matchAll(/["']([^"']+)["']/g) ?? []) {
			if (quoted !== undefined) {
				roots.push(path.resolve(REPO_ROOT, quoted));
			}
		}
	}
	return [...new Set(roots)].sort();
}

/**
 * A relative specifier's file, or `undefined` for an inert asset; an unresolvable or unreadable target is a problem.
 */
function resolveRelative(from: string, specifier: string, problems: string[]): string | undefined {
	const base = path.resolve(path.dirname(from), specifier);
	const candidates = [
		base,
		...[".ts", ".tsx", ".mts", ".cts", ".js", ".mjs"].map((ext) => base + ext),
		base.replace(/\.js$/, ".ts"),
		path.join(base, "index.ts"),
		path.join(base, "index.tsx"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate) && statSync(candidate).isFile()) {
			const extension = path.extname(candidate);
			if (PARSED_EXTENSIONS.has(extension)) {
				return candidate;
			}
			if (!INERT_ASSET_EXTENSIONS.has(extension)) {
				problems.push(
					`${rel(from)}: cannot classify import "${specifier}"; only ${[...INERT_ASSET_EXTENSIONS].join(", ")} assets are inert`
				);
			}
			return undefined;
		}
	}
	if (existsSync(`${base}.d.ts`)) {
		return undefined;
	}
	problems.push(`${rel(from)}: cannot resolve import "${specifier}"`);
	return undefined;
}

/** Whether a call is `import(...)` or a direct `require(...)`. */
const isDynamicLoad = (node: ts.CallExpression): boolean =>
	node.expression.kind === ts.SyntaxKind.ImportKeyword || baseName(node.expression) === "require";

/** The relative modules a file loads at runtime; a type-only import or export loads nothing, so it is not one. */
function loadedTargets(sf: ts.SourceFile, problems: string[]): string[] {
	const file = path.resolve(sf.fileName);
	const targets: string[] = [];
	const follow = (specifier: string): void => {
		if (specifier.startsWith(".")) {
			const target = resolveRelative(file, specifier, problems);
			if (target !== undefined) {
				targets.push(target);
			}
		}
	};
	const scan = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
			if (!isTypeOnlyImport(node.importClause)) {
				follow(node.moduleSpecifier.text);
			}
			return;
		}
		if (
			ts.isExportDeclaration(node) &&
			node.moduleSpecifier !== undefined &&
			ts.isStringLiteralLike(node.moduleSpecifier)
		) {
			if (!isTypeOnlyExport(node)) {
				follow(node.moduleSpecifier.text);
			}
			return;
		}
		if (
			(ts.isCallExpression(node) && isDynamicLoad(node)) ||
			(ts.isNewExpression(node) && baseName(node.expression) === "Worker")
		) {
			const [first] = node.arguments ?? [];
			if (first !== undefined && ts.isStringLiteralLike(first)) {
				follow(first.text);
			}
		}
		ts.forEachChild(node, scan);
	};
	scan(sf);
	return targets;
}

/** The runtime import closure of the roots over relative specifiers. */
function discoverModules(roots: readonly string[], problems: string[]): string[] {
	const seen = new Set<string>(roots);
	const queue = [...roots];
	for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
		const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false);
		for (const target of loadedTargets(sf, problems)) {
			if (!seen.has(target)) {
				seen.add(target);
				queue.push(target);
			}
		}
	}
	return [...seen].sort();
}

const isFunctionLike = (node: ts.Node): boolean => ts.isArrowFunction(node) || ts.isFunctionExpression(node);

/** A variable whose value is a function body runs nothing until called; any other initializer runs at load. */
const isDeferred = (initializer: ts.Expression | undefined): boolean =>
	initializer !== undefined && isFunctionLike(initializer);

/**
 * The parts of a class that run when its definition is evaluated, not when an instance is made or a method called: a
 * static method's body is deferred like any other, so only a static property's initializer counts.
 */
const runsAtDefinition = (member: ts.Node): boolean =>
	ts.isHeritageClause(member) ||
	ts.isDecorator(member) ||
	ts.isClassStaticBlockDeclaration(member) ||
	(ts.canHaveDecorators(member) && (ts.getDecorators(member)?.length ?? 0) > 0) ||
	(ts.isPropertyDeclaration(member) &&
		(ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ?? false)) ||
	(ts.isClassElement(member) && member.name !== undefined && ts.isComputedPropertyName(member.name));

function bindingNames(name: ts.BindingName): string[] {
	if (ts.isIdentifier(name)) {
		return [name.text];
	}
	return name.elements.flatMap((element) => (ts.isBindingElement(element) ? bindingNames(element.name) : []));
}

/** An object literal made only of identifier-keyed assignments: the one shape whose keys the walk can read. */
function plainKeys(literal: ts.ObjectLiteralExpression): Set<string> | undefined {
	const keys = new Set<string>();
	for (const property of literal.properties) {
		if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) {
			return undefined;
		}
		keys.add(property.name.text);
	}
	return keys;
}

/**
 * The identifier a callee chain hangs off and the member read directly off it: `test.each(rows)` and `it.skipIf(flag)`
 * both root at their first name, and `bt.test(...)` off a namespace import roots at `bt` with member `test`.
 */
function calleeRoot(
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

function analyzeModule(sf: ts.SourceFile, context: Context): Module {
	const { problems, usedSafe, jsxRuntimes } = context;
	const file = path.resolve(sf.fileName);
	const module: Module = {
		file,
		rel: rel(file),
		imports: new Map(),
		exports: new Map(),
		exportStars: [],
		decls: new Map(),
		registrations: [],
		moduleScope: newScope(true),
	};
	const lineOf = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
	const fail = (node: ts.Node, message: string): void => {
		problems.push(`${module.rel}:${lineOf(node)}: ${message}`);
	};
	const cannotRead = (node: ts.Node, what: string): void => {
		fail(node, `${what} runs or loads code the walk cannot read`);
	};
	/**
	 * Whether the walk may load `specifier`: a spawner or a listed module yes, dynamic code or an unlisted package no.
	 */
	const admit = (node: ts.Node, specifier: string, name = "*"): boolean => {
		if (specifier.startsWith(".")) {
			return true;
		}
		const kind = classifyExternal(specifier, name);
		if (kind === "dynamic-code") {
			cannotRead(node, `"${specifier}"`);
			return false;
		}
		if (kind === "unclassified") {
			fail(
				node,
				`"${specifier}" is neither a known spawner nor in KNOWN_SAFE_MODULES; classify it there with the reason it starts no process`
			);
			return false;
		}
		if (kind === "safe") {
			usedSafe.add(specifier);
		}
		return true;
	};
	const bindingFor = (specifier: string, name: string): Binding | undefined => {
		if (!specifier.startsWith(".")) {
			return { kind: "external", specifier, name };
		}
		const target = resolveRelative(file, specifier, problems);
		return target === undefined ? undefined : { kind: "internal", target, name };
	};

	// Pass one: the names that count as spawn sites or registrations in this module, which the scoped walk needs up
	// front.
	const spawnLocals = new Set([...SPAWN_MEMBERS, ...SPAWNING_GLOBALS]);
	const testLocals = new Set(TEST_NAMES);
	const hookLocals = new Set(HOOK_NAMES);
	const testNamespaces = new Set<string>();
	const spawnImports: { readonly local: string; readonly description: string }[] = [];
	let namesChildProcess = false;
	const scanLiterals = (node: ts.Node): void => {
		if (ts.isStringLiteralLike(node) && CHILD_PROCESS_SPECIFIER.test(node.text)) {
			namesChildProcess = true;
		}
		ts.forEachChild(node, scanLiterals);
	};
	scanLiterals(sf);
	if (namesChildProcess) {
		for (const name of CHILD_PROCESS_ONLY_MEMBERS) {
			spawnLocals.add(name);
		}
	}
	for (const statement of sf.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) {
			continue;
		}
		const specifier = statement.moduleSpecifier.text;
		const clause = statement.importClause;
		if (isTypeOnlyImport(clause) || !admit(statement, specifier) || clause === undefined) {
			continue;
		}
		const fromBunTest = specifier === "bun:test";
		const register = (local: ts.Identifier, imported: string): void => {
			const binding = bindingFor(specifier, imported);
			if (binding !== undefined) {
				module.imports.set(local.text, binding);
			}
			if (spawnsFromExternal(specifier, imported)) {
				spawnLocals.add(local.text);
				spawnImports.push({
					local: local.text,
					description: `${imported} imported from "${specifier}" at ${module.rel}:${lineOf(local)}`,
				});
			}
			if (fromBunTest && TEST_NAMES.has(imported)) {
				testLocals.add(local.text);
			}
			if (fromBunTest && HOOK_NAMES.has(imported)) {
				hookLocals.add(local.text);
			}
			if (fromBunTest && imported === "*") {
				testNamespaces.add(local.text);
			}
		};
		if (clause.name !== undefined) {
			register(clause.name, "default");
		}
		const bindings = clause.namedBindings;
		if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
			register(bindings.name, "*");
		} else if (bindings !== undefined) {
			for (const element of bindings.elements) {
				if (!element.isTypeOnly) {
					register(element.name, (element.propertyName ?? element.name).text);
				}
			}
		}
	}
	if (JSX_EXTENSIONS.has(path.extname(file))) {
		for (const runtime of jsxRuntimes) {
			admit(sf, runtime);
		}
	}

	/** Whether a callee registers a test or a hook, by its root name or by the member read off a bun:test namespace. */
	const registrationKind = (callee: ts.Expression): "test" | "hook" | undefined => {
		const found = calleeRoot(callee);
		if (found === undefined) {
			return undefined;
		}
		const name = testNamespaces.has(found.root.text) ? found.member : found.root.text;
		if (name === undefined) {
			return undefined;
		}
		if (testLocals.has(name) || (testNamespaces.has(found.root.text) && TEST_NAMES.has(name))) {
			return "test";
		}
		if (hookLocals.has(name) || (testNamespaces.has(found.root.text) && HOOK_NAMES.has(name))) {
			return "hook";
		}
		return undefined;
	};
	// A stored alias of a registration function (`const t = test`, `const each = test.each(rows)`) registers under its
	// own name; found to a fixpoint so an alias of an alias counts too.
	for (let grew = true; grew; ) {
		grew = false;
		const scanAliases = (node: ts.Node): void => {
			if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
				const found = calleeRoot(node.initializer);
				const fromRunner =
					found !== undefined &&
					(testNamespaces.has(found.root.text) || testLocals.has(found.root.text) || hookLocals.has(found.root.text));
				if (!ts.isIdentifier(node.name)) {
					if (fromRunner) {
						fail(node, "destructuring the test runner is not followed");
					}
				} else {
					const kind = registrationKind(node.initializer);
					const bucket = kind === "test" ? testLocals : kind === "hook" ? hookLocals : undefined;
					if (bucket !== undefined && !bucket.has(node.name.text)) {
						bucket.add(node.name.text);
						grew = true;
					} else if (fromRunner && kind === undefined && !testNamespaces.has(node.name.text)) {
						testNamespaces.add(node.name.text);
						grew = true;
					}
				}
			}
			ts.forEachChild(node, scanAliases);
		};
		scanAliases(sf);
	}

	// Pass two: declarations, exports, registrations, and every identifier and spawn site under its enclosing scopes.
	const identifierCallbacks: { readonly node: ts.Node; readonly name: string }[] = [];
	const addDecl = (name: string, scope: Scope): void => {
		const existing = module.decls.get(name);
		if (existing === undefined) {
			module.decls.set(name, [scope]);
		} else {
			existing.push(scope);
		}
	};
	// A barrel around the test runner would register tests under a name this walk does not know.
	const runnerBindings = new Set([...testLocals, ...hookLocals, ...testNamespaces]);
	const exportLocal = (node: ts.Node, name: string, exportedAs: string = name): void => {
		if (runnerBindings.has(name)) {
			fail(node, `exporting "${name}" of bun:test is not followed`);
			return;
		}
		module.exports.set(exportedAs, { kind: "local", name });
	};
	// An imported spawn is a spawning declaration under its local name, so `export { run }` of an aliased import and
	// every other path that resolves the name lands on a site.
	for (const { local, description } of spawnImports) {
		const scope = newScope();
		scope.sites.push(description);
		addDecl(local, scope);
	}
	const hasModifier = (node: ts.HasModifiers, kind: ts.SyntaxKind): boolean =>
		ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false;
	const enclosing = (scopes: readonly Scope[]): readonly Scope[] =>
		scopes.length === 0 ? [module.moduleScope] : scopes;
	const site = (scopes: readonly Scope[], description: string): void => {
		for (const scope of enclosing(scopes)) {
			scope.sites.push(description);
		}
	};
	const load = (scopes: readonly Scope[], target: string): void => {
		for (const scope of enclosing(scopes)) {
			scope.moduleRefs.push(target);
		}
	};
	// Only a declaration outside every other declaration and registration gets a name of its own: a nested one flows
	// its references and sites into the scope enclosing it, so a local in one function cannot alias a local in another.
	// A declaration's own name defines, it does not use.
	// Not named `declare`: bun 1.3.x's transpiler reads a statement that begins with that contextual keyword as an
	// ambient declaration and drops the whole call, which silently emptied every module's declaration table on CI; the
	// top-level declaration control in audit() catches a recurrence of that whole class of loss.
	const registerDeclaration = (node: ts.HasModifiers & { readonly name?: ts.Node }, scopes: readonly Scope[]): void => {
		const body = (child: ts.Node, inner: readonly Scope[]): void => {
			if (child !== node.name) {
				visit(child, inner);
			}
		};
		if (scopes.length > 0) {
			ts.forEachChild(node, (child) => body(child, scopes));
			return;
		}
		const scope = newScope(ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node));
		const name = node.name !== undefined && ts.isIdentifier(node.name) ? node.name.text : "default";
		addDecl(name, scope);
		if (hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
			exportLocal(node, name, hasModifier(node, ts.SyntaxKind.DefaultKeyword) ? "default" : name);
		}
		if (ts.isClassDeclaration(node)) {
			const atDefinition = newScope(true);
			addDecl(name, atDefinition);
			ts.forEachChild(node, (child) => body(child, [...scopes, runsAtDefinition(child) ? atDefinition : scope]));
			return;
		}
		ts.forEachChild(node, (child) => body(child, [...scopes, scope]));
	};
	const visit = (node: ts.Node, scopes: readonly Scope[]): void => {
		// Types run nothing; the one type-node kind with a runtime expression inside is a heritage clause's target.
		if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) {
			return;
		}
		if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) {
			if (ts.isImportEqualsDeclaration(node)) {
				fail(node, "import-equals declarations are not followed");
			}
			return;
		}
		if (ts.isExportDeclaration(node)) {
			if (isTypeOnlyExport(node)) {
				return;
			}
			const specifier =
				node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)
					? node.moduleSpecifier.text
					: undefined;
			const clause = node.exportClause;
			if (clause === undefined) {
				if (specifier === undefined) {
					fail(node, "export declaration without clause or specifier");
				} else if (!specifier.startsWith(".")) {
					fail(node, `export * from a non-relative module "${specifier}" cannot be followed`);
				} else {
					const target = resolveRelative(file, specifier, problems);
					if (target !== undefined) {
						module.exportStars.push(target);
					}
				}
				return;
			}
			const reexport = (exportedAs: string, imported: string): void => {
				if (specifier === "bun:test") {
					fail(node, `re-exporting "${imported}" of bun:test is not followed`);
					return;
				}
				if (specifier === undefined) {
					exportLocal(node, imported, exportedAs);
					return;
				}
				if (!admit(node, specifier, imported)) {
					return;
				}
				if (spawnsFromExternal(specifier, imported)) {
					const scope = newScope();
					scope.sites.push(`${imported} re-exported from "${specifier}" at ${module.rel}:${lineOf(node)}`);
					addDecl(exportedAs, scope);
					exportLocal(node, exportedAs);
					return;
				}
				const binding = bindingFor(specifier, imported);
				if (binding !== undefined) {
					module.exports.set(exportedAs, binding);
				}
			};
			if (ts.isNamespaceExport(clause)) {
				if (specifier === undefined) {
					fail(node, "namespace export without a specifier");
				} else {
					reexport(clause.name.text, "*");
				}
				return;
			}
			for (const element of clause.elements) {
				if (!element.isTypeOnly) {
					reexport(element.name.text, (element.propertyName ?? element.name).text);
				}
			}
			return;
		}
		if (ts.isExportAssignment(node)) {
			if (scopes.length > 0) {
				fail(node, "export assignment inside a declaration");
				return;
			}
			const scope = newScope(true);
			addDecl("default", scope);
			exportLocal(node, "default");
			visit(node.expression, [...scopes, scope]);
			for (const name of scope.refs) {
				if (runnerBindings.has(name)) {
					fail(node, `default export mentions "${name}" of bun:test, which is not followed`);
				}
			}
			return;
		}
		if (
			ts.isFunctionDeclaration(node) ||
			ts.isClassDeclaration(node) ||
			ts.isInterfaceDeclaration(node) ||
			ts.isTypeAliasDeclaration(node) ||
			ts.isEnumDeclaration(node) ||
			ts.isModuleDeclaration(node)
		) {
			registerDeclaration(node, scopes);
			return;
		}
		// Destructuring reads members like a member access does: a loader member, a computed key, or a rest element pulled
		// out of a guarded base fails the same way, and a banned base pulled out of globalThis is that base stored under
		// another name. (`require` never reaches here: as an initializer it is already a stored `require`.)
		const pattern:
			| { readonly source: ts.Expression; readonly keys: readonly (readonly [ts.Node, string | undefined])[] }
			| undefined =
			ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer !== undefined
				? {
						source: node.initializer,
						keys: node.name.elements.map((element) => {
							const key = element.propertyName ?? element.name;
							return [
								element,
								element.dotDotDotToken === undefined && ts.isIdentifier(key) ? key.text : undefined,
							] as const;
						}),
					}
				: ts.isBinaryExpression(node) &&
						node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
						ts.isObjectLiteralExpression(node.left)
					? {
							source: node.right,
							keys: node.left.properties.map((property) => {
								const key =
									ts.isShorthandPropertyAssignment(property) || ts.isPropertyAssignment(property)
										? property.name
										: undefined;
								return [property, key !== undefined && ts.isIdentifier(key) ? key.text : undefined] as const;
							}),
						}
					: undefined;
		if (pattern !== undefined) {
			const base = baseName(pattern.source);
			const guarded = base !== undefined && COMPUTED_MEMBER_BANNED_BASES.has(base);
			const fromProcess = namesProcess(pattern.source);
			for (const [element, key] of pattern.keys) {
				if (!guarded && !fromProcess) {
					break;
				}
				if (key === undefined) {
					cannotRead(element, `a computed member of ${base ?? "process"}`);
				} else if (fromProcess && PROCESS_LOADER_MEMBERS.has(key)) {
					cannotRead(element, `process.${key}`);
				} else if (base === "globalThis" && COMPUTED_MEMBER_BANNED_BASES.has(key)) {
					cannotRead(element, `${key} used other than as a member base or direct call`);
				}
			}
		}
		if ((ts.isVariableStatement(node) || ts.isVariableDeclaration(node)) && scopes.length > 0) {
			ts.forEachChild(node, (child) => visit(child, scopes));
			return;
		}
		if (ts.isVariableStatement(node)) {
			const exported = hasModifier(node, ts.SyntaxKind.ExportKeyword);
			for (const declaration of node.declarationList.declarations) {
				const scope = newScope(!isDeferred(declaration.initializer));
				for (const name of bindingNames(declaration.name)) {
					addDecl(name, scope);
					if (exported) {
						exportLocal(node, name);
					}
				}
				ts.forEachChild(declaration, (child) => visit(child, [...scopes, scope]));
			}
			return;
		}
		if (ts.isVariableDeclaration(node)) {
			const scope = newScope(!isDeferred(node.initializer));
			for (const name of bindingNames(node.name)) {
				addDecl(name, scope);
			}
			ts.forEachChild(node, (child) => visit(child, [...scopes, scope]));
			return;
		}
		if (ts.isNewExpression(node) && baseName(node.expression) === "Worker") {
			const [script, options] = node.arguments ?? [];
			if (script === undefined || !ts.isStringLiteralLike(script) || !script.text.startsWith(".")) {
				cannotRead(node, "a Worker from anything but a literal relative module path");
			} else {
				// A worker boots a second runtime, which pays the same startup cost as a child, and its module may spawn.
				site(scopes, `new Worker("${script.text}") at ${module.rel}:${lineOf(node)}`);
				const target = resolveRelative(file, script.text, problems);
				if (target !== undefined) {
					load(scopes, target);
				}
			}
			if (options !== undefined) {
				const keys = ts.isObjectLiteralExpression(options) ? plainKeys(options) : undefined;
				if (keys === undefined || keys.has("eval")) {
					cannotRead(node, "a Worker with eval or unreadable options");
				}
			}
			for (const argument of node.arguments ?? []) {
				visit(argument, scopes);
			}
			return;
		}
		if (ts.isCallExpression(node)) {
			const [first, second, third] = node.arguments;
			if (isDynamicLoad(node)) {
				if (first === undefined || !ts.isStringLiteralLike(first)) {
					fail(node, "dynamic import or require without a literal specifier cannot be followed");
				} else if (spawnsFromExternal(first.text, "*")) {
					site(scopes, `import("${first.text}") at ${module.rel}:${lineOf(node)}`);
				} else if (first.text.startsWith(".")) {
					const target = resolveRelative(file, first.text, problems);
					if (target !== undefined) {
						load(scopes, target);
					}
				} else {
					admit(node, first.text);
				}
				if (baseName(node.expression) === "require") {
					for (const argument of node.arguments) {
						visit(argument, scopes);
					}
					return;
				}
			}
			const kind = registrationKind(node.expression);
			const isTest = kind === "test";
			const isHook = kind === "hook";
			const callback = isTest ? second : isHook ? first : undefined;
			if (callback !== undefined && (isFunctionLike(callback) || ts.isIdentifier(callback))) {
				if (ts.isIdentifier(callback)) {
					identifierCallbacks.push({ node, name: callback.text });
				}
				const registration: Registration = {
					...newScope(),
					kind: isTest ? "test" : "hook",
					subject:
						isTest && first !== undefined && ts.isStringLiteralLike(first) ? first.text : node.expression.getText(sf),
					line: lineOf(node),
					deadline: isTest ? third : second,
				};
				module.registrations.push(registration);
				// The callee chain (`test.each(rows)`, `it.skipIf(flag)`), the label, and the options run when the file
				// loads; only the callback runs under the registration's deadline.
				visit(node.expression, scopes);
				for (const argument of node.arguments) {
					visit(argument, argument === callback ? [...scopes, registration] : scopes);
				}
				return;
			}
			if ((isTest || isHook) && callback !== undefined) {
				fail(
					node,
					`unrecognized ${isTest ? "test" : "hook"} registration shape: the callback argument is ${ts.SyntaxKind[callback.kind]}`
				);
			}
		}
		if (ts.isPropertyAccessExpression(node)) {
			const base = baseName(node.expression);
			if (base === "Bun" && BUN_SPAWN_EXPORTS.has(node.name.text)) {
				site(scopes, `Bun.${node.name.text} at ${module.rel}:${lineOf(node)}`);
			}
			if (namesProcess(node.expression) && PROCESS_LOADER_MEMBERS.has(node.name.text)) {
				cannotRead(node, `process.${node.name.text}`);
			}
			// `Bun` and `require` are read only as a member base or called directly: stored anywhere else, what they
			// hand out cannot be followed (`const b = Bun; b[key]`, `const load = require`).
			if (base === "Bun" || base === "require") {
				if (base === "require" && !REQUIRE_MEMBERS.has(node.name.text)) {
					cannotRead(node, `require.${node.name.text}`);
				}
				visit(node.name, scopes);
				return;
			}
		}
		if (ts.isElementAccessExpression(node)) {
			const base = baseName(node.expression);
			const literal = ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;
			if (
				literal === undefined &&
				((base !== undefined && COMPUTED_MEMBER_BANNED_BASES.has(base)) || namesProcess(node.expression))
			) {
				cannotRead(node, `a computed member of ${base ?? "process"}`);
			} else if (
				literal !== undefined &&
				(spawnLocals.has(literal) || (base === "Bun" && BUN_SPAWN_EXPORTS.has(literal)))
			) {
				site(scopes, `["${literal}"] at ${module.rel}:${lineOf(node)}`);
			} else if (literal !== undefined && namesProcess(node.expression) && PROCESS_LOADER_MEMBERS.has(literal)) {
				cannotRead(node, `process["${literal}"]`);
			}
			if (base === "Bun" || base === "require") {
				if (base === "require" && (literal === undefined || !REQUIRE_MEMBERS.has(literal))) {
					cannotRead(node, "a computed or unlisted member of require");
				}
				visit(node.argumentExpression, scopes);
				return;
			}
		}
		if (ts.isIdentifier(node)) {
			if (node.text === "Bun" || node.text === "require") {
				cannotRead(node, `${node.text} used other than as a member base or direct call`);
			}
			if (DYNAMIC_CODE_IDENTIFIERS.has(node.text)) {
				cannotRead(node, node.text);
			}
			if (node.text === "Worker") {
				cannotRead(node, "Worker used other than as `new Worker(<relative path>)`");
			}
			for (const scope of enclosing(scopes)) {
				scope.refs.add(node.text);
			}
			if (spawnLocals.has(node.text)) {
				site(scopes, `${node.text} at ${module.rel}:${lineOf(node)}`);
			}
			return;
		}
		ts.forEachChild(node, (child) => visit(child, scopes));
	};
	visit(sf, []);
	for (const { node, name } of identifierCallbacks) {
		if (!module.decls.has(name) && !module.imports.has(name)) {
			fail(
				node,
				`registration callback "${name}" is neither declared nor imported here, so its body cannot be followed`
			);
		}
	}
	return module;
}

/**
 * Positive control on the declaration step: the parser's own statement list is the ground truth the walk must have
 * registered, so this recounts the file's top-level function, class, interface, type, enum, and namespace declarations
 * by the same naming rule and reports the ones module.decls never received. A runtime that silently skips the
 * registering call (bun 1.3.x dropped a statement beginning with the identifier `declare`) fails here as "the walk saw
 * nothing" instead of as hundreds of downstream export misses.
 */
function topLevelDeclarationControl(
	sf: ts.SourceFile,
	module: Module
): { readonly parsed: number; readonly missing: string[] } {
	let parsed = 0;
	const missing: string[] = [];
	for (const statement of sf.statements) {
		if (
			ts.isFunctionDeclaration(statement) ||
			ts.isClassDeclaration(statement) ||
			ts.isInterfaceDeclaration(statement) ||
			ts.isTypeAliasDeclaration(statement) ||
			ts.isEnumDeclaration(statement) ||
			ts.isModuleDeclaration(statement)
		) {
			parsed += 1;
			const name = statement.name !== undefined && ts.isIdentifier(statement.name) ? statement.name.text : "default";
			if (!module.decls.has(name)) {
				missing.push(`${name} (${module.rel})`);
			}
		}
	}
	return { parsed, missing };
}

interface Graph {
	readonly modules: Map<string, Module>;
	readonly problems: string[];
}

/**
 * The declaration scopes an exported name stands for, following re-exports and `export *`; undefined means
 * unresolved.
 */
function resolveExport(graph: Graph, file: string, name: string, visiting: Set<string>): Scope[] | undefined {
	const key = `${file}\0${name}`;
	if (visiting.has(key)) {
		return name === "*" ? [] : undefined;
	}
	visiting.add(key);
	const module = graph.modules.get(file);
	if (module === undefined) {
		graph.problems.push(`${rel(file)} was imported but never analyzed`);
		return [];
	}
	if (name === "*") {
		const all: Scope[] = [];
		for (const exported of module.exports.keys()) {
			all.push(...(resolveExport(graph, file, exported, visiting) ?? []));
		}
		for (const star of module.exportStars) {
			all.push(...(resolveExport(graph, star, "*", visiting) ?? []));
		}
		return all;
	}
	const binding = module.exports.get(name);
	if (binding === undefined) {
		for (const star of module.exportStars) {
			const found = resolveExport(graph, star, name, visiting);
			if (found !== undefined) {
				return found;
			}
		}
		return undefined;
	}
	if (binding.kind === "local") {
		return resolveName(graph, module, binding.name, visiting);
	}
	return resolveBinding(graph, binding, visiting);
}

function resolveBinding(graph: Graph, binding: Binding, visiting: Set<string>): Scope[] {
	if (binding.kind === "external") {
		return [];
	}
	const found = resolveExport(graph, binding.target, binding.name, visiting);
	if (found === undefined) {
		const recorded = [...(graph.modules.get(binding.target)?.exports.keys() ?? [])];
		graph.problems.push(
			`${rel(binding.target)} exports no "${binding.name}" the walk can find (it recorded ${recorded.length === 0 ? "no exports" : `${recorded.length} exports: ${recorded.join(", ")}`})`
		);
		return [];
	}
	return found;
}

/** What a name means inside a module: its declarations, or what its import binding stands for. */
function resolveName(graph: Graph, module: Module, name: string, visiting: Set<string>): Scope[] {
	const declared = module.decls.get(name);
	if (declared !== undefined) {
		return declared;
	}
	const imported = module.imports.get(name);
	if (imported !== undefined) {
		return resolveBinding(graph, imported, visiting);
	}
	return [];
}

/** Which scopes reach a spawn site, by fixpoint over the reference edges, with one witness chain each. */
function computeReach(graph: Graph): Map<Scope, string[]> {
	const edges = new Map<Scope, Set<Scope>>();
	const scopes: Scope[] = [];
	for (const module of graph.modules.values()) {
		for (const scope of [...[...module.decls.values()].flat(), ...module.registrations, module.moduleScope]) {
			if (edges.has(scope)) {
				continue;
			}
			const targets = new Set<Scope>();
			for (const ref of scope.refs) {
				for (const target of resolveName(graph, module, ref, new Set())) {
					targets.add(target);
				}
			}
			for (const loaded of scope.moduleRefs) {
				const target = graph.modules.get(loaded);
				if (target === undefined) {
					graph.problems.push(`${rel(loaded)} is loaded dynamically but was never analyzed`);
					continue;
				}
				for (const declared of [...target.decls.values()].flat()) {
					targets.add(declared);
				}
				for (const star of resolveExport(graph, loaded, "*", new Set()) ?? []) {
					targets.add(star);
				}
			}
			targets.delete(scope);
			edges.set(scope, targets);
			scopes.push(scope);
		}
	}
	const chains = new Map<Scope, string[]>();
	for (const scope of scopes) {
		if (scope.sites.length > 0) {
			chains.set(scope, [scope.sites[0] ?? "spawn"]);
		}
	}
	for (let changed = true; changed; ) {
		changed = false;
		for (const scope of scopes) {
			if (chains.has(scope)) {
				continue;
			}
			for (const target of edges.get(scope) ?? []) {
				const chain = chains.get(target);
				if (chain !== undefined) {
					chains.set(scope, [nameOf(graph, target), ...chain]);
					changed = true;
					break;
				}
			}
		}
	}
	return chains;
}

function nameOf(graph: Graph, scope: Scope): string {
	for (const module of graph.modules.values()) {
		for (const [name, declared] of module.decls) {
			if (declared.includes(scope)) {
				return `${name} (${module.rel})`;
			}
		}
		const registration = module.registrations.find((candidate) => candidate === scope);
		if (registration !== undefined) {
			return `${registration.kind} "${registration.subject}" (${module.rel}:${registration.line})`;
		}
		if (module.moduleScope === scope) {
			return `module level (${module.rel})`;
		}
	}
	return "?";
}

type DeadlineRead = { readonly ok: true; readonly constant: boolean } | { readonly ok: false; readonly why: string };

function readDeadline(module: Module, expression: ts.Expression | undefined, sf: ts.SourceFile): DeadlineRead {
	if (expression === undefined) {
		return { ok: false, why: "no deadline argument" };
	}
	if (ts.isIdentifier(expression)) {
		const binding = module.imports.get(expression.text);
		if (binding?.kind === "internal" && binding.target === DEADLINE_MODULE && binding.name === DEADLINE_NAME) {
			return { ok: true, constant: true };
		}
		return { ok: false, why: `"${expression.text}" is not ${DEADLINE_NAME} imported from ${DEADLINE_PATH}` };
	}
	if (ts.isNumericLiteral(expression)) {
		const value = Number(expression.text.replaceAll("_", ""));
		return value >= CHILD_PROCESS_TIMEOUT_MS
			? { ok: true, constant: false }
			: { ok: false, why: `${expression.text} is below ${DEADLINE_NAME} (${CHILD_PROCESS_TIMEOUT_MS})` };
	}
	if (ts.isObjectLiteralExpression(expression)) {
		const timeout = expression.properties.find(
			(property): property is ts.PropertyAssignment =>
				ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === "timeout"
		);
		return timeout === undefined
			? { ok: false, why: "options object without a timeout property" }
			: readDeadline(module, timeout.initializer, sf);
	}
	return { ok: false, why: `unrecognized deadline expression ${expression.getText(sf)}` };
}

function audit(): { readonly problems: string[]; readonly spawningRegistrations: number } {
	const problems: string[] = [];
	const roots = listRoots(problems);
	if (roots.length === 0) {
		problems.push(`no test files found under ${BUN_TREE}`);
	}
	const files = discoverModules(roots, problems);
	const program = ts.createProgram(files, {
		noResolve: true,
		noLib: true,
		types: [],
		allowJs: true,
		jsx: ts.JsxEmit.Preserve,
		target: ts.ScriptTarget.ESNext,
		module: ts.ModuleKind.ESNext,
	});
	for (const diagnostic of program.getSyntacticDiagnostics()) {
		const where = diagnostic.file === undefined ? "?" : rel(path.resolve(diagnostic.file.fileName));
		problems.push(`${where}: parse error: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
	}
	const graph: Graph = { modules: new Map(), problems };
	const context: Context = { problems, usedSafe: new Set(), jsxRuntimes: jsxRuntimeModules(problems) };
	let parsedDeclarations = 0;
	const unregistered: string[] = [];
	for (const file of files) {
		const sf = program.getSourceFile(file);
		if (sf === undefined) {
			problems.push(`${rel(file)}: the program did not parse this file (looked it up as ${file})`);
			continue;
		}
		const module = analyzeModule(sf, context);
		graph.modules.set(file, module);
		const control = topLevelDeclarationControl(sf, module);
		parsedDeclarations += control.parsed;
		unregistered.push(...control.missing);
	}
	if (parsedDeclarations === 0) {
		problems.push(
			"the walk parsed no top-level declaration anywhere in the tree, so it is not reading what it claims to read"
		);
	}
	if (unregistered.length > 0) {
		// Reach and export resolution both read the declaration table, so nothing computed from it would be trustworthy:
		// report the loss once, in place of the hundreds of misleading misses it would otherwise cause.
		const shown = unregistered.slice(0, 5).join(", ");
		problems.push(
			`the walk never registered ${unregistered.length} of the ${parsedDeclarations} top-level declarations it parsed (${shown}${unregistered.length > 5 ? ", ..." : ""}), so its declaration walk is incomplete and the audit stops here`
		);
		return { problems: [...new Set(problems)], spawningRegistrations: 0 };
	}
	const chains = computeReach(graph);
	const exceptionMatches = new Map<(typeof EXCEPTIONS)[number], string[]>(EXCEPTIONS.map((entry) => [entry, []]));
	let spawningRegistrations = 0;
	let sitesFound = 0;
	for (const module of graph.modules.values()) {
		const sf = program.getSourceFile(module.file);
		if (sf === undefined) {
			continue;
		}
		const declared = [...module.decls.values()].flat();
		sitesFound += [...declared, ...module.registrations, module.moduleScope].reduce(
			(count, scope) => count + scope.sites.length,
			0
		);
		// Code that runs when the module loads answers to no deadline; a function body a test calls answers to the test's.
		// A spawning function nothing calls is a helper the bun tree does not use (scripts hold several), not a member.
		for (const scope of [module.moduleScope, ...declared]) {
			const chain = chains.get(scope);
			if (scope.eager && chain !== undefined) {
				problems.push(
					`${nameOf(graph, scope)} reaches a child-process spawn (${chain.join(" -> ")}) when the module loads, where no deadline applies; a spawner stored in module-level data counts the same, so keep spawns behind functions that only a test or hook calls`
				);
			}
		}
		for (const registration of module.registrations) {
			const chain = chains.get(registration);
			const deadline = readDeadline(module, registration.deadline, sf);
			const where = `${module.rel}:${registration.line} ${registration.kind} "${registration.subject}"`;
			if (chain !== undefined) {
				spawningRegistrations += 1;
				if (!deadline.ok) {
					const exception = EXCEPTIONS.find(
						(candidate) =>
							registration.deadline === undefined &&
							candidate.file === module.rel &&
							candidate.subject === registration.subject
					);
					if (exception !== undefined) {
						exceptionMatches.get(exception)?.push(where);
					} else {
						problems.push(
							`${where} reaches a child-process spawn (${chain.join(" -> ")}) but carries no load-proof deadline (${deadline.why}); pass ${DEADLINE_NAME} from ${DEADLINE_PATH} as the ${registration.kind === "test" ? "test's third" : "hook's second"} argument`
						);
					}
				}
			} else if (deadline.ok && deadline.constant) {
				problems.push(
					`${where} carries ${DEADLINE_NAME} but reaches no child-process spawn; the deadline is reserved for spawning tests`
				);
			}
		}
	}
	for (const [exception, matches] of exceptionMatches) {
		if (matches.length === 0) {
			problems.push(
				`stale exception: ${exception.file} "${exception.subject}" matches no deadline-less spawning registration`
			);
		} else if (matches.length > 1) {
			problems.push(
				`exception ${exception.file} "${exception.subject}" matches ${matches.length} registrations (${matches.join("; ")}); one entry covers one`
			);
		}
	}
	for (const [name, reason] of KNOWN_SAFE_MODULES) {
		if (reason.trim().length === 0) {
			problems.push(`known-safe module "${name}" carries no reason`);
		}
		if (!context.usedSafe.has(name)) {
			problems.push(`stale known-safe module "${name}": nothing in the bun tree's runtime import closure loads it`);
		}
	}
	if (sitesFound === 0) {
		problems.push("the detector found no spawn site anywhere in the tree, so it is not reading what it claims to read");
	}
	return { problems: [...new Set(problems)], spawningRegistrations };
}

// No deadline of its own: this test parses files and spawns nothing.
test("every child-spawning bun test or hook carries the load-proof deadline, and only those do", () => {
	const { problems, spawningRegistrations } = audit();
	expect(problems).toEqual([]);
	expect(spawningRegistrations).toBeGreaterThan(0);
});
