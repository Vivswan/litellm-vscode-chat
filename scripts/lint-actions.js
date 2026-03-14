const fs = require("node:fs/promises");
const path = require("node:path");
const { createLinter } = require("actionlint");

async function main() {
	const workflowsDir = path.join(process.cwd(), ".github", "workflows");
	const entries = await fs.readdir(workflowsDir, { withFileTypes: true });
	const files = entries
		.filter((entry) => entry.isFile() && /\.(ya?ml)$/i.test(entry.name))
		.map((entry) => path.join(workflowsDir, entry.name))
		.sort();

	const lint = await createLinter();
	const findings = [];

	for (const file of files) {
		const input = await fs.readFile(file, "utf8");
		findings.push(...lint(input, path.relative(process.cwd(), file)));
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
