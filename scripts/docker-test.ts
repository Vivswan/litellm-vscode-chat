#!/usr/bin/env bun
// scripts/docker-test.ts
// Runs the docker-stack test suites against the dockerized LiteLLM proxy:
// brings the compose stack up, runs the `docker` label, then optionally the
// `docker-transport`, `docker-serversync`, `docker-fuzz`, and
// `docker-conversation` labels, then the host-fidelity live suite pointed at
// the stack, then the `docker-monkey` label last (it deliberately dirties
// host state), and tears everything down. --only replaces that selection
// with an explicit label list (the CI shards use it); the order stays
// canonical either way.
//
// Usage:
//   bun run test:docker                     docker suite + transport + serversync + fuzzer + conversations + host-fidelity live + monkey
//   bun run test:docker --skip-transport    skip the transport-failure suite
//   bun run test:docker --skip-serversync   skip the server-sync provider-group suite
//   bun run test:docker --skip-fuzz         skip the stream fuzzer
//   bun run test:docker --skip-conversation skip the multi-turn conversation suite
//   bun run test:docker --skip-monkey       skip the interaction (monkey) fuzzer
//   bun run test:docker --only docker,docker-monkey  run only the listed labels, in the canonical order above
//   FUZZ_ITERATIONS=100 bun run test:docker larger fuzz budget (default 10)
//   CONVERSATION_ITERATIONS=50 bun run test:docker larger conversation budget (default 10)
//   MONKEY_ITERATIONS=40 bun run test:docker larger monkey-walk budget (default 5)
//   bun run test:docker --skip-host-fidelity
//   KEEP_DOCKER_STACK=1 bun run test:docker leave the stack running afterward

import { execSync } from "node:child_process";
import { DOCKER_TEST_LABELS, type DockerTestLabel, parseOnlyLabels } from "../src/test/dockerTestLabels";
import { PLAYBACK_MODEL } from "../src/test/fakeStack/models";
import { resolveComposeCommand } from "./composeCommand";
import { composeSetting, ensureGeneratedConfig, readEnvFile, STACK_DEFAULTS } from "./litellmConfig";

const args = process.argv.slice(2);

const usageError = (message: string): never => {
	console.error(message);
	process.exit(2);
};

// --skip-* carves legs out of the default full run; --only replaces the
// selection outright (the CI shards use it), so combining the two has no
// coherent meaning and errors. The base `docker` label has no skip flag.
const SKIP_FLAGS: Partial<Record<DockerTestLabel, string>> = {
	"docker-transport": "--skip-transport",
	"docker-serversync": "--skip-serversync",
	"docker-fuzz": "--skip-fuzz",
	"docker-conversation": "--skip-conversation",
	"host-fidelity": "--skip-host-fidelity",
	"docker-monkey": "--skip-monkey",
};

function selectLabels(): ReadonlySet<DockerTestLabel> {
	const onlyFlags = args.filter((arg) => arg === "--only" || arg.startsWith("--only="));
	if (onlyFlags.length === 0) {
		return new Set(
			DOCKER_TEST_LABELS.filter((label) => {
				const flag = SKIP_FLAGS[label];
				return flag === undefined || !args.includes(flag);
			})
		);
	}
	const skips = args.filter((arg) => arg.startsWith("--skip-"));
	if (skips.length > 0) {
		usageError(`--only cannot be combined with ${skips.join(", ")}; list the labels to run instead.`);
	}
	if (onlyFlags.length > 1) {
		usageError("--only was given more than once; pass a single comma-separated list.");
	}
	const flag = onlyFlags[0] as string;
	const value = flag === "--only" ? args[args.indexOf("--only") + 1] : flag.slice("--only=".length);
	if (value === undefined || value.startsWith("--")) {
		usageError(`--only needs a comma-separated label list; known labels: ${DOCKER_TEST_LABELS.join(", ")}`);
	}
	try {
		return new Set(parseOnlyLabels(value));
	} catch (error) {
		return usageError(error instanceof Error ? error.message : String(error));
	}
}

const selected = selectLabels();

