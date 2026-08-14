/**
 * The Usage tab at 500px under OS forced colors, which is the only way to reach
 * the collapsed rail's own forced-colors block: that block is nested inside
 * `width < 1000px`, so it needs both halves at once, and every other
 * forced-colors fixture here renders at 1300px.
 *
 * What it should photograph: the selected rail item's edge bar and the footer's
 * verdict dot, redrawn in system colours - the collapsed rail's only two marks,
 * both of them backgrounds, which is the layer forced colours discard - beside
 * the narrow meter, which at this width is a rule under the row's facts
 * rather than a short bar at the end of the line.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import usageNarrow from "./usage-narrow.ts";

const fixture: RenderFixture = {
	...usageNarrow,
	hostTheme: "forced-colors",
};

export default fixture;
