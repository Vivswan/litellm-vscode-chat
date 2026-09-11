import fs from "node:fs/promises";
import path from "node:path";
import { createLinter, type LintResult } from "actionlint";

async function main(): Promise<void> {
	const workflowsDir = path.join(process.cwd(), ".github", "workflows");
	const entries = await fs.readdir(workflowsDir, { withFileTypes: true });
	const files = entries
		.filter((entry) => entry.isFile() && /\.(ya?ml)$/i.test(entry.name))
		.map((entry) => path.join(workflowsDir, entry.name))
		.sort();

	const findings: LintResult[] = [];

	// The npm actionlint wasm build lags the upstream binary; drop findings it
	// raises only because its permission-scope list is stale, or because it
	// does not know the `vars` context inside a `with:` block (CI runs the
	// current binary via raven-actions/actionlint, which accepts both).
	const staleScopes = /unknown permission scope "(attestations|vulnerability-alerts)"/;
	const staleVars = /^undefined variable "vars"\. available variables are/;
	const isStale = (result: LintResult, lines: string[]): boolean =>
		staleScopes.test(result.message) || (staleVars.test(result.message) && parentKey(lines, result.line) === "with:");

	for (const file of files) {
		const input = await fs.readFile(file, "utf8");
		const lines = input.split("\n");
		// A fresh linter per file: reusing one instance grows the WASM memory
		// across calls until the actionlint wrapper crashes out of bounds.
		const lint = await createLinter();
		const results = lint(input, path.relative(process.cwd(), file));
		findings.push(...results.filter((result) => !isStale(result, lines)));
	}

	if (findings.length === 0) {
		return;
	}

	for (const finding of findings) {
		console.error(`${finding.file}:${finding.line}:${finding.column}: ${finding.kind}: ${finding.message}`);
	}

	process.exitCode = 1;
}

/** The trimmed text of the nearest less-indented non-blank, non-comment line above a 1-based line: the YAML key it sits under. */
function parentKey(lines: string[], line: number): string | undefined {
	const own = lines[line - 1];
	if (own === undefined) {
		return undefined;
	}
	const indent = own.length - own.trimStart().length;
	for (let i = line - 2; i >= 0; i--) {
		const text = lines[i];
		const trimmed = text.trim();
		if (trimmed === "" || trimmed.startsWith("#")) {
			continue;
		}
		if (text.length - text.trimStart().length < indent) {
			return trimmed;
		}
	}
	return undefined;
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
