/**
 * Shared machinery for the l10n scripts: the deterministic source walk and
 * extraction behind `l10n:extract`, the module-scope localization guard, and
 * the zod schemas `l10n:check` parses every translation file with. Scripts
 * run from the repo root (package.json invokes them there), so paths anchor
 * on process.cwd() like the other scripts in this tree.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getL10nJson, type l10nJsonFormat } from "@vscode/l10n-dev";
import ts from "typescript";
import { z } from "zod";

/** The English reference bundle: what extract writes and check re-derives. */
export const BUNDLE_PATH = path.join(process.cwd(), "l10n", "bundle.l10n.json");

/**
 * The generated English bundle's values: a message, optionally wrapped with
 * translator comments (l10n.t({message, comment}) mints those). Translated
 * bundles are NOT allowed the wrapped shape; check.ts parses them with
 * nlsSchema because the webview bootstrap drops non-string values wholesale.
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
 * Lazy localization helpers: calling one at module scope defeats its laziness
 * exactly like a direct t() call, so the guard bans these names alongside
 * l10n.t and vscode.l10n.t. The inclusion rule is a full census, no judgment:
 * EVERY top-level lowercase-named function in shipped src/ whose declaration
 * (default parameters included) resolves l10n.t, directly or transitively
 * through another censused name - presenters, parsers, error constructors,
 * action factories, and side-effecting flows alike. Over-inclusion is
 * harmless because none of these is ever legal at module scope; a wiring
 * flow frozen at load time is a worse bug than a frozen label, not a false
 * positive. Matching is by call-site name, so one entry covers same-named
 * helpers in different files. New helpers that touch l10n.t belong here.
 *
 * One census limit, so the closure claim stays honest: the census follows
 * bare-identifier calls only. A helper that resolves l10n.t through a
 * module-scope thunk table's PROPERTY call (servers.tsx's
 * INACTIVE_NOTICE_PRESENTATION[notice].surface()) is invisible to that walk
 * and must be registered by hand when added - inactiveSurfacesText is the
 * known case.
 */
