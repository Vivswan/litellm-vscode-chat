/** Paths anchor on process.cwd(): package.json invokes these from the repo root. */
import fs from "node:fs/promises";
import path from "node:path";
import { getL10nJson, type l10nJsonFormat } from "@vscode/l10n-dev";
import ts from "typescript";
import { z } from "zod";

/** The English reference bundle: what extract writes and check re-derives. */
export const BUNDLE_PATH = path.join(process.cwd(), "l10n", "bundle.l10n.json");

/**
 * The generated English bundle's values: a message, optionally wrapped with translator comments. Translated bundles are
 * NOT allowed the wrapped shape (check.ts parses them with nlsSchema; the webview bootstrap drops non-string values
 * wholesale).
 */
export const bundleSchema = z.record(
	z.string(),
	z.union([z.string(), z.object({ message: z.string(), comment: z.array(z.string()) })])
);

export type BundleFile = z.infer<typeof bundleSchema>;

/** Flat key-to-string tables: package.nls*.json and translated bundle.l10n.<locale>.json. */
export const nlsSchema = z.record(z.string(), z.string());

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

export async function extractBundle(): Promise<l10nJsonFormat> {
	const files = await readSourceFiles();
	const extracted = await getL10nJson(files.map(({ file, contents }) => ({ extension: path.extname(file), contents })));
	// Entries, not keys: the bun test project compiles this file under noUncheckedIndexedAccess, where a key lookup
	// reads as possibly undefined.
	return Object.fromEntries(
		Object.entries(extracted).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
	);
}

/** The bundle's on-disk form; one serializer so extract and check cannot disagree. */
export function serializeBundle(bundle: l10nJsonFormat): string {
	return `${JSON.stringify(bundle, null, "\t")}\n`;
}

/** A renaming import/export specifier's minted name and the name it stands for. */
interface AliasSpecifier {
	readonly name: string;
	readonly of: string;
}

/** The renaming (aliased) import/export specifiers of one top-level statement; a plain re-export mints no new name. */
function aliasSpecifiers(statement: ts.Statement): AliasSpecifier[] {
	const aliases: AliasSpecifier[] = [];
	if (ts.isImportDeclaration(statement)) {
		const bindings = statement.importClause?.namedBindings;
		if (statement.importClause?.isTypeOnly !== true && bindings !== undefined && ts.isNamedImports(bindings)) {
			for (const element of bindings.elements) {
				if (!element.isTypeOnly && element.propertyName !== undefined) {
					aliases.push({ name: element.name.text, of: element.propertyName.text });
				}
			}
		}
	} else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.exportClause !== undefined) {
		if (ts.isNamedExports(statement.exportClause)) {
			for (const element of statement.exportClause.elements) {
				// The propertyName may be a string literal (`export { "a-b" as t }`); both carry .text.
				if (!element.isTypeOnly && element.propertyName !== undefined) {
					aliases.push({ name: element.name.text, of: element.propertyName.text });
				}
			}
		}
	}
	return aliases;
}

/**
 * `import t = a.b.c` (and its exported form) minted under a new name: an entity alias the specifier walk cannot see.
 * `import x = require(...)` names no binding to follow, so it yields nothing.
 */
function importEqualsAlias(statement: ts.Statement): AliasSpecifier | undefined {
	if (!ts.isImportEqualsDeclaration(statement) || statement.isTypeOnly) {
		return undefined;
	}
	let entity = statement.moduleReference;
	while (ts.isQualifiedName(entity)) {
		entity = entity.right;
	}
	return ts.isIdentifier(entity) ? { name: statement.name.text, of: entity.text } : undefined;
}

/**
 * The names whose invocation resolves l10n.t, closed over every file, each with its kind: the input the module-scope
 * guard matches call sites against. Matching is by call-site name, so one entry covers same-named bindings in every
 * file.
 */
export type LazyL10nNames = ReadonlyMap<string, LazyKind>;

/** A table is a structure handing out thunks: a member READ of one carries the edge a call would. */
type LazyKind = "helper" | "table";

