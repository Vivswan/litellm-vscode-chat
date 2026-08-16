/**
 * The settings page under OS forced colors, where two marks have to survive a
 * mode that repaints every border colour, the transparent ones included.
 * Exactly one row should carry the gutter mark (the unmodified rows painted it
 * too until theme.css named Canvas for the off state), and the record chips
 * should read as text - the boxes belong to chips with something to say, which
 * hc-forced-record-invalid.ts photographs.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import settings from "./settings.ts";

const fixture: RenderFixture = {
	...settings,
	hostTheme: "forced-colors",
};

export default fixture;
