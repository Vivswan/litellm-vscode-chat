/**
 * A success toast, the transient the three server intents leave behind.
 *
 * Two toasts, because the stack's own gap between them is only visible with a
 * second one under the first.
 *
 * The toast is the other container that pads a button at its own edge (the
 * models scope chip is the first), so the numbers are measured against the
 * dismiss glyph's INK rather than its box: the Button primitive hands its
 * padding back to the layout, and a padding sized against the box sits the
 * glyph half as far from the border as the text on the other side and runs its
 * hover fill flush into it. What this should photograph: the glyph and the
 * sentence inset from their own borders by the same amount.
 *
 * The acks are delivered rather than driven, which is honest here: the app
 * raises a toast from the ack envelope alone (app.tsx's message handler), so
 * this is the same message a completed save produces, not a shortcut around
 * one.
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
		// would otherwise pass as a large, empty, successful render.
		`(() => {
			const toasts = document.querySelectorAll(".toast");
			if (toasts.length !== 2) { throw new Error("expected 2 toasts, found " + toasts.length); }
		})()`,
	],
	// The stack pins itself to the viewport's bottom-right corner, so a
	// full-page capture would expand the page out from under it.
	clipViewport: true,
	viewport: { width: 1300, height: 700 },
};

export default fixture;