/** One binding of a name to localization evidence, before the closure. */
interface Binding {
	readonly name: string;
	/**
	 * A table is an object or array literal walked whole: its thunks run later, exactly like a class's deferred members,
	 * and reading into it is how a resolver reaches them (`TABLE[key]()`, `TABLE[key].surface()`).
	 */
	readonly kind: "function" | "class" | "table" | "alias";
	/** The declaration (default parameters included) contains a direct l10n.t or vscode.l10n.t call. */
	readonly direct: boolean;
	/** Every bare-identifier call-site name inside the declaration; an alias of a name carries that name here. */
	readonly callees: ReadonlySet<string>;
	/**
	 * The root names of the member chains the declaration reads into; an alias of a member chain (`TEXTS.a`, or `a`
	 * destructured off TEXTS) carries the chain's root here.
	 */
	readonly reads: ReadonlySet<string>;
}

interface InvocationEvidence {
	direct: boolean;
	readonly callees: Set<string>;
	readonly reads: Set<string>;
	/** The members read or called on `this`: a constructor's path into the class's own methods. */
	readonly thisMembers: Set<string>;
}

function isStaticMember(member: ts.ClassElement): boolean {
	return (
		ts.canHaveModifiers(member) &&
		(ts.getModifiers(member) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)
	);
}

/** The text a literal key spells: `"render"` and `0` match the member they name, a variable key is unreadable. */
function literalKeyText(key: ts.Expression): string | undefined {
	const literal = unwrapExpression(key);
	return ts.isStringLiteralLike(literal) || ts.isNumericLiteral(literal) ? literal.text : undefined;
}

/** The name a class member is reached by through `this`: `["render"]()` is reached as `render`. */
function memberKey(name: ts.PropertyName): string | undefined {
	return ts.isComputedPropertyName(name) ? literalKeyText(name.expression) : name.text;
}

/**
 * Assignment operators that hand their right side to the left-hand name: plain `=` and the logical compounds, which
 * assign conditionally and so can bind a lazy helper exactly like a ternary branch.
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

function memberNameOf(node: ts.Expression): { readonly object: ts.Expression; readonly member: string } | undefined {
	if (ts.isPropertyAccessExpression(node)) {
		return { object: node.expression, member: node.name.text };
	}
	if (ts.isElementAccessExpression(node)) {
		const member = literalKeyText(node.argumentExpression);
		if (member !== undefined) {
			return { object: node.expression, member };
		}
	}
	return undefined;
}

/**
 * A local namespace import's member named `call`/`apply`/`bind` is that module's own export, not Function.prototype,
 * so stripping stops there. A receiver whose genuine method shares one of those names over-strips into a harmless
 * extra edge, and a bare `.bind` flags even uninvoked - deliberate conservatism; reference the helper plainly instead.
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
 * Local (relative-specifier) namespace-import names of one file, computed once per SourceFile. The "." prefix is the
 * locality test: a tsconfig `paths` alias or a package subpath would not resolve here (none exist in shipped source;
 * the check is defensive, not load-bearing).
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
 * The member name a member read resolves to when its object is a LOCAL namespace import: `helpers.title` (and
 * `helpers["title"]`) reads as `title`, joining the graph under the member's own name (matching stays by name, the
 * guard's rule). Package and builtin namespaces (`path.join`) resolve to nothing - their members are not lazy names -
 * and deeper chains (`helpers.sub.title`) stay outside.
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
 * The name a member chain reads into: the bare identifier at its root (`TABLE[key].surface` reads TABLE), or the member
 * a LOCAL namespace import is read at (`helpers.TABLE.x` reads TABLE, matching by name like a call). `this.x` and
 * `make().x` read no name.
 */
function memberChainRoot(node: ts.Expression, sourceFile: ts.SourceFile): string | undefined {
	let current = unwrapExpression(node);
	while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
		const member = namespaceMemberName(current, sourceFile);
		if (member !== undefined) {
			return member;
		}
		current = unwrapExpression(current.expression);
	}
	return ts.isIdentifier(current) ? current.text : undefined;
}

type LiteralTable = ts.ObjectLiteralExpression | ts.ArrayLiteralExpression;

