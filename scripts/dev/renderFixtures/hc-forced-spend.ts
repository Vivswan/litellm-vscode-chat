/**
 * The merged Servers page under OS forced colors: the fill's explicit
 * Highlight over the axis's CanvasText, at all three tones plus the budget-less
 * row that renders no axis at all. Backgrounds flatten to Canvas there while
 * border-color forces to CanvasText, so the fill has to name a system colour
 * outright or the meter reads as a measured zero - the same reading the
 * no-budget row must not produce, which is why it renders no axis. The
 * severity-ruled diagnostic tiers under the rows are in frame too, ranked by
 * weight and style where every colour collapses to one.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import serversSpend from "./servers-spend.ts";

const fixture: RenderFixture = {
	...serversSpend,
	hostTheme: "forced-colors",
};

export default fixture;
