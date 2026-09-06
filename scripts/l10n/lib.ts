/**
 * Shared machinery for the l10n scripts: the source walk and extraction behind
 * `l10n:extract`, the module-scope localization guard, and the zod schemas
 * `l10n:check` parses translation files with. Paths anchor on process.cwd():
 * package.json invokes these from the repo root.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getL10nJson, type l10nJsonFormat } from "@vscode/l10n-dev";
import ts from "typescript";
import { z } from "zod";
import { LAZY_L10N_HELPERS } from "./census";

export const BUNDLE_PATH = path.join(process.cwd(), "l10n", "bundle.l10n.json");

/**
 * The generated English bundle's values: a message, optionally wrapped with
 * translator comments. Translated bundles are NOT allowed the wrapped shape
 * (check.ts parses them with nlsSchema; the webview bootstrap drops non-string
 * values wholesale).
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

/** Extract every l10n.t() literal from the source tree, key-sorted. */

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
 * Which of `names` this file DECLARES as a top-level function, class, or
 * variable - the census-integrity check's evidence that an entry still names
 * something real. Through the AST, because a name in a comment or a string is
 * not a declaration. Import/export ALIASES count: an alias mints a new
 * call-site name, so the reverse walk can report it as its own obligation.
 */
export function declaredCensusNames(contents: string, fileName: string, names: readonly string[]): Set<string> {
	const wanted = new Set(names);
	const found = new Set<string>();
	const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const sourceFile = ts.createSourceFile(fileName, contents, ts.ScriptTarget.Latest, false, kind);
	const note = (name: string): void => {
		if (wanted.has(name)) {
			found.add(name);
		}
	};
	const noteBound = (name: ts.BindingName): void => {
		if (ts.isIdentifier(name)) {
			note(name.text);
			return;
		}
		for (const element of name.elements) {
			if (ts.isBindingElement(element)) {
				noteBound(element.name);
			}
		}
	};
	// A NODE walk, not a statement walk: the reverse census reaches names
	// through module-level control flow and for-initializers alike, and a name
	// it can demand has to be one this check can see. Function and class bodies
	// stay closed - their declarations bind locals, not top-level names.
	const visit = (node: ts.Node): void => {
		if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name !== undefined) {
			note(node.name.text);
		} else if (ts.isVariableDeclaration(node)) {
			noteBound(node.name);
		} else if (ts.isStatement(node)) {
			for (const alias of aliasSpecifiers(node)) {
				note(alias.name);
			}
			const entityAlias = importEqualsAlias(node);
			if (entityAlias !== undefined) {
				note(entityAlias.name);
			}
		}
		// The node is named first, then closed.
		if (!ts.isFunctionLike(node) && !ts.isClassLike(node)) {
			node.forEachChild(visit);
		}
	};
	visit(sourceFile);
	return found;
}

/** A renaming import/export specifier's minted name and the name it stands for. */

interface AliasSpecifier {
	readonly name: string;
	readonly of: string;
	readonly node: ts.Node;
}

/** The renaming (aliased) import/export specifiers of one top-level statement; a plain re-export mints no new name. */

function aliasSpecifiers(statement: ts.Statement): AliasSpecifier[] {
	const aliases: AliasSpecifier[] = [];
	if (ts.isImportDeclaration(statement)) {
		const bindings = statement.importClause?.namedBindings;
		if (statement.importClause?.isTypeOnly !== true && bindings !== undefined && ts.isNamedImports(bindings)) {
			for (const element of bindings.elements) {
				if (!element.isTypeOnly && element.propertyName !== undefined) {
					aliases.push({ name: element.name.text, of: element.propertyName.text, node: element });
				}
			}
		}
	} else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.exportClause !== undefined) {
		if (ts.isNamedExports(statement.exportClause)) {
			for (const element of statement.exportClause.elements) {
				// The propertyName may be a string literal (`export { "a-b" as t }`); both carry .text.
				if (!element.isTypeOnly && element.propertyName !== undefined) {
					aliases.push({ name: element.name.text, of: element.propertyName.text, node: element });
				}
			}
		}
	}
	return aliases;
}

/**
 * `import t = a.b.c` (and its exported form) minted under a new name: an
 * entity alias the specifier walk cannot see. `import x = require(...)` names
 * no binding to follow, so it yields nothing.
 */
function importEqualsAlias(statement: ts.Statement): AliasSpecifier | undefined {
	if (!ts.isImportEqualsDeclaration(statement) || statement.isTypeOnly) {
		return undefined;
	}
	let entity = statement.moduleReference;
	while (ts.isQualifiedName(entity)) {
		entity = entity.right;
	}
	return ts.isIdentifier(entity) ? { name: statement.name.text, of: entity.text, node: statement.name } : undefined;
}

/** A top-level function the reverse census walk found resolving l10n.t without a LAZY_L10N_HELPERS entry. */

export interface UncensusedLazyHelper {
	readonly file: string;
	readonly name: string;
	/** 1-based line of the declaration. */
	readonly line: number;
}

/** One top-level binding's localization evidence, before the cross-file closure. */

