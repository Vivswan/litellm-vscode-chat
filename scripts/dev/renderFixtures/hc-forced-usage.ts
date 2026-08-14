/**
 * The Usage tab under OS forced colors: the fill's explicit Highlight over the
 * axis's CanvasText, at all three tones plus the budget-less row that renders
 * no axis at all. Backgrounds flatten to Canvas there while border-color forces
 * to CanvasText, so the fill has to name a system colour outright or the meter
 * reads as a measured zero. It takes a Usage-tab fixture to photograph that:
 * .usage-meter exists only in UsageSection, because the servers table's usage
 * column is a percentage rather than a meter, so no overview render can show
 * it however it is themed.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import usage from "./usage.ts";

const fixture: RenderFixture = {
	...usage,
	hostTheme: "forced-colors",
};

export default fixture;
