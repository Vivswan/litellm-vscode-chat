/**
 * The stacked band's floor, pane 560px (a 657px window: the collapsed rail's
 * 49px plus the pane's 48px of padding), where the two-column settings row
 * has the least room: the title's auto track against the control track's
 * 1fr auto-minimum. The step ASSERTS the layout's load-bearing claim at this
 * width - no control content under the row's absolutely pinned actions
 * corner - because the failure is an overlap, not an overflow: the page
 * still scrolls nowhere, so check-overflow reads a broken band as green.
 * A minmax(0,1fr) control track shipped exactly that way once: a long title
 * absorbed its max-content first and pushed a 144px input under Reset and
 * the settings.json jump. The step runs at this fixture's own width (steps
 * run once, before the width sweep), which is the band's worst case.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [
		{ kind: "push", state: baseState() },
		{ kind: "focusSection", section: "settings" },
	],
	viewport: { width: 657, height: 2400 },
	steps: [
		`(() => {
			const pane = document.querySelector(".pane");
			if (pane === null) { throw new Error("no .pane on the page"); }
			const style = getComputedStyle(pane);
			const paneContent = pane.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
			if (paneContent < 545 || paneContent > 575) {
				throw new Error("the pane is " + paneContent.toFixed(0) + "px, not the ~560px band floor this fixture asserts at");
			}
			const rows = [...document.querySelectorAll(".setting-row")].filter((row) => !row.hidden);
			let checked = 0;
			const overlaps = [];
			for (const row of rows) {
				const actions = row.querySelector(".setting-actions");
				const control = row.querySelector(".setting-control");
				if (actions === null || control === null) { continue; }
				const a = actions.getBoundingClientRect();
				if (a.width <= 0 || a.height <= 0) { continue; }
				checked += 1;
				for (const piece of control.children) {
					const c = piece.getBoundingClientRect();
					if (c.width <= 0 || c.height <= 0) { continue; }
					const horizontal = Math.min(c.right, a.right) - Math.max(c.left, a.left);
					const vertical = Math.min(c.bottom, a.bottom) - Math.max(c.top, a.top);
					if (horizontal > 0.5 && vertical > 0.5) {
						overlaps.push(
							(row.querySelector(".setting-title")?.textContent ?? "(row)") +
							": control content overlaps the pinned actions by " + horizontal.toFixed(1) + "x" + vertical.toFixed(1) + "px"
						);
					}
				}
			}
			if (checked < 5) {
				throw new Error("only " + checked + " settings rows measured; this is not the settings page this fixture expects");
			}
			if (overlaps.length > 0) {
				throw new Error("control content under the actions corner at the band floor:\\n  " + overlaps.join("\\n  "));
			}
		})()`,
	],
};

export default fixture;
