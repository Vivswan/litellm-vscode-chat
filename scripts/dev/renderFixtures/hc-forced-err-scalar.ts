/**
 * The refused scalar write under OS forced colors: the same driven flow as
 * err-scalar.ts, in the mode that draws an opaque backplate behind the overlay's
 * text. That backplate is why the covered slot's help glyph re-homes to the
 * error's own tail (settings.tsx glyphTrail), so this shot is the reachability
 * evidence for that placement.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import errScalar from "./err-scalar.ts";

const fixture: RenderFixture = {
	...errScalar,
	hostTheme: "forced-colors",
};

export default fixture;
