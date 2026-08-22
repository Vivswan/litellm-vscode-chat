/**
 * Regenerates each locale's settings reference table. `--check` verifies
 * instead of writing and exits 1 on drift; `--root <dir>` targets another
 * checkout (tests use it).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { applyReferenceTable, buildReferenceTable, DOC_LOCALES, readManifestSettings, SETTINGS_DOC_PATHS } from "./lib";

interface CliArgs {
	readonly check: boolean;
	readonly root: string;
}

/** The whole flag vocabulary; an unknown argument aborts, so a typo'd --check cannot silently rewrite the docs. */
function parseArgs(argv: readonly string[]): CliArgs {
	let check = false;
	let root = process.cwd();
	for (let at = 0; at < argv.length; at += 1) {
		const arg = argv[at];
		if (arg === "--check") {
			check = true;
			continue;
		}
		if (arg === "--root") {
			const value = argv[at + 1];
			if (value === undefined || value.startsWith("--")) {
				throw new Error("--root needs a directory");
			}
			root = path.resolve(value);
			at += 1;
			continue;
		}
		throw new Error(`unknown argument ${arg}; the flags are --check and --root <dir>`);
	}
	return { check, root };
}

function main(): void {
	const { check, root } = parseArgs(process.argv.slice(2));
	const manifest = readManifestSettings(root);
	// Two phases so one locale's failure cannot leave another already rewritten.
	const stale: { docPath: string; file: string; next: string }[] = [];
	for (const locale of DOC_LOCALES) {
		const docPath = SETTINGS_DOC_PATHS[locale];
		const file = path.join(root, docPath);
		const content = fs.readFileSync(file, "utf8");
		const next = applyReferenceTable(content, locale, buildReferenceTable(locale, manifest));
		if (next !== content) {
			stale.push({ docPath, file, next });
		}
	}
	for (const { docPath, file, next } of stale) {
		if (check) {
			console.error(`settings-reference: ${docPath} is stale; run: bun scripts/docs/generate-settings-reference.ts`);
		} else {
			fs.writeFileSync(file, next);
			console.log(`settings-reference: wrote ${docPath}`);
		}
	}
	if (check && stale.length > 0) {
		process.exitCode = 1;
		return;
	}
	if (stale.length === 0) {
		console.log(check ? "settings-reference check passed." : "settings-reference: docs already up to date.");
	}
}

try {
	main();
} catch (error) {
	// The message first: a CI failure's opening stderr line should be the
	// actionable text, not a code frame.
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
}
