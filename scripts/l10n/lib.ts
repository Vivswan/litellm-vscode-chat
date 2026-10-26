/** Paths anchor on process.cwd(): package.json invokes these from the repo root. */
import fs from "node:fs/promises";
import path from "node:path";
import { getL10nJson, type l10nJsonFormat } from "@vscode/l10n-dev";
import ts from "typescript";
import { z } from "zod";

/** The English reference bundle: what extract writes and check re-derives. */
export const BUNDLE_PATH = path.join(process.cwd(), "l10n", "bundle.l10n.json");

/** The English bundle's values: a message, or one wrapped with translator comments; translated bundles stay flat. */
export const bundleSchema = z.record(
	z.string(),
	z.union([z.string(), z.object({ message: z.string(), comment: z.array(z.string()) })])
);

export type BundleFile = z.infer<typeof bundleSchema>;

/** Flat key-to-string tables (package.nls*.json, translated bundles): the webview bootstrap drops non-string values. */
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

/** Code-unit order, so the serialized bundle is stable; localeCompare would vary by locale. */
function compareKeys(left: string, right: string): number {
	if (left < right) {
		return -1;
	}
	if (left > right) {
		return 1;
	}
	return 0;
}

export async function extractBundle(): Promise<l10nJsonFormat> {
	const files = await readSourceFiles();
	const extracted = await getL10nJson(files.map(({ file, contents }) => ({ extension: path.extname(file), contents })));
	// Entries, not keys: the bun test project compiles this file under noUncheckedIndexedAccess, where a key lookup
	// reads as possibly undefined.
	return Object.fromEntries(Object.entries(extracted).sort(([left], [right]) => compareKeys(left, right)));
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

/**
 * A renaming specifier's alias, or undefined for a plain or type-only one. The propertyName may be a string literal
 * (`export { "a-b" as t }`); both carry .text.
 */
function aliasOf(element: ts.ImportSpecifier | ts.ExportSpecifier): AliasSpecifier | undefined {
	if (element.isTypeOnly || element.propertyName === undefined) {
		return undefined;
	}
	return { name: element.name.text, of: element.propertyName.text };
}

/** The aliases among a statement's specifiers. */
function aliasesOf(elements: readonly (ts.ImportSpecifier | ts.ExportSpecifier)[]): AliasSpecifier[] {
	const aliases: AliasSpecifier[] = [];
	for (const element of elements) {
		const alias = aliasOf(element);
		if (alias !== undefined) {
			aliases.push(alias);
		}
	}
	return aliases;
}

/** The renaming (aliased) import/export specifiers of one top-level statement; a plain re-export mints no new name. */
function aliasSpecifiers(statement: ts.Statement): AliasSpecifier[] {
	if (ts.isImportDeclaration(statement)) {
		const bindings = statement.importClause?.namedBindings;
		if (statement.importClause?.isTypeOnly === true || bindings === undefined || !ts.isNamedImports(bindings)) {
			return [];
		}
		return aliasesOf(bindings.elements);
	}
	if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.exportClause !== undefined) {
		return ts.isNamedExports(statement.exportClause) ? aliasesOf(statement.exportClause.elements) : [];
	}
	return [];
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
	/** The binding's name as call sites spell it; same-named bindings in other files share one entry after closure. */
	readonly name: string;

	/** A table is an object or array literal walked whole; reading into it reaches its thunks (TABLE[key]()). */
	readonly kind: "function" | "class" | "table" | "alias";

	/** The declaration (default parameters included) contains a direct l10n.t or vscode.l10n.t call. */
	readonly direct: boolean;

	/** Every bare-identifier call-site name inside the declaration; an alias of a name carries that name here. */
	readonly callees: ReadonlySet<string>;

	/** Roots of the member chains read; an alias of a chain (TEXTS.a, or a destructured off TEXTS) carries its root. */
	readonly reads: ReadonlySet<string>;
}

/**
 * What a walk of one declaration found, before it becomes a Binding. `thisMembers` are the members read or called on
 * `this`: a constructor's path into the class's own methods.
 */
interface InvocationEvidence {
	direct: boolean;
	readonly callees: Set<string>;
	readonly reads: Set<string>;
	readonly thisMembers: Set<string>;
}

function isStaticMember(member: ts.ClassElement): boolean {
	return (
		ts.canHaveModifiers(member) &&
		(ts.getModifiers(member) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)
	);
}

