/**
 * check-overflow.ts proves "the page fits"; this sweep proves "a state change does not move what it marks", plus a width
 * leg proving each registered surface reaches the pane's content edge at 2000px. THE REGISTRIES (geometryRegistry.ts) ARE
 * THE COVERAGE CLAIM, and every case measures under the pinned faces (render-dashboard.ts), so a green sweep here predicts
 * the Linux-only gate.
 *
 *   an element gaining a mark, reveal, error, or overlay without moving -> STATE_PAIRS entry
 *   a new destination or structural container                           -> WIDTH_SURFACES entry
 *   a text-bearing slot                                                 -> also names itself in metricProbe; its height must survive divergent fonts
 *   disclosure                                                          -> deliberately no pair; open-vs-closed EXISTS to move geometry
 *
 * A stale entry is its own failure, never a green. A case that never ran (vanished selector, inert toggle, baseline already
 * toggled) or an expectedDrift marker whose drift is gone exits 2, apart from the exit 1 of moved geometry.
 *
 * Usage:
 *   bun scripts/dev/check-geometry.ts [--only <substring>] [--jobs 4]
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import ts from "typescript";
import type { Dim, StatePair, WidthSurface } from "./geometryRegistry";
import { marker, paneWidthStep, STATE_PAIRS, UNGUARDED_FIXTURE_PINS, WIDTH_SURFACES } from "./geometryRegistry";

const REPO_ROOT = path.resolve(__dirname, "../..");

const FIXTURE_DIR = path.join(REPO_ROOT, "scripts/dev/renderFixtures");

const HARNESS = path.join(REPO_ROOT, "scripts/dev/render-dashboard.ts");

/**
 * Sub-pixel slack for antialiased layout: two paints of the same box can differ
 * by a rounding step without any rule having moved. Past half a pixel is a rule.
 */
const TOLERANCE_PX = 0.5;

/** The width-extreme viewport: past the pane's 1560px cap plus the rail, so every surface is at its widest. */
const WIDE_VIEWPORT_PX = 2000;

const UNGUARDED_FIXTURES: ReadonlyMap<string, string> = new Map(UNGUARDED_FIXTURE_PINS);

/** The steps digest an exemption pins: content-addressed, so any edit to the flow re-opens the question. */
function stepsDigest(steps: readonly string[]): string {
	return createHash("sha256").update(JSON.stringify(steps)).digest("hex").slice(0, 12);
}

/**
 * Whether a step contains a real throw STATEMENT, by parsing it: a substring
 * test is satisfied by the word in a comment or a string literal, and a guard
 * leg that can be met by prose is met by prose eventually.
 */
function stepThrows(step: string): boolean {
	let found = false;
	const walk = (node: ts.Node): void => {
		if (ts.isThrowStatement(node)) {
			found = true;
			return;
		}
		if (!found) {
			ts.forEachChild(node, walk);
		}
	};
	walk(ts.createSourceFile("step.ts", step, ts.ScriptTarget.Latest, true));
	return found;
}

/**
 * The static guard sweep, over each fixture's EXPORTED shape rather than its
 * text: steps arrive by spread and import as well as by literal, and the
 * assertion has to live in the steps that actually run.
 */
async function fixtureGuardFindings(): Promise<string[]> {
	const findings: string[] = [];
	const names = readdirSync(FIXTURE_DIR)
		.filter((name) => name.endsWith(".ts") && name !== "shared.ts")
		.sort();
	for (const name of names) {
		const module = (await import(pathToFileURL(path.join(FIXTURE_DIR, name)).href)) as {
			default?: { steps?: readonly string[] };
		};
		const steps = Array.isArray(module.default?.steps) ? module.default.steps : [];
		const drivesFlow = steps.length > 0;
		const throws = steps.some(stepThrows);
		const pinned = UNGUARDED_FIXTURES.get(name);
		if (drivesFlow && !throws) {
			if (pinned === undefined) {
				findings.push(`${name} drives a flow through steps with no throwing assertion on its own subject`);
			} else if (pinned !== stepsDigest(steps)) {
				findings.push(
					`${name}'s steps changed since they were grandfathered; add a throwing assertion on its subject ` +
						"and remove its UNGUARDED_FIXTURE_PINS entry"
				);
			}
		}
		if (pinned !== undefined && (!drivesFlow || throws)) {
			findings.push(`${name} no longer needs its UNGUARDED_FIXTURE_PINS entry; the list only shrinks - remove it`);
		}
	}
	for (const name of UNGUARDED_FIXTURES.keys()) {
		if (!existsSync(path.join(FIXTURE_DIR, name))) {
			findings.push(`${name} is in UNGUARDED_FIXTURE_PINS but no longer exists; remove the entry`);
		}
	}
	return findings;
}

