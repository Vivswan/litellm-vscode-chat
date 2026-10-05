import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { DOCKER_TEST_LABELS, nightlyDockerArgs, parseOnlyLabels } from "../dockerTestLabels";

/**
 * Pins the label grammar behind `bun run test:docker --only ...`, which the CI shard matrices drive: canonical order
 * (docker-monkey last) regardless of flag order, and loud rejection of anything unknown or empty.
 */

describe("dockerTestLabels: parseOnlyLabels", () => {
	test("a single label selects exactly itself", () => {
		assert.deepStrictEqual(parseOnlyLabels("docker-serversync"), ["docker-serversync"]);
	});

	test("the selection replays canonical order (monkey last) regardless of input order", () => {
		assert.deepStrictEqual(parseOnlyLabels("docker-monkey,host-fidelity,docker"), [
			"docker",
			"host-fidelity",
			"docker-monkey",
		]);
	});

	test("duplicates collapse to one run", () => {
		assert.deepStrictEqual(parseOnlyLabels("docker,docker"), ["docker"]);
	});

	test("whitespace around entries is trimmed", () => {
		assert.deepStrictEqual(parseOnlyLabels(" docker , docker-fuzz "), ["docker", "docker-fuzz"]);
	});

	test("an unknown label throws naming it and every known label", () => {
		assert.throws(
			() => parseOnlyLabels("docker,docker-transprot"), // typos: ignore
			(error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				assert.ok(message.includes('unknown label "docker-transprot"'), message); // typos: ignore
				for (const label of DOCKER_TEST_LABELS) {
					assert.ok(message.includes(label), `error message names ${label}: ${message}`);
				}
				return true;
			}
		);
	});

	test("empty values and empty entries throw", () => {
		assert.throws(() => parseOnlyLabels(""), /empty label/);
		assert.throws(() => parseOnlyLabels("docker,,docker-fuzz"), /empty label/);
		assert.throws(() => parseOnlyLabels("docker,"), /empty label/);
	});
});

describe("dockerTestLabels: nightlyDockerArgs", () => {
	// scripts/ci/nightly-fuzz-leg.ts hands these lists to test:docker; a flag dropped from the complement would run
	// that suite in both legs every night with every leg green.
	test("the seeded legs run exactly the seeded labels and the unseeded leg skips exactly them", () => {
		assert.deepStrictEqual(nightlyDockerArgs(true), ["--only", "docker-fuzz,docker-conversation,docker-monkey"]);
		assert.deepStrictEqual(nightlyDockerArgs(false), ["--skip-fuzz", "--skip-conversation", "--skip-monkey"]);
	});
});
