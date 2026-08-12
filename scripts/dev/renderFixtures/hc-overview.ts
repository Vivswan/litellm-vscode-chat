/**
 * The overview tab under the Dark High Contrast theme: the same load as the
 * overview fixture, rendered with the HC token set, the vscode-high-contrast
 * body class, and forced-colors/prefers-contrast active - so the theme.css
 * contrast overrides and the fill-less fallback chains stay pinned.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import overview from "./overview.ts";

const fixture: RenderFixture = {
	...overview,
	hostTheme: "high-contrast",
};

export default fixture;
