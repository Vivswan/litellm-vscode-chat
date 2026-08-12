/**
 * Pixel-baseline gate over the dashboard render fixtures: renders every
 * fixture in scripts/dev/renderFixtures/ through the render-dashboard.ts
 * harness and compares the PNG against the committed baseline with
 * pixelmatch.
 *
 * Baselines live in scripts/dev/renderFixtures/baselines/ and are rendered on
 * Linux (CI's runner): font rasterization is OS-specific, so a macOS or
 * Windows render never matches them byte for byte. Linux contributors
 * regenerate with `bun run render:update`; everyone else commits the
 * render-current artifact from the CI run (the render-check job uploads it on
 * every run).
 *
 * Bootstrap is an explicit flag, never inferred: the CI job passes
 * --bootstrap while the repository has no committed baselines yet, which
 * turns missing baselines into a loud warning instead of a failure so the
 * render-current artifact can seed scripts/dev/renderFixtures/baselines/;
 * the commit that lands the baselines also removes the flag from the
 * workflow, and the flag self-terminates: once any baseline is committed,
 * running with --bootstrap is an error. Without the flag, EVERY fixture
 * missing its baseline fails hard - a new fixture must land its baseline in
 * the same change, and deleting baselines cannot silently disable the gate.
 * Mismatches always fail hard, with the diff image written under
 * renders/diff/.
 *
 * Tolerance: pixelmatch threshold 0.1 (its own default, sized for
 * anti-aliasing jitter) and at most 25 differing pixels per fixture. The
 * harness freezes the page clock, animations, and the caret, so same-machine
 * renders come out byte-identical - the one variation observed in
 * calibration (a translucent settings gutter indicator, once, differing by
 * rounding in 6 raw pixels) stayed below pixelmatch's detection floor even
 * at threshold 0. The allowance exists for sub-pixel drift across Chrome or
 * runner image updates small enough not to matter visually.
 *
 * Usage: bun scripts/ci/render-check.mts [--update] [--bootstrap] [--only <name,...>] [--jobs N]
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const HARNESS = path.join(REPO_ROOT, "scripts", "dev", "render-dashboard.ts");
const FIXTURES_DIR = path.join(REPO_ROOT, "scripts", "dev", "renderFixtures");
const BASELINE_DIR = path.join(FIXTURES_DIR, "baselines");
const CURRENT_DIR = path.join(REPO_ROOT, "renders", "current");
const DIFF_DIR = path.join(REPO_ROOT, "renders", "diff");

const PIXELMATCH_THRESHOLD = 0.1;
const MAX_DIFF_PIXELS = 25;

/**
 * Hard per-render bound: a wedged Chrome (the harness awaits its DevTools
 * socket with no deadline of its own past connect) must fail this fixture,
 * not stall the pool into the job timeout - a cancelled job uploads no
 * artifacts, and during bootstrap the artifact is the whole point.
 */
const RENDER_TIMEOUT_MS = 120_000;

type Outcome =
	| { readonly kind: "pass"; readonly diffPixels: number }
	| { readonly kind: "updated" }
	| { readonly kind: "missing-baseline" }
	| { readonly kind: "mismatch"; readonly diffPixels: number }
	| { readonly kind: "size-mismatch"; readonly baseline: string; readonly current: string }
	| { readonly kind: "render-failed"; readonly log: string };

interface Result {
	readonly name: string;
	readonly outcome: Outcome;
}

async function listFixtures(only: readonly string[] | undefined): Promise<readonly string[]> {
	const names = (await fs.readdir(FIXTURES_DIR))
		.filter((file) => file.endsWith(".ts") && file !== "shared.ts")
		.map((file) => file.slice(0, -".ts".length))
		.sort();
	if (only === undefined) {
		return names;
	}
	const unknown = only.filter((name) => !names.includes(name));
	if (unknown.length > 0) {
		throw new Error(`Unknown fixtures: ${unknown.join(", ")} (known: ${names.join(", ")})`);
	}
	return [...new Set(only)];
}

/**
 * Build the webview bundle unconditionally, up front: a stale dist/webview
 * would render (and baseline) yesterday's dashboard, and parallel harness
 * processes would race an on-demand build.
 */
function buildBundle(): void {
	const build = spawnSync("bun", ["run", "bundle:dev"], { cwd: REPO_ROOT, stdio: "inherit" });
	if (build.status !== 0) {
		throw new Error("bun run bundle:dev failed");
	}
}

