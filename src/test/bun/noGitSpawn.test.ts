import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * A quoted git command in any spawn shape: git alone as an argv element, git followed by its arguments as one shell
 * string, a path ending in git, or git.exe. A comment that quotes one matches too, which is loud and names the site.
 */
const GIT_LITERAL = /["'](?:[^"'\n]*[\\/])?git(?:\.exe)?(?:["']|\s)/;

test("the bun tree never spawns git", () => {
	const offenders: string[] = [];
	for (const entry of readdirSync(import.meta.dir, { recursive: true, withFileTypes: true })) {
		const file = path.join(entry.parentPath, entry.name);
		if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name) && GIT_LITERAL.test(readFileSync(file, "utf8"))) {
			offenders.push(path.relative(import.meta.dir, file));
		}
	}
	expect(
		offenders,
		"the bun tree never spawns git; the pre-commit hook runs this tree with git's hook environment exported, and a scratch git under a leaked GIT_DIR once rewrote the real repository"
	).toEqual([]);
});
