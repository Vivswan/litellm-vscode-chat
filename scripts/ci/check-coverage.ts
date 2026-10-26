import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_FLOOR = 85;

/** line number -> hit at least once. */
type FileLines = Map<number, boolean>;

/** The merged line counts the floor is judged on. */
interface Tally {
	total: number;
	covered: number;
	fileCount: number;
}

/** The two coverage runs, each with a sentinel file only that runner loads, so path or filter drift fails loudly. */
const REPORTS = [
	{ lcovPath: path.join("coverage", "lcov.info"), sentinel: "src/extension.ts" },
	{ lcovPath: path.join("coverage", "bun", "lcov.info"), sentinel: "src/webview/dashboard/app.tsx" },
];

/**
 * Both runners emit repo-relative lcov today; the absolute branch keeps a reporter that emits absolute paths from
 * slipping past the src/ filter unstripped. Slashes normalize first so a Windows path in either form strips the same.
 */
function normalizePath(file: string): string {
	const normalized = file.replaceAll("\\", "/");
	const cwdPrefix = `${process.cwd().replaceAll("\\", "/")}/`;
	return normalized.startsWith(cwdPrefix) ? normalized.slice(cwdPrefix.length) : normalized;
}

/** The map of a file's line hits, created on its first SF record. */
function fileLines(files: Map<string, FileLines>, file: string): FileLines {
	const existing = files.get(file);
	if (existing !== undefined) {
		return existing;
	}
	const created: FileLines = new Map();
	files.set(file, created);
	return created;
}

/** A `DA:` record's line number and hit flag, or undefined for one whose line is not a positive integer. */
function lineRecord(record: string): { readonly line: number; readonly hit: boolean } | undefined {
	const [lineNo, hits] = record.split(",");
	const line = Number(lineNo);
	if (!Number.isInteger(line) || line <= 0) {
		return undefined;
	}
	return { line, hit: Number(hits) > 0 };
}

/** Minimal lcov reader: only SF/DA/end_of_record matter for a line floor. */
function parseLcov(text: string): Map<string, FileLines> {
	const files = new Map<string, FileLines>();
	let current: FileLines | undefined;
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (line.startsWith("SF:")) {
			current = fileLines(files, normalizePath(line.slice(3)));
			continue;
		}
		if (line === "end_of_record") {
			current = undefined;
			continue;
		}
		if (!line.startsWith("DA:") || current === undefined) {
			continue;
		}
		const record = lineRecord(line.slice(3));
		if (record !== undefined) {
			current.set(record.line, (current.get(record.line) ?? false) || record.hit);
		}
	}
	return files;
}

/** The floor from argv, or undefined after reporting an invalid one. */
function parseFloor(argument: string | undefined): number | undefined {
	const floor = argument === undefined ? DEFAULT_FLOOR : Number(argument);
	if (!Number.isFinite(floor) || floor < 0 || floor > 100) {
		console.error(`Invalid coverage floor "${argument}"; expected a number between 0 and 100.`);
		return undefined;
	}
	return floor;
}

/** One report's files, or undefined after reporting a missing file or a sentinel without line data. */
async function readReport(lcovPath: string, sentinel: string): Promise<Map<string, FileLines> | undefined> {
	let text: string;
	try {
		text = await fs.readFile(lcovPath, "utf8");
	} catch {
		console.error(`Missing ${lcovPath}; run \`bun run test:coverage\` to generate both lcov files.`);
		return undefined;
	}
	const files = parseLcov(text);
	// Line data, not mere presence: an SF header with no DA records would pass a presence check while shrinking the
	// floor's denominator.
	if ((files.get(sentinel)?.size ?? 0) === 0) {
		console.error(`${lcovPath} has no line data for ${sentinel}; its paths or filters have drifted.`);
		return undefined;
	}
	return files;
}

/**
 * The union of both reports' line hits, or undefined once a report failed to read. A line counts as covered when
 * either run hit it: line-level union is the only sound merge across runners, since two 50% summaries can cover
 * disjoint halves or the same half.
 */
async function mergedReports(): Promise<Map<string, FileLines> | undefined> {
	const merged = new Map<string, FileLines>();
	for (const { lcovPath, sentinel } of REPORTS) {
		const files = await readReport(lcovPath, sentinel);
		if (files === undefined) {
			return undefined;
		}
		for (const [file, lines] of files) {
			const target = fileLines(merged, file);
			for (const [lineNo, hit] of lines) {
				target.set(lineNo, (target.get(lineNo) ?? false) || hit);
			}
		}
	}
	return merged;
}

/**
 * Line totals over the repository's own non-test source files only: the host runner's filters apply before sourcemap
 * remapping, so covering the dist bundle drags remapped node_modules sources in, and the bun run covers the test
 * harness files themselves.
 */
function sourceTally(merged: ReadonlyMap<string, FileLines>): Tally {
	const tally: Tally = { total: 0, covered: 0, fileCount: 0 };
	for (const [file, lines] of merged) {
		if (!file.startsWith("src/") || file.startsWith("src/test/") || lines.size === 0) {
			continue;
		}
		tally.total += lines.size;
		for (const hit of lines.values()) {
			if (hit) {
				tally.covered++;
			}
		}
		tally.fileCount++;
	}
	return tally;
}

async function main(): Promise<void> {
	const floor = parseFloor(process.argv[2]);
	if (floor === undefined) {
		process.exitCode = 1;
		return;
	}

	const merged = await mergedReports();
	if (merged === undefined) {
		process.exitCode = 1;
		return;
	}

	const { total, covered, fileCount } = sourceTally(merged);
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
