import { afterEach, beforeEach, describe, test } from "bun:test";
import * as assert from "node:assert";
import {
	FUZZ_MODES,
	freshFuzzSeed,
	fuzzSeedLine,
	fuzzSeedPrefix,
	parseLastFuzzSeedLine,
	resolveDockerFuzzSeed,
} from "../fuzzSeed";

describe("fuzzSeed contract", () => {
	// The emitters and parseLastFuzzSeedLine are written apart; an emitted shape the parser stops reading ships the
	// nightly issue without a reproduction seed.
	test("the docker line parses back to its seed and mode for every mode", () => {
		for (const mode of FUZZ_MODES) {
			assert.deepStrictEqual(parseLastFuzzSeedLine(fuzzSeedLine(123456, 10, mode)), { seed: 123456, mode });
		}
	});

	test("the unit harness prefix parses to its seed with no mode", () => {
		// fuzzStream.ts logs only the prefix (no iterations/mode) into the unit leg's log.
		assert.deepStrictEqual(parseLastFuzzSeedLine(fuzzSeedPrefix(987)), { seed: 987, mode: undefined });
	});

	test("seed 0 keeps its digits", () => {
		assert.deepStrictEqual(parseLastFuzzSeedLine(fuzzSeedLine(0, 1, "proxy")), { seed: 0, mode: "proxy" });
	});

	test("the last line of a log wins, and a log without one parses to null", () => {
		// The orchestrator runs a leg's suites in sequence, so the replay report names the suite that logged last.
		const log = ["suite output", fuzzSeedLine(11, 10, "proxy"), "more output", fuzzSeedLine(22, 50, "monkey"), ""].join(
			"\n"
		);
		assert.deepStrictEqual(parseLastFuzzSeedLine(log), { seed: 22, mode: "monkey" });
		assert.strictEqual(parseLastFuzzSeedLine("setup died before any suite ran\n"), null);
	});

	test("fresh draws stay in the seed range", () => {
		for (const [nowMs, pid] of [
			[1740000000000, 1234],
			[1740000000016, 77],
			[1753679999999, 90210],
		] as const) {
			const seed = freshFuzzSeed(nowMs, pid);
			assert.ok(Number.isInteger(seed) && seed >= 0 && seed < 1000000, "draw out of range");
		}
	});

	describe("resolveDockerFuzzSeed", () => {
		let savedSeed: string | undefined;
		beforeEach(() => {
			savedSeed = process.env.FUZZ_SEED;
		});
		afterEach(() => {
			if (savedSeed === undefined) {
				delete process.env.FUZZ_SEED;
			} else {
				process.env.FUZZ_SEED = savedSeed;
			}
		});

		test("an explicit seed reproduces exactly, including 0", () => {
			process.env.FUZZ_SEED = "42";
			assert.strictEqual(resolveDockerFuzzSeed(), 42);
			process.env.FUZZ_SEED = "0";
			assert.strictEqual(resolveDockerFuzzSeed(), 0);
		});

		test("an invalid or absent seed draws a fresh one in range", () => {
			for (const bad of [undefined, "", "  ", "abc"]) {
				if (bad === undefined) {
					delete process.env.FUZZ_SEED;
				} else {
					process.env.FUZZ_SEED = bad;
				}
				const seed = resolveDockerFuzzSeed();
				assert.ok(
					Number.isInteger(seed) && seed >= 0 && seed < 1000000,
					`fresh seed out of range for ${JSON.stringify(bad)}`
				);
			}
		});
	});
});
