/**
 * The pre-commit hook's test selection: prints the bun test files the staged change can affect, one per line, and
 * the one-line reason on stderr (changedBunTests.ts holds the rule). A git failure or an import the graph cannot
 * resolve exits non-zero, so the hook refuses instead of running nothing.
 */
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { selectBunTests } from "./changedBunTests";

const repoRoot = path.resolve(__dirname, "..", "..");
// --no-renames lists a move as its old and new path, so the suites importing either side run.
const diff = spawnSync("git", ["diff", "--cached", "--name-only", "-z", "--no-renames"], {
	cwd: repoRoot,
	encoding: "utf8",
	stdio: ["ignore", "pipe", "pipe"],
});
if (diff.status !== 0) {
	throw new Error(`git diff --cached failed: ${diff.error?.message ?? diff.stderr.trim()}`);
}
const { files, summary } = selectBunTests(
	repoRoot,
	diff.stdout.split("\0").filter((file) => file !== "")
);
console.error(`pre-commit: ${summary}`);
console.log(files.join("\n"));
