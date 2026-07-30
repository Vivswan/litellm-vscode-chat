import * as assert from "node:assert";
import { FUZZ_MODES, freshFuzzSeed, fuzzSeedLine, fuzzSeedPrefix, resolveDockerFuzzSeed } from "./fuzzSeed";

suite("fuzzSeed contract", () => {
	// nightly-fuzz.yml's extraction patterns, copied byte-for-byte from the
	// workflow. If the emitted shapes ever stop satisfying them, the nightly
	// issue ships without a reproduction seed - which is the whole point.
	const workflowLine = /\[fuzz\] seed=[0-9]+[^"]*/;
	const workflowSeed = /seed=[0-9]+/;
	const workflowMode = /mode=[a-z-]+/;

	test("the docker line satisfies the workflow greps for every mode", () => {
		for (const mode of FUZZ_MODES) {
			const line = fuzzSeedLine(123456, 10, mode);
			const matched = line.match(workflowLine)?.[0];
			assert.strictEqual(matched, line, `grep must capture the whole line for mode=${mode}`);
			assert.strictEqual(line.match(workflowSeed)?.[0], "seed=123456");
			assert.strictEqual(line.match(workflowMode)?.[0], `mode=${mode}`);
		}
	});

	test("the monkey suite's mode is declared, so its seed lines reach the nightly grep", () => {
		// docker-monkey.test.ts logs via logFuzzSeed(SEED, WALKS, "monkey"); a
		// mode dropped from FUZZ_MODES would fail compilation there, and this
		// pin keeps the intent visible next to the grep contract.
		assert.ok((FUZZ_MODES as readonly string[]).includes("monkey"));
	});

	test("the unit harness prefix satisfies the seed grep on its own", () => {
		// fuzzStream.ts logs only the prefix (no iterations/mode) into the unit
		// leg's log; the seed extraction must still work there.
		const line = fuzzSeedPrefix(987);
		assert.strictEqual(line.match(workflowLine)?.[0], line);
		assert.strictEqual(line.match(workflowSeed)?.[0], "seed=987");
	});

	test("seed 0 keeps its digits in the grep", () => {
		const line = fuzzSeedLine(0, 1, "proxy");
		assert.strictEqual(line.match(workflowSeed)?.[0], "seed=0");
	});

	test("the shard salt diverges fresh draws", () => {
		// The by-design difference between the suites: the stream fuzzer salts
		// fresh draws per shard, the conversation suite does not (salt 0).
		for (const [nowMs, pid] of [
			[1740000000000, 1234],
			[1740000000016, 77],
			[1753679999999, 90210],
		] as const) {
			const unsalted = freshFuzzSeed(0, nowMs, pid);
			const salted = freshFuzzSeed(7919, nowMs, pid);
			assert.notStrictEqual(salted, unsalted, `salt must change the draw for now=${nowMs} pid=${pid}`);
			for (const seed of [unsalted, salted]) {
				assert.ok(Number.isInteger(seed) && seed >= 0 && seed < 1000000, "draw out of range");
			}
		}
	});

	suite("resolveDockerFuzzSeed", () => {
		let savedSeed: string | undefined;
		setup(() => {
			savedSeed = process.env.FUZZ_SEED;
		});
		teardown(() => {
			if (savedSeed === undefined) {
				delete process.env.FUZZ_SEED;
			} else {
				process.env.FUZZ_SEED = savedSeed;
			}
		});

		test("an explicit seed reproduces exactly, including 0", () => {
			process.env.FUZZ_SEED = "42";
			assert.strictEqual(resolveDockerFuzzSeed(0), 42);
			assert.strictEqual(resolveDockerFuzzSeed(7919), 42, "the salt never touches an explicit seed");
			process.env.FUZZ_SEED = "0";
			assert.strictEqual(resolveDockerFuzzSeed(0), 0);
		});

		test("an invalid or absent seed draws a fresh one in range", () => {
			for (const bad of [undefined, "", "  ", "abc"]) {
				if (bad === undefined) {
					delete process.env.FUZZ_SEED;
				} else {
					process.env.FUZZ_SEED = bad;
				}
				const seed = resolveDockerFuzzSeed(0);
				assert.ok(
					Number.isInteger(seed) && seed >= 0 && seed < 1000000,
					`fresh seed out of range for ${JSON.stringify(bad)}`
				);
			}
		});
	});
});
