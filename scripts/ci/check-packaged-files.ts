/**
 * The packaged-file-list gate of format-check-reusable.yml, run after `bun run compile` and `bun run bundle`: lists
 * what vsce would package and judges the listing, the bundle sizes, the lazy tokenizer edges, the content markers,
 * and the OpenRouter catalog (packagedFiles.ts holds each rule). Every problem, a missing artifact or an unparseable
 * catalog included, is reported before exit 1.
 *
 *   CATALOG_PRESENT=true  -> dist/openrouter-models.json must be listed and must parse to a real model set
 *   anything else          -> the producer reported catalog=skipped; its assertions do not run
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { CATALOG_MODEL_COUNT_FLOOR } from "../../src/shared/config/openRouterCatalog";
import {
	catalogProblems,
	dashboardMarkerProblems,
	lazyEdgeProblems,
	listingProblems,
	REQUIRED_PACKAGED_FILES,
	SIZE_BOUNDS,
	sizeProblem,
	stylesheetMarkerProblems,
} from "./packagedFiles";

// out/ is on disk from the compile; logs/ and coverage/ are seeded here because nothing in CI writes them, so without
// the seeding their .vscodeignore exclusion would never be exercised.
mkdirSync("logs", { recursive: true });
mkdirSync("coverage", { recursive: true });
writeFileSync("logs/ci-proof.log", "");
writeFileSync("coverage/ci-proof.json", "");

const vsce = spawnSync("bunx", ["vsce", "ls"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
if (vsce.status !== 0) {
	throw new Error(`bunx vsce ls exited ${vsce.status}`);
}
const listing = vsce.stdout.split("\n").filter((line) => line !== "");
console.log(listing.join("\n"));

const problems: string[] = [];

/** The artifact's text, or null with the absence recorded, so one missing file does not hide the other findings. */
function artifact(file: string): string | null {
	const stat = statSync(file, { throwIfNoEntry: false });
	if (stat === undefined) {
		problems.push(`${file} was not emitted`);
		return null;
	}
	return readFileSync(file, "utf8");
}

const catalogPresent = process.env.CATALOG_PRESENT === "true";
const chunks = (statSync("dist/chunks", { throwIfNoEntry: false }) === undefined ? [] : readdirSync("dist/chunks"))
	.filter((name) => name.endsWith(".js"))
	.map((name) => `dist/chunks/${name}`);
const required = [...REQUIRED_PACKAGED_FILES, ...chunks, ...(catalogPresent ? ["dist/openrouter-models.json"] : [])];
problems.push(...listingProblems(listing, required));

for (const bound of SIZE_BOUNDS) {
	const size = statSync(bound.file, { throwIfNoEntry: false })?.size;
	if (size === undefined) {
		problems.push(`${bound.file} was not emitted`);
		continue;
	}
	console.log(`${bound.file}: ${size} bytes`);
	const problem = sizeProblem(bound, size);
	if (problem !== null) {
		problems.push(problem);
	}
}

const entry = artifact("dist/extension.js");
if (entry !== null) {
	problems.push(...lazyEdgeProblems(entry));
}
const dashboardScript = artifact("dist/webview/dashboard.js");
if (dashboardScript !== null) {
	problems.push(...dashboardMarkerProblems(dashboardScript));
}
const stylesheet = artifact("dist/webview/dashboard.css");
if (stylesheet !== null) {
	problems.push(...stylesheetMarkerProblems(stylesheet));
}

if (catalogPresent) {
	const catalog = artifact("dist/openrouter-models.json");
	if (catalog !== null) {
		try {
			problems.push(...catalogProblems(JSON.parse(catalog), CATALOG_MODEL_COUNT_FLOOR));
		} catch (error) {
			problems.push(`dist/openrouter-models.json is not JSON: ${error instanceof Error ? error.message : error}`);
		}
	}
} else {
	console.log(
		"dist/openrouter-models.json absent because the producer reported catalog=skipped; its assertions did not run"
	);
}

for (const problem of problems) {
	console.log(`::error::${problem}`);
}
if (problems.length > 0) {
	process.exit(1);
}
console.log(`Packaged file list is clean (${listing.length} files)`);
