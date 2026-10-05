/**
 * One nightly fuzz leg (nightly-fuzz.yml): runs the family's suites under `timeout --kill-after`, tees the log, and on
 * failure writes .fuzz-failures/<leg>/report.md with the exact replay command, which the report job merges into the
 * fuzz-nightly tracking issue. Exits with the suites' own status. The timeout wrapper, not the job's timeout-minutes,
 * is what ends a hang: a job cancelled at its timeout never reaches the report.
 *
 *   unit    FUZZ_SEED and FUZZ_RUNS through `bun run test`, 15m budget
 *   docker  seeded rows: FUZZ_SEED plus --only over SEEDED_FUZZ_LABELS; the unseeded row: their skip flags, 45m budget
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, copyFileSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { nightlyDockerArgs } from "../../src/test/dockerTestLabels";
import { parseLastFuzzSeedLine } from "../../src/test/fuzzSeed";

function env(name: string): string {
	const value = process.env[name];
	if (value === undefined) {
		throw new Error(`${name} is unset`);
	}
	return value;
}

/** Each chunk goes to the step log and the file as it arrives: the file is the report's attachment. */
async function runLogged(
	argv: readonly string[],
	extraEnv: Readonly<Record<string, string>>,
	logPath: string
): Promise<number> {
	const log = openSync(logPath, "w");
	const [command, ...args] = argv;
	const child = spawn(command as string, args, {
		env: { ...process.env, ...extraEnv },
		stdio: ["inherit", "pipe", "pipe"],
	});
	const tee = (chunk: Buffer): void => {
		process.stdout.write(chunk);
		writeSync(log, chunk);
	};
	child.stdout?.on("data", tee);
	child.stderr?.on("data", tee);
	const [code, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
	closeSync(log);
	// The shell's status for a signal-ended command, so the step still reports what ended the run.
	return code ?? 128 + (signal === null ? 0 : os.constants.signals[signal]);
}

function writeReport(leg: string, logPath: string, lines: readonly string[]): void {
	const dir = path.join(".fuzz-failures", leg);
	mkdirSync(dir, { recursive: true });
	copyFileSync(logPath, path.join(dir, path.basename(logPath)));
	writeFileSync(path.join(dir, "report.md"), `${lines.join("\n")}\n`);
}

async function unitLeg(): Promise<number> {
	const leg = env("LEG");
	const seed = env("SEED");
	const iterations = env("ITERATIONS");
	const logPath = "nightly-unit.log";
	console.log(`leg ${leg}: seed ${seed}, ${iterations} runs`);
	const status = await runLogged(
		["timeout", "--kill-after=60", "15m", "xvfb-run", "-a", "bun", "run", "test"],
		{ FUZZ_SEED: seed, FUZZ_RUNS: iterations },
		logPath
	);
	if (status !== 0) {
		writeReport(leg, logPath, [
			`# Unit property suites failed (leg ${leg}, seed ${seed})`,
			"",
			"Replay:",
			"",
			"```bash",
			`FUZZ_SEED=${seed} FUZZ_RUNS=${iterations} bun run test`,
			"```",
			"",
			"fast-check prints the shrunk counterexample in the attached log.",
			"Pin it as an example test next to the failing property, or in",
			"src/test/fuzzCorpus.ts when it is a FuzzEvent[] stream.",
			"",
			"bun run test also runs the unseeded webview, activation-production,",
			"and capture host-fidelity suites; if the log blames one of those,",
			"the seed guidance above does not apply.",
		]);
	}
	return status;
}

async function dockerLeg(): Promise<number> {
	const leg = env("LEG");
	const seed = env("SEED");
	const seeded = env("SEEDED") === "true";
	// One explicit seed for every suite in a seeded leg (resolveDockerFuzzSeed replays it exactly), so one seed
	// reproduces the whole leg and legs never overlap.
	const args = nightlyDockerArgs(seeded);
	const logPath = "nightly-docker.log";
	console.log(`leg ${leg}: test:docker ${args.join(" ")}${seeded ? `, seed ${seed}` : ""}`);
	const status = await runLogged(
		["timeout", "--kill-after=60", "45m", "xvfb-run", "-a", "bun", "run", "test:docker", ...args],
		seeded ? { FUZZ_SEED: seed } : {},
		logPath
	);
	if (status === 0) {
		return 0;
	}
	// On a seeded leg the logged seed equals SEED; the fallback covers a failure before any suite logged.
	const last = parseLastFuzzSeedLine(readFileSync(logPath, "utf8"));
	const replaySeed = last?.seed ?? seed;
	writeReport(
		leg,
		logPath,
		seeded
			? [
					`# Docker leg ${leg} failed (mode ${last?.mode ?? "unknown"}, seed ${replaySeed})`,
					"",
					"Replay:",
					"",
					"```bash",
					`FUZZ_SEED=${replaySeed} FUZZ_ITERATIONS=${env("FUZZ_ITERATIONS")} ` +
						`CONVERSATION_ITERATIONS=${env("CONVERSATION_ITERATIONS")} MONKEY_ITERATIONS=${env("MONKEY_ITERATIONS")} ` +
						`bun run test:docker ${args.join(" ")}`,
					"```",
					"",
					"Every suite in this leg ran under the same explicit seed, so the",
					"command replays the whole leg; the mode names the suite that",
					"logged last (keep FUZZ_SEED and narrow --only to that suite's",
					"label to skip the rest). A seeded failure report includes a",
					"minimal failing event list; pin it in src/test/fuzzCorpus.ts so",
					"the case replays on every run.",
				]
			: [
					`# Docker leg ${leg} failed (unseeded suites)`,
					"",
					"Replay:",
					"",
					"```bash",
					`bun run test:docker ${args.join(" ")}`,
					"```",
					"",
					"These suites draw no fuzz seed; see the attached log for the",
					"failing suite.",
				]
	);
	return status;
}

const family = process.argv[2];
const run = family === "unit" ? unitLeg : family === "docker" ? dockerLeg : undefined;
if (run === undefined) {
	console.error(`usage: bun scripts/ci/nightly-fuzz-leg.ts unit|docker (got "${family}")`);
	process.exit(2);
}
run().then(
	(status) => {
		process.exitCode = status;
	},
	(error: unknown) => {
		console.error(error);
		process.exitCode = 1;
	}
);
