/**
 * The flag vocabulary the two generator CLIs share: `--check` verifies and exits 1 on drift, `--root <dir>` points the
 * output files at another directory (the fixture tests use it; the sources are always the checkout the script was
 * loaded from). An unknown argument aborts, so a typo'd --check cannot silently rewrite a generated file.
 */
import * as path from "node:path";
import { parseArgs } from "node:util";

export interface GeneratorArgs {
	readonly mode: "write" | "check";
	readonly root: string;
}

export function parseGeneratorArgs(argv: readonly string[]): GeneratorArgs {
	let values: { check?: boolean; root?: string };
	try {
		values = parseArgs({
			args: [...argv],
			options: { check: { type: "boolean" }, root: { type: "string" } },
			strict: true,
			allowPositionals: false,
		}).values;
	} catch (error) {
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}; the flags are --check and --root <dir>`
		);
	}
	if (values.root !== undefined && (values.root === "" || values.root.startsWith("--"))) {
		throw new Error("--root needs a directory");
	}
	return {
		mode: values.check === true ? "check" : "write",
		root: values.root === undefined ? process.cwd() : path.resolve(values.root),
	};
}