/**
 * The literal a member chain selects out of when the table is written in place: `{ a: thunk }.a` and `[thunk][0]`
 * select out of the literal itself (a bare literal is its own root). The whole literal is the evidence, as it is for a
 * name bound to one.
 */
function literalChainRoot(node: ts.Expression): LiteralTable | undefined {
	let current = unwrapExpression(node);
	while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
		current = unwrapExpression(current.expression);
	}
	return ts.isObjectLiteralExpression(current) || ts.isArrayLiteralExpression(current) ? current : undefined;
}

/**
 * A name a destructuring binds, with the keys selecting it from the value: `{ TEXTS: { a: label } }` binds label at
 * [TEXTS, a].
 */
interface DestructuredName {
	readonly name: string;
	readonly path: readonly string[];
}

/**
 * The names a destructuring target binds, nested targets flattened: a binding pattern (a declaration or parameter) or
 * the object/array literal an assignment destructures into. A default (`{ a = x }`, `[a = x]`) binds its left side; a
 * rest or an unreadable computed key selects nothing, so its name sits at the parent's path; a member target
 * (`[obj.x] = ...`) binds no name.
 */
function destructuredNames(target: ts.Node, path: readonly string[] = []): DestructuredName[] {
	const names: DestructuredName[] = [];
	const bound = (node: ts.Node, key: string | undefined): void => {
		const at = key === undefined ? path : [...path, key];
		const value = ts.isExpression(node) ? unwrapExpression(node) : node;
		if (ts.isIdentifier(value)) {
			names.push({ name: value.text, path: at });
		} else if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
			bound(value.left, key);
		} else {
			names.push(...destructuredNames(value, at));
		}
	};
	if (ts.isObjectBindingPattern(target) || ts.isArrayBindingPattern(target)) {
		const selects = (element: ts.BindingElement, index: number): string | undefined => {
			if (element.dotDotDotToken !== undefined) {
				return undefined;
			}
			if (element.propertyName !== undefined) {
				return memberKey(element.propertyName);
			}
			// A shorthand `{ a }` selects its own name; an array element its position.
			return ts.isIdentifier(element.name) ? element.name.text : String(index);
		};
		target.elements.forEach((element, index) => {
			if (!ts.isOmittedExpression(element)) {
				bound(element.name, selects(element, index));
			}
		});
	} else if (ts.isObjectLiteralExpression(target)) {
		for (const property of target.properties) {
			if (ts.isPropertyAssignment(property)) {
				bound(property.initializer, memberKey(property.name));
			} else if (ts.isShorthandPropertyAssignment(property)) {
				bound(property.name, property.name.text);
			} else if (ts.isSpreadAssignment(property)) {
				bound(property.expression, undefined);
			}
		}
	} else if (ts.isArrayLiteralExpression(target)) {
		target.elements.forEach((element, index) => {
			if (ts.isSpreadElement(element)) {
				bound(element.expression, undefined);
			} else if (!ts.isOmittedExpression(element)) {
				bound(element, String(index));
			}
		});
	}
	return names;
}

interface DestructuringEdges {
	/** A renamed leaf and the key it selects, by spelling: `{ label: localized }` is `label` under a new name. */
	readonly aliases: AliasSpecifier[];
	/** A leaf and the name whose member chain it reads into: `{ a } = TEXTS` reads TEXTS exactly as `TEXTS.a` does. */
	readonly reads: AliasSpecifier[];
	/** A table written in place and every leaf selected out of it, each carrying the whole literal as evidence. */
	readonly literals: { readonly literal: LiteralTable; readonly names: string[] }[];
	/** The members selected off `this`: `const { render: label } = this` reaches render as `this.render` does. */
	readonly thisMembers: string[];
}

/**
 * The edges a destructuring draws. Off a local namespace import the first key is the root read (`{ TEXTS: { a } } =
 * helpers` reads TEXTS as `helpers.TEXTS.a` does), and a leaf selected by that key alone is its spelling alias and
 * nothing more.
 */
