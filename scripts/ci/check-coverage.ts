import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_FLOOR = 85;

/** Per-file line-hit sets: line number -> hit at least once. */
type FileLines = Map<number, boolean>;

/**
 * The two coverage runs and, for each, a source file only that runner can
 * load. The sentinels are drift guards: path-form or filter drift in either
 * report must fail loudly, never shrink the floor's denominator to whichever
 * report still parses.
 */
const REPORTS = [
	{ lcovPath: path.join("coverage", "lcov.info"), sentinel: "src/extension.ts" },
	{ lcovPath: path.join("coverage", "bun", "lcov.info"), sentinel: "src/webview/dashboard/app.tsx" },
];

/**
 * Repo-relative path with forward slashes. Both runners emit repo-relative
 * lcov today; the absolute branch keeps a reporter that emits absolute paths
 * from slipping past the src/ filter unstripped. Slashes normalize first so a
 * Windows path in either form strips the same.
 */
function normalizePath(file: string): string {
	const normalized = file.replaceAll("\\", "/");
	const cwdPrefix = `${process.cwd().replaceAll("\\", "/")}/`;
	return normalized.startsWith(cwdPrefix) ? normalized.slice(cwdPrefix.length) : normalized;
}

/** Minimal lcov reader: only SF/DA/end_of_record matter for a line floor. */
function parseLcov(text: string): Map<string, FileLines> {
	const files = new Map<string, FileLines>();
	let current: FileLines | undefined;
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (line.startsWith("SF:")) {
			const file = normalizePath(line.slice(3));
			current = files.get(file);
			if (!current) {
				current = new Map();
				files.set(file, current);
			}
		} else if (line.startsWith("DA:") && current) {
			const [lineNo, hits] = line.slice(3).split(",");
			const parsedLine = Number(lineNo);
			if (Number.isInteger(parsedLine) && parsedLine > 0) {
				current.set(parsedLine, (current.get(parsedLine) ?? false) || Number(hits) > 0);
			}
		} else if (line === "end_of_record") {
			current = undefined;
		}
	}
	return files;
}

async function main(): Promise<void> {
	const floorArg = process.argv[2];
	const floor = floorArg === undefined ? DEFAULT_FLOOR : Number(floorArg);
	if (!Number.isFinite(floor) || floor < 0 || floor > 100) {
		console.error(`Invalid coverage floor "${floorArg}"; expected a number between 0 and 100.`);
		process.exitCode = 1;
		return;
	}

	// A line counts as covered when either run hit it: line-level union is the
	// only sound merge across runners, since two 50% summaries can cover
	// disjoint halves or the same half.
	const merged = new Map<string, FileLines>();
	for (const { lcovPath, sentinel } of REPORTS) {
		let text: string;
		try {
			text = await fs.readFile(lcovPath, "utf8");
		} catch {
			console.error(`Missing ${lcovPath}; run \`bun run test:coverage\` to generate both lcov files.`);
			process.exitCode = 1;
			return;
		}
		const files = parseLcov(text);
		if (!files.has(sentinel)) {
			console.error(`${lcovPath} does not cover ${sentinel}; its paths or filters have drifted.`);
			process.exitCode = 1;
			return;
		}
		for (const [file, lines] of files) {
			const target = merged.get(file) ?? new Map<number, boolean>();
			merged.set(file, target);
			for (const [lineNo, hit] of lines) {
				target.set(lineNo, (target.get(lineNo) ?? false) || hit);
			}
		}
	}

	// The floor is over the repository's own non-test source files only: the
	// host runner's filters apply before sourcemap remapping, so covering the
	// dist bundle drags remapped node_modules sources in, and the bun run
	// covers the test harness files themselves.
	let total = 0;
	let covered = 0;
	let fileCount = 0;
	for (const [file, lines] of merged) {
		if (!file.startsWith("src/") || file.startsWith("src/test/") || lines.size === 0) {
			continue;
		}
		total += lines.size;
		for (const hit of lines.values()) {
			if (hit) {
				covered++;
			}
		}
		fileCount++;
	}

	if (fileCount === 0 || total === 0) {
		console.error("No source-file line coverage found in the lcov reports.");
		process.exitCode = 1;
		return;
	}

	const pct = Math.round((covered / total) * 10000) / 100;
	const summary = `Merged source line coverage ${pct}% (${covered}/${total} across ${fileCount} files)`;
	if (pct < floor) {
		console.error(`${summary} is below the floor of ${floor}%.`);
		process.exitCode = 1;
		return;
	}

	console.log(`${summary} meets the floor of ${floor}%.`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
