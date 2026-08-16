/**
 * Shared fuzz-seed contract for every seeded suite. The log line matters as much
 * as the seed: nightly-fuzz.yml rebuilds the reproduction command in the filed
 * issue from the LAST "[fuzz] seed=<n> ... mode=<m>" line in the docker log.
 * Two emitters exist, both built here - the docker suites log the full line via
 * logFuzzSeed, the unit property harness the seed-only prefix. fuzzSeed.test.ts
 * pins both shapes against the workflow's patterns, so a rewording fails in CI
 * instead of silently filing seedless issues.
 */

/** Every mode the docker suites emit; the workflow's mode regex only admits lowercase and hyphens. */
export const FUZZ_MODES = ["proxy", "direct", "conversation", "monkey"] as const;
export type FuzzMode = (typeof FUZZ_MODES)[number];

/** The fresh-draw formula, pure so a test can pin its range and determinism. */
export function freshFuzzSeed(nowMs: number, pid: number): number {
	return (((nowMs >>> 4) ^ (pid << 8)) >>> 0) % 1000000;
}

/**
 * Resolve a docker suite's seed. An explicit FUZZ_SEED reproduces exactly,
 * including 0; anything unset or invalid draws a fresh seed. The unit property
 * suites have their own resolver: a pinned default instead of a fresh draw.
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