/** Two frames after a scroll re-pin, so every measurement reads a settled, identically-scrolled page. */
const SETTLE_JS = `window.scrollTo(0, 0);
		await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));`;

/** The in-page rect reader both probes share; throws the SETUP marker so a vanished selector reads as "never ran". */
function grabJs(): string {
	return `const grab = (selector) => {
			const node = document.querySelector(selector);
			if (node === null) { throw new Error(${marker("SETUP", ": no element matches ")} + selector); }
			const rect = node.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0) {
				throw new Error(${marker("SETUP", ": nothing is painted for ")} + selector);
			}
			return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
		};`;
}

function measureStep(pair: StatePair): string {
	return `(async () => {
		${SETTLE_JS}
		if (!(${pair.restVerify})) {
			throw new Error(${marker("SETUP", `: the baseline is already in the toggled state (${pair.restVerify})`)});
		}
		${grabJs()}
		const baseline = { rects: ${JSON.stringify(pair.targets)}.map(grab), siblingTop: null };
		const siblingOf = ${JSON.stringify(pair.siblingOf ?? null)};
		if (siblingOf !== null) {
			const anchor = document.querySelector(siblingOf);
			if (anchor === null || anchor.nextElementSibling === null) {
				throw new Error(${marker("SETUP", ": no next sibling to hold under ")} + siblingOf);
			}
			baseline.siblingTop = anchor.nextElementSibling.getBoundingClientRect().top;
		}
		window.__geometryBaseline = baseline;
	})()`;
}

