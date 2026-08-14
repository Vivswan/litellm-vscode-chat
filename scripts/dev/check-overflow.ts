/**
 * Sweeps every render fixture for horizontal overflow at the widths the
 * stylesheet itself declares, and fails when the page scrolls sideways at any
 * of them.
 *
 * This is the successor to the pixel baseline, and deliberately a much smaller
 * claim than it was. A baseline asked "does this look like it did", which made
 * every deliberate improvement a negotiation; this asks only "does the page
 * fit", which is never a matter of taste and is the one failure a full-page
 * capture cannot show - a screenshot of an overflowing page photographs the
 * overflow as though the page were that wide.
 *
 * The widths are read out of the dashboard rather than listed here, so a new
 * breakpoint is swept the moment it is written: the stylesheet's own queries
 * and the components' pane variants, which are equally real and where some
 * thresholds live only. Pane thresholds are container queries and go to
 * --pane-widths, which converts them to viewport widths by measuring the rail;
 * window queries (the rail's own collapse) go to --widths as they are. Each
 * threshold is tested on both sides, since a breakpoint's bug is usually on one
 * of them, plus the floor the shell declares.
 *
 * Exit 1 means a page did not fit. Exit 2 means every page that could be
 * measured fit, but some fixture never ran - a stale step is a different
 * problem from a layout one and reads as one here.
 *
 * Usage:
 *   bun scripts/dev/check-overflow.ts [--only <substring>] [--jobs 4]
 */
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const REPO_ROOT = path.resolve(__dirname, "../..");
const FIXTURE_DIR = path.join(REPO_ROOT, "scripts/dev/renderFixtures");
const HARNESS = path.join(REPO_ROOT, "scripts/dev/render-dashboard.ts");
const STYLESHEET = path.join(REPO_ROOT, "src/webview/dashboard/styles/dashboard.css");
const THEME = path.join(REPO_ROOT, "src/webview/dashboard/styles/theme.css");
/**
 * The trees a class string can live in: the same two theme.css hands Tailwind
 * in its @source lines. A scan narrower than the compiler's is a scan with a
 * blind spot, and a threshold declared in the shared tree is as real as one in
 * a component.
 */
const CLASS_TREES = [path.join(REPO_ROOT, "src/webview"), path.join(REPO_ROOT, "src/dashboard")];

/** Reads one number out of a file, and says which one is missing when it is. */
function declared(source: string, pattern: RegExp, what: string): number {
	const found = pattern.exec(source);
	if (found?.[1] === undefined) {
		throw new Error(`Cannot read ${what} out of the stylesheet`);
	}
	return Number(found[1]);
}

/**
 * The narrowest viewport the page promises not to scroll sideways at, read
 * from the shell's own floor rather than restated here. The rule's comment is
 * the promise: below it a horizontal scrollbar says the window is too narrow,
 * and above it the page has to fit.
 */
function floorWidth(css: string): number {
	return declared(css, /\.shell \{[^}]*min-width: (\d+)px/s, "the shell's minimum width");
}

/** Both sides of a threshold: the last width inside it and the first outside. */
function bothSides(thresholds: readonly number[]): number[] {
	return [...new Set(thresholds.flatMap((threshold) => [threshold - 1, threshold]))].sort((a, b) => a - b);
}

/**
 * Every width the dashboard changes layout at, split by what it measures.
 *
 * Both halves of the pane's vocabulary, because a threshold declared in a class
 * string is as real as one in the stylesheet and 910 lives only in components.
 * One spelling each, which is not an assumption but a guarantee: a suite fails
 * the build when a pane query or variant is written any other way, so these two
 * patterns see all of them.
 */
function declaredThresholds(css: string): { readonly pane: number[]; readonly window: number[] } {
	const classStrings = CLASS_TREES.flatMap((tree) =>
		readdirSync(tree, { recursive: true, encoding: "utf8" })
			.filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
			.map((name) => readFileSync(path.join(tree, name), "utf8"))
	).join("\n");
	const read = (source: string, pattern: RegExp): number[] =>
		[...source.matchAll(pattern)].map((match) => Number(match[1]));
	// Both directions. The pane's guard admits `>=` as well as `<` (the pair
	// cannot overlap at N the way a max-width and a min-width can), and a tier
	// that only exists above a width is a tier this would otherwise never
	// enter: 1136 is one today.
	const paneCss = [
		...read(css, /@container pane \(width < (\d+)px\)/g),
		...read(css, /@container pane \(width >= (\d+)px\)/g),
	];
	const paneVariants = [
		...read(classStrings, /@max-\[(\d+)px\]\/pane:/g),
		...read(classStrings, /@min-\[(\d+)px\]\/pane:/g),
	];
	const window = [...read(css, /@media \(width < (\d+)px\)/g), ...read(css, /@media \(width >= (\d+)px\)/g)];
	// Floored per SOURCE, not on the total: the two extractors fail
	// independently, and a merged floor is met by either one of them alone.
	if (paneCss.length < 3 || paneVariants.length < 3 || window.length < 1) {
		throw new Error(
			`Harvested ${paneCss.length} pane queries, ${paneVariants.length} pane variants and ${window.length} ` +
				"window queries; the dashboard declares more of each, so one of the scans is broken"
		);
	}
	return {
		pane: [...new Set([...paneCss, ...paneVariants])],
		window: [...new Set(window)],
	};
}

