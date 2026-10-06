/**
 * Guarantee: this rule catches accidental omissions and analysis gaps in the named reader modules; deliberate hiding
 * (aliasing a method, eval, indirect calls through untyped values) is out of scope.
 *
 * src/shared/util/headers.ts is the one trim rule and src/shared/util/decimalText.ts the one decimal grammar for a
 * user's text, so a settings reader that trims, numbers, or coerces a value itself is refused. A call is judged by the
 * lib declaration it resolves to, never by its name, and a type the checker cannot settle is a refusal, never a pass.
 *
 *   .trim() .trimStart() .trimEnd() .trimLeft() .trimRight()               -> refused on every receiver
 *   Number(x) parseFloat(x) parseInt(x, r) new Number(x)                   -> refused unless every argument is a literal, number, bigint, or boolean
 *   +x -x ~x, and *, /, -, %, **, |, &, ^, <<, >>, >>> with compound forms -> refused unless every operand is one of those
 *   x < y, <=, >, >=                                                       -> refused unless both sides are numbers or both are strings
 *   READER_HOMES, an ALLOWED_READS (file, function) pair                   -> seen, not refused
 */
import * as path from "node:path";
import ts from "typescript";

export interface ReaderRefusal {
	/** Repository-relative, forward slashes. */
	readonly file: string;
	readonly line: number;
	readonly column: number;
	/** As reported: `.trim()`, `Number.parseInt()`, `unary +`, `binary *=`, `.trim() on an unresolved receiver`. */
	readonly shape: string;
}

export interface AllowedRead {
	readonly file: string;
	/** The nearest named function around the read; a nameless callback belongs to its holder. */
	readonly function: string;
	readonly reason: string;
}

export interface ReaderScan {
	readonly seen: number;
	readonly refused: readonly ReaderRefusal[];
	/** Rows no read matched: a stale row would hide the next read added to that function. */
	readonly unusedAllowed: readonly AllowedRead[];
}

export interface ReaderScope {
	/** A directory prefix (trailing slash) or one file, repository-relative. */
	readonly modules: readonly string[];
	readonly allowed: readonly AllowedRead[];
}

export const TRIM_HOME = "src/shared/util/headers.ts";

export const DECIMAL_HOME = "src/shared/util/decimalText.ts";

/** The two homes; every call inside them is the rule itself. */
const READER_HOMES: readonly string[] = [TRIM_HOME, DECIMAL_HOME];

const READER_MODULES: readonly string[] = [
	"src/shared/config/",
	"src/extension/servers/serverSync/setting.ts",
	"src/dashboard/",
	"src/extension/settingsTransfer/",
	"src/extension/dashboard/state.ts",
	"src/extension/dashboard/entryAuth.ts",
	"src/extension/ui/settingsTransferCommands.ts",
	"src/provider/catalog/groupModels.ts",
	...READER_HOMES,
];

const ALLOWED_READS: readonly AllowedRead[] = [
	{
		file: "src/shared/config/openRouterCatalog.ts",
		function: "nonBlankString",
		reason: "reads a catalog response field, not user text; the one trim rule covers settings values",
	},
	{
		file: "src/dashboard/spendFormat.ts",
		function: "formatPercentExact",
		reason: "re-reads the code's own toPrecision output, never user text",
	},
	{
		file: "src/dashboard/presenters.ts",
		function: "scaledDecimal",
		reason: "reads a DECIMAL_TEXT_PATTERN capture; the grammar has already judged the text",
	},
];

const TRIM_MEMBERS: ReadonlySet<string> = new Set(["trim", "trimStart", "trimEnd", "trimLeft", "trimRight"]);

const NUMBER_PARSERS: ReadonlySet<string> = new Set(["parseFloat", "parseInt"]);

const NUMBER_CONSTRUCTOR = "NumberConstructor";

/** Everything that is not text: a constant or a value Number() reads without a grammar. */
const NOT_TEXT =
	ts.TypeFlags.NumberLike |
	ts.TypeFlags.BigIntLike |
	ts.TypeFlags.BooleanLike |
	ts.TypeFlags.StringLiteral |
	ts.TypeFlags.Null |
	ts.TypeFlags.Undefined;