function destructuringEdges(
	target: ts.Node,
	value: ts.Expression | undefined,
	sourceFile: ts.SourceFile
): DestructuringEdges {
	const names = destructuredNames(target);
	const edges: DestructuringEdges = { aliases: [], reads: [], literals: [], thisMembers: [] };
	for (const { name, path } of names) {
		const selected = path[path.length - 1];
		if (selected !== undefined && selected !== name) {
			edges.aliases.push({ name, of: selected });
		}
	}
	for (const candidate of value === undefined ? [] : calleeCandidates(value, sourceFile)) {
		if (candidate.kind === ts.SyntaxKind.ThisKeyword) {
			for (const [member] of names.map(({ path }) => path)) {
				if (member !== undefined) {
					edges.thisMembers.push(member);
				}
			}
			continue;
		}
		if (ts.isIdentifier(candidate) && localNamespaceImports(sourceFile).has(candidate.text)) {
			for (const { name, path } of names) {
				const [member] = path;
				if (member !== undefined && path.length > 1) {
					edges.reads.push({ name, of: member });
				}
			}
			continue;
		}
		const root = memberChainRoot(candidate, sourceFile);
		if (root !== undefined) {
			for (const { name } of names) {
				edges.reads.push({ name, of: root });
			}
			continue;
		}
		const literal = literalChainRoot(candidate);
		if (literal !== undefined) {
			edges.literals.push({ literal, names: names.map(({ name }) => name) });
		}
	}
	return edges;
}

/**
 * A destructuring with the value it reads from, where one is written: a declaration or parameter whose name is a
 * pattern (the value optional, a bare parameter pattern still renames), an element carrying its own default, or an
 * assignment into an object or array literal.
 */
function destructuringOf(
	node: ts.Node
): { readonly target: ts.Node; readonly value: ts.Expression | undefined } | undefined {
	if (
		(ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) &&
		(ts.isObjectBindingPattern(node.name) || ts.isArrayBindingPattern(node.name)) &&
		(!ts.isBindingElement(node) || node.initializer !== undefined)
	) {
		return { target: node.name, value: node.initializer };
	}
	if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
		const target = unwrapExpression(node.left);
		if (ts.isObjectLiteralExpression(target) || ts.isArrayLiteralExpression(target)) {
			return { target, value: node.right };
		}
	}
	return undefined;
}

/**
 * Every intermediate form the resolution visits - branch flattening and forwarding stripping interleaved to a FIXED
 * POINT, each candidate recorded BEFORE its strip. Stripping can expose a fresh choosing shape underneath (`(flag ?
 * helper : plain).call(...)`), and a branch can expose fresh forwarding, so the two interleave until stable.
 *
 *   both steps strictly descend; the seen set covers repeats -> Terminates
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
 * The walk follows bound NAMES, never values in flight: following those would be data-flow analysis, which the gate
 * deliberately is not.
 */
