/**
 * The Usage tab at the width where its six columns become three lines.
 *
 * The tab's own fixture is 1300px wide, so the fold this change added had no
 * render coverage at all - and the fold is where the surface's money lives: at
 * six columns in a 400px pane the spend truncated to "$21.1..." while a
 * decorative meter kept its 8rem.
 *
 * What it should photograph: every dollar figure whole, the qualifying fact
 * beside the percentage, and the meter as a rule under the row's facts,
 * indented past the chevron - with the budget-less rows showing no axis at
 * all rather than a bare one, which would read as a measured zero.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import usage from "./usage.ts";

const fixture: RenderFixture = {
	...usage,
	viewport: { width: 500, height: 900 },
};

export default fixture;
