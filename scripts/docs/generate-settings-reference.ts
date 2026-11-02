/**
 * Regenerates each locale's settings reference table (generatorArgs.ts names the flags). Nothing regenerates on the
 * developer's behalf: the pre-commit hook and CI run `--check`.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseGeneratorArgs } from "../dev/generatorArgs";
import { renderSettingsReference } from "./lib";

/** The checkout this script was loaded from: biome's config and launcher live there, whatever --root points at. */
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const BIOME_LAUNCHER = path.join(REPO_ROOT, "node_modules", "@biomejs", "biome", "bin", "biome");
const FORMAT_TIMEOUT_MS = 60_000;

/**
 * Returns `content` as biome's Markdown formatter prints it for `relativePath`, so a generated page passes the same
 * format check as a hand-edited one. Biome pads table columns by display width, which the renderer does not try to
 * reproduce. Throws when biome does not exit 0.
 */
function formatMarkdown(relativePath: string, content: string): string {
	const result = spawnSync(process.execPath, [BIOME_LAUNCHER, "format", "--stdin-file-path", relativePath], {
		cwd: REPO_ROOT,
		input: content,
		encoding: "utf8",
		timeout: FORMAT_TIMEOUT_MS,
	});
	if (result.status !== 0) {
		throw new Error(`biome format failed for ${relativePath}: ${result.error?.message ?? result.stderr.trim()}`);
	}
	return result.stdout;
}

function main(): void {
	const { mode, root } = parseGeneratorArgs(process.argv.slice(2));
	const rendered = renderSettingsReference(root).map((file) => ({
		relativePath: file.relativePath,
		next: formatMarkdown(file.relativePath, file.next),
	}));
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
