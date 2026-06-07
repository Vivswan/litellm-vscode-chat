import { defineConfig } from "@vscode/test-cli";
import os from "node:os";
import path from "node:path";

const userDataDir = process.env.VSCODE_TEST_USER_DATA_DIR || path.join(os.tmpdir(), `litellm-vscode-test-${process.pid}`);
const launchArgs = ["--user-data-dir", userDataDir];

export default defineConfig([
	{
		label: "unit",
		files: [
			"out/test/*.test.js",
			"out/test/shared/*.test.js",
			"out/test/provider/*.test.js",
			"out/test/extension/*.test.js",
			"!out/test/host-fidelity.test.js",
		],
		mocha: {
			ui: "tdd",
			timeout: 20000,
			color: true,
		},
		launchArgs,
	},
	{
		label: "host-fidelity",
		files: "out/test/host-fidelity.test.js",
		mocha: {
			ui: "tdd",
			timeout: 30000,
			color: true,
		},
		env: {
			LITELLM_REAL_BASE_URL: process.env.LITELLM_REAL_BASE_URL || "",
			LITELLM_REAL_API_KEY: process.env.LITELLM_REAL_API_KEY || "",
			LITELLM_REAL_MODEL: process.env.LITELLM_REAL_MODEL || "",
			LITELLM_REAL_TIMEOUT: process.env.LITELLM_REAL_TIMEOUT || "",
		},
		launchArgs,
	},
]);
