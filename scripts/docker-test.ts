#!/usr/bin/env bun
// scripts/docker-test.ts
// Runs the docker-stack test suites against the dockerized LiteLLM proxy:
// brings the compose stack up (postgres-backed, with the usage/budget fixture
// key seeded), runs the selected labels in the canonical order of
// src/test/dockerTestLabels.ts (docker-monkey last - it deliberately dirties
// host state), and tears everything down. --only replaces the default
// selection with an explicit label list (the CI shards use it); the order
// stays canonical either way.
//
// Usage:
//   bun run test:docker                     every label in canonical order (see src/test/dockerTestLabels.ts)
//   bun run test:docker --skip-usage        skip the usage/budget smoke suite
//   bun run test:docker --skip-transport    skip the transport-failure suite
//   bun run test:docker --skip-serversync   skip the server-sync provider-group suite
//   bun run test:docker --skip-resolution   skip the catalog/record resolution suite
//   bun run test:docker --skip-fuzz         skip the stream fuzzer
//   bun run test:docker --skip-conversation skip the multi-turn conversation suite
//   bun run test:docker --skip-group-path   skip the provider-group chat path suite
//   bun run test:docker --skip-monkey       skip the interaction (monkey) fuzzer
//   bun run test:docker --only docker,docker-monkey  run only the listed labels, in the canonical order above
//   FUZZ_ITERATIONS=100 bun run test:docker larger fuzz budget (default 10)
//   CONVERSATION_ITERATIONS=50 bun run test:docker larger conversation budget (default 10)
//   MONKEY_ITERATIONS=40 bun run test:docker larger monkey-walk budget (default 5)
//   bun run test:docker --skip-host-fidelity
//   bun run test:docker --skip-host-fidelity-groups
//   KEEP_DOCKER_STACK=1 bun run test:docker leave the stack running afterward

import { execSync } from "node:child_process";
import {
	DOCKER_SKIP_FLAGS,
	DOCKER_TEST_LABELS,
	type DockerTestLabel,
	parseOnlyLabels,
} from "../src/test/dockerTestLabels";
import { PLAYBACK_MODEL } from "../src/test/fakeStack/models";
import { resolveComposeCommand, runCompose } from "./stack/composeCommand";
import { composeSetting, ensureGeneratedConfig, readEnvFile, STACK_DEFAULTS } from "./stack/litellmConfig";
import { seedStackUsageBudgetKey } from "./stack/seedUsage";

const args = process.argv.slice(2);

const usageError = (message: string): never => {
	console.error(message);
	process.exit(2);
};

// --skip-* carves legs out of the default full run; --only replaces the
// selection outright, so combining the two has no coherent meaning and errors.
// The flag-per-label mapping lives in src/test/dockerTestLabels.ts so the
// nightly-fuzz drift guard reads the same source; `docker` has no skip flag.
const KNOWN_SKIP_FLAGS: ReadonlySet<string> = new Set(Object.values(DOCKER_SKIP_FLAGS));

/**
 * Reject any argv token this script does not understand: a mistyped skip flag
 * would otherwise run the leg it meant to skip, and extra positionals after
 * `--only a` would be dropped without a word. Exit 2 names the vocabulary.
 */
function validateArgs(): void {
	// The value a bare `--only` consumes is validated by parseOnlyLabels, not
	// as a standalone token here.
	const onlyValueIndexes = new Set(args.flatMap((arg, index) => (arg === "--only" ? [index + 1] : [])));
	for (const [index, arg] of args.entries()) {
		if (onlyValueIndexes.has(index) || arg === "--only" || arg.startsWith("--only=")) {
			continue;
		}
		if (arg.startsWith("--skip-")) {
			if (!KNOWN_SKIP_FLAGS.has(arg)) {
				usageError(`unknown flag "${arg}"; known skip flags: ${[...KNOWN_SKIP_FLAGS].join(", ")}`);
			}
			continue;
		}
		usageError(
			`unexpected argument "${arg}"; pass --only with ONE comma-separated label list (no spaces), or --skip-* flags: ${[
				...KNOWN_SKIP_FLAGS,
			].join(", ")}`
		);
	}
}