function render(name: string, outPath: string): Promise<{ readonly ok: boolean; readonly log: string }> {
	return new Promise((resolve) => {
		const fixture = path.join(FIXTURES_DIR, `${name}.ts`);
		// detached puts the harness and the Chrome it spawns in their own
		// process group, so the timeout kill below reaps both - killing only
		// the harness would bypass its cleanup and leak a headless Chrome per
		// timed-out attempt.
		const child = spawn("bun", [HARNESS, "--fixture", fixture, "--out", outPath], {
			cwd: REPO_ROOT,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		let log = "";
		child.stdout.on("data", (chunk: Buffer) => {
			log += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			log += chunk.toString();
		});
		const deadline = setTimeout(() => {
			log += `render timed out after ${RENDER_TIMEOUT_MS}ms; killing the harness\n`;
			if (child.pid !== undefined) {
				try {
					process.kill(-child.pid, "SIGKILL");
					return;
				} catch {
					// Group already gone; fall through to the direct kill.
				}
			}
			child.kill("SIGKILL");
		}, RENDER_TIMEOUT_MS);
		child.on("close", (code) => {
			clearTimeout(deadline);
			resolve({ ok: code === 0, log });
		});
	});
}

async function compare(name: string, currentPath: string): Promise<Outcome> {
	const baselinePath = path.join(BASELINE_DIR, `${name}.png`);
	if (!existsSync(baselinePath)) {
		return { kind: "missing-baseline" };
	}
	const baseline = PNG.sync.read(await fs.readFile(baselinePath));
	const current = PNG.sync.read(await fs.readFile(currentPath));
	if (baseline.width !== current.width || baseline.height !== current.height) {
		return {
			kind: "size-mismatch",
			baseline: `${baseline.width}x${baseline.height}`,
			current: `${current.width}x${current.height}`,
		};
	}
	const diff = new PNG({ width: baseline.width, height: baseline.height });
	const diffPixels = pixelmatch(baseline.data, current.data, diff.data, baseline.width, baseline.height, {
		threshold: PIXELMATCH_THRESHOLD,
	});
	if (diffPixels <= MAX_DIFF_PIXELS) {
		return { kind: "pass", diffPixels };
	}
	await fs.mkdir(DIFF_DIR, { recursive: true });
	await fs.writeFile(path.join(DIFF_DIR, `${name}.png`), PNG.sync.write(diff));
	return { kind: "mismatch", diffPixels };
}

async function checkFixture(name: string, update: boolean): Promise<Result> {
	// Renders always land in CURRENT_DIR; update mode copies the validated
	// PNG over the baseline afterwards, so a failed render can never leave a
	// truncated file where a good baseline used to be.
	const outPath = path.join(CURRENT_DIR, `${name}.png`);
	// One relaunch absorbs Chrome startup flake under concurrency (a busy
	// machine can miss the DevTools port deadline); a deterministic render
	// failure fails both attempts.
	let rendered = await render(name, outPath);
	if (!rendered.ok) {
		rendered = await render(name, outPath);
	}
	if (!rendered.ok) {
		return { name, outcome: { kind: "render-failed", log: rendered.log } };
	}
	if (update) {
		await fs.copyFile(outPath, path.join(BASELINE_DIR, `${name}.png`));
		return { name, outcome: { kind: "updated" } };
	}
	return { name, outcome: await compare(name, outPath) };
}

/** A small worker pool: each render runs its own Chrome, so cap concurrency. */
async function runAll(names: readonly string[], update: boolean, jobs: number): Promise<readonly Result[]> {
	const results: Result[] = [];
	const queue = [...names];
	async function worker(): Promise<void> {
		for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
			const result = await checkFixture(name, update);
			results.push(result);
			console.log(`${result.outcome.kind === "render-failed" ? "FAIL" : result.outcome.kind}: ${name}`);
		}
	}
	await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, names.length)) }, worker));
	return results.toSorted((a, b) => a.name.localeCompare(b.name));
}

