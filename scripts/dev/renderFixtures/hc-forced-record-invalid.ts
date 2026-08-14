/**
 * An invalid chip under OS forced colors: the half of the chip fix that the
 * settings render cannot show.
 *
 * There the marks are absent by design, and a render of quiet rows proves only
 * that nothing paints. Here one chip is rejected while its neighbours are at
 * rest, so the border has to do the whole job: the mode repaints the error
 * colour that carries the mark everywhere else, which leaves the box as the
 * only channel left. What it should photograph: a box on the rejected chip and
 * on the open popover, and none on the chips around them.
 *
 * It inherits measuredAtOwnWidth with the rest of that fixture, and needs it
 * for the same reason: the popover under it chose its side by measuring, so a
 * width sweep would judge a page the dashboard never builds.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import recordPopoverInvalid from "./record-popover-invalid.ts";

const fixture: RenderFixture = {
	...recordPopoverInvalid,
	hostTheme: "forced-colors",
};

export default fixture;
