/**
 * The pinned OpenRouter catalog fixture (src/test/fixtures/openrouter-models.json).
 * tsc compiles no JSON, so the fixture stays in src/ and the suites running
 * from out/test walk back to it; this loader is the one place that knows the
 * walk.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const FIXTURE_PATH = path.resolve(__dirname, "..", "..", "src", "test", "fixtures", "openrouter-models.json");

/** The fixture's raw text, for suites that plant it as a bundled or cached artifact file. */
export function catalogFixtureText(): string {
	return fs.readFileSync(FIXTURE_PATH, "utf8");
}

/** The fixture's parsed JSON payload, for parseCatalogSnapshot and the seeding seam. */
export function catalogFixtureJson(): unknown {
	return JSON.parse(catalogFixtureText());
}