function compareStep(pair: StatePair): string {
	const siblingCheck =
		pair.siblingOf === undefined
			? ""
			: `const anchor = document.querySelector(${JSON.stringify(pair.siblingOf)});
		if (anchor === null || anchor.nextElementSibling === null) {
			throw new Error(${marker("SETUP", ": no next sibling to hold under ")} + ${JSON.stringify(pair.siblingOf)});
		}
		hold("next sibling of " + ${JSON.stringify(pair.siblingOf)}, "y", [],
			window.__geometryBaseline.siblingTop, anchor.nextElementSibling.getBoundingClientRect().top);`;
	// With an expectedDrift marker the probe decides between "the named drifts
	// still stand within their bound" (XDRIFT, green), "a drift outside the
	// list or past the bound" (DRIFT, which a known defect must not hide), and
	// "no drift at all" (STALE).
	const verdict =
		pair.expectedDrift === undefined
			? `if (drifts.length > 0) {
			throw new Error(${marker("DRIFT", ` ${pair.name}:`)} + "\\n  " + drifts.map((drift) => drift.line).join("\\n  "));
		}`
			: `const where = ${JSON.stringify(pair.expectedDrift.where)};
		const maxAbsPx = ${pair.expectedDrift.maxAbsPx};
		const unexpected = drifts.filter(
			(drift) => !where.some((prefix) => drift.key.startsWith(prefix)) || Math.abs(drift.delta) > maxAbsPx
		);
		if (unexpected.length > 0) {
			throw new Error(
				${marker("DRIFT", ` ${pair.name} (outside its expectedDrift list or past its ${pair.expectedDrift.maxAbsPx}px bound):`)} +
				"\\n  " + unexpected.map((drift) => drift.line).join("\\n  ")
			);
		}
		// Dead prefixes fail too: a partially fixed defect must shrink the
		// where-list with the fix, or the list quietly stops describing main.
		const dead = where.filter((prefix) => !drifts.some((drift) => drift.key.startsWith(prefix)));
		if (dead.length > 0) {
			throw new Error(
				${marker("STALE", ` ${pair.name}: expected drift no longer occurs at `)} + dead.join(", ") +
				"; shrink or remove the expectedDrift marker"
			);
		}
		throw new Error(
			${marker("XDRIFT", ` ${pair.name} (expected on today's main):`)} + "\\n  " +
			drifts.map((drift) => drift.line).join("\\n  ")
		);`;
	return `(async () => {
		${SETTLE_JS}
		if (!(${pair.verify})) {
			throw new Error(${marker("SETUP", `: the toggle never induced the state (${pair.verify})`)});
		}
		${grabJs()}
		const baseline = window.__geometryBaseline;
		const intended = ${JSON.stringify(intendedByTarget(pair))};
		const targets = ${JSON.stringify(pair.targets)};
		const drifts = [];
		const hold = (what, dim, exempt, was, now) => {
			const delta = now - was;
			if (!exempt.includes(dim) && Math.abs(delta) > ${TOLERANCE_PX}) {
				drifts.push({
					key: what + " " + dim,
					delta,
					line:
						what + " " + dim + " " + was.toFixed(2) + "px -> " + now.toFixed(2) +
						"px (moved " + delta.toFixed(2) + "px)",
				});
			}
		};
		targets.forEach((target, index) => {
			const now = grab(target);
			for (const dim of ["x", "y", "width", "height"]) {
				hold(target, dim, intended[index], baseline.rects[index][dim], now[dim]);
			}
		});
		${siblingCheck}
		${verdict}
	})()`;
}

/** The intended-dimension exemptions as an array parallel to targets; a key naming no target is a registry typo. */
function intendedByTarget(pair: StatePair): readonly (readonly Dim[])[] {
	for (const key of Object.keys(pair.intended ?? {})) {
		if (!pair.targets.includes(key)) {
			throw new Error(`${pair.name}: intended names "${key}", which is not one of its targets`);
		}
	}
	return pair.targets.map((target) => pair.intended?.[target] ?? []);
}

/**
 * The font-metric divergence probe, run in the toggled state after the pair
 * held: re-measures each named slot with the divergent faces swapped in
 * through ALL FOUR font tokens - the host pair and Tailwind's --font-sans/
 * --font-mono, so a slot rendering through a font-mono utility diverges too -
 * and fails when a height moves. The harness has already proven both face
 * sets loaded with their declared metrics, so a height that holds here holds
 * under ANY platform's fonts.
 */
function metricProbeStep(pair: StatePair, selectors: readonly string[]): string {
	return `(async () => {
		${SETTLE_JS}
		${grabJs()}
		const root = document.documentElement;
		const rest = {
			sans: root.style.getPropertyValue("--vscode-font-family"),
			mono: root.style.getPropertyValue("--vscode-editor-font-family"),
			utilitySans: root.style.getPropertyValue("--font-sans"),
			utilityMono: root.style.getPropertyValue("--font-mono"),
		};
		if (
			!rest.sans.includes("geometry-pinned-sans") || !rest.mono.includes("geometry-pinned-mono") ||
			!rest.utilitySans.includes("geometry-pinned-sans") || !rest.utilityMono.includes("geometry-pinned-mono")
		) {
			throw new Error(${marker("SETUP", ": the harness did not pin the fonts, so the divergence probe has nothing to toggle")});
		}
		const selectors = ${JSON.stringify(selectors)};
		const under = async (sans, mono) => {
			root.style.setProperty("--vscode-font-family", sans);
			root.style.setProperty("--vscode-editor-font-family", mono);
			root.style.setProperty("--font-sans", sans);
			root.style.setProperty("--font-mono", mono);
			await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
			return selectors.map((selector) => grab(selector).height);
		};
		const pinned = await under(rest.sans, rest.mono);
		const mixed = await under(rest.sans, "geometry-divergent-mono");
		const swapped = await under("geometry-divergent-sans", "geometry-divergent-mono");
		await under(rest.sans, rest.mono);
		const moved = [];
		selectors.forEach((selector, index) => {
			for (const [label, heights] of [["a divergent mono face", mixed], ["divergent faces throughout", swapped]]) {
				if (Math.abs(heights[index] - pinned[index]) > ${TOLERANCE_PX}) {
					moved.push(
						selector + " height " + pinned[index].toFixed(2) + "px -> " + heights[index].toFixed(2) +
						"px under " + label
					);
				}
			}
		});
		if (moved.length > 0) {
			throw new Error(${marker("DRIFT", ` ${pair.name} (height depends on font metrics):`)} + "\\n  " + moved.join("\\n  "));
		}
	})()`;
}

function widthStep(surface: WidthSurface): string {
	const within = surface.within ?? 1;
	return `(async () => {
		${SETTLE_JS}
		// The steps run before the harness's own asserted setWidth, on whatever
		// viewport --window-size produced, and a platform minimum can hand back
		// something narrower. At a shrunken width every surface fills whatever
		// pane is left and the extreme goes untested, so it fails as never-ran.
		if (document.documentElement.clientWidth < ${WIDE_VIEWPORT_PX}) {
			throw new Error(
				${marker("SETUP", `: the viewport is `)} + document.documentElement.clientWidth +
				"px, not the ${WIDE_VIEWPORT_PX}px this surface must be measured at"
			);
		}
		const pane = document.querySelector(".pane");
		if (pane === null) { throw new Error(${marker("SETUP", ": no .pane on the page")}); }
		const style = getComputedStyle(pane);
		const paneRect = pane.getBoundingClientRect();
		const contentRight = paneRect.right - parseFloat(style.paddingRight) - (parseFloat(style.borderRightWidth) || 0);
		const node = document.querySelector(${JSON.stringify(surface.selector)});
		if (node === null) {
			throw new Error(${marker("SETUP", ": no element matches ")} + ${JSON.stringify(surface.selector)});
		}
		const actualRight = node.getBoundingClientRect().right;
		if (Math.abs(actualRight - contentRight) > ${within}) {
			throw new Error(
				${marker("WIDTH", ` ${surface.name}: `)} + ${JSON.stringify(surface.selector)} + " right edge at " +
				actualRight.toFixed(2) + "px, the pane's content edge at " + contentRight.toFixed(2) + "px (off by " +
				(actualRight - contentRight).toFixed(2) + "px at ${WIDE_VIEWPORT_PX}px)"
			);
		}
	})()`;
}

interface SweepCase {
	readonly name: string;
	readonly fixture: string;
	readonly steps: readonly string[];
	/** A viewport width forced onto the fixture; pairs without one keep the fixture's own. */
	readonly viewportWidth?: number;
	/** Whether the case carries an expectedDrift marker (its probe then never exits green). */
	readonly expectsDrift: boolean;
}

function pairCase(pair: StatePair): SweepCase {
	return {
		name: pair.name,
		fixture: pair.fixture,
		steps: [
			...(pair.paneWidth === undefined ? [] : [paneWidthStep(pair.paneWidth)]),
			...(pair.setup ?? []),
			measureStep(pair),
			...pair.toggle,
			compareStep(pair),
			...(pair.metricProbe === undefined ? [] : [metricProbeStep(pair, pair.metricProbe)]),
		],
		...(pair.viewportWidth === undefined ? {} : { viewportWidth: pair.viewportWidth }),
		expectsDrift: pair.expectedDrift !== undefined,
	};
}

function widthCase(surface: WidthSurface): SweepCase {
	return {
		name: surface.name,
		fixture: surface.fixture,
		steps: [widthStep(surface)],
		viewportWidth: WIDE_VIEWPORT_PX,
		expectsDrift: false,
	};
}

/**
 * The generated fixture: the real one plus this case's steps, so the harness
 * runs the probes exactly as it runs any fixture's own steps. Generated under
 * tmp and imported by absolute path, so the base fixture's relative imports
 * still resolve at its real location.
 */
async function writeCaseFixture(dir: string, sweep: SweepCase, index: number): Promise<string> {
	const basePath = path.join(FIXTURE_DIR, sweep.fixture);
	await fs.access(basePath);
	const viewport =
		sweep.viewportWidth === undefined
			? ""
			: `\tviewport: { width: ${sweep.viewportWidth}, height: base.viewport?.height ?? 950 },\n`;
	const source =
		`import base from ${JSON.stringify(basePath)};\n` +
		`export default {\n\t...base,\n${viewport}` +
		`\tsteps: [...(base.steps ?? []), ...${JSON.stringify(sweep.steps)}],\n};\n`;
	const file = path.join(dir, `${String(index).padStart(2, "0")}-${sweep.name}.ts`);
	await fs.writeFile(file, source);
	return file;
}

type Outcome = "held" | "drifted" | "expected-drift" | "stale-expectation" | "never-ran";

interface Result {
	readonly name: string;
	readonly outcome: Outcome;
	readonly output: string;
}

/**
 * One case through the harness. --widths "" puts it in measurement-only mode
 * (no PNG) while the steps and the own-width overflow assertion still run; a
 * probe's throw surfaces as exit 1 with its runtime-assembled marker in the
 * output, which is the whole wire protocol between the two scripts.
 */
async function run(sweep: SweepCase, fixtureFile: string): Promise<Result> {
	const child = spawn(process.execPath, [HARNESS, "--fixture", fixtureFile, "--widths", ""], {
		cwd: REPO_ROOT,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	const code = await new Promise<number>((resolve) => child.on("close", (status) => resolve(status ?? 1)));
	let outcome: Outcome;
	if (code === 0) {
		// A green exit under an expectedDrift marker cannot happen through the
		// probe (it always throws one of its three verdicts), so reaching it means
		// the compare step never ran: a stale entry, not a pass.
		outcome = sweep.expectsDrift ? "stale-expectation" : "held";
	} else if (output.includes("GEOMETRY-XDRIFT")) {
		outcome = "expected-drift";
	} else if (output.includes("GEOMETRY-STALE")) {
		outcome = "stale-expectation";
	} else if (output.includes("GEOMETRY-DRIFT") || output.includes("GEOMETRY-WIDTH")) {
		outcome = "drifted";
	} else {
		outcome = "never-ran";
	}
	return { name: sweep.name, outcome, output };
}

async function main(): Promise<void> {
	const { values } = parseArgs({ options: { only: { type: "string" }, jobs: { type: "string" } } });
	const jobs = values.jobs === undefined ? 4 : Number(values.jobs);
	if (!Number.isInteger(jobs) || jobs < 1) {
		throw new Error(`--jobs takes a positive integer; got ${values.jobs}`);
	}
	const cases = [...STATE_PAIRS.map(pairCase), ...WIDTH_SURFACES.map(widthCase)].filter(
		(sweep) => values.only === undefined || sweep.name.includes(values.only)
	);
	if (cases.length === 0) {
		throw new Error(`No pairs matched ${values.only ?? "(everything)"}`);
	}
	// Always swept, --only or not: the guard leg is static and instant, and a
	// filtered run that silently skipped it would be a green nobody earned.
	const unguarded = await fixtureGuardFindings();
	for (const finding of unguarded) {
		console.log(`GUARD ${finding}`);
	}
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "check-geometry-"));
	try {
		const results: Result[] = [];
		// A case whose base fixture is gone never ran: the renamed-fixture failure
		// belongs to exit 2's vocabulary, not to a runner crash that would take
		// the rest of the sweep with it.
		const queue: { sweep: SweepCase; file: string }[] = [];
		for (const [index, sweep] of cases.entries()) {
			try {
				queue.push({ sweep, file: await writeCaseFixture(tmpDir, sweep, index) });
			} catch (error) {
				results.push({
					name: sweep.name,
					outcome: "never-ran",
					output: error instanceof Error ? error.message : String(error),
				});
			}
		}
		console.log(
			`sweeping ${cases.length} case(s): ${STATE_PAIRS.length} state pair(s), ${WIDTH_SURFACES.length} width surface(s) registered`
		);
		// The same pool and stagger as check-overflow.ts, for the same reason:
		// each run launches its own Chrome, and cold-starting them all at once
		// starves the harness's DevTools deadline on a busy runner.
		await Promise.all(
			Array.from({ length: Math.min(jobs, queue.length) }, async (_, worker) => {
				await delay(worker * 400);
				for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
					const result = await run(next.sweep, next.file);
					results.push(result);
					const tag = {
						held: "ok  ",
						drifted: "FAIL",
						"expected-drift": "xfail",
						"stale-expectation": "STALE",
						"never-ran": "FAIL",
					}[result.outcome];
					console.log(`${tag} ${result.name}`);
				}
			})
		);
		const failed = results
			.filter(
				(result) =>
					result.outcome === "drifted" || result.outcome === "never-ran" || result.outcome === "stale-expectation"
			)
			.sort((a, b) => a.name.localeCompare(b.name));
		for (const result of failed) {
			console.log(`\n--- ${result.name} ---\n${result.output.trim()}`);
		}
		const drifted = results.filter((result) => result.outcome === "drifted");
		const expected = results.filter((result) => result.outcome === "expected-drift");
		const stale = results.filter((result) => result.outcome === "stale-expectation");
		const unrunnable = results.filter((result) => result.outcome === "never-ran");
		const held = results.filter((result) => result.outcome === "held");
		console.log(`\n${held.length}/${results.length} cases held their geometry`);
		if (expected.length > 0) {
			console.log(
				`${expected.length} drifted as expected (known defects): ${expected.map((result) => result.name).join(", ")}`
			);
		}
		if (drifted.length > 0) {
			console.log(`${drifted.length} moved: ${drifted.map((result) => result.name).join(", ")}`);
		}
		if (stale.length > 0) {
			console.log(
				`${stale.length} stale expectedDrift marker(s) - the defect is fixed, remove the marker: ` +
					stale.map((result) => result.name).join(", ")
			);
		}
		if (unrunnable.length > 0) {
			console.log(`${unrunnable.length} never ran: ${unrunnable.map((result) => result.name).join(", ")}`);
		}
		if (unguarded.length > 0) {
			console.log(`${unguarded.length} fixture guard finding(s), listed above the sweep`);
		}
		if (drifted.length > 0 || unguarded.length > 0) {
			process.exitCode = 1;
		} else if (unrunnable.length > 0 || stale.length > 0) {
			process.exitCode = 2;
		}
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
