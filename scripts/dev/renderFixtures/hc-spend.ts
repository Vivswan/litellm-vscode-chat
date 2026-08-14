/**
 * The merged Servers page under the Dark High Contrast theme. The spend meter
 * is why this tier needs a render of its own: the HC block pins neither half
 * of it, so both inherit whatever the HC palette makes of their token chains -
 * the axis through its color-mix of --foreground and --background, the fill
 * through the status hue. servers-spend is the one fixture holding every fill
 * tone plus the axis-less no-budget row, so it is the state the trio renders.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import serversSpend from "./servers-spend.ts";

const fixture: RenderFixture = {
	...serversSpend,
	hostTheme: "high-contrast",
};

export default fixture;