interface HelperNode {
	readonly file: string;
	readonly name: string;
	readonly line: number;
	/**
	 * Functions report lowercase-only (components are uppercase by
	 * convention); classes report at any case. An alias is exempt only where
	 * its own spelling AND its target both say so - see reportsAsObligation.
	 */
	readonly kind: "function" | "class" | "alias";
	/** For an alias: the name it stands for, one half of its reportability. */
	readonly aliasOf?: string;
	/** The declaration (default parameters included) contains a direct l10n.t or vscode.l10n.t call. */
	readonly direct: boolean;
	/** Every bare-identifier call-site name inside the declaration. */
	readonly callees: ReadonlySet<string>;
}

/** The invocation evidence of a set of nodes: a direct l10n.t call, plus every bare-name invocation edge. */

interface InvocationEvidence {
	direct: boolean;
	readonly callees: Set<string>;
}

/**
 * Assignment operators that hand their right side to the left-hand name:
 * plain `=` and the logical compounds, which assign conditionally and so can
 * bind a lazy helper exactly like a ternary branch.
 */
function isAssigningOperator(kind: ts.SyntaxKind): boolean {
	return (
		kind === ts.SyntaxKind.EqualsToken ||
		kind === ts.SyntaxKind.QuestionQuestionEqualsToken ||
		kind === ts.SyntaxKind.BarBarEqualsToken ||
		kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken
	);
}

/** The Function.prototype members that forward an invocation to their receiver. */

const FORWARDING_MEMBERS = new Set(["call", "apply", "bind"]);

/** A property access, or an element access whose key is a string literal - one member read either way. */

function memberNameOf(node: ts.Expression): { readonly object: ts.Expression; readonly member: string } | undefined {
	if (ts.isPropertyAccessExpression(node)) {
		return { object: node.expression, member: node.name.text };
	}
	if (ts.isElementAccessExpression(node)) {
		const key = unwrapExpression(node.argumentExpression);
		if (ts.isStringLiteralLike(key)) {
			return { object: node.expression, member: key.text };
		}
	}
	return undefined;
}

/**
 * Strip trailing .call/.apply/.bind links (unwrapping at each step, element
 * access with a literal key included) so `helper.call(...)` and
 * `helper["call"](...)` read as `helper` and `l10n.t.call(...)` as `l10n.t`.
 * A local namespace import's member named `call`/`apply`/`bind` is that
 * module's own export, not Function.prototype, so stripping stops there. A
 * receiver whose genuine method shares one of those names over-strips into a
 * harmless extra edge, and a bare `.bind` flags even uninvoked - deliberate
 * conservatism; reference the helper plainly instead.
 */
function stripForwarding(node: ts.Expression, sourceFile: ts.SourceFile): ts.Expression {
	let current = unwrapExpression(node);
	for (;;) {
		if (namespaceMemberName(current, sourceFile) !== undefined) {
			return current;
		}
		const read = memberNameOf(current);
		if (read === undefined || !FORWARDING_MEMBERS.has(read.member)) {
			return current;
		}
		current = unwrapExpression(read.object);
	}
}

/**
 * Local (relative-specifier) namespace-import names of one file, computed once
 * per SourceFile. The "." prefix is the locality test: a tsconfig `paths`
 * alias or a package subpath would not resolve here (none exist in shipped
 * source; the check is defensive, not load-bearing).
 */
const localNamespaceCache = new WeakMap<ts.SourceFile, ReadonlySet<string>>();

function localNamespaceImports(sourceFile: ts.SourceFile): ReadonlySet<string> {
	const cached = localNamespaceCache.get(sourceFile);
	if (cached !== undefined) {
		return cached;
	}
	const names = new Set<string>();
	for (const statement of sourceFile.statements) {
		if (
			ts.isImportDeclaration(statement) &&
			statement.importClause?.isTypeOnly !== true &&
			statement.importClause?.namedBindings !== undefined &&
			ts.isNamespaceImport(statement.importClause.namedBindings) &&
			ts.isStringLiteral(statement.moduleSpecifier) &&
			statement.moduleSpecifier.text.startsWith(".")
		) {
			names.add(statement.importClause.namedBindings.name.text);
		}
	}
	localNamespaceCache.set(sourceFile, names);
	return names;
}

/**
 * The member name a member read resolves to when its object is a LOCAL
 * namespace import: `helpers.title` (and `helpers["title"]`) reads as
 * `title`, joining the graph under the member's own name (matching stays by
 * name, the guard's rule). Package and builtin namespaces (`path.join`)
 * resolve to nothing - their members are not census names - and deeper
 * chains (`helpers.sub.title`) stay outside.
 */
function namespaceMemberName(expression: ts.Expression, sourceFile: ts.SourceFile): string | undefined {
	const read = memberNameOf(expression);
	if (read === undefined) {
		return undefined;
	}
	const object = unwrapExpression(read.object);
	if (ts.isIdentifier(object) && localNamespaceImports(sourceFile).has(object.text)) {
		return read.member;
	}
	return undefined;
}

/**
 * Every intermediate form the resolution visits - branch flattening and
 * forwarding stripping interleaved to a FIXED POINT, each candidate recorded
 * BEFORE its strip. Stripping can expose a fresh choosing shape underneath
 * (`(flag ? helper : plain).call(...)`), and a branch can expose fresh
 * forwarding, so the two interleave until stable. Terminates because both
 * steps strictly descend; the seen set covers repeats.
 */
