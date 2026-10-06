/**
 * src/shared/logger.ts is the one place output-channel text is written, so the redaction there covers every line; a
 * write-shaped member access on vscode's channel types anywhere else is refused. Membership is judged by the vscode
 * declaration a member resolves to, never by its name, so a Map's clear() or a string's replace() is not a hit.
 *
 *   src/shared/logger.ts takes a structural LogSink  -> its info()/error() resolve to logger.ts, never to vscode
 *   src/extension.ts creates the channel             -> the one createOutputChannel call, handed to the Logger
 */
import * as path from "node:path";
import ts from "typescript";

export interface ChannelAccess {
	/** Repository-relative, forward slashes. */
	readonly file: string;
	readonly line: number;
	readonly column: number;
	readonly member: string;
}

export interface ChannelAccessScan {
	readonly seen: number;
	readonly refused: readonly ChannelAccess[];
}

export const LOGGER_FILE = "src/shared/logger.ts";

/** The wiring site may only create the channel; a write there would skip the Logger like a write anywhere else. */
export const WIRING_FILE = "src/extension.ts";

/** Default-deny: a member vscode adds later is a write until it is listed here; clear() erases, it writes no text. */
export const NON_WRITING_MEMBERS: ReadonlySet<string> = new Set([
	"name",
	"show",
	"hide",
	"clear",
	"dispose",
	"logLevel",
	"onDidChangeLogLevel",
]);

const CHANNEL_INTERFACES: ReadonlySet<string> = new Set(["OutputChannel", "LogOutputChannel"]);

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
	return (type.isUnion() ? type.types : [type]).flatMap((t) => (t.isStringLiteral() ? [t.value] : []));
}

function propertyKeys(checker: ts.TypeChecker, key: ts.PropertyName): string[] {
	if (ts.isComputedPropertyName(key)) {
		return literalKeys(checker, key.expression);
	}
	return ts.isPrivateIdentifier(key) ? [] : [key.text];
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
		return {
			receiver: checker.getTypeAtLocation(node.parent.right),
			keys: node.properties.flatMap((property) =>
				ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)
					? propertyKeys(checker, property.name)
					: []
			),
		};
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

function isAllowed(file: string, member: string): boolean {
	return (
		NON_WRITING_MEMBERS.has(member) ||
		file === LOGGER_FILE ||
		(file === WIRING_FILE && member === "createOutputChannel")
	);
}

export function scanOutputChannelAccess(tsconfigPath: string, fileNames?: readonly string[]): ChannelAccessScan {
	const config = parseConfig(tsconfigPath);
	const rootDir = path.dirname(tsconfigPath);
	const program = ts.createProgram(fileNames ?? config.fileNames, config.options);
	const checker = program.getTypeChecker();
	let seen = 0;
	const refused: ChannelAccess[] = [];

	for (const fileName of program.getRootFileNames()) {
		const sourceFile = program.getSourceFile(fileName);
		if (sourceFile === undefined || sourceFile.isDeclarationFile) {
			continue;
		}
		const file = path.relative(rootDir, sourceFile.fileName).split(path.sep).join("/");
		const visit = (node: ts.Node): void => {
			for (const member of channelMembersAt(checker, node)) {
				seen += 1;
				if (!isAllowed(file, member)) {
					const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
					refused.push({ file, line: line + 1, column: character + 1, member });
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
	}
	return { seen, refused };
}
