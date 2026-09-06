/**
 * The one-API rule: shipped source localizes through @vscode/l10n's canonical
 * import form and direct l10n.t calls, never through vscode's own l10n surface
 * or an aliased binding extraction cannot see.
 */
import ts from "typescript";

interface VscodeL10nRuleOptions {
	/** Whether this file may read `vscode.l10n.bundle` (the two bundle-feeding sites). */
	readonly allowBundleReads: boolean;
	/**
	 * Whether this file may reference a vscode-module binding as a plain value
	 * (the Reflect constructor-probe files). Member access rules still apply;
	 * `.l10n` stays flagged.
	 */
	readonly allowVscodeValueUse: boolean;
}

/**
 * Line numbers (1-based) of localization forms outside the sanctioned set: the
 * canonical `import * as l10n from "@vscode/l10n"` with direct `l10n.t`/
 * `l10n.config` calls, ordinary non-l10n vscode member access,
 * `vscode.l10n.bundle` reads in the bundle-feeding files, and type-only forms.
 *
 * An allowlist that fails closed, not a catalog of known escapes: every other
 * appearance of a tracked binding flags, so a novel laundering form fails the
 * gate rather than shipping strings extraction cannot follow. Matching is
 * syntactic, so a local binding shadowing a tracked name flags too; rename it
 * or add a deliberate allowlist entry here.
 */