function resolutionTrace(expression: ts.Expression, sourceFile: ts.SourceFile): ts.Expression[] {
	const visited: ts.Expression[] = [];
	const queue = possibleValues(expression);
	const seen = new Set<ts.Expression>();
	while (queue.length > 0) {
		const candidate = queue.pop() as ts.Expression;
		if (seen.has(candidate)) {
			continue;
		}
		seen.add(candidate);
		visited.push(candidate);
		const stripped = stripForwarding(candidate, sourceFile);
		if (stripped !== candidate) {
			queue.push(...possibleValues(stripped));
		}
	}
	return visited;
}

/**
 * The fixed point's RESOLVED candidates: the trace's stable forms, carrying
 * no wrapper, choosing shape, or forwarding link. The one shared resolution
 * pipeline for callees, forwarder targets, alias sources, and argument taint;
 * forwarder DETECTION reads the whole trace instead, since resolving erases
 * the forwarding spelling that identifies a forwarder.
 */
function calleeCandidates(expression: ts.Expression, sourceFile: ts.SourceFile): ts.Expression[] {
	return resolutionTrace(expression, sourceFile).filter(
		(candidate) => stripForwarding(candidate, sourceFile) === candidate
	);
}

/**
 * Walk `roots` for every invocation shape - calls, tagged templates, `new` -
 * noting a direct l10n.t/vscode.l10n.t hit or a bare-identifier edge. Every
 * resolution site - callees, alias sources, direct arguments - reads through
 * calleeCandidates, so choosing shapes and .call/.apply/.bind forwarding
 * resolve to a fixed point wherever they nest; a local namespace import's
 * member resolves to the member's name, and a computed member call
 * (`helper[key]()`) edges its receiver, since the member cannot be read.
 * Bare-identifier variable initializers and assignment right-hand sides count
 * as edges too, so a FUNCTION-LOCAL alias becomes the enclosing declaration's
 * own edge, and a direct argument (identifier or local-namespace member) is
 * the calling declaration's edge as well - the walk cannot see whether the
 * callee invokes what it is handed.
 */
function invocationEvidence(roots: readonly ts.Node[], sourceFile: ts.SourceFile): InvocationEvidence {
	const evidence: InvocationEvidence = { direct: false, callees: new Set<string>() };
	const note = (calleeExpression: ts.Expression): void => {
		for (const callee of calleeCandidates(calleeExpression, sourceFile)) {
			const calleeText = callee.getText(sourceFile);
			if (calleeText === "l10n.t" || calleeText === "vscode.l10n.t") {
				evidence.direct = true;
				continue;
			}
			if (ts.isIdentifier(callee)) {
				evidence.callees.add(callee.text);
				continue;
			}
			const member = namespaceMemberName(callee, sourceFile);
			if (member !== undefined) {
				evidence.callees.add(member);
				continue;
			}
			// A computed member call on a bare name or a local-namespace member:
			// the member is unreadable, so the receiver carries the edge (a lazy
			// function's only meaningful members are its forwarders), resolved
			// through the same pipeline so a choosing receiver flattens. Literal
			// keys resolved above; a key on any other receiver stays the
			// thunk-table boundary.
			if (ts.isElementAccessExpression(callee)) {
				const key = unwrapExpression(callee.argumentExpression);
				if (!ts.isStringLiteralLike(key)) {
					for (const receiver of calleeCandidates(callee.expression, sourceFile)) {
						if (ts.isIdentifier(receiver)) {
							evidence.callees.add(receiver.text);
						} else {
							const receiverMember = namespaceMemberName(receiver, sourceFile);
							if (receiverMember !== undefined) {
								evidence.callees.add(receiverMember);
							}
						}
					}
				}
			}
		}
	};
	const noteAliasSources = (rhs: ts.Expression): void => {
		for (const source of calleeCandidates(rhs, sourceFile)) {
			if (ts.isIdentifier(source)) {
				evidence.callees.add(source.text);
			} else {
				const member = namespaceMemberName(source, sourceFile);
				if (member !== undefined) {
					evidence.callees.add(member);
				}
			}
		}
	};
	// Direct arguments only: an identifier nested in an array or object
	// literal, or behind a spread, is a value in a structure - the documented
	// data-flow boundary, pinned by fixtures.
	const noteArguments = (args: readonly ts.Expression[] | undefined): void => {
		for (const argument of args ?? []) {
			noteAliasSources(argument);
		}
	};
	const dig = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) {
			note(node.expression);
			noteArguments(node.arguments);
		} else if (ts.isTaggedTemplateExpression(node)) {
			note(node.tag);
		} else if (ts.isNewExpression(node)) {
			note(node.expression);
			noteArguments(node.arguments);
		}
		// A default aliases exactly like a variable initializer does, wherever it
		// binds: `wrap(title = manageCommandTitle)` and `{ title = ... } = {}`.
		if (
			(ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) &&
			node.initializer !== undefined
		) {
			noteAliasSources(node.initializer);
		}
		if (ts.isBinaryExpression(node) && isAssigningOperator(node.operatorToken.kind)) {
			noteAliasSources(node.right);
		}
		ts.forEachChild(node, dig);
	};
	for (const root of roots) {
		dig(root);
	}
	return evidence;
}

/**
 * A class's CONSTRUCTION-time localization evidence: the constructor body and
 * parameter defaults and the instance property initializers, the code `new`
 * reaches; methods stay deferred and do not taint, and each heritage name is
 * an edge. Those roots are walked WHOLE, nested function literals included, so
 * a registered callback or a property-initialized thunk table counts even
 * though neither RUNS at `new` - the census's documented over-inclusion.
 */
