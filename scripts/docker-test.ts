#!/usr/bin/env bun
// scripts/docker-test.ts
// Runs the docker-stack test suites against the dockerized LiteLLM proxy:
// brings the compose stack up, runs the `docker` label, optionally the
// `docker-fuzz` label, then the host-fidelity live suite pointed at the
// stack, and tears everything down.
//
// Usage:
//   bun run test:docker                     docker suite + fuzzer + host-fidelity live
//   bun run test:docker --skip-fuzz         skip the stream fuzzer
//   FUZZ_ITERATIONS=100 bun run test:docker larger fuzz budget (default 10)
//   bun run test:docker --skip-host-fidelity
//   KEEP_DOCKER_STACK=1 bun run test:docker leave the stack running afterward

import { execSync } from "node:child_process";
import { resolveComposeCommand } from "./composeCommand";
import { composeSetting, ensureGeneratedConfig, readEnvFile } from "./litellmConfig";

const args = process.argv.slice(2);
const runFuzz = !args.includes("--skip-fuzz");
const runHostFidelity = !args.includes("--skip-host-fidelity");

// The suite must agree with docker-compose on ports and key, so it resolves
// them with the same ${VAR:-fallback} semantics compose uses.
const envFile = readEnvFile();
const setting = (key: string, fallback: string): string => composeSetting(key, fallback, envFile);

const litellmPort = setting("LITELLM_PORT", "4000");
const fakePort = setting("FAKE_OPENAI_PORT", "8090");
const masterKey = setting("LITELLM_MASTER_KEY", "sk-test-1234");
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

	if (runFuzz) {
		console.log("\nRunning the stream fuzzer...");
		run("vscode-test --config .vscode-test.mjs --label docker-fuzz", suiteEnv);
	}

	if (runHostFidelity) {
		console.log("\nRunning the host-fidelity live suite against the stack...");
		run("vscode-test --config .vscode-test.mjs --label host-fidelity", {
			LITELLM_REAL_BASE_URL: baseUrl,
			LITELLM_REAL_API_KEY: masterKey,
			LITELLM_REAL_MODEL: "fake/long-text",
		});
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
