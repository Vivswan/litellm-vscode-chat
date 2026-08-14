/**
 * The Servers page at 500px under OS forced colors, which is the only way to
 * reach the collapsed rail's own forced-colors block: that block is nested
 * inside `width < 1000px`, so it needs both halves at once, and every other
 * forced-colors fixture here renders at 1300px.
 *
 * What it should photograph: the selected rail item's edge bar and the
 * footer's verdict dot, redrawn in system colours - the collapsed rail's only
 * two marks, both of them backgrounds, which is the layer forced colours
 * discard - beside the folded rows' spend units, whose meter fills name
 * Highlight at the call site.
 *
 * The step asserts the tier it caught rather than trusting the width: a
 * wider-than-asked window (a platform minimum, a harness change) would
 * otherwise photograph the wide tier while claiming the fold.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import serversSpend from "./servers-spend.ts";

const fixture: RenderFixture = {
	...serversSpend,
	hostTheme: "forced-colors",
	steps: [
		`(() => {
			const meta = document.querySelector(".server-meta");
			if (!meta) {
				throw new Error("no server row rendered");
			}
			// The folded tier's own computed signature: display:contents at wide,
			// a flex line once the row folds at 920px of pane.
			if (getComputedStyle(meta).display !== "flex") {
				throw new Error("the rows did not fold: this shot would not show the tier it claims");
			}
			const rail = document.querySelector(".rail");
			if (!rail || rail.getBoundingClientRect().width > 60) {
				throw new Error("the rail did not collapse: this shot would not show the tier it claims");
			}
		})()`,
	],
	viewport: { width: 500, height: 1100 },
};

export default fixture;