function classConstructionEvidence(cls: ts.ClassLikeDeclaration, sourceFile: ts.SourceFile): InvocationEvidence {
	const roots: ts.Node[] = [];
	for (const member of cls.members) {
		if (ts.isConstructorDeclaration(member)) {
			if (member.body !== undefined) {
				roots.push(member.body);
			}
			// The whole parameter: a default nested in a destructuring pattern
			// evaluates at `new` too.
			roots.push(...member.parameters);
		} else if (
			ts.isPropertyDeclaration(member) &&
			!(ts.getModifiers(member) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) &&
			member.initializer !== undefined
		) {
			roots.push(member.initializer);
		}
	}
	const evidence = invocationEvidence(roots, sourceFile);
	for (const clause of cls.heritageClauses ?? []) {
		for (const type of clause.types) {
			// A base resolves like a callee: choosing shapes flatten, and a
			// local namespace member reads by member name.
			for (const base of calleeCandidates(type.expression, sourceFile)) {
				if (ts.isIdentifier(base)) {
					evidence.callees.add(base.text);
				} else {
					const member = namespaceMemberName(base, sourceFile);
					if (member !== undefined) {
						evidence.callees.add(member);
					}
				}
			}
		}
	}
	return evidence;
}

/**
 * Whether a lazy node's name is a census obligation. Functions report
 * lowercase-only (the uppercase-component convention is the whole exemption);
 * classes report at any case, since a constructor freezes like a helper call.
 *
 * An alias is exempt only when BOTH its own spelling and what it NAMES say so:
 * aliasing a component mints no obligation, but re-spelling one lowercase
 * (`export { Banner as label }`) mints a helper-shaped name that freezes.
 * Target resolution follows alias chains and fails CLOSED - an unresolvable
 * target or a cycle reports - so the exemption applies only where the walk can
 * PROVE the target is a component.
 */
function reportsAsObligation(
	node: HelperNode,
	byName: ReadonlyMap<string, HelperNode[]>,
	seen: ReadonlySet<string>
): boolean {
	if (node.kind === "class") {
		return true;
	}
	if (node.kind === "function") {
		return /^[a-z]/.test(node.name);
	}
	// An alias, judged on its own spelling first: a lowercase name is
	// helper-shaped whatever it stands for.
	if (/^[a-z]/.test(node.name)) {
		return true;
	}
	const target = node.aliasOf;
	if (target === undefined || seen.has(target)) {
		return true;
	}
	const targets = byName.get(target);
	if (targets === undefined || targets.length === 0) {
		return true;
	}
	return targets.some((candidate) => reportsAsObligation(candidate, byName, new Set(seen).add(target)));
}

/**
 * The census's reverse direction: every top-level name whose declaration
 * resolves l10n.t at call time, directly or transitively, and is missing from
 * LAZY_L10N_HELPERS - so the guard cannot be disarmed by never registering a
 * helper. Call-site names, bare-identifier calls only, closed over the whole
 * source set; reportsAsObligation decides which names REPORT.
 *
 * Candidates are every top-level shape that mints a call-site name for
 * deferred code (declarations, function-literal/IIFE/class-expression
 * bindings, renaming specifiers, identifier aliases); default exports are
 * banned instead, being the one shape no name-following walk can chase.
 * Deliberately over-inclusive, per the census's own rule.
 */
export function uncensusedLazyHelpers(
	sources: readonly SourceFile[],
	census: readonly string[]
): UncensusedLazyHelper[] {
	const nodes: HelperNode[] = [];
	for (const { file, contents } of sources) {
		// No substring pre-filter here, unlike the forward check: a file that
		// never spells "l10n" can still be a LINK in a lazy chain, so every
		// file's top-level functions join the graph.
		nodes.push(...collectTopLevelFunctions(file, contents));
	}
	// The closure: seeded by direct callers and the census, grown through the
	// call edges until stable. Matching is by name (the guard's own rule).
	const lazyNames = new Set<string>(census);
	for (const node of nodes) {
		if (node.direct) {
			lazyNames.add(node.name);
		}
	}
	let grew = true;
	while (grew) {
		grew = false;
		for (const node of nodes) {
			if (lazyNames.has(node.name)) {
				continue;
			}
			for (const callee of node.callees) {
				if (lazyNames.has(callee)) {
					lazyNames.add(node.name);
					grew = true;
					break;
				}
			}
		}
	}
	const censusSet = new Set(census);
	const findings: UncensusedLazyHelper[] = [];
	const seen = new Set<string>();
	const byName = new Map<string, HelperNode[]>();
	for (const node of nodes) {
		const bucket = byName.get(node.name);
		if (bucket === undefined) {
			byName.set(node.name, [node]);
		} else {
			bucket.push(node);
		}
	}
	for (const node of nodes) {
		if (!lazyNames.has(node.name) || censusSet.has(node.name) || !reportsAsObligation(node, byName, new Set())) {
			continue;
		}
		// One finding per name per file; a name declared twice in one file is
		// the same census obligation either way.
		const key = `${node.file}\n${node.name}`;
		if (!seen.has(key)) {
			seen.add(key);
			findings.push({ file: node.file, name: node.name, line: node.line });
		}
	}
	return findings;
}