function invocationEvidence(roots: readonly ts.Node[], sourceFile: ts.SourceFile): InvocationEvidence {
	const evidence: InvocationEvidence = { direct: false, callees: new Set(), reads: new Set(), thisMembers: new Set() };
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
			// A computed member call on a bare name or a local-namespace member: the member is unreadable, so the
			// receiver carries the edge (a lazy function's only meaningful members are its forwarders), resolved
			// through the same pipeline so a choosing receiver flattens. Literal keys resolved above; a key on any
			// other receiver stays the thunk-table boundary.
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
	// An argument is the caller's edge, since the walk cannot see whether the callee invokes it. An identifier nested in
	// an array or object literal, or behind a spread, is a value in a structure - the data-flow boundary.
	const noteDirectArgumentEdges = (args: readonly ts.Expression[] | undefined): void => {
		for (const argument of args ?? []) {
			noteAliasSources(argument);
		}
	};
	const dig = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) {
			note(node.expression);
			noteDirectArgumentEdges(node.arguments);
		} else if (ts.isTaggedTemplateExpression(node)) {
			note(node.tag);
		} else if (ts.isNewExpression(node)) {
			note(node.expression);
			noteDirectArgumentEdges(node.arguments);
		} else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
			// Read or called alike: `SURFACE_COPY[surface]` handed back is as much a path to the thunks as calling one.
			const root = memberChainRoot(node, sourceFile);
			if (root !== undefined) {
				evidence.reads.add(root);
			}
			const read = memberNameOf(node);
			if (read !== undefined && unwrapExpression(read.object).kind === ts.SyntaxKind.ThisKeyword) {
				evidence.thisMembers.add(read.member);
			}
		}
		// A default aliases exactly like a variable initializer does, wherever it binds: `wrap(title =
		// manageCommandTitle)` and `{ title = ... } = {}`.
		if (
			(ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) &&
			node.initializer !== undefined
		) {
			noteAliasSources(node.initializer);
		}
		if (ts.isBinaryExpression(node) && isAssigningOperator(node.operatorToken.kind)) {
			noteAliasSources(node.right);
		}
		// An assignment pattern's shorthand default is the same default without the `=` node: `({ title = helper } = x)`.
		if (ts.isShorthandPropertyAssignment(node) && node.objectAssignmentInitializer !== undefined) {
			noteAliasSources(node.objectAssignmentInitializer);
		}
		// A destructuring aliases and reads like the member chains it stands for; a literal it selects out of sits
		// inside the roots this walk covers whole.
		const destructured = destructuringOf(node);
		if (destructured !== undefined) {
			const edges = destructuringEdges(destructured.target, destructured.value, sourceFile);
			for (const alias of edges.aliases) {
				evidence.callees.add(alias.of);
			}
			for (const read of edges.reads) {
				evidence.reads.add(read.of);
			}
			for (const member of edges.thisMembers) {
				evidence.thisMembers.add(member);
			}
		}
		ts.forEachChild(node, dig);
	};
	for (const root of roots) {
		dig(root);
	}
	return evidence;
}

/**
 * A class's CONSTRUCTION-time localization evidence: what `new` runs, including every instance member the constructor
 * reaches through `this`. The roots are walked WHOLE, nested function literals included, so a registered callback or a
 * property-initialized thunk table counts even though neither RUNS at `new` - the inference's documented over-inclusion.
 */
