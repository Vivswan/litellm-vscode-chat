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
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveComposeCommand } from "./composeCommand";

const args = process.argv.slice(2);
const runFuzz = !args.includes("--skip-fuzz");
const runHostFidelity = !args.includes("--skip-host-fidelity");

/**
 * .env values used by docker-compose; the suite must agree on ports and key.
 * Minimal dotenv semantics: KEY=VALUE lines, surrounding quotes stripped.
 */
function dotenvValues(): Record<string, string> {
	const envPath = path.join(process.cwd(), ".env");
	if (!existsSync(envPath)) {
		return {};
	}
	const values: Record<string, string> = {};
	for (const line of readFileSync(envPath, "utf8").split("\n")) {
		const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
		if (match?.[1] && match[2] !== undefined) {
			values[match[1]] = match[2].replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
		}
	}
	return values;
}

const dotenv = dotenvValues();
const setting = (key: string, fallback: string): string => process.env[key] || dotenv[key] || fallback;

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
	run("bun scripts/generate-litellm-config.ts --check");
	console.log(`\nStarting the LiteLLM stack via "${compose}"...`);
	run(`${compose} up -d --wait --wait-timeout 120`);

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