const UNRESOLVED = ts.TypeFlags.Any | ts.TypeFlags.Unknown;

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

function isInScope(modules: readonly string[], file: string): boolean {
	return modules.some((module) => (module.endsWith("/") ? file.startsWith(module) : file === module));
}

function constituents(checker: ts.TypeChecker, type: ts.Type): readonly ts.Type[] {
	const constrained = checker.getBaseConstraintOfType(type) ?? type;
	return constrained.isUnion() ? constrained.types : [constrained];
}

/** The callee under the wrappers that change nothing about it: `(text.trim)()`, `text.trim!()`. */
function callee(node: ts.CallExpression | ts.NewExpression): ts.Expression {
	let expression: ts.Expression = node.expression;
	while (
		ts.isParenthesizedExpression(expression) ||
		ts.isNonNullExpression(expression) ||
		ts.isAsExpression(expression) ||
		ts.isSatisfiesExpression(expression) ||
		ts.isTypeAssertionExpression(expression)
	) {
		expression = expression.expression;
	}
	return expression;
}

/** A key typed as plain string names no member, so only literal types (or a constraint to them) count. */
function memberNames(checker: ts.TypeChecker, access: ts.Expression): readonly string[] {
	if (ts.isPropertyAccessExpression(access)) {
		return [access.name.text];
	}
	if (ts.isElementAccessExpression(access)) {
		return constituents(checker, checker.getTypeAtLocation(access.argumentExpression)).flatMap((t) =>
			t.isStringLiteral() ? [t.value] : []
		);
	}
	return [];
}

interface Judged {
	readonly shape: string;
	readonly refused: boolean;
}

function isLibStringMember(program: ts.Program, declaration: ts.Declaration): boolean {
	const owner = declaration.parent;
	return (
		program.isSourceFileDefaultLibrary(declaration.getSourceFile()) &&
		ts.isInterfaceDeclaration(owner) &&
		owner.name.text === "String"
	);
}

function trimAt(checker: ts.TypeChecker, program: ts.Program, node: ts.CallExpression): Judged | undefined {
	const access = callee(node);
	if (!ts.isPropertyAccessExpression(access) && !ts.isElementAccessExpression(access)) {
		return undefined;
	}
	const members = memberNames(checker, access).filter((name) => TRIM_MEMBERS.has(name));
	if (members.length === 0) {
		return undefined;
	}
	const shape = members
		.map((member) => `.${member}()`)
		.sort()
		.join(" or ");
	const receiver = checker.getNonNullableType(checker.getTypeAtLocation(access.expression));
	let resolved = false;
	for (const part of constituents(checker, receiver)) {
		if ((part.flags & UNRESOLVED) !== 0) {
			return { shape: `${shape} on an unresolved receiver`, refused: true };
		}
		// A mapped type's property (Record<"trim", () => number>) has a symbol but no declaration; it is still resolved.
		const properties = members.flatMap((member) => checker.getApparentType(part).getProperty(member) ?? []);
		if (properties.some((property) => property.declarations?.some((d) => isLibStringMember(program, d)))) {
			return { shape, refused: true };
		}
		resolved ||= properties.length > 0;
	}
	return resolved ? undefined : { shape: `${shape} on an unresolved receiver`, refused: true };
}

function numberReaderOf(program: ts.Program, declaration: ts.Declaration): string | undefined {
	if (!program.isSourceFileDefaultLibrary(declaration.getSourceFile())) {
		return undefined;
	}
	const owner = declaration.parent;
	const ownsConstructor = ts.isInterfaceDeclaration(owner) && owner.name.text === NUMBER_CONSTRUCTOR;
	if (ts.isCallSignatureDeclaration(declaration) && ownsConstructor) {
		return "Number()";
	}
	if (ts.isConstructSignatureDeclaration(declaration) && ownsConstructor) {
		return "new Number()";
	}
	if (
		ts.isFunctionDeclaration(declaration) &&
		declaration.name !== undefined &&
		NUMBER_PARSERS.has(declaration.name.text)
	) {
		return `${declaration.name.text}()`;
	}
	return ts.isMethodSignature(declaration) &&
		ownsConstructor &&
		ts.isIdentifier(declaration.name) &&
		NUMBER_PARSERS.has(declaration.name.text)
		? `Number.${declaration.name.text}()`
		: undefined;
}

