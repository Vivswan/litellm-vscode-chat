import { existsSync } from "node:fs";
import * as path from "node:path";

/**
 * The repository root, found by walking up to the nearest package.json. Both
 * runners share the test helpers but run suites from different depths - the
 * extension host from out/test and bun from src/test/bun - so any fixed
 * __dirname arithmetic is wrong for one of them; the walk is right for both.
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
