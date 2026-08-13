/**
 * The Settings tab at the width where the explanation column runs out of room
 * for its help glyph but not for its words.
 *
 * The shot exists because that column's layout has already produced one
 * regression the full-width render could not show. A hint cell that reserves a
 * track for the glyph looks correct at 1300px and, here, holds that track at
 * full size while the prose starves beside it. The prose has to be the thing
 * that gives, and it has to give all the way to taking the line alone, so the
 * glyph wraps under it rather than into it - which is what this width
 * photographs: every row's description on its own line, every glyph beneath it,
 * and no row's answer depending on how long its sentence happens to be.
 *
 * The width moved from 1040 to 1220 when the row learned to stack. Below 910px
 * of PANE the three columns become one, and 1040px of window is 775px of pane
 * once the rail and the pane's own padding are taken off - so this shot had
 * quietly become a second photograph of the stacked layout, and the cell it
 * exists to watch was being watched by nothing. 1220 is the narrowest window
 * that still has three columns (pane 955), which keeps it the width that tells
 * the two designs apart.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [
		{ kind: "push", state: baseState() },
		{ kind: "focusSection", section: "settings" },
	],
	viewport: { width: 1220, height: 2400 },
};

export default fixture;