function classConstructionEvidence(cls: ts.ClassLikeDeclaration, sourceFile: ts.SourceFile): InvocationEvidence {
	const roots: ts.Node[] = [];
	const byName = new Map<string, ts.ClassElement[]>();
	for (const member of cls.members) {
		if (ts.isConstructorDeclaration(member)) {
			if (member.body !== undefined) {
				roots.push(member.body);
			}
			// The whole parameter: a default nested in a destructuring pattern evaluates at `new` too.
			roots.push(...member.parameters);
		} else if (isStaticMember(member)) {
		} else if (ts.isPropertyDeclaration(member) && member.initializer !== undefined) {
			roots.push(member.initializer);
		} else if ((ts.isMethodDeclaration(member) || ts.isAccessor(member)) && member.name !== undefined) {
			const key = memberKey(member.name);
			if (key !== undefined) {
				byName.set(key, [...(byName.get(key) ?? []), member]);
			}
		}
	}
	const evidence = invocationEvidence(roots, sourceFile);
	const reached = new Set<string>();
	const pending = [...evidence.thisMembers];
	for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
		if (reached.has(name)) {
			continue;
		}
		reached.add(name);
		const found = invocationEvidence(byName.get(name) ?? [], sourceFile);
		evidence.direct ||= found.direct;
		for (const callee of found.callees) {
			evidence.callees.add(callee);
		}
		for (const read of found.reads) {
			evidence.reads.add(read);
		}
		pending.push(...found.thisMembers);
	}
	for (const clause of cls.heritageClauses ?? []) {
		for (const type of clause.types) {
			// A base resolves like a callee: choosing shapes flatten, and a local namespace member reads by member
			// name.
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
 * Every binding of a name to localization evidence in one file. The module walk stops at function and class bodies,
 * whose declarations bind locals, not module names; the file walk crosses them, because the module-scope guard matches
 * by spelling wherever a name is bound (an alias inside an eager IIFE is called at module scope too).
 */
function collectBindings(sourceFile: ts.SourceFile, scope: "module" | "file"): Binding[] {
	const bindings: Binding[] = [];
	const push = (name: string, kind: Binding["kind"], evidence: InvocationEvidence): void => {
		bindings.push({ name, kind, direct: evidence.direct, callees: evidence.callees, reads: evidence.reads });
	};
	const pushAlias = (alias: AliasSpecifier): void => {
		bindings.push({ name: alias.name, kind: "alias", direct: false, callees: new Set([alias.of]), reads: new Set() });
	};
	// A name bound to a member chain reads into the chain's root: a thunk table's member is a thunk or another row,
	// and the closure keeps the alias a table so both stay reachable.
	const pushMemberAlias = (name: string, root: string): void => {
		bindings.push({ name, kind: "alias", direct: false, callees: new Set(), reads: new Set([root]) });
	};
	const isFunctionLiteral = (node: ts.Node): boolean => ts.isArrowFunction(node) || ts.isFunctionExpression(node);
	// One binding of a name to a right-hand side, judged for EVERY value the RHS can hand over (calleeCandidates
	// flattens choosing shapes and strips forwarding to a fixed point, so `const t = helper.call` aliases helper).
	const bind = (name: string, rhs: ts.Expression): void => {
		for (const source of calleeCandidates(rhs, sourceFile)) {
			if (isFunctionLiteral(source)) {
				push(name, "function", invocationEvidence([source], sourceFile));
			} else if (ts.isCallExpression(source) && isFunctionLiteral(unwrapExpression(source.expression))) {
				// An IIFE-bound name: whatever it hands back is callable under this name, so the whole initializer
				// counts.
				push(name, "function", invocationEvidence([source], sourceFile));
			} else if (ts.isClassExpression(source)) {
				push(name, "class", classConstructionEvidence(source, sourceFile));
			} else if (ts.isObjectLiteralExpression(source) || ts.isArrayLiteralExpression(source)) {
				push(name, "table", invocationEvidence([source], sourceFile));
			} else if (ts.isIdentifier(source)) {
				pushAlias({ name, of: source.text });
			} else {
				// A local namespace import's member is the same alias by member name: `const t = helpers.title` binds
				// `title`'s laziness to t. Any other member chain binds the name to a read of its root.
				const member = namespaceMemberName(source, sourceFile);
				if (member !== undefined) {
					pushAlias({ name, of: member });
				} else {
					const root = memberChainRoot(source, sourceFile);
					const literal = root === undefined ? literalChainRoot(source) : undefined;
					if (root !== undefined) {
						pushMemberAlias(name, root);
					} else if (literal !== undefined) {
						push(name, "table", invocationEvidence([literal], sourceFile));
					}
				}
			}
		}
	};
	const visit = (node: ts.Node): void => {
		if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
			push(node.name.text, "function", invocationEvidence([node], sourceFile));
		} else if (ts.isClassDeclaration(node) && node.name !== undefined) {
			push(node.name.text, "class", classConstructionEvidence(node, sourceFile));
		} else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
			bind(node.name.text, node.initializer);
		} else if (
			(ts.isBindingElement(node) || ts.isParameter(node)) &&
			ts.isIdentifier(node.name) &&
			node.initializer !== undefined
		) {
			// A default binds a name to whatever it defaults TO, wherever it sits: `const { title = lazyHelper } = {}`.
			bind(node.name.text, node.initializer);
		} else if (ts.isBinaryExpression(node) && isAssigningOperator(node.operatorToken.kind)) {
			const target = unwrapExpression(node.left);
			if (ts.isIdentifier(target)) {
				bind(target.text, node.right);
			}
		} else if (ts.isShorthandPropertyAssignment(node) && node.objectAssignmentInitializer !== undefined) {
			// An assignment pattern's shorthand default: `({ title = lazyHelper } = x)` binds title like the declaration
			// form does.
			bind(node.name.text, node.objectAssignmentInitializer);
		} else if (ts.isStatement(node)) {
			// A renaming import/export specifier binds a new local name to whatever it renames, so `new Renamed()` at
			// module scope is the same freeze as the original.
			for (const alias of aliasSpecifiers(node)) {
				pushAlias(alias);
			}
			const entityAlias = importEqualsAlias(node);
			if (entityAlias !== undefined) {
				pushAlias(entityAlias);
			}
		}
		// Outside the chain above, since a destructured leaf may carry a default the chain already binds.
		const destructured = destructuringOf(node);
		if (destructured !== undefined) {
			const edges = destructuringEdges(destructured.target, destructured.value, sourceFile);
			for (const alias of edges.aliases) {
				pushAlias(alias);
			}
			for (const read of edges.reads) {
				pushMemberAlias(read.name, read.of);
			}
			for (const { literal, names } of edges.literals) {
				const evidence = invocationEvidence([literal], sourceFile);
				for (const name of names) {
					push(name, "table", evidence);
				}
			}
		}
		if (scope === "file" || !(ts.isFunctionLike(node) || ts.isClassLike(node))) {
			ts.forEachChild(node, visit);
		}
	};
	visit(sourceFile);
	return bindings;
}

