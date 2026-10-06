import { existsSync } from "node:fs";
import * as path from "node:path";

/**
 * The repository root, found by walking up to the nearest package.json. Both runners share the test helpers but run
 * suites from different depths - the extension host from out/test, bun from src/test/bun - so any fixed __dirname
 * arithmetic is wrong for one of them.
 *
 * Importing this module declares that the suite reads the repository as data (a doc, a stylesheet, a fixture, the
 * source tree), which no import graph can see. The pre-commit selection (scripts/dev/changedBunTests.ts) therefore runs
 * every suite whose imports reach this file on any staged change, so a repository path is never derived elsewhere.
 * eslint.config.ts refuses __dirname, __filename, and import.meta paths anywhere else under src/test.
 */
function findRepoRoot(): string {
	let dir = __dirname;
	while (!existsSync(path.join(dir, "package.json"))) {
		const parent = path.dirname(dir);
		if (parent === dir) {
			throw new Error(`no package.json found above ${__dirname}`);
		}
		dir = parent;
	}
	return dir;
}

export const REPO_ROOT = findRepoRoot();
