// scripts/stack/composeCommand.ts
//
// Resolves which compose CLI to use, keeping the docker stack runnable under
// both Docker and Podman: an explicit COMPOSE_CMD wins, then `docker compose`,
// then `podman compose`. The compose file lives in docker/, but the project
// directory stays the repo root so .env resolution and the compose file's
// relative bind mounts keep resolving from there.

import { spawnSync } from "node:child_process";

const COMPOSE_FILE_ARGS = ["-f", "docker/docker-compose.yml", "--project-directory", "."];

function probes(candidate: string[]): boolean {
	const [command, ...args] = candidate;
	if (!command) {
		return false;
	}
	const result = spawnSync(command, [...args, "version"], { stdio: "ignore" });
	return result.status === 0;
}

// Resolved once per process: every compose call in a run (up, logs, down) must
// use the same runtime, probed once, exactly as when call sites resolved a
// single command string up front.
let resolved: readonly string[] | undefined;

export function resolveComposeCommand(): string[] {
	if (resolved !== undefined) {
		return [...resolved];
	}
	const override = process.env.COMPOSE_CMD?.trim();
	if (override) {
		resolved = [...override.split(/\s+/), ...COMPOSE_FILE_ARGS];
		return [...resolved];
	}
	for (const candidate of [
		["docker", "compose"],
		["podman", "compose"],
	]) {
		if (probes(candidate)) {
			resolved = [...candidate, ...COMPOSE_FILE_ARGS];
			return [...resolved];
		}
	}
	console.error(
		"No compose runtime found. Install Docker or Podman, or set COMPOSE_CMD to your compose command (for example COMPOSE_CMD='podman-compose')."
	);
	process.exit(1);
}

/**
 * Run a compose subcommand with inherited stdio; returns the exit code. The
 * one compose executor: the resolved argv is spawned directly, never re-parsed
 * by a shell, so a quoted COMPOSE_CMD means the same thing on every path.
 */
export function runCompose(args: string[]): number {
	const [command, ...base] = resolveComposeCommand();
	if (!command) {
		return 1;
	}
	const result = spawnSync(command, [...base, ...args], { stdio: "inherit" });
	if (result.error) {
		// An unprobed COMPOSE_CMD override can name a missing binary; spawnSync
		// reports that as `error` with no status, which must not die silently.
		console.error(`[compose] could not run "${command}": ${result.error.message}`);
	}
	return result.status ?? 1;
}
