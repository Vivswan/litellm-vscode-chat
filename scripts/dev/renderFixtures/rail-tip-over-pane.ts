/**
 * A collapsed-rail tip over the pane, held by a throwing step: every point inside the open Settings tip hit-tests to the
 * bubble itself, with a settings row proven underneath. The bubble is a child of the rail's sticky column, a stacking
 * context, and every positioned element later in the document (each settings row) painted over it until the open
 * bubble became a top-layer popover (#630).
 *
 *   the row underneath is checked first -> a tip over empty pane would pass without testing the paint order
 */
import type { RenderFixture } from "../render-dashboard.ts";
import settings from "./settings.ts";

const fixture: RenderFixture = {
	...settings,
	// Below the 1000px collapse, scrolled so the settings rows sit under the Settings tab's tip.
	viewport: { width: 500, height: 700 },
	// A full-page capture resets the scroll to 0; the clipped one photographs the overlap the step asserts.
	clipViewport: true,
	steps: [
		`(async () => {
			const wait = (ms) => new Promise((done) => setTimeout(done, ms));
			const rail = document.querySelector(".rail");
			if (rail === null || rail.getBoundingClientRect().width >= 100) {
				throw new Error("the rail did not collapse: this fixture measures the icon rail's tips");
			}
			const trigger = document.querySelector("#tab-settings");
			if (trigger === null) {
				throw new Error("no Settings tab on the rail");
			}
			window.scrollTo(0, 40);
			await wait(50);
			trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
			await wait(150);
			const bubble = trigger.querySelector(".tip-bubble");
			if (bubble === null || bubble.getAttribute("data-open") !== "true") {
				throw new Error("hovering the Settings tab did not open its tip");
			}
			const rect = bubble.getBoundingClientRect();
			const points = [
				[rect.left + 6, rect.top + 6],
				[rect.left + rect.width / 2, rect.top + rect.height / 2],
				[rect.right - 6, rect.bottom - 6],
			];
			// With the bubble out of hit-testing, the same points must land on a settings row; otherwise nothing sat
			// under the tip and the loop below would pass over empty pane.
			bubble.style.visibility = "hidden";
			const underneath = points.map(([x, y]) => document.elementFromPoint(x, y));
			bubble.style.visibility = "";
			if (!underneath.some((element) => element !== null && element.closest(".setting-row") !== null)) {
				throw new Error("no settings row sits under the Settings tip; re-point the scroll offset");
			}
			for (const [x, y] of points) {
				const hit = document.elementFromPoint(x, y);
				if (hit === null || !bubble.contains(hit)) {
					throw new Error(
						"the pane paints over the open tip at (" + Math.round(x) + ", " + Math.round(y) + "): hit " +
							(hit === null ? "nothing" : hit.className || hit.tagName)
					);
				}
			}
		})()`,
	],
};

export default fixture;
