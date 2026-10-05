#!/usr/bin/env bun
// Children run on process.execPath, the bun already running this file, so no PATH lookup and nothing differs per OS.
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const USAGE = `Usage: bun scripts/env/setup-env.ts [--verify] [--full] [--no-hooks]

Options:
  --verify    Install dependencies, then run compile and lint.
  --full      Install dependencies, then run compile, lint, and tests.
  --no-hooks  Disable Husky during dependency installation.

The default mode only installs pinned dependencies. Husky hooks are installed
for local checkouts, but are disabled automatically when CI=true.
`;

const steps = { compile: false, lint: false, test: false };
let hooks = true;
for (const arg of process.argv.slice(2)) {
	switch (arg) {
		case "--verify":
			steps.compile = true;
			steps.lint = true;
			break;
		case "--full":
			steps.compile = true;
			steps.lint = true;
			steps.test = true;
			break;
		case "--no-hooks":
			hooks = false;
			break;
		case "-h":
		case "--help":
			process.stdout.write(USAGE);
			process.exit(0);
			break;
		default:
			console.error(`Unknown option: ${arg}`);
			process.stderr.write(USAGE);
			process.exit(2);
	}
}

const root = join(__dirname, "..", "..");
const env = process.env.CI === "true" || !hooks ? { ...process.env, HUSKY: "0" } : process.env;

function run(args: readonly string[]): void {
	const result = spawnSync(process.execPath, [...args], { cwd: root, env, stdio: "inherit" });
	if (result.error !== undefined) {
		console.error(`could not run "bun ${args.join(" ")}": ${result.error.message}`);
		process.exit(1);
	}
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}

console.log("Initializing litellm-vscode-chat: bun install --frozen-lockfile ...");
run(["install", "--frozen-lockfile"]);
for (const script of ["compile", "lint", "test"] as const) {
	if (steps[script]) {
		run(["run", script]);
	}
}
console.log("Done.");
