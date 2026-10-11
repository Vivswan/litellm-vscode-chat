// scripts/stack/stackLogs.ts
//
// The full log of every compose service, one <service>.log per service, for a failed test run's artifact. The console
// tail scripts/docker-test.ts prints covers seconds; a timing question (did the proxy answer before the client gave up)
// needs the whole run with timestamps.

import { closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { readCompose, runCompose } from "./composeCommand";

/** scripts/ci/nightly-fuzz-leg.ts sets it to the leg's failure directory, the one the workflow's artifact uploads. */
export const STACK_LOG_DIR_ENV = "DOCKER_TEST_LOG_DIR";

export interface StackLogCapture {
	readonly file: string;
	readonly status: number;
}

/**
 * One <service>.log per declared compose service under `dir`, streamed into the file's descriptor: a piped spawnSync
 * stops at 1 MiB, far short of a run's proxy log. A failed capture keeps its partial file and its status, so a short
 * file is never read as a quiet service; a failed enumeration throws, since no file would say what is missing.
 */
export function writeStackLogs(dir: string): StackLogCapture[] {
	const services = readCompose(["config", "--services"]);
	if (services === undefined) {
		throw new Error("compose config --services failed; no service log written");
	}
	mkdirSync(dir, { recursive: true });
	const captures: StackLogCapture[] = [];
	for (const service of services
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "")) {
		const file = path.join(dir, `${service}.log`);
		const fd = openSync(file, "w");
		try {
			captures.push({ file, status: runCompose(["logs", "--no-color", "--timestamps", service], fd) });
		} finally {
			closeSync(fd);
		}
	}
	return captures;
}
