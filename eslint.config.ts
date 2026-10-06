import tseslint from "typescript-eslint";
import { outputChannelWrites } from "./scripts/lint/outputChannelWrites";
import { type AllowedRead, userTextReaders } from "./scripts/lint/userTextReaders";

/**
 * Biome owns formatting and every check it has a rule for. This config carries what Biome cannot express: the promise
 * rules that need the type checker (VS Code APIs return Thenables, which Biome's rule cannot see), the two local rules
 * that judge a call by the declaration it resolves to, and the restricted-syntax rules, which need AST selectors.
 */
const litellm = { rules: { "output-channel-writes": outputChannelWrites, "user-text-readers": userTextReaders } };
const promiseRules = {
	"@typescript-eslint/no-floating-promises": ["error", { checkThenables: true }],
	"@typescript-eslint/no-misused-promises": "error",
	"@typescript-eslint/await-thenable": "error",
} as const;

const REPO_ROOT_FIX =
	"Repository paths under src/test come from REPO_ROOT: import it from src/test/util/repoRoot.ts and " +
	"path.join(REPO_ROOT, ...). Importing the marker is what makes the pre-commit selection run the suite on any " +
	"staged change.";

/** Every extension bun runs as a suite or a helper (BUN_TEST_FILE in src/test/runtimeImportGraph.ts). */
const TEST_FILES = "src/test/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}";

const SOURCE_FILES = "src/**/*.{ts,tsx,mts,cts}";

/**
 * The settings readers: where a user's text is taken in, so a trim or number read there must go through the two homes
 * (src/shared/util/headers.ts, src/shared/util/decimalText.ts). The homes are not listed: every read inside them is the
 * rule itself.
 */
const READER_MODULES = [
	"src/shared/config/**/*.{ts,tsx,mts,cts}",
	"src/extension/servers/serverSync/setting.ts",
	"src/dashboard/**/*.{ts,tsx,mts,cts}",
	"src/extension/settingsTransfer/**/*.{ts,tsx,mts,cts}",
	"src/extension/dashboard/state.ts",
	"src/extension/dashboard/entryAuth.ts",
	"src/extension/ui/settingsTransferCommands.ts",
	"src/provider/catalog/groupModels.ts",
];

/** A read that is not user text, by file and the function holding it; the rule refuses a row no read matches. */
const ALLOWED_READS: AllowedRead[] = [
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

/**
 * Text leaves the extension through one door per surface, where Logger.redact runs once. Each entry is a VS Code API,
 * the files allowed to call it, and the door to call instead. A flat config replaces a rule's whole option list per
 * file, so the entries are composed per door: every other file bans all of them, and a door bans all but its own.
 */
const DOORS = [
	{
		doors: ["src/extension/ui/notifier.ts"],
		properties: ["showErrorMessage", "showWarningMessage", "showInformationMessage"],
		selectors: [],
		message:
			"A toast leaves through showMessage or showActionableMessage in src/extension/ui/notifier.ts, which masks " +
			"credentials once.",
	},
	{
		doors: ["src/extension/ui/clipboard.ts"],
		properties: [],
		// The webview copies a model id through navigator.clipboard; that is browser API over pushed state, not an exit.
		// Both member names match as identifiers and as literal keys, so clipboard["writeText"] is a hit too.
		selectors: [
			'MemberExpression:matches([property.name="writeText"], [property.value="writeText"])' +
				':matches([object.property.name="clipboard"], [object.property.value="clipboard"])' +
				':not([object.object.name="navigator"])',
		],
		message:
			"The clipboard is written through copyToClipboard in src/extension/ui/clipboard.ts, which masks credentials " +
			"once.",
	},
	{
		// A tool exit's text is masked upstream (agentTools/render.ts); the processor masks the one part it builds whole
		// (the Sources trailer), while refusal and content deltas arrive in token-sized pieces no mask can judge.
		doors: ["src/extension/features/modelFacingExit.ts", "src/provider/transport/streaming/processor.ts"],
		properties: [],
		selectors: [
			'NewExpression[callee.property.name="LanguageModelTextPart"]',
			'NewExpression[callee.property.value="LanguageModelTextPart"]',
			'NewExpression[callee.name="LanguageModelTextPart"]',
		],
		message:
			"A model-facing text part is built by src/extension/features/modelFacingExit.ts (tool exits) or " +
			"src/provider/transport/streaming/processor.ts (chat replies), nowhere else.",
	},
] as const;

const DOOR_FILES = [...new Set(DOORS.flatMap((entry) => entry.doors))];

function restrictedApiRules(file?: string) {
	const applicable = DOORS.filter((entry) => file === undefined || !(entry.doors as readonly string[]).includes(file));
	return {
		"no-restricted-properties": [
			"error",
			...applicable.flatMap((entry) => entry.properties.map((property) => ({ property, message: entry.message }))),
		],
		"no-restricted-syntax": [
			"error",
			...applicable.flatMap((entry) => entry.selectors.map((selector) => ({ selector, message: entry.message }))),
		],
	};
}

export default tseslint.config(
	{
		files: [SOURCE_FILES],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		plugins: {
			"@typescript-eslint": tseslint.plugin,
		},
		rules: promiseRules,
	},
	{
		files: ["scripts/**/*.ts", "scripts/**/*.mts"],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				project: "./tsconfig.scripts.json",
				tsconfigRootDir: import.meta.dirname,
			},
		},
		plugins: {
			"@typescript-eslint": tseslint.plugin,
		},
		rules: promiseRules,
	},
	{
		// Importing src/test/util/repoRoot.ts declares that a suite reads the repository as data, and the pre-commit
		// selection (scripts/dev/changedBunTests.ts) runs every suite whose imports reach it on any staged change. A suite
		// deriving a repository path from its own module location instead reads the repository undeclared: a staged edit
		// to a file it reads commits with the hook green while the suite is red.
		files: [TEST_FILES],
		ignores: ["src/test/util/repoRoot.ts"],
		languageOptions: { parser: tseslint.parser },
		rules: {
			// The identifier in any position, not the global: `declare const __dirname: string` would otherwise shadow it.
			"no-restricted-syntax": [
				"error",
				{ selector: "Identifier[name=/^__(dirname|filename)$/]", message: REPO_ROOT_FIX },
				{
					selector:
						'MemberExpression[object.type="MetaProperty"][object.meta.name="import"][object.property.name="meta"]' +
						"[property.name=/^(dir|dirname|file|filename|path)$/]",
					message: REPO_ROOT_FIX,
				},
			],
		},
	},
	{
		// The Logger is the one writer, so the rule is off there; the wiring file may only create the channel.
		files: [SOURCE_FILES],
		ignores: ["src/test/**", "src/shared/logger.ts"],
		plugins: { litellm },
		rules: { "litellm/output-channel-writes": "error" },
	},
	{
		files: ["src/extension.ts"],
		rules: { "litellm/output-channel-writes": ["error", { allow: ["createOutputChannel"] }] },
	},
	{
		files: READER_MODULES,
		rules: { "litellm/user-text-readers": ["error", { allow: ALLOWED_READS }] },
	},
	{
		files: [SOURCE_FILES],
		ignores: ["src/test/**", ...DOOR_FILES],
		rules: restrictedApiRules(),
	},
	...DOOR_FILES.map((file) => ({ files: [file], rules: restrictedApiRules(file) }))
);
