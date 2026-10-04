import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { DOCKER_TEST_LABELS, parseOnlyLabels } from "../dockerTestLabels";

/**
 * Pins the label grammar behind `bun run test:docker --only ...`, which the CI
 * shard matrices drive: canonical order (docker-monkey last) regardless of flag
 * order, and loud rejection of anything unknown or empty.
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
