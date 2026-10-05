/**
 * Two redaction boundaries, each with one sanctioned exit; an access or construction elsewhere skipped the pass and
 * is refused. A channel member or a vscode class is judged by the declaration a node resolves to, never by its name,
 * so a Map's clear() or a Set's `new` is not a hit; a prepared invocation has no class, so a literal is judged by the
 * member names it carries.
 *
 *   output channel      src/shared/logger.ts writes every line              -> the Logger's redaction covers all of them
 *                       src/extension.ts creates the channel                 -> the one createOutputChannel call
 *   model-facing exits  agentTools/wiring.ts's constructors take ModelFacing -> render.ts's modelFacing() covered the text
 *                       the consult tool's methods, the stream's text parts   -> EXIT_SITES exceptions with no pass
 *                       a tool's invoke/prepareInvocation return exit calls  -> nothing else reaches the host
 *
 * A tool is judged where it reaches the host, never where it is written: the value handed to lm.registerTool, a class
 * implementing LanguageModelTool, a value typed as one. Each exit member is followed to its declaration through
 * spreads, shorthand, identifiers, and fields; a member whose body is out of reach is refused, not passed.
 *
 * This check covers accidental omissions and analysis gaps: a model-facing tool result or invocation message
 * constructed outside the sanctioned exits (wiring.ts toolResult and preparedInvocation, and the consult tool's two
 * methods until #74) fails the build; deliberate hiding is out of scope.
 */
import * as path from "node:path";
import ts from "typescript";

export type Rule = "channel" | "construct" | "return" | "member";

export interface Judgment {
	/** Repository-relative, forward slashes. */
	readonly file: string;
	readonly line: number;
	readonly column: number;
	readonly rule: Rule;
	/** The channel member; the construct (`new LanguageModelTextPart`, `{ invocationMessage }`); `return in invoke`. */
	readonly shape: string;
	readonly allowed: boolean;
}

export interface RuleScan {
	readonly judgments: readonly Judgment[];
}

export interface BoundaryScan {
	readonly channel: RuleScan;
	readonly exits: RuleScan;
}

export const LOGGER_FILE = "src/shared/logger.ts";

/** The wiring site may only create the channel; a write there would skip the Logger like a write anywhere else. */
export const WIRING_FILE = "src/extension.ts";

/** Default-deny: a member vscode adds later is a write until it is listed here. */
export const NON_WRITING_MEMBERS: ReadonlySet<string> = new Set([
	"name",
	"show",
	"hide",
	"dispose",
	"logLevel",
	"onDidChangeLogLevel",
]);

const CHANNEL_INTERFACES: ReadonlySet<string> = new Set(["OutputChannel", "LogOutputChannel"]);

export interface ExitSite {
	readonly file: string;
	/** Absent: every function in the file. */
	readonly functions?: readonly string[];
	/** Absent: every construct. */
	readonly constructs?: ReadonlySet<string>;
}

/**
 * Where a tool result, a result part, or a prepared invocation may be built. The agent tools' two constructors take
 * ModelFacing only; the consult tool's own methods are its exit; the response stream relays the model's text parts and
 * builds no tool result.
 */
export const EXIT_SITES: readonly ExitSite[] = [
	{ file: "src/extension/features/agentTools/wiring.ts", functions: ["toolResult", "preparedInvocation"] },
	{ file: "src/extension/features/consultTool/wiring.ts", functions: ["prepareInvocation", "invoke"] },
	{ file: "src/provider/transport/streaming/processor.ts", constructs: new Set(["LanguageModelTextPart"]) },
];

/** The host's result and every part kind it accepts: a data part's text() factory carries text like a text part. */
const EXIT_CLASSES: ReadonlySet<string> = new Set([
	"LanguageModelToolResult",
	"LanguageModelTextPart",
	"LanguageModelPromptTsxPart",
	"LanguageModelDataPart",
]);

const PREPARED_MEMBERS: ReadonlySet<string> = new Set(["invocationMessage", "confirmationMessages"]);

const TOOL_INTERFACE = "LanguageModelTool";

const TOOL_REGISTRATION = "registerTool";

const TOOL_EXIT_MEMBERS: readonly string[] = ["invoke", "prepareInvocation"];

function isVscodeTypings(file: ts.SourceFile): boolean {
	return file.isDeclarationFile && /[\\/]@types[\\/]vscode[\\/]/.test(file.fileName);
}