/** Every top-level binding in one file, with its direct-l10n evidence and bare-call edges. */

function collectTopLevelFunctions(file: string, contents: string): HelperNode[] {
	const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const sourceFile = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, false, kind);
	const nodes: HelperNode[] = [];
	const lineOf = (node: ts.Node): number =>
		sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
	const push = (name: string, at: ts.Node, evidence: InvocationEvidence, nodeKind: "function" | "class"): void => {
		nodes.push({ file, name, line: lineOf(at), kind: nodeKind, direct: evidence.direct, callees: evidence.callees });
	};
	/** An alias node: one edge to the name it stands for, which is also half of its reportability. */
	const pushAlias = (name: string, at: ts.Node, of: string): void => {
		nodes.push({ file, name, line: lineOf(at), kind: "alias", aliasOf: of, direct: false, callees: new Set([of]) });
	};
	const isFunctionLiteral = (node: ts.Node): boolean => ts.isArrowFunction(node) || ts.isFunctionExpression(node);
	// One binding of a name to a right-hand side, judged for EVERY value the
	// RHS can hand over (calleeCandidates flattens choosing shapes and strips
	// forwarding to a fixed point, so `const t = helper.call` aliases helper).
	const handleBinding = (name: ts.Identifier, rhs: ts.Expression): void => {
		for (const source of calleeCandidates(rhs, sourceFile)) {
			if (isFunctionLiteral(source)) {
				push(name.text, name, invocationEvidence([source], sourceFile), "function");
			} else if (ts.isCallExpression(source) && isFunctionLiteral(unwrapExpression(source.expression))) {
				push(name.text, name, invocationEvidence([source], sourceFile), "function");
			} else if (ts.isClassExpression(source)) {
				push(name.text, name, classConstructionEvidence(source, sourceFile), "class");
			} else if (ts.isIdentifier(source)) {
				pushAlias(name.text, name, source.text);
			} else {
				// A local namespace import's member is the same alias by member
				// name: `const t = helpers.title` mints a `title` obligation.
				const member = namespaceMemberName(source, sourceFile);
				if (member !== undefined) {
					pushAlias(name.text, name, member);
				}
			}
		}
	};
	const handleStatement = (statement: ts.Statement): void => {
		if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
			// An overload SIGNATURE declares no code, and a node minted from it
			// would point the finding away from the body. The implementation
			// below it is the declaration that counts.
			if (statement.body !== undefined) {
				push(statement.name.text, statement.name, invocationEvidence([statement], sourceFile), "function");
			}
			return;
		}
		if (ts.isClassDeclaration(statement)) {
			if (statement.name !== undefined) {
				push(statement.name.text, statement.name, classConstructionEvidence(statement, sourceFile), "class");
			}
			return;
		}
		// A renaming import/export specifier mints a new call-site name: the
		// alias joins the graph with one edge to the name it stands for.
		for (const alias of aliasSpecifiers(statement)) {
			pushAlias(alias.name, alias.node, alias.of);
		}
		const entityAlias = importEqualsAlias(statement);
		if (entityAlias !== undefined) {
			pushAlias(entityAlias.name, entityAlias.node, entityAlias.of);
		}
		// Bindings and nested statements, wherever module-level code puts them:
		// variable statements, assignments, for-initializers, and the bodies of
		// top-level if/for/switch/try all bind module-level names. Function and
		// class bodies stay deferred boundaries - what they do reaches the graph
		// as the enclosing binding's own evidence.
		descend(statement);
	};
	const descend = (node: ts.Node): void => {
		node.forEachChild((child) => {
			if (ts.isStatement(child)) {
				handleStatement(child);
				return;
			}
			if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name) && child.initializer !== undefined) {
				handleBinding(child.name, child.initializer);
			} else if (ts.isBindingElement(child) && ts.isIdentifier(child.name) && child.initializer !== undefined) {
				// A destructuring default: `const { title = lazyHelper } = {}`.
				handleBinding(child.name, child.initializer);
			} else if (ts.isBinaryExpression(child) && isAssigningOperator(child.operatorToken.kind)) {
				const target = unwrapExpression(child.left);
				if (ts.isIdentifier(target)) {
					handleBinding(target, child.right);
				}
			}
			if (!ts.isFunctionLike(child) && !ts.isClassLike(child)) {
				descend(child);
			}
		});
	};
	for (const statement of sourceFile.statements) {
		handleStatement(statement);
	}
	return nodes;
}

/** Parens and type wrappers do not change what evaluates; strip them so `(fn)()` and `fn as T` read as fn. */

function unwrapExpression(node: ts.Expression): ts.Expression {
	let current = node;
	while (
		ts.isParenthesizedExpression(current) ||
		ts.isAsExpression(current) ||
		ts.isSatisfiesExpression(current) ||
		ts.isNonNullExpression(current) ||
		ts.isTypeAssertionExpression(current)
	) {
		current = current.expression;
	}
	return current;
}

/**
 * The value expressions a right-hand side can hand to its binding, with the
 * choosing shapes flattened (ternaries, `??`/`||`/`&&`, comma and nested
 * assignment). Bindings judge every candidate, so a lazy helper cannot hide
 * behind the branch a static walk cannot pick.
 */
