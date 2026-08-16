/**
 * A success toast, the transient the three server intents leave behind. Two of
 * them, because the stack's own gap is only visible with a second one under the
 * first.
 *
 * The toast is the other container that pads a button at its own edge (the
 * models scope chip is the first), so its numbers are measured against the
 * dismiss glyph's INK rather than its box: the Button primitive hands its
 * padding back to the layout. The glyph and the sentence should be inset from
 * their own borders by the same amount.
 *
 * The acks are delivered rather than driven, which is honest: the app raises a
 * toast from the ack envelope alone, so this is the same message a completed
 * save produces.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, GATEWAY_SERVER, PROD_SERVER } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [
		{ kind: "push", state: baseState({ servers: [PROD_SERVER, GATEWAY_SERVER] }) },
		{ kind: "focusSection", section: "overview" },
		{ kind: "ack", id: "render-1", method: "saveServerSetting" },
		{
			kind: "ack",
			id: "render-2",
			method: "adoptServer",
		},
	],
	steps: [
		// Throw rather than photograph a page with no toast on it: the stack is
		// this fixture's whole subject, and an ack whose method stops raising one
		// would otherwise pass as a large, empty, successful render. The dismiss
		// buttons are counted too, since where their ink lands is the geometry
		// being photographed.
		`(() => {
			const toasts = document.querySelectorAll(".toast");
			if (toasts.length !== 2) { throw new Error("expected 2 toasts, found " + toasts.length); }
			const dismissers = document.querySelectorAll('.toast [data-slot="button"]');
			if (dismissers.length !== 2) {
				throw new Error("expected 2 toast dismiss buttons, found " + dismissers.length);
			}
		})()`,
	],
	// The stack pins itself to the viewport's bottom-right corner, so a
	// full-page capture would expand the page out from under it.
	clipViewport: true,
	viewport: { width: 1300, height: 700 },
};

export default fixture;
