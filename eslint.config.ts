import tseslint from "typescript-eslint";
import { outputChannelWrites } from "./scripts/lint/outputChannelWrites";

/**
 * Biome owns formatting and every check it has a rule for. This config carries what Biome cannot express: the promise
 * rules that need the type checker (VS Code APIs return Thenables, which Biome's rule cannot see), the one local rule
 * that judges a receiver by its vscode type, and the restricted-syntax rule, which needs AST selectors.
 */
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
		plugins: { litellm: { rules: { "output-channel-writes": outputChannelWrites } } },
		rules: { "litellm/output-channel-writes": "error" },
	},
	{
		files: ["src/extension.ts"],
		rules: { "litellm/output-channel-writes": ["error", { allow: ["createOutputChannel"] }] },
	}
);
