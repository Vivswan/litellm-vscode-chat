/**
 * Regenerates the generated contributes blocks of package.json from the setting spec. `--check` verifies instead of
 * writing and exits 1 on drift; `--stage` writes and stages the changed output for the pre-commit hook, refusing dirty
 * inputs or outputs; `--root <dir>` points the output at another directory (tests use it).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseGeneratorArgs } from "../generatorArgs";
import { assertStageable, writeAndStage } from "../stageGenerated";
import { renderConfiguration } from "./configuration";
import { applyContributes } from "./write";

const MANIFEST_PATH = "package.json";

function main(): void {
	const { mode, root } = parseGeneratorArgs(process.argv.slice(2));
	if (mode === "stage") {
		assertStageable(root, [MANIFEST_PATH]);
	}
	const file = path.join(root, MANIFEST_PATH);
	const content = fs.readFileSync(file, "utf8");
	const { next, drifted } = applyContributes(content, { configuration: renderConfiguration() });
	if (mode === "stage") {
		writeAndStage(root, "manifest", [{ relativePath: MANIFEST_PATH, next }]);
		return;
	}
	if (next === content) {
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
	fs.writeFileSync(file, next);
	console.log(`manifest: wrote package.json (${stale.join(", ")})`);
}

try {
	main();
} catch (error) {
	// The message first: a CI failure's opening stderr line should be the actionable text, not a code frame.
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
}
