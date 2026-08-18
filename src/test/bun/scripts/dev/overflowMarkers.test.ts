import { describe, test } from "bun:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { OVERFLOW_SIDEWAYS_MARKER, OWN_WIDTH_ONLY_MARKER } from "../../../../../scripts/dev/overflowMarkers";
import { REPO_ROOT } from "../../../util/repoRoot";

/**
 * Pins the wire between the render harness and the overflow sweep: both sides
 * share the marker constants, the sweep classifies by markers alone, and
 * neither side hardcodes the words. Reworded prose then cannot flip the
 * documented exit contract (1 = overflow, 2 = never ran) or drop the
 * measuredAtOwnWidth opt-out count.
 */

const harness = fs.readFileSync(path.join(REPO_ROOT, "scripts/dev/render-dashboard.ts"), "utf8");
const sweep = fs.readFileSync(path.join(REPO_ROOT, "scripts/dev/check-overflow.ts"), "utf8");

describe("overflow sweep wire protocol", () => {
	test("the markers are distinct words, neither a substring of the other", () => {
		// includes() is the whole parser, so a marker containing the other would
		// classify both outcomes as one.
		assert.notStrictEqual(OVERFLOW_SIDEWAYS_MARKER, OWN_WIDTH_ONLY_MARKER);
		assert.ok(!OVERFLOW_SIDEWAYS_MARKER.includes(OWN_WIDTH_ONLY_MARKER));
		assert.ok(!OWN_WIDTH_ONLY_MARKER.includes(OVERFLOW_SIDEWAYS_MARKER));
	});

	test("the sweep classifies harness output by the shared markers alone, never by prose", () => {
		const greps = [...sweep.matchAll(/\.output\.includes\(([^)]*)\)/g)].map((match) => match[1]);
		assert.ok(greps.length >= 3, "the classifier greps the harness output");
		for (const grep of greps) {
			assert.ok(
				grep === "OVERFLOW_SIDEWAYS_MARKER" || grep === "OWN_WIDTH_ONLY_MARKER",
				`check-overflow classifies by ${grep}; only the shared marker constants may decide an outcome`
			);
		}
	});

	test("the harness emits both markers through the constants and hardcodes neither word", () => {
		assert.ok(harness.includes(`\${OVERFLOW_SIDEWAYS_MARKER}`), "the harness interpolates the sideways marker");
		assert.ok(harness.includes(`\${OWN_WIDTH_ONLY_MARKER}`), "the harness interpolates the own-width marker");
		assert.ok(!harness.includes(OVERFLOW_SIDEWAYS_MARKER), "the sideways word lives only in overflowMarkers.ts");
		assert.ok(!harness.includes(OWN_WIDTH_ONLY_MARKER), "the own-width word lives only in overflowMarkers.ts");
		assert.ok(!sweep.includes(OVERFLOW_SIDEWAYS_MARKER), "the parser matches the constant, not a copied word");
		assert.ok(!sweep.includes(OWN_WIDTH_ONLY_MARKER), "the parser matches the constant, not a copied word");
	});
});
