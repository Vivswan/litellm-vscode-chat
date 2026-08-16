/**
 * An invalid chip under OS forced colors: one chip rejected while its
 * neighbours rest, so the border does the whole job - the mode repaints the
 * error colour that carries the mark everywhere else, leaving the box as the
 * only channel. A box should appear on the rejected chip and the open popover,
 * and on none of the chips around them.
 *
 * It inherits measuredAtOwnWidth for the same reason as its base: the popover
 * chose its side by measuring, so a width sweep would judge a page the dashboard
 * never builds.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import recordPopoverInvalid from "./record-popover-invalid.ts";

const fixture: RenderFixture = {
	...recordPopoverInvalid,
	hostTheme: "forced-colors",
};

export default fixture;
