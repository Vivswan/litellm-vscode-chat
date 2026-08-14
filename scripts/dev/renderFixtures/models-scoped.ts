/**
 * The Models destination scoped to one server, which is the only state that
 * paints the scope chip.
 *
 * The chip is the one place on the dashboard where a button sits inside a
 * bordered container's own padding, so the container's numbers are measured
 * against the clear button's INK rather than its box: the Button primitive
 * hands its horizontal padding back to the layout, and a padding sized against
 * the box puts the X a couple of pixels from the pill's border with its hover
 * fill hanging over the outline. What this should photograph: the X inset from
 * the border the way the label is on the other side, and the pill's own
 * outline unbroken.
 *
 * Reached the way a reader reaches it - the count link on a server row - rather
 * than by posting a scoped state, because the chip and the scope are the same
 * navigation and a fixture that fakes one photographs a page the dashboard
 * cannot produce.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, GATEWAY_SERVER, MODELS, PROD_SERVER } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [
		{
			kind: "push",
			state: baseState({
				servers: [PROD_SERVER, GATEWAY_SERVER],
				models: [...MODELS],
			}),
		},
		{ kind: "focusSection", section: "overview" },
	],
	steps: [
		// The count link lives in the row's own detail, so the row opens first.
		// Two steps, not one: React commits the click's state on its own
		// schedule, so the link is only there after the harness's settle.
		`(() => {
			const line = Array.from(document.querySelectorAll("button.server-line")).find(
				(candidate) => candidate.querySelector(".server-label-text")?.textContent?.trim() === "prod"
			);
			if (!line) { throw new Error("no server row named prod"); }
			line.click();
		})()`,
		// Throw rather than photograph an unscoped Models page claiming to be the
		// scoped one: without the chip this fixture has no subject.
		`(() => {
			const link = document.querySelector("button.count-link");
			if (!link) { throw new Error("no server count link to navigate from"); }
			link.click();
			window.scrollTo(0, 0);
		})()`,
		`(() => {
			if (!document.querySelector("#panel-models .chip .chip-label")) {
				throw new Error("the count link did not scope the Models page");
			}
			// The chip's own clear button, not just the chip: the geometry this
			// fixture photographs is where that button's ink lands, so a chip
			// rendered without it is a large green screenshot of nothing.
			if (!document.querySelector('#panel-models .chip [data-slot="button"]')) {
				throw new Error("the scope chip rendered without its clear button");
			}
		})()`,
	],
	viewport: { width: 1300, height: 700 },
};

export default fixture;
