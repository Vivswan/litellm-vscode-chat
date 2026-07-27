#!/usr/bin/env bun
// Launches an Extension Development Host preconfigured against the local
// fake LiteLLM stack: starts the docker proxy + fake OpenAI backend, builds
// the dev bundle, drops a one-shot seed file the extension consumes on its
// next development-mode activation (src/extension/devSeed.ts), and opens a
// new VS Code window in extension-development mode.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

// Compose reads .env with ${VAR:-default} semantics, so the seed must agree:
// process.env wins, then .env, then the compose defaults; empty means unset.
function composeVar(name: string, fallback: string): string {
	const fromProcess = process.env[name];
	if (fromProcess !== undefined && fromProcess !== "") {
		return fromProcess;
	}
	const envFile = join(root, ".env");
	if (existsSync(envFile)) {
		for (const line of readFileSync(envFile, "utf8").split("\n")) {
			const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
			if (match && match[1] === name && match[2] !== undefined && match[2] !== "") {
				return match[2].replace(/^["']|["']$/g, "");
			}
		}
	}
	return fallback;
}

const port = composeVar("LITELLM_PORT", "4000");
const apiKey = composeVar("LITELLM_MASTER_KEY", "sk-test-1234");

function run(label: string, cmd: string[]): void {
	console.log(`[dev:fake] ${label}`);
	const result = spawnSync(cmd[0] as string, cmd.slice(1), { stdio: "inherit", cwd: root });
	if (result.error !== undefined) {
		console.error(`[dev:fake] ${label} failed: could not run "${cmd[0]}" (${result.error.message})`);
		if (cmd[0] === "code") {
			console.error(
				`[dev:fake] install the "code" shell command: VS Code > Command Palette > "Shell Command: Install 'code' command in PATH"`
			);
		}
		process.exit(1);
	}
	if (result.status !== 0) {
		console.error(`[dev:fake] ${label} failed (exit ${result.status})`);
		process.exit(result.status ?? 1);
	}
}

run("starting the fake LiteLLM stack", ["bun", "scripts/compose.ts", "up", "-d", "--wait"]);
run("building the dev bundle", ["bun", "run", "bundle:dev"]);

const seed = {
	label: "Fake LiteLLM",
	baseUrl: `http://localhost:${port}`,
	apiKey,
	openDashboard: true,
};
writeFileSync(join(root, ".dev-fake-seed.json"), `${JSON.stringify(seed, null, "\t")}\n`);
console.log(`[dev:fake] seed written for ${seed.baseUrl}`);

run("opening the Extension Development Host", ["code", "--new-window", `--extensionDevelopmentPath=${root}`]);
console.log("[dev:fake] window launched; the seed configures the server on activation");
console.log("[dev:fake] tear the stack down with: bun run docker:down");
