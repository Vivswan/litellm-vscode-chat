/**
 * The overview tab under the Dark High Contrast theme: the same load as the
 * overview fixture, with the HC token set and the vscode-high-contrast body
 * class the theme.css contrast overrides key off, so those overrides and the
 * fill-less fallback chains stay pinned. Forced colors is a separate fixture.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import overview from "./overview.ts";

const fixture: RenderFixture = {
	...overview,
	hostTheme: "high-contrast",
};

export default fixture;