function isChannelDeclaration(declaration: ts.Declaration): boolean {
	if (!isVscodeTypings(declaration.getSourceFile())) {
		return false;
	}
	if (ts.isFunctionDeclaration(declaration)) {
		return declaration.name?.text === "createOutputChannel";
	}
	const owner = declaration.parent;
	return ts.isInterfaceDeclaration(owner) && CHANNEL_INTERFACES.has(owner.name.text);
}

/** A key typed as plain string reaches no channel member, so only literal types (or a constraint to them) name one. */
function literalKeys(checker: ts.TypeChecker, key: ts.Expression): string[] {
	const declared = checker.getTypeAtLocation(key);
	const type = checker.getBaseConstraintOfType(declared) ?? declared;
	return (type.isUnion() ? type.types : [type]).flatMap((t) =>
		t.isStringLiteral() ? [t.value] : t.isNumberLiteral() ? [String(t.value)] : []
	);
}

function propertyKeys(checker: ts.TypeChecker, key: ts.PropertyName): string[] {
	if (ts.isComputedPropertyName(key)) {
		return literalKeys(checker, key.expression);
	}
	return ts.isPrivateIdentifier(key) ? [] : [key.text];
}

/** A getter is a member the host reads like a value, so `{ get invocationMessage() {...} }` names the member too. */
function literalPropertyKeys(checker: ts.TypeChecker, literal: ts.ObjectLiteralExpression): string[] {
	return literal.properties.flatMap((property) =>
		ts.isPropertyAssignment(property) ||
		ts.isShorthandPropertyAssignment(property) ||
		ts.isGetAccessorDeclaration(property)
			? propertyKeys(checker, property.name)
			: []
	);
}

interface MemberRead {
	readonly receiver: ts.Type;
	readonly keys: readonly string[];
}

function memberRead(checker: ts.TypeChecker, node: ts.Node): MemberRead | undefined {
	if (ts.isPropertyAccessExpression(node)) {
		return { receiver: checker.getTypeAtLocation(node.expression), keys: [node.name.text] };
	}
	if (ts.isElementAccessExpression(node)) {
		return {
			receiver: checker.getTypeAtLocation(node.expression),
			keys: literalKeys(checker, node.argumentExpression),
		};
	}
	if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
		const key = node.propertyName ?? node.name;
		if (ts.isObjectBindingPattern(key) || ts.isArrayBindingPattern(key)) {
			return undefined;
		}
		return { receiver: checker.getTypeAtLocation(node.parent), keys: propertyKeys(checker, key) };
	}
	if (
		ts.isObjectLiteralExpression(node) &&
		ts.isBinaryExpression(node.parent) &&
		node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
		node.parent.left === node
	) {
		return { receiver: checker.getTypeAtLocation(node.parent.right), keys: literalPropertyKeys(checker, node) };
	}
	return undefined;
}

function isChannelMember(checker: ts.TypeChecker, receiver: ts.Type, key: string): boolean {
	const type = checker.getNonNullableType(receiver);
	return (type.isUnion() ? type.types : [type]).some((t) =>
		t.getProperty(key)?.declarations?.some(isChannelDeclaration)
	);
}

/**
 * Reflection reaches every member by name at runtime, so a channel handed to Reflect is a write whatever the member.
 */
function reflectedOn(checker: ts.TypeChecker, node: ts.Node): string | undefined {
	if (!ts.isCallExpression(node)) {
		return undefined;
	}
	const declaration = checker.getResolvedSignature(node)?.declaration;
	const target = node.arguments[0];
	if (
		declaration === undefined ||
		target === undefined ||
		!ts.isFunctionDeclaration(declaration) ||
		declaration.name === undefined ||
		!declaration.getSourceFile().isDeclarationFile ||
		!ts.isModuleBlock(declaration.parent) ||
		declaration.parent.parent.name.text !== "Reflect"
	) {
		return undefined;
	}
	// appendLine is declared on OutputChannel, which LogOutputChannel extends, so it is the membership probe.
	return isChannelMember(checker, checker.getTypeAtLocation(target), "appendLine")
		? `Reflect.${declaration.name.text}`
		: undefined;
}