function unresolvedReaderName(access: ts.Expression): string | undefined {
	const name = ts.isIdentifier(access)
		? access.text
		: ts.isPropertyAccessExpression(access)
			? access.name.text
			: undefined;
	return name === "Number" || (name !== undefined && NUMBER_PARSERS.has(name)) ? name : undefined;
}

/** A branded number (`number & { unit: "ms" }`) is still a number, so one member with the flags clears an intersection. */
function hasFlags(type: ts.Type, flags: ts.TypeFlags): boolean {
	return type.isIntersection() ? type.types.some((member) => hasFlags(member, flags)) : (type.flags & flags) !== 0;
}

function isText(checker: ts.TypeChecker, argument: ts.Expression | undefined): boolean {
	if (argument === undefined) {
		return false;
	}
	return constituents(checker, checker.getTypeAtLocation(argument)).some((part) => !hasFlags(part, NOT_TEXT));
}

const NUMERIC =
	ts.TypeFlags.NumberLike |
	ts.TypeFlags.BigIntLike |
	ts.TypeFlags.BooleanLike |
	ts.TypeFlags.Null |
	ts.TypeFlags.Undefined;

/** Undefined when the side may read a number from text: any, a `string | number`, or an object whose valueOf decides. */
function orderingKind(checker: ts.TypeChecker, operand: ts.Expression): "numeric" | "text" | undefined {
	const parts = constituents(checker, checker.getTypeAtLocation(operand));
	if (parts.every((part) => hasFlags(part, NUMERIC))) {
		return "numeric";
	}
	return parts.every((part) => hasFlags(part, ts.TypeFlags.StringLike)) ? "text" : undefined;
}

/** Strings against strings compare UTF-16 code units and read no number; every other pairing may read one. */
function isMixedOrdering(checker: ts.TypeChecker, node: ts.BinaryExpression): boolean {
	const left = orderingKind(checker, node.left);
	const right = orderingKind(checker, node.right);
	return left === undefined || right === undefined || left !== right;
}

function numberReadAt(
	checker: ts.TypeChecker,
	program: ts.Program,
	node: ts.CallExpression | ts.NewExpression
): Judged | undefined {
	const declaration = checker.getResolvedSignature(node)?.declaration;
	if (declaration === undefined) {
		const name = unresolvedReaderName(callee(node));
		return name === undefined ? undefined : { shape: `${name}() unresolved`, refused: true };
	}
	const shape = numberReaderOf(program, declaration);
	// parseInt's radix is read like its text: "0x10" there is base 16.
	return shape === undefined
		? undefined
		: { shape, refused: (node.arguments ?? []).some((argument) => isText(checker, argument)) };
}

const COERCING_PREFIXES: ReadonlyMap<ts.SyntaxKind, string> = new Map([
	[ts.SyntaxKind.PlusToken, "+"],
	[ts.SyntaxKind.MinusToken, "-"],
	[ts.SyntaxKind.TildeToken, "~"],
]);

const COERCING_OPERATORS: ReadonlyMap<ts.SyntaxKind, string> = new Map([
	[ts.SyntaxKind.AsteriskToken, "*"],
	[ts.SyntaxKind.SlashToken, "/"],
	[ts.SyntaxKind.MinusToken, "-"],
	[ts.SyntaxKind.PercentToken, "%"],
	[ts.SyntaxKind.AsteriskAsteriskToken, "**"],
	[ts.SyntaxKind.BarToken, "|"],
	[ts.SyntaxKind.AmpersandToken, "&"],
	[ts.SyntaxKind.CaretToken, "^"],
	[ts.SyntaxKind.LessThanLessThanToken, "<<"],
	[ts.SyntaxKind.GreaterThanGreaterThanToken, ">>"],
	[ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken, ">>>"],
	[ts.SyntaxKind.AsteriskEqualsToken, "*="],
	[ts.SyntaxKind.SlashEqualsToken, "/="],
	[ts.SyntaxKind.MinusEqualsToken, "-="],
	[ts.SyntaxKind.PercentEqualsToken, "%="],
	[ts.SyntaxKind.AsteriskAsteriskEqualsToken, "**="],
	[ts.SyntaxKind.BarEqualsToken, "|="],
	[ts.SyntaxKind.AmpersandEqualsToken, "&="],
	[ts.SyntaxKind.CaretEqualsToken, "^="],
	[ts.SyntaxKind.LessThanLessThanEqualsToken, "<<="],
	[ts.SyntaxKind.GreaterThanGreaterThanEqualsToken, ">>="],
	[ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken, ">>>="],
]);

