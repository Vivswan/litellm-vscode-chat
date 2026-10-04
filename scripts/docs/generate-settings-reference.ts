/**
 * Regenerates each locale's settings reference table. `--check` verifies instead of writing and exits 1 on drift;
 * `--root <dir>` points the output docs at another directory (tests use it). The pre-commit hook does not run this:
 * scripts/dev/stageGenerated.ts regenerates and stages its registered generators' outputs in one run.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseGeneratorArgs } from "../dev/generatorArgs";
import { renderSettingsReference } from "./lib";

function main(): void {
	const { mode, root } = parseGeneratorArgs(process.argv.slice(2));
	const rendered = renderSettingsReference(root);
	const stale = rendered.filter((file) => fs.readFileSync(path.join(root, file.relativePath), "utf8") !== file.next);
	for (const { relativePath, next } of stale) {
		if (mode === "check") {
			console.error(
				`settings-reference: ${relativePath} is stale; run: bun scripts/docs/generate-settings-reference.ts`
			);
		} else {
			fs.writeFileSync(path.join(root, relativePath), next);
			console.log(`settings-reference: wrote ${relativePath}`);
		}
	}
	if (mode === "check" && stale.length > 0) {
		process.exitCode = 1;
		return;
	}
	if (stale.length === 0) {
		console.log(mode === "check" ? "settings-reference check passed." : "settings-reference: docs already up to date.");
	}
}

try {
	main();
} catch (error) {
	// The message first: a CI failure's opening stderr line should be the actionable text, not a code frame.
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
}