/** The closure and the guard's inline-class check judge evidence here and nowhere else, so they cannot drift apart. */
function reachesLazy(evidence: Pick<Binding, "direct" | "callees" | "reads">, lazy: LazyL10nNames): boolean {
	return (
		evidence.direct ||
		[...evidence.callees].some((callee) => lazy.has(callee)) ||
		[...evidence.reads].some((read) => lazy.get(read) === "table")
	);
}

/**
 * The fixed point over the bindings. Over-inclusive by name on purpose: it marks by spelling, so a same-named
 * non-localizing binding elsewhere is marked too, and matching stays syntactic (a parameter sharing a lazy name taints
 * its function, the guard's own rule).
 */
function closeLazyNames(bindings: readonly Binding[], seed: LazyL10nNames): LazyL10nNames {
	const lazy = new Map(seed);
	for (let grew = true; grew; ) {
		grew = false;
		for (const binding of bindings) {
			if (!lazy.has(binding.name) && !reachesLazy(binding, lazy)) {
				continue;
			}
			const aliasOfTable =
				binding.kind === "alias" && [...binding.callees, ...binding.reads].some((name) => lazy.get(name) === "table");
			const kind: LazyKind = binding.kind === "table" || aliasOfTable ? "table" : "helper";
			const current = lazy.get(binding.name);
			// An alias of a table upgrades a helper to a table; nothing downgrades.
			if (current === undefined || (current === "helper" && kind === "table")) {
				lazy.set(binding.name, kind);
				grew = true;
			}
		}
	}
	return lazy;
}

function parseSource(file: string, contents: string): ts.SourceFile {
	const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	return ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, false, kind);
}

/**
 * Every top-level name in the tree whose invocation resolves l10n.t, inferred from the declarations themselves, so a
 * new helper is guarded the moment it is written. Every file joins the graph: one that never spells "l10n" can still be
 * a LINK in a lazy chain. eslint.config.ts bans default exports beside this, the one shape no name-following walk can
 * chase.
 */
