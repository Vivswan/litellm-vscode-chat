/**
 * The armed remove state at the FOLDED tier: the same no-shift contract as
 * servers-armed.ts, measured where it is cheapest to break. Below the 920 fold
 * the actions live in the list's flexible track, whose 9em floor covers only the
 * RESTING pair - the armed pair leaves the flow and covers the row, so it can
 * never raise the track's minimum. 500px of window presses the flexible track
 * down to that floor, which is where the old minmax(min-content, 1fr) template
 * failed. The failure mode here is OVERFLOW rather than a leftward shift, so the
 * harness's no-sideways-scroll assertion is the sensor; the shared shift
 * measurement runs as a second net.
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
