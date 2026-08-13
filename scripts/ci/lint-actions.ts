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
	// raises only because its permission-scope list is stale (CI runs the
	// current binary via raven-actions/actionlint, which knows these scopes).
	const staleFindings = [/unknown permission scope "(attestations|vulnerability-alerts)"/];

	for (const file of files) {
		const input = await fs.readFile(file, "utf8");
		// A fresh linter per file: reusing one instance grows the WASM memory
		// across calls until the actionlint wrapper crashes out of bounds.
		const lint = await createLinter();
		const results = lint(input, path.relative(process.cwd(), file));
		findings.push(...results.filter((result) => !staleFindings.some((pattern) => pattern.test(result.message))));
	}

	if (findings.length === 0) {
		return;
	}

	for (const finding of findings) {
		console.error(`${finding.file}:${finding.line}:${finding.column}: ${finding.kind}: ${finding.message}`);
	}

	process.exitCode = 1;
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
