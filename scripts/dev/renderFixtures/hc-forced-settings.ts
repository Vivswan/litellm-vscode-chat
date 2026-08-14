/**
 * The settings page under OS forced colors, where two marks have to survive a
 * mode that repaints every border colour, the transparent ones included.
 *
 * The gutter: the unmodified rows painted the same left mark as the modified
 * one until theme.css named Canvas for the off state. Exactly one row should
 * carry it, and it is the row whose description says it is modified.
 *
 * The record chips: quiet at rest, a field on approach. Every chip wore the
 * hairline here until the resting state was named at the call site, so these
 * rows should read as text - the boxes belong to the chips with something to
 * say, which hc-forced-record-invalid.ts photographs.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import settings from "./settings.ts";

const fixture: RenderFixture = {
	...settings,
	hostTheme: "forced-colors",
};

export default fixture;
