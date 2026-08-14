/**
 * The Settings tab just above the measure boundary: a pane still wide enough
 * for three columns, and barely.
 *
 * The page's measure sits deliberately under the 910px stack threshold
 * (narrowThresholds' settings-measure test enforces the relation), so a pane
 * wide enough for three columns is always wide enough for the whole measure -
 * there is no middle band where the explanation column starves beside its
 * glyph. This shot is the proof near that edge: the full grid, every
 * description at its cap with its glyph past it, and the leftover margin
 * beyond the page's one right edge. settings-stacked.ts photographs the other
 * side of the same threshold.
 *
 * 1190px of window is 925px of pane - the window less the uncollapsed rail
 * (216px plus its border) and the pane's own 24px of padding on each side.
 * Not the narrowest three-column pane, which is the threshold itself: the
 * 15px of clearance is what stops the shot flipping tiers over a pixel of
 * chrome, and a fixture that photographs the wrong tier proves nothing while
 * looking like proof. The PANE decides, not the window: a viewport media
 * query would have asked the wrong question. It is also why this cannot be a
 * component test - happy-dom has no layout, so a container query there is
 * just a class name.
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
