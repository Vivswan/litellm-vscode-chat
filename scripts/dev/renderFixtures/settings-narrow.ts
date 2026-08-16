/**
 * The Settings tab just above the measure boundary: a pane still wide enough
 * for three columns, and barely. The page's measure sits under the 910px stack
 * threshold, so a pane wide enough for three columns is always wide enough for
 * the whole measure and no middle band starves the explanation column.
 *
 * 1190px of window is 925px of pane (the window less the uncollapsed rail and
 * its border, less the pane's own 24px of padding a side). Not the narrowest
 * three-column pane: the 15px of clearance is what stops the shot flipping
 * tiers over a pixel of chrome. The PANE decides, not the window, which is also
 * why this cannot be a component test - happy-dom has no layout, so a container
 * query there is just a class name. settings-stacked.ts is the other side.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [
		{ kind: "push", state: baseState() },
		{ kind: "focusSection", section: "settings" },
	],
	viewport: { width: 1190, height: 2400 },
};

export default fixture;