export const LAZY_L10N_HELPERS: readonly string[] = [
	"configureNowLabel",
	"hubItems",
	"manageCommandTitle",
	"secretPaletteLabel",
	"numberSettingPresentation",
	"booleanSettingPresentation",
	"settingScopeLabel",
	"serverFormFieldLabel",
	"serverFieldHelp",
	"settingRowHelp",
	"helpServersSection",
	"helpModelsSection",
	"helpParamsInspector",
	"helpSettingsSection",
	"helpModelParametersSection",
	"helpSecretStorage",
	"helpModelParameterPrefix",
	"helpEntryModelParameterPrefix",
	"helpModelParameterName",
	"helpModelParameterValue",
	"parseNumberDraft",
	"defaultDisplay",
	"equivalence",
	"parseJsonValue",
	"formatDuration",
	"keyProblem",
	"firstGroupProblem",
	"recordFromJsonText",
	"parseGroups",
	"parseHeaderRows",
	"parseHeaderRowsDetailed",
	"groupsFromJsonText",
	"parseServerForm",
	"parseServerFormForTest",
	"validateAdoptLabel",
	"sectionFailureText",
	"authMessage",
	"reasoningOnlyResponseMessage",
	"timeoutMessage",
	"timeoutRequestError",
	"upstreamAuthMessage",
	"statusErrorTexts",
	// src/dashboard record-draft and form parsers (localized problems ride the verdicts).
	"parseDirectiveListText",
	"judgeInheritableRow",
	"judgeInheritFromRow",
	"firstCapabilityProblem",
	"capabilityGroupsFromJsonText",
	"consumedInvalidHint",
	"parseCapabilityGroups",
	"directiveListedEntries",
	"directiveMarkedFields",
	"directiveRowAbsorbed",
	"toggleDirectiveField",
	"inheritFromChoice",
	"analyzeServerForm",
	// src/shared presenters, titles, and localized-error constructors.
	"capabilityDisplayLabel",
	"parameterCountText",
	"costUnitLabel",
	"syncModelsCommandTitle",
	"refreshUsageCommandTitle",
	"chatErrorMessage",
	"toolPairingHeadline",
	"validateRequest",
	// src/provider error constructors, catalog presenters, and schema builders.
	"unparseableModelsResponse",
	"coerceJsonPayload",
	"modelListingUnservedError",
	"noEndpointServedError",
	"refineModelsListingFailure",
	"pickerLabel",
	"pickerDescription",
	"reasoningEffortSchema",
	"configurationSchemaFor",
	"buildModelInfos",
	"applyCapabilityOverrides",
	"synthesizeDeclaredModels",
	"twoPartTexts",
	"timeoutError",
	"parseTokenResponse",
	"chatHttpHeadline",
	"discoveryHttpHeadline",
	"streamErrorFrame",
	"mapSdkError",
	// src/extension pure returners (labels, actions, rendered texts).
	"validateNumberSetting",
	"usageHttpError",
	"relativeTimeText",
	"dismissAction",
	"reconfigureAction",
	"reportIssueAction",
	"viewOutputAction",
	"testConnectionAction",
	"troubleshootingDocsAction",
	"notifierErrorActions",
	"commandErrorActions",
	"openChatAction",
	"openSettingsAction",
	"openGroupsFileAction",
	"renderImportPreview",
	"undoImportAction",
	"parseFailureMessage",
	"gateMessage",
	"zeroModelStatusTexts",
	"openUsageAction",
	"serverTooltipLines",
	"renderUsageStatus",
	// The rest of the census: flows, wiring, prompts, and IO that resolve
	// l10n.t on the way. Never legal at module scope either, so listing them
	// closes the census instead of leaving a judgment call open.
	"activate",
	"applyAdoptServer",
	"executeDashboardIntent",
	"applySaveServerSetting",
	"applyTestServerDraft",
	"submitGroupSeed",
	"migrateServersToProviderGroups",
	"showMutationRefusedNotice",
	"canMutateRegistry",
	"runRegistryMutation",
	"promptForServerLabel",
	"promptForBaseUrl",
	"promptForApiKey",
	"warnAboutOrphanedModelParameters",
	"addServerFlow",
	"manageServerFlow",
	"openServerManagement",
	"registerManageCommand",
	"notifyRemovalEvents",
	"createServerSyncEnv",
	"registerSetServerSecretCommand",
	"notifyUsageRefreshFailure",
	"registerRefreshUsageCommand",
	"showZeroModelOutcomeToast",
	"runConnectionTest",
	"registerTestConnectionCommand",
	"runModelSync",
	"runModelSyncPass",
	"registerSyncModelsCommand",
	"runReportIssue",
	"showRepeatReportHint",
	"registerReportIssueCommand",
	"registerOpenGroupsFileCommand",
	"registerHelpAndFeedbackCommand",
	"createIssueReporterEnv",
	"handleOpenSettingKey",
	"registerOpenSettingKeyCommand",
	"createSettingsTransferPrompts",
	"createSettingsTransferEnv",
	"runExportSettingsFlow",
	"applyServersUnit",
	"runImportSettingsFlow",
	"notifyKeptSnapshot",
	"runUndoLastImportFlow",
	"registerSettingsTransferCommands",
	"showSetupProblemGate",
	"wireServers",
	"maybeShowWelcome",
	"wireUiCommands",
	"fetchModels",
	"exchangeClientCredentials",
	// Webview component presenters that resolve l10n.t at call time.
	"relativeTime",
	"formatPricing",
	"pricingNote",
	"metaLine",
	"detailFields",
	"fieldLabel",
	"capabilityList",
	"priceFilterLabel",
	"externalTip",
	"locationName",
	"sectionLabel",
	"toastText",
	"overallState",
	"diagnosticsReportText",
	"modelParametersTitle",
	"skipReasonText",
	"maxTokensParts",
	"lastSync",
	"railSections",
	"diagnosticsCount",
	"severityLabel",
	"recordProblemText",
	"legacyProblemText",
	"docsAction",
	"configProblem",
	"nodeFieldText",
	"treeTitle",
	"paramProvenance",
	"capProvenance",
	"pricingFieldLabel",
	"parameterProvenance",
	"capabilityProvenance",
	"fallbackMark",
	"parameterDiagnosticText",
	"formatValue",
	"capabilityEditLabel",
	"capabilityDiagnosticText",
	"outputLimitNote",
	"settingsScope",
	"entryScope",
	"serverScope",
	"forceWord",
	"fallbackWord",
	"inheritedWord",
	"modelCapabilitiesTitle",
	"numberInputProps",
	"recordListLabel",
	"matcherKindLabel",
	"inheritableWord",
	"chipFlags",
	"chipRowIndices",
	"candidateProblem",
	"troubleshootingLink",
	"expectedFailureLabel",
	"authFormName",
	"matcherCountAside",
	"serverDiagnostics",
	"usageDiagnostics",
	"pillVerdict",
	"neverUpdatedText",
	"stalenessText",
	"spendUnknownText",
	"requestsMissingText",
	"serversMeta",
	"entryInactiveFixText",
	// Thunk-table resolver, hand-registered (see the census limit above).
	"inactiveSurfacesText",
	// Webview help-text and settings-row presenters.
	"helpImportExportGroup",
	"helpConnectionSection",
	"helpDiscoverySection",
	"helpAdoptionSection",
	"helpOauthCompanionApiKey",
	"helpCapabilityPrefix",
	"helpCapabilityName",
	"helpCapabilityValue",
	"helpCatalogPicker",
	"helpFallbackFlag",
	"helpForceFlag",
	"helpForceFlagDisabled",
	"helpInheritableFlag",
	"helpInheritFromControl",
	"helpModelCapabilitiesSection",
	"helpTokenEstimation",
	"helpToolSchemaKeywords",
	"helpCurrencySymbol",
	"helpUiTheme",
	"helpUiAccent",
	"helpCapsInspector",
	"helpConfigDiagnosticsSection",
	"helpResolutionSection",
	"helpSupportSection",
	"usageStatusBarDescription",
	"tokenEstimationDescription",
	"toolSchemaKeywordsDescription",
	"usageThresholdsDescription",
	"currencySymbolDescription",
	"uiThemeDescription",
	"uiAccentDescription",
	"statusBarModeLabel",
	"tokenEstimationLabel",
	"uiThemeLabel",
	"uiAccentLabel",
	"scopeSummary",
	"scalarText",
];

