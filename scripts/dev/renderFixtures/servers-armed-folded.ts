/**
 * The armed remove state at the FOLDED tier: the same no-shift contract as
 * servers-armed.ts, measured where it is cheapest to break. Below the 920 fold
 * the actions live in the list's flexible track, whose 9em floor covers only
 * the RESTING pair - the armed pair leaves the flow and covers the row
 * (.server-actions.armed), so it can never raise the track's minimum. 500px
 * of window (a ~400px pane, the collapsed rail beside it) presses the
 * flexible track down to that floor, which is exactly where the old
 * minmax(min-content, 1fr) template failed. At this tier the failure mode is
 * OVERFLOW rather than a leftward shift (an out-of-flow cover wider than the
 * row pokes past the pane's left edge instead of dragging siblings), and the
 * harness's own no-sideways-scroll assertion on every render is the sensor
 * for that; the shared shift measurement still runs as a second net.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { ARM_AND_ASSERT_NO_SHIFT } from "./servers-armed.ts";
import serversSpend from "./servers-spend.ts";

const fixture: RenderFixture = {
	...serversSpend,
	steps: [
		// The tier assertion first: a wider-than-asked window (a platform
		// minimum, a harness change) would otherwise measure the wide tier
		// while claiming the fold.
		`(() => {
			const meta = document.querySelector(".server-meta");
			if (!meta || getComputedStyle(meta).display !== "flex") {
				throw new Error("the rows did not fold: this fixture would measure the wrong tier");
			}
		})()`,
		...ARM_AND_ASSERT_NO_SHIFT,
	],
	viewport: { width: 500, height: 1600 },
};

export default fixture;
