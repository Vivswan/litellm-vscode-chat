import { defineConfig } from "@vscode/test-cli";

export default defineConfig([
	{
		label: "unit",
		files: "out/test/**/*.test.js",
		mocha: {
			ui: "tdd",
			timeout: 20000,
			color: true,
		},
	},
	{
		label: "real",
		files: "out/test/provider.real.test.js",
		mocha: {
			ui: "tdd",
			timeout: 60000,
			color: true,
		},
		env: {
			LITELLM_REAL_BASE_URL: process.env.LITELLM_REAL_BASE_URL || "",
			LITELLM_REAL_API_KEY: process.env.LITELLM_REAL_API_KEY || "",
			LITELLM_REAL_MODEL: process.env.LITELLM_REAL_MODEL || "",
		},
	},
]);
