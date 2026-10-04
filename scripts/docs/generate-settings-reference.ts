/**
 * Regenerates each locale's settings reference table. `--check` verifies instead of writing and exits 1 on drift;
 * `--root <dir>` points the output docs at another directory (tests use it). Nothing regenerates on the developer's
 * behalf: the pre-commit hook and CI run `--check`, refuse drift, and name the command.
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
				`settings-reference: ${relativePath} is stale; run: bun run docs:settings, then stage the docs and commit again`
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