function selectLabels(): ReadonlySet<DockerTestLabel> {
	validateArgs();
	const onlyFlags = args.filter((arg) => arg === "--only" || arg.startsWith("--only="));
	if (onlyFlags.length === 0) {
		return new Set(
			DOCKER_TEST_LABELS.filter((label) => {
				const flag = DOCKER_SKIP_FLAGS[label];
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

// Resolved eagerly so a missing runtime fails before any work; the resolution
// is memoized, so every compose call below reuses this same runtime.
const composeDisplay = resolveComposeCommand().join(" ");
const run = (command: string, env: Record<string, string> = {}): void => {
	execSync(command, { stdio: "inherit", env: { ...process.env, ...env } });
};
// Compose goes through the shared no-shell executor (runCompose), so a quoted
// COMPOSE_CMD behaves identically here and in scripts/stack/compose.ts. A
// non-zero exit throws with `status`, keeping execSync's error shape for the
// catch and teardown paths.
const compose = (...composeArgs: string[]): void => {
	const status = runCompose(composeArgs);
	if (status !== 0) {
		throw Object.assign(new Error(`${composeDisplay} ${composeArgs.join(" ")} exited with status ${status}`), {
			status,
		});
	}
};

let failed = false;
async function main(): Promise<void> {
	try {
		// Test config is always generated without real-provider wildcards, so a
		// developer's keys in .env cannot change the model list under test, and
		// --force-recreate makes a stack already running with a different config
		// pick this one up instead of poisoning the run.
		ensureGeneratedConfig({ realProviders: false });
		console.log(`\nStarting the LiteLLM stack via "${composeDisplay}"...`);
		// 180 over the litellm healthcheck's 90s start_period: --wait-timeout is
		// hard wall clock, so a cold runner's first-boot prisma migration needs
		// real headroom before the shard dies.
		compose("up", "-d", "--wait", "--wait-timeout", "180", "--force-recreate");

		// The usage/budget fixture key must exist before any suite runs: the
		// docker-usage smoke suite reads it directly, later usage suites spend
		// through it, and --force-recreate wiped the DB (tmpfs), so this always
		// starts from spend 0.
		await seedStackUsageBudgetKey();

		const suiteEnv = {
			LITELLM_DOCKER_BASE_URL: baseUrl,
			LITELLM_DOCKER_API_KEY: masterKey,
			LITELLM_DOCKER_FAKE_URL: fakeUrl,
		};

		run("bun run compile && bun run bundle:dev");

		// One entry per label, keyed on the full set (Record, not Partial) so a
		// label added to DOCKER_TEST_LABELS cannot compile without a leg to run.
		// Each label gets its own fresh extension host, which is load-bearing for
		// docker-serversync (provider groups are add-only for the host lifetime)
		// and docker-monkey (walks deliberately dirty host state).
		const legs: Record<DockerTestLabel, { banner: string; env: Record<string, string> }> = {
			docker: { banner: "Running the docker suite...", env: suiteEnv },
			"docker-usage": { banner: "Running the usage/budget smoke suite...", env: suiteEnv },
			"docker-transport": { banner: "Running the transport-failure suite...", env: suiteEnv },
			"docker-serversync": { banner: "Running the server-sync suite...", env: suiteEnv },
			"docker-resolution": { banner: "Running the catalog/record resolution suite...", env: suiteEnv },
			"docker-fuzz": { banner: "Running the stream fuzzer...", env: suiteEnv },
			"docker-conversation": { banner: "Running the multi-turn conversation suite...", env: suiteEnv },
			"docker-group-path": { banner: "Running the provider-group chat path suite...", env: suiteEnv },
			"host-fidelity": {
				banner: "Running the host-fidelity live suite against the stack...",
				env: {
					LITELLM_REAL_LIVE: "1",
					LITELLM_REAL_BASE_URL: baseUrl,
					LITELLM_REAL_API_KEY: masterKey,
					LITELLM_REAL_MODEL: PLAYBACK_MODEL.alias,
				},
			},
			// Capture-mode: the suite stands up its own capture server and never
			// touches the stack, so it takes no connection env.
			"host-fidelity-groups": { banner: "Running the host-fidelity group-label suite (capture)...", env: {} },
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
			compose("logs", "litellm", "--tail", "100");
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
				compose("down", "-v");
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
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