const ORDERING_OPERATORS: ReadonlyMap<ts.SyntaxKind, string> = new Map([
	[ts.SyntaxKind.LessThanToken, "<"],
	[ts.SyntaxKind.LessThanEqualsToken, "<="],
	[ts.SyntaxKind.GreaterThanToken, ">"],
	[ts.SyntaxKind.GreaterThanEqualsToken, ">="],
]);

/** `+x`, `x | 0`, and `x < 20` are Number(x) without the name: "0x10" reads 16 and " " reads 0. */
function coercionAt(checker: ts.TypeChecker, node: ts.Node): Judged | undefined {
	if (ts.isPrefixUnaryExpression(node)) {
		const prefix = COERCING_PREFIXES.get(node.operator);
		return prefix === undefined ? undefined : { shape: `unary ${prefix}`, refused: isText(checker, node.operand) };
	}
	if (!ts.isBinaryExpression(node)) {
		return undefined;
	}
	const kind = node.operatorToken.kind;
	const operator = COERCING_OPERATORS.get(kind);
	if (operator !== undefined) {
		return { shape: `binary ${operator}`, refused: isText(checker, node.left) || isText(checker, node.right) };
	}
	const ordering = ORDERING_OPERATORS.get(kind);
	return ordering === undefined ? undefined : { shape: `binary ${ordering}`, refused: isMixedOrdering(checker, node) };
}

function readAt(checker: ts.TypeChecker, program: ts.Program, node: ts.Node): Judged | undefined {
	if (ts.isCallExpression(node)) {
		return trimAt(checker, program, node) ?? numberReadAt(checker, program, node);
	}
	return ts.isNewExpression(node) ? numberReadAt(checker, program, node) : coercionAt(checker, node);
}

function enclosingFunctionName(node: ts.Node): string | undefined {
	for (let current = node.parent; current !== undefined; current = current.parent) {
		if (!ts.isFunctionLike(current)) {
			continue;
		}
		const name = ts.getNameOfDeclaration(current);
		if (name === undefined) {
			continue;
		}
		return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name) ? name.text : undefined;
	}
	return undefined;
}

export function scanUserTextReaders(
	tsconfigPath: string,
	fileNames?: readonly string[],
	scope: ReaderScope = { modules: READER_MODULES, allowed: ALLOWED_READS }
): ReaderScan {
	const config = parseConfig(tsconfigPath);
	const rootDir = path.dirname(tsconfigPath);
	const program = ts.createProgram(fileNames ?? config.fileNames, config.options);
	const checker = program.getTypeChecker();
	let seen = 0;
	const refused: ReaderRefusal[] = [];
	const used = new Set<AllowedRead>();

	for (const fileName of program.getRootFileNames()) {
		const sourceFile = program.getSourceFile(fileName);
		const file = path.relative(rootDir, fileName).split(path.sep).join("/");
		if (sourceFile === undefined || sourceFile.isDeclarationFile || !isInScope(scope.modules, file)) {
			continue;
		}
		const visit = (node: ts.Node): void => {
			const read = readAt(checker, program, node);
			if (read !== undefined) {
				seen += 1;
				const owner = enclosingFunctionName(node);
				const allowed = scope.allowed.find((row) => row.file === file && row.function === owner);
				if (allowed !== undefined) {
					used.add(allowed);
				} else if (read.refused && !READER_HOMES.includes(file)) {
					const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
					refused.push({ file, line: line + 1, column: character + 1, shape: read.shape });
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
	}
	return { seen, refused, unusedAllowed: scope.allowed.filter((row) => !used.has(row)) };
}
