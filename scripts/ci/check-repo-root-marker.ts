/**
 * Fails when a file under src/test derives a repository path from __dirname or import.meta.dir instead of importing
 * REPO_ROOT. Two callers run this one script, .husky/pre-commit through check:static and the format-check workflow, so
 * a local green predicts the gate. Zero scanned files is a failure too: a walk that misses the tree would pass every
 * derivation.
 */
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { reportLines, SCANNED_FILE, scanRepositoryPathDerivations, TEST_TREE } from "./repo-root-marker";

const repoRoot = path.resolve(__dirname, "../..");
const testRoot = path.join(repoRoot, TEST_TREE);
const files = readdirSync(testRoot, { recursive: true, encoding: "utf8" })
	.filter((entry) => SCANNED_FILE.test(entry))
	.sort();

if (files.length === 0) {
	process.stderr.write(`No source file found under ${TEST_TREE} at all: the walk missed the test tree\n`);
	process.exit(1);
}
const found = files.flatMap((entry) => {
	const file = `${TEST_TREE}/${entry.split(path.sep).join("/")}`;
	return scanRepositoryPathDerivations(file, readFileSync(path.join(testRoot, entry), "utf8"));
});
if (found.length > 0) {
	process.stderr.write(`${reportLines(found).join("\n")}\n`);
	process.exit(1);
}
process.stdout.write(
	`Repository paths: ${files.length} test files scanned, every derivation goes through the marker\n`
);
