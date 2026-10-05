/**
 * The log line matters as much as the seed: scripts/ci/nightly-fuzz-leg.ts rebuilds the reproduction command in the
 * filed issue from the LAST "[fuzz] seed=<n> ... mode=<m>" line in the docker log.
 *
 *   fuzzSeed.test.ts round-trips both emitted shapes through parseLastFuzzSeedLine
 *     -> a rewording of either side fails in CI instead of silently filing seedless issues
 */

/** Every mode the docker suites emit; the parser's mode pattern only admits lowercase and hyphens. */
export const FUZZ_MODES = ["proxy", "direct", "conversation", "monkey"] as const;
export type FuzzMode = (typeof FUZZ_MODES)[number];

/** The fresh-draw formula, pure so a test can pin its range and determinism. */
export function freshFuzzSeed(nowMs: number, pid: number): number {
	return (((nowMs >>> 4) ^ (pid << 8)) >>> 0) % 1000000;
}

/**
 * An explicit FUZZ_SEED reproduces exactly, including 0; anything unset or invalid draws a fresh seed. The unit
 * property suites have their own resolver: a pinned default instead of a fresh draw.
 */
export function resolveDockerFuzzSeed(): number {
	const seedEnv = Number(process.env.FUZZ_SEED ?? "");
	if (process.env.FUZZ_SEED?.trim() && Number.isFinite(seedEnv)) {
		return seedEnv >>> 0;
	}
	return freshFuzzSeed(Date.now(), process.pid);
}

/** The greppable core both emitters share. */
export function fuzzSeedPrefix(seed: number): string {
	return `[fuzz] seed=${seed}`;
}

/** The full line the docker suites emit. */
export function fuzzSeedLine(seed: number, iterations: number, mode: FuzzMode): string {
	return `${fuzzSeedPrefix(seed)} iterations=${iterations} mode=${mode}`;
}

export function logFuzzSeed(seed: number, iterations: number, mode: FuzzMode): void {
	console.log(fuzzSeedLine(seed, iterations, mode));
}

/**
 * The last seed line of a log, or null when no suite logged one; `mode` is absent on the unit harness's prefix-only
 * line. The orchestrator runs a leg's suites in sequence, so the last line names the suite that logged last, which is the
 * failing one unless it died before logging.
 */
export function parseLastFuzzSeedLine(log: string): { seed: number; mode: string | undefined } | null {
	let last: RegExpExecArray | undefined;
	for (const match of log.matchAll(/\[fuzz\] seed=(\d+)(?:[^"\n]*?\bmode=([a-z-]+))?/g)) {
		last = match;
	}
	return last === undefined ? null : { seed: Number(last[1]), mode: last[2] };
}
