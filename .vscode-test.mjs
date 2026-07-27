import os from "node:os";
import path from "node:path";
import { defineConfig } from "@vscode/test-cli";

const userDataDir =
	process.env.VSCODE_TEST_USER_DATA_DIR || path.join(os.tmpdir(), `litellm-vscode-test-${process.pid}`);
const launchArgs = ["--user-data-dir", userDataDir];

export default defineConfig({
	coverage: {
		include: ["**/out/**", "**/dist/**"],
		exclude: ["**/out/test/**", "**/node_modules/**"],
		reporter: ["text-summary", "json-summary"],
		output: "./coverage",
	},
	tests: [
		{
			label: "unit",
			files: [
				"out/test/*.test.js",
				"out/test/shared/*.test.js",
				"out/test/provider/*.test.js",
				"out/test/extension/*.test.js",
				"out/test/extension/dashboard/*.test.js",
				"!out/test/host-fidelity.test.js",
				"!out/test/docker-litellm.test.js",
				"!out/test/docker-fuzz.test.js",
			],
			mocha: {
				ui: "tdd",
				timeout: 20000,
				color: true,
			},
			env: {
				FUZZ_RUNS: process.env.FUZZ_RUNS || "",
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
		{
			label: "docker",
			files: "out/test/docker-litellm.test.js",
			mocha: {
				ui: "tdd",
				timeout: 60000,
				color: true,
			},
			env: {
				LITELLM_DOCKER_BASE_URL: process.env.LITELLM_DOCKER_BASE_URL || "",
				LITELLM_DOCKER_API_KEY: process.env.LITELLM_DOCKER_API_KEY || "",
				LITELLM_DOCKER_FAKE_URL: process.env.LITELLM_DOCKER_FAKE_URL || "",
			},
			launchArgs,
		},
		{
			label: "docker-fuzz",
			files: "out/test/docker-fuzz.test.js",
			mocha: {
				ui: "tdd",
				timeout: 120000,
				color: true,
			},
			env: {
				LITELLM_DOCKER_BASE_URL: process.env.LITELLM_DOCKER_BASE_URL || "",
				LITELLM_DOCKER_API_KEY: process.env.LITELLM_DOCKER_API_KEY || "",
				LITELLM_DOCKER_FAKE_URL: process.env.LITELLM_DOCKER_FAKE_URL || "",
				FUZZ_SEED: process.env.FUZZ_SEED || "",
				FUZZ_ITERATIONS: process.env.FUZZ_ITERATIONS || "",
				FUZZ_SHARD: process.env.FUZZ_SHARD || "",
			},
			launchArgs,
		},
	],
});
