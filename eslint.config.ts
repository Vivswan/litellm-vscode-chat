import tseslint from "typescript-eslint";

/**
 * Biome owns formatting and every check it has a rule for. This config carries what Biome cannot express: the promise
 * rules that need the type checker (VS Code APIs return Thenables, which Biome's rule cannot see) and the
 * restricted-API rules, which need AST selectors and per-property bans.
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

const LOGGER_FIX =
	"Output-channel text is written only by src/shared/logger.ts, where redaction lives; route this through the Logger.";

const WIRING_FIX = "src/extension.ts creates the one output channel and hands it to the Logger.";

/**
 * A member that writes to the output channel, judged by name: appendLine belongs to the channel alone, while append,
 * replace, clear, and the five log levels are shared with Headers, String, Map, and the Logger, so those count only on
 * a receiver named like a channel: `channel.append(...)`, `holder.channel.append(...)`, and either behind one `!` or
 * `as` assertion.
 */
const CHANNEL_RECEIVER = /[cC]hannel$/;
const CHANNEL_WRITE_MEMBER = /^(append|replace|clear|trace|debug|info|warn|error)$/;
const CHANNEL_WRITE_SELECTOR = `:matches(${["object", "object.expression"]
	.flatMap((receiver) => [`${receiver}.name`, `${receiver}.property.name`])
	.map((attribute) => `MemberExpression[${attribute}=${CHANNEL_RECEIVER}]`)
	.join(", ")})[property.name=${CHANNEL_WRITE_MEMBER}]`;

/** Every extension bun runs as a suite or a helper (BUN_TEST_FILE in src/test/runtimeImportGraph.ts). */
const TEST_FILES = "src/test/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}";

/**
 * Each entry is an API and the one file allowed to call it. A flat config replaces a rule's whole option list per
 * file, so the entries are composed per door: every other file bans all of them, and a door bans all but its own.
 */
const DOORS = [
	{
		door: "src/shared/logger.ts",
		properties: ["appendLine"],
		selectors: [CHANNEL_WRITE_SELECTOR],
		message: LOGGER_FIX,
	},
	{ door: "src/extension.ts", properties: ["createOutputChannel"], selectors: [], message: WIRING_FIX },
] as const;

function restrictedApiRules(exclude?: (typeof DOORS)[number]) {
	const applicable = DOORS.filter((entry) => entry !== exclude);
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
		files: ["src/**/*.{ts,tsx,mts,cts}"],
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
		files: ["src/**/*.{ts,tsx,mts,cts}"],
		ignores: ["src/test/**", ...DOORS.map((entry) => entry.door)],
		rules: restrictedApiRules(),
	},
	...DOORS.map((entry) => ({ files: [entry.door], rules: restrictedApiRules(entry) }))
);