function channelMembersAt(checker: ts.TypeChecker, node: ts.Node): string[] {
	const reflected = reflectedOn(checker, node);
	if (reflected !== undefined) {
		return [reflected];
	}
	const read = memberRead(checker, node);
	return read === undefined ? [] : read.keys.filter((key) => isChannelMember(checker, read.receiver, key));
}

function isChannelAccessAllowed(file: string, member: string): boolean {
	return (
		NON_WRITING_MEMBERS.has(member) ||
		file === LOGGER_FILE ||
		(file === WIRING_FILE && member === "createOutputChannel")
	);
}

function exitClassOf(node: ts.Node | undefined): string | undefined {
	return node !== undefined &&
		ts.isClassDeclaration(node) &&
		node.name !== undefined &&
		isVscodeTypings(node.getSourceFile()) &&
		EXIT_CLASSES.has(node.name.text)
		? node.name.text
		: undefined;
}

interface Construct {
	/** The vscode class built, or PreparedToolInvocation for a literal carrying its members. */
	readonly kind: string;
	/** As reported: `new LanguageModelTextPart`, `LanguageModelDataPart.text`, `{ invocationMessage }`. */
	readonly shape: string;
}

/** Undefined when the node builds nothing the host shows the model. */
function constructAt(checker: ts.TypeChecker, node: ts.Node): Construct | undefined {
	if (ts.isNewExpression(node)) {
		const declarations = checker.getTypeAtLocation(node.expression).getSymbol()?.declarations ?? [];
		const kind = declarations.map(exitClassOf).find((found) => found !== undefined);
		return kind === undefined ? undefined : { kind, shape: `new ${kind}` };
	}
	if (ts.isCallExpression(node)) {
		const declaration = checker.getResolvedSignature(node)?.declaration;
		if (declaration === undefined || !ts.isMethodDeclaration(declaration) || !ts.isIdentifier(declaration.name)) {
			return undefined;
		}
		const kind = exitClassOf(declaration.parent);
		return kind === undefined ? undefined : { kind, shape: `${kind}.${declaration.name.text}` };
	}
	if (ts.isObjectLiteralExpression(node)) {
		const members = literalPropertyKeys(checker, node).filter((key) => PREPARED_MEMBERS.has(key));
		return members.length === 0 ? undefined : { kind: "PreparedToolInvocation", shape: `{ ${members.join(", ")} }` };
	}
	return undefined;
}

function enclosingFunctionName(node: ts.Node): string | undefined {
	let current: ts.Node | undefined = node.parent;
	while (current !== undefined) {
		if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) {
			return current.name !== undefined && ts.isIdentifier(current.name) ? current.name.text : undefined;
		}
		if (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) {
			const owner = current.parent;
			return (ts.isVariableDeclaration(owner) || ts.isPropertyAssignment(owner) || ts.isPropertyDeclaration(owner)) &&
				ts.isIdentifier(owner.name)
				? owner.name.text
				: undefined;
		}
		current = current.parent;
	}
	return undefined;
}

function isConstructAllowed(sites: readonly ExitSite[], file: string, node: ts.Node, construct: Construct): boolean {
	const site = sites.find((candidate) => candidate.file === file);
	if (site === undefined || (site.constructs !== undefined && !site.constructs.has(construct.kind))) {
		return false;
	}
	if (site.functions === undefined) {
		return true;
	}
	const owner = enclosingFunctionName(node);
	return owner !== undefined && site.functions.includes(owner);
}

function reachesToolInterface(checker: ts.TypeChecker, type: ts.Type, seen: Set<ts.Symbol> = new Set()): boolean {
	if (type.isUnionOrIntersection()) {
		return type.types.some((part) => reachesToolInterface(checker, part, seen));
	}
	const symbol = type.getSymbol();
	if (symbol === undefined || seen.has(symbol)) {
		return false;
	}
	seen.add(symbol);
	return (symbol.declarations ?? []).some((declaration) => {
		if (ts.isInterfaceDeclaration(declaration) && isVscodeTypings(declaration.getSourceFile())) {
			return declaration.name.text === TOOL_INTERFACE;
		}
		return (
			(ts.isInterfaceDeclaration(declaration) || ts.isClassLike(declaration)) &&
			(declaration.heritageClauses ?? []).some((clause) =>
				clause.types.some((heritage) => reachesToolInterface(checker, checker.getTypeAtLocation(heritage), seen))
			)
		);
	});
}

