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
 * 1040px is chosen, not something narrower. Below about 870 the row template's
 * fixed 10rem label and 20rem control gutters leave the third column a few tens
 * of pixels and EVERY implementation of it looks broken, so a shot there
 * measures the template, not the cell, and would go on passing while this cell
 * regressed. 1040 is the widest point at which the cell is still too narrow to
 * seat prose and glyph on one line, which makes it the width that tells the two
 * designs apart.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [
		{ kind: "push", state: baseState() },
		{ kind: "focusSection", section: "settings" },
	],
	viewport: { width: 1040, height: 2400 },
};

export default fixture;
