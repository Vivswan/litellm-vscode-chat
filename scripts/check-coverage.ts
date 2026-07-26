import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_FLOOR = 85;

interface CoverageMetric {
	total: number;
	covered: number;
}

interface FileSummary {
	lines?: CoverageMetric;
}

async function main(): Promise<void> {
	const floorArg = process.argv[2];
	const floor = floorArg === undefined ? DEFAULT_FLOOR : Number(floorArg);
	if (!Number.isFinite(floor) || floor < 0 || floor > 100) {
		console.error(`Invalid coverage floor "${floorArg}"; expected a number between 0 and 100.`);
		process.exitCode = 1;
		return;
	}

	const summaryPath = path.join(process.cwd(), "coverage", "coverage-summary.json");
	let raw: string;
	try {
		raw = await fs.readFile(summaryPath, "utf8");
	} catch {
		console.error(`Missing ${summaryPath}; run \`bun run test:coverage\` to generate it.`);
		process.exitCode = 1;
		return;
	}

	// The runner's include/exclude filters apply to runtime script paths before
	// sourcemap remapping, so covering the dist bundle (needed to see the
	// activation-path files the extension host loads from dist/extension.js)
	// also drags remapped node_modules sources into the summary. The floor is
	// therefore computed over the repository's own source files only.
	const summary = JSON.parse(raw) as Record<string, FileSummary>;
	const srcPrefix = `${path.join(process.cwd(), "src")}${path.sep}`;
	let total = 0;
	let covered = 0;
	let fileCount = 0;
	for (const [file, metrics] of Object.entries(summary)) {
		if (file === "total" || !file.startsWith(srcPrefix)) {
			continue;
		}
		const lines = metrics.lines;
		if (!lines || !Number.isFinite(lines.total) || !Number.isFinite(lines.covered)) {
			continue;
		}
		total += lines.total;
		covered += lines.covered;
		fileCount++;
	}

	if (fileCount === 0 || total === 0) {
		console.error(`No source-file line coverage found in ${summaryPath}.`);
		process.exitCode = 1;
		return;
	}

	const pct = Math.round((covered / total) * 10000) / 100;
	if (pct < floor) {
		console.error(
			`Source line coverage ${pct}% (${covered}/${total} across ${fileCount} files) is below the floor of ${floor}%.`
		);
		process.exitCode = 1;
		return;
	}

	console.log(
		`Source line coverage ${pct}% (${covered}/${total} across ${fileCount} files) meets the floor of ${floor}%.`
	);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
