import os from "node:os";
import path from "node:path";
import { defineConfig } from "@vscode/test-cli";

// Per-label isolation; VS Code's IPC socket lives inside this dir and must fit macOS's ~104-byte AF_UNIX path cap.
const launchArgsFor = (label) => [
	"--user-data-dir",
	process.env.VSCODE_TEST_USER_DATA_DIR
		? path.join(process.env.VSCODE_TEST_USER_DATA_DIR, label)
		: path.join(os.tmpdir(), `lvt-${process.pid}-${label}`),
];

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
			// Positive globs and literals only: the installed @vscode/test-cli
			// ignores "!" negations in files globs, so exclusion works by
			// directory layout instead. Suites that need their own host
			// (activation-production, host-fidelity) or a running stack (the
			// docker suites at the out/test root, listed by literal name in
			// their own labels) are simply never matched here. stackDrift's
			// label-coverage guard walks out/test and fails the suite when a
			// compiled test file is matched by zero labels or by more than one.
			files: [
				"out/test/dockerTestLabels.test.js",
				"out/test/envFile.test.js",
				"out/test/fuzzSeed.test.js",
				"out/test/scenarios.test.js",
				"out/test/stackDrift.test.js",
				"out/test/fakeStack/*.test.js",
				"out/test/shared/*.test.js",
				"out/test/shared/config/*.test.js",
				"out/test/shared/conversion/*.test.js",
				"out/test/shared/util/*.test.js",
				"out/test/provider/*.test.js",
				"out/test/provider/catalog/*.test.js",
				"out/test/provider/transport/*.test.js",
				"out/test/extension/*.test.js",
				"out/test/extension/dashboard/*.test.js",
				"out/test/extension/migrations/*.test.js",
				"out/test/extension/servers/*.test.js",
				"out/test/extension/ui/*.test.js",
			],
			mocha: {
				ui: "tdd",
				timeout: 20000,
				color: true,
			},
			env: {
				FUZZ_RUNS: process.env.FUZZ_RUNS || "",
				FUZZ_SEED: process.env.FUZZ_SEED || "",
			},
			launchArgs: launchArgsFor("unit"),
		},
		{
			// Its own label and host: the file calls the compiled activate() with a
			// fake Production-mode context, which registers the real litellm.*
			// command IDs - it can never share a host with the activated extension.
			label: "activation-production",
			files: "out/test/activation/production.test.js",
			mocha: {
				ui: "tdd",
				timeout: 30000,
				color: true,
			},
			launchArgs: launchArgsFor("activation-production"),
		},
		{
			label: "host-fidelity",
			files: "out/test/hostFidelity/host-fidelity.test.js",
			mocha: {
				ui: "tdd",
				timeout: 30000,
				color: true,
			},
			env: {
				LITELLM_REAL_LIVE: process.env.LITELLM_REAL_LIVE || "",
				LITELLM_REAL_BASE_URL: process.env.LITELLM_REAL_BASE_URL || "",
				LITELLM_REAL_API_KEY: process.env.LITELLM_REAL_API_KEY || "",
				LITELLM_REAL_MODEL: process.env.LITELLM_REAL_MODEL || "",
				LITELLM_REAL_TIMEOUT: process.env.LITELLM_REAL_TIMEOUT || "",
			},
			launchArgs: launchArgsFor("host-fidelity"),
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
			launchArgs: launchArgsFor("docker"),
		},
		{
			label: "docker-transport",
			files: "out/test/docker-transport.test.js",
			mocha: {
				ui: "tdd",
				timeout: 120000,
				color: true,
			},
			env: {
				LITELLM_DOCKER_BASE_URL: process.env.LITELLM_DOCKER_BASE_URL || "",
				LITELLM_DOCKER_API_KEY: process.env.LITELLM_DOCKER_API_KEY || "",
				LITELLM_DOCKER_FAKE_URL: process.env.LITELLM_DOCKER_FAKE_URL || "",
			},
			launchArgs: launchArgsFor("docker-transport"),
		},
		{
			label: "docker-serversync",
			files: "out/test/docker-serversync.test.js",
			mocha: {
				ui: "tdd",
				timeout: 120000,
				color: true,
			},
			env: {
				LITELLM_DOCKER_BASE_URL: process.env.LITELLM_DOCKER_BASE_URL || "",
				LITELLM_DOCKER_API_KEY: process.env.LITELLM_DOCKER_API_KEY || "",
				LITELLM_DOCKER_FAKE_URL: process.env.LITELLM_DOCKER_FAKE_URL || "",
			},
			launchArgs: launchArgsFor("docker-serversync"),
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
			launchArgs: launchArgsFor("docker-fuzz"),
		},
		{
			label: "docker-conversation",
			files: "out/test/docker-conversation.test.js",
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
				CONVERSATION_ITERATIONS: process.env.CONVERSATION_ITERATIONS || "",
			},
			launchArgs: launchArgsFor("docker-conversation"),
		},
		{
			label: "docker-monkey",
			files: "out/test/docker-monkey.test.js",
			mocha: {
				ui: "tdd",
				// Whole-walk tests; the suite raises its own per-test budgets on top.
				timeout: 300000,
				color: true,
			},
			env: {
				LITELLM_DOCKER_BASE_URL: process.env.LITELLM_DOCKER_BASE_URL || "",
				LITELLM_DOCKER_API_KEY: process.env.LITELLM_DOCKER_API_KEY || "",
				LITELLM_DOCKER_FAKE_URL: process.env.LITELLM_DOCKER_FAKE_URL || "",
				FUZZ_SEED: process.env.FUZZ_SEED || "",
				FUZZ_SHARD: process.env.FUZZ_SHARD || "",
				MONKEY_ITERATIONS: process.env.MONKEY_ITERATIONS || "",
			},
			launchArgs: launchArgsFor("docker-monkey"),
		},
	],
});
