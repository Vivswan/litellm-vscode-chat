import tseslint from "typescript-eslint";

/**
 * Type-aware rules only. Biome owns formatting and everything it can check
 * syntactically; this config exists for the promise rules that need the type
 * checker (VS Code APIs return Thenables, which Biome's rule cannot see).
 */
const promiseRules = {
	"@typescript-eslint/no-floating-promises": ["error", { checkThenables: true }],
	"@typescript-eslint/no-misused-promises": "error",
	"@typescript-eslint/await-thenable": "error",
} as const;

export default tseslint.config(
	{
		files: ["src/**/*.ts", "src/**/*.tsx"],
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
	}
);
