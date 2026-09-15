/**
 * Regenerates the agent tools' inputSchema blocks in package.json from their
 * zod envelopes. `--check` verifies instead of writing and exits 1 on drift.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { regenerateToolSchemas } from "./toolSchemas";

/** The whole flag vocabulary; an unknown argument aborts, so a typo'd --check cannot silently rewrite the manifest. */
function parseArgs(argv: readonly string[]): { readonly check: boolean } {
	let check = false;
	for (const arg of argv) {
		if (arg === "--check") {
			check = true;
			continue;
		}
		throw new Error(`unknown argument ${arg}; the only flag is --check`);
	}
	return { check };
}

function main(): void {
	const { check } = parseArgs(process.argv.slice(2));
	const file = path.join(process.cwd(), "package.json");
	const content = fs.readFileSync(file, "utf8");
	const { next, drifted } = regenerateToolSchemas(content);
	if (drifted.length === 0) {
		console.log(check ? "tool-schemas check passed." : "tool-schemas: package.json already up to date.");
		return;
	}
	if (check) {
		for (const name of drifted) {
			console.error(`tool-schemas: ${name} inputSchema is stale; run: bun run tools:schemas`);
		}
		process.exitCode = 1;
		return;
	}
	fs.writeFileSync(file, next);
	console.log(`tool-schemas: wrote package.json (${drifted.join(", ")})`);
}

try {
	main();
} catch (error) {
	// The message first: a CI failure's opening stderr line should be the
	// actionable text, not a code frame.
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
}
