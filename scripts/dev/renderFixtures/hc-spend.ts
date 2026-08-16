/**
 * The merged Servers page under the Dark High Contrast theme. The spend meter is
 * why this tier needs its own render: the HC block pins neither half of it, so
 * both inherit whatever the HC palette makes of their token chains. servers-spend
 * holds every fill tone plus the axis-less no-budget row, so it is the state.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import serversSpend from "./servers-spend.ts";

const fixture: RenderFixture = {
	...serversSpend,
	hostTheme: "high-contrast",
};

export default fixture;
