/**
 * The Usage tab under the Dark High Contrast theme. The spend meter is why
 * this tier needs a render of its own: the HC block pins neither half of it,
 * so both inherit whatever the HC palette makes of their token chains - the
 * axis through its color-mix of --foreground and --background, the fill
 * through the status hue. The overview fixtures cannot stand in, because the
 * servers table's usage column is a percentage rather than a meter and
 * .usage-meter exists only in UsageSection.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import usage from "./usage.ts";

const fixture: RenderFixture = {
	...usage,
	hostTheme: "high-contrast",
};

export default fixture;
