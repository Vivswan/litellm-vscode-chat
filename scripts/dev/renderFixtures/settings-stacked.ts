/**
 * The Settings tab below the width where its three tracks stop being tracks.
 *
 * The row's template spends a fixed 10rem on the label and up to 20rem on the
 * control before the explanation column gets anything, so under about 870px of
 * PANE the third column is a few tens of pixels: a word per line, under a
 * right-aligned label that now lines up with nothing. This shot is the stacked
 * answer - title, control, explanation, each on its own line, in the order the
 * row is spoken.
 *
 * The pane rather than the window decides, which is the whole reason this shot
 * exists at 900px: the rail has already collapsed by here, so the window is 900
 * and the container query sees 803 - the window less the collapsed rail and the
 * pane's own 24px of padding on each side. A viewport media query would have
 * asked the wrong question, and counting the rail but not the padding would have
 * answered it 49px wrong. It is also why this cannot be a component test - happy-dom
 * has no layout, so a container query there is just a class name.
 *
 * Deliberately not the same width as settings-narrow.ts: that one photographs
 * the hint cell INSIDE a three-column row and needs a pane wide enough to still
 * have three columns, and this one photographs what replaces them.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [
		{ kind: "push", state: baseState() },
		{ kind: "focusSection", section: "settings" },
	],
	viewport: { width: 900, height: 2400 },
};

export default fixture;
