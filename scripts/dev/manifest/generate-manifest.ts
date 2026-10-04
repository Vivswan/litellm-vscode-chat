/**
 * Regenerates the contributes blocks of package.json from the code constants and the authored presentation tables
 * (contributions.ts names the blocks). `--check` verifies instead of writing and exits 1 on drift; `--root <dir>` points the output at another directory (tests use it). The pre-commit
 * hook does not run this: scripts/dev/stageGenerated.ts regenerates and stages its registered generators' outputs in
 * one run.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseGeneratorArgs } from "../generatorArgs";
import { MANIFEST_PATH, regenerateManifest } from "./generator";

function main(): void {
	const { mode, root } = parseGeneratorArgs(process.argv.slice(2));
	const { current, next, drifted } = regenerateManifest(root);
	if (next === current) {
		console.log(mode === "check" ? "manifest check passed." : "manifest: package.json already up to date.");
		return;
	}
	// A whole-file difference with no drifted block is the serialization itself (indentation or the trailing newline),
	// named as such.
	const stale = drifted.length === 0 ? ["package.json's formatting"] : drifted.map((key) => `contributes.${key}`);
	if (mode === "check") {
		for (const what of stale) {
			console.error(
				`manifest: ${what} is stale; run: bun run manifest:generate (the pre-commit hook does this; a --no-verify commit or a web edit skipped it)`
			);
		}
		process.exitCode = 1;
		return;
	}
	fs.writeFileSync(path.join(root, MANIFEST_PATH), next);
	console.log(`manifest: wrote package.json (${stale.join(", ")})`);
}

try {
	main();
} catch (error) {
	// The message first: a CI failure's opening stderr line should be the actionable text, not a code frame.
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
}
