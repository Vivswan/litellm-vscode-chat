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

/**
 * COMPOSE_CMD split into argv words the way a POSIX shell splits them:
 * whitespace separates, single or double quotes group (a quoted binary path
 * may contain spaces), no escape sequences - a backslash is a literal
 * character (Windows paths), so a space inside a word needs quotes, not a
 * backslash. Undefined means an unclosed quote.
 */
export function splitCommandWords(command: string): string[] | undefined {
	const words: string[] = [];
	let current = "";
	let inWord = false;
	let quote: '"' | "'" | undefined;
	for (const char of command) {
		if (quote !== undefined) {
			if (char === quote) {
				quote = undefined;
			} else {
				current += char;
			}
		} else if (char === '"' || char === "'") {
			quote = char;
			inWord = true;
		} else if (/\s/.test(char)) {
			if (inWord) {
				words.push(current);
				current = "";
				inWord = false;
			}
		} else {
			current += char;
			inWord = true;
		}
	}
	if (quote !== undefined) {
		return undefined;
	}
	if (inWord) {
		words.push(current);
	}
	return words;
}

export function resolveComposeCommand(): string[] {
	if (resolved !== undefined) {
		return [...resolved];
	}
	const override = process.env.COMPOSE_CMD?.trim();
	if (override) {
		const words = splitCommandWords(override);
		if (words === undefined || words[0] === undefined || words[0] === "") {
			console.error(`COMPOSE_CMD is not a runnable command (unclosed quote or empty): ${override}`);
			process.exit(1);
		}
		resolved = [...words, ...COMPOSE_FILE_ARGS];
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