interface Registration {
	/** Absent when the arguments are spread or short: the tool value cannot be named, so the call is a dead end. */
	readonly tool: ts.Expression | undefined;
}

function registersTool(checker: ts.TypeChecker, node: ts.Node): Registration | undefined {
	if (!ts.isCallExpression(node)) {
		return undefined;
	}
	const declaration = checker.getResolvedSignature(node)?.declaration;
	if (
		declaration === undefined ||
		!ts.isFunctionDeclaration(declaration) ||
		declaration.name?.text !== TOOL_REGISTRATION ||
		!isVscodeTypings(declaration.getSourceFile())
	) {
		return undefined;
	}
	return { tool: node.arguments.some(ts.isSpreadElement) ? undefined : node.arguments[1] };
}

/**
 * The tool types a node brings to the host. A class is its instance type; a literal or an annotated initializer is
 * the value's own type, so spreads and inferred returns are followed where the interface alone would hide them.
 */
function toolTypesAt(checker: ts.TypeChecker, node: ts.Node): ts.Type[] {
	const registration = registersTool(checker, node);
	if (registration !== undefined) {
		return registration.tool === undefined ? [] : [checker.getTypeAtLocation(registration.tool)];
	}
	if (ts.isClassLike(node)) {
		const symbol = checker.getTypeAtLocation(node).getSymbol();
		const instance = symbol === undefined ? undefined : checker.getDeclaredTypeOfSymbol(symbol);
		return instance !== undefined && reachesToolInterface(checker, instance) ? [instance] : [];
	}
	if (ts.isObjectLiteralExpression(node)) {
		const contextual = checker.getContextualType(node);
		return contextual !== undefined && reachesToolInterface(checker, contextual)
			? [checker.getTypeAtLocation(node)]
			: [];
	}
	if (
		(ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
		node.type !== undefined &&
		node.initializer !== undefined &&
		reachesToolInterface(checker, checker.getTypeAtLocation(node.type))
	) {
		return [checker.getTypeAtLocation(node.initializer)];
	}
	return [];
}

interface Resolution {
	readonly bodies: ts.ConciseBody[];
	/** Where following the member stopped short of a body: a signature, a call result, a field with no initializer. */
	readonly stuck: ts.Node[];
}

function merge(resolutions: readonly Resolution[]): Resolution {
	return {
		bodies: resolutions.flatMap((resolution) => resolution.bodies),
		stuck: resolutions.flatMap((resolution) => resolution.stuck),
	};
}

const LEAF_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
	ts.SyntaxKind.QuestionQuestionToken,
	ts.SyntaxKind.BarBarToken,
	ts.SyntaxKind.AmpersandAmpersandToken,
	ts.SyntaxKind.CommaToken,
]);

/**
 * The values an expression can evaluate to, through the wrappers that change nothing about them. `a && b` yields `a`
 * only when `a` is falsy, and a falsy value is neither a callable nor model-facing text, so only `b` is a value.
 */
function leaves(expression: ts.Expression): ts.Expression[] {
	if (
		ts.isParenthesizedExpression(expression) ||
		ts.isAwaitExpression(expression) ||
		ts.isAsExpression(expression) ||
		ts.isSatisfiesExpression(expression) ||
		ts.isTypeAssertionExpression(expression) ||
		ts.isNonNullExpression(expression)
	) {
		return leaves(expression.expression);
	}
	if (ts.isConditionalExpression(expression)) {
		return [...leaves(expression.whenTrue), ...leaves(expression.whenFalse)];
	}
	if (ts.isBinaryExpression(expression) && LEAF_OPERATORS.has(expression.operatorToken.kind)) {
		return expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
			expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
			? [...leaves(expression.left), ...leaves(expression.right)]
			: leaves(expression.right);
	}
	return [expression];
}