// The suite must agree with docker-compose on ports and key, so it resolves
// them with the same ${VAR:-fallback} semantics compose uses.
const envFile = readEnvFile();
const setting = (key: string, fallback: string): string => composeSetting(key, fallback, envFile);

const litellmPort = setting("LITELLM_PORT", STACK_DEFAULTS.LITELLM_PORT);
const fakePort = setting("FAKE_OPENAI_PORT", STACK_DEFAULTS.FAKE_OPENAI_PORT);
const masterKey = setting("LITELLM_MASTER_KEY", STACK_DEFAULTS.LITELLM_MASTER_KEY);
const baseUrl = `http://localhost:${litellmPort}`;
const fakeUrl = `http://localhost:${fakePort}`;

const compose = resolveComposeCommand().join(" ");
const run = (command: string, env: Record<string, string> = {}): void => {
	execSync(command, { stdio: "inherit", env: { ...process.env, ...env } });
};

let failed = false;
try {
	// Test config is always generated without real-provider wildcards, so a
	// developer's keys in .env cannot change the model list under test, and
	// --force-recreate makes a stack already running with a different config
	// pick this one up instead of poisoning the run.
	ensureGeneratedConfig({ realProviders: false });
	console.log(`\nStarting the LiteLLM stack via "${compose}"...`);
	run(`${compose} up -d --wait --wait-timeout 120 --force-recreate`);

	const suiteEnv = {
		LITELLM_DOCKER_BASE_URL: baseUrl,
		LITELLM_DOCKER_API_KEY: masterKey,
		LITELLM_DOCKER_FAKE_URL: fakeUrl,
	};

	run("bun run compile && bun run bundle:dev");

	// One entry per label, keyed on the full set (Record, not Partial) so a
	// label added to DOCKER_TEST_LABELS cannot compile without a leg to run.
	// Each label gets its own fresh extension host; that isolation is
	// load-bearing for docker-serversync (its provider groups are add-only
	// for the host lifetime) and docker-monkey (walks deliberately dirty
	// host state), which is also why monkey sits last in the canonical
	// order.
	const legs: Record<DockerTestLabel, { banner: string; env: Record<string, string> }> = {
		docker: { banner: "Running the docker suite...", env: suiteEnv },
		"docker-transport": { banner: "Running the transport-failure suite...", env: suiteEnv },
		"docker-serversync": { banner: "Running the server-sync suite...", env: suiteEnv },
		"docker-fuzz": { banner: "Running the stream fuzzer...", env: suiteEnv },
		"docker-conversation": { banner: "Running the multi-turn conversation suite...", env: suiteEnv },
		"host-fidelity": {
			banner: "Running the host-fidelity live suite against the stack...",
			env: {
				LITELLM_REAL_LIVE: "1",
				LITELLM_REAL_BASE_URL: baseUrl,
				LITELLM_REAL_API_KEY: masterKey,
				LITELLM_REAL_MODEL: PLAYBACK_MODEL.alias,
			},
		},
		"docker-monkey": { banner: "Running the interaction (monkey) fuzzer...", env: suiteEnv },
	};

	for (const label of DOCKER_TEST_LABELS) {
		if (!selected.has(label)) {
			continue;
		}
		console.log(`\n${legs[label].banner}`);
		run(`vscode-test --config .vscode-test.mjs --label ${label}`, legs[label].env);
	}
} catch (error) {
	failed = true;
	console.error("\nDocker test run failed; recent LiteLLM logs:");
	try {
		run(`${compose} logs litellm --tail 100`);
	} catch {
		// Logs are best-effort; the original failure is what matters.
	}
	const status = (error as { status?: number }).status;
	process.exitCode = status ?? 1;
} finally {
	if (process.env.KEEP_DOCKER_STACK === "1") {
		console.log(`\nKEEP_DOCKER_STACK=1: stack left running at ${baseUrl} (fake backend at ${fakeUrl})`);
	} else {
		try {
			run(`${compose} down -v`);
		} catch (teardownError) {
			// Teardown noise must not replace the original test failure.
			console.error(`Teardown failed: ${String(teardownError)}`);
			process.exitCode ??= 1;
		}
	}
	if (failed) {
		process.exit(process.exitCode ?? 1);
	}
}
