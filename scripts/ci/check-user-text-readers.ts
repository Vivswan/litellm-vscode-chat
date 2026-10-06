/**
 * Fails when a settings reader trims, numbers, or coerces a user's text itself instead of reading through the two
 * homes, or when an allowlist row matches no read. .husky/pre-commit (check:static) and the format-check workflow run
 * this one script, so a local green predicts the gate.
 *
 *   no argument                  -> tsconfig.prod.json's reader modules under ALLOWED_READS
 *   --scope <file>, repeatable   -> those files alone are the program and the reader modules (the exit-code test's door)
 *   --allow <file>:<function>    -> the allowlist in place of ALLOWED_READS; needs --scope
 *   zero reads anywhere          -> exit 1: decimalText.ts always calls Number(), so the scan lost its homes
 */
import { statSync } from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { type AllowedRead, DECIMAL_HOME, scanUserTextReaders, TRIM_HOME } from "./user-text-readers";

const rootDir = path.resolve(__dirname, "../..");
const tsconfigPath = path.join(rootDir, "tsconfig.prod.json");

function usage(message: string): never {
	process.stderr.write(
		`${message}\nusage: check-user-text-readers.ts [--scope <file>]... [--allow <file>:<function>]...\n`
	);
	process.exit(2);
}

function parsedArguments(): { scope?: string[]; allow?: string[] } {
	try {
		return parseArgs({
			options: { scope: { type: "string", multiple: true }, allow: { type: "string", multiple: true } },
			strict: true,
			allowPositionals: false,
		}).values;
	} catch (error) {
		return usage(error instanceof Error ? error.message : String(error));
	}
}

/** False for a missing path and for a path through a file (ENOTDIR), both of which name no file. */
function isFile(absolute: string): boolean {
	try {
		return statSync(absolute).isFile();
	} catch {
		return false;
	}
}

/** Repository-relative with forward slashes, the identity the scan matches files by. */
function scopeModule(scope: string): string {
	const absolute = path.resolve(rootDir, scope);
	if (!isFile(absolute)) {
		return usage(`--scope ${scope} names no file`);
	}
	return path.relative(rootDir, absolute).split(path.sep).join("/");
}

function allowedRow(value: string): AllowedRead {
	const separator = value.lastIndexOf(":");
	if (separator <= 0 || separator === value.length - 1) {
		return usage(`--allow takes <file>:<function>, got ${value}`);
	}
	return {
		file: scopeModule(value.slice(0, separator)),
		function: value.slice(separator + 1),
		reason: "named on the command line",
	};
}

const arguments_ = parsedArguments();
const modules = (arguments_.scope ?? []).map(scopeModule);
const allowed = (arguments_.allow ?? []).map(allowedRow);
if (modules.length === 0 && allowed.length > 0) {
	usage("--allow needs --scope");
}

const { seen, refused, unusedAllowed } =
	modules.length === 0
		? scanUserTextReaders(tsconfigPath)
		: scanUserTextReaders(
				tsconfigPath,
				modules.map((module) => path.join(rootDir, module)),
				{ modules, allowed }
			);

if (seen === 0) {
	process.stderr.write(
		`No trim or number read found at all: ${DECIMAL_HOME} always calls Number(), so the scan lost its homes\n`
	);
	process.exit(1);
}
if (refused.length > 0 || unusedAllowed.length > 0) {
	for (const read of refused) {
		process.stderr.write(
			`${read.file}:${read.line}:${read.column}: ${read.shape} reads user text outside the one rule\n`
		);
	}
	for (const row of unusedAllowed) {
		process.stderr.write(
			`${row.file}: ALLOWED_READS names ${row.function}, which has no trim or number read; delete the row\n`
		);
	}
	process.stderr.write(
		`Settings readers trim through usableHttpText or trimHttpWhitespace (${TRIM_HOME}) and number through ` +
			`parseDecimalText (${DECIMAL_HOME}); a read that is not user text is an ALLOWED_READS row carrying its reason.\n`
	);
	process.exit(1);
}
process.stdout.write(`User-text readers: ${seen} trim and number reads, none outside the one rule\n`);
