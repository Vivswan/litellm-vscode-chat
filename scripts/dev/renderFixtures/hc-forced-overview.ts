/**
 * The overview tab under OS forced colors on top of the high-contrast theme:
 * forced-colors: active discards most author colors, so this pins that the
 * dashboard stays structured and legible when the system paints it.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import overview from "./overview.ts";

const fixture: RenderFixture = {
	...overview,
	hostTheme: "forced-colors",
};

export default fixture;
