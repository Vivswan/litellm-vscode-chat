/**
 * The flag vocabulary the two generator CLIs share: `--check` verifies and exits 1 on drift, `--stage` writes and
 * stages for the pre-commit hook, `--root <dir>` points the output files at another directory (the fixture tests use
 * it; the sources are always the checkout the script was loaded from). `--stage` takes no `--root` and ignores the
 * working directory: it always targets the checkout this module lives in, so the dirty-input refusal and the staged
 * outputs name the same repository. An unknown argument aborts, so a typo'd --check cannot silently rewrite a
 * generated file.
 */
import * as path from "node:path";
import { parseArgs } from "node:util";

/** The checkout these scripts belong to: two levels above scripts/dev. */
const SOURCE_CHECKOUT = path.resolve(__dirname, "..", "..");

export interface GeneratorArgs {
	readonly mode: "write" | "check" | "stage";
	readonly root: string;
}

export function parseGeneratorArgs(argv: readonly string[]): GeneratorArgs {
	let values: { check?: boolean; stage?: boolean; root?: string };
	try {
		values = parseArgs({
			args: [...argv],
			options: { check: { type: "boolean" }, stage: { type: "boolean" }, root: { type: "string" } },
			strict: true,
			allowPositionals: false,
		}).values;
	} catch (error) {
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}; the flags are --check, --stage, and --root <dir>`
		);
	}
	if (values.check === true && values.stage === true) {
		throw new Error("--check and --stage exclude each other");
	}
	if (values.root !== undefined && (values.root === "" || values.root.startsWith("--"))) {
		throw new Error("--root needs a directory");
	}
	if (values.stage === true) {
		if (values.root !== undefined) {
			throw new Error("--stage regenerates the checkout it was loaded from; it takes no --root");
		}
		return { mode: "stage", root: SOURCE_CHECKOUT };
	}
	return {
		mode: values.check === true ? "check" : "write",
		root: values.root === undefined ? process.cwd() : path.resolve(values.root),
	};
}
