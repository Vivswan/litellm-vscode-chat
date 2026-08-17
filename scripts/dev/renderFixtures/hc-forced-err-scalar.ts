/**
 * The refused scalar write under OS forced colors: the same driven flow as
 * err-scalar.ts, in the mode that draws an opaque backplate behind the overlay's
 * text. That backplate is why the row's help glyph shares the covering error's
 * own inline flow (settings.tsx SettingRow) instead of painting through it, so
 * this shot is the reachability evidence for that placement.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import errScalar from "./err-scalar.ts";

const fixture: RenderFixture = {
	...errScalar,
	hostTheme: "forced-colors",
};

export default fixture;
