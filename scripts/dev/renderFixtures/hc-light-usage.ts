/**
 * The Usage tab under the Light High Contrast theme, for the reason
 * hc-light-overview.ts has its own fixture: HC light is the one host kind that
 * is light AND high contrast, and the meter meets both at once. The
 * light-surface block names body.vscode-high-contrast-light outright, so the
 * status fills arrive here already darkened toward black, over an axis mixed
 * from the HC palette. No other Usage render puts those two together.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import usage from "./usage.ts";

const fixture: RenderFixture = {
	...usage,
	hostTheme: "high-contrast-light",
};

export default fixture;
