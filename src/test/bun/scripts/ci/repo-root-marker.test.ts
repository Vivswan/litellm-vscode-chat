import { describe, expect, test } from "bun:test";
import {
	MARKER_FILE,
	reportLines,
	SCANNED_FILE,
	scanRepositoryPathDerivations,
} from "../../../../../scripts/ci/repo-root-marker";
import { BUN_TEST_FILE } from "../../../runtimeImportGraph";

/** Hand-authored: both derivations beside the look-alikes the scan must ignore (a comment, a string, path.dirname). */
const FIXTURE = [
	'import * as path from "node:path";',
	"// __dirname in a comment derives nothing",
	'const label = "__dirname";',
	'const root = path.resolve(__dirname, "..", "..");',
	"const here = import.meta.dir;",
	"const url = import.meta.url;",
	"export const paths = [label, root, here, url, path.dirname(root)];",
].join("\n");

describe("scanRepositoryPathDerivations", () => {
	// The hook's selection trusts the marker import, so a derivation the scan misses is a suite the hook skips on a
	// change it should have run on. The report is pinned whole: every hit's position and the fix line.
	test.each([
		[
			"src/test/example.test.ts",
			[
				"src/test/example.test.ts:4:27: __dirname derives a repository path outside the marker",
				"src/test/example.test.ts:5:14: import.meta.dir derives a repository path outside the marker",
				"Repository paths under src/test come from REPO_ROOT: import it from src/test/util/repoRoot.ts and " +
					"path.join(REPO_ROOT, ...). Importing the marker is what makes the pre-commit selection run the suite on " +
					"any staged change.",
			],
		],
		[MARKER_FILE, []],
	])("reports every derivation in %s with the fix line, and nothing for look-alikes", (file, expected) => {
		expect(reportLines(scanRepositoryPathDerivations(file, FIXTURE))).toEqual(expected);
	});

	// A suite bun runs that the walk never opens is the bypass the guard exists to close, and the two patterns live in
	// different files. The first assertion is the control: every name is one bun runs.
	test("every file name bun runs as a suite is a file name the walk scans", () => {
		const bunSuites = [
			"a.test.ts",
			"a.spec.mts",
			"a.test.cts",
			"a.test.js",
			"a.test.mjs",
			"a_test.cjs",
			"a.test.tsx",
			"a.test.jsx",
		];
		expect(bunSuites.filter((name) => BUN_TEST_FILE.test(name))).toEqual(bunSuites);
		expect(bunSuites.filter((name) => SCANNED_FILE.test(name))).toEqual(bunSuites);
	});
});