export function inferLazyL10nNames(sources: readonly SourceFile[]): LazyL10nNames {
	const bindings: Binding[] = [];
	for (const { file, contents } of sources) {
		bindings.push(...collectBindings(parseSource(file, contents), "module"));
	}
	return closeLazyNames(bindings, new Map());
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
 * A module-scope localization call runs before l10n.config and freezes the English text. `shared` is the tree-wide
 * inference; the file's own bindings close over it so a name bound anywhere in the file, however renamed or
 * reconstructed, matches by spelling. A destructured `t` is invisible to the text match here; vscodeL10nOffenses bans
 * destructuring off the canonical l10n binding.
 */
export function moduleScopeL10nOffenses(contents: string, fileName: string, shared: LazyL10nNames): number[] {
	const sourceFile = parseSource(fileName, contents);
	const offenses: number[] = [];
	const tracked = closeLazyNames(collectBindings(sourceFile, "file"), shared);

	const unwrap = unwrapExpression;

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
		// A COMPUTED member call on a tracked name or a tracked local-namespace member: the key is unreadable and a
		// lazy function's only meaningful members are its forwarders; the receiver resolves through the same pipeline
		// so a choosing receiver flattens. Literal keys resolved above; ordinary member calls on a name that merely
		// shares a lazy spelling (`lastSync.toISOString()`) stay quiet.
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

	// The caller-side forwarders invoke what they are handed: stripping Reflect.apply / Function.prototype.call/apply
	// leaves their bare receivers, and Reflect.construct strips nothing. Matching is by TEXT, so
	// `globalThis.Reflect.apply` or a rebound `const R = Reflect` stays quiet - deliberate obfuscation, left outside
	// like every custom wrapper, because treating arbitrary arguments as callees would contradict the sanctioned
	// `register(helper)` reference pattern.
	const isCallerForwarder = (candidate: ts.Expression): boolean => {
		const stripped = stripForwarding(candidate, sourceFile);
		const strippedText = stripped.getText(sourceFile);
		return (
			strippedText === "Reflect.construct" ||
			(stripped !== candidate && (strippedText === "Reflect" || strippedText === "Function.prototype"))
		);
	};

	const flagInlineClass = (node: ts.Node, cls: ts.ClassExpression): void => {
		if (reachesLazy(classConstructionEvidence(cls, sourceFile), tracked)) {
			offenses.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
		}
	};

	const flagIfTracked = (node: ts.Node, calleeExpression: ts.Expression, args?: readonly ts.Expression[]): void => {
		// calleeCandidates resolves the callee to a fixed point, so no choosing shape, paren, type wrapper, or
		// .call/.apply/.bind link - however nested - may launder a freeze past this match.
		for (const candidate of calleeCandidates(calleeExpression, sourceFile)) {
			if (candidateIsTracked(candidate)) {
				offenses.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
				return;
			}
		}
		// EVERY argument of a recognized forwarder, not just the first: `Reflect.apply.call(...)` shifts its target one
		// slot right, and a tracked name has no business in any forwarder slot at module scope. Forwarder detection
		// reads the whole resolution TRACE - the resolved forms erase the forwarding spelling that identifies one.
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
	// A function invoked ON THE SPOT evaluates its parameter defaults as well as its body, whether a call or a template
	// tag runs it.
	const scanInvoked = (invoked: ts.ArrowFunction | ts.FunctionExpression): void => {
		// The whole parameter, not just its initializer: a default nested in a destructuring pattern evaluates with the
		// invocation too.
		for (const parameter of invoked.parameters) {
			scan(parameter);
		}
		scan(invoked.body);
	};
	// Every inline function a callee can resolve to: a plain branch, one under forwarding (`(fn).call(...)`), or one
	// behind a computed member read (`(fn)[key]()` invokes some member of fn - its forwarders in practice), the
	// receiver resolved through the same pipeline.
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
			// A function literal in ANY branch of the callee evaluates eagerly when that branch is picked, however deep
			// choosing shapes and forwarding nest; a computed member call on an inline function evaluates it too, and a
			// recognized forwarder's arguments evaluate its inline function and class targets the same way.
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
		// A tagged template runs its tag and a `new` runs its callee: both are module-load invocations exactly like a
		// call, tag-IIFE included.
		if (ts.isTaggedTemplateExpression(node)) {
			flagIfTracked(node, node.tag);
			scanInvokedCandidates(node.tag);
			scan(node.tag);
			scan(node.template);
			return;
		}
		if (ts.isNewExpression(node)) {
			flagIfTracked(node, node.expression, node.arguments);
			// Constructing an INLINE class runs its constructor, parameter defaults, and instance property initializers
			// on the spot, and extends invokes the base constructor - in ANY callee branch; an inline FUNCTION
			// constructed with new runs its body the same way.
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
				// A bare-name decorator invokes that name at class definition time; a factory decorator is a
				// CallExpression the scan below flags by its own callee.
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
				} else if (ts.isPropertyDeclaration(member) && isStaticMember(member) && member.initializer !== undefined) {
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

	// One pass: the tracked set was computed to its fixed point up front, so evaluation-order tricks (loops calling
	// before reassigning, aliases minted after their call site) change nothing here.
	for (const statement of sourceFile.statements) {
		scan(statement);
	}
	return offenses;
}
