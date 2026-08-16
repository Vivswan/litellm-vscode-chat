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
			// A two-sided bound on purpose: under 560 the one-column fallback
			// applies and this fixture would be certifying the safe layout it
			// never measured, and past ~580 the rows have slack, so the guard
			// would be certifying the roomy case instead of the band's floor.
			if (paneContent < 560 || paneContent > 580) {
				throw new Error("the pane is " + paneContent.toFixed(0) + "px, not the ~560px band floor this fixture asserts at");
			}
			const rows = [...document.querySelectorAll(".setting-row")].filter((row) => !row.hidden);
			let checked = 0;
			let twoColumn = 0;
			let selectRows = 0;
			const overlaps = [];
			for (const row of rows) {
				const actions = row.querySelector(".setting-actions");
				const control = row.querySelector(".setting-control");
				if (actions === null || control === null) { continue; }
				const a = actions.getBoundingClientRect();
				if (a.width <= 0 || a.height <= 0) { continue; }
				checked += 1;
				// The state under test, asserted rather than assumed: every row
				// must actually BE in the two-column band here, or a drifted
				// breakpoint quietly re-points this guard at the fallback layout.
				if (getComputedStyle(row).gridTemplateColumns.trim().split(/\\s+/).length === 2) {
					twoColumn += 1;
				}
				if (control.querySelector("select") !== null) {
					selectRows += 1;
				}
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
			if (twoColumn !== checked) {
				throw new Error(twoColumn + " of " + checked + " rows are in the two-column band; the guard is not measuring the state it exists for");
			}
			if (selectRows < 1) {
				throw new Error("no row with a select control measured; the widest-control case this floor was derived from is missing");
			}
			if (overlaps.length > 0) {
				throw new Error("control content under the actions corner at the band floor:\\n  " + overlaps.join("\\n  "));
			}
		})()`,
	],
};

export default fixture;
