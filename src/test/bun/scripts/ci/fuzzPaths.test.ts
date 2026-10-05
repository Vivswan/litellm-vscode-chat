import { describe, test } from "bun:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { FUZZ_PATHS } from "../../../../../scripts/ci/fuzzPaths";
import { REPO_ROOT } from "../../../util/repoRoot";

/**
 * A renamed or moved fuzzer file silently stops the elevated fuzz pass from triggering: checks.yml's fuzz jobs skip,
 * and a skipped job counts green in the gate. Every path FUZZ_PATHS names must still exist.
 */
describe("fuzz paths", () => {
	test("every named file and directory exists", () => {
		const missing = [
			...FUZZ_PATHS.files.filter(
				(file) => !fs.statSync(path.join(REPO_ROOT, file), { throwIfNoEntry: false })?.isFile()
			),
			...FUZZ_PATHS.directories.filter(
				(directory) => !fs.statSync(path.join(REPO_ROOT, directory), { throwIfNoEntry: false })?.isDirectory()
			),
		];
		assert.deepStrictEqual(missing, [], "FUZZ_PATHS names paths that no longer exist");
	});

	test("every test name prefix still matches an entry under one of the test roots", () => {
		const entries = FUZZ_PATHS.testRoots.flatMap((root) => fs.readdirSync(path.join(REPO_ROOT, root)));
		const unmatched = FUZZ_PATHS.testNames.filter(
			(name) => !entries.some((entry) => entry.startsWith(name.replace(/\/$/, "")))
		);
		assert.deepStrictEqual(unmatched, [], "FUZZ_PATHS test names that match nothing");
	});
});