interface Resolver {
	readonly checker: ts.TypeChecker;
	/** Declarations the program assigns to after their initializer; their value at the host's call is unknowable. */
	readonly written: ReadonlySet<ts.Declaration>;
	readonly seen: Map<ts.Node, Resolution>;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
	return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

/** A spread copies a property's symbol but shares its declaration, so the written set holds declarations. */
function writtenDeclarations(checker: ts.TypeChecker, program: ts.Program): Set<ts.Declaration> {
	const written = new Set<ts.Declaration>();
	const add = (symbol: ts.Symbol | undefined): void => {
		for (const declaration of symbol?.declarations ?? []) {
			written.add(declaration);
		}
	};
	const target = (node: ts.Expression): void => {
		if (ts.isIdentifier(node)) {
			add(checker.getSymbolAtLocation(node));
		} else if (ts.isPropertyAccessExpression(node)) {
			add(checker.getSymbolAtLocation(node.name));
		} else if (ts.isElementAccessExpression(node)) {
			// A key the checker cannot name may reach any member, so every member of the receiver counts as written.
			const receiver = checker.getNonNullableType(checker.getTypeAtLocation(node.expression));
			const keys = literalKeys(checker, node.argumentExpression);
			for (const part of receiver.isUnion() ? receiver.types : [receiver]) {
				for (const symbol of keys.length === 0 ? part.getProperties() : keys.map((key) => part.getProperty(key))) {
					add(symbol);
				}
			}
		} else if (ts.isObjectLiteralExpression(node)) {
			for (const property of node.properties) {
				if (ts.isPropertyAssignment(property)) {
					target(property.initializer);
				} else if (ts.isShorthandPropertyAssignment(property)) {
					target(property.name);
				} else if (ts.isSpreadAssignment(property)) {
					target(property.expression);
				}
			}
		} else if (ts.isArrayLiteralExpression(node)) {
			for (const element of node.elements) {
				target(ts.isSpreadElement(element) ? element.expression : element);
			}
		} else if (
			ts.isParenthesizedExpression(node) ||
			ts.isNonNullExpression(node) ||
			ts.isAsExpression(node) ||
			ts.isSatisfiesExpression(node) ||
			ts.isTypeAssertionExpression(node)
		) {
			target(node.expression);
		} else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
			target(node.left);
		}
	};
	const visit = (node: ts.Node): void => {
		if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
			target(node.left);
		} else if (
			(ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
			(node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
		) {
			target(node.operand);
		} else if (
			(ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
			!ts.isVariableDeclarationList(node.initializer)
		) {
			target(node.initializer);
		}
		ts.forEachChild(node, visit);
	};
	for (const sourceFile of program.getSourceFiles()) {
		if (!sourceFile.isDeclarationFile) {
			visit(sourceFile);
		}
	}
	return written;
}

function symbolBodies(resolver: Resolver, symbol: ts.Symbol): Resolution {
	const resolved = symbol.flags & ts.SymbolFlags.Alias ? resolver.checker.getAliasedSymbol(symbol) : symbol;
	const declarations = resolved.declarations ?? [];
	const [first] = declarations;
	const merged = merge(declarations.map((declaration) => declarationBodies(resolver, declaration)));
	return first !== undefined && merged.bodies.length === 0 && merged.stuck.length === 0
		? { bodies: [], stuck: [first] }
		: merged;
}

function propertyBodies(resolver: Resolver, receiver: ts.Type, keys: readonly string[]): Resolution {
	const bare = resolver.checker.getNonNullableType(receiver);
	return merge(
		(bare.isUnion() ? bare.types : [bare]).flatMap((part) =>
			keys.map((key) => {
				const symbol = part.getProperty(key);
				return symbol === undefined ? { bodies: [], stuck: [] } : symbolBodies(resolver, symbol);
			})
		)
	);
}

function expressionBodies(resolver: Resolver, expression: ts.Expression): Resolution {
	const { checker } = resolver;
	return merge(
		leaves(expression).map((leaf): Resolution => {
			if (ts.isArrowFunction(leaf) || ts.isFunctionExpression(leaf)) {
				return { bodies: [leaf.body], stuck: [] };
			}
			if (ts.isElementAccessExpression(leaf)) {
				const keys = literalKeys(checker, leaf.argumentExpression);
				return keys.length === 0
					? { bodies: [], stuck: [leaf] }
					: propertyBodies(resolver, checker.getTypeAtLocation(leaf.expression), keys);
			}
			if (ts.isIdentifier(leaf) || ts.isPropertyAccessExpression(leaf)) {
				const symbol = checker.getSymbolAtLocation(leaf);
				return symbol === undefined ? { bodies: [], stuck: [leaf] } : symbolBodies(resolver, symbol);
			}
			return { bodies: [], stuck: [leaf] };
		})
	);
}

function declarationBodies(resolver: Resolver, declaration: ts.Declaration): Resolution {
	const cached = resolver.seen.get(declaration);
	if (cached !== undefined) {
		return cached;
	}
	resolver.seen.set(declaration, { bodies: [], stuck: [] });
	const resolution = resolveDeclaration(resolver, declaration);
	resolver.seen.set(declaration, resolution);
	return resolution;
}

/**
 * A written declaration never resolves: the value the host calls is some later assignment's. A variable resolves
 * only as a `const`, since a `let` may be assigned on a path the scan does not follow.
 */
function resolveDeclaration(resolver: Resolver, declaration: ts.Declaration): Resolution {
	const { checker, written } = resolver;
	const stuck: Resolution = { bodies: [], stuck: [declaration] };
	if (declaration.getSourceFile().isDeclarationFile || written.has(declaration)) {
		return stuck;
	}
	if (ts.isMethodDeclaration(declaration) || ts.isFunctionDeclaration(declaration)) {
		// An overload signature has no body and its implementation is another declaration of the same symbol.
		return { bodies: declaration.body === undefined ? [] : [declaration.body], stuck: [] };
	}
	if (ts.isGetAccessorDeclaration(declaration)) {
		// The host calls what the getter returns, so the getter's returns are callables to follow, not exit values.
		return declaration.body === undefined
			? stuck
			: merge(returnedExpressions(declaration.body).map((returned) => expressionBodies(resolver, returned)));
	}
	if (ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration)) {
		return { bodies: [declaration.body], stuck: [] };
	}
	if (ts.isShorthandPropertyAssignment(declaration)) {
		const value = checker.getShorthandAssignmentValueSymbol(declaration);
		return value === undefined ? stuck : symbolBodies(resolver, value);
	}
	if (ts.isPropertyAssignment(declaration)) {
		return expressionBodies(resolver, declaration.initializer);
	}
	if (ts.isPropertyDeclaration(declaration) && declaration.initializer !== undefined) {
		return expressionBodies(resolver, declaration.initializer);
	}
	if (
		ts.isVariableDeclaration(declaration) &&
		declaration.initializer !== undefined &&
		(ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0
	) {
		return expressionBodies(resolver, declaration.initializer);
	}
	// A parameter's value is the caller's, so its default fixes nothing.
	return stuck;
}

function memberBodies(resolver: Resolver, type: ts.Type, member: string): Resolution {
	const bare = resolver.checker.getNonNullableType(type);
	if (bare.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
		return { bodies: [], stuck: [] };
	}
	return propertyBodies(resolver, bare, [member]);
}

/** The returns of this body alone: a callback's return is not the host's value. */
function returnedExpressions(body: ts.ConciseBody): ts.Expression[] {
	if (!ts.isBlock(body)) {
		return [body];
	}
	const found: ts.Expression[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isFunctionLike(node) || ts.isClassLike(node)) {
			return;
		}
		if (ts.isReturnStatement(node)) {
			if (node.expression !== undefined) {
				found.push(node.expression);
			}
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(body);
	return found;
}

function callsExitSite(
	checker: ts.TypeChecker,
	sites: readonly ExitSite[],
	file: string,
	leaf: ts.Expression
): boolean {
	if (!ts.isCallExpression(leaf)) {
		return false;
	}
	const declaration = checker.getResolvedSignature(leaf)?.declaration;
	const site = sites.find((candidate) => candidate.file === file);
	return (
		declaration !== undefined &&
		site?.functions !== undefined &&
		(ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) &&
		declaration.name !== undefined &&
		ts.isIdentifier(declaration.name) &&
		site.functions.includes(declaration.name.text) &&
		declaration.getSourceFile() === leaf.getSourceFile()
	);
}

/** A thrown exit (never) or no value at all hands the host nothing to show. */
function carriesNothing(checker: ts.TypeChecker, leaf: ts.Expression): boolean {
	const type = checker.getTypeAtLocation(leaf);
	const awaited = checker.getAwaitedType(type) ?? type;
	return (awaited.flags & (ts.TypeFlags.Never | ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Null)) !== 0;
}

/**
 * A construct in a root file is judged by the construct rule, so the return rule accepts it rather than reporting it
 * twice; a body reached outside the roots gets no construct judgment, so there the construct is the return's verdict.
 */
function isReturnAllowed(
	checker: ts.TypeChecker,
	sites: readonly ExitSite[],
	isRoot: (file: ts.SourceFile) => boolean,
	file: string,
	leaf: ts.Expression
): boolean {
	return (
		(constructAt(checker, leaf) !== undefined && isRoot(leaf.getSourceFile())) ||
		callsExitSite(checker, sites, file, leaf) ||
		carriesNothing(checker, leaf)
	);
}

function parseConfig(tsconfigPath: string): ts.ParsedCommandLine {
	const host: ts.ParseConfigFileHost = {
		...ts.sys,
		onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
			throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
		},
	};
	const config = ts.getParsedCommandLineOfConfigFile(tsconfigPath, {}, host);
	if (config === undefined) {
		throw new Error(`Cannot parse ${tsconfigPath}`);
	}
	return config;
}

class RuleTally implements RuleScan {
	readonly judgments: Judgment[] = [];

	constructor(private readonly rootDir: string) {}

	fileOf(node: ts.Node): string {
		return path.relative(this.rootDir, node.getSourceFile().fileName).split(path.sep).join("/");
	}

	judge(node: ts.Node, rule: Rule, shape: string, allowed: boolean): void {
		const sourceFile = node.getSourceFile();
		const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
		this.judgments.push({ file: this.fileOf(node), line: line + 1, column: character + 1, rule, shape, allowed });
	}
}

/** The test hands fixtures their own sites. */
export function scanRedactionBoundaries(
	tsconfigPath: string,
	fileNames?: readonly string[],
	sites: readonly ExitSite[] = EXIT_SITES
): BoundaryScan {
	const config = parseConfig(tsconfigPath);
	const rootDir = path.dirname(tsconfigPath);
	const program = ts.createProgram(fileNames ?? config.fileNames, config.options);
	// Root names arrive as given (a Windows join keeps backslashes); the SourceFile object is the one stable identity.
	const roots = new Set(program.getRootFileNames().map((name) => program.getSourceFile(name)));
	const isRoot = (file: ts.SourceFile): boolean => roots.has(file);
	const checker = program.getTypeChecker();
	const written = writtenDeclarations(checker, program);
	const channel = new RuleTally(rootDir);
	const exits = new RuleTally(rootDir);
	const judgedBodies = new Set<ts.Node>();
	const reportedStuck = new Map<string, Set<ts.Node>>();

	const judgeTool = (boundary: ts.Node, type: ts.Type): void => {
		for (const member of TOOL_EXIT_MEMBERS) {
			const { bodies, stuck } = memberBodies({ checker, written, seen: new Map() }, type, member);
			for (const body of bodies) {
				if (judgedBodies.has(body)) {
					continue;
				}
				judgedBodies.add(body);
				for (const leaf of returnedExpressions(body).flatMap(leaves)) {
					const allowed = isReturnAllowed(checker, sites, isRoot, exits.fileOf(leaf), leaf);
					exits.judge(leaf, "return", `return in ${member}`, allowed);
				}
			}
			const reported = reportedStuck.get(member) ?? new Set<ts.Node>();
			reportedStuck.set(member, reported);
			for (const deadEnd of stuck) {
				const at = deadEnd.getSourceFile().isDeclarationFile ? boundary : deadEnd;
				if (reported.has(at)) {
					continue;
				}
				reported.add(at);
				exits.judge(at, "member", `${member} member not analyzable`, false);
			}
		}
	};

	for (const fileName of program.getRootFileNames()) {
		const sourceFile = program.getSourceFile(fileName);
		if (sourceFile === undefined || sourceFile.isDeclarationFile) {
			continue;
		}
		const file = channel.fileOf(sourceFile);
		const visit = (node: ts.Node): void => {
			for (const member of channelMembersAt(checker, node)) {
				channel.judge(node, "channel", member, isChannelAccessAllowed(file, member));
			}
			const construct = constructAt(checker, node);
			if (construct !== undefined) {
				exits.judge(node, "construct", construct.shape, isConstructAllowed(sites, file, node, construct));
			}
			const registration = registersTool(checker, node);
			if (registration !== undefined && registration.tool === undefined) {
				for (const member of TOOL_EXIT_MEMBERS) {
					exits.judge(node, "member", `${member} member not analyzable`, false);
				}
			}
			for (const type of toolTypesAt(checker, node)) {
				judgeTool(registration?.tool ?? node, type);
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
	}
	return { channel, exits };
}