/**
 * Line numbers (1-based) of module-scope localization calls: l10n.t,
 * vscode.l10n.t, or a LAZY_L10N_HELPERS name evaluated while the module
 * loads, before l10n.config has run, freezing the English text. A real parse
 * of everything that evaluates at load time (no deep scope analysis): every
 * top-level statement is searched through object/array literals, templates,
 * as/satisfies wrappers, control flow, and immediately-invoked functions,
 * while function bodies, object-literal methods and accessors, and instance
 * property initializers defer and pass. Class statics do not defer: static
 * property initializers, static blocks, heritage-clause expressions,
 * decorators, and computed member names all run when the class statement
 * does, so they are searched too.
 */
export function moduleScopeL10nOffenses(contents: string, fileName: string): number[] {
	const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const sourceFile = ts.createSourceFile(fileName, contents, ts.ScriptTarget.Latest, false, kind);
	const offenses: number[] = [];

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

	const isStatic = (member: ts.ClassElement): boolean =>
		ts.canHaveModifiers(member) &&
		(ts.getModifiers(member) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword);

	// Walk everything that evaluates at module load. Function bodies are
	// skipped (their calls run later) unless the function is invoked on the
	// spot: an IIFE's callee body evaluates eagerly, so it is walked too.
	const scan = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) {
			const callee = node.expression.getText(sourceFile);
			if (callee === "l10n.t" || callee === "vscode.l10n.t" || LAZY_L10N_HELPERS.includes(callee)) {
				offenses.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
			}
			const invoked = unwrap(node.expression);
			if (ts.isArrowFunction(invoked) || ts.isFunctionExpression(invoked)) {
				scan(invoked.body);
			} else {
				scan(node.expression);
			}
			for (const argument of node.arguments) {
				scan(argument);
			}
			return;
		}
		if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
			for (const decorator of ts.getDecorators(node) ?? []) {
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

	for (const statement of sourceFile.statements) {
		scan(statement);
	}
	return offenses;
}

export interface VscodeL10nRuleOptions {
	/** Whether this file may read `vscode.l10n.bundle` (the two bundle-feeding sites). */
	readonly allowBundleReads: boolean;
	/**
	 * Whether this file may reference a vscode-module binding as a plain value
	 * (the constructor-probe files pass the module object into Reflect-based
	 * probes). Member access rules still apply; `.l10n` stays flagged.
	 */
	readonly allowVscodeValueUse: boolean;
}

/**
 * Line numbers (1-based) of localization forms outside the sanctioned set.
 * This is an allowlist that fails closed, not a catalog of known escapes: the
 * only sanctioned ways to touch the localization surface are the canonical
 * `import * as l10n from "@vscode/l10n"` with direct `l10n.t(...)` (or
 * `l10n.config(...)`) call expressions, ordinary non-l10n member access on a
 * vscode-module binding, `vscode.l10n.bundle` reads in the bundle-feeding
 * files, and type-only forms (erased at runtime). Every other appearance of
 * a tracked binding - aliasing, destructuring, element access, re-exports,
 * facades, shadowing declarations, or any shape this walk has never seen -
 * is flagged by default, so a novel laundering form fails the gate instead
 * of slipping through. The stakes: a form extraction cannot follow (a named
 * `{ t }` import, `l10n["t"]`, an aliased `t`) ships permanently
 * untranslated strings that no drift check can see, and a renamed namespace
 * would extract but breaks the one greppable shape. Matching is syntactic,
 * not scope-resolved, so a local binding shadowing a tracked name flags too;
 * rename it or add a deliberate allowlist entry here.
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

	// Parens and type wrappers do not change what evaluates; unwrap them so
	// `(vscode).l10n` or `const loc = (l10n as typeof l10n)` cannot slip by.
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
				// import x = <entity>: an alias of whatever the entity names.
				// Off a vscode binding, a non-l10n member alias (import Uri =
				// vscode.Uri) is classifiable and fine; the whole namespace or
				// anything through .l10n is not. Off the canonical binding,
				// every alias breaks the one canonical call shape.
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
		// nothing looser, so a wrapped or optional variant falls through to
		// the catch-all instead.
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
		// while still walking its initializer, body, and computed names.
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