function report(results: readonly Result[], bootstrap: boolean): number {
	const missing = results.filter((result) => result.outcome.kind === "missing-baseline");
	const failed = results.filter(
		(result) =>
			result.outcome.kind === "mismatch" ||
			result.outcome.kind === "size-mismatch" ||
			result.outcome.kind === "render-failed"
	);
	for (const { name, outcome } of results) {
		// A fixture living near the allowance must be visible before it tips
		// over, not indistinguishable from a byte-identical one.
		if (outcome.kind === "pass" && outcome.diffPixels > 0) {
			console.log(
				`note ${name}: ${outcome.diffPixels} differing pixels, within the ${MAX_DIFF_PIXELS}-pixel allowance`
			);
		}
	}
	for (const { name, outcome } of failed) {
		if (outcome.kind === "mismatch") {
			console.error(
				`FAIL ${name}: ${outcome.diffPixels} differing pixels (allowed ${MAX_DIFF_PIXELS});` +
					` diff: renders/diff/${name}.png`
			);
		} else if (outcome.kind === "size-mismatch") {
			console.error(`FAIL ${name}: size changed ${outcome.baseline} -> ${outcome.current}`);
		} else if (outcome.kind === "render-failed") {
			console.error(`FAIL ${name}: render failed\n${outcome.log}`);
		}
	}
	let missingFailures = 0;
	if (missing.length > 0 && bootstrap) {
		console.log(
			`::warning::${missing.length} fixture(s) without a baseline soft-passed under --bootstrap: commit the` +
				" render-current artifact's PNGs from this run to scripts/dev/renderFixtures/baselines/ and drop the" +
				" flag from the workflow."
		);
	} else if (missing.length > 0) {
		missingFailures = missing.length;
		for (const { name } of missing) {
			console.error(
				`FAIL ${name}: no baseline. Render on Linux (bun run render:update --only ${name}) or commit the` +
					" render-current artifact's PNG from this fixture's CI run."
			);
		}
	}
	const passed = results.length - failed.length - missing.length;
	console.log(`${passed} matched, ${missing.length} missing baseline, ${failed.length} failed`);
	return failed.length + missingFailures > 0 ? 1 : 0;
}

/**
 * Baseline PNGs whose fixture no longer exists: deleted by render:update,
 * a hard failure in check mode (a deleted fixture must take its baseline
 * with it).
 */
async function orphanBaselines(names: readonly string[]): Promise<readonly string[]> {
	if (!existsSync(BASELINE_DIR)) {
		return [];
	}
	return (await fs.readdir(BASELINE_DIR))
		.filter((file) => file.endsWith(".png") && !names.includes(file.slice(0, -".png".length)))
		.sort();
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			update: { type: "boolean", default: false },
			bootstrap: { type: "boolean", default: false },
			only: { type: "string" },
			jobs: { type: "string" },
		},
	});
	const jobs = values.jobs !== undefined ? Number(values.jobs) : Math.min(4, os.availableParallelism());
	if (!Number.isInteger(jobs) || jobs <= 0) {
		throw new Error(`--jobs must be a positive integer; got ${values.jobs}`);
	}
	const names = await listFixtures(values.only?.split(",").map((name) => name.trim()));
	if (names.length === 0) {
		// An empty run must never read as a green gate.
		throw new Error(`No fixtures found in ${FIXTURES_DIR}`);
	}
	const allNames = values.only === undefined ? names : await listFixtures(undefined);
	const orphans = await orphanBaselines(allNames);
	if (values.bootstrap && existsSync(BASELINE_DIR)) {
		// Self-terminating bootstrap: once any baseline is committed, a
		// lingering (or re-added) flag must fail instead of un-gating every
		// new fixture forever.
		const committed = (await fs.readdir(BASELINE_DIR)).some((file) => file.endsWith(".png"));
		if (committed) {
			throw new Error(
				"Bootstrap is over: baselines exist under scripts/dev/renderFixtures/baselines/; drop --bootstrap from checks.yml"
			);
		}
	}
	buildBundle();
	await fs.rm(CURRENT_DIR, { recursive: true, force: true });
	await fs.mkdir(CURRENT_DIR, { recursive: true });
	if (values.update) {
		await fs.mkdir(BASELINE_DIR, { recursive: true });
	}
	await fs.rm(DIFF_DIR, { recursive: true, force: true });

	const results = await runAll(names, values.update, jobs);
	if (values.update) {
		for (const orphan of orphans) {
			await fs.rm(path.join(BASELINE_DIR, orphan));
			console.log(`removed orphan baseline ${orphan}`);
		}
		console.log(`${results.length} baseline(s) written to scripts/dev/renderFixtures/baselines/`);
		const failed = results.filter((result) => result.outcome.kind === "render-failed");
		for (const { name, outcome } of failed) {
			if (outcome.kind === "render-failed") {
				console.error(`FAIL ${name}: render failed\n${outcome.log}`);
			}
		}
		process.exitCode = failed.length > 0 ? 1 : 0;
		return;
	}
	if (orphans.length > 0) {
		console.error(`FAIL: baselines without a fixture: ${orphans.join(", ")} (delete them or restore the fixture)`);
	}
	process.exitCode = report(results, values.bootstrap) || (orphans.length > 0 ? 1 : 0);
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
