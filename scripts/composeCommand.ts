// scripts/composeCommand.ts
//
// Resolves which compose CLI to use, keeping the docker stack runnable under
// both Docker and Podman: an explicit COMPOSE_CMD wins, then `docker compose`,
// then `podman compose`.

import { spawnSync } from "node:child_process";

function probes(candidate: string[]): boolean {
	const [command, ...args] = candidate;
	if (!command) {
		return false;
	}
	const result = spawnSync(command, [...args, "version"], { stdio: "ignore" });
	return result.status === 0;
}

export function resolveComposeCommand(): string[] {
	const override = process.env.COMPOSE_CMD?.trim();
	if (override) {
		return override.split(/\s+/);
	}
	for (const candidate of [
		["docker", "compose"],
		["podman", "compose"],
	]) {
		if (probes(candidate)) {
			return candidate;
		}
	}
	console.error(
		"No compose runtime found. Install Docker or Podman, or set COMPOSE_CMD to your compose command (for example COMPOSE_CMD='podman-compose')."
	);
	process.exit(1);
}

/** Run a compose subcommand with inherited stdio; returns the exit code. */
export function runCompose(args: string[]): number {
	const [command, ...base] = resolveComposeCommand();
	if (!command) {
		return 1;
	}
	const result = spawnSync(command, [...base, ...args], { stdio: "inherit" });
	return result.status ?? 1;
}