function possibleValues(rhs: ts.Expression): ts.Expression[] {
	const source = unwrapExpression(rhs);
	if (ts.isConditionalExpression(source)) {
		return [...possibleValues(source.whenTrue), ...possibleValues(source.whenFalse)];
	}
	if (ts.isBinaryExpression(source)) {
		const operator = source.operatorToken.kind;
		if (
			operator === ts.SyntaxKind.BarBarToken ||
			operator === ts.SyntaxKind.AmpersandAmpersandToken ||
			operator === ts.SyntaxKind.QuestionQuestionToken
		) {
			return [...possibleValues(source.left), ...possibleValues(source.right)];
		}
		// A logical assignment's VALUE is one side or the other, exactly like
		// the logical operator it compounds: `(held ||= helper)()` calls helper.
		// Plain `=` yields its right side alone, below.
		if (operator !== ts.SyntaxKind.EqualsToken && isAssigningOperator(operator)) {
			return [...possibleValues(source.left), ...possibleValues(source.right)];
		}
		if (operator === ts.SyntaxKind.CommaToken || operator === ts.SyntaxKind.EqualsToken) {
			return possibleValues(source.right);
		}
	}
	return [source];
}

/**
 * Every name in one file that resolves l10n.t when called, at ANY scope, as a
 * fixed point over the file's function-ish bindings (declarations, function
 * literals, IIFEs, aliases, nested ones included). Matching is by name,
 * scope-insensitively - the guard's documented syntactic semantics - so a name
 * bound anywhere in the file lands in this set however it is renamed or
 * reconstructed. It over-flags rather than under-flags within that scope; the
 * census docstring names what falls outside it.
 */
