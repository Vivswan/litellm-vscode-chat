#!/usr/bin/env bun
// scripts/docker-test.ts
// Runs the docker-stack test suites against the dockerized LiteLLM proxy:
// brings the compose stack up, runs the `docker` label, then optionally the
// `docker-transport`, `docker-serversync`, `docker-fuzz`, and
// `docker-conversation` labels, then the host-fidelity live suite pointed at
// the stack, then the `docker-monkey` label last (it deliberately dirties
// host state), and tears everything down.
//
// Usage:
//   bun run test:docker                     docker suite + transport + serversync + fuzzer + conversations + host-fidelity live + monkey
//   bun run test:docker --skip-transport    skip the transport-failure suite
//   bun run test:docker --skip-serversync   skip the server-sync provider-group suite
//   bun run test:docker --skip-fuzz         skip the stream fuzzer
//   bun run test:docker --skip-conversation skip the multi-turn conversation suite
//   bun run test:docker --skip-monkey       skip the interaction (monkey) fuzzer
//   FUZZ_ITERATIONS=100 bun run test:docker larger fuzz budget (default 10)
//   CONVERSATION_ITERATIONS=50 bun run test:docker larger conversation budget (default 10)
//   MONKEY_ITERATIONS=40 bun run test:docker larger monkey-walk budget (default 5)
//   bun run test:docker --skip-host-fidelity
//   KEEP_DOCKER_STACK=1 bun run test:docker leave the stack running afterward

import { execSync } from "node:child_process";
import { PLAYBACK_MODEL } from "../src/test/fakeStack/models";
import { resolveComposeCommand } from "./composeCommand";
import { composeSetting, ensureGeneratedConfig, readEnvFile, STACK_DEFAULTS } from "./litellmConfig";

const args = process.argv.slice(2);
const runTransport = !args.includes("--skip-transport");
const runServerSync = !args.includes("--skip-serversync");
const runFuzz = !args.includes("--skip-fuzz");
const runConversation = !args.includes("--skip-conversation");
const runHostFidelity = !args.includes("--skip-host-fidelity");
const runMonkey = !args.includes("--skip-monkey");

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
	console.log("\nRunning the docker suite...");
	run("vscode-test --config .vscode-test.mjs --label docker", suiteEnv);

	if (runTransport) {
		console.log("\nRunning the transport-failure suite...");
		run("vscode-test --config .vscode-test.mjs --label docker-transport", suiteEnv);
	}

	if (runServerSync) {
		// A fresh extension host on purpose: the suite's provider groups are
		// add-only for the host lifetime and must not leak into other labels.
		console.log("\nRunning the server-sync suite...");
		run("vscode-test --config .vscode-test.mjs --label docker-serversync", suiteEnv);
	}

	if (runFuzz) {
		console.log("\nRunning the stream fuzzer...");
		run("vscode-test --config .vscode-test.mjs --label docker-fuzz", suiteEnv);
	}

	if (runConversation) {
		console.log("\nRunning the multi-turn conversation suite...");
		run("vscode-test --config .vscode-test.mjs --label docker-conversation", suiteEnv);
	}

	if (runHostFidelity) {
		console.log("\nRunning the host-fidelity live suite against the stack...");
		run("vscode-test --config .vscode-test.mjs --label host-fidelity", {
			LITELLM_REAL_LIVE: "1",
			LITELLM_REAL_BASE_URL: baseUrl,
			LITELLM_REAL_API_KEY: masterKey,
			LITELLM_REAL_MODEL: PLAYBACK_MODEL.alias,
		});
	}

	if (runMonkey) {
		// Last on purpose, and in its own fresh extension host: monkey walks
		// deliberately dirty host state (add-only provider groups, settings
		// churn) that no later suite should inherit.
		console.log("\nRunning the interaction (monkey) fuzzer...");
		run("vscode-test --config .vscode-test.mjs --label docker-monkey", suiteEnv);
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
