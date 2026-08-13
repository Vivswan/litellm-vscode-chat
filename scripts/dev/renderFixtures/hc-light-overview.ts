/**
 * The overview tab under the Light High Contrast theme. Its own fixture because
 * HC light is the one host kind that is light AND high contrast: the wash scale
 * has to read it as light (the class is vscode-high-contrast-light, not
 * vscode-light), while ui.theme and ui.accent have to go inert on it like they
 * do under HC dark. Neither behavior is visible in any other render.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import overview from "./overview.ts";

const fixture: RenderFixture = {
	...overview,
	hostTheme: "high-contrast-light",
};

export default fixture;