function fileLazyNames(sourceFile: ts.SourceFile, census: readonly string[]): Set<string> {
	interface Binding {
		readonly name: string;
		readonly direct: boolean;
		readonly callees: ReadonlySet<string>;
	}
	const bindings: Binding[] = [];
	// The shared evidence walkers, which the reverse census reads too, so the
	// two guards cannot drift shape by shape.
	const collectFrom = (name: string, declaration: ts.Node): void => {
		const evidence = invocationEvidence([declaration], sourceFile);
		bindings.push({ name, direct: evidence.direct, callees: evidence.callees });
	};
	const isFunctionLiteral = (node: ts.Node): boolean => ts.isArrowFunction(node) || ts.isFunctionExpression(node);
	// A class binding is lazy when the roots `new` evaluates reach l10n, which
	// is wider than what `new` RUNS; methods stay deferred and do not taint
	// (classConstructionEvidence owns the details).
	const collectClass = (name: string, cls: ts.ClassLikeDeclaration): void => {
		const evidence = classConstructionEvidence(cls, sourceFile);
		bindings.push({ name, direct: evidence.direct, callees: evidence.callees });
	};
	const bind = (name: string, rhs: ts.Expression): void => {
		for (const source of calleeCandidates(rhs, sourceFile)) {
			if (isFunctionLiteral(source)) {
				collectFrom(name, source);
			} else if (ts.isCallExpression(source) && isFunctionLiteral(unwrapExpression(source.expression))) {
				// An IIFE-bound name: whatever it hands back is callable under
				// this name, so the whole initializer counts.
				collectFrom(name, source);
			} else if (ts.isClassExpression(source)) {
				collectClass(name, source);
			} else if (ts.isIdentifier(source)) {
				bindings.push({ name, direct: false, callees: new Set([source.text]) });
			} else {
				// A local namespace import's member aliases by member name too.
				const member = namespaceMemberName(source, sourceFile);
				if (member !== undefined) {
					bindings.push({ name, direct: false, callees: new Set([member]) });
				}
			}
		}
	};
	const visit = (node: ts.Node): void => {
		if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
			collectFrom(node.name.text, node);
		} else if (ts.isClassDeclaration(node) && node.name !== undefined) {
			collectClass(node.name.text, node);
		} else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
			bind(node.name.text, node.initializer);
		} else if (
			(ts.isBindingElement(node) || ts.isParameter(node)) &&
			ts.isIdentifier(node.name) &&
			node.initializer !== undefined
		) {
			// A default binds a name to whatever it defaults TO, wherever it sits.
			bind(node.name.text, node.initializer);
		} else if (ts.isBinaryExpression(node) && isAssigningOperator(node.operatorToken.kind)) {
			const target = unwrapExpression(node.left);
			if (ts.isIdentifier(target)) {
				bind(target.text, node.right);
			}
		} else if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
			// A renaming import/export specifier binds a new local name to
			// whatever it renames, so `new Renamed()` at module scope is the
			// same freeze as the original.
			for (const alias of aliasSpecifiers(node)) {
				bindings.push({ name: alias.name, direct: false, callees: new Set([alias.of]) });
			}
		} else if (ts.isImportEqualsDeclaration(node)) {
			const entityAlias = importEqualsAlias(node);
			if (entityAlias !== undefined) {
				bindings.push({ name: entityAlias.name, direct: false, callees: new Set([entityAlias.of]) });
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	const lazy = new Set<string>(census);
	for (const binding of bindings) {
		if (binding.direct) {
			lazy.add(binding.name);
		}
	}
	let grew = true;
	while (grew) {
		grew = false;
		for (const binding of bindings) {
			if (!lazy.has(binding.name)) {
				for (const callee of binding.callees) {
					if (lazy.has(callee)) {
						lazy.add(binding.name);
						grew = true;
						break;
					}
				}
			}
		}
	}
	return lazy;
}

/**
 * Line numbers (1-based) of module-scope localization calls: l10n.t,
 * vscode.l10n.t, or any name that resolves them, evaluated while the module
 * loads - before l10n.config has run, freezing the English text.
 *
 * A real parse of what evaluates at load time, within the census's documented
 * name-following limits: literals, templates, type wrappers, control flow, and IIFEs are
 * searched, while function bodies, object methods and accessors, and instance
 * property initializers defer and pass. Class STATICS do not defer. Callable
 * names come from fileLazyNames plus the census; a callee resolves through
 * calleeCandidates - branch flattening and forwarding stripping interleaved
 * to a fixed point - then a local namespace import's member call matches by
 * member name, a computed member call (`helper[key]()`) matches by its
 * receiver, and the caller-side forwarders (Reflect.apply, Reflect.construct,
 * Function.prototype.call/apply) match by every direct argument - tracked
 * names, inline functions, and inline classes alike.
 *
 * The residual is what these matches cannot express: a destructured `t`
 * (vscodeL10nOffenses bans that shape outright), a custom wrapper invoking
 * its argument (module-scope references stay deliberately quiet), a
 * re-spelled forwarder (`globalThis.Reflect.apply`, a rebound `Reflect` -
 * text matching is the decision, see isCallerForwarder), and a member call
 * reaching a class STATIC that localizes - all pinned by fixtures as the
 * boundary, not discovered.
 */
export function moduleScopeL10nOffenses(contents: string, fileName: string): number[] {
	const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const sourceFile = ts.createSourceFile(fileName, contents, ts.ScriptTarget.Latest, false, kind);
	const offenses: number[] = [];
	const tracked = fileLazyNames(sourceFile, LAZY_L10N_HELPERS);

	const unwrap = unwrapExpression;

	const isStatic = (member: ts.ClassElement): boolean =>
		ts.canHaveModifiers(member) &&
		(ts.getModifiers(member) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword);

	// Walk what evaluates at module load. Function bodies are skipped unless
	// invoked on the spot, which evaluates them eagerly.

	/** Whether one flattened callee candidate resolves a tracked name or l10n.t. */
	const candidateIsTracked = (candidate: ts.Expression): boolean => {
		const callee = stripForwarding(candidate, sourceFile);
		const calleeText = callee.getText(sourceFile);
		if (calleeText === "l10n.t" || calleeText === "vscode.l10n.t" || tracked.has(calleeText)) {
			return true;
		}
		const member = namespaceMemberName(callee, sourceFile);
		if (member !== undefined && tracked.has(member)) {
			return true;
		}
		// A COMPUTED member call on a tracked name or a tracked local-namespace
		// member: the key is unreadable and a lazy function's only meaningful
		// members are its forwarders; the receiver resolves through the same
		// pipeline so a choosing receiver flattens. Literal keys resolved
		// above; ordinary member calls on a name that merely shares a census
		// spelling (`lastSync.toISOString()`) stay quiet.
		if (ts.isElementAccessExpression(callee)) {
			const key = unwrap(callee.argumentExpression);
			if (!ts.isStringLiteralLike(key)) {
				for (const receiver of calleeCandidates(callee.expression, sourceFile)) {
					if (ts.isIdentifier(receiver) && tracked.has(receiver.text)) {
						return true;
					}
					const receiverMember = namespaceMemberName(receiver, sourceFile);
					if (receiverMember !== undefined && tracked.has(receiverMember)) {
						return true;
					}
				}
			}
		}
		return false;
	};

	// The caller-side forwarders invoke what they are handed: stripping
	// Reflect.apply / Function.prototype.call/apply leaves their bare
	// receivers, and Reflect.construct strips nothing. Matching is by TEXT, so
	// `globalThis.Reflect.apply` or a rebound `const R = Reflect` stays quiet -
	// deliberate obfuscation, left outside like every custom wrapper, because
	// treating arbitrary arguments as callees would contradict the sanctioned
	// `register(helper)` reference pattern.
	const isCallerForwarder = (candidate: ts.Expression): boolean => {
		const stripped = stripForwarding(candidate, sourceFile);
		const strippedText = stripped.getText(sourceFile);
		return (
			strippedText === "Reflect.construct" ||
			(stripped !== candidate && (strippedText === "Reflect" || strippedText === "Function.prototype"))
		);
	};

	/** An inline class whose construction-time roots resolve a tracked name or l10n.t flags at `node`. */
	const flagInlineClass = (node: ts.Node, cls: ts.ClassExpression): void => {
		const evidence = classConstructionEvidence(cls, sourceFile);
		if (evidence.direct || [...evidence.callees].some((callee) => tracked.has(callee))) {
			offenses.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
		}
	};

	const flagIfTracked = (node: ts.Node, calleeExpression: ts.Expression, args?: readonly ts.Expression[]): void => {
		// calleeCandidates resolves the callee to a fixed point, so no choosing
		// shape, paren, type wrapper, or .call/.apply/.bind link - however
		// nested - may launder a freeze past this match.
		for (const candidate of calleeCandidates(calleeExpression, sourceFile)) {
			if (candidateIsTracked(candidate)) {
				offenses.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
				return;
			}
		}
		// EVERY argument of a recognized forwarder, not just the first:
		// `Reflect.apply.call(...)` shifts its target one slot right, and a
		// tracked name has no business in any forwarder slot at module scope.
		// Forwarder detection reads the whole resolution TRACE - the resolved
		// forms erase the forwarding spelling that identifies one.
		if (args !== undefined && resolutionTrace(calleeExpression, sourceFile).some(isCallerForwarder)) {
			for (const argument of args) {
				for (const target of calleeCandidates(argument, sourceFile)) {
					if (candidateIsTracked(target)) {
						offenses.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
						return;
					}
				}
			}
		}
	};
	// A function invoked ON THE SPOT evaluates its parameter defaults as well as
	// its body, whether a call or a template tag runs it.
	const scanInvoked = (invoked: ts.ArrowFunction | ts.FunctionExpression): void => {
		// The whole parameter, not just its initializer: a default nested in a
		// destructuring pattern evaluates with the invocation too.
		for (const parameter of invoked.parameters) {
			scan(parameter);
		}
		scan(invoked.body);
	};
	// Every inline function a callee can resolve to: a plain branch, one under
	// forwarding (`(fn).call(...)`), or one behind a computed member read
	// (`(fn)[key]()` invokes some member of fn - its forwarders in practice),
	// the receiver resolved through the same pipeline.
	const scanInvokedCandidates = (expression: ts.Expression): void => {
		for (const candidate of calleeCandidates(expression, sourceFile)) {
			if (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate)) {
				scanInvoked(candidate);
			} else if (ts.isElementAccessExpression(candidate)) {
				for (const receiver of calleeCandidates(candidate.expression, sourceFile)) {
					if (ts.isArrowFunction(receiver) || ts.isFunctionExpression(receiver)) {
						scanInvoked(receiver);
					}
				}
			}
		}
	};
	const scan = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) {
			flagIfTracked(node, node.expression, node.arguments);
			// A function literal in ANY branch of the callee evaluates eagerly
			// when that branch is picked, however deep choosing shapes and
			// forwarding nest; a computed member call on an inline function
			// evaluates it too, and a recognized forwarder's arguments evaluate
			// its inline function and class targets the same way.
			scanInvokedCandidates(node.expression);
			if (resolutionTrace(node.expression, sourceFile).some(isCallerForwarder)) {
				for (const argument of node.arguments) {
					for (const target of calleeCandidates(argument, sourceFile)) {
						if (ts.isArrowFunction(target) || ts.isFunctionExpression(target)) {
							scanInvoked(target);
						} else if (ts.isClassExpression(target)) {
							flagInlineClass(node, target);
						}
					}
				}
			}
			scan(node.expression);
			for (const argument of node.arguments) {
				scan(argument);
			}
			return;
		}
		// A tagged template runs its tag and a `new` runs its callee: both are
		// module-load invocations exactly like a call, tag-IIFE included.
		if (ts.isTaggedTemplateExpression(node)) {
			flagIfTracked(node, node.tag);
			scanInvokedCandidates(node.tag);
			scan(node.tag);
			scan(node.template);
			return;
		}
		if (ts.isNewExpression(node)) {
			flagIfTracked(node, node.expression, node.arguments);
			// Constructing an INLINE class runs its constructor, parameter
			// defaults, and instance property initializers on the spot, and
			// extends invokes the base constructor - in ANY callee branch; an
			// inline FUNCTION constructed with new runs its body the same way.
			for (const candidate of calleeCandidates(node.expression, sourceFile)) {
				if (ts.isClassExpression(candidate)) {
					flagInlineClass(node, candidate);
				} else if (ts.isFunctionExpression(candidate)) {
					scanInvoked(candidate);
				}
			}
			scan(node.expression);
			for (const argument of node.arguments ?? []) {
				scan(argument);
			}
			return;
		}
		if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
			for (const decorator of ts.getDecorators(node) ?? []) {
				// A bare-name decorator invokes that name at class definition
				// time; a factory decorator is a CallExpression the scan below
				// flags by its own callee.
				flagIfTracked(decorator, decorator.expression);
				scan(decorator.expression);
			}
			for (const clause of node.heritageClauses ?? []) {
				for (const type of clause.types) {
					scan(type.expression);
				}
			}
			for (const member of node.members) {
				if (ts.canHaveDecorators(member)) {
					for (const decorator of ts.getDecorators(member) ?? []) {
						flagIfTracked(decorator, decorator.expression);
						scan(decorator.expression);
					}
				}
				if (member.name !== undefined && ts.isComputedPropertyName(member.name)) {
					scan(member.name.expression);
				}
				if (ts.isClassStaticBlockDeclaration(member)) {
					scan(member.body);
				} else if (ts.isPropertyDeclaration(member) && isStatic(member) && member.initializer !== undefined) {
					scan(member.initializer);
				}
			}
			return;
		}
		if (
			ts.isArrowFunction(node) ||
			ts.isFunctionExpression(node) ||
			ts.isFunctionDeclaration(node) ||
			ts.isMethodDeclaration(node) ||
			ts.isGetAccessorDeclaration(node) ||
			ts.isSetAccessorDeclaration(node)
		) {
			return;
		}
		ts.forEachChild(node, scan);
	};

	// One pass: the tracked set was computed to its fixed point up front, so
	// evaluation-order tricks (loops calling before reassigning, aliases minted
	// after their call site) change nothing here.
	for (const statement of sourceFile.statements) {
		scan(statement);
	}
	return offenses;
}