/** The fixture modules, which are every file in the directory but the shared helpers. */
function fixtures(only: string | undefined): string[] {
	return readdirSync(FIXTURE_DIR)
		.filter((name) => name.endsWith(".ts") && name !== "shared.ts")
		.filter((name) => only === undefined || name.includes(only))
		.sort()
		.map((name) => path.join(FIXTURE_DIR, name));
}

interface Result {
	readonly fixture: string;
	readonly ok: boolean;
	readonly output: string;
}

async function sweep(fixture: string, widths: readonly number[], paneWidths: readonly number[]): Promise<Result> {
	const child = spawn(
		process.execPath,
		[HARNESS, "--fixture", fixture, "--widths", widths.join(","), "--pane-widths", paneWidths.join(",")],
		{ cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] }
	);
	let output = "";
	child.stdout.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	const code = await new Promise<number>((resolve) => child.on("close", (status) => resolve(status ?? 1)));
	return { fixture: path.basename(fixture), ok: code === 0, output };
}

async function main(): Promise<void> {
	const { values } = parseArgs({ options: { only: { type: "string" }, jobs: { type: "string" } } });
	const jobs = values.jobs === undefined ? 4 : Number(values.jobs);
	if (!Number.isInteger(jobs) || jobs < 1) {
		throw new Error(`--jobs takes a positive integer; got ${values.jobs}`);
	}
	const css = [STYLESHEET, THEME]
		.map((sheet) => readFileSync(sheet, "utf8").replace(/\/\*[\s\S]*?\*\//g, ""))
		.join("\n");
	const thresholds = declaredThresholds(css);
	const widths = [floorWidth(css), ...bothSides(thresholds.window)];
	const paneWidths = bothSides(thresholds.pane);
	const queue = fixtures(values.only);
	if (queue.length === 0) {
		throw new Error(`No fixtures matched ${values.only ?? "(everything)"}`);
	}
	console.log(`sweeping ${queue.length} fixture(s)`);
	console.log(`  viewport widths: ${widths.join(", ")}`);
	console.log(`  pane widths:     ${paneWidths.join(", ")}`);
	const results: Result[] = [];
	// A pool rather than a map: each sweep launches its own Chrome, so running
	// the whole set at once would ask for sixty of them.
	await Promise.all(
		Array.from({ length: Math.min(jobs, queue.length) }, async () => {
			for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
				const result = await sweep(next, widths, paneWidths);
				results.push(result);
				console.log(`${result.ok ? "ok  " : "FAIL"} ${result.fixture}`);
			}
		})
	);
	const failed = results.filter((result) => !result.ok).sort((a, b) => a.fixture.localeCompare(b.fixture));
	for (const result of failed) {
		console.log(`\n--- ${result.fixture} ---\n${result.output.trim()}`);
	}
	// Two failures with nothing to do with each other: a page that does not fit
	// is what this sweeps for, while a fixture whose own steps threw never got
	// as far as being measured. Counted apart so a stale fixture cannot read as
	// a layout regression, or hide one.
	const overflowing = failed.filter((result) => result.output.includes("scrolls sideways"));
	const unrunnable = failed.filter((result) => !result.output.includes("scrolls sideways"));
	// Counted apart from the rest, because they were asserted once rather than
	// swept: a summary that folded them in would claim a coverage they opted out
	// of by declaring measuredAtOwnWidth.
	const ownWidthOnly = results.filter((result) => result.ok && result.output.includes("skipped the width sweep"));
	const swept = results.length - failed.length - ownWidthOnly.length;
	console.log(`\n${swept}/${results.length} fixtures fit at every declared width`);
	if (ownWidthOnly.length > 0) {
		console.log(`${ownWidthOnly.length} fit at their own width, having opted out of the sweep`);
	}
	if (overflowing.length > 0) {
		console.log(`${overflowing.length} overflowed: ${overflowing.map((result) => result.fixture).join(", ")}`);
	}
	if (unrunnable.length > 0) {
		console.log(`${unrunnable.length} never ran: ${unrunnable.map((result) => result.fixture).join(", ")}`);
	}
	if (overflowing.length > 0) {
		process.exitCode = 1;
	} else if (unrunnable.length > 0) {
		process.exitCode = 2;
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