export function vscodeL10nOffenses(contents: string, fileName: string, options: VscodeL10nRuleOptions): number[] {
	const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const sourceFile = ts.createSourceFile(fileName, contents, ts.ScriptTarget.Latest, false, kind);
	const offenses: number[] = [];
	const flag = (node: ts.Node): void => {
		offenses.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
	};

	const specifierOf = (statement: ts.ImportDeclaration | ts.ExportDeclaration): string | undefined =>
		statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)
			? statement.moduleSpecifier.text
			: undefined;

	// Unwrap parens and type wrappers so `(vscode).l10n` or
	// `const loc = (l10n as typeof l10n)` cannot slip by.
	const unwrap = (node: ts.Expression): ts.Expression => {
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
	};

	const isCanonicalL10nImport = (statement: ts.ImportDeclaration): boolean =>
		statement.importClause?.name === undefined &&
		statement.importClause?.namedBindings !== undefined &&
		ts.isNamespaceImport(statement.importClause.namedBindings) &&
		statement.importClause.namedBindings.name.text === "l10n";

	// Pass 1: which local names bind the vscode module, and whether the
	// canonical @vscode/l10n binding exists (its laundering checks key off it).
	const vscodeNamespaces = new Set<string>();
	let hasCanonicalL10n = false;
	for (const statement of sourceFile.statements) {
		if (ts.isImportDeclaration(statement)) {
			const specifier = specifierOf(statement);
			const clause = statement.importClause;
			if (clause === undefined || clause.isTypeOnly) {
				continue;
			}
			if (specifier === "vscode") {
				// Default and namespace imports both bind the whole module
				// object under Node16 interop, so both feed the member checks.
				if (clause.name !== undefined) {
					vscodeNamespaces.add(clause.name.text);
				}
				if (clause.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings)) {
					vscodeNamespaces.add(clause.namedBindings.name.text);
				}
			} else if (specifier === "@vscode/l10n" && isCanonicalL10nImport(statement)) {
				hasCanonicalL10n = true;
			}
		} else if (ts.isImportEqualsDeclaration(statement) && !statement.isTypeOnly) {
			const reference = statement.moduleReference;
			if (
				ts.isExternalModuleReference(reference) &&
				ts.isStringLiteral(reference.expression) &&
				reference.expression.text === "vscode"
			) {
				vscodeNamespaces.add(statement.name.text);
			}
		}
	}

	// Pass 2: import and export statements themselves.
	for (const statement of sourceFile.statements) {
		if (ts.isImportDeclaration(statement)) {
			const specifier = specifierOf(statement);
			const clause = statement.importClause;
			if (clause === undefined || clause.isTypeOnly) {
				continue;
			}
			if (specifier === "vscode") {
				if (clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
					for (const element of clause.namedBindings.elements) {
						if (!element.isTypeOnly && (element.propertyName ?? element.name).text === "l10n") {
							flag(element);
						}
					}
				}
			} else if (specifier === "@vscode/l10n" && !isCanonicalL10nImport(statement)) {
				const bindings = clause.namedBindings;
				const typeOnlyElements =
					bindings !== undefined &&
					ts.isNamedImports(bindings) &&
					clause.name === undefined &&
					bindings.elements.every((element) => element.isTypeOnly);
				if (!typeOnlyElements) {
					flag(statement);
				}
			}
		} else if (ts.isImportEqualsDeclaration(statement) && !statement.isTypeOnly) {
			const reference = statement.moduleReference;
			if (ts.isExternalModuleReference(reference)) {
				if (ts.isStringLiteral(reference.expression) && reference.expression.text === "@vscode/l10n") {
					flag(statement);
				}
			} else {
				// import x = <entity>: an alias of whatever the entity names. Off
				// a vscode binding a non-l10n member alias is fine; the whole
				// namespace or anything through .l10n is not. Off the canonical
				// binding, every alias breaks the one canonical call shape.
				const segments: string[] = [];
				let root: ts.EntityName = reference;
				while (ts.isQualifiedName(root)) {
					segments.unshift(root.right.text);
					root = root.left;
				}
				if (hasCanonicalL10n && root.text === "l10n") {
					flag(statement);
				} else if (vscodeNamespaces.has(root.text) && (segments.length === 0 || segments.includes("l10n"))) {
					flag(statement);
				}
			}
		} else if (ts.isExportDeclaration(statement)) {
			if (statement.isTypeOnly) {
				continue;
			}
			const specifier = specifierOf(statement);
			if (specifier === "@vscode/l10n") {
				const typeOnlyElements =
					statement.exportClause !== undefined &&
					ts.isNamedExports(statement.exportClause) &&
					statement.exportClause.elements.every((element) => element.isTypeOnly);
				if (!typeOnlyElements) {
					flag(statement);
				}
			} else if (specifier === "vscode") {
				if (statement.exportClause === undefined || !ts.isNamedExports(statement.exportClause)) {
					flag(statement);
				} else {
					for (const element of statement.exportClause.elements) {
						if (!element.isTypeOnly && (element.propertyName ?? element.name).text === "l10n") {
							flag(element);
						}
					}
				}
			} else if (specifier === undefined && statement.exportClause !== undefined) {
				// A local export of any tracked binding is a facade.
				if (ts.isNamedExports(statement.exportClause)) {
					for (const element of statement.exportClause.elements) {
						const local = (element.propertyName ?? element.name).text;
						if (!element.isTypeOnly && (vscodeNamespaces.has(local) || (hasCanonicalL10n && local === "l10n"))) {
							flag(element);
						}
					}
				}
			}
		}
	}

	const isVscodeBinding = (node: ts.Expression): boolean => {
		const inner = unwrap(node);
		return ts.isIdentifier(inner) && vscodeNamespaces.has(inner.text);
	};

	const isVscodeL10n = (node: ts.Node): boolean =>
		ts.isPropertyAccessExpression(node) && isVscodeBinding(node.expression) && node.name.text === "l10n";

	const isCanonicalBinding = (node: ts.Expression): boolean => {
		const inner = unwrap(node);
		return hasCanonicalL10n && ts.isIdentifier(inner) && inner.text === "l10n";
	};

	// The walk allows the sanctioned forms and flags every other appearance
	// of a tracked binding, so unknown shapes fail closed.
	const scan = (node: ts.Node): void => {
		// A heritage clause's expression evaluates when the class does, even
		// though its node counts as a type node; walk it before the type skip.
		if (ts.isExpressionWithTypeArguments(node)) {
			scan(node.expression);
			return;
		}
		// Type positions are erased at runtime; they cannot ship a string.
		if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
			return;
		}
		// Import and export statements were judged in pass 2; walking into
		// them would flag their own binding identifiers.
		if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isExportDeclaration(node)) {
			return;
		}
		// A dynamic import or CommonJS require of either module is a
		// laundering route the walk cannot follow; nothing sanctioned needs one.
		if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
			node.arguments.length > 0
		) {
			const argument = unwrap(node.arguments[0]);
			if (ts.isStringLiteralLike(argument) && (argument.text === "vscode" || argument.text === "@vscode/l10n")) {
				flag(node);
				return;
			}
		}
		// Sanctioned: the exact canonical call shape, l10n.t(...) or
		// l10n.config(...), unwrapped and unchained - extraction follows
		// nothing looser, so a wrapped or optional variant falls through.
		if (ts.isCallExpression(node) && node.questionDotToken === undefined) {
			const callee = node.expression;
			if (
				ts.isPropertyAccessExpression(callee) &&
				callee.questionDotToken === undefined &&
				hasCanonicalL10n &&
				ts.isIdentifier(callee.expression) &&
				callee.expression.text === "l10n" &&
				(callee.name.text === "t" || callee.name.text === "config")
			) {
				for (const argument of node.arguments) {
					scan(argument);
				}
				return;
			}
		}
		if (ts.isPropertyAccessExpression(node)) {
			const object = unwrap(node.expression);
			if (isVscodeBinding(object)) {
				// Sanctioned: ordinary vscode API use; the l10n member is not it.
				if (node.name.text === "l10n") {
					flag(node);
				}
				return;
			}
			if (isVscodeL10n(object)) {
				// Sanctioned: the bundle read, in the bundle-feeding files only.
				if (!(options.allowBundleReads && node.name.text === "bundle")) {
					flag(node);
				}
				return;
			}
			if (isCanonicalBinding(object)) {
				flag(node);
				return;
			}
			// A member name is a key, not a reference; only the object side binds.
			scan(node.expression);
			return;
		}
		// Element access on a vscode binding stays banned even where passing
		// the module object as a value is allowed.
		if (ts.isElementAccessExpression(node) && isVscodeBinding(unwrap(node.expression))) {
			flag(node);
			scan(node.argumentExpression);
			return;
		}
		// Fail-closed catch-all: any other appearance of a tracked binding.
		if (ts.isIdentifier(node)) {
			if (vscodeNamespaces.has(node.text) && !options.allowVscodeValueUse) {
				flag(node);
				return;
			}
			if (hasCanonicalL10n && node.text === "l10n") {
				flag(node);
				return;
			}
		}
		// Property KEYS spell a name without referencing a binding: skip a
		// member's non-computed name (and a binding element's property name)
		// while still walking initializers, bodies, and computed names.
		const named = node as { readonly name?: ts.Node; readonly propertyName?: ts.Node };
		const key =
			ts.isBindingElement(node) && node.propertyName !== undefined && !ts.isComputedPropertyName(node.propertyName)
				? named.propertyName
				: ts.isJsxAttribute(node) ||
						((ts.isClassElement(node) || ts.isObjectLiteralElementLike(node) || ts.isEnumMember(node)) &&
							!ts.isShorthandPropertyAssignment(node) &&
							named.name !== undefined &&
							!ts.isComputedPropertyName(named.name))
					? named.name
					: undefined;
		if (key !== undefined) {
			ts.forEachChild(node, (child) => {
				if (child !== key) {
					scan(child);
				}
			});
			return;
		}
		ts.forEachChild(node, scan);
	};
	scan(sourceFile);
	return offenses;
}
