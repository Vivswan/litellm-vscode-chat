/**
 * Resolves package.json manifest strings for tests that compare them against
 * runtime titles: a "%key%" value goes through package.nls.json, anything else
 * passes through unchanged - as does everything when package.nls.json does not
 * exist yet, so the helper works on both sides of the externalization.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { REPO_ROOT } from "./repoRoot";

const nlsSchema = z.record(z.string(), z.string());

let cached: { readonly table: Readonly<Record<string, string>> | null } | undefined;

function readNlsTable(): Readonly<Record<string, string>> | null {
	if (cached === undefined) {
		const nlsPath = path.join(REPO_ROOT, "package.nls.json");
		cached = {
			table: fs.existsSync(nlsPath) ? nlsSchema.parse(JSON.parse(fs.readFileSync(nlsPath, "utf8"))) : null,
		};
	}
	return cached.table;
}

/** Resolve one manifest value; throws on a %key% that package.nls.json exists but does not define. */
export function resolveNls(value: string): string {
	// Key-shaped references only, mirroring vsce's substitution: a literal value
	// that merely contains percent signs ("100%") passes through.
	const match = /^%([\w\d.]+)%$/.exec(value);
	if (match === null) {
		return value;
	}
	const table = readNlsTable();
	if (table === null) {
		return value;
	}
	const resolved = table[match[1] ?? ""];
	if (resolved === undefined) {
		throw new Error(`package.nls.json has no entry for ${value}`);
	}
	return resolved;
}