/** Parens and type wrappers do not change what evaluates; strip them so `(fn)()` and `fn as T` read as fn. */
export function unwrapExpression(node: ts.Expression): ts.Expression {
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

/** Per SourceFile, the local (relative-specifier) namespace-import names, computed once. */
const localNamespaceCache = new WeakMap<ts.SourceFile, ReadonlySet<string>>();

/**
 * The "." prefix is the locality test: a tsconfig `paths` alias or a package subpath would not resolve here. None exist
 * in shipped source, so the check is defensive, not load-bearing.
 */
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

/** The leaves a destructuring renames: a leaf selected by a key other than its own name is that key's alias. */
function renamedLeaves(names: readonly DestructuredName[]): AliasSpecifier[] {
	const aliases: AliasSpecifier[] = [];
	for (const { name, path } of names) {
		const selected = path[path.length - 1];
		if (selected !== undefined && selected !== name) {
			aliases.push({ name, of: selected });
		}
	}
	return aliases;
}

/** The first key of each leaf's path: the member a destructuring off `this` selects. */
function firstKeys(names: readonly DestructuredName[]): string[] {
	const keys: string[] = [];
	for (const { path } of names) {
		const [member] = path;
		if (member !== undefined) {
			keys.push(member);
		}
	}
	return keys;
}

/**
 * Off a local namespace import the first key is the root read (`{ TEXTS: { a } } = helpers` reads TEXTS as
 * `helpers.TEXTS.a` does), and a leaf selected by that key alone is its spelling alias and nothing more.
 */
function namespaceReads(names: readonly DestructuredName[]): AliasSpecifier[] {
	const reads: AliasSpecifier[] = [];
	for (const { name, path } of names) {
		const [member] = path;
		if (member !== undefined && path.length > 1) {
			reads.push({ name, of: member });
		}
	}
	return reads;
}

/** The edges one resolved value of the destructuring draws, added to `edges`. */
function addValueEdges(
	edges: DestructuringEdges,
	candidate: ts.Expression,
	names: readonly DestructuredName[],
	sourceFile: ts.SourceFile
): void {
	if (candidate.kind === ts.SyntaxKind.ThisKeyword) {
		edges.thisMembers.push(...firstKeys(names));
		return;
	}
	if (ts.isIdentifier(candidate) && localNamespaceImports(sourceFile).has(candidate.text)) {
		edges.reads.push(...namespaceReads(names));
		return;
	}
	const root = memberChainRoot(candidate, sourceFile);
	if (root !== undefined) {
		edges.reads.push(...names.map(({ name }) => ({ name, of: root })));
		return;
	}
	const literal = literalChainRoot(candidate);
	if (literal !== undefined) {
		edges.literals.push({ literal, names: names.map(({ name }) => name) });
	}
}

/** The edges a destructuring draws, for every value its right-hand side can hand over. */
function destructuringEdges(
	target: ts.Node,
	value: ts.Expression | undefined,
	sourceFile: ts.SourceFile
): DestructuringEdges {
	const names = destructuredNames(target);
	const edges: DestructuringEdges = { aliases: renamedLeaves(names), reads: [], literals: [], thisMembers: [] };
	for (const candidate of value === undefined ? [] : calleeCandidates(value, sourceFile)) {
		addValueEdges(edges, candidate, names, sourceFile);
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

/** The name a resolved callee is tracked by: a bare identifier's text, or a local namespace member's own name. */
function calleeName(candidate: ts.Expression, sourceFile: ts.SourceFile): string | undefined {
	if (ts.isIdentifier(candidate)) {
		return candidate.text;
	}
	return namespaceMemberName(candidate, sourceFile);
}

/**
 * A computed member call on a bare name or a local-namespace member: the member is unreadable, so the receiver carries
 * the edge (a lazy function's only meaningful members are its forwarders), resolved through the same pipeline so a
 * choosing receiver flattens. Literal keys resolve as members; a key on any other receiver stays the thunk-table
 * boundary.
 */
function noteComputedReceiver(
	evidence: InvocationEvidence,
	callee: ts.ElementAccessExpression,
	sourceFile: ts.SourceFile
): void {
	const key = unwrapExpression(callee.argumentExpression);
	if (ts.isStringLiteralLike(key)) {
		return;
	}
	for (const receiver of calleeCandidates(callee.expression, sourceFile)) {
		const name = calleeName(receiver, sourceFile);
		if (name !== undefined) {
			evidence.callees.add(name);
		}
	}
}

/** The edges a call's callee draws: a direct l10n.t, a tracked name, or a computed member call's receiver. */
function noteCallee(evidence: InvocationEvidence, calleeExpression: ts.Expression, sourceFile: ts.SourceFile): void {
	for (const callee of calleeCandidates(calleeExpression, sourceFile)) {
		const calleeText = callee.getText(sourceFile);
		if (calleeText === "l10n.t" || calleeText === "vscode.l10n.t") {
			evidence.direct = true;
			continue;
		}
		const name = calleeName(callee, sourceFile);
		if (name !== undefined) {
			evidence.callees.add(name);
			continue;
		}
		if (ts.isElementAccessExpression(callee)) {
			noteComputedReceiver(evidence, callee, sourceFile);
		}
	}
}

/** Every value a right-hand side can hand over, as callee edges: an alias's source is callable under the new name. */
function noteSources(evidence: InvocationEvidence, rhs: ts.Expression, sourceFile: ts.SourceFile): void {
	for (const source of calleeCandidates(rhs, sourceFile)) {
		const name = calleeName(source, sourceFile);
		if (name !== undefined) {
			evidence.callees.add(name);
		}
	}
}

/**
 * A member read or call alike: `SURFACE_COPY[surface]` handed back is as much a path to the thunks as calling one, so
 * the chain's root is read; a member of `this` is the class's own.
 */
function noteMemberRead(
	evidence: InvocationEvidence,
	node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
	sourceFile: ts.SourceFile
): void {
	const root = memberChainRoot(node, sourceFile);
	if (root !== undefined) {
		evidence.reads.add(root);
	}
	const read = memberNameOf(node);
	if (read !== undefined && unwrapExpression(read.object).kind === ts.SyntaxKind.ThisKeyword) {
		evidence.thisMembers.add(read.member);
	}
}

/**
 * The right-hand side a node binds to a name, where aliasing happens: a variable initializer or a default
 * (`wrap(title = manageCommandTitle)`, `{ title = ... } = {}`), an assignment, or an assignment pattern's shorthand
 * default, which is the same default without the `=` node (`({ title = helper } = x)`).
 */
function boundValueOf(node: ts.Node): ts.Expression | undefined {
	if (
		(ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) &&
		node.initializer !== undefined
	) {
		return node.initializer;
	}
	if (ts.isBinaryExpression(node) && isAssigningOperator(node.operatorToken.kind)) {
		return node.right;
	}
	if (ts.isShorthandPropertyAssignment(node) && node.objectAssignmentInitializer !== undefined) {
		return node.objectAssignmentInitializer;
	}
	return undefined;
}

/**
 * A destructuring aliases and reads like the member chains it stands for; a literal it selects out of sits inside the
 * roots this walk covers whole.
 */
function noteDestructuring(evidence: InvocationEvidence, node: ts.Node, sourceFile: ts.SourceFile): void {
	const destructured = destructuringOf(node);
	if (destructured === undefined) {
		return;
	}
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

/**
 * One node of the walk, then its children. An argument is the caller's edge, since the walk cannot see whether the
 * callee invokes it; an identifier nested in an array or object literal, or behind a spread, is a value in a structure,
 * the data-flow boundary.
 */
function digEvidence(evidence: InvocationEvidence, node: ts.Node, sourceFile: ts.SourceFile): void {
	if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
		noteCallee(evidence, node.expression, sourceFile);
		for (const argument of node.arguments ?? []) {
			noteSources(evidence, argument, sourceFile);
		}
	} else if (ts.isTaggedTemplateExpression(node)) {
		noteCallee(evidence, node.tag, sourceFile);
	} else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
		noteMemberRead(evidence, node, sourceFile);
	}
	const bound = boundValueOf(node);
	if (bound !== undefined) {
		noteSources(evidence, bound, sourceFile);
	}
	noteDestructuring(evidence, node, sourceFile);
	ts.forEachChild(node, (child) => digEvidence(evidence, child, sourceFile));
}

/**
 * The walk follows bound NAMES, never values in flight: following those would be data-flow analysis, which the gate
 * deliberately is not.
 */
function invocationEvidence(roots: readonly ts.Node[], sourceFile: ts.SourceFile): InvocationEvidence {
	const evidence: InvocationEvidence = { direct: false, callees: new Set(), reads: new Set(), thisMembers: new Set() };
	for (const root of roots) {
		digEvidence(evidence, root, sourceFile);
	}
	return evidence;
}

/** What `new` runs, and the instance members a constructor may reach through `this`, by the name it reaches them by. */
interface ConstructionRoots {
	readonly roots: ts.Node[];
	readonly byName: Map<string, ts.ClassElement[]>;
}

/**
 * What one member runs at `new`: a constructor's body and its whole parameters (a default nested in a destructuring
 * pattern evaluates at `new` too), or an instance property's initializer.
 */
function constructionRootsOf(member: ts.ClassElement): ts.Node[] {
	if (ts.isConstructorDeclaration(member)) {
		return member.body === undefined ? [...member.parameters] : [member.body, ...member.parameters];
	}
	if (ts.isPropertyDeclaration(member) && member.initializer !== undefined) {
		return [member.initializer];
	}
	return [];
}

/** The name `this` reaches a method or accessor by, or undefined for any other member or a name no literal spells. */
function reachableMemberKey(member: ts.ClassElement): string | undefined {
	if (!(ts.isMethodDeclaration(member) || ts.isAccessor(member)) || member.name === undefined) {
		return undefined;
	}
	return memberKey(member.name);
}

/**
 * The construction roots of every instance member. A static member runs at class definition, never at `new`; the
 * parser also accepts `static constructor()`, which the scanner still reads as the constructor.
 */
function constructionRoots(cls: ts.ClassLikeDeclaration): ConstructionRoots {
	const roots: ts.Node[] = [];
	const byName = new Map<string, ts.ClassElement[]>();
	for (const member of cls.members) {
		if (isStaticMember(member) && !ts.isConstructorDeclaration(member)) {
			continue;
		}
		roots.push(...constructionRootsOf(member));
		const key = reachableMemberKey(member);
		if (key !== undefined) {
			byName.set(key, [...(byName.get(key) ?? []), member]);
		}
	}
	return { roots, byName };
}

/** The instance members the constructor reaches through `this`, transitively, folded into the evidence. */
function reachThisMembers(
	evidence: InvocationEvidence,
	byName: ReadonlyMap<string, ts.ClassElement[]>,
	sourceFile: ts.SourceFile
): void {
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
}

/** A base resolves like a callee: choosing shapes flatten, and a local namespace member reads by member name. */
function noteHeritage(evidence: InvocationEvidence, cls: ts.ClassLikeDeclaration, sourceFile: ts.SourceFile): void {
	for (const clause of cls.heritageClauses ?? []) {
		for (const type of clause.types) {
			for (const base of calleeCandidates(type.expression, sourceFile)) {
				const name = calleeName(base, sourceFile);
				if (name !== undefined) {
					evidence.callees.add(name);
				}
			}
		}
	}
}

/**
 * A class's CONSTRUCTION-time localization evidence: what `new` runs, including every instance member the constructor
 * reaches through `this`. The roots are walked WHOLE, nested function literals included, so a registered callback or a
 * property-initialized thunk table counts even though neither RUNS at `new` - the inference's documented over-inclusion.
 */
function classConstructionEvidence(cls: ts.ClassLikeDeclaration, sourceFile: ts.SourceFile): InvocationEvidence {
	const { roots, byName } = constructionRoots(cls);
	const evidence = invocationEvidence(roots, sourceFile);
	reachThisMembers(evidence, byName, sourceFile);
	noteHeritage(evidence, cls, sourceFile);
	return evidence;
}

/** A binding of `name` to the evidence a walk found. */
function pushBinding(bindings: Binding[], name: string, kind: Binding["kind"], evidence: InvocationEvidence): void {
	bindings.push({ name, kind, direct: evidence.direct, callees: evidence.callees, reads: evidence.reads });
}

/** A name bound to another by spelling alone. */
function pushAlias(bindings: Binding[], alias: AliasSpecifier): void {
	bindings.push({ name: alias.name, kind: "alias", direct: false, callees: new Set([alias.of]), reads: new Set() });
}

/**
 * A name bound to a member chain reads into the chain's root: a thunk table's member is a thunk or another row, and the
 * closure keeps the alias a table so both stay reachable.
 */
function pushMemberAlias(bindings: Binding[], name: string, root: string): void {
	bindings.push({ name, kind: "alias", direct: false, callees: new Set(), reads: new Set([root]) });
}

function isFunctionLiteral(node: ts.Node): boolean {
	return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

/**
 * A local namespace import's member is the same alias by member name: `const t = helpers.title` binds `title`'s
 * laziness to t. Any other member chain binds the name to a read of its root, and a chain off a literal written in
 * place binds the name to that literal as a table.
 */
function bindMemberChain(bindings: Binding[], name: string, source: ts.Expression, sourceFile: ts.SourceFile): void {
	const member = namespaceMemberName(source, sourceFile);
	if (member !== undefined) {
		pushAlias(bindings, { name, of: member });
		return;
	}
	const root = memberChainRoot(source, sourceFile);
	if (root !== undefined) {
		pushMemberAlias(bindings, name, root);
		return;
	}
	const literal = literalChainRoot(source);
	if (literal !== undefined) {
		pushBinding(bindings, name, "table", invocationEvidence([literal], sourceFile));
	}
}

/**
 * One resolved value bound to `name`: a function literal, an IIFE (whatever it hands back is callable under this name,
 * so the whole initializer counts), a class, a table, a plain alias, or a member chain.
 */
function bindSource(bindings: Binding[], name: string, source: ts.Expression, sourceFile: ts.SourceFile): void {
	if (isFunctionLiteral(source)) {
		pushBinding(bindings, name, "function", invocationEvidence([source], sourceFile));
	} else if (ts.isCallExpression(source) && isFunctionLiteral(unwrapExpression(source.expression))) {
		pushBinding(bindings, name, "function", invocationEvidence([source], sourceFile));
	} else if (ts.isClassExpression(source)) {
		pushBinding(bindings, name, "class", classConstructionEvidence(source, sourceFile));
	} else if (ts.isObjectLiteralExpression(source) || ts.isArrayLiteralExpression(source)) {
		pushBinding(bindings, name, "table", invocationEvidence([source], sourceFile));
	} else if (ts.isIdentifier(source)) {
		pushAlias(bindings, { name, of: source.text });
	} else {
		bindMemberChain(bindings, name, source, sourceFile);
	}
}

/**
 * One binding of a name to a right-hand side, judged for EVERY value the RHS can hand over (calleeCandidates flattens
 * choosing shapes and strips forwarding to a fixed point, so `const t = helper.call` aliases helper).
 */
function bindValue(bindings: Binding[], name: string, rhs: ts.Expression, sourceFile: ts.SourceFile): void {
	for (const source of calleeCandidates(rhs, sourceFile)) {
		bindSource(bindings, name, source, sourceFile);
	}
}

/**
 * The name a node binds to a right-hand side by a plain identifier: a declaration, a default wherever it sits
 * (`const { title = lazyHelper } = {}`), an assignment, or an assignment pattern's shorthand default
 * (`({ title = lazyHelper } = x)`), which binds title like the declaration form does.
 */
function namedBindingOf(node: ts.Node): { readonly name: string; readonly rhs: ts.Expression } | undefined {
	if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
		return { name: node.name.text, rhs: node.initializer };
	}
	if (
		(ts.isBindingElement(node) || ts.isParameter(node)) &&
		ts.isIdentifier(node.name) &&
		node.initializer !== undefined
	) {
		return { name: node.name.text, rhs: node.initializer };
	}
	if (ts.isBinaryExpression(node) && isAssigningOperator(node.operatorToken.kind)) {
		const target = unwrapExpression(node.left);
		return ts.isIdentifier(target) ? { name: target.text, rhs: node.right } : undefined;
	}
	if (ts.isShorthandPropertyAssignment(node) && node.objectAssignmentInitializer !== undefined) {
		return { name: node.name.text, rhs: node.objectAssignmentInitializer };
	}
	return undefined;
}

/**
 * The bindings one node declares: a function or class by name, a named right-hand side, or the renaming specifiers of
 * a top-level statement, which bind a new local name to whatever they rename, so `new Renamed()` at module scope is the
 * same freeze as the original.
 */
function bindNode(bindings: Binding[], node: ts.Node, sourceFile: ts.SourceFile): void {
	if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
		pushBinding(bindings, node.name.text, "function", invocationEvidence([node], sourceFile));
		return;
	}
	if (ts.isClassDeclaration(node) && node.name !== undefined) {
		pushBinding(bindings, node.name.text, "class", classConstructionEvidence(node, sourceFile));
		return;
	}
	const bound = namedBindingOf(node);
	if (bound !== undefined) {
		bindValue(bindings, bound.name, bound.rhs, sourceFile);
		return;
	}
	if (!ts.isStatement(node)) {
		return;
	}
	for (const alias of aliasSpecifiers(node)) {
		pushAlias(bindings, alias);
	}
	const entityAlias = importEqualsAlias(node);
	if (entityAlias !== undefined) {
		pushAlias(bindings, entityAlias);
	}
}

/**
 * A destructuring's bindings: its renamed leaves as aliases, its reads as member aliases, and every leaf selected out
 * of a literal written in place as a table.
 */
function bindDestructuring(bindings: Binding[], node: ts.Node, sourceFile: ts.SourceFile): void {
	const destructured = destructuringOf(node);
	if (destructured === undefined) {
		return;
	}
	const edges = destructuringEdges(destructured.target, destructured.value, sourceFile);
	for (const alias of edges.aliases) {
		pushAlias(bindings, alias);
	}
	for (const read of edges.reads) {
		pushMemberAlias(bindings, read.name, read.of);
	}
	for (const { literal, names } of edges.literals) {
		const evidence = invocationEvidence([literal], sourceFile);
		for (const name of names) {
			pushBinding(bindings, name, "table", evidence);
		}
	}
}

/**
 * The walk: a node's own bindings, its destructuring (outside bindNode, since a destructured leaf may carry a default
 * that already binds), then its children.
 */
function visitBindings(bindings: Binding[], node: ts.Node, scope: "module" | "file", sourceFile: ts.SourceFile): void {
	bindNode(bindings, node, sourceFile);
	bindDestructuring(bindings, node, sourceFile);
	if (scope === "file" || !(ts.isFunctionLike(node) || ts.isClassLike(node))) {
		ts.forEachChild(node, (child) => visitBindings(bindings, child, scope, sourceFile));
	}
}

/**
 * Every binding of a name to localization evidence in one file. The module walk stops at function and class bodies,
 * whose declarations bind locals, not module names; the file walk crosses them, because the module-scope guard matches
 * by spelling wherever a name is bound (an alias inside an eager IIFE is called at module scope too).
 */
function collectBindings(sourceFile: ts.SourceFile, scope: "module" | "file"): Binding[] {
	const bindings: Binding[] = [];
	visitBindings(bindings, sourceFile, scope, sourceFile);
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

/** The kind a binding joins the lazy set as: a table, or an alias of one, hands out thunks; the rest are helpers. */
function lazyKindOf(binding: Binding, lazy: LazyL10nNames): LazyKind {
	const aliasOfTable =
		binding.kind === "alias" && [...binding.callees, ...binding.reads].some((name) => lazy.get(name) === "table");
	return binding.kind === "table" || aliasOfTable ? "table" : "helper";
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
			const kind = lazyKindOf(binding, lazy);
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

/** What recording an offense needs of a scan: the source its lines are counted in, and the lines found so far. */
export interface OffenseScan {
	readonly sourceFile: ts.SourceFile;
	readonly offenses: number[];
}

/** Records the 1-based line `node` starts on. */
export function flagOffense(scan: OffenseScan, node: ts.Node): void {
	scan.offenses.push(scan.sourceFile.getLineAndCharacterOfPosition(node.getStart(scan.sourceFile)).line + 1);
}

/**
 * One file's module-scope scan, with the names tracked as lazy once the file's own bindings closed over the tree-wide
 * inference.
 */
interface ModuleScan extends OffenseScan {
	readonly tracked: LazyL10nNames;
}

/**
 * A COMPUTED member call on a tracked name or a tracked local-namespace member: the key is unreadable and a lazy
 * function's only meaningful members are its forwarders; the receiver resolves through the same pipeline so a choosing
 * receiver flattens. Literal keys resolve as members, and ordinary member calls on a name that merely shares a lazy
 * spelling (`lastSync.toISOString()`) stay quiet.
 */
function computedReceiverTracked(scan: ModuleScan, callee: ts.ElementAccessExpression): boolean {
	const key = unwrapExpression(callee.argumentExpression);
	if (ts.isStringLiteralLike(key)) {
		return false;
	}
	for (const receiver of calleeCandidates(callee.expression, scan.sourceFile)) {
		const name = calleeName(receiver, scan.sourceFile);
		if (name !== undefined && scan.tracked.has(name)) {
			return true;
		}
	}
	return false;
}

/**
 * Whether a resolved callee is tracked: l10n.t itself, a tracked name or local-namespace member, or a computed member
 * call on one.
 */
function candidateIsTracked(scan: ModuleScan, candidate: ts.Expression): boolean {
	const callee = stripForwarding(candidate, scan.sourceFile);
	const calleeText = callee.getText(scan.sourceFile);
	if (calleeText === "l10n.t" || calleeText === "vscode.l10n.t" || scan.tracked.has(calleeText)) {
		return true;
	}
	const member = namespaceMemberName(callee, scan.sourceFile);
	if (member !== undefined && scan.tracked.has(member)) {
		return true;
	}
	return ts.isElementAccessExpression(callee) && computedReceiverTracked(scan, callee);
}

/**
 * The caller-side forwarders invoke what they are handed: stripping Reflect.apply / Function.prototype.call/apply
 * leaves their bare receivers, and Reflect.construct strips nothing. Matching is by TEXT, so
 * `globalThis.Reflect.apply` or a rebound `const R = Reflect` stays quiet - deliberate obfuscation, left outside
 * like every custom wrapper, because treating arbitrary arguments as callees would contradict the sanctioned
 * `register(helper)` reference pattern.
 */
function isCallerForwarder(sourceFile: ts.SourceFile, candidate: ts.Expression): boolean {
	const stripped = stripForwarding(candidate, sourceFile);
	const strippedText = stripped.getText(sourceFile);
	return (
		strippedText === "Reflect.construct" ||
		(stripped !== candidate && (strippedText === "Reflect" || strippedText === "Function.prototype"))
	);
}

/**
 * Whether the callee resolves to a recognized forwarder anywhere in its resolution TRACE: the resolved forms erase the
 * forwarding spelling that identifies one, so detection reads the whole trace.
 */
function forwardsThroughCaller(scan: ModuleScan, calleeExpression: ts.Expression): boolean {
	return resolutionTrace(calleeExpression, scan.sourceFile).some((candidate) =>
		isCallerForwarder(scan.sourceFile, candidate)
	);
}

function flagInlineClass(scan: ModuleScan, node: ts.Node, cls: ts.ClassExpression): void {
	if (reachesLazy(classConstructionEvidence(cls, scan.sourceFile), scan.tracked)) {
		flagOffense(scan, node);
	}
}

/**
 * Whether any argument of a recognized forwarder resolves to a tracked callee: EVERY argument, not just the first
 * (`Reflect.apply.call(...)` shifts its target one slot right), since a tracked name has no business in any forwarder
 * slot at module scope.
 */
function forwardsTracked(scan: ModuleScan, args: readonly ts.Expression[]): boolean {
	for (const argument of args) {
		for (const target of calleeCandidates(argument, scan.sourceFile)) {
			if (candidateIsTracked(scan, target)) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Flags a call-like node whose callee resolves to a tracked name, or a recognized forwarder handed one.
 * calleeCandidates resolves the callee to a fixed point, so no choosing shape, paren, type wrapper, or
 * .call/.apply/.bind link - however nested - may launder a freeze past this match.
 */
function flagIfTracked(
	scan: ModuleScan,
	node: ts.Node,
	calleeExpression: ts.Expression,
	args?: readonly ts.Expression[]
): void {
	for (const candidate of calleeCandidates(calleeExpression, scan.sourceFile)) {
		if (candidateIsTracked(scan, candidate)) {
			flagOffense(scan, node);
			return;
		}
	}
	if (args !== undefined && forwardsThroughCaller(scan, calleeExpression) && forwardsTracked(scan, args)) {
		flagOffense(scan, node);
	}
}

/**
 * A function invoked ON THE SPOT evaluates its parameter defaults as well as its body, whether a call or a template tag
 * runs it. The whole parameter, not just its initializer: a default nested in a destructuring pattern evaluates with
 * the invocation too.
 */
function scanInvoked(scan: ModuleScan, invoked: ts.ArrowFunction | ts.FunctionExpression): void {
	for (const parameter of invoked.parameters) {
		scanNode(scan, parameter);
	}
	scanNode(scan, invoked.body);
}

/**
 * Every inline function a callee can resolve to: a plain branch, one under forwarding (`(fn).call(...)`), or one
 * behind a computed member read (`(fn)[key]()` invokes some member of fn - its forwarders in practice), the receiver
 * resolved through the same pipeline.
 */
function scanInvokedCandidates(scan: ModuleScan, expression: ts.Expression): void {
	for (const candidate of calleeCandidates(expression, scan.sourceFile)) {
		if (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate)) {
			scanInvoked(scan, candidate);
			continue;
		}
		if (!ts.isElementAccessExpression(candidate)) {
			continue;
		}
		for (const receiver of calleeCandidates(candidate.expression, scan.sourceFile)) {
			if (ts.isArrowFunction(receiver) || ts.isFunctionExpression(receiver)) {
				scanInvoked(scan, receiver);
			}
		}
	}
}

/** A recognized forwarder's arguments evaluate its inline function and class targets as a direct call would. */
function scanForwardedTargets(scan: ModuleScan, node: ts.CallExpression): void {
	if (!forwardsThroughCaller(scan, node.expression)) {
		return;
	}
	for (const argument of node.arguments) {
		for (const target of calleeCandidates(argument, scan.sourceFile)) {
			if (ts.isArrowFunction(target) || ts.isFunctionExpression(target)) {
				scanInvoked(scan, target);
			} else if (ts.isClassExpression(target)) {
				flagInlineClass(scan, node, target);
			}
		}
	}
}

/**
 * A call: its callee flagged if tracked; a function literal in ANY branch of the callee evaluates eagerly when that
 * branch is picked, however deep choosing shapes and forwarding nest, and a computed member call on an inline function
 * evaluates it too; then the callee and the arguments themselves.
 */
function scanCall(scan: ModuleScan, node: ts.CallExpression): void {
	flagIfTracked(scan, node, node.expression, node.arguments);
	scanInvokedCandidates(scan, node.expression);
	scanForwardedTargets(scan, node);
	scanNode(scan, node.expression);
	for (const argument of node.arguments) {
		scanNode(scan, argument);
	}
}

/**
 * A `new` runs its callee like a call. Constructing an INLINE class runs its constructor, parameter defaults, and
 * instance property initializers on the spot, and extends invokes the base constructor - in ANY callee branch; an
 * inline FUNCTION constructed with new runs its body the same way.
 */
function scanNew(scan: ModuleScan, node: ts.NewExpression): void {
	flagIfTracked(scan, node, node.expression, node.arguments);
	for (const candidate of calleeCandidates(node.expression, scan.sourceFile)) {
		if (ts.isClassExpression(candidate)) {
			flagInlineClass(scan, node, candidate);
		} else if (ts.isFunctionExpression(candidate)) {
			scanInvoked(scan, candidate);
		}
	}
	scanNode(scan, node.expression);
	for (const argument of node.arguments ?? []) {
		scanNode(scan, argument);
	}
}

/**
 * A decorator: a bare name invokes that name at definition time; a factory decorator is a call the walk flags by its
 * own callee.
 */
function scanDecorators(scan: ModuleScan, node: ts.HasDecorators): void {
	for (const decorator of ts.getDecorators(node) ?? []) {
		flagIfTracked(scan, decorator, decorator.expression);
		scanNode(scan, decorator.expression);
	}
}

/** One member at definition time: its decorators, a computed name, a static block's body, a static initializer. */
function scanClassMember(scan: ModuleScan, member: ts.ClassElement): void {
	if (ts.canHaveDecorators(member)) {
		scanDecorators(scan, member);
	}
	if (member.name !== undefined && ts.isComputedPropertyName(member.name)) {
		scanNode(scan, member.name.expression);
	}
	if (ts.isClassStaticBlockDeclaration(member)) {
		scanNode(scan, member.body);
	} else if (ts.isPropertyDeclaration(member) && isStaticMember(member) && member.initializer !== undefined) {
		scanNode(scan, member.initializer);
	}
}

/** A class runs at definition: its decorators, its heritage expressions, and each member's definition-time parts. */
function scanClass(scan: ModuleScan, node: ts.ClassDeclaration | ts.ClassExpression): void {
	scanDecorators(scan, node);
	for (const clause of node.heritageClauses ?? []) {
		for (const type of clause.types) {
			scanNode(scan, type.expression);
		}
	}
	for (const member of node.members) {
		scanClassMember(scan, member);
	}
}

/**
 * The module-scope walk. A call, a tagged template (its tag runs, tag-IIFE included), and a `new` are module-load
 * invocations; a class runs at definition; a function body does not run until called, so the walk stops at every
 * function-like node.
 */
function scanNode(scan: ModuleScan, node: ts.Node): void {
	if (ts.isCallExpression(node)) {
		scanCall(scan, node);
		return;
	}
	if (ts.isTaggedTemplateExpression(node)) {
		flagIfTracked(scan, node, node.tag);
		scanInvokedCandidates(scan, node.tag);
		scanNode(scan, node.tag);
		scanNode(scan, node.template);
		return;
	}
	if (ts.isNewExpression(node)) {
		scanNew(scan, node);
		return;
	}
	if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
		scanClass(scan, node);
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
	ts.forEachChild(node, (child) => scanNode(scan, child));
}

/**
 * A module-scope localization call runs before l10n.config and freezes the English text. `shared` is the tree-wide
 * inference; the file's own bindings close over it so a name bound anywhere in the file, however renamed or
 * reconstructed, matches by spelling. A destructured `t` is invisible to the text match here; vscodeL10nOffenses bans
 * destructuring off the canonical l10n binding.
 */
export function moduleScopeL10nOffenses(contents: string, fileName: string, shared: LazyL10nNames): number[] {
	const sourceFile = parseSource(fileName, contents);
	const scan: ModuleScan = {
		sourceFile,
		tracked: closeLazyNames(collectBindings(sourceFile, "file"), shared),
		offenses: [],
	};
	// One pass: the tracked set was computed to its fixed point up front, so evaluation-order tricks (loops calling
	// before reassigning, aliases minted after their call site) change nothing here.
	for (const statement of sourceFile.statements) {
		scanNode(scan, statement);
	}
	return scan.offenses;
}
