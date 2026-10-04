/**
 * Regenerates each locale's settings reference table. `--check` verifies instead of writing and exits 1 on drift;
 * `--stage` writes and stages the changed docs for the pre-commit hook, refusing dirty inputs or outputs; `--root
 * <dir>` points the output docs at another directory (tests use it).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseGeneratorArgs } from "../dev/generatorArgs";
import { assertStageable, type GeneratedFile, writeAndStage } from "../dev/stageGenerated";
import { applyReferenceTable, buildReferenceTable, DOC_LOCALES, readSpecSettings, SETTINGS_DOC_PATHS } from "./lib";

function main(): void {
	const { mode, root } = parseGeneratorArgs(process.argv.slice(2));
	const outputs = DOC_LOCALES.map((locale) => SETTINGS_DOC_PATHS[locale]);
	if (mode === "stage") {
		assertStageable(root, outputs);
	}
	const settings = readSpecSettings();
	// Two phases so one locale's failure cannot leave another already rewritten.
	const rendered: GeneratedFile[] = [];
	for (const locale of DOC_LOCALES) {
		const relativePath = SETTINGS_DOC_PATHS[locale];
		const content = fs.readFileSync(path.join(root, relativePath), "utf8");
		rendered.push({ relativePath, next: applyReferenceTable(content, locale, buildReferenceTable(locale, settings)) });
	}
	if (mode === "stage") {
		writeAndStage(root, "settings-reference", rendered);
		return;
	}
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
