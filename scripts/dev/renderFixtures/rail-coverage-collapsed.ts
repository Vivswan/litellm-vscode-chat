/**
 * The rail-coverage claim below the rail's 1000px collapse: the icon rail swaps
 * the column's basis and inner geometry, so the expanded rail reaching both
 * bottoms says nothing about the collapsed one. Everything rides in from
 * rail-coverage.ts; only the window and the claimed rail state change.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import expanded, { coverageSteps } from "./rail-coverage.ts";

const fixture: RenderFixture = {
	...expanded,
	// The same tall window under the collapse, well clear of both the 1000px
	// threshold and the shell's 320px floor.
	viewport: { width: 700, height: 1500 },
	steps: coverageSteps("collapsed"),
};

export default fixture;
